/**
 * Model catalogue and downloader.
 *
 * The point of this file is Joe.
 *
 * Every optional capability in Studio — cover art, stems, timed lyrics — works
 * on this machine only because its weights happen to be sitting in a cache
 * somebody filled by hand. That is not a product. So capabilities do not assume
 * their models exist: they DECLARE them here, the app reports what is missing
 * with an honest size, and one button fetches it. Nothing is downloaded without
 * being asked for, and nothing is silently 4 GB.
 *
 * Design rules this file exists to enforce:
 *
 *  - **Nothing auto-downloads.** A first run must never begin with 12 GB of
 *    traffic the user did not consent to.
 *  - **Sizes are real, and checked.** Every entry carries the exact byte count
 *    from the HuggingFace API, and a file is only "present" if it matches. A
 *    truncated download that merely EXISTS is the failure mode that turns into
 *    "the model is corrupt" bug reports weeks later.
 *  - **Licences are stated where the user chooses**, not buried. Two of these
 *    are Apache-2.0 and one is MIT, which is the whole reason they were picked.
 *  - **Downloads resume.** These are gigabytes over a home connection.
 *  - **Every entry answers "may I sell what this made."** `outputRights` below,
 *    beside `licence`, in the publisher's own words. A model whose output terms
 *    nobody has read ships as `unknown`, never as a guess in either direction.
 *
 * ⚠ THE INVARIANT THIS FILE STANDS ON:
 *
 *   **Studio must stay a free program that ships no weights, mirrors nothing,
 *   sells nothing, and is not required by any paid AIPLAY feature.**
 *
 * That is an invariant, not a preference, because every one of these licences
 * was read as "a person downloads weights from the publisher onto their own
 * machine and runs them" — and each convenience that sounds harmless moves the
 * question somewhere a lawyer has to answer:
 *
 *   · a CDN mirror ("just so downloads are faster") makes Studio a REDISTRIBUTOR
 *     — and redistribution is precisely where these licences attach conditions:
 *     pass the agreement on, carry the NOTICE, honour the territory. H3's grant
 *     is territorial; mirroring its weights would hand them to people its
 *     licensor did not grant them to;
 *   · an aiplay.live login makes the user's licence OUR account relationship,
 *     which is what "hosting the model behind an API" clauses are written about;
 *   · a paid tier, or a platform feature that only works with Studio, makes the
 *     weights part of a monetised product — the exact wording several
 *     non-commercial licences use;
 *   · and any of the above turns "the licence is between the user and the
 *     publisher", which every screen in this app says out loud, into a claim we
 *     could no longer make.
 *
 * A settled question is worth more than a convenience. Nothing here is a
 * hardship: `homeFor()` links to the publisher, `download()` fetches from them,
 * and Studio never touches the bytes.
 */
import { createWriteStream } from "node:fs";
import { stat, mkdir, rename, unlink, statfs } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { config } from "./config.js";

const HF = "https://huggingface.co";

/**
 * Where a capability's weights actually come from.
 *
 * DERIVED from the download URLs rather than typed alongside them. A hand-kept
 * second list of links is a list that goes stale the first time a repo moves,
 * and a credit pointing at a 404 is worse than no credit. Every file URL here
 * is a HuggingFace `resolve` path, so the repo page is that path cut at
 * `/resolve/`.
 */
function homeFor(cap) {
  /* Two capabilities have no files of their own -- their libraries fetch into a
   * private cache -- so there is nothing to derive from and the source has to be
   * stated. Everything else derives. */
  if (cap.home) return cap.home;
  const u = (cap.files || []).map((f) => f.url).find((x) => typeof x === "string" && x.includes("/resolve/"));
  if (!u) return cap.gated?.url || cap.region?.url || null;
  return u.split("/resolve/")[0];
}
const M = (p) => path.join(config.comfyDir, "models", p);

/**
 * @typedef {object} ModelFile
 * @property {string} url    direct download
 * @property {string} dest   absolute path on disk
 * @property {number} bytes  exact size, used to verify completeness
 */

/* ─────────────────────────────────────────────────── output rights (D6)
 *
 * "Non-commercial" is a claim about THE MODEL. It is almost never a claim about
 * the picture, and people lose money to that confusion in both directions —
 * some never sell work they own outright, others sell work under the one
 * licence that really does reach the output.
 *
 * So every capability carries `outputRights` beside `licence`, and it answers
 * exactly one question: **may the person who made this sell it?** Four classes,
 * deliberately no fifth — a scale with more steps is a scale nobody reads:
 *
 *   unrestricted           nothing in the licence touches what you generate.
 *   yours-with-conditions  the licence SAYS you may, and names conditions.
 *   not-for-sale           the ban reaches the output itself.
 *   unknown                nobody has read the operative text. Not a verdict.
 *
 * Three rules this field exists to enforce:
 *
 *  1. **The user reads the source, never our summary.** `quote` is the operative
 *     sentence VERBATIM, `clause` says where it sits, `url` goes to the text.
 *     Our prose is navigation; the quote is the evidence.
 *  2. **`unknown` is a real answer and is never dressed up.** Ideogram 4's
 *     agreement is behind an HTTP 401 (re-checked 2026-08-27) and has not been
 *     read by anyone here. Repeating a plausible restriction as fact is the
 *     same failure as repeating a plausible permission.
 *  3. **It never blocks anything.** Studio cannot know where a file is going —
 *     a wallpaper, a client's album cover, a joke in a group chat — so it states
 *     the terms and gets out of the way. A tool that guesses wrong about that
 *     gets routed around, and then it informs nobody.
 *
 * Territory is a SEPARATE axis and lives in `region` (H3). An entry may be
 * "yours to sell" and still ungrantable where you live; the two fields must
 * agree rather than one quietly answering for the other.
 *
 * @typedef {object} OutputRights
 * @property {"unrestricted"|"yours-with-conditions"|"not-for-sale"|"unknown"} class
 * @property {boolean|null} sellable  null ONLY for `unknown`
 * @property {string} quote           the operative sentence, verbatim
 * @property {string} clause          where that sentence sits in the document
 * @property {string} url             where to read it
 * @property {string[]} [conditions]  required for `yours-with-conditions`
 * @property {string} [note]          our navigation, never a substitute for the quote
 */

/** Chip wording, in one place: the UI must not invent its own phrasing. */
export const OUTPUT_RIGHTS_CLASSES = {
  "unrestricted": {
    chip: "Yours to sell",
    tone: "ok",
    line: "This model's licence places no condition on what you generate with it.",
  },
  "yours-with-conditions": {
    chip: "Yours to sell",           // the UI appends "— N conditions"
    tone: "warn",
    line: "The licence says in writing that the output is yours to use commercially, and attaches conditions.",
  },
  "not-for-sale": {
    chip: "Not for sale (model licence)",
    tone: "bad",
    line: "This licence's commercial ban reaches the generated material itself, not only the weights.",
  },
  "unknown": {
    chip: "Rights unverified",
    tone: "unknown",
    line: "Nobody has read the operative text. This is not a verdict either way — read it yourself before you rely on it.",
  },
};

/* The three permissive texts quoted below appear verbatim in several entries.
 * Held as constants so a typo cannot make one entry's quote differ from another
 * entry's quote of the SAME sentence — a quote that has drifted is worse than
 * no quote, because it is believed.
 *
 * MIT: the grant paragraph in demucs, whisper, Practical-RIFE and BiRefNet was
 * fetched from each project's own LICENSE on 2026-08-27 and is byte-identical
 * across all four (whitespace-normalised md5 0fb95aee…). Apache-2.0 §2 is the
 * canonical text (`licence_reframe/archive/apache20.txt`), which the shipped
 * FLUX.2 klein 4B LICENSE.md matches word for word per the licence re-analysis
 * (1426 words, similarity 1.0, no addendum). BSD-3 is Real-ESRGAN's own. */
const MIT_GRANT =
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software '
  + 'and associated documentation files (the "Software"), to deal in the Software without restriction, '
  + "including without limitation the rights to use, copy, modify, merge, publish, distribute, "
  + "sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is "
  + "furnished to do so, subject to the following conditions:";
const APACHE_GRANT =
  "Subject to the terms and conditions of this License, each Contributor hereby grants to You a "
  + "perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to "
  + "reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and "
  + "distribute the Work and such Derivative Works in Source or Object form.";
const BSD3_GRANT =
  "Redistribution and use in source and binary forms, with or without modification, are permitted "
  + "provided that the following conditions are met:";
/* Why a permissive licence is `unrestricted` rather than `yours-with-conditions`:
 * its conditions are about REDISTRIBUTING THE SOFTWARE (keep the notice, keep
 * the disclaimer). None of them are conditions on the material you generate,
 * and the documents say nothing about generated material at all. Quoting the
 * grant lets the user check that for themselves in one click. */
const PERMISSIVE_NOTE =
  "This licence says nothing about generated output at all — its conditions are about redistributing "
  + "the software itself. There is no term to comply with when you sell a picture, a stem or a clip.";

/* ─────────────────────────────────────────── Z-Image's shared halves
 *
 * Turbo and base are one architecture, one encoder, one VAE and one licence
 * DOCUMENT, so those four things are written once here and referenced by both
 * entries below — the same reason MIT_GRANT is a constant. Two quotes of the
 * same sentence that have drifted apart is the failure this file is built to
 * prevent, and two copies of the same file record would drift a byte count.
 *
 * Why two entries at all, rather than one with both transformers: `ready` is
 * all-or-nothing per capability, so folding them together would make someone
 * who wants the 8-step model download 12.7 GB to get it. This file's first
 * design rule is "nothing is silently 4 GB". Two entries is also the shape
 * `video` and `videoRefs` already use for H3's two checkpoints, for exactly
 * this reason — a second checkpoint that reuses the first's encoder.
 */
const ZIMAGE_RIGHTS = {
  class: "unrestricted",
  sellable: true,
  quote: APACHE_GRANT,
  clause: "Apache-2.0 §2 (Grant of Copyright License)",
  /* ⚠ GITHUB, not HuggingFace, and the difference is not cosmetic: BOTH HF
   * repos publish `license: apache-2.0` in README frontmatter and NO LICENSE
   * FILE. Frontmatter is a tag, not a document. The operative text is the one
   * in Tongyi-MAI's own repo, and the licence re-analysis normalised it
   * against canonical Apache-2.0 on 2026-08-27: 11,357 bytes, 1,581 words,
   * identical, ending at END OF TERMS AND CONDITIONS. */
  url: "https://github.com/Tongyi-MAI/Z-Image/blob/main/LICENSE",
  note: PERMISSIVE_NOTE + " Checked rather than assumed: neither HuggingFace repo carries a LICENSE file — "
    + "only `license: apache-2.0` in the README — so the text quoted here is Tongyi-MAI's own on GitHub, "
    + "normalised against canonical Apache-2.0 and found identical: no addendum, no acceptable-use annexe, "
    + "no revenue ceiling, no territory clause. Nothing in it reaches a picture you make and sell.",
};
/**
 * Anima — the model is non-commercial, the PICTURES are yours.
 *
 * This is the split outputRights exists for, and reading the licence rather
 * than the tag is what surfaces it. The HuggingFace frontmatter says only
 * `license: other` / `circlestone-labs-non-commercial-license`, which reads as
 * a flat no. The text says something more useful:
 *
 *   §1(a) "For the avoidance of doubt, Outputs are not considered Derivatives
 *          under this License."
 *   §2(e) "We claim no ownership rights in and to the Outputs... You may use
 *          Outputs for any purpose (including for commercial purposes), except
 *          as expressly prohibited herein."
 *
 * So a picture you make with Anima is sellable. What is NOT permitted is
 * commercial or production use OF THE MODEL — §4(a) — and §1(c) is explicit
 * that "direct interactions with or that has impact on third-party end users"
 * is outside the grant. Generating locally in a free tool is squarely inside
 * it; standing the model up as a hosted service for other people is not.
 *
 * That is the whole reason this app runs models on your own machine, and it is
 * why the same licence would be a blocker for a platform and is not one here.
 */
const ANIMA_RIGHTS = {
  class: "yours-with-conditions",
  sellable: true,
  quote: "We claim no ownership rights in and to the Outputs. You are solely responsible for the Outputs "
    + "you generate and their subsequent uses in accordance with this License. You may use Outputs for any "
    + "purpose (including for commercial purposes), except as expressly prohibited herein.",
  clause: "CircleStone Labs Non-Commercial License v1.2 §2(e) (Outputs)",
  url: "https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md",
  conditions: [
    "The MODEL is non-commercial (§4(a)). Generating on your own machine for personal, hobby or research "
    + "work is inside the grant; running it as a paid or production service is not, and §1(c) names "
    + "\"direct interactions with or that has impact on third-party end users\" as outside it.",
    "Outputs are explicitly NOT Derivatives (§1(a)), so selling a picture is not selling a derivative "
    + "of the model.",
    "§4(a)(ii) forbids use that infringes publicity or \"digital replica\" rights — which is a real "
    + "constraint on likeness work, not boilerplate.",
    "Redistributing the weights or a fine-tune requires carrying the licence and the attribution notice "
    + "(§3). Nothing this app does redistributes them.",
  ],
  note: "Read from the licence text on 2026-08-27, not from the repo tag: the frontmatter says only "
    + "`license: other`, which would have filed a model whose outputs are explicitly commercial-safe as a "
    + "flat refusal.",
};

/* Anima's two companions. The DiT itself is NOT listed: this entry exists to
 * make the Anima checkpoints a user already has usable, and the base model is
 * offered as a variant rather than pushed — 4.18 GB nobody asked for is not a
 * dependency. */
const ANIMA_ENCODER = {
  url: `${HF}/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors`,
  dest: M("text_encoders/qwen_3_06b_base.safetensors"), bytes: 1192135096,
};
/* ⚠ Qwen-IMAGE's VAE, not Qwen3's anything, and not the `ae.safetensors`
 * already in this folder for Z-Image. The model class declares a WAN 2.1 latent
 * format, which reads like it wants the WAN VAE; the vendor blueprint loads
 * this one. Same trap as Z-Image's encoder type — the class says what it can
 * accept, the blueprint says what it was tested with. */
const ANIMA_VAE = {
  url: `${HF}/circlestone-labs/Anima/resolve/main/split_files/vae/qwen_image_vae.safetensors`,
  dest: M("vae/qwen_image_vae.safetensors"), bytes: 253806246,
};

const ZIMAGE_REQUIRES = {
  vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
  /* 🔑 THE LIMIT HERE IS SYSTEM RAM, NOT VRAM, and that is the opposite of
   * what every other entry in this file wants you to worry about.
   *
   * The 6.2 GB transformer and the 8.04 GB encoder never have to be resident
   * together: ComfyUI encodes the prompt, frees the encoder, then loads the
   * DiT, and on Studio's default --lowvram flags it streams the rest from
   * pinned host memory — measured on this rig (RTX 4070 Ti SUPER, 16 GB) at a
   * torch allocator peak of only ~2.3 GB.
   *
   * Which is exactly why free RAM decides the render time. Measured 2026-08-27,
   * same graph, same seed 12345, one 1024² base picture, only the machine's
   * free memory different:
   *
   *     16.3 GB free  →  41 s
   *      3.8 GB free  →  still running at 13 minutes, and interruptible only
   *                      between sampler steps
   *
   * The 25-step run pushed a second ComfyUI's working set into the pagefile
   * and every streamed block then came off the disk. Close the other GPU app
   * before a long batch; do not read a slow render here as the model. */
  note: "The 6.2 GB transformer and the 8.04 GB text encoder never have to be resident together — ComfyUI "
    + "encodes the prompt, frees the encoder, then loads the DiT, and streams the rest from system RAM "
    + "(measured here: ComfyUI's own allocator peaks at ~2.3 GB of VRAM). ⚠ So the number that decides "
    + "your render time is FREE SYSTEM RAM, not VRAM: the same 25-step picture took 41 s with 16 GB free "
    + "and was still going after 13 minutes with 3.8 GB free, because the streamed blocks came off the "
    + "pagefile. Close other GPU apps before a batch.",
};
/* ⚠ THE ENCODER IS LISTED IN BOTH ENTRIES, AND THAT IS NOT A SECOND DOWNLOAD.
 *
 * `filePresent()` skips a file already on disk at the right size, so on a
 * machine that has FLUX.2 klein this line costs nothing and the Models screen
 * just shows 8.04 GB of the total already present — exactly what the Ideogram
 * entry does with flux2-vae. Leaving it OUT is the worse bug in the other
 * direction: on a machine WITHOUT klein, `ready` would go true with no text
 * encoder on disk and the first render would die inside ComfyUI on a filename.
 *
 * That klein's copy and Z-Image's copy are the SAME BYTES is measured, not
 * assumed — the HF LFS sha256 is
 * 6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a in
 * Comfy-Org/z_image_turbo, Comfy-Org/z_image AND Comfy-Org/flux2-klein-4B
 * (checked 2026-08-27). The model research left this [UNVERIFIED]; it is
 * settled. What is NOT shared is the CLIPLoader `type` that wraps the file —
 * see the footgun block over zImageGraph() in workflow.js. */
const ZIMAGE_ENCODER = {
  url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`,
  dest: M("text_encoders/qwen_3_4b.safetensors"), bytes: 8044982048,
};
/* FLUX.1's 16-channel autoencoder. NOT flux2-vae.safetensors, which is
 * 32-channel and already sitting in the same folder on most of these machines
 * — same family name, different latent space, and the wrong one decodes noise.
 * This 0.34 GB file is the only genuinely new weight Z-Image needs. */
const ZIMAGE_AE = {
  url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors`,
  dest: M("vae/ae.safetensors"), bytes: 335304388,
};

/**
 * Capabilities, in the order a user meets them.
 *
 * `engine` is the only required one; everything below it is opt-in and the app
 * is fully usable without any of them.
 */
export const CATALOG = [
  {
    id: "engine",
    label: "Music engine — MiniMax Music 3",
    why: "Required. This is what writes and renders the music.",
    licence: "MiniMax Music3 Community Licence",

    /* Read in full from the publisher's own repo on 2026-08-27
     * (MiniMaxAI/MiniMax-Music3/LICENSE, HTTP 200 — note the repo id has no
     * hyphen before the 3; MiniMax-Music-3 401s and is a different thing).
     * It is an MIT-shaped grant with four numbered conditions bolted on, and
     * NO territory clause — this is not H3.
     *
     * ⚠ Worth knowing which document governs: the files below come from
     * Comfy-Org's repackage, whose README frontmatter says `license: apache-2.0`.
     * That is a repackager's tag. The weights are MiniMax's and the Community
     * Licence is what MiniMax published with them. */
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "Permission is hereby granted, free of charge, to any person obtaining a copy of this Software, including the model weights, parameters, configuration files, inference code and associated documentation (the “Software”), to deal in the Software, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or provide copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
      clause: "MiniMax-Music3 Community License, grant paragraph",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE",
      conditions: [
        "§3.1 — a commercial product or service that uses it must show “MiniMax-Music3” prominently in its interface. That is why the name sits in Studio's corner rather than on a credits page.",
        "§3.2 — above USD 20 million a year in revenue from such products you need MiniMax's prior written authorisation (api@minimax.io).",
        "§2 and Exhibit A — the Acceptable Use Policy binds your use of the software.",
        "§4 — if you let other people generate with it through a product or hosted service, you owe safeguards against infringing output.",
      ],
      note: "Unlike H3 and LTX, this licence never says “we claim no rights in your Outputs” — it simply never restricts them, and its conditions all attach to the software and to commercial products built on it. The absence is stated here rather than read as either a claim or a disclaimer.",
    },
    required: true,
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/diffusion_models/minimax_music3_dit_int8_convrot.safetensors`,
        dest: M("diffusion_models/minimax_music3_dit_int8_convrot.safetensors"), bytes: 2502161682 },
      { url: `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors`,
        dest: M("text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors"), bytes: 9196611886 },
      { url: `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main/vae/minimax_music3_dav.safetensors`,
        dest: M("vae/minimax_music3_dav.safetensors"), bytes: 216696128 },
    ],
    // These are already the SMALLEST published variants — see config.js. "Use a
    // smaller model" is not an option that exists; the low-VRAM tiers work by
    // streaming, not by shrinking.
    note: "The smallest published weights. Lower-VRAM machines stream these from system RAM rather than using different files.",
    requires: {
      // Measured on this rig, not guessed: the music stack sits at ~14.1 GB
      // resident (DiT fp16 4.91 + text encoder int8 9.20).
      vramMinGb: 6, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Runs on less by streaming weights from system RAM — that is what the graphics-memory tiers do. The 6 GB tier is UNPROVEN on real hardware.",
    },
    variants: [
      { label: "DiT int8 convrot (shipped)", bytes: 2502161682, note: "Measured identical to fp16 against a converged reference." },
      { label: "DiT fp16", bytes: 4914197682, note: "Twice the size for the same measured result." },
      { label: "DiT fp32", bytes: 9828345396, note: "Never measured here." },
      { label: "Encoder pruned int8 convrot (shipped)", bytes: 9196611886 },
      { label: "Encoder pruned bf16", bytes: 16706629398 },
      { label: "Encoder bf16", bytes: 18472478038 },
    ],
  },
  {
    id: "audioRef",
    label: "Audio reference — MiniMax Music 3 DAV encoder",
    why: "Starts a render from a real song instead of from silence.",

    /* ⚠ LICENCE, stated carefully because the repo itself states none.
     *
     * SimpleTuner/MiniMax-Music-3-Encoder publishes no licence field. These are
     * the ENCODER half of MiniMax Music 3's DAV autoencoder, and the engine
     * entry above already fetches the decoder half of the same autoencoder, so
     * the Music 3 Community Licence is what governs them. Studio links to the
     * publisher and hosts nothing, exactly as everywhere else in this file. */
    licence: "MiniMax Music3 Community Licence",

    /* Rights INHERITED, and the inference is stated rather than hidden: this
     * repo publishes no licence of its own, these are the encoder half of the
     * same DAV autoencoder whose decoder the engine entry fetches, so the
     * engine's terms are what apply. The quote is therefore the engine's
     * licence, not a document about this file — say so plainly. */
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "Permission is hereby granted, free of charge, to any person obtaining a copy of this Software, including the model weights, parameters, configuration files, inference code and associated documentation (the “Software”), to deal in the Software, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or provide copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
      clause: "MiniMax-Music3 Community License, grant paragraph (inherited — see the note)",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE",
      conditions: [
        "§3.1 — a commercial product or service that uses it must show “MiniMax-Music3” prominently in its interface.",
        "§3.2 — prior written authorisation from MiniMax above USD 20 million a year in revenue.",
        "§2 and Exhibit A — the Acceptable Use Policy binds your use of the software.",
      ],
      note: "SimpleTuner's repo states no licence. These are Music 3 encoder weights and this entry applies Music 3's terms to them — an inference, not a document. What this encoder produces is a latent that the engine turns into a song, so in practice the song's terms are the engine's.",
    },
    files: [
      { url: `${HF}/SimpleTuner/MiniMax-Music-3-Encoder/resolve/main/audio_vae/diffusion_pytorch_model.safetensors`,
        dest: M("vae/minimax_music3_dav_encoder.safetensors"), bytes: 306466152 },
    ],

    /* ComfyUI never loads this file. `comfy/sd.py` refuses to encode audio at
     * all, so `scripts/dav_encode.py` loads these weights itself, outside the
     * engine, and writes a .latent that stock `LoadLatent` then reads. It still
     * belongs under models/vae: that is what it is, and one place for weights
     * beats two. The encoder finds it here, in the HuggingFace cache, or via
     * AIPLAY_DAV_ENCODER — see find_ckpt() in that script. */
    needsPackage: "av",
    note: "ComfyUI ships the DAV decoder only — sd.py refuses to encode audio — so this is the missing half, and it runs outside ComfyUI. Its decoder tensors are bit-identical to the copy the engine already uses, which is what makes the latent it produces one the sampler understands: the round trip measures +26.26 dB SI-SDR. Encoding is capped at 60 seconds, enough to establish structure and short of the out-of-memory a full track hit while the music stack was resident. The publisher states no licence; these are Music 3 weights, so treat them as the engine's. Needs numpy, torch and PyAV in the system Python — INSTALL.md has the one pip line.",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Falls back to the CPU when there is no CUDA, several times slower. These figures follow from the 60-second cap rather than a per-tier measurement: a 2-minute stereo decode allocates over 4 GB and did OOM alongside the resident music stack, which is why the cap exists.",
    },
  },
  {
    id: "coverArt",
    label: "Cover art — FLUX.2 klein 4B",
    why: "Draws a cover for each song while nothing is generating.",
    licence: "Apache-2.0",

    /* THE ONE THE FAMILY SPLITS ON, and Studio is on the right side of it.
     * FLUX.2 splits by SIZE, not by name: klein-4B (and klein-base-4B, and the
     * fp8 build shipped here) are Apache-2.0 — the licence re-analysis
     * normalised klein-4B/LICENSE.md, klein-base-4B and klein-4b-fp8 against
     * canonical Apache-2.0 and got 1426 words, similarity 1.0, ZERO differences,
     * ending at END OF TERMS AND CONDITIONS with no addendum. FLUX.2-dev and
     * klein-9B are the non-commercial ones. Same brand, different answer. */
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: APACHE_GRANT,
      clause: "Apache-2.0 §2 (Grant of Copyright License)",
      url: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/blob/main/LICENSE.md",
      note: PERMISSIVE_NOTE + " Covers drawn here are yours outright — no attribution, no revenue ceiling, no filter duty.",
    },
    files: [
      { url: `${HF}/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors`,
        dest: M("diffusion_models/flux-2-klein-4b-fp8.safetensors"), bytes: 4070624520 },
      { url: `${HF}/Comfy-Org/flux2-klein-4B/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`,
        dest: M("text_encoders/qwen_3_4b.safetensors"), bytes: 8044982048 },
      { url: `${HF}/Comfy-Org/flux2-klein-4B/resolve/main/split_files/vae/flux2-vae.safetensors`,
        dest: M("vae/flux2-vae.safetensors"), bytes: 336211292 },
    ],
    note: "Roughly 3 seconds a cover once loaded. The text encoder is shared with other image models, so a second one later costs only its own weights.",
    requires: {
      vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Cannot be resident alongside the music engine on a 16 GB card, so covers are drawn only while nothing is generating.",
    },
    variants: [
      { label: "DiT fp8 (shipped)", bytes: 4070624520, note: "fp8 is native on Ada and Blackwell." },
      { label: "DiT bf16", bytes: 7751105712, note: "Nearly twice the size; no measured gain at 4 steps." },
      { label: "Encoder Qwen3-4B fp16 (shipped)", bytes: 8044982048 },
      { label: "Encoder Qwen3-4B fp4", bytes: 3848213998, note: "Half the size, but fp4 tensor cores are Blackwell-only — emulated on this Ada card." },
    ],
  },
  {
    id: "stems",
    home: "https://github.com/adefossez/demucs",   // torchaudio pulls HTDemucs itself
    label: "Stem separation — HTDemucs (fine-tuned)",
    why: "Splits a finished track into drums, bass, vocals and other.",
    licence: "MIT",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: MIT_GRANT,
      clause: "MIT License, grant paragraph (demucs LICENSE, Meta Platforms)",
      url: "https://github.com/adefossez/demucs/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " The stems it separates are parts of YOUR track; this tool's licence adds nothing to them.",
    },
    /* ⚠ NO files listed on purpose.
     *
     * The HuggingFace mirror (adefossez/HTDemucs-ft) publishes .safetensors, but
     * demucs does not read those — it fetches its own .th bundles from
     * dl.fbaipublicfiles.com into the torch hub cache on first run. Downloading
     * the HF copies ourselves would put 336 MB on disk that the tool then
     * ignores while it downloads its own. Verified: the first separation pulled
     * the weights unprompted and completed. */
    files: [],
    viaPackage: "demucs",
    approxBytes: 336101760,
    // Four models run in sequence and averaged — that IS the "-ft" variant, and
    // why it is four times the size of plain htdemucs.
    note: "Four fine-tuned models averaged together — the highest-quality Demucs variant. Measured here at about 12 s for a 30 s track, and the four stems come to roughly 4 MB as FLAC.",
    needsPackage: "demucs",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Runs on the CPU too, several times slower. Never runs while music is generating.",
    },
    variants: [
      { label: "htdemucs_ft (shipped)", bytes: 336101760, note: "Four models averaged — best quality, ~4x the time." },
      { label: "htdemucs", bytes: 84025440, note: "One model. Noticeably faster, slightly worse separation." },
    ],
  },
  {
    id: "video",
    label: "Video clips — MiniMax H3 (quantised)",
    why: "Renders a short looping clip to sit under a finished song.",
    licence: "MiniMax H3 Community Licence",

    /* Outputs and TERRITORY are two different answers and this entry carries
     * both. §VI.4 gives the clips to you; §V.4 then says the grant — including
     * for the Outputs — stops at the Applicable Territory boundary. So a clip
     * rendered by a licensee is theirs to sell, and `region` below is what
     * decides whether they could be a licensee at all. The chip must never read
     * as permission to run this where the territory excludes you. */
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property)",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — you may not use, reproduce, modify, distribute or display the Outputs outside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the USA. See the territory notice on this capability.",
        "§V.3 — Outputs may not be used to improve any other AI model.",
        "§IV.2 — a commercial product or service using H3 must display “MiniMax H3” prominently; §IV.1 needs written authorisation above USD 20 million a year.",
        "§V.5 — if you let other people generate with it, you owe safeguards and a way to report violations.",
      ],
    },

    /* 🔴 THE ONE ENTRY THAT IS REGION-LOCKED.
     *
     * H3's Community Licence grants rights "solely within the Applicable
     * Territory", which EXCLUDES the European Union, the United Kingdom, the
     * Republic of Korea and the United States of America (I.5, read from the
     * text on 2026-08-27). Everything else in this catalogue is Apache-2.0, MIT
     * or a licence with no territorial clause at all.
     *
     * Studio does not host, redistribute or bundle any weights — this is a
     * direct link to the publisher, exactly as ComfyUI Manager works — so the
     * obligation is the USER's and they have to be able to see it before they
     * choose. That is the whole reason `region` exists as a field rather than a
     * sentence buried in `note`: the UI is required to surface it as a blocking
     * acknowledgement, and `download()` refuses without one. */
    region: {
      /* ⚠ FOUR territories, not three. Read from the licence text itself on
       * 2026-08-27 (HTTP 200, ungated): I.5 defines Excluded Territories as
       * "the European Union, the United Kingdom, the Republic of Korea and the
       * United States of America." The USA was missing here — a summary written
       * before the 2026-08-02 licence date, and the kind of drift that is
       * exactly why `quote` exists in `outputRights` below. */
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "MiniMax grants H3 rights only inside its Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. If you are in one of those places you may not use these weights — and §V.4 says the same about anything they generate. AIPLAY Studio does not host them — the download goes straight to the publisher, and the licence is between you and MiniMax.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },

    /* OFFICIAL FILES — superseding the third-party hunt of 08-17.
     *
     * When this catalogue was first written, no official quantised H3 existed:
     * the DiT measured here was Abiray's int4 build (later pulled from its
     * repo) and the VAEs were cast locally. Comfy-Org has since published the
     * complete official set — the same filenames the ComfyUI templates use —
     * so that is what a fresh install gets.
     *
     * The official pruned int8 DiT is also simply BETTER: measured 08-24, same
     * seed/flow/prompt against the local int4 prune, it produced a
     * prompt-following photographic close-up where the int4 gave a distant
     * figure, at ~15% more wall clock. config.js prefers it when present. */
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`,
        dest: M("diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"), bytes: 20970379616,
        alt: ["minimax_h3_fl2va_pruned_int4_convrot.safetensors", "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors", "MiniMax_H3_FL2VA_pruned_mixed_int4_int8_convrot.safetensors"] },
      { url: `${HF}/Winnougan/MiniMax-H3-INT4_Convrot_ComfyUI/resolve/main/qwen3vl_32b_minimax_h3-int4_convrot.safetensors`,
        dest: M("text_encoders/qwen3vl_32b_minimax_h3-int4_convrot.safetensors"), bytes: 14173709116 },
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors`,
        dest: M("vae/minimax_h3_video_vae_fp16.safetensors"), bytes: 5207808496,
        alt: ["minimax_h3_video_vae_int8_convrot.safetensors"] },
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors`,
        dest: M("vae/minimax_h3_audio_vae_fp32.safetensors"), bytes: 605254808,
        alt: ["minimax_h3_audio_vae_bf16.safetensors"] },
      // Full-rank turbo LoRA on purpose — the 440 MB resized-rank one has two
      // independent reports of camera-movement and prompt-following damage.
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors`,
        dest: M("loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"), bytes: 1956192992 },
    ],
    note: "43 GB — by far the largest thing here, and entirely optional. H3 always renders audio even when you only want pictures; Studio discards it, because the song already exists. Measured on this rig at roughly 15 s fixed cost plus 1.7 s per step.",
    requires: {
      vramMinGb: 16, vramRecGb: 24, ramMinGb: 32, ramRecGb: 64,
      note: "The heaviest capability in Studio by a wide margin. Never runs while music is generating.",
    },
    variants: [
      { label: "DiT FL2VA pruned int8 convrot, official (offered)", bytes: 20970379616, note: "Measured 08-24: a class above the third-party int4 prune — real prompt-following close-ups — at ~15% more render time." },
      { label: "DiT FL2VA pruned int4 convrot (third-party)", bytes: 11337536848, note: "What this rig originally measured. Visibly worse than the official int8; kept as a fallback for small disks." },
      { label: "DiT FL2VA pruned fp8 scaled, official", bytes: 20956702112, note: "Same size as int8; not measured here." },
      { label: "DiT FL2VA pruned bf16, official (unquantised)", bytes: 40225724176, note: "Twice the download; not measured here." },
      { label: "Text encoder Qwen3-VL-32B int4 convrot (offered)", bytes: 14173709116 },
      { label: "Text encoder nvfp4 awq, official", bytes: 15690000000, note: "What the ComfyUI templates name. Blackwell-native; not measured here." },
      { label: "Text encoder int8 convrot, official", bytes: 27141342152, note: "Nearly twice the size." },
      { label: "Video VAE fp16, official (offered)", bytes: 5207808496 },
      { label: "Audio VAE fp32, official (offered)", bytes: 605254808 },
    ],
  },
  {
    id: "videoRefs",
    label: "Video references — MiniMax H3 ref2va",
    why: "The checkpoint BUILT for reference conditioning — pictures and audio the prompt calls by name (<Picture 1>, <Audio 1>). Without it, references still work on the fl2va checkpoint; this is the vendor's own model for the job, plus its turbo distillation for fast renders.",
    licence: "MiniMax H3 Community Licence",
    // Same licence, same output terms and same territory condition as the video
    // capability above — one document governs both checkpoints.
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property)",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Outputs may not be used, reproduced, distributed or displayed outside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the USA.",
        "§V.3 — Outputs may not be used to improve any other AI model.",
        "§IV.2 — a commercial product or service using H3 must display “MiniMax H3” prominently; §IV.1 needs written authorisation above USD 20 million a year.",
      ],
    },
    region: {
      /* ⚠ FOUR territories, not three. Read from the licence text itself on
       * 2026-08-27 (HTTP 200, ungated): I.5 defines Excluded Territories as
       * "the European Union, the United Kingdom, the Republic of Korea and the
       * United States of America." The USA was missing here — a summary written
       * before the 2026-08-02 licence date, and the kind of drift that is
       * exactly why `quote` exists in `outputRights` below. */
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "MiniMax grants H3 rights only inside its Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. If you are in one of those places you may not use these weights — and §V.4 says the same about anything they generate. AIPLAY Studio does not host them — the download goes straight to the publisher, and the licence is between you and MiniMax.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`,
        dest: M("diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"), bytes: 20970379616 },
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`,
        dest: M("loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"), bytes: 1956193000 },
    ],
    note: "23 GB, optional. Shares the text encoder and VAEs with the video capability, so install that first.",
    requires: {
      vramMinGb: 16, vramRecGb: 24, ramMinGb: 32, ramRecGb: 64,
      note: "Same weight class as the H3 video capability; the two never load together.",
    },
  },
  {
    id: "imageCutout",
    label: "Background removal — BiRefNet",
    why: "One click takes the background out of any library image: the subject stays, everything else becomes real transparency. Feeds compositing, logo work and the chroma tools.",
    licence: "MIT — chosen over the better-known RMBG-class models precisely because their licences are non-commercial and this one is not.",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: MIT_GRANT,
      clause: "MIT License, grant paragraph (BiRefNet LICENSE, ZhengPeng)",
      url: "https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " This is the whole reason BiRefNet was picked over RMBG-2.0, whose weights are non-commercial: a cutout you can sell.",
    },
    files: [
      { url: `${HF}/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors`,
        dest: M("background_removal/birefnet.safetensors"), bytes: 444473596 },
    ],
    note: "444 MB, runs in a couple of seconds through the ordinary engine queue.",
    requires: { vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16 },
  },
  {
    id: "imageIdeogram",
    label: "Images — Ideogram 4 (open 9B)",
    why: "A second image engine with a different eye: Ideogram's open release, strong at typography, posters and graphic layouts where FLUX paints. Dual-model CFG, 20-step Default or 48-step Quality. No reference-image input — iterating on refs stays with FLUX.2.",
    /* ⚠ WHAT WE ACTUALLY KNOW, which is less than this line used to claim.
     *
     * The only readable evidence is a NAME: the Comfy-Org repackage's README
     * frontmatter says `license_name: ideogram-non-commercial-model-agreement`
     * and links to `ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md`. That file
     * is gated — HTTP 401 to an anonymous request, re-checked 2026-08-27 — and
     * NOBODY HERE HAS READ IT. This entry used to state as fact that the
     * agreement bans commercial use of the outputs. That may well be true; it
     * was never verified, and "non-commercial" in every other licence in this
     * catalogue restricts the MODEL while leaving the pictures alone. Asserting
     * a restriction we have not read is the same failure as asserting a
     * permission we have not read, and it costs someone a sale either way. */
    licence: "Ideogram Non-Commercial Model Agreement — the licence NAME, from the repo's own metadata. The agreement text is gated (HTTP 401, re-checked 2026-08-27) and has not been read here, so what it says about the pictures you make is genuinely unknown: accept it on the model page and read it yourself, or render with FLUX.2 klein 4B (Apache-2.0), whose terms are settled.",
    /* THE `unknown` CLASS EXISTS FOR THIS ENTRY. No quote, because there is no
     * sentence anyone here has read — and an `unknown` is the one class allowed
     * to ship with an empty quote (the catalogue guard in provenance_test.js
     * enforces exactly that asymmetry). */
    outputRights: {
      class: "unknown",
      sellable: null,
      quote: "",
      clause: "",
      url: "https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md",
      note: "The Ideogram Non-Commercial Model Agreement is behind a gate: the URL above returns HTTP 401 to an anonymous request (checked 2026-08-27) and no copy of the text has been read here. The name says non-commercial; every other non-commercial licence in this catalogue restricts the MODEL and leaves the output alone — but Ideogram's may not, and Studio will not guess in either direction. Accept the agreement on the model page, read §-by-§, and decide. If you need a settled answer today, FLUX.2 klein 4B is Apache-2.0.",
    },
    files: [
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_fp8_scaled.safetensors`,
        dest: M("diffusion_models/ideogram4_fp8_scaled.safetensors"), bytes: 9280741285 },
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors`,
        dest: M("diffusion_models/ideogram4_unconditional_fp8_scaled.safetensors"), bytes: 9280741293 },
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/text_encoders/qwen3vl_8b_nvfp4.safetensors`,
        dest: M("text_encoders/qwen3vl_8b_nvfp4.safetensors"), bytes: 6305221764 },
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/vae/flux2-vae.safetensors`,
        dest: M("vae/flux2-vae.safetensors"), bytes: 336211292 },
    ],
    note: "25.2 GB (the VAE is shared with FLUX.2 and is usually already present). ⚠ fp8_scaled ON PURPOSE: the int8_convrot conversions of this model are BROKEN — the conversion damages the conditioning head and every render comes back as the model's trained-in 'blocked by safety filter' card (measured; the vendor's own fp8 renders perfectly). And the deeper finding: the open weights are NOISE-LOCKED — only a sparse, deterministic set of seeds renders at all (1 in 23 probed; seed 777 is the shipped one) and every other seed draws the card regardless of prompt. The app renders from its pass-seed list automatically; scripts/harvest_ideogram_seeds.mjs finds more overnight. Composition variety per prompt = the size of that list. Hunyuan Image 3.0 was evaluated and rejected: 48 GB of weights even at NF4, physically over this machine's memory.",
    requires: { vramMinGb: 12, vramRecGb: 16, ramMinGb: 32, ramRecGb: 32 },
  },
  {
    id: "imageZImage",
    label: "Images — Z-Image Turbo (Apache-2.0)",
    why: "Eight steps to a finished picture, and the licence puts no condition on selling it. The one image engine here that is both fast and legally settled.",
    licence: "Apache-2.0",
    outputRights: ZIMAGE_RIGHTS,
    files: [
      { url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors`,
        dest: M("diffusion_models/z_image_turbo_int8_convrot.safetensors"), bytes: 6201001296 },
      ZIMAGE_AE,
      ZIMAGE_ENCODER,
    ],
    note: "14.58 GB listed, of which 8.04 GB is the Qwen3-4B text encoder FLUX.2 klein already fetched — the same file, byte for byte — so on a machine that has klein this costs 6.54 GB, measured here at 2 min 47 s. Measured render at 1024²: 21 s cold, 5.8 s warm. Good for: photographic realism, faces and skin, bilingual English/Chinese prompts, and anything you mean to sell, because plain Apache-2.0 with no addendum is the cleanest answer in this catalogue. ⚠ Turbo is DISTILLED and samples at cfg 1.0, where ComfyUI never evaluates the negative branch at all — so it has no negative prompt, and the app says so rather than showing a box that does nothing. Its own publisher rates its diversity LOW: different seeds stay closer together than base's. Reference images are not available on ANY released Z-Image checkpoint, and that was tested rather than read off a README: ComfyUI's TextEncodeZImageOmni node runs and takes up to three pictures, but on these weights it returns the reference's own composition covered in colour noise with the prompt ignored, because the checkpoints it was written for (Z-Image-Edit, Z-Image-Omni-Base) are still \"to be released\". Refs stay with FLUX.2.",
    requires: ZIMAGE_REQUIRES,
    variants: [
      { label: "DiT int8 convrot (shipped)", bytes: 6201001296, note: "int8_convrot is native on Ada. The vendor's int8 template pairs it with an fp8 encoder; this app pairs it with the full bf16 encoder it already has, exactly as the base int8 template does." },
      { label: "DiT bf16", bytes: 12309866400, note: "Twice the download and ~11.5 GB resident on a 16 GB card. What image_z_image_turbo.json loads." },
      { label: "DiT nvfp4", bytes: 4509509600, note: "Smallest, but fp4 tensor cores are Blackwell-only — emulated on this Ada card." },
      { label: "Encoder Qwen3-4B bf16 (shipped, shared with FLUX.2 klein)", bytes: 8044982048 },
      { label: "Encoder Qwen3-4B fp8 mixed", bytes: 5631994051, note: "2.4 GB smaller. Only worth fetching on a machine that does not already hold the bf16 one." },
      { label: "Encoder Qwen3-4B fp4 mixed", bytes: 3479416193, note: "Blackwell-only, like the fp4 DiT." },
      { label: "Turbo distill patch LoRA bf16", bytes: 158826336, note: "Turns the BASE model into the turbo one at load time, for people who only want one 12 GB checkpoint on disk. Not used here — two standalone int8 checkpoints are smaller than one bf16 plus the patch." },
    ],
  },
  {
    id: "imageZImageBase",
    label: "Images — Z-Image base (Apache-2.0)",
    why: "The undistilled sibling: slower, more varied, and the one where a negative prompt actually does something. Same licence, same encoder, same VAE.",
    licence: "Apache-2.0",
    outputRights: ZIMAGE_RIGHTS,
    files: [
      { url: `${HF}/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_int8_convrot.safetensors`,
        dest: M("diffusion_models/z_image_int8_convrot.safetensors"), bytes: 6201001296 },
      ZIMAGE_AE,
      ZIMAGE_ENCODER,
    ],
    note: "6.2 GB on top of Z-Image Turbo — the VAE and the text encoder are shared, so with Turbo installed this is one file. Why it exists beside Turbo: classifier-free guidance was never distilled out of it, so it runs real CFG (4.0) and a real negative prompt, and its publisher rates its diversity MEDIUM against Turbo's LOW — different seeds give genuinely different pictures. The price is steps: 25 against 8, and real CFG means each step is a batch of two — measured at 1024² here, 41 s cold and 23 s warm against Turbo's 21 s and 5.8 s — and it scales cleanly with the step count, 7.2 s at 6 steps. Reach for it when Turbo keeps drawing the same composition, or when you need to say what must NOT be in the frame.",
    requires: ZIMAGE_REQUIRES,
    variants: [
      { label: "DiT int8 convrot (shipped)", bytes: 6201001296, note: "What image_z_image_int8.json loads." },
      { label: "DiT bf16", bytes: 12309866400, note: "Twice the download. What image_z_image.json loads; not measured here." },
    ],
  },
  {
    id: "imageAnima",
    label: "Images — Anima (non-commercial model, sellable pictures)",
    why: "Anime, illustration and stylised art. The two files an Anima checkpoint needs to run — the DiT is whichever one you already have.",
    licence: "CircleStone Labs Non-Commercial v1.2",
    outputRights: ANIMA_RIGHTS,
    files: [ANIMA_ENCODER, ANIMA_VAE],
    note: "1.45 GB, and it is the SMALL half: an Anima DiT is ~4.2 GB and you may already have one — a "
      + "checkpoint whose tensors read `anima` is a merge of this base, and the Images screen will offer it "
      + "once these two are here. What they are: Anima is conditioned by Qwen3-0.6B, NOT the Qwen3-4B this "
      + "app already holds for FLUX.2 klein and Z-Image — different model, no reuse, and picking the 4B "
      + "would fail at the sampler. The VAE is Qwen-Image's, which the vendor blueprint loads even though "
      + "the model class declares a WAN 2.1 latent format. Its own README: 2B parameters, trained on several "
      + "million anime images plus ~800k non-anime artistic ones, anime knowledge to September 2025, no "
      + "synthetic data, and \"will not work well at realism\" — reach for a photographic checkpoint there. "
      + "Sampling is the blueprint's: 30 steps, cfg 4.0, er_sde/simple at 1024².",
    requires: { vramMinGb: 6, vramRecGb: 10, ramMinGb: 16, ramRecGb: 32 },
    variants: [
      { label: "Base DiT anima-base-v1.0 (optional)", bytes: 4182218328,
        note: "The official base, if you have no Anima checkpoint of your own. Not fetched with this entry — "
          + "4.18 GB nobody asked for is not a dependency." },
    ],
  },
  {
    id: "videoLtx",
    label: "Video clips — LTX 2.5 (quantised)",
    why: "Renders a short clip with sound. Much faster than H3 and, here, better.",
    licence: "LTX-2.x Community Licence",

    /* READ FROM THE WEIGHTS THEMSELVES. Lightricks' HF LICENSE 401s like the
     * rest of the repo, but `ltx-2.5-video-vae-conv-bf16.safetensors` carries
     * the ENTIRE agreement in its safetensors `__metadata__.license` — 34,561
     * characters, "LTX-2.x Community License Agreement, License date: August 11,
     * 2026". That is the copy quoted here: a primary text that travels inside
     * the file it governs and cannot be edited out from under us. */
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "Except as set forth herein, Licensor claims no rights in the Output you generate using LTX-2.x.",
      clause: "LTX-2.x Community License Agreement §5 (The Output You Generate)",
      url: "https://huggingface.co/Lightricks/LTX-2.5",
      conditions: [
        "§2.1 — an entity with annual revenue of at least USD 10,000,000 needs a paid Commercial Use Agreement (ltxv-licensing@lightricks.com). Exactly $10M is above the line.",
        "§6 — you must not remove, disable or circumvent the watermarking, metadata, content-provenance or latent-disclosure features, including in Outputs; AI-Act and California-AI-Transparency disclosure duties are yours as the deployer.",
        "Attachment A — the Acceptable Use Policy binds the Outputs as well as the model, and Lightricks may update it.",
      ],
      note: "Studio's own provenance ledger and embedded C2PA-style markers are on the right side of §6 — they add disclosure rather than removing it. §2.1 is about YOUR revenue, not the clip's price: below $10M a year, selling the clip needs nothing from Lightricks.",
    },

    /* 🔴 GATED. Unlike everything else in this catalogue, these files 401 to an
     * anonymous request: Lightricks requires you to accept the licence on the
     * model page and authenticate. The downloader below has no credential path
     * and MUST NOT grow one — a token belongs in the user's own keychain, not in
     * this app's config. `scripts/fetch_ltx25.py` does the fetch instead, reading
     * the token the hf CLI stored, and never printing or copying it.
     *
     * The command here is `hf auth login`, NOT `huggingface-cli login`. The
     * latter is dead as of huggingface_hub 1.x -- it refuses outright rather
     * than warning and continuing -- and this text told people to run it, so
     * the very first step failed with an error that looked nothing like a
     * licence problem. Anyone following it could not get past step one. */
    gated: {
      url: "https://huggingface.co/Lightricks/LTX-2.5",
      how: "Accept the licence on the model page, then in the ComfyUI python environment run `hf auth login` followed by `python scripts/fetch_ltx25.py`. About 40 GB.",
    },

    /* ⚠ DELIBERATELY NO `region` FIELD.
     *
     * This is not H3. The LTX-2.x Community Licence has no Applicable Territory
     * clause, so reusing H3's entry would region-block LTX in the EU, the UK,
     * Korea and the USA for no legal reason at all. Its restrictions are a different
     * shape and belong in `note`: a paid agreement at $10M annual revenue OR
     * MORE (§2.1 — exactly $10M is above the line), and Attachment A §20 forbids
     * use in a product that competes with Lightricks' own offerings. */
    files: [
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`,
        dest: M("diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"), bytes: 21504034224 },
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`,
        dest: M("text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"), bytes: 15372969374 },
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-conv-bf16.safetensors`,
        dest: M("vae/ltx-2.5-video-vae-conv-bf16.safetensors"), bytes: 1452269922 },
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors`,
        dest: M("vae/ltx-2.5-audio-vae-bf16.safetensors"), bytes: 364866540 },
      // Not optional. The whole speed advantage is sampling at half size and
      // upscaling the LATENT — without this there is no second pass.
      { url: `${HF}/Lightricks/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`,
        dest: M("latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"), bytes: 995778752 },
    ],
    note: "39.69 GB. Measured here at 121 s for a 5-second 1280x704 clip with audio — against 308 s for MiniMax H3 at 8 steps and 660 s at 20, and better by eye. The speed is the schedule, not the model: 8 steps at half resolution, a latent upscale, then 3 steps at full size. ⚠ Free below $10M annual revenue; at or above that Lightricks require a paid agreement, and their licence forbids use in a product competing with their own.",
    requires: {
      vramMinGb: 16, vramRecGb: 16, ramMinGb: 32, ramRecGb: 32,
      note: "16 GB is the published minimum and what this was measured on. Community GGUF builds go lower.",
    },
    variants: [
      { label: "DiT distilled int8 convrot (offered)", bytes: 21504034224, note: "4-6 steps by design. int8_convrot is native on Ada; nvfp4 is smaller but emulated." },
      { label: "DiT distilled nvfp4", bytes: 18719999999, note: "2.8 GB smaller, Blackwell only — emulated and slower below compute 10." },
      { label: "DiT distilled bf16", bytes: 42020000000, note: "Twice the download." },
      { label: "DiT dev (not distilled)", bytes: 21500000000, note: "20-30 steps. For training LoRAs, not for generating." },
      { label: "Text encoder Gemma 4 12B int8 convrot (offered)", bytes: 15372969374 },
      { label: "Text encoder bf16", bytes: 26260000000 },
      { label: "Temporal upscaler x2", bytes: 260000000, note: "Not used by the shipped graph; for frame-rate interpolation." },
    ],
  },
  {
    id: "lyrics",
    home: "https://github.com/openai/whisper",   // faster-whisper fetches into its own cache
    label: "Timed lyrics — Whisper large-v3",
    why: "Produces word-level and line-level LRC files for visualisers.",
    licence: "MIT",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: MIT_GRANT,
      clause: "MIT License, grant paragraph (openai/whisper LICENSE)",
      url: "https://github.com/openai/whisper/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " And what this produces is timing for words you already wrote.",
    },
    files: [],                 // fetched by faster-whisper into its own cache
    viaPackage: "faster_whisper",
    approxBytes: 3090000000,
    note: "We already know the words, so this is alignment rather than transcription — the model supplies timing and the known lyrics supply the text. Measured 97.9% of words timed by direct match on a real track.",
    needsPackage: "faster_whisper",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "About 36 s for a 2.5-minute song at int8_float16. Line timing is reliable; word timing is approximate on sung vocals.",
    },
    variants: [
      { label: "large-v3 (shipped)", bytes: 3090000000, note: "Best accuracy on sung vocals." },
      { label: "medium", bytes: 1530000000, note: "Faster, more misheard words — reconciliation fixes the text, not the timing." },
      { label: "base", bytes: 141000000, note: "Fast but unreliable on singing." },
    ],
  },
  {
    id: "interpolate",
    label: "Smooth motion — RIFE 4.26",
    why: "Doubles a clip's frame rate, or turns it into slow motion.",
    licence: "MIT",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: MIT_GRANT,
      clause: "MIT License, grant paragraph (hzwer/Practical-RIFE LICENSE)",
      url: "https://github.com/hzwer/Practical-RIFE/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " Interpolation adds frames to a clip you already have; whatever the clip's own model said still governs it.",
    },
    files: [
      { url: `${HF}/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors`,
        dest: M("frame_interpolation/rife_v4.26.safetensors"), bytes: 22674688 },
    ],
    /* This is the one capability where the best-quality answer and the
     * cheapest-to-install answer are the SAME answer, which is rare enough to
     * say out loud. 22 MB, first-party Comfy-Org repo, core loader. */
    note: "22 MB — the smallest thing in this list by a factor of a thousand. Generated clips are short and their weak point is motion, so this earns its place more than its size suggests. Same model does slow motion: keep the new frames, leave the frame rate alone, and the clip runs at half speed with no stutter.",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Roughly real time on this card. Runs only while nothing is generating.",
    },
    variants: [
      { label: "RIFE 4.26 (shipped)", bytes: 22674688, note: "The default everywhere. Fast and stable." },
      { label: "RIFE 4.26 heavy", bytes: 22908216, note: "Slightly better on fast motion, slightly slower." },
      { label: "RIFE 4.25 lite", bytes: 22506384, note: "For weaker cards." },
      { label: "FILM fp16", bytes: 68882302, note: "Handles very large motion between frames better than RIFE, and is three times the size and slower. Worth it for big camera moves." },
    ],
  },
  {
    id: "upscale",
    label: "Upscale — Real-ESRGAN 2x",
    why: "Enlarges a finished clip or cover without it going soft.",
    licence: "BSD-3-Clause",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: BSD3_GRANT,
      clause: "BSD 3-Clause License, grant paragraph (xinntao/Real-ESRGAN LICENSE)",
      url: "https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE",
      note: PERMISSIVE_NOTE + " Upscaling enlarges a picture you already have; whatever the picture's own model said still governs it.",
    },
    files: [
      { url: `${HF}/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x2.pth`,
        dest: M("upscale_models/RealESRGAN_x2.pth"), bytes: 67061725 },
    ],
    /* ⚠ Stated plainly because it is a real limitation, not a detail.
     *
     * `ImageUpscaleWithModel` loads ESRGAN-architecture weights only, and those
     * models see ONE FRAME AT A TIME. Fine detail invented independently per
     * frame can shimmer between frames — the exact artifact that video-native
     * upscalers (SeedVR2, FlashVSR) exist to prevent. Those need custom node
     * packs, which is why they are not here yet rather than not here at all. */
    note: "Per-frame, so it does not know a clip is a clip: on fine texture the invented detail can shimmer slightly between frames. 2x is the default for that reason as well as for memory — at 4x a 5-second 1280x704 clip becomes 5120x2816 and needs about 20 GB of system RAM to hold. Video-native upscalers that avoid the shimmer entirely need extra ComfyUI nodes; this one works with a stock install.",
    requires: {
      vramMinGb: 4, vramRecGb: 8, ramMinGb: 16, ramRecGb: 32,
      note: "Tiles automatically and backs off on its own if VRAM runs short. System RAM is the real limit, not VRAM — every frame is held at full size.",
    },
    variants: [
      { label: "Real-ESRGAN 2x (shipped)", bytes: 67061725, note: "The safe default. 4x the pixels." },
      { label: "Real-ESRGAN 4x", bytes: 67040989, note: "16x the pixels. Watch system RAM on anything longer than a few seconds." },
      { label: "4x-UltraSharp", bytes: 66961958, note: "A community favourite for stills — crisper than Real-ESRGAN, and that crispness is exactly what shimmers most on video. Good for covers." },
    ],
  },
];

/* ─────────────────────────────────── from a generator name to its rights
 *
 * The ledger records what generated a file (`data.model`), which is an ENGINE
 * name — "flux2", "ltx", "MiniMax-Music3" — not a capability id. This is the
 * one place that bridge is written down, and provenance_test.js pins it against
 * the engine lists in config.js: an engine added there without a line here
 * would stamp every render `unknown` and nobody would notice for months.
 */
export const MODEL_TO_CAPABILITY = {
  "minimax-music3": "engine",
  "flux2": "coverArt",
  "ideogram4": "imageIdeogram",
  // Two engine names, two capabilities, because they are two downloads. Their
  // rights record is the SAME object (ZIMAGE_RIGHTS) — one licence, quoted once.
  "zimage": "imageZImage",
  "zimage-base": "imageZImageBase",
  "h3": "video",
  "ltx": "videoLtx",
};

/**
 * A checkpoint the user dropped into ComfyUI themselves.
 *
 * Studio genuinely cannot answer this one: two SDXL files can be
 * byte-for-byte the same shape and carry opposite terms — Illustrious v1.0
 * permits SaaS outright, NoobAI-XL's card bans "monetization or commercial use
 * of the model, derivative models, or model-generated products", and nothing in
 * either file says which it is. So the app says it does not know, points at the
 * one place the answer lives, and does not gate the export.
 */
export const CHECKPOINT_RIGHTS = Object.freeze({
  class: "unknown",
  sellable: null,
  quote: "",
  clause: "",
  url: "",
  note: "This was rendered by a checkpoint you supplied, so Studio has no licence to read — and SDXL checkpoints differ wildly: some permit commercial use outright, at least one bans selling the pictures themselves. Check the page you downloaded it from. Where a model card and a repo tag disagree, the author's own text governs.",
});

/** Everything an unrecognised generator gets: an honest blank, never a guess. */
const UNRECOGNISED_RIGHTS = Object.freeze({
  class: "unknown", sellable: null, quote: "", clause: "", url: "",
  note: "Studio does not recognise the model this was made with, so it has nothing to read. Nothing is claimed either way.",
});

/** The full rights record for a generator name, or an honest `unknown`. */
/* ── What made this picture ───────────────────────────────────────────────
 * The route, the ledger and imageMeta all record an ENGINE id. "checkpoint" is
 * the one that needs a second field to mean anything, because it names a file
 * the user supplied rather than a model this app ships.
 *
 * One resolver, exported, so the Images screen, the MCP tools and the ledger
 * cannot drift apart — the failure mode a second copy of this table would have
 * is three surfaces disagreeing about what painted a picture, which is exactly
 * the sort of thing nobody notices until a licence question is asked. */
const ENGINE_CAP = {
  flux2: "coverArt",
  zimage: "imageZImage",
  "zimage-base": "imageZImageBase",
  ideogram4: "imageIdeogram",
};

export function modelLabel({ engine, checkpoint } = {}) {
  if (engine === "checkpoint" || (!engine && checkpoint)) {
    return checkpoint
      ? String(checkpoint).replace(/\.(safetensors|ckpt|gguf|pt|pth)$/i, "")
      : "a checkpoint (its name was not recorded)";
  }
  if (!engine) return null;
  const cap = CATALOG.find((c) => c.id === ENGINE_CAP[engine]);
  /* The catalogue label is written for the Models screen and carries a purpose
   * and a licence — "Images — Z-Image Turbo (Apache-2.0)". A tile wants the
   * name alone; the licence has its own home. */
  return cap?.label
    ? cap.label.replace(/^[^—]*—\s*/, "").replace(/\s*\([^)]*\)\s*$/, "")
    : engine;
}

/* Where to read about it — DERIVED from the download URL the catalogue already
 * holds, never written out a second time, so it cannot come to point at the
 * wrong repository. A user's own checkpoint returns null on purpose: this app
 * lists that shelf, it does not curate it, and a guessed Civitai search that
 * lands on the wrong file is worse than no link at all. */
/* Which engine ships this weight file? Matched against the catalogue's own
 * `dest` paths, so a new engine is recognised the moment it is catalogued and
 * this function never needs editing.
 *
 * Restricted to diffusion_models/unet on purpose: the Qwen3-4B text encoder is
 * byte-identical across FLUX.2 klein, Z-Image and Z-Image base and appears in
 * all three entries, so matching on any file would make the shared encoder
 * claim every picture for whichever entry happened to be found first. */
export function engineFromModelFile(fileName) {
  if (!fileName) return null;
  /* Windows and posix separators both, without a regex: the catalogue
   * builds dests with path.join, so they arrive backslashed here. */
  const base = String(fileName).split("\\").join("/").split("/").pop().toLowerCase();
  if (!base) return null;
  for (const [engine, capId] of Object.entries(ENGINE_CAP)) {
    const cap = CATALOG.find((c) => c.id === capId);
    for (const f of cap?.files || []) {
      const dest = String(f.dest || "").split("\\").join("/");
      if (!dest.toLowerCase().includes("/diffusion_models/") && !dest.toLowerCase().includes("/unet/")) continue;
      if (dest.split("/").pop().toLowerCase() === base) return engine;
    }
  }
  return null;
}

export function modelPageUrl({ engine } = {}) {
  const cap = CATALOG.find((c) => c.id === ENGINE_CAP[engine]);
  const u = cap?.files?.[0]?.url;
  const m = typeof u === "string" && u.match(/^(https:\/\/huggingface\.co\/[^/]+\/[^/]+)\//);
  return m ? m[1] : null;
}

export function outputRightsFor(model) {
  const key = String(model ?? "").trim().toLowerCase();
  if (!key) return UNRECOGNISED_RIGHTS;
  if (key === "checkpoint") return CHECKPOINT_RIGHTS;
  const capId = MODEL_TO_CAPABILITY[key];
  const cap = capId && CATALOG.find((c) => c.id === capId);
  return cap?.outputRights || UNRECOGNISED_RIGHTS;
}

/**
 * The small record stamped into a `generate` event (see provenance.js).
 *
 * Class + capability + where the quote came from: enough to reconstruct the
 * claim years later, and small enough that a ledger line stays a ledger line.
 * The verbatim text deliberately does NOT travel — it would put 34 KB of LTX
 * licence in every event, and the catalogue still holds it.
 */
export function rightsStampFor(model) {
  const key = String(model ?? "").trim().toLowerCase();
  const r = outputRightsFor(model);
  return {
    class: r.class,
    capability: (key === "checkpoint" ? null : MODEL_TO_CAPABILITY[key]) || null,
    url: r.url || null,
  };
}

/**
 * Free space on the drive the models live on.
 *
 * Shown next to the download buttons because these are multi-gigabyte files and
 * "12.45 GB to download" is only half the question — the other half is whether
 * it fits. Running out mid-download leaves a `.part` and a confusing error, and
 * the answer was available all along.
 */
export async function diskFree() {
  try {
    const s = await statfs(config.comfyDir);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

/**
 * Is this file on disk AND the right size?
 *
 * `alt` names satisfy the same slot without a size check: they are a DIFFERENT
 * build of the same weights (a local int8 cast, or a variant since pulled from
 * its repo), so there is no byte count to compare against. Without this the
 * catalogue tells a machine that already runs H3 that it is missing 18 GB,
 * which would be both wrong and expensive to believe.
 */
async function filePresent(f) {
  try {
    if ((await stat(f.dest)).size === f.bytes) return true;
  } catch { /* fall through to the alternates */ }
  for (const name of f.alt || []) {
    try {
      if ((await stat(path.join(path.dirname(f.dest), name))).size > 0) return true;
    } catch { /* keep looking */ }
  }
  return false;
}

/** Bytes already fetched, for resume and for progress on a partial file. */
async function fileHave(f) {
  try { return (await stat(f.dest)).size; } catch { return 0; }
}

export class ModelManager extends EventEmitter {
  constructor() {
    super();
    /** id -> { received, total, file, state } */
    this.progress = new Map();
    this.cancelled = new Set();
  }

  /** Catalogue with live presence, for the UI. */
  async status() {
    const out = [];
    for (const cap of CATALOG) {
      const files = await Promise.all(cap.files.map(async (f) => ({
        name: path.basename(f.dest),
        bytes: f.bytes,
        present: await filePresent(f),
        have: await fileHave(f),
      })));
      const totalBytes = cap.files.reduce((s, f) => s + f.bytes, 0) || cap.approxBytes || 0;
      const haveBytes = files.reduce((s, f) => s + (f.present ? f.bytes : f.have), 0);
      out.push({
        id: cap.id,
        label: cap.label,
        why: cap.why,
        licence: cap.licence,
        // May the user sell what this made? The chip on an image's origin row,
        // the line at export and the Thanks table all read THIS — one answer,
        // one source, with the publisher's own sentence attached.
        outputRights: cap.outputRights || null,
        // The publisher's own page, derived from the download URLs. The Thanks
        // page turns each label into a link to it — a credit you cannot follow
        // is only half a credit.
        home: homeFor(cap),
        // Null for every capability but H3. The UI must render this as a
        // blocking acknowledgement, not a footnote — download() rejects without
        // one, so a client that ignores it simply cannot fetch the weights.
        region: cap.region || null,
        // Gated repos cannot be fetched by the built-in downloader at all — the
        // UI must say how to get them rather than offering a button that 401s.
        gated: cap.gated || null,
        note: cap.note,
        required: !!cap.required,
        // What the machine needs, and what else could be used instead. Stated
        // because "4 GB to download" answers a different question from "will it
        // run on my card" — and the second is the one that stops people.
        requires: cap.requires || null,
        variants: cap.variants || null,
        needsPackage: cap.needsPackage || null,
        // A capability with no files of its own (whisper) is reported by whether
        // its python package can be imported, which the server checks separately.
        managedByPackage: !!cap.viaPackage,
        files,
        totalBytes,
        haveBytes,
        ready: cap.files.length > 0 && files.every((f) => f.present),
        downloading: this.progress.has(cap.id),
        progress: this.progress.get(cap.id) || null,
      });
    }
    return out;
  }

  cancel(id) {
    this.cancelled.add(id);
  }

  /**
   * Fetch everything missing for one capability.
   *
   * Resumes with a Range request rather than starting again — these are
   * multi-gigabyte files and a dropped connection three quarters of the way
   * through should not cost the whole download. The partial is written to
   * `.part` and only moved into place once the size matches exactly, so an
   * interrupted run can never leave a truncated file that looks complete.
   */
  async download(id, { acceptRegion = false } = {}) {
    const cap = CATALOG.find((c) => c.id === id);
    if (!cap) throw new Error(`unknown capability: ${id}`);
    /* Enforced at the downloader, not at the button. A region-locked capability
     * cannot be fetched by a client that skipped the warning, by a stale page,
     * or by curl — which is the only version of this that means anything. */
    if (cap.region && !acceptRegion) {
      const e = new Error(`${cap.label} is licensed only outside ${cap.region.excluded.join(", ")}. Confirm you are outside those territories before downloading.`);
      e.needsRegionAck = true;
      e.region = cap.region;
      throw e;
    }
    /* A gated repo needs an accepted licence and a token, and this downloader
     * deliberately has neither. Failing here with instructions beats a 401 that
     * looks like a network error. */
    if (cap.gated) {
      const e = new Error(cap.gated.how);
      e.gated = cap.gated;
      throw e;
    }
    if (this.progress.has(id)) return { alreadyRunning: true };
    if (!cap.files.length) throw new Error(`${cap.label} is fetched by its python package, not by this downloader.`);

    this.cancelled.delete(id);
    const total = cap.files.reduce((s, f) => s + f.bytes, 0);
    let doneBytes = 0;
    for (const f of cap.files) if (await filePresent(f)) doneBytes += f.bytes;

    this.progress.set(id, { received: doneBytes, total, file: null, state: "starting" });
    this.emit("update");

    try {
      for (const f of cap.files) {
        if (this.cancelled.has(id)) throw new Error("cancelled");
        if (await filePresent(f)) continue;
        await this.#one(id, f, () => doneBytes, (n) => { doneBytes = n; });
        doneBytes += f.bytes;
      }
      this.progress.delete(id);
      this.emit("update");
      this.emit("ready", id);
      return { ok: true };
    } catch (err) {
      this.progress.set(id, { received: doneBytes, total, file: null, state: "failed", error: String(err.message || err) });
      this.emit("update");
      // Leave the .part behind on purpose: the next attempt resumes from it.
      setTimeout(() => { if (this.progress.get(id)?.state === "failed") { this.progress.delete(id); this.emit("update"); } }, 15000);
      throw err;
    }
  }

  async #one(id, f, getBase, _setBase) {
    await mkdir(path.dirname(f.dest), { recursive: true });
    const part = `${f.dest}.part`;
    let from = 0;
    try { from = (await stat(part)).size; } catch { /* fresh */ }
    if (from > f.bytes) { await unlink(part).catch(() => {}); from = 0; }

    const res = await fetch(f.url, from ? { headers: { Range: `bytes=${from}-` } } : undefined);
    if (!res.ok && res.status !== 206) throw new Error(`${path.basename(f.dest)}: HTTP ${res.status}`);
    // A server that ignores Range answers 200 with the whole file; restarting is
    // then the only correct thing to do, rather than appending to a partial.
    if (from && res.status !== 206) from = 0;

    const out = createWriteStream(part, { flags: from ? "a" : "w" });
    let received = from;
    const base = getBase();
    for await (const chunk of res.body) {
      if (this.cancelled.has(id)) { out.close(); throw new Error("cancelled"); }
      received += chunk.length;
      out.write(chunk);
      const p = this.progress.get(id);
      if (p) {
        p.received = base + received;
        p.file = path.basename(f.dest);
        p.state = "downloading";
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

    const got = (await stat(part)).size;
    if (got !== f.bytes) {
      throw new Error(`${path.basename(f.dest)}: expected ${f.bytes} bytes, got ${got}`);
    }
    await rename(part, f.dest);
  }
}
