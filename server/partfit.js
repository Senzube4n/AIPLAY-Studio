/**
 * DOES THIS TEXT ENCODER OR VAE FIT WHERE THE ENGINE'S OWN ONE GOES?
 *
 * The Video screen lets you point an engine at your own files: a transformer, a
 * text encoder, a video VAE and an audio VAE. `modelpick.js` answers the first —
 * a DiT says which architecture it is, and `VIDEO_DIT_ENGINE` maps that to the
 * engine that can drive it. The other three had no answer at all: `listParts`
 * returns every file in `models/vae` and `models/text_encoders` by name and
 * size, so the video-VAE dropdown offered a FLUX autoencoder, a music codec and
 * an audio vocoder with equal confidence, and picking one produced a render that
 * failed deep inside ComfyUI.
 *
 * ⚠ THE ENGINE'S OWN FILE IS THE ANCHOR — THERE IS NO TABLE IN THIS FILE.
 * config.js already names the `textEncoder`, `videoVae` and `audioVae` each
 * engine came with. This reads THOSE and offers whatever is built the same way,
 * which is the same standard the DiT picker already applies: a community model
 * of a family is that family re-trained, and the graph drives it with a name
 * changed. Writing "h3 wants qwen3vl" here would be a second copy of an engine
 * fact, which is exactly how these screens go stale.
 *
 * ⚠ NEVER HIDE ON IGNORANCE. Anything this cannot read or cannot judge comes
 * back "unknown", and unknown is SHOWN. Hiding a file somebody deliberately put
 * in models/vae because we failed to parse its header is worse than listing it:
 * the point is to drop what we can positively say belongs to something else.
 *
 * ── WHY IT IS TWO SIGNALS AND NOT ONE ──────────────────────────────────────
 *
 * Both were measured against the 15 VAEs and 11 encoders on this rig, not
 * reasoned about, and the first single-signal draft was wrong twice.
 *
 * VAEs are decided by MODULE-TREE CONTAINMENT. Stripping the parameter leaf off
 * every tensor name (`.weight`, `.bias`, `.weight_scale`, …) leaves the module
 * tree, which survives quantisation: a quantised twin adds a `weight_scale`
 * beside each `weight` and lands on the same module. Containment against H3's
 * own video VAE:
 *
 *     1.000  minimax_h3_video_vae_fp16          (the anchor)
 *     1.000  minimax_h3_video_vae_int8_convrot   <- a rebuild, 355 -> 499 modules
 *     0.333  vae-ft-mse-840000-ema-pruned
 *     0.328  ae.safetensors
 *     0.000  everything else
 *
 * Note the second line, because it is why this is containment and not equality:
 * `convrot` inserts rotation layers, so the int8 rebuild has 499 modules where
 * the fp16 has 355. An exact fingerprint matched the two H3 AUDIO VAEs and would
 * have hidden H3's own int8 VIDEO VAE.
 *
 * ⚠ TEXT ENCODERS ARE NOT DECIDED THIS WAY, and containment alone is actively
 * wrong for them: a SMALL model of a family is a subset of a BIG one, so it
 * scores near 1. Against H3's own 32B encoder:
 *
 *     1.000  qwen3vl_32b_minimax_h3-int4_convrot  (the anchor)
 *     0.997  qwen_3_4b            <- a 4B LLM
 *     0.997  qwen_3_06b_base      <- a 0.6B LLM
 *
 * Both would have been offered as H3's text encoder. What actually has to match
 * is the width the DiT's cross-attention was built for, so the encoder slot is
 * judged on EMBEDDING WIDTH and LAYER COUNT, which separate cleanly:
 *
 *     h3    qwen3vl_32b_minimax_h3   emb 151936x5120   50 layers
 *     ltx   gemma4-12b-with-proj     emb 262144x3840   48 layers
 *     ...   qwen3vl_8b               emb 151936x4096   36 layers
 *     ...   qwen_3_4b                emb 151936x2560   36 layers
 *     ...   umt5_xxl                 emb 256384x4096   24 layers
 *
 * ⚠ AND THE NAME IS NEVER THE EVIDENCE. `wan_2.1_vae.safetensors` and
 * `qwen_image_vae.safetensors` are the same architecture — 194 tensors, the same
 * module tree, identical fingerprints — under names that share nothing. Matching
 * names would have called one a Wan VAE and the other a Qwen VAE, and both
 * answers would have been about the name rather than the file. In the other
 * direction, H3's own encoder is named `qwen3vl_…` but carries NO `model.visual`
 * tensors at all: the vision tower is pruned out, so it is structurally a plain
 * qwen3. A rule keyed on "qwen3vl" would have hidden the engine's own file and
 * offered three encoders that do not fit.
 */
import { readHeader } from "./detect.js";

/**
 * The leaves that hang off a module. Stripping them is what makes a quantised
 * rebuild compare equal to the original: `…down_proj.weight` and
 * `…down_proj.weight_scale` are one module, not two.
 */
const LEAF = /\.(weight|bias|weight_scale|bias_scale|scale|input_scale|weight_shape|running_mean|running_var|num_batches_tracked)$/;

/** How many transformer layers, by the two numbering schemes in use here. */
function layerCount(keys) {
  const seen = new Set();
  for (const k of keys) {
    const m = /^model\.layers\.(\d+)\./.exec(k) || /^encoder\.block\.(\d+)\./.exec(k);
    if (m) seen.add(m[1]);
  }
  return seen.size;
}

/**
 * What a part file IS, structurally. Reads the safetensors header only — no
 * weights — which costs single-digit milliseconds even on a 5 GB VAE.
 */
export async function readPart(file) {
  const { json } = await readHeader(file);
  const keys = [], modules = new Set();
  let emb = null;
  for (const [k, v] of Object.entries(json)) {
    if (k === "__metadata__") continue;
    keys.push(k);
    modules.add(k.replace(LEAF, ""));
    /* The width the next stage was built for. `shared.weight` is T5's spelling
     * of the same tensor. */
    if ((k === "model.embed_tokens.weight" || k === "shared.weight") && Array.isArray(v?.shape)) emb = v.shape;
  }
  return { modules, emb, layers: layerCount(keys), keys: keys.length };
}

/** Shared modules over the smaller of the two trees. */
export function containment(a, b) {
  if (!a?.modules?.size || !b?.modules?.size) return 0;
  const [small, big] = a.modules.size <= b.modules.size ? [a.modules, b.modules] : [b.modules, a.modules];
  let n = 0;
  for (const m of small) if (big.has(m)) n++;
  return n / small.size;
}

/**
 * The line between "the same thing rebuilt" and "a different thing". Measured
 * gap on this shelf is 1.000 against 0.333, so anywhere in between would do;
 * 0.9 leaves room for a rebuild that renames a module or two without letting a
 * merely similar autoencoder through.
 */
export const SAME_TREE = 0.9;

/**
 * Does `file` fit the slot `anchor` occupies? "yes" | "no" | "unknown", and
 * unknown is shown by every caller rather than hidden.
 *
 * `slot` is "textEncoder" for the encoder row and anything else for a VAE row;
 * it selects WHICH signal decides, because containment is wrong for encoders
 * (see the header) and width is unavailable for VAEs.
 */
export function partFits(file, anchor, slot) {
  if (!file || !anchor) return "unknown";
  if (slot === "textEncoder") {
    /* Width first: it is the thing that actually has to line up, and it is the
     * signal containment gets wrong. No embedding on either side means we
     * cannot say — which is "unknown", not "no". */
    if (!file.emb || !anchor.emb) return "unknown";
    const sameWidth = file.emb[1] === anchor.emb[1];
    const sameDepth = file.layers === anchor.layers;
    return sameWidth && sameDepth ? "yes" : "no";
  }
  return containment(file, anchor) >= SAME_TREE ? "yes" : "no";
}

export default { readPart, containment, partFits, SAME_TREE };
