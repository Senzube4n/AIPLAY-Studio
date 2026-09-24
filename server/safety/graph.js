/**
 * THE MINORS CHECK, READ OFF A COMPOSED COMFYUI GRAPH.
 *
 * The engine door (server/engine/client.js dispatch()) calls this on every
 * graph before anything is recorded, stored or posted, and the engine's own
 * backstop (server/comfy_nodes/aiplay_safety_gate.py, through
 * server/safety/routes.js) calls it on every graph posted to ComfyUI by any
 * other route. It is the one place that sees the FINAL words after every
 * rewriter has run: wildcards, the persona fold, cover prompts written from
 * lyrics, MV clip prompts built from bibles and boards, the editor's prefixes,
 * custom workflows, raw graphs an agent posted to /api/engine. So it reads the
 * graph GENERICALLY rather than a list of known builder fields:
 *
 *   · every string input on every node, at any depth (AnimateDiff's prompt
 *     schedule is a JSON string under `schedule`, and is DECODED too, escapes
 *     and all; Qwen keeps its positive and negative on ONE node under `prompt`
 *     and `negative_prompt`; a custom workflow puts the prompt wherever its
 *     author wired it). Model and LoRA file names count too.
 *   · MINUS text that is PROVABLY negative. The graph is walked back from its
 *     outputs the way ComfyUI executes it, top-level wires only, carrying a
 *     mode: a sampler or guider whose cfg is a number of at least 1 turns its
 *     `negative` wire into NEGATIVE mode, and the conditioning nodes that pass
 *     a pair through (ControlNet, LTX guides, WAN...) send each half down its
 *     own wire. A text node reached ONLY in negative mode is negative. Anything
 *     reached in positive mode, anything the walk never reaches, and every
 *     negative when a sampler's cfg is below 1 or wired (at cfg 0 the sampler
 *     renders its negative) counts as positive: fail closed.
 *   · MINUS graphs that make no picture at all: every node is one of the
 *     classes this app's songs, chat, score reading and music-LoRA training
 *     are built from (NON_VISUAL_CLASSES). One class outside that list and
 *     the graph is read.
 *
 * AND ONE MORE REFUSAL, of its own: a picture graph whose words are WRITTEN
 * WHILE IT RUNS (a string node, a text generator, a caption file) cannot be
 * checked, so it is not run. UNVERIFIABLE says so and how to fix it.
 *
 * Pure: no fs, no net. The words never leave this function.
 */
import { checkPrompt } from "./minors.js";

export const UNVERIFIABLE_CODE = "unverifiable-text";
export const UNVERIFIABLE = "This graph writes its prompt while it runs, so the Studio cannot check it, and it was not run. "
  + "Type the finished words into the text node instead.";

/**
 * Every class a graph may hold and still make no picture: the loaders,
 * samplers and savers of this app's songs (YuE2, MiniMax Music, ACE-Step),
 * its chat and visual briefs (TextGenerate into PreviewAny / SaveText), its
 * score reading (SheetSage2) and its music-LoRA training. Measured against
 * every graph stored on the owner's rig (2026-09-24). A picture needs a
 * decoder or a saver that is not here, so a graph with any class outside this
 * list is read as a picture.
 */
export const NON_VISUAL_CLASSES = new Set([
  // loaders and generic sampling, harmless without a picture decoder
  "CheckpointLoaderSimple", "CLIPLoader", "DualCLIPLoader", "UNETLoader", "UnetLoaderGGUF", "CLIPLoaderGGUF",
  "VAELoader", "LoraLoader", "LoraLoaderModelOnly", "AudioEncoderLoader", "ModelSamplingAuraFlow",
  "ConditioningZeroOut", "KSampler", "KSamplerSelect", "ManualSigmas", "SamplerCustom",
  // audio in, audio out
  "LoadAudio", "VAEEncodeAudio", "VAEDecodeAudio", "VAEDecodeAudioTiled", "TrimAudioDuration",
  "SaveAudio", "SaveAudioMP3", "SaveAudioOpus", "SaveAudioFLAC", "PreviewAudio",
  "YuE2GenerateABC", "YuE2GenerateMusic", "EmptyYuE2LatentAudio", "AiplayYuE2Continue",
  "MiniMaxMusic3TextEncode", "EmptyMiniMaxMusic3LatentAudio",
  "TextEncodeAceStepAudio", "TextEncodeAceStepAudio1.5", "EmptyAceStepLatentAudio", "EmptyAceStep1.5LatentAudio",
  "ReferenceTimbreAudio", "SheetSage2AudioToABC",
  // music-LoRA training (its latents come from audio; an image set needs a class not listed)
  "TrainLoraNode", "SaveLoRA", "SaveLoRANode", "AiplaySaveLossJson",
  // words in, words out: chat, visual briefs, cue sheets
  "TextGenerate", "PreviewAny", "SaveText", "LoadImage",
]);
/** Kept for callers that asked the old question. */
export const NON_VISUAL_OUTPUTS = NON_VISUAL_CLASSES;

const isLink = (v) => Array.isArray(v) && v.length === 2
  && (typeof v[0] === "string" || typeof v[0] === "number") && Number.isInteger(v[1]);

/** An input key that says it is the negative prompt. */
export const NEGATIVE_KEY = /negative|(^|_)neg(_|$)|^neg(prompt|text)$/i;
/** The conditioning wires a sampler or guider takes. Exact names only: a
 *  guider's `model_negative` is a MODEL wire. */
const POSITIVE_WIRE = /^(positive|pos|positive_cond|positive_conditioning)$/i;
const NEGATIVE_WIRE = /^(negative|neg|negative_cond|negative_conditioning)$/i;
/** The classifier-free-guidance scale. At 1 the negative is not computed; above
 *  1 it is pushed away from; BELOW 1 it is blended in, and at 0 it is all that
 *  renders. FluxGuidance's `guidance` is distilled guidance, not CFG. */
const CFG_KEY = /^(cfg|video_cfg|audio_cfg|cfg_scale|guidance_scale)$/i;
/** Inputs a node takes its words through. A WIRE into one of these means the
 *  words are made while the graph runs. */
const TEXT_LINK_KEY = /^(text|texts|prompt|prompts|string|text_g|text_l|t5xxl|clip_l|schedule|positive_prompt|positive_text|text_positive|caption|captions)$/i;

/** The nodes that take a positive and a negative wire and hand out the pair
 *  as output 0 (positive) and output 1 (negative), anything after that being
 *  a latent. Read from ComfyUI's own sources (2026-09-24) and the Studio's. */
const PASS_THROUGH = new Set([
  "ControlNetApplyAdvanced", "ControlNetApplySD3", "LTXVConditioning", "LTXVAddGuide", "LTXVCropGuides",
  "LTXVImgToVideo", "WanVaceToVideo", "WanImageToVideo", "WanFirstLastFrameToVideo",
  "InstructPixToPixConditioning", "AiplaySparseCtrlApply",
]);
/** Text encoders that hold BOTH prompts on one node, the negative under a
 *  negative-named key feeding the sampler's negative. A negative-named key on
 *  any other class is read like any other words: nothing proves what a custom
 *  node does with it. */
const OWN_NEGATIVE = new Set([
  "TextEncodeQwenImage21", "WanVideoTextEncode", "WanVideoTextEncodeCached",
]);
/** Nodes that compute a string while the graph runs: ComfyUI's own string and
 *  text-generation nodes, and the popular packs' equivalents. */
const STRING_MAKERS = new Set([
  "StringConcatenate", "StringSubstring", "StringTrim", "StringReplace", "CaseConverter", "RegexExtract",
  "RegexReplace", "TextGenerate", "TextGenerateLTX2Prompt", "Text Concatenate", "Text Find and Replace",
  "Text Random Line", "Text Load Line From File", "Load Text File", "Join Strings", "StringFunction|pysssss",
  "ImpactWildcardProcessor", "ImpactWildcardEncode", "DPRandomGenerator", "DPCombinatorialGenerator",
  "Florence2Run", "WD14Tagger|pysssss", "OllamaGenerate", "OllamaGenerateAdvance",
]);
/** Nodes that read their words from a file the graph does not carry. */
const TEXT_FROM_OUTSIDE = /TextSetFromFolder|TextDataSetFromPath|LoadText|TextFile|ReadText|PromptFromFile|FromFile/i;

/** A picture or sound carried inline is not words: a data: URI of an image,
 *  audio or video type, or a long base64 run whose first bytes are a media
 *  file's signature. Anything else of that shape is DECODED and read, and
 *  text padded with newlines to look like base64 is not base64 at all. */
const MEDIA_MAGIC = [
  [0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46],
  [0x66, 0x4c, 0x61, 0x43], [0x4f, 0x67, 0x67, 0x53], [0x49, 0x44, 0x33], [0x1a, 0x45, 0xdf, 0xa3],
  [0x42, 0x4d], [0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a], [0x76, 0x2f, 0x31, 0x01], [0x93, 0x4e, 0x55, 0x4d],
];
function looksLikeMedia(bytes) {
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true; // ...ftyp: mp4/mov/heic/avif
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;                             // mp3 frame
  return MEDIA_MAGIC.some((m) => m.every((b, i) => bytes[i] === b));
}
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const isBlob = (s) => {
  if (typeof s !== "string") return false;
  if (/^data:(?:image|audio|video)\//i.test(s)) return true;
  if (s.length < 2048 || !B64.test(s)) return false;
  try { return looksLikeMedia(Buffer.from(s.slice(0, 64), "base64")); } catch { return false; }
};

/** Words hidden inside a string: a JSON object or array (decoded, escapes and
 *  all, keys and values), a data: URI that is not a picture, or base64 that is
 *  not a media file. Returned so they are read beside the string itself. */
function hiddenWords(s, depth = 0) {
  const out = [];
  if (depth > 3) return out;
  const t = s.trim();
  if (/^[[{]/.test(t)) {
    try {
      const walk = (v, d) => {
        if (d > 32) return;
        if (typeof v === "string") { out.push(v, ...hiddenWords(v, depth + 1)); return; }
        if (Array.isArray(v)) { for (const x of v) walk(x, d + 1); return; }
        if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); walk(x, d + 1); }
      };
      walk(JSON.parse(t), 0);
    } catch { /* not JSON: read as it is */ }
  }
  const dataUri = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(t);
  if (dataUri && !/^(?:image|audio|video)\//i.test(dataUri[1])) {
    try { out.push(dataUri[2] ? Buffer.from(dataUri[3], "base64").toString("utf8") : decodeURIComponent(dataUri[3])); } catch { /* unreadable */ }
  } else if (t.length >= 16 && B64.test(t) && !isBlob(t)) {
    try {
      const d = Buffer.from(t.slice(0, 1 << 20), "base64").toString("utf8");
      if (/^[\p{L}\p{N}\p{P}\p{Zs}\n\r\t]+$/u.test(d)) out.push(d);
    } catch { /* not base64 */ }
  }
  return out;
}

/** Every string under an input, with the key it hangs from. Top-level links
 *  are wires, not words, and are skipped. */
function eachString(value, key, visit, depth = 0) {
  if (depth > 32) return;
  if (typeof value === "string") { visit(key, value); return; }
  if (depth === 1 && isLink(value)) return;
  if (Array.isArray(value)) { for (const v of value) eachString(v, key, visit, depth + 1); return; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) eachString(v, k, visit, depth + 1);
  }
}

const topLinks = (node) => Object.entries(node?.inputs && typeof node.inputs === "object" ? node.inputs : {})
  .filter(([, v]) => isLink(v));

/** A sampler or guider that really uses its `negative` wire as a negative. */
function provesNegative(node) {
  const ins = node?.inputs;
  if (!ins || typeof ins !== "object") return false;
  const cfg = Object.entries(ins).filter(([k]) => CFG_KEY.test(k));
  return cfg.length > 0 && cfg.every(([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 1);
}

/** A node whose only input is one typed string: a text primitive. */
function isLiteralText(node) {
  const vals = Object.values(node?.inputs && typeof node.inputs === "object" ? node.inputs : {});
  return vals.length === 1 && typeof vals[0] === "string";
}

/**
 * The words a graph will render with, and whether it renders a picture at all.
 * @returns {{ positive: string[], visual: boolean, unverifiable: boolean }}
 */
export function graphTexts(graph) {
  const g = graph && typeof graph === "object" && !Array.isArray(graph) ? graph : {};
  const nodes = Object.entries(g).filter(([, n]) => n && typeof n === "object");
  const byId = new Map(nodes.map(([id, n]) => [String(id), n]));
  const cls = (n) => String(n?.class_type || "");

  /* ── is anything here a picture? ── */
  const visual = !(nodes.length > 0 && nodes.every(([, n]) => NON_VISUAL_CLASSES.has(cls(n))));

  /* ── the walk back from the outputs, as ComfyUI executes it ── */
  const consumed = new Set();
  for (const [, n] of nodes) for (const [, l] of topLinks(n)) consumed.add(String(l[0]));
  const starts = nodes.filter(([id, n]) => !consumed.has(String(id)) || /^(Save|Preview)|VideoCombine|Output/i.test(cls(n)))
    .map(([id]) => String(id));
  const reached = new Map();        // id -> { pos: bool, neg: bool, posSlots: Set }
  const seen = new Set();
  const stack = starts.map((id) => [id, "pos", null]);
  while (stack.length) {
    const [id, mode, slot] = stack.pop();
    const key = `${id}|${mode}|${slot}`;
    if (seen.has(key) || !byId.has(id)) continue;
    seen.add(key);
    const r = reached.get(id) || { pos: false, neg: false, posSlots: new Set() };
    r[mode] = true;
    if (mode === "pos") r.posSlots.add(slot);
    reached.set(id, r);
    const n = byId.get(id);
    const proving = provesNegative(n);
    const pass = PASS_THROUGH.has(cls(n)) && slot !== null;
    for (const [k, l] of topLinks(n)) {
      if (pass) {
        if (slot === 0 && NEGATIVE_WIRE.test(k)) continue;
        if (slot === 1 && POSITIVE_WIRE.test(k)) continue;
        if (slot >= 2 && (POSITIVE_WIRE.test(k) || NEGATIVE_WIRE.test(k))) continue;
      }
      stack.push([String(l[0]), proving && NEGATIVE_WIRE.test(k) ? "neg" : mode, l[1]]);
    }
  }
  /* The negative a sampler blends in below cfg 1 is a positive: when any
   * sampler's cfg is under 1 or wired, no negative is trusted anywhere. */
  const cfgNodes = nodes.filter(([, n]) => Object.keys(n?.inputs || {}).some((k) => CFG_KEY.test(k)));
  const cfgTrusted = cfgNodes.length > 0 && cfgNodes.every(([, n]) => provesNegative(n));
  const negativeOnly = (id) => cfgTrusted && reached.get(id)?.neg === true && reached.get(id)?.pos !== true;
  /* A node's own negative-named string (Qwen's negative_prompt) feeds its
   * output 1. It is negative unless that output is wired somewhere positive. */
  const ownNegativeTrusted = (id) => cfgTrusted && !(reached.get(id)?.posSlots.has(1));

  /* ── words written while the graph runs ── */
  let unverifiable = false;
  if (visual) {
    for (const [id, n] of nodes) {
      if (negativeOnly(String(id))) continue;
      if (TEXT_FROM_OUTSIDE.test(cls(n))) { unverifiable = true; break; }
      if (STRING_MAKERS.has(cls(n)) && consumed.has(String(id))) { unverifiable = true; break; }
      for (const [k, l] of topLinks(n)) {
        if (!TEXT_LINK_KEY.test(k)) continue;
        const src = byId.get(String(l[0]));
        if (!src || !isLiteralText(src)) { unverifiable = true; break; }
      }
      if (unverifiable) break;
    }
  }

  /* ── the words ── */
  const positive = [];
  for (const [id, n] of nodes) {
    if (negativeOnly(String(id))) continue;
    eachString(n.inputs, "", (k, s) => {
      if (!s.trim() || isBlob(s)) return;
      if (NEGATIVE_KEY.test(k) && OWN_NEGATIVE.has(cls(n)) && ownNegativeTrusted(String(id))) return;
      positive.push(s, ...hiddenWords(s));
    });
  }
  return { positive, visual, unverifiable };
}

/**
 * THE GRAPH CHECK. Same answer shape as checkPrompt, plus the one refusal of
 * its own (UNVERIFIABLE, code "unverifiable-text").
 * @param {object} graph  API-format ComfyUI graph
 * @param {{context?: string|string[], flags?: object|object[]}} [opts]  words
 *   that reach the model as a picture rather than as text (a referenced cast
 *   member's description, the stored prompt of a reference image), and the
 *   wordless flags such pictures carry. They count on both sides.
 */
export function checkGraph(graph, { context = [], flags = [] } = {}) {
  const { positive, visual, unverifiable } = graphTexts(graph);
  if (!visual) return { ok: true };
  const verdict = checkPrompt(positive, { context, flags });
  if (!verdict.ok) return verdict;
  if (unverifiable) return { ok: false, reason: UNVERIFIABLE, code: UNVERIFIABLE_CODE };
  return verdict;
}
