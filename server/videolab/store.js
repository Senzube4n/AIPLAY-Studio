/**
 * Video lab — what survives a restart.
 *
 * TWO documents, one file:
 *
 *   knobs    the render settings a person or an agent moved, written back into
 *            `config` at boot so the next render uses them. NOT settings.json:
 *            that file's PREF_PATHS is a deliberately flat two-level allow-list
 *            (group.key) and these live three deep on an engine — and more to
 *            the point, they are RENDER knobs, not app preferences. Keeping them
 *            apart means a hand-edited lab file can never reach the folder
 *            paths, the API mode or the model filenames.
 *
 *   groups   the comparisons. A group is a real record even when an arm failed,
 *            because "H3 at 1920x1088 ran out of memory" is a comparison result
 *            and losing it would leave the same question to be paid for twice.
 *
 *            A group also carries the two things a person adds AFTER the render:
 *            `frames`, the frame numbers its still strip is locked to, and
 *            `verdict` — {armId, note, by, at}, the judgement. Those are the
 *            only fields here that cost human attention rather than GPU time,
 *            which makes them the ones most worth surviving a restart.
 *
 * Read failures are silent, as everywhere else in this app: a corrupt store
 * should cost you the memory of a comparison, never the ability to start.
 *
 * ⚠ THE KNOBS ARE APPLIED THROUGH catalog.setKnob, not merged. Every value on
 * disk is untrusted input, and setKnob is the one place the range checks live —
 * a hand-written 400 in `shiftVideo` gets dropped with a warning rather than
 * silently becoming what every render on this machine now uses.
 */
import path from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { config } from "../config.js";
import { setKnob, KNOBS, COMPARE_CONFIGS } from "./catalog.js";

const FILE = path.join(config.paths.appData, "videolab.json");

/* WHERE THE SECOND COPY OF A COMPARISON LIVES, and the reason this file can
 * recover from losing its own. server/index.js owns clips.json; routes.js tags
 * every finished arm's clip with its group there precisely so a comparison
 * survives in the library. This module only ever READS that file. */
const CLIP_STORE = path.join(config.paths.appData, "clips.json");

/** Comparison groups, newest first. Bounded — see `remember`. */
const groups = [];

/* Fifty is arbitrary but bounded on purpose: this file is rewritten whole on
 * every change, and an unbounded list would grow until the write cost showed. */
const MAX_GROUPS = 50;

let timer = null;

export async function load() {
  let raw = {};
  /* No file, or an unreadable one, is the LOUDEST case of "no groups" — so the
   * heal runs on that path too, before giving up on the rest. */
  try { raw = JSON.parse(await readFile(FILE, "utf8")); }
  catch { await healGroupsFromClips(); return; }
  for (const [id, value] of Object.entries(raw.knobs ?? {})) {
    try { setKnob(id, value); }
    catch (err) { console.warn(`  [videolab] ignoring saved ${id}: ${err.message}`); }
  }
  /* The quality selection, checked the same way the route checks it. A size on
   * disk is untrusted input like any other, and a 40000-pixel width restored at
   * boot would be a render that dies minutes later with nothing to point at. */
  for (const [engine, size] of Object.entries(raw.sizes ?? {})) {
    const eng = config.video.engines[engine];
    const w = Math.round(Number(size?.[0])), h = Math.round(Number(size?.[1]));
    if (!eng || !Number.isFinite(w) || !Number.isFinite(h)
        || w < 256 || h < 256 || w > 3840 || h > 3840) {
      console.warn(`  [videolab] ignoring saved size for ${engine}: ${JSON.stringify(size)}`);
      continue;
    }
    eng.width = w; eng.height = h;
  }
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!g || typeof g.id !== "string") continue;
    /* NOTHING IS RENDERING AT BOOT, so a group that says it is, is stale.
     *
     * The record is written debounced, and a comparison that was in flight when
     * the app was closed (or crashed, or was killed) lands on disk mid-run —
     * caught doing exactly that on this surface's own proof run, where the last
     * group persisted with its arms still reading "rendering". Loaded as-is it
     * would be indistinguishable from a comparison still going: the page would
     * poll it forever and an agent would wait on an arm that died with the
     * process. This app has already learned that lesson once, in its own words
     * — "a row stuck at waiting is indistinguishable from one still queued" —
     * so an unfinished arm is INTERRUPTED, which is a result you can act on.
     */
    if (g.running) {
      g.running = false;
      for (const a of g.arms || []) {
        if (a.status === "rendering" || a.status === "waiting") {
          a.status = "interrupted";
          a.error = "The app stopped while this arm was queued or rendering. Run the comparison "
            + "again — on a different seed, or ComfyUI will serve the finished arms from cache.";
        }
      }
    }
    /* THE VERDICT IS THE PART WORTH KEEPING, so it is also the part worth
     * checking. Everything in this file is untrusted input — the knobs are
     * range-checked above for exactly that reason — and a verdict is text
     * somebody typed that both the page and an MCP tool will read back. A
     * hand-edited object of the wrong shape must cost the judgement, never the
     * boot. Same for the frame numbers: they index into a decoder. */
    g.verdict = cleanVerdict(g.verdict, g);
    g.frames = cleanFrames(g.frames);
    groups.push(g);
  }
  /* Whatever the file held, the clips are the second copy — see the healing
   * block below. Additive, so this can only ever put back what is missing. */
  await healGroupsFromClips();
}

/** `{armId, note, by, at}` or nothing. An armId must name an arm of THIS group. */
function cleanVerdict(v, group) {
  if (!v || typeof v !== "object") return null;
  const note = typeof v.note === "string" ? v.note.trim() : "";
  const by = typeof v.by === "string" ? v.by.trim() : "";
  if (!note && !v.armId) return null;
  if (!by) return null;
  const armId = typeof v.armId === "string"
    && (group.arms || []).some((a) => a.id === v.armId) ? v.armId : null;
  return { armId, note, by, at: Number.isFinite(v.at) ? v.at : Date.now() };
}

/** Whole, non-negative, sorted, unique frame numbers, or nothing. */
function cleanFrames(f) {
  if (!Array.isArray(f)) return undefined;
  const out = [...new Set(f.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 200000))];
  return out.length ? out.sort((a, b) => a - b) : undefined;
}

/**
 * What to write for the knobs.
 *
 * Only what DIFFERS from the shipped default, so the file stays a record of
 * decisions rather than a snapshot that would pin every measured constant in
 * config.js the first time anyone touched one unrelated switch.
 */
function knobsToSave() {
  const out = {};
  for (const k of KNOBS) {
    let node = config;
    for (const seg of k.path) node = node?.[seg];
    if (node === undefined) continue;
    if (k.kind === "bool") { if ((node === k.onValue) !== (DEFAULTS[k.id] === k.onValue)) out[k.id] = node === k.onValue; continue; }
    if (node !== DEFAULTS[k.id]) out[k.id] = node;
  }
  return out;
}

/* Captured at import, BEFORE load() writes anything — so "default" means what
 * config.js shipped, not what this machine last chose. Taken by walking the
 * same paths the knobs declare, which means a new knob needs no second entry
 * here: it is a row in catalog.js and nothing else, which is the point. */
const DEFAULTS = Object.fromEntries(KNOBS.map((k) => {
  let node = config;
  for (const seg of k.path) node = node?.[seg];
  return [k.id, node];
}));

/** Each engine's shipped size, captured at the same moment and for the same reason. */
const SIZE_DEFAULTS = Object.fromEntries(
  Object.entries(config.video.engines).map(([k, e]) => [k, [e.width, e.height]]),
);

/* Same rule as the knobs: only what differs from what config.js shipped, so
 * this file records a decision rather than pinning a measured default. */
function sizesToSave() {
  const out = {};
  for (const [key, eng] of Object.entries(config.video.engines)) {
    const d = SIZE_DEFAULTS[key];
    if (!d) continue;
    if (eng.width !== d[0] || eng.height !== d[1]) out[key] = [eng.width, eng.height];
  }
  return out;
}

/* Every write goes through ONE chain, so two saves that fall due together land
 * in the order they were asked for and the file ends up holding the later
 * state. It is also what makes the fixed temp name below safe: this process
 * never has two of its own writes to that name in flight at once. */
let writing = Promise.resolve();

function writeNow() {
  writing = writing.then(async () => {
    await mkdir(path.dirname(FILE), { recursive: true });
    /* A sibling temp file renamed into place — the pattern server/mv/store.js
     * already uses: a reader gets the old document or the new one, never a
     * splice of both. Written in place, a reader under disk load once saw the
     * new head and the old tail, and the JSON parse of that took down a whole
     * pre-commit run. */
    const tmp = `${FILE}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify({
      knobs: knobsToSave(),
      sizes: sizesToSave(),
      groups: groups.slice(0, MAX_GROUPS),
    }, null, 2), "utf8");
    await rename(tmp, FILE);
  }).catch((err) => {
    console.warn(`  [videolab] could not be saved: ${err.message}`);
  });
  return writing;
}

/** Debounced: a burst of changes is one write, 400 ms after the last of them. */
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; writeNow(); }, 400);
}

/**
 * Write whatever is pending NOW, and resolve once it is on disk.
 *
 * The handle a test — or a shutdown — needs instead of a sleep tuned to the
 * debounce. A sleep is a hope, not a synchronisation: the store test slept
 * 700 ms, lost the race once while a 35-minute render kept the disk busy, and
 * passed on the next run with the card idle. Cheap when nothing is pending:
 * it resolves as soon as any write already in flight has landed.
 */
export function flush() {
  if (timer) { clearTimeout(timer); timer = null; writeNow(); }
  return writing;
}

/** Newest first, optionally one. */
export function listGroups(limit = 20) {
  return groups.slice(0, Math.max(1, Number(limit) || 20));
}

export function getGroup(id) {
  return groups.find((g) => g.id === id) || null;
}

export function remember(group) {
  const at = groups.findIndex((g) => g.id === group.id);
  if (at >= 0) groups[at] = group; else groups.unshift(group);
  if (groups.length > MAX_GROUPS) groups.length = MAX_GROUPS;
  save();
  return group;
}

/* ══════════════════════════════════════════════════════════════════════════
 * HEALING — because the comparison is written down twice, and only one of the
 * two copies can be lost by a knob sweep
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED. This file's `groups` array came back empty while five clips in
 * clips.json still carried full `compare` tags — two whole comparisons, four
 * arms and one, ~13 GPU-minutes of renders, present on disk and invisible to
 * both surfaces. The write path is debounced and rewrites the file WHOLE (a
 * sibling temp file renamed into place), so
 * one save issued from a process whose `groups` was empty (a knob write is
 * enough: `set_knob` calls `save()`) replaces the list with `[]`.
 *
 * WHY THIS IS THE RIGHT REPAIR AND NOT A SECOND STORE. routes.js already tags
 * every finished arm's clip with its group id, config, label, engine, size,
 * seed and wall time — deliberately, "so the group survives in the library".
 * That tag is a complete arm record. So the group list is DERIVABLE from the
 * clips whenever it goes missing, and this is that derivation: read-only over
 * clips.json, additive, idempotent, and it can only ever put back a comparison
 * whose clips are still on disk.
 *
 * WHAT IT CANNOT PUT BACK, and says so on the record rather than inventing it:
 * the prompt, the length, the references and the first frame were never written
 * onto the clips. A healed group carries `healed` and a prompt line that admits
 * what it is. An arm that failed left no clip, so it left no tag either — a
 * healed group is the arms that finished, and its `healed` note says that too.
 */

/** Timestamps are minted as `cmp${Date.now().toString(36)}`, so they read back. */
function atFromGroupId(id) {
  const t = Number.parseInt(String(id).replace(/^cmp/, ""), 36);
  /* 2020-01-01 to 2050-01-01 — a decoded number outside that is not a date, and
   * `new Date(NaN).toISOString()` throws in the MCP layer. */
  return Number.isFinite(t) && t > 1577836800000 && t < 2524608000000 ? t : 0;
}

/** One group rebuilt from the `compare` tags of its clips. */
function groupFromTags(id, tagged) {
  const seeds = [...new Set(tagged.map((t) => t.seed).filter((n) => Number.isFinite(n)))];
  return {
    id,
    at: atFromGroupId(id),
    /* The UI prints this in bold as the comparison's name, so it has to be a
     * sentence rather than an empty string pretending nothing was lost. */
    prompt: "(recovered from the clip tags — the description was not saved on them)",
    seed: seeds.length === 1 ? seeds[0] : null,
    seconds: null,
    refImages: [], refAudios: [], firstFrame: null,
    running: false,
    healed: `Rebuilt from ${tagged.length} tagged clip${tagged.length === 1 ? "" : "s"} in `
      + "clips.json after videolab.json lost its groups. The arms, sizes, step counts, seed and "
      + "wall times are the ones recorded on the clips at render time. The prompt, the clip "
      + "length, the reference images and any arm that FAILED were never written onto a clip, so "
      + "they are gone — a failed arm leaves no file to tag.",
    arms: tagged.map((t) => {
      const spec = COMPARE_CONFIGS.find((c) => c.id === t.config);
      return {
        id: t.config, label: t.label || t.config,
        engine: t.engine, declaredEngine: t.declaredEngine ?? t.engine,
        steps: t.steps ?? null,
        width: t.width ?? null, height: t.height ?? null,
        sizeLabel: t.sizeLabel || "",
        why: spec?.why,            // the arm's reason is data in catalog.js, keyed by id
        status: "done",
        clip: t.clip,
        wallSeconds: Number.isFinite(t.wallSeconds) ? t.wallSeconds : null,
        error: null,
      };
    }),
  };
}

/**
 * Put back any comparison the clips remember and this store does not.
 *
 * Additive and idempotent: a group already held here is left exactly as it is,
 * including its verdict — the clips carry no verdict, so a rebuild must never
 * overwrite a judgement somebody typed. Logged only when it actually did
 * something, because a line that prints on every boot is a line nobody reads.
 *
 * Returns `{ rebuilt: [ids], groupsInClips: n }` so a test — and an operator
 * running it by hand — can see what it found rather than trusting the log.
 */
export async function healGroupsFromClips({ file = CLIP_STORE } = {}) {
  let meta = {};
  try { meta = JSON.parse(await readFile(file, "utf8"))?.meta ?? {}; }
  catch { return { rebuilt: [], groupsInClips: 0 }; }

  const byGroup = new Map();
  for (const [clip, m] of Object.entries(meta)) {
    const c = m?.compare;
    if (!c || typeof c.group !== "string" || !c.group) continue;
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group).push({ clip, ...c });
  }

  const rebuilt = [];
  for (const [id, tagged] of byGroup) {
    if (groups.some((g) => g.id === id)) continue;
    groups.push(groupFromTags(id, tagged));
    rebuilt.push(id);
  }
  if (rebuilt.length) {
    /* Newest first, the order every reader of this list assumes. */
    groups.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    if (groups.length > MAX_GROUPS) groups.length = MAX_GROUPS;
    console.log(`  [videolab] rebuilt ${rebuilt.length} comparison(s) from clip tags: `
      + `${rebuilt.join(", ")} — videolab.json had lost them`);
    save();
  }
  return { rebuilt, groupsInClips: byGroup.size };
}

export const storeFile = FILE;
export const clipStoreFile = CLIP_STORE;
