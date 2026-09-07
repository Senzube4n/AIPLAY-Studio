/**
 * THE REFERENCE PROFILE — the route half.
 *
 * Four actions, one mount. `createDawRoutes` calls handleProfileAction the way
 * it already calls handleMixerAction and handleVoiceLabAction: before the
 * switch, same `safe`, same catch, same error shape. Nothing in here writes a
 * project document, and nothing in here ever writes audio.
 *
 *   profile_build   separate a track into four stems (through the app's own
 *                   /api/stems door, which is demucs) and measure its SHAPE
 *   profile_list    the profiles on this machine, as summaries
 *   profile_get     one profile, whole
 *   profile_delete  remove one
 *
 * Profiles live at `<DAW_DIR>/_profiles/<id>.json`, beside the projects rather
 * than inside one, because a reference is a thing you match SEVERAL projects
 * against — it belongs to the machine, not to a song.
 *
 * ── WHAT A PROFILE IS, RESTATED HERE BECAUSE THIS IS THE DOOR ─────────────
 * dB numbers, times in milliseconds and counts. refprofile.py's
 * `check_shape_only()` refuses to emit anything outside a declared whitelist,
 * and this file re-runs that whitelist over what came back before writing it
 * to disk — the same rule, checked on both sides of the pipe, because the
 * thing it protects (that we never copy anybody's audio out of their track)
 * is the thing that would otherwise quietly become a licensing problem when
 * this fork goes public.
 *
 * ── THE SEPARATION IS THE APP'S OWN, NOT A SECOND COPY OF IT ──────────────
 * demucs already runs here: `POST /api/stems {action:"run", file}` puts a
 * four-stem job on the same idle-drain queue as cover art, and it lands at
 * `<outputDir>/stems/<model>/<song>/<part>.flac`. This module asks THAT door
 * and waits for the files; it never spawns demucs itself, never knows which
 * python demucs runs in, and never learns the model name from anywhere but
 * `config.stems.model`. If the stems are already there — which is the usual
 * case, since the app separates tracks on its own — nothing is queued at all.
 *
 * ── AND THE ONE PLACE THAT COSTS A STAGED COPY ────────────────────────────
 * `/api/stems` takes a BARE FILENAME in the output root: no slashes, by its
 * own check. A file the owner dropped in `<DAW_DIR>/reference/` is therefore
 * unreachable through that door as it stands, so it is copied to the output
 * root under a derived name for the length of the separation and removed
 * afterwards — the same staging discipline art.js already uses to get a clip
 * into ComfyUI's input directory. The copy is named from the file's own
 * digest, so a second build of the same reference reuses the same stem folder
 * instead of separating it twice.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, stat, unlink, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";

import { DAW_DIR } from "./store.js";

/** The actions this module dispatches — for the parity census. */
export const REFPROFILE_ACTIONS = [
  "profile_build", "profile_list", "profile_get", "profile_delete",
];

/** The four parts demucs writes, in the order a profile reports them. */
export const PROFILE_STEMS = ["drums", "bass", "other", "vocals"];

/** How long a build will wait for a separation that is queued behind other
 *  work, before answering "not yet" rather than hanging on a socket. The
 *  stems queue drains only when the generation queue is empty, so this is a
 *  wait on the machine, not on demucs (which measured ~12 s for 30 s of
 *  audio). */
export const SEPARATE_WAIT_MS = 10 * 60 * 1000;
const POLL_MS = 2000;

/** The one place the profile directory is named. */
export const profilesDir = () => path.join(DAW_DIR(), "_profiles");
export const referenceDir = () => path.join(DAW_DIR(), "reference");

const AUDIO_RE = /\.(wav|flac|mp3|m4a|aac|ogg|opus|aif|aiff)$/i;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A profile id: a slug, and refused rather than sanitised into something the
 *  caller did not ask for. */
export function profileId(v) {
  const s = String(v ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return ID_RE.test(s) ? s : null;
}

const sha10 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 10);

/* ══════════════════════════════ THE WHITELIST, ON THIS SIDE OF THE PIPE ══
 * refprofile.py enforces this before it prints. This is the same rule
 * enforced before we WRITE, so a profile that reached here some other way —
 * an older python on the path, a hand-edited file, a future mode that forgot
 * to call the checker — still cannot put audio on this disk under the name of
 * a shape. Two checks of one rule; neither is the other's backup, because
 * they guard different moments. */
export const MAX_ARRAY = 512;

/** Walk a profile and throw on anything that is not a shape. `allowed` comes
 *  from the python's own `probe` when the caller has it (one source of truth),
 *  and falls back to the structural half of the rule when it does not. */
export function checkShapeOnly(obj, allowed = null, max = MAX_ARRAY, at = "profile") {
  if (Array.isArray(obj)) {
    if (obj.length > max) {
      throw new Error(
        `${at}: ${obj.length} entries, over the ${max} cap. An array that long is `
        + "audio or a spectrogram, not a shape — a profile carries neither.");
    }
    obj.forEach((v, i) => {
      if (Array.isArray(v)) {
        throw new Error(`${at}[${i}]: nested arrays are how a spectrogram gets out; `
          + "a profile carries flat curves only.");
      }
      checkShapeOnly(v, allowed, max, `${at}[${i}]`);
    });
    return true;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (allowed && !allowed.has(k)) {
        throw new Error(
          `${at}.${k}: a profile is a SHAPE, never a sample. "${k}" is not a key `
          + "refprofile.py declares — if it really is a shape measurement, add it to "
          + "refprofile.ALLOWED_KEYS and say what it is.");
      }
      checkShapeOnly(v, allowed, max, `${at}.${k}`);
    }
    return true;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════ the summary ══
 * What a list row shows, what a tool answers with, and what the Ear's cards
 * are actually built from. Everything here is a number a knob can be set to;
 * the full curves stay in the file for the overlay to draw. */
export function summarise(p) {
  const kick = p?.kick || {};
  const shape = kick.shape || {};
  const grid = kick.grid || {};
  const pump = p?.pump || null;
  const st = p?.stems || {};
  return {
    id: p?.id || null,
    name: p?.name || null,
    seconds: p?.seconds ?? null,
    sr: p?.sr ?? null,
    resampled_from: p?.resampled_from ?? null,
    lufs: p?.master?.loudness?.lufs ?? null,
    true_peak_db: p?.master?.loudness?.true_peak_db ?? null,
    crest_db: p?.master?.loudness?.crest_db ?? null,
    width: p?.master?.stereo?.width ?? null,
    stems: Object.fromEntries(Object.keys(st).sort().map((s) => [s, {
      level_rel_mix_db: st[s]?.level_rel_mix_db ?? null,
      width: st[s]?.stereo?.width ?? null,
    }])),
    kick: {
      f0_hz: kick.f0_hz ?? null,
      onsets: kick.onsets ?? null,
      attack_ms: shape.attack_ms ?? null,
      t10_ms: shape.t10_ms ?? null,
      t30_ms: shape.t30_ms ?? null,
      t60_ms: shape.t60_ms ?? null,
      click_over_body_db: kick.click?.click_over_body_db ?? null,
      sub_over_kick_db: kick.sub_over_kick_db ?? null,
      /* The gate's verdict travels with every number that depends on it.
       * `grid_gated: false` means the onsets are raw flux peaks and the beat
       * is whatever they say it is — which is how 442 BPM happened. */
      grid_gated: grid.gated === true,
      grid_bpm: grid.implied_bpm ?? null,
      grid_salience: grid.salience ?? null,
      beat_bpm: shape.implied_bpm ?? null,
    },
    pump: pump ? {
      depth_db: pump.depth_db, depth_mad_db: pump.depth_mad_db,
      recovery_ms: pump.recovery_ms,
      recovery_frac_of_beat: pump.recovery_frac_of_beat,
      beat_s: pump.beat_s, hits: pump.hits,
    } : null,
    sections: (p?.sections || []).length,
    warnings: p?.warnings || [],
    built_at: p?.built_at ?? null,
  };
}

/* ════════════════════════════════════════════════════════════ the store ══ */

export async function listProfiles() {
  const dir = profilesDir();
  const out = [];
  for (const f of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".json"))) {
    try {
      const p = JSON.parse(await readFile(path.join(dir, f), "utf8"));
      out.push(summarise({ ...p, id: p.id || f.replace(/\.json$/, "") }));
    } catch { /* a half-written profile is not worth a 500 */ }
  }
  return out.sort((a, b) => String(b.built_at).localeCompare(String(a.built_at)));
}

export async function readProfile(id) {
  const key = profileId(id);
  if (!key) return null;
  try {
    const p = JSON.parse(await readFile(path.join(profilesDir(), `${key}.json`), "utf8"));
    return { ...p, id: p.id || key };
  } catch { return null; }
}

async function writeProfile(id, profile, allowed) {
  checkShapeOnly(profile, allowed);
  await mkdir(profilesDir(), { recursive: true });
  const file = path.join(profilesDir(), `${id}.json`);
  await writeFile(file, JSON.stringify(profile, null, 1), "utf8");
  return file;
}

/* ═════════════════════════════════════════════════════ demucs, next door ══ */

/** Which of the four parts are on disk, whatever container they came in. */
async function stemsIn(dir) {
  const names = await readdir(dir).catch(() => null);
  if (!names) return null;
  const have = {};
  for (const s of PROFILE_STEMS) {
    const hit = names.find((n) => AUDIO_RE.test(n) && n.replace(AUDIO_RE, "") === s);
    if (hit) have[s] = hit;
  }
  return have;
}

/** Ask the app's own stems door to separate a file in the output root. */
async function requestSeparation(config, bare) {
  const r = await fetch(`http://127.0.0.1:${config.uiPort}/api/stems`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-aiplay-actor": "system:refprofile" },
    body: JSON.stringify({ action: "run", file: bare }),
  });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(`the stems door refused "${bare}": ${j.error}`);
  return j;
}

/** Wait for the four parts, or say how long we waited and give up cleanly. */
async function waitForStems(dir, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const have = await stemsIn(dir);
    if (have && Object.keys(have).length >= 3) return have;
    if (Date.now() >= until) return null;
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

const digestOf = (file) => new Promise((resolve, reject) => {
  const h = createHash("sha1");
  createReadStream(file, { start: 0, end: 1 << 20 })          // the first MB is plenty
    .on("data", (d) => h.update(d))
    .on("error", reject)
    .on("end", () => resolve(h.digest("hex").slice(0, 10)));
});

/* ════════════════════════════════════════════════════════════ the mount ══ */

/**
 * ctx: { runProfile, safe?, config }
 *   runProfile  (mode, job, timeoutMs) -> the python's reply. routes.js binds
 *               this to refprofile.py through the same one-JSON-line contract
 *               engine.py and capture.py use.
 *   config      the app's config: uiPort (the stems door), outputDir, stems.
 */
export async function handleProfileAction(action, b, ctx) {
  if (!REFPROFILE_ACTIONS.includes(action)) return null;
  switch (action) {
    case "profile_build": return buildProfile(b, ctx);
    case "profile_list": return { ok: true, profiles: await listProfiles(), dir: profilesDir() };
    /* `profile` IS THE NAME. The `?? b.id` below is a compatibility tail, not
     * a second spelling: it is what made the panel's `id` work in silence
     * while daw_profile_get declared `profile`, so the census saw two hands
     * agreeing when they were saying different words. web/voicelab.js now
     * posts `profile`, server/daw/ui_test.js's profile-family gate holds both
     * directions to it, and this tail stays only for anything older. */
    case "profile_get": {
      const p = await readProfile(b.profile ?? b.id);
      if (!p) throw new Error(`No such profile "${b.profile ?? b.id}". ` + KNOWN_HINT);
      return { ok: true, profile: p, summary: summarise(p) };
    }
    case "profile_delete": {
      const key = profileId(b.profile ?? b.id);
      if (!key) throw new Error("profile must be an id: lowercase letters, digits, - and _.");
      const file = path.join(profilesDir(), `${key}.json`);
      try { await stat(file); } catch { throw new Error(`No such profile "${key}". ` + KNOWN_HINT); }
      await unlink(file);
      return { ok: true, deleted: key,
               note: "The profile is gone. Its stems, if the app separated them, are "
                 + "not — they are the library's, and a profile never owned them." };
    }
    default: return null;
  }
}

const KNOWN_HINT = 'Ask action:"profile_list" for the ones on this machine.';

/**
 * Build one.
 *
 * body:
 *   file        a bare filename in the output root, or a filename in
 *               <DAW_DIR>/reference/ — the owner's own copy of a track
 *   stem_dir    an already-separated folder, absolute (the escape hatch)
 *   name, id    what to call it; both derived from the file when absent
 *   separate    ask the stems door when the stems are missing (default true)
 *   wait_ms     how long to wait for that separation
 */
async function buildProfile(b, ctx) {
  const config = ctx.config;
  if (!config) throw new Error("profile_build needs the app config (the stems door and the output root).");
  const t0 = Date.now();
  const model = config.stems?.model || "htdemucs_ft";
  const stemsRoot = path.join(config.outputDir, "stems");

  let stemDir = null;
  let mixPath = null;
  let staged = null;
  let source = null;
  const demucs = { requested: false, waited_ms: 0, model, note: null };

  if (b.stem_dir) {
    stemDir = path.resolve(String(b.stem_dir));
    source = { kind: "stem_dir", name: path.basename(stemDir) };
  } else {
    const bare = path.basename(String(b.file ?? ""));
    if (!bare || bare !== String(b.file ?? "") || !AUDIO_RE.test(bare)) {
      throw new Error(
        "profile_build takes `file`: the name of an audio file, either in the "
        + "output root (a track the app made) or in the DAW's own reference folder "
        + `(${referenceDir()}) — where a track you own goes. Or `
        + "`stem_dir`, if you have already separated one somewhere else.");
    }
    const inRef = path.join(referenceDir(), bare);
    const inLib = path.join(config.outputDir, bare);
    let src = null;
    try { await stat(inRef); src = { path: inRef, where: "reference" }; } catch { /* try the library */ }
    if (!src) {
      try { await stat(inLib); src = { path: inLib, where: "library" }; } catch { /* neither */ }
    }
    if (!src) {
      throw new Error(
        `"${bare}" is in neither ${referenceDir()} nor the output root. Drop your own `
        + "copy of the track in the reference folder — this program never downloads a "
        + "reference and never reproduces one; it measures the shape of a file you "
        + "already have.");
    }
    mixPath = src.path;
    source = { kind: src.where, name: bare };

    /* THE STEM FOLDER'S NAME IS THE SEPARATOR'S RULE, NOT OURS. demucs writes
     * <out>/<model>/<name without extension>/. For a reference-folder file the
     * name is the staged copy's, which is derived from the file's own digest so
     * a second build finds the first build's stems. */
    const libStem = bare.replace(AUDIO_RE, "");
    const refStem = src.where === "reference"
      ? `aiplay_ref_${await digestOf(src.path)}` : libStem;
    stemDir = path.join(stemsRoot, model, refStem);

    let have = await stemsIn(stemDir);
    if (!have || Object.keys(have).length < 3) {
      if (b.separate === false) {
        throw new Error(
          `"${bare}" has not been separated (no stems at ${stemDir}) and separate:false `
          + "was asked for. A profile is measured PER STEM — drums, bass, other, vocals "
          + "— so there is nothing to measure without them.");
      }
      /* Stage, if the source is not already where the stems door can see it. */
      let askFor = bare;
      if (src.where === "reference") {
        staged = path.join(config.outputDir, `${refStem}${path.extname(bare)}`);
        await copyFile(src.path, staged);
        askFor = path.basename(staged);
        demucs.note = "the reference folder is not the output root and the stems door "
          + "takes a bare filename there, so the file was copied in under a name derived "
          + "from its own digest and removed again once the stems landed";
      }
      demucs.requested = true;
      const t1 = Date.now();
      await requestSeparation(config, askFor);
      const waitMs = Number.isFinite(Number(b.wait_ms))
        ? Math.max(0, Math.min(Number(b.wait_ms), 60 * 60 * 1000)) : SEPARATE_WAIT_MS;
      have = await waitForStems(stemDir, waitMs);
      demucs.waited_ms = Date.now() - t1;
      if (!have) {
        if (staged) await unlink(staged).catch(() => {});
        return {
          ok: true, built: false, pending: true, source, demucs,
          stem_dir: stemDir,
          note: `The separation is queued but had not finished after ${Math.round(demucs.waited_ms / 1000)} s. `
            + "It runs on the same idle-drain queue as cover art, so it waits for the "
            + "generation queue to empty — nothing is lost. Ask for this build again "
            + "when it has; the stems will be on disk and no second separation is queued.",
        };
      }
    }
  }

  try {
    const id = profileId(b.id ?? b.name ?? source.name.replace(AUDIO_RE, ""))
      ?? `ref-${sha10(source.name)}`;
    const name = String(b.name || source.name.replace(AUDIO_RE, ""));
    const r = await ctx.runProfile("build", {
      stem_dir: stemDir,
      mix_path: mixPath || undefined,
      name, id, model,
      sections: b.sections !== false,
    }, Number(b.timeout_ms) || 600_000);
    const profile = r.profile;
    if (!profile) throw new Error("refprofile.py answered without a profile.");
    profile.id = id;

    /* The whitelist, read from the python's OWN probe so there is one list and
     * not two. If the probe is unavailable the structural half of the rule
     * (array length, no nested arrays) still runs — a narrower check, said so
     * in the reply rather than passed off as the whole one. */
    let allowed = null;
    let keyCheck = "structural only (refprofile.py probe was unavailable)";
    try {
      const pr = await ctx.runProfile("probe", {}, 120_000);
      if (Array.isArray(pr?.allowed_keys)) {
        allowed = new Set(pr.allowed_keys);
        keyCheck = `${pr.allowed_keys.length} declared keys, re-checked here before writing`;
      }
    } catch { /* structural only, and the reply says so */ }
    const file = await writeProfile(id, profile, allowed);

    return {
      ok: true, built: true, id, path: file, source, demucs,
      stem_dir: stemDir,
      summary: summarise(profile),
      warnings: profile.warnings || [],
      shape_only: { checked: keyCheck, max_array: MAX_ARRAY, note: profile.shape_only_note },
      resampled_from: profile.resampled_from ?? null,
      resample_note: profile.resample_note ?? null,
      build_ms: profile.ms,
      ms: Date.now() - t0,
    };
  } finally {
    if (staged) await unlink(staged).catch(() => {});
  }
}
