/**
 * An API-format ComfyUI graph → the technical record of the render it asks for.
 *
 * PURE. No fs, no net, no server, no clock. It imports the model catalogue (to
 * name what made a picture) and node:crypto (hashing a string is arithmetic,
 * not I/O) and nothing else. Everything that needs a disk — how big that
 * .safetensors is, when it was written, what its SHA-256 is — is a hole this
 * module leaves NAMED and `null`, for `store.js` to fill. That split is what
 * lets the whole §8-D completeness suite run standalone in about a second, and
 * it is why a record can be built and shown to an agent (`dry_run`) before a
 * millisecond of GPU time is spent.
 *
 * ── WHAT THIS MODULE MAY AND MAY NOT CLAIM ────────────────────────────────
 *
 * This is a compliance record. The single worst thing it could do is guess
 * confidently: a `model` that names the wrong checkpoint gets the WRONG
 * LICENCE stamped onto the render by provenance.js's `stampRights()`, and a
 * `prompt` that names the wrong text node writes a sentence nobody typed into
 * a hash-chained file that is supposed to be evidence.
 *
 * So every resolution here is a UNIQUENESS ARGUMENT, never a heuristic:
 *
 *   · a field is hoisted out of an array only when exactly ONE node in the
 *     graph supplies it. Two samplers with two seeds leave `seed` null and both
 *     seeds in `samplers[]` — the array is always complete, the hoist is a
 *     convenience that is allowed to be absent.
 *   · a prompt is claimed only when the sampler's own `positive` link walks
 *     back to exactly one text node, or when the graph contains exactly one
 *     text and no sampler at all to walk from. Anything else is
 *     `promptResolved: false` with every text still listed in `texts[]`.
 *   · a `model` is claimed only when the graph's diffusion weights are a file
 *     the catalogue actually ships. Otherwise `null`, so that `stampRights()`
 *     stamps nothing rather than something wrong — which is exactly the rule
 *     that function already documents for itself.
 *
 * ── WHY THE FIELD NAMES ARE THE GRAPH'S OWN ───────────────────────────────
 *
 * `video_cfg` is recorded as `video_cfg`, not folded into `cfg`. LTX's
 * `LTXVDualCFGGuider` has two of them and they mean different things; a record
 * that flattened them would be smaller and wrong. Where the spec's shape and a
 * real graph in this repository disagree, the graph wins — noted at each site.
 */
import { createHash } from "node:crypto";
import { CATALOG, MODEL_TO_CAPABILITY } from "../models.js";
import { classify } from "../customWorkflows.js";

/** A ComfyUI API-format link: ["<node id>", <output slot>]. */
export const isLink = (v) =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && Number.isInteger(v[1]);

/**
 * Stable JSON — object keys sorted at every level, so two graphs that differ
 * only in the order their builder happened to assign nodes hash the same.
 *
 * Ported from the base repo's `scripts/gate_lib.mjs`, which uses it for exactly
 * this reason: a hundred arms of one sweep must share ONE stored graph, and
 * they would not if `{a,b}` and `{b,a}` hashed differently.
 */
export const sortedJSON = (o) => JSON.stringify(o, (_, v) =>
  (v && typeof v === "object" && !Array.isArray(v))
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v);

export const sha256 = (s) => `sha256:${createHash("sha256").update(String(s), "utf8").digest("hex")}`;

/** The verbatim prompt is capped so one pasted novel cannot make a ledger line
 *  unreadable. The HASH is always of the WHOLE text — a truncated hash would
 *  match nothing and quietly defeat the point of recording one. */
export const PROMPT_CAP = 4000;

/* ───────────────────────────────── what is a sampler ─────────────────────── */

/**
 * ⚠ THE SPEC SAID "any class ending `Sampler`". THE GRAPHS IN THIS REPOSITORY
 * SAY OTHERWISE, and the graphs win.
 *
 * `server/workflow.js`'s LTX clip — the most expensive thing this app renders —
 * contains no `KSampler` at all. Its knobs are spread over five nodes:
 *
 *     RandomNoise            noise_seed          ← the seed
 *     KSamplerSelect         sampler_name        ← the sampler
 *     ManualSigmas           (a sigma schedule)
 *     LTXVDualCFGGuider      video_cfg/audio_cfg ← the cfg, twice
 *     SamplerCustomAdvanced  (wires them together)
 *
 * and the FLUX.2 cover graph puts `steps` on a `Flux2Scheduler`. A rule that
 * only matched "ends with Sampler" would have recorded a clip with no seed, no
 * cfg and no step count while reporting itself complete — the exact failure
 * this whole record exists to make impossible.
 *
 * So: the nodes that CONFIGURE sampling, by class name or by carrying a seed.
 * Broad on purpose. A node swept in here that turns out to hold none of the
 * knobs below contributes an entry with nulls and costs nothing; a node left
 * out loses a number nobody can recover later.
 */
const SAMPLERISH = /sampler|sampling|scheduler|sigmas|guider|noise/i;

/** The knobs worth naming, in the graph's own vocabulary. Scalars and strings
 *  only: `ManualSigmas.sigmas` is a hundred floats and belongs in the stored
 *  graph, not in a ledger line. */
const SAMPLER_KNOBS = [
  "seed", "noise_seed", "steps", "cfg", "video_cfg", "audio_cfg",
  "sampler_name", "scheduler", "denoise", "shift", "start_at_step", "end_at_step",
  "max_shift", "base_shift", "guidance", "add_noise", "sampling_mode",
];

/** Model-bearing inputs. `sampler_name` deliberately does not match — it ends
 *  `r_name`, and none of the alternatives below completes that word. */
const MODEL_INPUT_RE = /(ckpt|unet|clip|vae|lora|model|style_model|control_net)_name$/;

/** A loader that reads a file the USER staged (a reference image, a source
 *  clip). `(^|_)Load[A-Z]` so `VHS_LoadVideo` counts and
 *  `CheckpointLoaderSimple` — which loads WEIGHTS — does not. */
const LOADER_RE = /(^|_)Load[A-Z]/;
/* ⚠ `LoadVideo`'s input is called `file`, not `video` (server/workflow.js:1149,
 * the restyle graph's node 30). The spec's §6 says `LoadVideo.video`; the code
 * wins, so every plausible name is accepted rather than one guessed one. */
const REFERENCE_INPUTS = new Set(["image", "video", "audio", "file", "latent", "mask", "clip_file"]);

/* ────────────────────────────────── the walk ─────────────────────────────── */

/**
 * Walk one conditioning role backwards to the text that made it.
 *
 * Deliberately NOT a full ancestor walk. Following every input of every node
 * would reach the positive AND the negative text from either starting point —
 * `LTXVAddGuide` takes both — and a record that reports the negative prompt as
 * the positive one is worse than a record that reports neither.
 *
 * So the walk follows exactly one thread: the input with the SAME ROLE NAME, or
 * the node's single link when it is an unambiguous pass-through
 * (`ConditioningZeroOut`, `ReferenceLatent`, `ConditioningStableAudio`). The
 * moment it is ambiguous, it stops and says so.
 *
 * Returns { node, text } | { zeroed: true } | null.
 */
function walkToText(graph, start, role, depth = 0) {
  if (depth > 64 || !start || !isLink(start)) return null;
  const id = start[0];
  const node = graph[id];
  if (!node || typeof node.inputs !== "object") return null;

  /* A zeroed conditioning is not an unresolved negative — it is the positive
   * answer "this graph has NO negative prompt", which is what FLUX.2 klein
   * does (workflow.js:305, ConditioningZeroOut on the positive). Reporting the
   * positive text as the negative here would be a lie the fold could not
   * detect. */
  if (/ZeroOut/i.test(node.class_type || "")) return { zeroed: true };

  for (const [k, v] of Object.entries(node.inputs)) {
    if ((k === "text" || k === "prompt") && typeof v === "string") return { node: id, text: v };
  }

  const sameRole = node.inputs[role];
  if (isLink(sameRole)) return walkToText(graph, sameRole, role, depth + 1);

  const links = Object.values(node.inputs).filter(isLink);
  if (links.length === 1) return walkToText(graph, links[0], role, depth + 1);
  return null;
}

/* ──────────────────────────────── the catalogue ──────────────────────────── */

const baseName = (f) => String(f || "").split("\\").join("/").split("/").pop().toLowerCase();

/**
 * Which catalogue key made this? Generalised from `models.js:engineFromModelFile`,
 * which answers the same question for the four IMAGE engines only, over the
 * same restriction and for the same reason: match ONLY on diffusion weights.
 *
 * The Qwen3-4B text encoder is byte-identical across FLUX.2 klein, Z-Image and
 * Z-Image base and appears in all three catalogue entries, so matching on any
 * file would let the shared encoder claim every render for whichever entry was
 * found first — and the thing that gets stamped onto the render from this
 * answer is a LICENCE.
 *
 * A file the catalogue does not ship returns null, and null means
 * `stampRights()` stamps nothing. That is deliberate and it is the only honest
 * answer: a `CheckpointLoaderSimple` in an SFX graph is loading a file WE ship,
 * so calling it "checkpoint" (the class meaning "the user supplied this and we
 * cannot read its licence") would be as wrong as naming the wrong model.
 */
export function modelKeyFromFiles(files) {
  const names = new Set(files.map((f) => baseName(f.file)).filter(Boolean));
  /* The same references kept WHOLE, for the `identifies` tail match below. A
   * graph widget carries whatever the loader was given — "flux2-vae.safetensors"
   * or "triposg/vae/diffusion_pytorch_model.safetensors" — and the second form
   * is the only one that can be told apart from every other diffusers file. */
  const refs = files.map((f) => String(f.file || "").split("\\").join("/").toLowerCase())
    .filter(Boolean);
  const hits = new Set();
  for (const [key, capId] of Object.entries(MODEL_TO_CAPABILITY)) {
    const cap = CATALOG.find((c) => c.id === capId);
    for (const f of cap?.files || []) {
      const dest = String(f.dest || "").split("\\").join("/").toLowerCase();
      /* ⚠ THE SECOND WAY TO EARN THE RIGHT TO CLAIM A RENDER, and it is a
       * DECLARED PATH TAIL rather than a widened directory rule.
       *
       * The directory rule below stays exactly as it was, because the defect it
       * prevents is still live: the Qwen3-4B text encoder is byte-identical
       * across three catalogue rows, so matching on any file at all would let a
       * shared encoder stamp one row's licence on another row's render.
       *
       * What it could not express is a model whose weights are not in the
       * engine's tree at all. `server/mesh/` reads TripoSG and UniRig out of a
       * folder BESIDE ComfyUI (MESH() in models.js) precisely so that no engine
       * loader offers them — and the consequence was that both rows could sit in
       * MODEL_TO_CAPABILITY and be invisible to the one walk that reads it,
       * which stamps every such render `unknown`.
       *
       * So a file may declare `identifies: "<tail>"`, and the match is against
       * the WHOLE tail, not the basename. That distinction is the entire safety
       * of it: these two models keep the diffusers layout their loaders require,
       * so their basenames are `diffusion_pytorch_model.safetensors` and
       * `model.safetensors` — the names every diffusers repository on earth
       * uses. A basename match would hand TripoSG's licence to any graph that
       * loaded any diffusers checkpoint. A tail match cannot: a graph that names
       * only the basename fails to match and the render stamps `unknown`, which
       * is the honest answer rather than a confident wrong one.
       *
       * `models_control_test.js` pins both halves — that the tail matches and
       * that the bare basename does not. */
      if (typeof f.identifies === "string" && f.identifies) {
        const tail = f.identifies.split("\\").join("/").toLowerCase();
        if (refs.some((r) => r === tail || r.endsWith(`/${tail}`))) hits.add(key);
        continue;
      }
      if (!dest.includes("/diffusion_models/") && !dest.includes("/unet/")) continue;
      if (names.has(dest.split("/").pop())) hits.add(key);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/* ─────────────────────────────── graph problems ──────────────────────────── */

/**
 * What is structurally wrong with this graph, in sentences a person can act on.
 *
 * The first two reuse `customWorkflows.classify()` — the same check the custom
 * workflow importer already runs — because the API-format-versus-editor-save
 * distinction is the single most common way a hand-made graph fails, and the
 * two files look equally like JSON. One classifier, one verdict, both doors.
 */
export function graphProblems(graph) {
  const bad = [];
  const verdict = classify(graph);
  if (!verdict.ok) {
    bad.push({
      "ui-format": "This is ComfyUI's editor save, not the API format. In ComfyUI, turn on Dev Mode "
        + "in settings and use \"Save (API Format)\" instead — /prompt cannot execute an editor document.",
      "not-api-format": "Every entry in an API-format graph needs a class_type. This does not look like one.",
      "not-an-object": "The graph is not a JSON object.",
      "empty": "The graph has no nodes.",
    }[verdict.reason] || verdict.reason);
    return bad;
  }
  for (const [id, node] of Object.entries(graph)) {
    if (!node.inputs || typeof node.inputs !== "object") { bad.push(`node ${id} (${node.class_type}) has no inputs object`); continue; }
    for (const [k, v] of Object.entries(node.inputs)) {
      if (isLink(v) && !graph[v[0]]) bad.push(`node ${id}.${k} links to node ${v[0]}, which is not in this graph`);
    }
  }
  return bad;
}

/* ──────────────────────────────── the record ─────────────────────────────── */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The one value every entry agrees on, or null. This IS the hoisting rule:
 *  "exactly one node supplies it" — not "the first one wins". */
function soleValue(rows, key) {
  const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
  if (vals.length !== 1) return null;
  return vals[0];
}

/** The one DISTINCT value, for knobs many nodes legitimately repeat: LTX writes
 *  the same frame rate onto `LTXVConditioning`, `LTXVEmptyLatentAudio` and
 *  `CreateVideo`, and three agreeing copies of 24 are still one frame rate. */
function soleDistinct(vals) {
  const uniq = [...new Set(vals.filter((v) => v !== null && v !== undefined))];
  return uniq.length === 1 ? uniq[0] : null;
}

/**
 * Build the record.
 *
 * @param {object} graph  an API-format graph: { "<id>": { class_type, inputs } }
 * @param {object} ctx    everything the graph cannot know about itself — who
 *                        asked, which run this is, what the engine is. Every
 *                        key defaults to null rather than being absent: a field
 *                        that silently vanishes is exactly what §8-D fails on.
 */
export function buildRecord(graph, ctx = {}) {
  const nodes = Object.entries(graph && typeof graph === "object" ? graph : {});

  /* ── texts, samplers, latents, files ── */
  const texts = [];
  const samplers = [];
  const latents = [];
  const engineFiles = [];
  const loras = [];
  const references = [];
  const outputPrefixes = [];
  const rates = [];

  for (const [id, node] of nodes) {
    const cls = String(node?.class_type || "");
    const inputs = (node && typeof node.inputs === "object" && node.inputs) || {};

    for (const [k, v] of Object.entries(inputs)) {
      if ((k === "text" || k === "prompt") && typeof v === "string") {
        texts.push({ node: id, class: cls, input: k, value: v });
      }
      if (k === "filename_prefix" && typeof v === "string") outputPrefixes.push(v);
      if ((k === "fps" || k === "frame_rate") && typeof v === "number") rates.push(v);

      if (typeof v === "string" && MODEL_INPUT_RE.test(k)) {
        const entry = { node: id, class: cls, input: k, file: v, bytes: null, mtimeMs: null, sha256: null };
        if (k === "lora_name") {
          loras.push({
            ...entry,
            strength_model: num(inputs.strength_model),
            strength_clip: num(inputs.strength_clip),
          });
        } else {
          engineFiles.push(entry);
        }
      }

      if (typeof v === "string" && LOADER_RE.test(cls) && REFERENCE_INPUTS.has(k)) {
        references.push({ node: id, class: cls, input: k, file: v, bytes: null, mtimeMs: null, sha256: null });
      }
    }

    const hasSeed = inputs.seed !== undefined || inputs.noise_seed !== undefined;
    if (SAMPLERISH.test(cls) || hasSeed) {
      const s = { node: id, class: cls, seed: null, steps: null, cfg: null, sampler_name: null, scheduler: null, denoise: null, shift: null };
      for (const k of SAMPLER_KNOBS) {
        const v = inputs[k];
        if (v === undefined || v === null) continue;
        if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") continue;
        s[k] = v;
      }
      // `noise_seed` and `seed` are the same idea under two node vocabularies.
      if (s.seed === null && s.noise_seed !== undefined && s.noise_seed !== null) s.seed = s.noise_seed;

      /* ⚠ THE STEP COUNT OF A GRAPH THAT HAS NO `steps` INPUT.
       *
       * LTX 2.5 — the shape this app renders most, and the expensive one — is
       * driven by an explicit sigma schedule on `ManualSigmas`, so `steps`
       * hoists to null and the Steps column is blank on every LTX clip. The
       * sigma VALUES stay out of the ledger line for the reason given above (a
       * hundred floats belong in the stored graph, not in a line somebody has
       * to read), but their COUNT is one integer and it is the number a person
       * means by "how many steps": it is what separates a six-step draft from a
       * twenty-step final, which is the comparison the activity table exists
       * for.
       *
       * Counted rather than parsed: anything that is not a number is not a
       * step, so a malformed list under-reports instead of inventing. */
      if (typeof inputs.sigmas === "string") {
        const n = inputs.sigmas.split(",").map((x) => Number(x.trim())).filter(Number.isFinite).length;
        if (n > 0) s.sigmaSteps = n;
      }
      samplers.push(s);
    }

    /* A latent, not a resize. `ImageScale` also carries width and height —
     * requiring a batch/length input is what tells the thing that DEFINES the
     * render's size apart from the thing that rescales a picture on the way
     * out. (workflow.js:1160 is exactly such an ImageScale.) */
    const w = num(inputs.width), h = num(inputs.height);
    const len = num(inputs.length) ?? num(inputs.frames_number) ?? null;
    const batch = num(inputs.batch_size);
    if (w !== null && h !== null && (len !== null || batch !== null)) {
      latents.push({ node: id, class: cls, width: w, height: h, length: len, batch_size: batch });
    }
  }

  /* ── the prompt ── */
  const withRoles = samplers.filter((s) => graph[s.node]?.inputs?.positive !== undefined);
  let promptNode = null, negNode = null, negZeroed = false, promptFrom = null;
  for (const s of withRoles) {
    const pos = walkToText(graph, graph[s.node].inputs.positive, "positive");
    const neg = walkToText(graph, graph[s.node].inputs.negative, "negative");
    if (pos?.node) { if (promptNode && promptNode !== pos.node) { promptNode = null; break; } promptNode = pos.node; }
    if (neg?.zeroed) negZeroed = true;
    else if (neg?.node) { if (negNode && negNode !== neg.node) negNode = null; else negNode = neg.node; }
  }
  if (promptNode) promptFrom = "sampler-walk";

  /* THE SECOND PATH, and it is a uniqueness argument rather than a guess: a
   * graph the role walk found NOTHING in, holding exactly ONE text input, has
   * exactly one candidate. `server/mv/sfxcue.js`'s judge is that graph — a
   * CLIPLoader, a TextGenerate and a PreviewAny — and it renders no file at
   * all, so its prompt is the only thing about it there is to record. Leaving
   * it null because the spec's rule names a sampler would throw away the whole
   * record of a real call this app makes several hundred times a book.
   *
   * ⚠ THE CONDITION WAS `samplers.length === 0`, AND THAT WAS WRONG FOR THE
   * CLIP THIS APP RENDERS MOST. `workflow.js`'s H3 graph puts its prompt on the
   * VIDEO NODE — `MiniMaxH3ImageToVideo.prompt` — and contains no
   * CLIPTextEncode at all, while SAMPLERISH quite correctly sweeps up the six
   * sampling nodes around it. So there WAS a sampler, its `positive` walked
   * back to no text, and a 512x320x56 clip was recorded with `prompt: null`
   * while the sentence that produced it sat in `texts[0]` two fields away.
   * Measured 2026-09-03, one job of each kind through art.js against a fake
   * engine; §11's "positive prompt, verbatim ✅" was false for clips until this
   * line changed.
   *
   * It stays an argument rather than a heuristic: it fires only when the walk
   * produced nothing at all — no positive, no negative, not even a zero-out —
   * and the graph holds exactly one text. One candidate, no competing role
   * assignment, nothing left to be wrong about. If the walk DID resolve a
   * negative, this stays silent rather than promote the text it found: a text
   * known to be a negative must never be recorded as the prompt.
   *
   * `promptFrom` still says which path was taken, so a reader can tell a walked
   * prompt from an inferred one rather than having to trust both equally. */
  if (!promptNode && !negNode && !negZeroed && texts.length === 1) {
    promptNode = texts[0].node;
    promptFrom = "sole-text";
  }
  /* Both roles landing on the same node means the walk lost the thread (a
   * pass-through that is not a zero-out), not that one text is both prompts. */
  if (negNode && negNode === promptNode) negNode = null;

  const positive = promptNode ? (texts.find((t) => t.node === promptNode)?.value ?? null) : null;
  const negative = negZeroed && !negNode ? "" : (negNode ? (texts.find((t) => t.node === negNode)?.value ?? null) : null);

  const cap = (s) => (typeof s === "string" && s.length > PROMPT_CAP ? s.slice(0, PROMPT_CAP) : s);

  /* ── the size ── */
  const oneLatent = latents.length === 1 ? latents[0] : null;
  const frames = oneLatent?.length ?? null;
  const fps = soleDistinct(rates);
  const seconds = frames !== null && fps ? Math.round((frames / fps) * 1000) / 1000 : null;

  const model = modelKeyFromFiles(engineFiles);
  const graphHash = sha256(sortedJSON(graph ?? {}));

  return {
    runId: ctx.runId ?? null,
    via: ctx.via ?? null,
    actor_echo: ctx.actor ?? null,
    /* `label` is the first 48 characters of the prompt (index.js sets
     * title: finalPrompt.slice(0, 48)), so it is content wearing a name. */
    label: ctx.private === true ? null : (ctx.label ?? null),
    note: ctx.note ?? null,
    project: ctx.project ?? null,
    shot: ctx.shot ?? null,

    graphHash,
    graphNodes: nodes.length,
    graphStored: ctx.graphStored ?? null,

    /* ⚠ PRIVATE RUNS KEEP THE SHAPE AND LOSE THE WORDS.
     *
     * Everything below this line is what somebody typed, and this record is the
     * single largest store of it in the app: measured on one real ledger, 1132
     * events carried the prompt verbatim, 1589 every text node, 332 a verbatim
     * negative, and 3405 a `label` that is its first 48 characters.
     *
     * The HASHES go with them, which looks over-cautious and is not. A prompt is
     * low-entropy text, so sha256 of one is a lookup key rather than an
     * anonymisation — measured on the same ledger, 305 of 419 promptHash
     * values were confirmed just by hashing candidates out of the picture
     * sidecar. Keeping the hash would keep the leak and drop only the
     * convenience.
     *
     * `promptResolved` and `promptFrom` stay: they say whether a prompt node was
     * FOUND and where, which is structure, not content, and it is how a render
     * that silently used no prompt at all is still diagnosable. */
    ...(ctx.private === true ? {
      prompt: null, promptTruncated: false, promptHash: null,
      negative: null, negativeHash: null, texts: [],
      redacted: ["prompt", "negative", "texts", "promptHash", "negativeHash", "label"],
    } : {
      prompt: cap(positive),
      promptTruncated: typeof positive === "string" && positive.length > PROMPT_CAP,
      promptHash: positive === null ? null : sha256(positive),
      negative: cap(negative),
      negativeHash: negative === null ? null : sha256(negative),
      texts: texts.map((t) => ({ ...t, value: cap(t.value) })),
    }),
    promptResolved: promptNode !== null,
    promptFrom,

    samplers,
    seed: soleValue(samplers, "seed"),
    steps: soleValue(samplers, "steps"),
    cfg: soleValue(samplers, "cfg"),

    latents,
    width: oneLatent ? oneLatent.width : null,
    height: oneLatent ? oneLatent.height : null,
    frames,
    fps,
    seconds,

    engineFiles,
    loras,
    references,
    outputPrefixes,

    model,
    enginePort: ctx.enginePort ?? null,
    engineVersion: ctx.engineVersion ?? null,
    engineArgvHash: ctx.engineArgvHash ?? null,
    adopt: ctx.adopt ?? null,
    wait: ctx.wait ?? null,
    timeoutMs: ctx.timeoutMs ?? null,
    appVersion: ctx.appVersion ?? null,
  };
}

/** Every field §3.2 of the spec promises. Exported so the completeness test
 *  cannot drift from the builder by being written out twice. */
export const RECORD_FIELDS = Object.freeze([
  "runId", "via", "actor_echo", "label", "note", "project", "shot",
  "graphHash", "graphNodes", "graphStored",
  "prompt", "promptTruncated", "promptHash", "negative", "negativeHash",
  "promptResolved", "promptFrom", "texts",
  "samplers", "seed", "steps", "cfg",
  "latents", "width", "height", "frames", "fps", "seconds",
  "engineFiles", "loras", "references", "outputPrefixes",
  "model", "enginePort", "engineVersion", "engineArgvHash",
  "adopt", "wait", "timeoutMs", "appVersion",
]);
