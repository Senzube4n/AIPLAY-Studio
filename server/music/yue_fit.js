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
 *    ⚠ AND NO SETTING IN THIS APP MOVES IT, which is the conclusion this module
 *    was rewritten around rather than the one it started with. The stage that
 *    limits duration is the synthesis prefill, and it holds the entire model
 *    every time: nar.py:249 constructs CachedNAR — whose __init__ ends in
 *    `self._prefill()` at nar.py:127 — BEFORE nar.py:251 enters the offload
 *    context. So the peak is established while the AR half is still resident,
 *    and neither lever in `RUNGS` is in scope when it happens. The rungs are
 *    real and they help real stages; none of them helps this one. See
 *    `PREFILL_MIB_PER_SECOND`.
 *
 * 2. THE GENERATION CAP — `semantic.max_tokens` 9000, which at the MEASURED
 *    25.0 tokens per second of audio is exactly 360.0 s. A hard stop in the
 *    sampler: the model stops emitting, so no card and no configuration reaches
 *    past it. MEASURED from two independently published files that agree:
 *      · YuE2-3B/yue2_generation_config.json                 (BF16 checkpoint)
 *      · Yue2-3B-GGUF/sidecars/yue2-generation-config.json   (GGUF release)
 *    protocol.py:29 is the same 9000, and its validator sets no upper bound —
 *    so this one is raisable in principle, unlike the next.
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
 * keys differing (MEASURED by reading both files' headers, 2026-09-11). Quantization
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
 */
export const RUNGS = [
  {
    id: "standard",
    label: "Standard",
    quantization: "none",
    offloadAr: false,
    savesGib: 0,
    /* MEASURED: 168.0 s of audio at this configuration on a 16 GiB RTX 4070 Ti
     * SUPER, peak 10.6 GiB of the 13.99 GiB the runtime allows — seven times,
     * at exactly 167.9987 s, because that is where the score budget stops it
     * rather than where the card does. A demonstrated reach, NOT this rung's
     * ceiling: the card's true limit is above it and is unmeasured. */
    reachSeconds: 168.0,
    reachFrom: "MEASURED — 7 renders at 167.9987 s, peak 10.6 GiB of 13.99 allowed",
    lowers: ["nothing — this is the vendor's own default configuration"],
    speed: 1.0,
    costs: [],
  },
  {
    id: "long",
    label: "Steady",
    quantization: "none",
    offloadAr: true,
    /* MEASURED 4.0344 GiB: the 310 tensors nar.py:208-210 names — embed_tokens,
     * lm_head, and every layer's input_layernorm / self_attn /
     * post_attention_layernorm / mlp — summed from the safetensors header,
     * leaving the 318 `nar_*` tensors (2.7283 GiB) on the card.
     *
     * ⚠ AND IT DOES NOT RAISE THE DURATION CEILING. This rung was first written
     * here claiming it did, on the reasoning that it frees memory in the
     * synthesis stage and synthesis is the stage whose memory grows with
     * length. Both halves of that are true and the conclusion is still false,
     * because of an ORDERING that has to be read to be seen:
     *
     *   nar.py:249   engine = CachedNAR(...)        <- __init__ ends at
     *   nar.py:127   self._prefill()                   nar.py:127
     *   nar.py:251   with _offload_ar(model, offload_ar):
     *   nar.py:257       engine.solve(...)
     *
     * `_prefill` (nar.py:133-149) is the expensive moment: it runs all 28
     * layers through `layer.self_attn.project_qkv` and `layer.mlp` — the exact
     * modules this flag moves — and builds the whole 114,688-bytes-per-token
     * K/V cache. It happens BEFORE the `with`. So the stage's peak is set while
     * the AR half is still resident, every time, and the offload only applies
     * to the 64 velocity evaluations that follow it.
     *
     * What the flag therefore buys is headroom during the LONGEST phase rather
     * than a lower peak: less allocator pressure across the solve, which is
     * most of the wall clock. That is worth having and is why the rung stays.
     * It is not a bigger song, and this comment exists so the claim is not
     * quietly reintroduced. */
    savesGib: 4.0344,
    reachSeconds: null,
    reachFrom: "NOT A DURATION LEVER — 4.0344 GiB freed during the solve (measured), "
      + "but the stage peak is set by the prefill before the offload begins",
    lowers: ["the synthesis solve, not the synthesis peak (nar.py:249 precedes nar.py:251)"],
    /* config.js:445 has carried "2.89x realtime with it against 2.39x without"
     * since the engine landed. That comparison cannot be about this flag:
     * nothing read `config.yue.offloadAr`, this door did not take the option,
     * the driver had no argument for it, and pipeline.py's default is False —
     * so the 2.89x run had the flag OFF, and its own comment calls it "a first
     * pass". It measures a cold start. The cost of this lever is UNMEASURED. */
    speed: null,
    costs: ["The model's first half moves to system memory during synthesis and back "
      + "again, once per chunk, so the render is slower. Not yet measured by how "
      + "much. The audio is unchanged: the same weights, moved."],
  },
  {
    id: "compact",
    label: "Small card",
    quantization: "fp8",
    offloadAr: true,
    /* 4.0344 + 1.3125. The FP8 figure is MEASURED the same way: the 196 tensors
     * matching quantization.py's own AR_LINEAR regex weigh 2.6250 GiB at BF16,
     * and E4M3 is one byte where BF16 is two.
     *
     * ⚠ WHICH STAGE EACH ONE LOWERS, because they are not additive at any single
     * peak and presenting them as one number would be the same mistake as
     * above. FP8 lowers the PLANNING and SEMANTIC stages: quantization.py's
     * restore_ar puts exact BF16 back before the NAR prefill, so it is not
     * resident where the synthesis peak happens. offload_ar lowers the
     * synthesis SOLVE. Nothing either of them does touches the synthesis
     * PREFILL, which carries the full 6.7627 GiB every time.
     *
     * So this rung is for a card that cannot hold the semantic stage — a real
     * and common case, since that stage allocates
     * 114,688 x (prefix + max_tokens) bytes of K/V cache and DOUBLES it when
     * cot is "off" (sampling.py:97-100, cuda_graph.py:92). It is not for
     * longer songs. */
    savesGib: 5.3469,
    reachSeconds: null,
    reachFrom: "NOT MEASURED — 1.3125 GiB off the semantic stage and 4.0344 off the "
      + "synthesis solve (both measured); the synthesis prefill is unchanged",
    lowers: ["the planning and semantic stages (fp8)",
             "the synthesis solve (offload_ar)"],
    speed: null,
    /* The vendor's own words, and not decoration: quantization.py's docstring
     * opens "Opt-in experimental FP8 AR linear layers" and says "No quantized
     * quality or speed claim is implied by enabling this module", and
     * quantization_status() reports both "quality_validation": "unvalidated"
     * and "performance_validation": "unvalidated". Repeating that is the honest
     * thing; softening it would invent a claim the people who wrote the kernel
     * declined to make. */
    costs: ["Slower, for the same reason as Steady.",
      "The first half of the model runs at 8-bit precision. The model's authors "
      + "publish this as experimental and explicitly make no quality claim about "
      + "it, so neither do we — nobody has measured whether it sounds the same.",
      "Needs an NVIDIA card of compute capability 8.9 or newer — RTX 40-series or "
      + "later. On anything older the 8-bit kernels do not exist and this rung "
      + "cannot be selected."],
  },
];

/**
 * WHERE THE DURATION WALL ACTUALLY IS, since no rung above moves it.
 *
 * The synthesis prefill allocates 114,688 bytes per token of AR context
 * (nar.py:143,146 — 2 x 28 layers x 8 kv_heads x 128 head_dim x 2 bytes), over
 * a context of `prefix + frames + 1` where frames is 25 per second of audio.
 * So its peak grows with the song at a MEASURED 114,688 x 25 = 2,867,200 bytes
 * = 2.734 MiB per second of finished audio, with the full 6.7627 GiB of weights
 * resident alongside it and no lever able to move either term.
 *
 * ⚠ AND IT WOULD PLATEAU, BUT NOT SOON ENOUGH TO MATTER. protocol.py:141-145
 * splits the codec into chunks of `(24576 - prefix - 3) // 2` frames and
 * nar.py:245-260 solves them serially, releasing each chunk's cache before the
 * next — so past one chunk the peak stops growing. At a ~1000-token prefix that
 * is 11,786 frames = 471.4 s. But the sampler stops at 9000 semantic tokens =
 * 360 s, which is SHORTER. The plateau is therefore unreachable in a default
 * render, and across the whole span a user can actually ask for, synthesis
 * memory rises monotonically with duration.
 *
 * That is the honest shape of it: one wall, no lever, and a chunking mechanism
 * that would help if the model would generate long enough to reach it. The way
 * to a longer song is more sections, joined — not a setting.
 */
export const PREFILL_MIB_PER_SECOND = Number((114688 * 25 / 2 ** 20).toFixed(3));

/** `(24576 - prefix - 3) // 2` frames, at the ~1000-token prefix we measure. */
export const CHUNK_PLATEAU_SECONDS =
  Number((Math.floor((CONTEXT_FRAMES - 1000 - 3) / 2) / TOKENS_PER_AUDIO_SECOND).toFixed(1));

/** Compute capability FP8 needs. quantization.py:74 `< (8, 9)` raises. */
export const FP8_MIN_CAPABILITY = [8, 9];

const rung = (id) => RUNGS.find((r) => r.id === id) || null;

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
  const cap = opts.capability || null;
  const fp8Ok = !cap || (cap[0] > FP8_MIN_CAPABILITY[0]
    || (cap[0] === FP8_MIN_CAPABILITY[0] && cap[1] >= FP8_MIN_CAPABILITY[1]));

  const usable = ladder.filter((r) => r.quantization !== "fp8" || fp8Ok);
  const base = usable[0];

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
    const asRendered = fit(GENERATION_CAP_SECONDS, opts);
    return {
      rung: asRendered.rung, wantSeconds: want, ceiling: "generation",
      promoted: asRendered.rung.id !== base.id,
      notes: asRendered.notes,
      info: {
        level: "warn",
        title: `${fmt(want)} is past the model's own stopping point`,
        lines: [
          `YuE2 stops generating at ${TOKEN_CAPS.semantic} semantic tokens, which is `
          + `${fmt(GENERATION_CAP_SECONDS)} of audio. That is the model's published `
          + `generation default, not a limit of your card — a bigger card does not `
          + `reach further, and neither does the quantized release, whose own config `
          + `file carries the same ${TOKEN_CAPS.semantic}. Expect the song to end `
          + `around ${fmt(GENERATION_CAP_SECONDS)}.`,
          /* Whatever the memory rule said about 360 s applies unchanged, because
           * 360 s is what is being rendered. Carrying its lines through rather
           * than restating them keeps one description of one configuration. */
          ...(asRendered.info ? asRendered.info.lines : []),
        ],
      },
    };
  }

  /* Ceiling 1 — memory, the one the ladder is for. Promote to the cheapest rung
   * whose reach has been MEASURED to cover the request; if none has, promote to
   * the one with the most measured headroom and say that its reach is untested.
   * A rung is never promoted to on the strength of an estimated reach, which is
   * why `reachSeconds` is allowed to be null. */
  const covered = usable.find((r) => r.reachSeconds !== null && want <= r.reachSeconds);
  if (covered) {
    return { rung: covered, wantSeconds: want, ceiling: null,
             promoted: covered.id !== base.id, notes: [], info: null };
  }

  const chosen = usable.reduce((a, b) => (b.savesGib > a.savesGib ? b : a), usable[0]);
  const proven = base.reachSeconds;
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
        /* ⚠ THE BOX MUST NOT OFFER A CURE IT DOES NOT HAVE. The obvious thing
         * to write is "switching to a lower-memory configuration". That would
         * be false: the stage that limits duration is the synthesis prefill,
         * which carries the full model every time (nar.py:249 constructs and
         * prefills BEFORE nar.py:251 offloads anything), and no option this
         * app can pass makes it smaller. Saying otherwise would send someone
         * to a setting instead of to the thing that works. */
        `What limits length is the synthesis stage, and it is not a setting: it `
        + `holds the whole model and adds ${PREFILL_MIB_PER_SECOND} MiB for every `
        + `second of audio, so a longer song simply needs a bigger card. Selected `
        + `${chosen.label} because it is the lightest configuration available, `
        + `which helps the other stages — not this one.`,
        `If it does not fit: render the song in sections and join them. That is `
        + `the only reliable route to a longer piece on this hardware, and it is `
        + `what the model does internally anyway above ${fmt(CHUNK_PLATEAU_SECONDS)}.`,
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
  return { quantization: r.quantization, offloadAr: r.offloadAr };
}
