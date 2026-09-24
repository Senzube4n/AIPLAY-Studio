/**
 * WHICH CONFIGURATION REACHES THE SONG YOU ASKED FOR, and what it costs.
 *
 * YuE2 has no duration argument — length is emergent — so "I want four minutes"
 * is an intention, not an input. But an intention is still actionable, because
 * the things that STOP a song getting longer are knowable in advance, and they
 * are not all the same kind of thing. This module sorts them into the three
 * that matter and, for a wanted duration, says which one you are about to meet.
 *
 * THE THREE CEILINGS, in the order they bind.
 *
 * 1. MEMORY — the only one hardware changes, and the only one that is not a
 *    published number. It is where a 16 GiB card actually stops.
 *
 *    ⚠ ONE SETTING IN THIS APP MOVES IT, and it is not the one this module
 *    first reached for. The stage that limits duration is the synthesis
 *    prefill, and it holds the entire model every time: nar.py:249 constructs
 *    CachedNAR — whose __init__ ends in `self._prefill()` at nar.py:127 —
 *    BEFORE nar.py:251 enters the offload context, so the offload lever is not
 *    in scope when the peak happens, and cannot be (the prefill IS the AR
 *    backbone). What the peak is made of, though, was measured on 2026-09-11
 *    and it was not the K/V cache: it was nar.py:70's whole-sequence attention
 *    block, tokens², and `queryChunk` bounds it. See the Long rung and
 *    `PREFILL_ATTENTION_MIB`. Six songs to 264.6 s rendered where 194 died.
 *
 * 2. THE GENERATION CAP — `semantic.max_tokens` 9000, which at the MEASURED
 *    25.0 tokens per second of audio is exactly 360.0 s. A stop in the
 *    sampler: the model stops emitting. MEASURED from two independently
 *    published files that agree:
 *      · YuE2-3B/yue2_generation_config.json                 (BF16 checkpoint)
 *      · Yue2-3B-GGUF/sidecars/yue2-generation-config.json   (GGUF release)
 *    protocol.py:29 is the same 9000, and its validator sets no upper bound —
 *    and since 2026-09-11 this app DOES raise it: `maxTokensFor()` below is
 *    what /api/generate sends for a wanted length past 360 s, and the driver
 *    clamps it to the room the plan's prefix leaves under ceiling 3. A raised
 *    stop is an attempt past what the vendor validated, and the box says so.
 *
 * 3. THE CONTEXT WINDOW — `max_position_embeddings` / `max_latent_frames`
 *    24576 = 983.04 s = 16.38 min. Architectural, and refused rather than
 *    merely enforced: protocol.py:54-55 raises
 *    "Require context=24576 and midpoint with positive integer steps" for any
 *    other value, so the pipeline will not even accept a different window.
 *
 *    ⚠ ASKING FOR A LONGER SONG STILL DOES NOT RAISE AN ERROR, because the
 *    refusal above guards the CONFIG, not the request. Positions past the
 *    window are clamped (nar.py:124, modeling_yue2.py:661), so a 20-minute
 *    request produces a finished file in which everything past 983 s is built
 *    on a position the model already used. That is the one ceiling a user must
 *    be told about rather than discover, because the failure sounds like a song.
 *
 * ⚠ WHY QUANTIZATION MOVES ONLY THE FIRST OF THE THREE — the question this
 * module was written to answer. The hope is that a quantized model, being
 * smaller, also gets longer. It does not, and the evidence is direct: the GGUF
 * release's own sidecar config was diffed field by field against the BF16
 * checkpoint's config.json and every architecture field is identical —
 * `max_position_embeddings` 24576, `max_latent_frames` 24576, hidden_size,
 * layers, heads, head_dim, latent_dim, vocab, rope_theta — with ZERO shared
 * keys differing (MEASURED, scratchpad/gguf_meta.py, 2026-09-11). Quantization
 * compresses weights; ceilings 2 and 3 are counted in positions, and a position
 * does not get smaller when the weight that reads it does.
 *
 * So: quantization buys memory, memory does not buy duration at the stage that
 * limits it, the model stops itself at 360 s, and nothing reaches past 983 s.
 * Four different sentences, and the info box says whichever one applies.
 */
import { TOKEN_CAPS, TOKENS_PER_AUDIO_SECOND } from "./yue.js";

/**
 * The architectural context window, in latent frames.
 *
 * MEASURED from two files that agree: YuE2-3B/config.json and the GGUF
 * release's sidecars/yue2-model-config.json both carry
 * `max_position_embeddings: 24576` and `max_latent_frames: 24576`, and the
 * generation config restates it as `"context": 24576`.
 */
export const CONTEXT_FRAMES = 24576;

/** 24576 / 25.0 = 983.04 s. The wall that clamps instead of failing. */
export const CONTEXT_SECONDS = Number((CONTEXT_FRAMES / TOKENS_PER_AUDIO_SECOND).toFixed(2));

/** 9000 / 25.0 = 360.0 s. The wall the sampler simply stops at. */
export const GENERATION_CAP_SECONDS =
  Number((TOKEN_CAPS.semantic / TOKENS_PER_AUDIO_SECOND).toFixed(2));

/**
 * THE RUNGS — the configuration ladder, cheapest first.
 *
 * Each rung is a combination of levers the vendor's own pipeline already takes
 * (pipeline.py:122-124 `quantization="none", offload_ar=False`), so none of
 * this is a fork of the model; it is a constructor argument we were not passing.
 *
 * `savesGib` is MEASURED, not estimated: both figures come from summing the
 * safetensors header of the 628-tensor checkpoint over exactly the tensor names
 * the code names, which is arithmetic on published bytes rather than a guess.
 *
 * ⚠ `reachSeconds` IS NULL ON EVERY RUNG THAT HAS NOT BEEN MEASURED, AND NULL
 * IS THE POINT. The temptation is to divide the freed bytes by the K/V cache's
 * 114,688 bytes per token (nar.py:143,146) and print a duration. Doing that on
 * the baseline rung yields 1438 s — past the architectural window and plainly
 * false, because the accounted terms miss 3.3-4.6 GiB of real peak that is not
 * constant with length. A null that says "not measured" is worth more than a
 * number that says 1438. `fit()` therefore never promotes a rung on the
 * strength of an estimate; it promotes on a measured reach or not at all.
 *
 * ⚠ AND THE MISSING TERM WAS FOUND, 2026-09-11. The "3.3-4.6 GiB of real peak
 * that is not constant with length" is the prefill's attention temp — one
 * whole-sequence scaled_dot_product_attention, tokens² — and it IS movable:
 * see the Long rung and `projectedPrefillGib()`. The rule above survives
 * unchanged; what changed is that a measured lever now exists.
 */
export const RUNGS = [
  {
    id: "standard",
    label: "Standard",
    quantization: "none",
    offloadAr: false,
    /* 512 on EVERY rung since 2026-09-11, this one included: length is an
     * outcome, so a 150 s wish with three verses of lyrics can plan a 194 s
     * song, and the vendor's whole-sequence block is the configuration that
     * died at exactly that length. The block costs nothing (less memory,
     * faster) and changes no arithmetic; `config.yue.queryChunk: 0` restores
     * the vendor's default for anyone who wants to measure it. */
    queryChunk: 512,
    savesGib: 0,
    /* MEASURED BOTH WAYS. 168.0 s of audio at this configuration on a 16 GiB
     * RTX 4070 Ti SUPER, peak 10.6 GiB of the 13.99 GiB the runtime allows —
     * seven times, at exactly 167.9987 s, because that is where the score
     * budget stops it rather than where the card does. And on 2026-09-11 a
     * 194.2 s plan at this configuration died in the synthesis prefill,
     * 764 MiB short of the cap (nar.py:95, 7,068 tokens). So this rung's
     * ceiling lies between the two, and the term that sets it is the one
     * `queryChunk` on the next rung removes. */
    reachSeconds: 168.0,
    reachFrom: "MEASURED — 7 renders at 167.9987 s, peak 10.6 GiB of 13.99 allowed; a 194.2 s plan OOMs in the prefill at this setting",
    lowers: ["nothing — this is the vendor's own default configuration"],
    speed: 1.0,
    costs: [],
  },
  {
    id: "long",
    label: "Long",
    quantization: "none",
    offloadAr: true,
    queryChunk: 512,
    /* TWO LEVERS, AND ONLY ONE OF THEM MOVES THE CEILING.
     *
     * `queryChunk` does. nar.py:70 sizes the attention block as THE WHOLE
     * SEQUENCE on CUDA (`block = query_chunk_size or len(q)`), so the temp
     * one prefill layer allocates grows as tokens², and that — not the K/V
     * cache — is what reached 13.99 GiB. MEASURED through nar.attention()
     * itself on this card (scratchpad/sdpa_probe.py, 2026-09-11):
     *
     *   tokens  seconds   whole sequence   512-token block
     *    4200     168        2.66 GiB         0.41 GiB     the renders that fit
     *    4900     194        3.58 GiB         0.46 GiB     the OOM
     *    6700     267        6.60 GiB         0.67 GiB
     *    9000     360       11.79 GiB         0.87 GiB     the sampler's own cap
     *
     * and the blocked call is FASTER (30 ms against 370 at 4200 tokens),
     * because it is the same arithmetic with less to spill. synthesize()
     * takes the option (nar.py:229); pipeline.py:300 never passes it; the
     * driver injects it (yue_driver.py, --query-chunk). The audio is
     * unchanged: bf16 rounding between one block and many, nothing else.
     *
     * `offloadAr` does NOT move the ceiling, and this paragraph exists so the
     * claim is not quietly reintroduced. MEASURED 4.0344 GiB: the 310 tensors
     * nar.py:208-210 names — embed_tokens, lm_head, and every layer's
     * input_layernorm / self_attn / post_attention_layernorm / mlp. But
     * `_prefill` (nar.py:133-149) IS the AR backbone run over the prefix —
     * `backbone.embed_tokens`, `layer.self_attn.project_qkv`, `layer.mlp`,
     * the very modules the flag moves — so they must be resident for it, and
     * nar.py:249 constructs the engine BEFORE the `with` at nar.py:251
     * offloads anything. That ordering is not an accident and cannot be
     * swapped: the reorder was worked through tonight and the prefill needs
     * the weights it would have moved. What the flag buys is headroom during
     * the solve, which is most of the wall clock, at the price of a PCIe
     * crossing per chunk: MEASURED 2.65x realtime with it against 2.39x
     * without. */
    savesGib: 4.0344,
    /* The longest of six full-length renders on the night the lever landed;
     * never past what rendered. All six: 194.2 / 226.4 / 253.9 / 264.6 /
     * 224.1 / 234.7 s, exit 0, prefill peaks 8.29–8.71 GiB at 7,068–8,823
     * tokens, 2.62–2.83x realtime. */
    reachSeconds: 264.6,
    reachFrom: "MEASURED 2026-09-11 — six songs of 194.2 to 264.6 s rendered at query_chunk 512 + offload, prefill peaks 8.29–8.71 GiB of 13.99 (7,068–8,823 tokens), where the 194 s plan OOM'd at the package default",
    lowers: ["the synthesis prefill (queryChunk) — the stage that sets the ceiling",
             "the synthesis solve (offloadAr)"],
    speed: null,
    costs: ["Slower: the model's first half moves to system memory during synthesis and "
      + "back again, once per chunk — measured at 2.65× the song's length against 2.39× "
      + "without. The audio is unchanged: the same weights, moved, and the same "
      + "arithmetic in smaller blocks."],
  },
  {
    id: "compact",
    label: "Small card",
    quantization: "fp8",
    offloadAr: true,
    queryChunk: 512,
    /* 4.0344 + 1.3125. The FP8 figure is MEASURED the same way: the 196 tensors
     * matching quantization.py's own AR_LINEAR regex weigh 2.6250 GiB at BF16,
     * and E4M3 is one byte where BF16 is two.
     *
     * ⚠ NOT A LENGTH RUNG, and `fit()` never selects it for one. FP8 lowers
     * the PLANNING and SEMANTIC stages: quantization.py's restore_ar puts
     * exact BF16 back before the NAR prefill, so it is not resident where the
     * length ceiling is set, and paying an unvalidated precision for a stage
     * it does not touch would be paying for nothing. This rung is for a card
     * that cannot hold the semantic stage at all — a real and common case,
     * since that stage allocates 114,688 x (prefix + max_tokens) bytes of K/V
     * cache and DOUBLES it when cot is "off" (sampling.py:97-100,
     * cuda_graph.py:92). It carries the chunk too, because a card that small
     * needs it more. */
    savesGib: 5.3469,
    reachSeconds: null,
    reachFrom: "NOT MEASURED — 1.3125 GiB off the semantic stage (fp8, measured) on top of Long; nothing here changes the length ceiling Long already moves",
    lowers: ["the planning and semantic stages (fp8)",
             "the synthesis prefill (queryChunk)",
             "the synthesis solve (offloadAr)"],
    speed: null,
    /* The vendor's own words, and not decoration: quantization.py's docstring
     * opens "Opt-in experimental FP8 AR linear layers" and says "No quantized
     * quality or speed claim is implied by enabling this module", and
     * quantization_status() reports both "quality_validation": "unvalidated"
     * and "performance_validation": "unvalidated". Repeating that is the honest
     * thing; softening it would invent a claim the people who wrote the kernel
     * declined to make. */
    /* ⚠ SLOWER, NOT FASTER, and MEASURED: the one A/B this project has, the
     * same song, seed and lyrics on a 16 GiB RTX 4070 Ti SUPER, 2026-09-11 —
     * bf16: plan 129.8 s, semantic 5,620 tokens at 14.8 tok/s, 224.8 s of
     * audio in 745 s; fp8: plan 236.9 s, semantic 5,111 tokens at 7.4 tok/s,
     * 204.4 s in 1,131 s. Half the AR throughput. The vendor's "no speed claim"
     * was the honest sentence. And the audio DIFFERS: different length, a
     * different plan — 8-bit is different arithmetic, not a compression of
     * the same one. This rung exists for a card that cannot hold the semantic
     * stage in bf16 at all, and for nothing else. */
    costs: ["Slower — measured at HALF the composing speed of bf16 on an RTX 4070 Ti SUPER "
      + "(7.4 against 14.8 tokens a second, the same song and seed), plus the Long rung's "
      + "own cost. 8-bit does not make this model faster on this hardware.",
      "The first half of the model runs at 8-bit precision. The model's authors "
      + "publish this as experimental and explicitly make no quality claim about "
      + "it, so neither do we — and the one A/B here made a different song "
      + "(204 s against 225 s from the same seed), so it is not the same render.",
      "Needs an NVIDIA card of compute capability 8.9 or newer — RTX 40-series or "
      + "later. On anything older the 8-bit kernels do not exist and this rung "
      + "cannot be selected."],
  },
];

/**
 * WHERE THE DURATION WALL ACTUALLY IS — and it was not where this file said.
 *
 * The first version of this comment named the K/V cache: 114,688 bytes per
 * token of AR context (nar.py:143,146 — 2 x 28 layers x 8 kv_heads x 128
 * head_dim x 2 bytes), 2.734 MiB per second of audio, "with no lever able to
 * move it". The number is right and the conclusion was wrong. At 194 s that
 * cache is 0.53 GiB; the render died 764 MiB short with 13.29 GiB allocated,
 * of which the weights are 6.76. The unaccounted 5-6 GiB — the "3.3-4.6 GiB
 * of real peak that is not constant with length" the header admits to — was
 * the prefill's attention temp: one scaled_dot_product_attention over the
 * whole causal sequence, growing as tokens², 3.58 GiB at 194 s and 11.79 at
 * 360 s (MEASURED, table on the Long rung). A 512-token query block bounds it
 * at 0.87 GiB across the whole reachable range, and the model's own ceilings
 * are what remain:
 *
 *   ceiling 2   360 s    the sampler's 9000-token stop (this app does not raise it)
 *   ceiling 3   983 s    the context window; positions past it clamp
 *
 * ⚠ THE PLATEAU IS STILL UNREACHABLE. protocol.py:141-145 splits the codec
 * into chunks of `(24576 - prefix - 3) // 2` frames and nar.py:245-260 solves
 * them serially, releasing each chunk's cache before the next — so past one
 * chunk the peak stops growing. At a ~1000-token prefix that is 11,786 frames
 * = 471.4 s, and the sampler stops at 360 s, which is SHORTER. Across the span
 * a user can ask for, synthesis memory still rises monotonically with length;
 * it just rises from a floor a 16 GiB card can hold.
 *
 * What is projected rather than measured is said so: `projectedPrefillGib()`
 * extrapolates from the measured 194 s point at the two measured slopes, and
 * `fit()` quotes it as an estimate until a longer render replaces it.
 */
export const PREFILL_MIB_PER_SECOND = Number((114688 * 25 / 2 ** 20).toFixed(3));

/** `(24576 - prefix - 3) // 2` frames, at the ~1000-token prefix we measure. */
export const CHUNK_PLATEAU_SECONDS =
  Number((Math.floor((CONTEXT_FRAMES - 1000 - 3) / 2) / TOKENS_PER_AUDIO_SECOND).toFixed(1));

/**
 * The runtime's own cap on this card: pipeline.py:162 takes
 * `min((budget - 2) GiB, total - 2 GiB)` = 13.99 of 15.99. MEASURED — it is
 * the "13.99 GiB allowed" in every OOM this project has recorded.
 */
export const RUNTIME_CAP_GIB = 13.99;

/**
 * The prefill's attention temp, MEASURED through nar.attention() on this card
 * (scratchpad/sdpa_probe.py, 2026-09-11), in MiB. `whole` is the package
 * default on CUDA — one block, the whole sequence; `block512` is the Long
 * rung. Kept as the table rather than a fitted curve: the whole-sequence
 * column is not quite quadratic (158 -> 142 bytes per token² across the
 * range) and a formula would claim more than four points know.
 */
export const PREFILL_ATTENTION_MIB = Object.freeze([
  Object.freeze({ tokens: 4200, seconds: 168, whole: 2663.6, block512: 412.0 }),
  Object.freeze({ tokens: 4900, seconds: 194, whole: 3583.6, block512: 463.2 }),
  Object.freeze({ tokens: 6700, seconds: 267, whole: 6598.8, block512: 668.2 }),
  Object.freeze({ tokens: 9000, seconds: 360, whole: 11786.4, block512: 872.1 }),
]);

/** The blocked temp's slope: (872.1 - 412.0) MiB over 4800 tokens, at 25 a second. */
export const CHUNK_ATTENTION_MIB_PER_SECOND =
  Number(((872.1 - 412.0) / (9000 - 4200) * TOKENS_PER_AUDIO_SECOND).toFixed(3));

/**
 * The one measured whole-stage point on the Long rung: 194.2 s of audio,
 * 7,068 tokens of prefill (2,212 prefix + 4,856 semantic), 8.286 GiB
 * allocated at the end of the prefill, read by the driver where it happens.
 */
export const MEASURED_PREFILL = Object.freeze({ seconds: 194.2, tokens: 7068, peakGib: 8.286, queryChunk: 512 });

/**
 * ESTIMATED peak of the synthesis prefill at `seconds` on the Long rung: the
 * measured 194.2 s point plus the two measured per-second slopes (K/V cache
 * and the blocked attention temp). An extrapolation, labelled as one wherever
 * it is shown; a longer measured render should replace MEASURED_PREFILL, not
 * this function.
 */
export function projectedPrefillGib(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return null;
  const perSecond = (PREFILL_MIB_PER_SECOND + CHUNK_ATTENTION_MIB_PER_SECOND) / 1024;
  return Number((MEASURED_PREFILL.peakGib + (s - MEASURED_PREFILL.seconds) * perSecond).toFixed(2));
}

/** Compute capability FP8 needs. quantization.py:74 `< (8, 9)` raises. */
export const FP8_MIN_CAPABILITY = [8, 9];

const rung = (id) => RUNGS.find((r) => r.id === id) || null;

/** The fp8 gate on its own: quantization.py:74 raises below (8, 9). An unknown
 *  capability does not exclude — the driver refuses at load if it must. */
export function fp8Allowed(capability) {
  const cap = capability || null;
  return !cap || cap[0] > FP8_MIN_CAPABILITY[0]
    || (cap[0] === FP8_MIN_CAPABILITY[0] && cap[1] >= FP8_MIN_CAPABILITY[1]);
}

/** The rungs this card can be offered. Only fp8 is gated; nothing else has a
 *  hardware requirement beyond memory, which the reach figures carry. */
export function usableRungs(capability, ladder = RUNGS) {
  const okFp8 = fp8Allowed(capability);
  return ladder.filter((r) => r.quantization !== "fp8" || okFp8);
}

/**
 * Which rung, and what to say about it.
 *
 * @param {number|null} wantSeconds  the duration the user is hoping for. An
 *   intention: YuE2 takes no duration argument, so this steers configuration
 *   and warnings, never the model.
 * @param {object} opts
 *   `capability` — [major, minor] from torch, when known. Gates the FP8 rung.
 *   `rungs` — override for tests.
 * @returns {{rung, wantSeconds, ceiling, promoted, notes, info}}
 *   `ceiling` names which of the three walls binds, or null if none do.
 *   `info` is the info box: {level, title, lines[]} or null when there is
 *   genuinely nothing to say, because a box that always appears is furniture.
 */
export function fit(wantSeconds, opts = {}) {
  const ladder = opts.rungs || RUNGS;
  const want = Number.isFinite(Number(wantSeconds)) && Number(wantSeconds) > 0
    ? Number(wantSeconds) : null;
  const usable = usableRungs(opts.capability || null, ladder);
  /* A ladder whose every rung is gated off still answers with its first rung
   * rather than with undefined — the driver's own refusal is the next line. */
  const base = usable[0] ?? ladder[0];

  /* No stated intention: nothing to choose and nothing to warn about. The
   * engine's own behaviour — length emerges — is documented elsewhere and does
   * not need a box on every visit. */
  if (want === null) {
    return { rung: base, wantSeconds: null, ceiling: null, promoted: false,
             notes: [], info: null };
  }

  /* Ceiling 3 first, because it is the one that lies. Past the context window
   * the run neither fails nor gets longer; it clamps. Say so before anything
   * about configuration, which cannot help here. */
  if (want > CONTEXT_SECONDS) {
    return {
      rung: base, wantSeconds: want, ceiling: "context", promoted: false,
      notes: [],
      info: {
        level: "stop",
        title: `${fmt(want)} is past what this model can address at all`,
        lines: [
          `The song you asked for is longer than YuE2's context window, which is `
          + `${CONTEXT_FRAMES} frames — ${fmt(CONTEXT_SECONDS)} at the measured `
          + `${TOKENS_PER_AUDIO_SECOND} frames per second of audio.`,
          `⚠ Asking anyway does not produce an error. Positions past the window are `
          + `clamped rather than rejected, so the render finishes and the material `
          + `past ${fmt(CONTEXT_SECONDS)} is built on a position the model has `
          + `already used. It will sound like a song that loses its place.`,
          `No card and no configuration changes this — it is the shape of the model, `
          + `and the quantized release carries the identical number. Render in `
          + `sections and join them.`,
        ],
      },
    };
  }

  /* Ceiling 2. A generation default, so raisable in principle — protocol.py's
   * validator sets no upper bound on max_tokens — but not by this app, and not
   * silently, so it is stated as the wall it is in practice.
   *
   * ⚠ THE RUNG IS CHOSEN FOR THE DURATION THAT WILL ACTUALLY RENDER, not for
   * the one that was asked for. The first version of this branch promoted to
   * the top rung with the reasoning "there is no reason to leave it on the
   * table". There is: the top rung runs the AR half at 8-bit precision that
   * nobody has validated, and it would be accepted here in exchange for
   * reaching a length the sampler is going to stop short of anyway. Paying an
   * unmeasured quality risk for a duration that cannot happen is not a
   * trade — so this asks the memory rule about 360 s, which is what the user
   * is really about to get, and then adds the warning.
   */
  if (want > GENERATION_CAP_SECONDS) {
    /* The memory rule is asked about the length that is actually about to be
     * attempted — the raised stop — so the rung and the projection describe
     * the render, not a 360 s song that will not happen. */
    const tokens = maxTokensFor(want);
    const attempt = Number((tokens / TOKENS_PER_AUDIO_SECOND).toFixed(1));
    const asRendered = fitMemory(attempt, usable, base);
    return {
      rung: asRendered.rung, wantSeconds: want, ceiling: "generation",
      promoted: asRendered.rung.id !== base.id,
      notes: asRendered.notes,
      maxTokens: tokens,
      info: {
        level: "warn",
        title: `${fmt(want)} is past the model's own stopping point — this render raises it`,
        lines: [
          `YuE2's published stop is ${TOKEN_CAPS.semantic} semantic tokens, `
          + `${fmt(GENERATION_CAP_SECONDS)} of audio — a default, not a limit of your card: the `
          + `quantized release carries the same number. This render asks the sampler for `
          + `${tokens} tokens instead (${fmt(attempt)}), which the driver trims to whatever the `
          + `plan's prefix leaves under the ${fmt(CONTEXT_SECONDS)} context window. The vendor `
          + `validated nothing past ${fmt(GENERATION_CAP_SECONDS)}; the model may still end the `
          + `song on its own earlier.`,
          ...(asRendered.info ? asRendered.info.lines : []),
        ],
      },
    };
  }

  return fitMemory(want, usable, base);
}

/**
 * The sampler stop /api/generate asks for at a wanted length: the vendor's
 * default up to 360 s, and past it 25 tokens a second plus 8 % for the model's
 * own endings, capped below the context window so the driver's exact clamp
 * (which knows the plan's prefix) has room to work. One function, so the box
 * on the form and the job that follows it describe the same request.
 */
export function maxTokensFor(wantSeconds) {
  const want = Number(wantSeconds);
  if (!Number.isFinite(want) || want <= GENERATION_CAP_SECONDS) return 0;
  return Math.min(Math.ceil(want * TOKENS_PER_AUDIO_SECOND * 1.08), CONTEXT_FRAMES - 2600);
}

/** Ceiling 1 on its own, so the generation branch can ask it about the
 *  length that will actually be attempted. */
function fitMemory(want, usable, base) {

  /* Ceiling 1 — memory, the one the ladder is for.
   *
   * Promote to the cheapest rung whose reach has been MEASURED to cover the
   * request. If none has, promote to the cheapest rung that lowers the stage
   * that sets the ceiling — the synthesis prefill, which only `queryChunk`
   * touches — and say plainly that its reach past the measured point is a
   * projection. A rung is never promoted to on the strength of an estimate
   * ALONE, which is why `reachSeconds` is allowed to be null; and the fp8 rung
   * is never promoted to for length at all, because fp8 is restored to BF16
   * before the stage that binds and would be paid for nothing. */
  const covered = usable.find((r) => r.reachSeconds !== null && want <= r.reachSeconds);
  if (covered) {
    const promoted = covered.id !== base.id;
    return {
      rung: covered, wantSeconds: want, ceiling: null, promoted, notes: [],
      /* A promotion is a change the user did not ask for, so it gets a box —
       * a note, not a warning: the song will render, and this says what will
       * be different about how. Staying on the base rung says nothing. */
      info: !promoted ? null : {
        level: "note",
        title: `${fmt(want)} uses the ${covered.label} configuration`,
        /* Two short lines. A song inside the measured reach is the normal case
         * now — six of them rendered tonight — and a paragraph about the
         * mechanism belongs in the code, not under the slider. */
        /* The mechanism and its ratios are in the Music ⓘ panel now
         * (server/welcome/catalogue.js howItRuns, UI_PLAN C2). */
        lines: [
          `Measured to ${fmt(covered.reachSeconds)} on this card in this configuration.`,
          "Slightly slower, and the same audio. The ⓘ panel says how it runs.",
        ],
      },
    };
  }

  /* Past every measured reach, the rung with the FARTHEST measured reach among
   * the ones that keep the vendor's arithmetic (no fp8) — the block is on
   * every rung now, so "the one with the block" would be Standard, whose reach
   * was measured before the block existed. */
  const chosen = usable
    .filter((r) => r.quantization === "none" && r.queryChunk > 0)
    .reduce((a, b) => ((b.reachSeconds ?? -1) > (a.reachSeconds ?? -1) ? b : a), base);
  const proven = chosen.reachSeconds ?? base.reachSeconds;
  const projected = chosen.queryChunk > 0 ? projectedPrefillGib(want) : null;
  return {
    rung: chosen, wantSeconds: want, ceiling: "memory",
    promoted: chosen.id !== base.id,
    notes: [chosen.reachFrom],
    info: {
      level: "note",
      title: `${fmt(want)} is past what this card has been measured to render`,
      lines: [
        proven === null ? null
          : `The longest song rendered here is ${fmt(proven)}. Past that nobody has `
            + `tried one, so treat ${fmt(want)} as an attempt rather than a promise.`,
        /* What sets the ceiling, and what is done about it — both measured. The
         * first version of this box said "it is not a setting" and sent people
         * to render in sections; that was true of the levers it knew about and
         * false of the one it did not. */
        `What limits length is the synthesis prefill. Its attention runs in `
        + `${chosen.queryChunk}-token blocks on every configuration here — the vendor's `
        + `whole-sequence default grows with the square of the song and died at `
        + `${fmt(MEASURED_PREFILL.seconds)} — and ${chosen.label} also moves the model's first `
        + `half off the card during the solve: the configuration measured to `
        + `${fmt(chosen.reachSeconds ?? base.reachSeconds)}.`,
        projected === null ? null
          : `Projected peak at ${fmt(want)}: about ${projected} GiB of the ${RUNTIME_CAP_GIB} GiB `
            + `the runtime allows — an estimate from the measured ${fmt(MEASURED_PREFILL.seconds)} `
            + `point and the two measured per-second costs (${PREFILL_MIB_PER_SECOND} MiB of `
            + `cache, ${CHUNK_ATTENTION_MIB_PER_SECOND} MiB of attention), not a measurement. `
            + (projected < RUNTIME_CAP_GIB
              ? `The render should fit; the receipt will say what it actually cost.`
              : `That is over the cap: render the song in sections and join them.`),
        ...chosen.costs,
      ].filter(Boolean),
    },
  };
}

/** Seconds as people say them: "168 s" under two minutes, "4:12" above. */
export function fmt(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return "?";
  if (s < 120) return `${s % 1 ? s.toFixed(1) : s} s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s - m * 60)).padStart(2, "0")}`;
}

/**
 * The rung as driver arguments. Named for what the driver takes, so a caller
 * cannot accidentally pass `offloadAr` to a python flag called `--offload-ar`.
 */
export function rungArgs(id) {
  const r = rung(id);
  if (!r) return null;
  return { quantization: r.quantization, offloadAr: r.offloadAr, queryChunk: r.queryChunk };
}
