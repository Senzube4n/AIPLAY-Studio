/**
 * The provenance ledger — honest AI labeling + human attribution, v1.
 *
 * One append-only JSONL event log per project, hash-chained, beside the store
 * it describes:
 *
 *   <appData>/provenance/library.jsonl       the song/image/clip library
 *   <outputDir>/vfx/<slug>/provenance.jsonl  a VFX comp (dir passed in by routes)
 *
 * Design invariants (SPEC.md D1.0/D1.4/D1.7 — do not weaken these):
 *
 *  ACTOR HONESTY. Every event says WHO acted: "user" (a browser click),
 *  "agent:<name>" (an MCP-driven action), "script:<name>" (an unattended
 *  harness driving the engine door), or "system" (an internal job).
 *  The MCP layer always stamps agent:*; the web UI carries no header and is
 *  therefore "user"; anything unattributable records "system" — NEVER "user".
 *  There is no configuration, flag, or import path that records an AI-made
 *  action as a human one. A header that *claims* to be "user" is recorded as
 *  "system": the browser never sets the header, so a caller that does is by
 *  definition not the browser.
 *
 *  APPEND-ONLY, HASH-CHAINED. Each event carries `prev`: the SHA-256 of the
 *  previous event's exact JSON line. What the chain PROVES: internal
 *  consistency — no silent insertion, deletion or reorder without recomputing
 *  everything after it. What it DOES NOT prove: authenticity. This is local,
 *  unsigned data on the user's own machine; a determined user can rewrite the
 *  whole chain. What makes it evidence anyway is contemporaneity and texture —
 *  a record grown over weeks, interleaved with file mtimes and kept takes, is
 *  a studio notebook, not a certificate. Signing/anchoring is v2.
 *
 *  CAPTURE IS NOT A TOGGLE. The ledger always records. Deleting a project
 *  deletes its ledger; nothing here transmits anything anywhere.
 *
 *  RIGHTS ARE STAMPED AT GENERATION TIME, NOT LOOKED UP AT READ TIME. Every
 *  `generate` event carries `data.outputRights` — the licence class the
 *  catalogue held for that model AT THE MOMENT THE FILE WAS MADE, plus the URL
 *  the quote came from. Two reasons, both learned the hard way elsewhere:
 *
 *    · it is CONTEMPORANEOUS EVIDENCE. "I made this in August 2026, when the
 *      licence said the output was mine" is a defensible sentence. "The
 *      catalogue says so today" is not, and is exactly what a read-time lookup
 *      would produce.
 *    · it SURVIVES A LICENCE CHANGE. Several of these terms live in editable
 *      model-card prose with no LICENSE file at all — a publisher can rewrite
 *      one tomorrow with no trace. A read-time lookup would silently rewrite
 *      the past to match; a stamp lets the two disagree out loud, which is the
 *      only way anyone ever notices.
 *
 *  The stamp is deliberately small (class + capability + source URL). The
 *  verbatim quote stays in the catalogue: putting 34 KB of LTX licence text in
 *  every event would make the ledger unreadable to defend a claim the URL
 *  already reconstructs.
 *
 * Origin classes (D1.3), each mapped to an IPTC DigitalSourceType for
 * embedding. A part's class is the most specific TRUE class, never the most
 * flattering: an edit by agent:* does not promote ai-generated to
 * ai-assisted-human-edited — only a user's edit does.
 */
import fs from "node:fs";
import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { rightsStampFor } from "./models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Tool identity, for markers. Read once; a missing package.json is not fatal. */
let VERSION = "0.1.0";
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version || VERSION;
} catch { /* keep the default */ }
export const TOOL = `AIPLAY Studio ${VERSION}`;

/* ──────────────────────────────────────────────── vocabulary and classes */

/** Event vocabulary v1 (SPEC D1.2). Unknown types in a FILE round-trip
 *  unharmed on read; unknown types on WRITE are a bug and throw. */
export const EVENT_TYPES = new Set([
  "generate", "author_text", "record", "pick_take", "judge", "author_layer",
  "edit", "preset_apply", "cast_voice", "commit_brief", "regen", "import",
  "licence_attach", "choice", "delegate", "approve", "export",
  /* PROCESS EVIDENCE, NOT AUTHORSHIP. `plan_step` records that an APPROVED
   * item of a plan was executed at a time, by the runner, producing an asset —
   * and it exists because no other type can say that without claiming
   * something untrue. Every existing type either claims authorship of the
   * artefact (`generate`, `regen`, `edit`) or claims a decision that was not
   * made here (`judge`, `choice`): the decision was made earlier, by whoever
   * approved the item, and each `plan_step` names that event in `approvedBy`.
   * Writing the execution as a `choice` would record the runner's loop as a
   * human's decision, which is the one thing this module must make impossible.
   *
   * It changes NO origin class. foldOrigin's `default: break` already means an
   * unrecognised type folds to nothing, which is exactly the standing this
   * should have — a render that ran under a plan is neither more nor less
   * AI-generated than the same render run by hand. provenance_test.js pins
   * that: the fold over a stream with and without plan_step events returns the
   * identical class.
   *
   * Older readers are unaffected: the module's read contract already says
   * unknown types round-trip unharmed, and only WRITES validate — which is the
   * deliberate extension point this uses.
   *
   * Rejected alternative, recorded so it is not re-litigated: write nothing and
   * join plan -> asset through item.result.asset and the library ledger.
   * Cheaper, and it leaves no contemporaneous record that the render was
   * AUTHORISED — which is the whole point of the object.
   *   data: { planId, itemId, tool, argsHash, ok, asset, ms, approvedBy } */
  "plan_step",
  /* A REQUEST THIS APP WOULD NOT MAKE. Written when a door refuses sexual
   * content involving minors (server/safety/refusal.js, docs/SAFETY.md). It
   * records THAT it happened, where and for whom — never what was asked: no
   * prompt, no label, no hash of either, because a hash of a short prompt is a
   * lookup key (see REDACTED_KEYS). Like plan_step it names no artefact and
   * folds to nothing in foldOrigin.
   *   data: { code: "minor-sexual", door, via } */
  "refused",
]);

const IPTC = "http://cv.iptc.org/newscodes/digitalsourcetype/";

/** Origin class → IPTC DigitalSourceType URI (SPEC R2/D3.1). The retired
 *  terms (minorHumanEdits, digitalArt) are never written. */
export const DIGITAL_SOURCE_TYPE = {
  "human-recorded": `${IPTC}digitalCapture`,
  "human-authored": `${IPTC}digitalCreation`,
  "ai-generated": `${IPTC}trainedAlgorithmicMedia`,
  "ai-assisted-human-edited": `${IPTC}compositeWithTrainedAlgorithmicMedia`,
  // A whole work mixing classes; -synthetic when an AI part is certain.
  "composite": `${IPTC}composite`,
  "composite-synthetic": `${IPTC}compositeSynthetic`,
  // Third-party assets carry their licence attribution rather than a source
  // type of ours; embeds fall back to composite for containers that need one.
  "third-party-licensed": `${IPTC}composite`,
};

/* ─────────────────────────────────────────────────────── actor honesty */

const AGENT_RE = /^agent:[a-z0-9_.:-]{1,40}$/i;

/**
 * A HARNESS — `script:gate_run`, `script:vace_run`, `script:ltx_smoke`.
 *
 * A batch that ran unattended. Not a person, and not a model deciding anything.
 *
 * WHY A FOURTH CLASS AND NOT `agent:script.gate_run`. Folding a harness into
 * `agent:` would leave the ledger unable to tell "an LLM asked for this" from
 * "a script ran a hundred arms overnight" — and that is precisely the
 * distinction this vocabulary was extended for. On one night in September 2026,
 * 245 renders were driven straight at the engine by three scripts and not one
 * of them exists in this ledger. When those scripts come through the app's door
 * instead, every arm must be attributable to the harness that asked, AS a
 * harness.
 *
 * ⚠ BIT-TRANSPARENT BY CONSTRUCTION, and that is the property to keep.
 * `actorGroup()` already maps everything that is not `user` or `agent:*` to
 * "system", and `actorFrom()` already coerced an unrecognised header to
 * "system". So every existing line in every existing ledger reads identically,
 * every `foldOrigin()` returns the identical class, and a `script:*` edit still
 * never promotes anything toward a human class. The ONLY change is that a
 * header which used to be FLATTENED to `system` now KEEPS ITS NAME — strictly
 * more information at strictly the same standing. The masquerade guard is
 * untouched: a header claiming `user` is still `system`, and `script:user` is a
 * script, not a person.
 *
 * No colon inside the name (unlike `agent:`), so `script:a:b` is refused rather
 * than quietly recorded: harness names come from a file's basename, and a
 * basename has no colons.
 */
const SCRIPT_RE = /^script:[a-z0-9_.-]{1,40}$/i;

/**
 * A FRIEND'S MACHINE — `peer:<32 hex fingerprint>:<their own actor>`.
 *
 * Work that came home from somebody else's Studio through Collab. Their user,
 * their agent, their harness, kept whole underneath their fingerprint, because
 * flattening it into any of ours is the one lie that would make this ledger
 * worthless: a lender's render is neither this machine's person nor this
 * machine's agent.
 *
 * ⚠ IT DOES NOT NEST. `peer:<a>:peer:<b>:user` is refused, which matters because
 * a relaying peer would otherwise absorb a third party's work under their own
 * fingerprint while the real one vanished from the record. server/collab/credit.js
 * refuses the same shape when it READS; this refuses it when it is written.
 *
 * ⚠ AND IT DOES NOT PROMOTE. `actorGroup` below sends everything that is not
 * `user` or `agent:*` to `system`, and a peer actor falls there ON PURPOSE. A
 * human edit on a machine this Studio cannot see is a claim it cannot check, and
 * `user` edits are the only thing that moves an asset from `ai-generated` to
 * `ai-assisted-human-edited`. The ledger says whose hand it was; the origin
 * class stays where an unverifiable claim belongs.
 *
 * Measured before this existed: `normalizeActor("peer:<fp>:agent:plan")` came
 * back `system`, so a take adopted from a friend was filed as this machine's
 * own work — the exact mis-attribution collab/credit.js exists to prevent, one
 * layer underneath it.
 */
const PEER_RE = /^peer:[0-9a-f]{32}:(user|system|agent:[a-z0-9_.:-]{1,40}|script:[a-z0-9_.-]{1,40})$/i;

/** Coerce anything into a legal actor. Unknown/malformed → "system", never
 *  "user" — fabricating human action is the one thing this module must make
 *  impossible (D1.0). */
export function normalizeActor(a) {
  const s = String(a ?? "").trim();
  if (s === "user" || s === "system") return s;
  if (AGENT_RE.test(s)) return s.toLowerCase();
  if (SCRIPT_RE.test(s)) return s.toLowerCase();
  /* ⚠ THE PEER FORM IS ACCEPTED HERE AND DELIBERATELY NOT IN `actorFrom`.
   * `normalizeActor` cleans an actor this process built; `actorFrom` reads a
   * HEADER. If the header could carry `peer:<fp>:user`, any caller on this
   * machine could file its work as a named friend's — the ledger's whole
   * discipline is that a caller cannot choose its own class, and this class is
   * the one that names somebody who is not here to object. It is written only
   * by the adopter, in process, from a row whose signature was checked. */
  if (PEER_RE.test(s)) return s.toLowerCase();
  return "system";
}

/**
 * The actor for an HTTP request, stamped at the API boundary (D1.4).
 *
 * The web UI sends no header → "user". The MCP server sends
 * `x-aiplay-actor: agent:<name>` on every call (see mcp.js api()) → that
 * agent. A harness driving the engine door sends `script:<name>` → that script.
 * A header that is present but is none of those — including a literal "user" —
 * records as "system": only the ABSENCE of the header is evidence of a browser,
 * and a non-browser caller claiming to be the user is exactly the masquerade
 * the ledger exists to refuse.
 *
 * Note what `script:` does NOT buy: it is `system` in every fold, so no harness
 * can promote an origin class. It buys a NAME on a line that would otherwise
 * have said only "system", which is the difference between "something on this
 * machine made 245 files" and "gate_run made these 135, vace_run these 40".
 */
export function actorFrom(req) {
  const h = req?.headers?.["x-aiplay-actor"];
  if (h === undefined || h === null || h === "") return "user";
  const s = String(h).trim();
  if (AGENT_RE.test(s)) return s.toLowerCase();
  if (SCRIPT_RE.test(s)) return s.toLowerCase();
  return "system";
}

/* ──────────────────────────────────────────────────────── the chain */

export const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const hashLine = (line) => `sha256:${sha256hex(line)}`;
export const GENESIS = "sha256:genesis";

/** Sortable, collision-safe id: ms timestamp base36 + 5 random bytes. */
const newEventId = () =>
  `${Date.now().toString(36).padStart(9, "0")}${randomBytes(5).toString("hex")}`;

/** Resolve a scope to its JSONL path. "library" → the app-data ledger;
 *  { dir } → a project ledger beside that project's own document. */
function scopePath(scope) {
  if (scope === "library" || scope === undefined || scope === null) {
    return path.join(config.paths.appData, "provenance", "library.jsonl");
  }
  if (typeof scope === "object" && scope.dir) {
    return path.join(String(scope.dir), "provenance.jsonl");
  }
  throw new Error(`unknown provenance scope: ${JSON.stringify(scope)}`);
}

/* Per-file writer state: the chain head and a promise tail that serialises
 * appends. The server is the single writer (same discipline as every other
 * store here); this map keeps concurrent route handlers from interleaving. */
const chains = new Map(); // file -> { head, count, tail: Promise }

function chainState(file) {
  let st = chains.get(file);
  if (!st) { st = { head: null, count: 0, loaded: false, tail: Promise.resolve() }; chains.set(file, st); }
  return st;
}

async function loadChain(file, st) {
  /* THE LEDGER FILE CAN LEGITIMATELY VANISH UNDER A LOADED CHAIN. Deleting a
   * project deletes its ledger with it, and a project recreated under the
   * same slug lands on the same path — so without this check the first event
   * of the NEW ledger inherits the OLD chain head, and verify() reports a
   * broken chain for a file nobody ever tampered with. A tamper-evidence
   * layer that cries tamper on its own bookkeeping is worse than none: it
   * teaches everybody to ignore the alarm.
   *
   * Found live (2026-08-26) by the Ear's loop demo, which deletes and
   * recreates its demo project at a fixed slug; provenance_test.js pins it.
   * Cost: one existsSync per append, and appends happen per DECISION, not per
   * sample. */
  if (st.loaded) {
    if (st.count > 0 && !fs.existsSync(file)) { st.head = null; st.count = 0; }
    return;
  }
  try {
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length);
    st.count = lines.length;
    st.head = lines.length ? hashLine(lines[lines.length - 1]) : null;
  } catch {
    st.count = 0; st.head = null; // first event for this project
  }
  st.loaded = true;
}

/**
 * Stamp a `generate` event with the model's output-rights class.
 *
 * HERE, not at the six call sites in index.js, on purpose. Every one of those
 * seams was written at a different time by somebody solving a different
 * problem, and a rule that has to be remembered six times is a rule that is
 * already broken in the seventh place — the next capability to grow a
 * `generate` event would silently ship unstamped. Doing it in the writer means
 * the ledger cannot record a generation whose rights it did not also record.
 *
 * A caller that supplies its own `outputRights` keeps it (an import replaying
 * an older event must not be rewritten to today's answer); a caller with no
 * `model` gets nothing, because there is nothing to look up.
 */
function stampRights(type, data) {
  if (type !== "generate") return data;
  if (!data.model || data.outputRights !== undefined) return data;
  return { ...data, outputRights: rightsStampFor(data.model) };
}

/**
 * THE FIELDS THAT CARRY WHAT SOMEBODY TYPED.
 *
 * Every one of these was measured in a real ledger before being listed: 1132
 * events carried `prompt` verbatim, 1589 `texts`, 332 `negative`, 3405 `label`
 * (which is the prompt's first 48 characters), and 1406 `promptHash` - of which
 * 305 were confirmed by hashing candidate prompts out of the picture sidecar,
 * which is why the hashes are on this list and not treated as anonymised.
 *
 * A DENYLIST is the wrong default in general and the right one here: an event's
 * `data` is free-form, so an allowlist would silently drop the model, the seed
 * and the runId that make a redacted line worth keeping at all.
 * provenance_test.js pins this against what the ledger really contains, so a
 * new prose field fails the gate rather than leaking.
 */
export const REDACTED_KEYS = Object.freeze([
  "prompt", "promptTruncated", "promptHash",
  "negative", "negativeHash",
  "texts", "label", "caption", "lyrics", "note",
]);

/** Strip the words, keep the event. Returns [data, droppedKeys]. */
function redactPrompts(data) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(data)) {
    if (REDACTED_KEYS.includes(k)) {
      /* Only count a key that HELD something. A null prompt was not redacted,
       * it was absent, and saying otherwise would make every event look like it
       * was hiding something. */
      if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  if (dropped.length) out.redacted = dropped;
  else out.redacted = [];
  return out;
}

/**
 * Append one event. Returns the event as written (with id/t/prev filled in).
 *
 * Callers at capture seams should `.catch()` — a ledger failure must never
 * cost a render — but a failure is logged loudly: a compliance layer that
 * fails silently is not a compliance layer.
 */
export async function append(scope, evt) {
  const file = scopePath(scope);
  if (!EVENT_TYPES.has(evt?.type)) throw new Error(`unknown event type: ${evt?.type}`);
  const asset = String(evt.asset || "");
  if (!asset) throw new Error("an event needs an asset");
  const st = chainState(file);
  const run = st.tail.then(async () => {
    await loadChain(file, st);
    const full = {
      v: 1,
      id: newEventId(),
      t: new Date().toISOString(),
      actor: normalizeActor(evt.actor),
      type: evt.type,
      asset,
      /* ⚠ REDACTED BEFORE RIGHTS, NOT AFTER. stampRights reads `data.model`
       * to decide output rights, and a private render's rights are exactly the
       * same as a public one's — privacy is about the words, never about what
       * the result may be used for. Redacting first also means the rights stamp
       * is computed from a field this never touches. */
      data: stampRights(
        evt.type,
        evt.private === true
          ? redactPrompts(evt.data && typeof evt.data === "object" ? evt.data : {})
          : (evt.data && typeof evt.data === "object" ? evt.data : {}),
      ),
      prev: st.head || GENESIS,
    };
    const line = JSON.stringify(full);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, line + "\n", "utf8");
    st.head = hashLine(line);
    st.count += 1;
    return full;
  });
  // Keep the tail alive even when this append fails, or one bad write would
  // wedge every later one behind a rejected promise.
  st.tail = run.catch(() => {});
  return run;
}

/** The current chain head for a scope (null when the ledger is empty). */
export async function head(scope) {
  const file = scopePath(scope);
  const st = chainState(file);
  await st.tail;
  await loadChain(file, st);
  return st.head;
}

/**
 * Read events. `asset` filters exact; `assetPrefix` filters by prefix;
 * unknown event types round-trip unharmed. A corrupt line is skipped and
 * counted rather than hiding the rest of the file.
 */
export async function read(scope, { asset, assetPrefix, type, limit } = {}) {
  const file = scopePath(scope);
  const st = chainState(file);
  await st.tail; // settle in-flight appends so a read sees its own writes
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { /* none yet */ }
  const lines = raw.split("\n").filter((l) => l.trim().length);
  const events = [];
  let corrupt = 0;
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { corrupt++; }
  }
  let out = events;
  if (asset) out = out.filter((e) => e.asset === asset);
  if (assetPrefix) out = out.filter((e) => String(e.asset || "").startsWith(assetPrefix));
  if (type) out = out.filter((e) => e.type === type);
  const total = out.length;
  if (limit && out.length > limit) out = out.slice(-limit);
  return { events: out, total, all: events.length, corrupt, head: lines.length ? hashLine(lines[lines.length - 1]) : null };
}

/**
 * Walk the whole chain. Proves internal consistency only — see the header
 * for what an unsigned local chain does and does not establish.
 */
export async function verify(scope) {
  const file = scopePath(scope);
  const st = chainState(file);
  await st.tail;
  let raw = "";
  try { raw = await readFile(file, "utf8"); } catch { return { ok: true, count: 0, head: null }; }
  const lines = raw.split("\n").filter((l) => l.trim().length);
  let prevHash = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, count: lines.length, brokenAt: i, why: "unparsable line" }; }
    if (e.prev !== prevHash) {
      return { ok: false, count: lines.length, brokenAt: i, why: `prev mismatch (expected ${prevHash}, recorded ${e.prev})` };
    }
    prevHash = hashLine(lines[i]);
  }
  return { ok: true, count: lines.length, head: lines.length ? prevHash : null };
}

/* ───────────────────────────────────────────── origin folding (D1.3) */

/* Three GROUPS, four actor classes: `script:*` lands in "system" here, and
 * that is not an oversight but the whole reason a fourth class was safe to add.
 * A harness has exactly the standing an internal job has — it promotes nothing,
 * demotes nothing, and folds to the same origin class the same events folded to
 * before the class existed. The extra name is for the READER of the ledger, not
 * for the labelling maths. provenance_test.js pins both halves. */
/* ⚠ A PEER FALLS INTO `system` HERE AND THAT IS THE DECISION, NOT AN OVERSIGHT.
 * See PEER_RE above: a human edit on a machine this Studio cannot see must not
 * promote an asset's origin class, because the promotion is a claim about this
 * asset and the only evidence for it is a string somebody else's door wrote. */
const actorGroup = (a) =>
  a === "user" ? "user" : String(a || "").startsWith("agent:") ? "agent" : "system";

/**
 * Fold one asset's events into its origin row. The pro-human rule, applied
 * honestly: human classes are DISPLAYED first but never ASSIGNED without a
 * supporting event, and only actor=user edits promote ai-generated to
 * ai-assisted-human-edited.
 */
export function foldOrigin(events) {
  const o = {
    class: null, model: null, modelVersion: null, outputRights: null,
    counts: {}, editsBy: { user: 0, agent: 0, system: 0 },
    authoredBy: { user: 0, agent: 0, system: 0 },
    attributions: [], firstAt: null, lastAt: null, events: events.length,
  };
  for (const e of events) {
    o.counts[e.type] = (o.counts[e.type] || 0) + 1;
    const who = actorGroup(e.actor);
    if (!o.firstAt) o.firstAt = e.t;
    o.lastAt = e.t;
    switch (e.type) {
      case "record":
        o.class = "human-recorded";
        break;
      case "generate":
        // Analysis outputs (transcriptions) are ai-generated artifacts too;
        // for media assets a generate resets the base class unless a capture
        // already claimed it (a recording is never re-labeled by a model run).
        if (o.class !== "human-recorded") o.class = "ai-generated";
        if (e.data?.model) o.model = e.data.model;
        if (e.data?.modelVersion !== undefined) o.modelVersion = e.data.modelVersion;
        /* Travels with `model` down the same path, so the chip on an origin row
         * is answering for the model that row NAMES. A pre-stamp generation
         * (anything made before this field existed) folds to null, and the UI
         * says nothing rather than back-dating an answer onto it. */
        if (e.data?.outputRights) o.outputRights = e.data.outputRights;
        break;
      case "author_text":
      case "author_layer":
        o.authoredBy[who]++;
        if (who === "user" && o.class === null) o.class = "human-authored";
        break;
      case "edit":
        o.editsBy[who]++;
        if (who === "user" && o.class === "ai-generated") o.class = "ai-assisted-human-edited";
        // A composite assembled from sources this ledger has no events for
        // (e.g. a VFX render landing in the clips library): the honest label
        // is composite — "parts may be AI-generated" — never a guess.
        else if (o.class === null && e.data?.origin) o.class = "composite";
        break;
      case "import":
        if (o.class === null) {
          o.class = e.data?.declared === "human-recorded" ? "human-recorded" : "third-party-licensed";
        }
        break;
      case "licence_attach":
        o.class = "third-party-licensed";
        o.attributions.push({
          spdx: e.data?.spdx ?? null,
          text: e.data?.attributionText ?? null,
          url: e.data?.sourceUrl ?? null,
        });
        break;
      default:
        break; // selection/process evidence types don't change the class
    }
  }
  return o;
}

/** Read + fold one asset. */
export async function summarize(scope, asset) {
  const { events, head: h } = await read(scope, { asset });
  return { asset, ...foldOrigin(events), chainHead: h };
}

/* ─────────────────────────────────────────────── the Tier-1 marker (D3.1) */

/**
 * The machine-readable AI marker for an origin class. Small, boring, always
 * the same shape — this is the Art-50 layer, and the callers that embed it do
 * so unconditionally for AI-origin media (D5.3: the marker is pinned; the
 * detailed record is the user's toggle).
 */
export function markerFor(cls, { model, modelVersion, media = "content" } = {}) {
  const gen = [model, modelVersion].filter(Boolean).join(" ") || null;
  const c = DIGITAL_SOURCE_TYPE[cls] ? cls : "composite";
  const sentences = {
    "ai-generated": `AI-generated ${media}: created with ${gen || "a generative model"}. Machine-generated content.`,
    "ai-assisted-human-edited": `Contains AI-generated material (${gen || "generative model"}), edited by a person.`,
    "composite-synthetic": `Composite ${media} containing AI-generated material.`,
    "composite": `Composite ${media}; parts may be AI-generated (origin partially unrecorded).`,
    "third-party-licensed": `Contains third-party licensed material; see attribution.`,
    "human-authored": `Human-authored ${media}, made with non-generative tools.`,
    "human-recorded": `Human performance, captured from real life.`,
  };
  return {
    digitalSourceType: DIGITAL_SOURCE_TYPE[c],
    disclosure: sentences[c],
    generator: gen,
    tool: TOOL,
  };
}

/* ──────────────────────────────────────────────────── sidecar (D3.3) */

/**
 * `<file>.provenance.json` — for containers that cannot carry the payload
 * (Opus/OGG until the C2PA SDK ships OGG, LRC, odd image formats). The UI
 * never claims embedding when this is the path that happened.
 */
export async function writeSidecar(filePath, payload) {
  const out = `${filePath}.provenance.json`;
  await writeFile(out, JSON.stringify(payload, null, 2), "utf8");
  return out;
}
