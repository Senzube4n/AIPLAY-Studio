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
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { config, isLightH3 } from "./config.js";
import { folderGroup } from "./localmodels.js";
/* H3's card tiers: the requirement numbers on every H3-family row, and the
 * flag that makes fit.js judge them by tier (server/h3tier.js, no second copy). */
import {
  h3Requires, H3_AMD_NOTE, H3_TIERS, H3_VRAM_FULL_GB, H3_LAB_CARD_GB, H3_RAM_FLOOR_GB, H3_RAM_MEASURED_GB,
} from "./h3tier.js";

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
const M = (p) => path.join(config.modelsDir, p);

/**
 * The card, as first-run setup saved it. Read when asked, not frozen at load,
 * the same test as index.js onAmd().
 *
 * NVFP4 and the other fp4 builds need NVIDIA tensor cores. ROCm and Intel's
 * XPU have no kernel for them, so on those cards a catalogue row names another
 * build of the same file (`amd` on the file entry) and the downloader refuses
 * any fp4 file outright, in case a row ever forgets to.
 */
export const cardIsAmd = () => config.torchBackend === "rocm" || config.gpu?.vendor === "amd";
const noFp4Card = () => cardIsAmd() || config.gpu?.vendor === "intel" || config.torchBackend === "xpu";
export const fp4Blocked = (f) => noFp4Card() && /fp4/i.test(path.basename(String(f?.dest || f?.url || "")));
/** A light machine for H3 (config.js h3Light: an AMD or Intel card, under
 *  16 GB of VRAM or under 32 GB of RAM) takes a file's `light` build. */
export const lightMachine = () => isLightH3(config);
/** A file list with each entry's `light` build swapped in on a light machine
 *  and its `amd` build on an AMD card. */
const forCard = (files) => {
  const light = lightMachine(), amd = cardIsAmd();
  return light || amd ? files.map((f) => (light && f.light) || (amd && f.amd) || f) : files;
};
/**
 * The one shelf that is NOT models/.
 *
 * comfyui_controlnet_aux keeps its weights inside its own clone rather than in
 * the engine's models tree, and that is the only place it looks for them — so a
 * DWPose file written to models/ would be ignored and downloaded again. This
 * helper exists so the fact is stated once, in the same shape as M(), instead
 * of a raw path turning up in a `dest` where it would read as a typo.
 *
 * Writing here is safe rather than a race: the pack's own custom_hf_download()
 * opens with `if not os.path.exists(model_path)`
 * (src/custom_controlnet_aux/util.py:297), so a file already in place is used
 * as it stands and nothing is fetched a second time.
 */
const CK = (p) => path.join(config.comfyDir, "custom_nodes", "comfyui_controlnet_aux", "ckpts", p);

/**
 * The other shelf that is NOT models/ — and deliberately not inside the engine
 * at all.
 *
 * The two mesh rows below are read by `server/mesh/`, which spawns a SEPARATE
 * python and never speaks to ComfyUI. Putting their weights under
 * `ComfyUI/models/` would be a lie told by a folder name: every loader in that
 * tree enumerates its directory and offers what it finds, so a 7 GB
 * image-to-3D transformer would turn up in a checkpoint dropdown that cannot
 * load it. It sits BESIDE the engine rather than in the app-data folder
 * because that is the disk with room — the engine's own weights are there.
 */
const MESH = (p) => path.resolve(config.comfyDir, "..", "models", "3d", p);

/**
 * The third shelf that is not models/ — and, unlike MESH(), not a shelf of our
 * choosing at all: IT IS THE PATH THE LOADER OPENS.
 *
 * The YuE2 row below is read by a python that is not ComfyUI's. MEASURED on
 * this rig 2026-09-11: the render ran under its own interpreter (python 3.10.6,
 * torch 2.10.0+cu130, transformers 4.57.6) and never spoke to the engine at
 * all. So MESH()'s argument applies word for word — every loader under
 * `ComfyUI/models/` enumerates its directory and offers what it finds, and a
 * 7.26 GB music transformer sitting in a checkpoint dropdown that cannot load
 * it is a lie told by a folder name.
 *
 * ⚠ BUT THE EXACT FOLDER IS NOT OURS TO PICK, and that is the whole reason this
 * helper is not `comfyDir/../models/yue2/`. `server/music/yue.js:147-154`
 * resolves the two checkpoints as `config.rig/yue2-kit/models/YuE2-3B` and
 * `…/YuE2-Vae`, and a `dest` anywhere else would write 7.79 GB the loader never
 * opens while leaving the files it needs missing — and this row would report
 * `ready` the whole time. That is not hypothetical: it is the defect the
 * TripoSG row records against itself, where a dest pointed at the repository
 * the weights ORIGINATE in rather than the one its loader reads.
 *
 * The per-model folder inside it is the loader's too — YuE2 resolves
 * `models/<model-name>/model.safetensors`, which is also the path the vendor's
 * own LICENSE names when it scopes CC BY-NC to the weights ("the corresponding
 * models/<model-name>/model.safetensors files in the inference kit"). Both
 * files are called `model.safetensors`, so flattening them into one folder
 * would collide the two downloads and break that scope sentence at once.
 *
 * ⚠ The runner reads `AIPLAY_YUE_MODEL` / `config.yue.model` FIRST and falls
 * back to this path. Anybody who sets either has to move the weights with it:
 * these two lines are one fact kept in two files, which is the arrangement this
 * catalogue exists to avoid, and it is written down here because the other file
 * is not this strand's to edit.
 */
const YUE = (p) => path.join(config.rig, "yue2-kit", "models", p);

/**
 * ⚠ A FILE FACT THAT HAS NOT BEEN MEASURED YET, spelled once so it cannot be
 * mistaken for a number somebody checked.
 *
 * `bytes: 0` is not a guess wearing a fact's clothes. `filePresent()` compares
 * the size on disk EXACTLY and nothing is 0 bytes, so a row carrying this can
 * never report ready — which means `server/mesh/` always refuses with "the
 * weights are not on this machine" instead of spawning a python at a file that
 * is not there. The download button is refused separately, at `awaiting` in
 * download(), because "expected 0 bytes, got 4283000000" reads like corruption
 * rather than like an unfinished catalogue row.
 *
 * `server/mesh/catalogue_test.js` FAILS while any of these remain, and that is
 * the whole point of them: a placeholder that does not fail the build is a
 * placeholder that ships.
 */
const AWAITING_MEASUREMENT = Object.freeze({ bytes: 0, sha256: null });

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
    chip: "Noncommercial (Studio policy)",
    tone: "bad",
    line: "Studio conservatively classifies this output as noncommercial / not for sale. This label does not determine whether every generated output is governed by the weights' licence.",
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
/* CC BY-NC 4.0's grant, quoted once. Every YuE2 row — the Python kit, the GGUF
 * kit, the ComfyUI checkpoint — ships the same m-a-p weights under it, and a
 * rights verdict without the verbatim sentence is not a verdict
 * (provenance_test.js: the GGUF row shipped with quote: ""). */
/* WHAT THE AUTHORS SAID, beside what the licence says. On the model page's
 * discussion "Commercial use of generated audio outputs" a member of the
 * Multimodal Art Projection org answered, verbatim below, that individuals may
 * use the model and its outputs as they like, money included, and that only
 * companies should pay for a commercial licence. It is a discussion comment,
 * not the licence file, which still reads CC BY-NC 4.0 — and the thread's
 * next replies ask whether it is official. So it is shown, sourced and dated.
 *
 * ⚠ SINCE 2026-09-24 STUDIO'S LABEL FOLLOWS IT (owner's decision). YuE2's
 * songs are "sellable by individuals; companies need a commercial licence",
 * which is what the authors wrote, and every surface that shows the label also
 * says the licence file still reads CC BY-NC 4.0. The reading of the file
 * itself is kept, verbatim, in `licenceFile` below and in server/music/yue.js
 * (YUE2_LICENCE_READ), so the day the two are compared again nothing has to
 * be re-read from memory. */
const YUE2_PUBLISHER = {
  said: "If you are individual content creators, musicians, researchers, you can use the model and outputs whatever you want. Even making money from the outputs.\n\nOnly companies should pay for the commercial license.",
  by: "a43992899 (Multimodal Art Projection org)",
  where: "https://huggingface.co/m-a-p/YuE2-3B/discussions/5",
  on: "2026-09-15",
  caveat: "A discussion comment, edited 2026-09-15, not the licence file, which still reads CC BY-NC 4.0; the thread's next replies ask whether it is official and what a company's licence would cover. Studio's label follows this statement (since 2026-09-24) and shows the licence file beside it.",
  support: "https://buymeacoffee.com/ruibin",
};

const YUE2_GRANT = {
  quote: "Subject to the terms and conditions of this Public License, the Licensor hereby grants You a worldwide, royalty-free, non-sublicensable, non-exclusive, irrevocable license to exercise the Licensed Rights in the Licensed Material to: a. reproduce and Share the Licensed Material, in whole or in part, for NonCommercial purposes only; and b. produce, reproduce, and Share Adapted Material for NonCommercial purposes only.",
  clause: "Creative Commons Attribution-NonCommercial 4.0 International §2(a)(1) (Scope — License grant), as shipped with the weights",
  url: "https://huggingface.co/m-a-p/YuE2-3B/blob/main/LICENSE",
};

/**
 * WHAT STUDIO SAYS ABOUT SELLING A YuE2 SONG, from 2026-09-24 (owner's
 * decision): the authors' statement, with the licence file beside it.
 *
 * Every YuE2 row that renders a song carries this one object (musicYue2 and
 * musicYue2Comfy through its getter; musicYue2Gguf with its own note), so the
 * three can never drift. `quote` is the authors' sentence verbatim, because
 * that is now the operative text for the label; `licenceFile` keeps the CC
 * BY-NC 4.0 grant verbatim, because it has not changed and a reader must be
 * able to see both. `changed` says what the label was before and why it
 * moved, so a ledger stamped "not-for-sale" before today is explained rather
 * than contradicted.
 *
 * NOT shared with the add-ons: the Mothersuperior LoRAs and tokenizer are
 * another author's weights, and m-a-p's statement is about YuE2 (see
 * YUE2_LICENCE_FILE_RIGHTS below).
 */
const YUE2_AUTHORS_RIGHTS = {
  class: "yours-with-conditions",
  sellable: true,
  basis: "authors-statement",
  chip: "Sellable by individuals (YuE2 authors' statement, 15 Sep 2026) · companies need a commercial licence",
  short: "sellable by individuals",
  quote: YUE2_PUBLISHER.said,
  clause: "Discussion comment by a43992899 (Multimodal Art Projection org), m-a-p/YuE2-3B discussion #5, 15 Sep 2026",
  url: "https://huggingface.co/m-a-p/YuE2-3B/discussions/5",
  conditions: [
    "Individuals (content creators, musicians, researchers) may use the model and what it makes as they like, money included — the authors' words.",
    "Companies need a commercial licence from the authors.",
  ],
  licenceFile: {
    name: "CC BY-NC 4.0",
    quote: YUE2_GRANT.quote,
    clause: YUE2_GRANT.clause,
    url: YUE2_GRANT.url,
    note: "The licence file shipped with the weights still reads CC BY-NC 4.0.",
  },
  publisher: YUE2_PUBLISHER,
  attribution: "YuE2-3B by Multimodal Art Projection (m-a-p), https://huggingface.co/m-a-p/YuE2-3B. Sellable by individuals (authors' statement, 15 Sep 2026); companies need a commercial licence. Weights licence file: CC BY-NC 4.0.",
  changed: {
    from: "not-for-sale",
    on: "2026-09-24",
    why: "Studio's label now follows the YuE2 authors' statement of 15 Sep 2026.",
  },
  note: "Studio's label follows what the model's authors wrote on the model page on 15 Sep 2026: individuals may sell what it makes, and companies need a commercial licence from them. It is a discussion comment, not the licence file, which still reads CC BY-NC 4.0 and has not changed; a company, or anyone who wants the file's own terms to settle it, should ask the authors. Attribution is required either way.",
};

/**
 * The label the YuE2 add-ons keep: the licence file's, as every YuE2 row read
 * before 2026-09-24. A frozen copy rather than a getter, so the authors'
 * statement about YuE2 does not quietly reach weights that other people
 * trained (Mothersuperior's LoRAs and tokenizer head). Their authors have said
 * nothing about selling, so the conservative reading stands for them.
 */
const YUE2_LICENCE_FILE_RIGHTS = Object.freeze({
  class: "not-for-sale",
  sellable: false,
  ...YUE2_GRANT,
  conditions: Object.freeze([
    "§3(a)(1) — if you Share the weights, modified or not, you must keep the creator identification, the copyright notice, the notices referring to this licence and to its disclaimer of warranties, and a link to the material, and indicate whether you changed it. Studio Shares nothing: the download goes straight to m-a-p and the licence is between you and them.",
    "Scope — the vendor's LICENSE applies CC BY-NC to the checkpoint weights only. What you may do with the inference CODE is the Apache-2.0 answer and a different question from what you may do with a song.",
  ]),
  note: "The weights are licensed for noncommercial use. Studio conservatively labels results noncommercial / not for sale; this is not a legal determination that every output inherits the checkpoint licence. Native runtime/code licences do not expand the rights granted for the weights. Review the publisher terms for your intended use.",
});

/* H3's text encoder and two VAEs. FastH3 loads the same three, so both rows
 * name the same files and a machine holding one engine fetches only the other
 * engine's DiT. */
const H3_SHARED_FILES = [
  /* THE int4 TEXT ENCODER ON EVERY CARD. AMD used to fetch the official
   * int8 (27.1 GB) on the belief that ROCm ran int4 on a slow fallback.
   * Measured 2026-09-25 on an RX 9060 XT: int4 was a little faster (299 s
   * against 316 s a clip), staged 13.5 GB instead of 25.9 and looked as good.
   * An int8 already on disk still counts (the alt). Revision and sha256 as
   * HuggingFace lists them. */
  { url: `${HF}/Winnougan/MiniMax-H3-INT4_Convrot_ComfyUI/resolve/6387f8cd370fd8b4deaa9aa7e9e1be4d7298e7df/qwen3vl_32b_minimax_h3-int4_convrot.safetensors`,
    dest: M("text_encoders/qwen3vl_32b_minimax_h3-int4_convrot.safetensors"), bytes: 14173709116,
    sha256: "a97a557136057a8bcf6f2459b0875aeee3e8274408bd6616b669b41caefdb48d",
    alt: ["qwen3vl_32b_minimax_h3_int8_convrot.safetensors"] },
  /* ⚠ STILL THE fp16 VIDEO VAE, although config.js loads the int8 one first
   * when it is present (a912a39: about 12% a clip). Checked 2026-09-24: the
   * rig's int8 file is 3,171,670,912 bytes, dated 2026-08-17, a month before
   * any official one existed (the 08-17 hunt cast its VAEs locally; see the H3
   * row's OFFICIAL FILES note). Comfy-Org published an int8 under the SAME name
   * on 2026-09-15 (revision 7a2065e37f5f, 2,811,065,184 bytes, sha256
   * 52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e): a
   * different file, never rendered here. So the 12% and the quality check
   * belong to a file nobody can download, and new installs keep the fp16 until
   * one clip is rendered with the published int8. It is listed under the H3
   * row's other builds meanwhile. */
  { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors`,
    dest: M("vae/minimax_h3_video_vae_fp16.safetensors"), bytes: 5207808496,
    alt: ["minimax_h3_video_vae_int8_convrot.safetensors"],
    /* A light machine (config.js h3Light) fetches the published int8:
     * rendered 2026-09-25 on an RX 9060 XT against the fp16, same seed:
     * frames PSNR 35.8 dB / SSIM 0.975, decode ~15 s faster, 2.7 GB staged
     * instead of 5. */
    light: { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/bf92c4091e333e69b8ca1998e0a669f15cb0832b/vae/minimax_h3_video_vae_int8_convrot.safetensors`,
      dest: M("vae/minimax_h3_video_vae_int8_convrot.safetensors"), bytes: 2811065184,
      sha256: "52a2c8c73583c86e4f41cdcce3a6ad0ea562987bc0bf3d60a0cef5f5c8e60c0e",
      alt: ["minimax_h3_video_vae_fp16.safetensors"] } },
  { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors`,
    dest: M("vae/minimax_h3_audio_vae_fp32.safetensors"), bytes: 605254808,
    alt: ["minimax_h3_audio_vae_bf16.safetensors"] },
];

export const CATALOG = [
  {
    id: "engine",
    label: "Music engine — MiniMax Music 3",
    /* Not "Required." any more: this sentence sits on the card whatever engine
     * is selected, and on a YuE2 install it told a newcomer to fetch 11.92 GB
     * they will never render with. Whether it IS required is markRequired()'s
     * answer, shown as the badge. No music engine's sentence says "required" or
     * "optional" at all: the badge is the one place that answer lives, and
     * models-screen_test.js reads every music row's `why` for either word. */
    why: "Writes and renders the music. Studio needs one music engine, the one picked in the music model list, not every one.",
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
    /* THE CATALOGUE'S DEFAULT, not this install's need. It marks the engine
     * config.js starts on (minimax-music3), and fit.js and the docs read it as
     * exactly that; the welcome panels fall back to it only when the selected
     * engine names no row. What the Models screen badges is markRequired(): the
     * SELECTED music engine once it is ready, "one music engine" before. */
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
    id: "musicYue2Gguf",
    label: "Music engine — YuE2 GGUF Q4 / optional Q8 (experimental)",
    why: "Make music without ComfyUI, Python, MiniMax, or image/video models, on NVIDIA, AMD, Intel or the CPU: setup fetches the audio.cpp build that fits this machine. Choose one precision in the native setup panel; one is enough.",
    nativeSetup: true,
    required: false,
    licence: "CC BY-NC 4.0 (weights) · Apache-2.0/MIT (native code) · NVIDIA CUDA runtime terms on NVIDIA only",
    files: [],
    approxBytes: 2933414997,
    variants: [
      {label:"Q4_0 (default)",bytes:2933414997,note:"Smaller native transformer plus shared F16 VAE and sidecars. Runtime is additional."},
      {label:"Q8_0 (optional)",bytes:4531969109,note:"Larger native transformer plus the same decoder and sidecars. Quality, speed and VRAM have not been benchmarked; not a promise of better audio."},
    ],
    home: "https://huggingface.co/audio-cpp/Yue2-3B-GGUF",
    /* The same weights as musicYue2, so the same label (the authors'
     * statement); only the note differs, because this row also ships native
     * code under its own licences. */
    outputRights: {
      ...YUE2_AUTHORS_RIGHTS,
      note: "Model weights and native code have different licences. The native audio.cpp code (Apache-2.0/MIT) neither widens nor narrows what the weights allow. Studio's label for the songs follows the YuE2 authors' statement of 15 Sep 2026 (individuals may sell; companies need a commercial licence); the weights' licence file still reads CC BY-NC 4.0. Attribution is required either way.",
    },
    requires: {experimental:true,vramMinGb:null,vramRecGb:null,ramMinGb:null,ramRecGb:null,
      note:"Windows x64. NVIDIA: CUDA 13.3-compatible driver and Microsoft VC14 x64 runtime. AMD and Intel: the official audio.cpp Vulkan build, which needs only a current graphics driver; no card: the CPU build (slow). Vulkan and CPU speed and memory are not measured here. Q4 only, CUDA: one 49.4-second song tested on RTX 4070 Ti SUPER 16 GB: 22 s render, entire-device sampled peak 6,589 MiB including 3,129 MiB baseline. This is not process memory or proof of 6/8/12 GB support. Q8 has not been benchmarked; longer songs and smaller GPUs remain unverified."},
    note: "Choose Q4_0 (2.93 GB kit) or optional Q8_0 (4.53 GB kit), each with the shared F16 VAE and four sidecars. The setup panel also quotes the native runtime download. Existing verified shared files are reused and the other precision is preserved. Q8 has no measured quality/VRAM advantage. Explicit terms review, verified resumable downloads, no other models. Requires lyrics; no reference audio, preview, instrumental toggle or guaranteed duration.",
  },
  {
    /* SHEETSAGE2, AS COMFYUI'S OWN AUDIO ENCODER — the transcriber behind the
     * cover recipe: a finished song becomes the planner's two-voice score,
     * and YuE2 re-renders it from scratch under a new style line. Core nodes
     * from ComfyUI 0.35 (AudioEncoderLoader → SheetSage2AudioToABC); the file
     * is the bf16 repack in Comfy-Org/YuE2, read off the HuggingFace API on
     * 2026-09-17 (revision pinned below, not gated, license cc-by-nc-4.0,
     * size and LFS sha256 as written). Nothing here renders audio: the score
     * it writes goes through the YuE2 rows, whose rights apply to the song. */
    id: "coverSheetSage2",
    label: "Cover — SheetSage2 song-to-score (ComfyUI)",
    why: "Turn a finished recording into the score YuE2 sings from, so a song can be covered under a new style — a different voice, a different arrangement — with the melody kept. Melody-only mode is the one to use for covers; full mode keeps the chords too.",
    licence: "CC BY-NC 4.0 (weights) — run by ComfyUI's built-in SheetSage2 node",
    home: "https://huggingface.co/m-a-p/SheetSage2",
    outputRights: {
      class: "not-for-sale", sellable: false,
      quote: "Subject to the terms and conditions of this Public License, the Licensor hereby grants You a worldwide, royalty-free, non-sublicensable, non-exclusive, irrevocable license to exercise the Licensed Rights in the Licensed Material to: a. reproduce and Share the Licensed Material, in whole or in part, for NonCommercial purposes only; and b. produce, reproduce, and Share Adapted Material for NonCommercial purposes only.",
      clause: "Creative Commons Attribution-NonCommercial 4.0 International §2(a)(1) (Scope — License grant), as shipped with the weights",
      url: "https://huggingface.co/m-a-p/SheetSage2/blob/main/LICENSE",
      conditions: [
        "The score is a transcription of a recording you supply. That recording's own rights are yours to check before you cover it; nothing here changes who wrote the song.",
      ],
      note: "A score, not a song: what you can do with the cover is decided by the YuE2 row that renders it and by the original song's rights. Studio keeps a conservative noncommercial label on the transcriber's own weights.",
    },
    required: false,
    files: [
      { url: `${HF}/Comfy-Org/YuE2/resolve/8e6fcf0f23252ed188b634bd50d44f4b01fba890/audio_encoders/sheetsage2_bf16.safetensors`,
        dest: M("audio_encoders/sheetsage2_bf16.safetensors"),
        bytes: 1_386_868_122,
        sha256: "5fd960ce3df281e3f3a889d174584d88f96247711480cf96377b12d7e8b6adc5" },
    ],
    note: "1.39 GB, one file in models/audio_encoders. Transcribes a whole mixed song (a hummed line has its own model-free path). Needs ComfyUI 0.35 or newer. ⚠ CC BY-NC: you may not sell what this makes.",
    requires: {
      vramMinGb: 4, vramRecGb: 8, ramMinGb: 8, ramRecGb: 16,
      note: "Not yet measured here; the publisher benchmarks bf16 inference on datacenter cards and gives no consumer figure.",
    },
  },
  {
    /* TAOMATE 3-STEP — TaoLiveAIGC's 3-step distillation of H3 (rank 128,
     * trained on the FL2VA weights), in Robert1212star's ComfyUI conversion:
     * no training, merging or pruning beyond the key layout. Read off
     * HuggingFace 2026-09-17 (revision pinned, LFS sha256 as written; the
     * first fetch here matched it). Loads at or below turbo3MaxSteps (3) on
     * the first-last-frame path only — h3TurboLoraFor(); the reference path
     * keeps its own builds. MEASURED 2026-09-17, 2 s at 1344x768: 105 s
     * warm against the 4-step build's 135 s, deterministic across runs,
     * clean at the base shift 12/3. Its card publishes no shift. */
    id: "videoH3Turbo3",
    label: "Video clips — TaoMate 3-step LoRA (H3)",
    why: "The fastest H3 render: three sampling steps on the first-last-frame path, measured 105 s for two seconds at native size where the 4-step build takes 135 s. Same seed gives a different picture than the 4-step build — a different distillation, not a faster copy of it.",
    licence: "MiniMax H3 Community Licence (derived from H3)",
    home: "https://huggingface.co/Robert1212star/TaoMate-H3-3Step-ComfyUI",
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property); the LoRA is a derivative of H3 and its card names that licence",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip made with this LoRA is an H3 output and carries the same limit.",
      ],
      note: "A distillation on H3's weights, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    required: false,
    addonFor: "video",
    /* Turns on the Video screen's Fast setting for H3 (fit.js recommendFor).
     * Not `newInstalls`: the rank-19 row below is what a new install gets.
     * `fastNote` is the plain sentence the recommendation shows. */
    fastPathFor: "video",
    fastNote: "Measured 2026-09-24: the same picture and speed as the 182 MB file new installs get.",
    files: [
      { url: `${HF}/Robert1212star/TaoMate-H3-3Step-ComfyUI/resolve/6897eea8f92ca8a1d511612dbf3ea51a63399cc4/taomate_h3_3step_comfy.safetensors`,
        dest: M("loras/taomate_h3_3step_comfy.safetensors"),
        bytes: 2_481_007_456,
        sha256: "c1c057121a5ebf77d708b8a5c331ebb78416b90775df465c02a4fa48688315cb",
        alt: ["minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors"] },
    ],
    note: "2.48 GB, one file in models/loras. The 3-step build threshold in the Video panel decides when it loads. Its shift is unmeasured: the base 12/3 rendered clean here. "
      + "Measured 2026-09-24 against Kijai's 182 MB rank-19 average of the same LoRA (the next row), on a 16 GB card at 1344x768, 8 s: the same speed (119.1 s against 120.0 s in the sampler) and, by two judges, the same picture. "
      + "Either file turns on Fast; new installs are offered the small one, and it counts as present here. With both on disk this one loads first.",
    requires: h3Requires("The same H3 render, three steps of it."),
  },
  {
    id: "videoH3FunControl",
    label: "Video clips \u2014 video-to-video control (H3 Fun ControlNet)",
    why: "Drive a render with a WHOLE VIDEO instead of one opening picture: depth, canny, pose, HED or MLSD "
      + "taken off your footage steers H3 frame by frame, so a live-action take can be re-rendered in another "
      + "style while its motion and blocking are kept. The union patch carries all five controls in one file.",
    licence: "MiniMax H3 Community Licence (a patch on H3's weights)",
    home: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    /* Identical to the H3 rows above, deliberately: a patch cannot be freer
     * than the weights it patches, and a reader should not have to cross-check
     * two pages to learn that. */
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "A patch on MiniMax H3, so its Community Licence applies unchanged: rights only inside the Applicable "
        + "Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. "
        + "MiniMax's hosted API is available everywhere; it is running the open weights locally that is limited. "
        + "The download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible "
        + "for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement \u00a7VI.4 (Intellectual Property); this patch is a derivative of H3",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "\u00a7V.4 \u2014 the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip driven by this patch is an H3 output and carries the same limit.",
        "The footage you drive it WITH is your own affair: a control video you do not hold the rights to does not become yours by being re-rendered.",
      ],
      note: "A patch on H3's weights, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    required: false,
    /* The int8-convrot conversion rather than the 4.22 GB bf16: this rig's H3
     * is already an int8 convrot build, so the quantisations match and the
     * smaller file is the one that fits beside it. The bf16 is the alt. */
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/7e75982b97cd5a41d2dcfa1904ee88d0686d6fd1/model_patches/minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors`,
        dest: M("model_patches/minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors"),
        bytes: 2_296_635_360,
        sha256: "9c645c0a308c8af361efd43b409710f6f8fec0db297c29503e141a84991fed0c",
        alt: ["minimax_h3_fun_controlnet_union_pruned_bf16.safetensors"] },
    ],
    note: "2.3 GB, one file in models/model_patches, loaded by ModelPatchLoader and applied by "
      + "MiniMaxH3FunControlNetApply. Needs ComfyUI 0.35 or newer \u2014 this rig runs 0.36. The 4.22 GB bf16 "
      + "conversion of the same patch counts as present if you already have it.",
    /* NOT h3Requires(): a control video riding along with H3 was never run at
     * a smaller size, so this row keeps full size's floor while H3 itself
     * offers a smaller size on 8 to 11 GB cards, and says why. The numbers are
     * h3tier.js's own (full size, the lab's card, the RAM floor, the RAM the
     * lab measured with), so they move with H3's. */
    requires: { vramMinGb: H3_VRAM_FULL_GB, vramRecGb: H3_LAB_CARD_GB, ramMinGb: H3_RAM_FLOOR_GB, ramRecGb: H3_RAM_MEASURED_GB,
                note: "The same H3 render with a control video alongside it; the patch is resident for the whole pass. "
                  + `Stays at ${H3_VRAM_FULL_GB} GB although H3 itself offers ${H3_TIERS[1].width}x${H3_TIERS[1].height} on `
                  + `${H3_TIERS[1].minGb} to ${H3_VRAM_FULL_GB - 1} GB cards: a control video riding along has not been measured at the smaller size.` },
  },

  {
    id: "videoH3Turbo3Small",
    label: "Video clips — Fast setting for H3 (TaoMate 3-step, 182 MB)",
    why: "The same 3-step distillation averaged down to rank 19 by Kijai: 182 MB instead of 2.48 GB. Measured 2026-09-24 against the full conversion on a 16 GB card at 1344x768, 8 s: the same speed (120.0 s against 119.1 s in the sampler) and, by two judges, the same picture; only small textures differ. It did not save RAM.",
    licence: "MiniMax H3 Community Licence (derived from H3)",
    home: "https://huggingface.co/Kijai/MiniMax-H3_comfy",
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property); a derivative of H3",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip made with this LoRA is an H3 output and carries the same limit.",
      ],
      note: "A distillation on H3's weights, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    required: false,
    addonFor: "video",
    /* Turns on the Video screen's Fast setting for H3, and it is the one NEW
     * installs are recommended (fit.js recommendFor): same speed and picture
     * as the 2.48 GB conversion, 2.30 GB less to fetch (lab, 2026-09-24).
     * config.js's pick order is left alone; both give the same picture. */
    fastPathFor: "video",
    newInstalls: true,
    fastNote: "Measured 2026-09-24: the same picture and speed as the 2.48 GB TaoMate file, in a 182 MB download.",
    files: [
      { url: `${HF}/Kijai/MiniMax-H3_comfy/resolve/098f8c48fccead9a93191c166ca31a130659d3bd/loras/minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors`,
        dest: M("loras/minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors"),
        bytes: 181_697_688,
        sha256: "de9663d974a884b477556748239c6f28239f7ca1825be270f98f023ff5dab6a7" },
    ],
    note: "182 MB, one file in models/loras. The one new installs are offered for the Fast setting. Loaded by the 3-step path when the full conversion is absent (config turboLora3 order); with both on disk the full one loads, which gives the same picture.",
    requires: h3Requires("The same H3 render, three steps of it."),
  },
  {
    /* H3'S 4-STEP SPEED-UP, an optional add-on (addonFor "video"): the
     * Video screen's 4-step renders need it, and nothing else does.
     * Read off HuggingFace 2026-09-24 (Comfy-Org/MiniMax-H3, revision pinned,
     * LFS sha256 and size as listed there). */
    id: "videoH3Turbo4",
    label: "Video clips — 4-step speed-up for H3 (1.96 GB)",
    why: "Four-step H3 renders: the Video screen's Standard setting on a disk without the 8-step file. Full-rank on purpose: the 440 MB resized-rank one has two independent reports of camera-movement and prompt-following damage.",
    licence: "MiniMax H3 Community Licence (derived from H3)",
    home: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property); a derivative of H3",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip made with this LoRA is an H3 output and carries the same limit.",
      ],
      note: "A distillation on H3's weights, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    required: false,
    addonFor: "video",
    stepsFor: 4,
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/bf92c4091e333e69b8ca1998e0a669f15cb0832b/loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors`,
        dest: M("loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"),
        bytes: 1_956_192_992,
        sha256: "c396a9a06f58399e9df9754b18299818d84a2ddd371724ba48fe4a41221437dc" },
    ],
    note: "1.96 GB, one file in models/loras. Optional: without it, 4 and 5 steps are refused with this download offered, and H3 still renders at 3 (TaoMate), 8 (the 8-step file) or 20 steps.",
    requires: h3Requires("The same H3 render, 4 steps of it."),
  },
  {
    /* H3'S 8-STEP SPEED-UP, an optional add-on (addonFor "video"): the
     * Video screen's 8-step renders need it, and nothing else does.
     * Read off HuggingFace 2026-09-24 (Comfy-Org/MiniMax-H3, revision pinned,
     * LFS sha256 and size as listed there). */
    id: "videoH3Turbo8",
    label: "Video clips — 8-step speed-up for H3 (1.96 GB)",
    why: "Eight-step H3 renders, the Video screen's Standard setting when it is on disk: the build config.js prefers for 6 to 12 steps.",
    licence: "MiniMax H3 Community Licence (derived from H3)",
    home: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property); a derivative of H3",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip made with this LoRA is an H3 output and carries the same limit.",
      ],
      note: "A distillation on H3's weights, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    required: false,
    addonFor: "video",
    stepsFor: 8,
    files: [
      { url: `${HF}/Comfy-Org/MiniMax-H3/resolve/bf92c4091e333e69b8ca1998e0a669f15cb0832b/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`,
        dest: M("loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"),
        bytes: 1_956_193_000,
        sha256: "2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e" },
    ],
    note: "1.96 GB, one file in models/loras. Optional: without it, 6 to 12 steps are refused with this download offered, and H3 still renders at 3 (TaoMate), 4 (the 4-step file) or 20 steps.",
    requires: h3Requires("The same H3 render, 8 steps of it."),
  },
  {
    /* CONDITIONING BRIDGES FOR H3 — two 5120→h→h→5120 MLPs that rewrite the
     * text conditioning before the transformer, run by the Studio's own node
     * (server/comfy_nodes/aiplay_h3_bridge.py). Read off HuggingFace
     * 2026-09-17: BUNNY publishes no checksum (the sha256 below is of the
     * bytes fetched that day); the Semantic Bridge's matches its SHA256SUMS.
     * Both derive from H3 and say so: the H3 Community Licence and its
     * territory clause apply, so the H3 rights block is repeated here. */
    id: "bridgeBunny",
    group: "video",   // Models screen section: feeds the video / Motion look path, not music
    label: "H3 conditioning bridge — BUNNY (action logic)",
    why: "Helps H3 keep who-does-what-to-whom straight in multi-character action shots: attacker and target, which hand holds what, identity after a pass behind something. Off by default; the Video panel's Conditioning bridge setting turns it on.",
    licence: "MiniMax H3 Community Licence (derived from H3)",
    home: "https://huggingface.co/JOKER141/BUNNY_H3_Conditioning_Bridge",
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property), which the adapter's card adopts for itself",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip made with this adapter is an H3 output and carries the same limit.",
        "The adapter's author reports, from their own tests and not a benchmark, about 6 in 10 renders improved, 2 unchanged, 1 worse.",
      ],
      note: "An adapter on H3's words, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    required: false,
    files: [
      { url: `${HF}/JOKER141/BUNNY_H3_Conditioning_Bridge/resolve/main/BUNNY_H3_ActionLogic_Bridge_V1.safetensors`,
        dest: M("conditioning_bridges/BUNNY_H3_ActionLogic_Bridge_V1.safetensors"),
        bytes: 22_045_536,
        sha256: "983380be6bf790544dbfa9be1bbe42e60ea841c7b6f7c5aac668de9380ab277a" },
    ],
    note: "22 MB, one file in models/conditioning_bridges. Trained against SenseNova U1.5 as a semantic teacher on 576 pairs; hidden width 512. Not validated on the reference path (the original bridge measured singing worse there).",
    requires: { vramMinGb: 0, vramRecGb: 0, ramMinGb: 0, ramRecGb: 0, note: "Negligible: a 22 MB MLP run once per render on the text conditioning." },
  },
  {
    id: "bridgeSemantic",
    group: "video",   // Models screen section: feeds the video / Motion look path, not music
    label: "H3 conditioning bridge — Semantic Bridge v1",
    why: "The original bridge: composition, spatial relations, counting, materials and lighting, reflections, transparency, hand state. The one to try when a shot's layout or object count keeps drifting.",
    licence: "MiniMax H3 Community Licence (derived from H3)",
    home: "https://huggingface.co/speach1sdef178/MiniMax-H3-Semantic-Bridge",
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. The download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property), which the repository's LICENSE.md adopts for its model-derived artifacts",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip made with this adapter is an H3 output and carries the same limit.",
        "Its card: an experimental adapter, inconsistent across prompts, no human-preference benchmark; the reference path (Ref2VA) measured worse for singing and lip-sync.",
      ],
      note: "An adapter on H3's words, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    required: false,
    files: [
      { url: `${HF}/speach1sdef178/MiniMax-H3-Semantic-Bridge/resolve/main/MiniMaxH3_SemanticBridge_v1.safetensors`,
        dest: M("conditioning_bridges/MiniMaxH3_SemanticBridge_v1.safetensors"),
        bytes: 11_023_032,
        sha256: "ac0dc8ac05f545ebdee12e2fcebe4515b049f9cfd9558eb4887a9bf3fd6d562e" },
    ],
    note: "11 MB, one file in models/conditioning_bridges. Distilled from SenseNova U1.5 on 500 prompts on a single 3090 Ti; hidden width 256. Representation-space cosine to the teacher 0.996 — which the author says is not a video-quality figure.",
    requires: { vramMinGb: 0, vramRecGb: 0, ramMinGb: 0, ramRecGb: 0, note: "Negligible: an 11 MB MLP run once per render on the text conditioning." },
  },
  {
    /* YuE2 FOR COMFYUI'S OWN NODES — the build Studio's `yue2-comfy` engine
     * loads — the small YuE2 that runs inside ComfyUI on an AMD card.
     *
     * Added 2026-09-16, when the native GGUF kit was CUDA-only (its files are
     * packed for audio.cpp, and ComfyUI-GGUF refuses every audio architecture).
     * Since 2026-09-18 the native kit also installs audio.cpp's Vulkan build on
     * AMD and Intel, so this is the ComfyUI route, no longer the only one. Comfy-Org publishes this int8 build instead, read off
     * the HuggingFace API that day (repo Comfy-Org/YuE2, revision pinned below,
     * not gated, `license: cc-by-nc-4.0`, size and LFS sha256 as written).
     *
     * `alt` makes a bf16 build count: ComfyUI loads either, so somebody who
     * already has yue2_3b_bf16.safetensors must not be told to download this. */
    id: "musicYue2Comfy",
    label: "Music engine — YuE2 3B for ComfyUI (int8)",
    why: "YuE2 through ComfyUI's own YuE2 nodes: the small 3.96 GB build. Works on NVIDIA and AMD, needs no Python kit and no native runtime. Already have yue2_3b_bf16? Then you have this engine and do not need the download.",
    licence: "CC BY-NC 4.0 (weights) — run by ComfyUI's built-in YuE2 nodes",
    /* The same weights under the same licence as the row below, so the same
     * rights verdict — read from that row at access time rather than retyped,
     * so the two can never disagree. */
    get outputRights() { return CATALOG.find((c) => c.id === "musicYue2")?.outputRights; },
    required: false,
    files: [
      { url: `${HF}/Comfy-Org/YuE2/resolve/8e6fcf0f23252ed188b634bd50d44f4b01fba890/checkpoints/yue2_3b_int8_convrot.safetensors`,
        dest: M("checkpoints/yue2_3b_int8_convrot.safetensors"),
        alt: ["yue2_3b_bf16.safetensors"],
        bytes: 3_960_938_800,
        sha256: "96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6" },
    ],
    note: "3.96 GB, one checkpoint file in models/checkpoints. The bf16 build (7.8 GB) renders a 30-second song in about 24 s warm on a 16 GB RX 9060 XT (measured 2026-09-16); the int8 build's speed and quality on AMD are not yet measured here. Selling: the YuE2 authors say individuals may sell what it makes and companies need a commercial licence (15 Sep 2026); the licence file still reads CC BY-NC 4.0.",
    requires: {
      vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Not yet measured for the int8 build. ComfyUI stages the 3B language model and the audio model with dynamic VRAM, so a smaller card streams more from system RAM and is slower rather than refused.",
    },
  },
  {
    /* THE INSTRUMENTAL PLANNER — a LoRA on YuE2's autoregressive composer (the
     * half ComfyUI holds as CLIP), published by Mothersuperior 2026-09 and
     * trained on ~2,700 instrumental tracks paired with SheetSage2 scores,
     * with a section-cursor loss and END up-weighted: the planner writes an
     * instrumental with a section plan and, by its card, ended on its own 8
     * times out of 9 where the stock model runs on. It is the answer to a
     * problem this app documents (yue2-instrumental-is-a-dice-roll: YuE2 has
     * no instrumental flag and plans a vocal staff anyway). Loads through
     * buildYue2ComfyGraph's planner door (LoraLoader on the clip wire); an
     * Instrumental take on yue2-comfy picks it by itself when it is here.
     *
     * Read off the HuggingFace API 2026-09-20 (repo
     * Mothersuperior/YuE2-instrumental-cot-full-loras, revision pinned below,
     * not gated, `license: cc-by-nc-4.0`, size and LFS sha256 as written). The
     * ComfyUI-native file (fused qkv / gate_up keys) is the one the stock
     * loader reads; the diffusers-layout twins are not listed. */
    id: "musicYue2InstrumentalLora",
    label: "YuE2 instrumental planner LoRA (ComfyUI)",
    why: "YuE2 through ComfyUI writes a real instrumental — sectioned, and ending on purpose — instead of planning a vocal staff and singing at random. Patches the composer only; the audio model stays the checkpoint's.",
    licence: "CC BY-NC 4.0 (weights, derived from YuE2-3B) — run by ComfyUI's own LoRA loader",
    /* Detached from musicYue2's getter on 2026-09-24: that row now follows
     * m-a-p's statement about YuE2, and these are another author's weights. */
    outputRights: YUE2_LICENCE_FILE_RIGHTS,
    required: false,
    files: [
      { url: `${HF}/Mothersuperior/YuE2-instrumental-cot-full-loras/resolve/947f2f4b28978b2b6c3e316e6a87925c76bf3c4b/ar_lora_inst_v3abc_comfyui.safetensors`,
        dest: M("loras/ar_lora_inst_v3abc_comfyui.safetensors"),
        bytes: 212_891_736,
        sha256: "de6a11d5701df103a191c87dc73115266e2420f3834739319dec5c24d2119f31" },
    ],
    note: "213 MB, one file in models/loras. Needs the YuE2 checkpoint for ComfyUI. Its card asks for generate mode full with the score plan on and a sheet of [instrumental] or [section] tags only, which the Instrumental switch does by itself; strength 1. Pairs with the real-audio NAR LoRA below for production audio, by the author. ⚠ CC BY-NC: you may not sell what this makes.",
    requires: {
      vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Adds 213 MB to the YuE2 checkpoint's own footprint; not separately measured here.",
    },
  },
  {
    /* THE REAL-AUDIO NAR LoRA — the rank-32 adapter on YuE2's acoustic model
     * that the real-audio tokenizer (next row) was trained jointly with:
     * it renders the tokenizer's near-miss codes the way the real recording
     * sounded. The author pairs it with the instrumental planner above for
     * production audio. Loads through the existing audio LoRA door
     * (LoraLoaderModelOnly). Same repository, revision and reading as the
     * tokenizer row. */
    id: "musicYue2RealAudioNarLora",
    label: "YuE2 real-audio NAR LoRA (ComfyUI)",
    why: "The acoustic model adapted to real recordings' tokens — the other half of the real-audio tokenizer, and the author's companion to the instrumental planner for production sound.",
    licence: "CC BY-NC 4.0 (weights, derived from YuE2-3B) — run by ComfyUI's own LoRA loader",
    /* Detached from musicYue2's getter on 2026-09-24: that row now follows
     * m-a-p's statement about YuE2, and these are another author's weights. */
    outputRights: YUE2_LICENCE_FILE_RIGHTS,
    required: false,
    files: [
      { url: `${HF}/Mothersuperior/yue2-mothersuperior-realaudio-tokenizer-v4/resolve/e2e63d859f3af879baf1b4d4e9f22d1eeda6fde5/nar_lora_joint_v4_comfyui.safetensors`,
        dest: M("loras/nar_lora_joint_v4_comfyui.safetensors"),
        bytes: 107_518_808,
        sha256: "f97aac7c9628d8ea7a157b0659ddc88dcbf9b2a726afa39c8231788e0e20dfc6" },
    ],
    note: "108 MB, one file in models/loras; the audio LoRA picker on the Music tab, strength 1. v4 is the pair the author documents; v5/v8/v9 twins exist upstream and are not catalogued. ⚠ CC BY-NC: you may not sell what this makes.",
    requires: {
      vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Adds 108 MB to the YuE2 checkpoint's own footprint; not separately measured here.",
    },
  },
  {
    /* THE REAL-AUDIO TOKENIZER — audio back into YuE2's own semantic codes,
     * which the model's authors never published an encoder for. Two pieces:
     * Mothersuperior's head (MERT-v2-FullSong layer-20 features at 25 Hz,
     * instance-normalised per track, through an 8-layer transformer d=512 to
     * the 32,768 codes; 16.1 % exact codes on YuE2's own songs, round trips
     * near 95 % by the author's ear test) and m-a-p's MERT-v2-FullSong itself
     * (632 M parameters, 24 kHz mono in, 25 Hz features out, loaded through
     * transformers with its own modeling code, which is why the four small
     * files are listed: the model does not load without them, and the pinned
     * revision keeps their bytes fixed). With these, Continue works on ANY
     * track in the library — a recording is read into codes (CPU: about half
     * a minute per minute of song, measured 2026-09-20; seconds on a card) and
     * the YuE2 Python engine continues them the way it continues its own
     * takes (server/music/yue_tokenize.py, yue_driver.py --extend-codes).
     *
     * Read off the HuggingFace API 2026-09-20 (repos
     * Mothersuperior/yue2-mothersuperior-realaudio-tokenizer-v4 and
     * m-a-p/MERT-v2-FullSong, revisions pinned below, not gated, both
     * `license: cc-by-nc-4.0`; LFS sizes and sha256 as written, the small
     * files hashed here from a download at that revision). The head's fp32
     * safetensors is listed; its .pt and bf16 twins are not. */
    id: "musicYue2Tokenizer",
    /* A song read through this tokenizer (a cover primed from a recording, a
     * continued recording) carries `tokenized` in its sidecar, and this is how
     * songRights() knows the song used this row's weights. */
    songAddOn: "tokenized",
    label: "YuE2 real-audio tokenizer (head + MERT-v2-FullSong)",
    why: "Continue any recording with YuE2, not only its own takes: the audio is read back into the model's semantic codes first. Also what a planner LoRA of your own would be trained on.",
    licence: "CC BY-NC 4.0 (head from YuE2-3B; MERT-v2-FullSong) — Mothersuperior's head and m-a-p's MERT-v2-FullSong, both non-commercial, run by the engine's python",
    /* Detached like the two LoRAs above: the authors' statement is about
     * YuE2, not about this head or MERT-v2-FullSong. */
    outputRights: YUE2_LICENCE_FILE_RIGHTS,
    required: false,
    files: [
      { url: `${HF}/Mothersuperior/yue2-mothersuperior-realaudio-tokenizer-v4/resolve/e2e63d859f3af879baf1b4d4e9f22d1eeda6fde5/tokenizer_head_joint_v4.safetensors`,
        dest: M("audio_encoders/yue2_tokenizer/tokenizer_head_joint_v4.safetensors"),
        bytes: 171_278_496,
        sha256: "0117394bb7db3dc88e4cb62a5e6e909283e1042240a3678780dcf9396502327e" },
      { url: `${HF}/m-a-p/MERT-v2-FullSong/resolve/d8ba1c745e733b3908ce6ad16ebeb17ac7600a42/model.safetensors`,
        dest: M("audio_encoders/MERT-v2-FullSong/model.safetensors"),
        bytes: 2_529_812_848,
        sha256: "e6dd2ab187d6dd62b6521cd7d8f932e237acf0c5757745a7232082e28391350d" },
      { url: `${HF}/m-a-p/MERT-v2-FullSong/resolve/d8ba1c745e733b3908ce6ad16ebeb17ac7600a42/config.json`,
        dest: M("audio_encoders/MERT-v2-FullSong/config.json"),
        bytes: 882,
        sha256: "f2e194895f58be3ddba327255db129ff0e3bee550cc0ecf08e4d22d79ce3bca3" },
      { url: `${HF}/m-a-p/MERT-v2-FullSong/resolve/d8ba1c745e733b3908ce6ad16ebeb17ac7600a42/configuration_mert2.py`,
        dest: M("audio_encoders/MERT-v2-FullSong/configuration_mert2.py"),
        bytes: 3_860,
        sha256: "77b53ec9d7ee31a599d744fb006e812c7eeaf7390deb46e2f460cf8c17b00bd6" },
      { url: `${HF}/m-a-p/MERT-v2-FullSong/resolve/d8ba1c745e733b3908ce6ad16ebeb17ac7600a42/modeling_mert2.py`,
        dest: M("audio_encoders/MERT-v2-FullSong/modeling_mert2.py"),
        bytes: 17_081,
        sha256: "b1a3174e5649c4b26b0c90d8626f0adacfbbba111a58ed3bb72ad651945a2f5c" },
      { url: `${HF}/m-a-p/MERT-v2-FullSong/resolve/d8ba1c745e733b3908ce6ad16ebeb17ac7600a42/preprocessor_config.json`,
        dest: M("audio_encoders/MERT-v2-FullSong/preprocessor_config.json"),
        bytes: 215,
        sha256: "fc7337f113b71062b8efd03f8a43a07aa769ce85c6a53fdc0b3bb90c299fe63f" },
    ],
    note: "2.70 GB, six files under models/audio_encoders: the 171 MB head and MERT-v2-FullSong's 2.53 GB weights with its config and modeling code. Runs on the CPU when the card is busy (MEASURED 2026-09-20: 30 s of song in 16 s on the CPU, 750 codes) and on the card otherwise. The codes are the song as YuE2 would have written it — close enough to continue, not a lossless copy. Needs the YuE2 Python engine to continue them. ⚠ CC BY-NC: you may not sell what this makes.",
    requires: {
      vramMinGb: 0, vramRecGb: 4, ramMinGb: 8, ramRecGb: 16,
      note: "MERT is 632 M parameters: 2.5 GB in fp32 on the CPU, about half that in bf16 on a card. The continuation that follows needs the YuE2 Python engine's own footprint.",
    },
  },
  {
    /* ACE-STEP 1.5 — the ComfyUI split files, the set ComfyUI's own "ACE-Step
     * 1.5 (split 4B)" template loads: the turbo DiT, the ACE 1.5 VAE, the 0.6B
     * text embedder and the 4B planner LM. Read off the HuggingFace API on
     * 2026-09-18 (repo Comfy-Org/ace_step_1.5_ComfyUI_files, revision pinned
     * below, not gated; sizes and LFS sha256 as written).
     *
     * THE LICENCE, READ RATHER THAN TAGGED. ACE-Step's own repository ships a
     * LICENSE that is the MIT text word for word ("Copyright (c) 2026 ACEStep",
     * github.com/ace-step/ACE-Step-1.5), and its model card (ACE-Step/Ace-Step1.5)
     * says `license: mit` and, of the music: "You can strictly use the
     * generated music for commercial purposes." The ComfyUI repack carries no
     * LICENSE file; its card's frontmatter says `apache-2.0`, a tag with no text
     * behind it, so the row follows the upstream text. Both are permissive; the
     * difference is recorded, not resolved by picking the friendlier one.
     *
     * A LoRA is not this row: each carries its own terms (ACE-Step's own
     * example LoRA says "commercial use is prohibited"), so the Music tab says
     * the LoRA's licence is its own. */
    id: "musicAceStep15",
    home: "https://github.com/ace-step/ACE-Step-1.5",
    label: "Music engine — ACE-Step 1.5 turbo (ComfyUI)",
    why: "A fast song model that runs inside ComfyUI's own nodes: 8 steps, lyrics in 50+ languages, tempo, key and time signature, LoRAs, and covers of a song you give it. NVIDIA or AMD, no Python kit. MIT, and its authors allow commercial use of what it makes.",
    licence: "MIT (ACE-Step's LICENSE; the ComfyUI repack's card tags apache-2.0 with no licence text)",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: MIT_GRANT,
      clause: "MIT License, grant paragraph (ACE-Step-1.5 LICENSE, Copyright (c) 2026 ACEStep)",
      url: "https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " ACE-Step's model card adds, of the music: \"You can strictly use the generated music for commercial purposes.\" A LoRA you add is licensed by its own author, and some forbid commercial use.",
    },
    required: false,
    files: [
      { url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/694a9723ff772285c73f0700caacf944d3f02f8d/split_files/diffusion_models/acestep_v1.5_turbo.safetensors`,
        dest: M("diffusion_models/acestep_v1.5_turbo.safetensors"),
        bytes: 4_787_825_604,
        sha256: "3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7" },
      { url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/694a9723ff772285c73f0700caacf944d3f02f8d/split_files/vae/ace_1.5_vae.safetensors`,
        dest: M("vae/ace_1.5_vae.safetensors"),
        bytes: 337_431_732,
        sha256: "6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb" },
      { url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/694a9723ff772285c73f0700caacf944d3f02f8d/split_files/text_encoders/qwen_0.6b_ace15.safetensors`,
        dest: M("text_encoders/qwen_0.6b_ace15.safetensors"),
        bytes: 1_191_588_248,
        sha256: "fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7" },
      /* The planner. `alt` makes the 1.7B count (ComfyUI's plain "split"
       * template uses it): 3.7 GB against 8.4, for a smaller card. */
      { url: `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/694a9723ff772285c73f0700caacf944d3f02f8d/split_files/text_encoders/qwen_4b_ace15.safetensors`,
        dest: M("text_encoders/qwen_4b_ace15.safetensors"),
        alt: ["qwen_1.7b_ace15.safetensors"],
        bytes: 8_379_154_232,
        sha256: "ffe5ffb855086c2ab55e467e9859fb01894781020a0376484dd19de166b79873" },
    ],
    note: "14.7 GB in four files (diffusion_models, vae, text_encoders). Turbo renders in 8 steps; ACE-Step documents 10 seconds to 10 minutes and 50+ languages. Covers and LoRAs work on turbo; Extract, Lego and Complete need ACE-Step's base model, which Studio does not drive. Not yet timed on this machine. Model card and docs: https://huggingface.co/ACE-Step/Ace-Step1.5",
    requires: {
      vramMinGb: 8, vramRecGb: 16, ramMinGb: 16, ramRecGb: 32,
      note: "Not measured here. ACE-Step's own guide asks 6-8 GB for its 0.6B planner, 12-16 GB for 1.7B and 24 GB for 4B when everything stays on the card; ComfyUI offloads what does not fit, so a smaller card is slower rather than refused. The 1.7B planner (3.7 GB) is the lighter choice.",
    },
  },
  {
    id: "musicYue2",
    label: "Music engine — YuE2 3B",
    /* No "optional" here: when YuE2 is the selected engine the card carries the
     * required badge, and the sentence under it must not argue with it. */
    why: "A Python music engine with an editable score. Studio needs one music engine, the one picked in the music model list, not every one.",

    /* 🔴 THREE LICENCES, NOT ONE, and they answer three different questions.
     * Each was read off THIS MACHINE on 2026-09-11, not off a repository tag:
     *
     *   WEIGHTS — CC BY-NC 4.0, and the vendor scopes it himself:
     *     `m-a-p/YuE2-3B/LICENSE` says it covers "the YuE2 checkpoint weights
     *     in model.safetensors, or the corresponding
     *     models/<model-name>/model.safetensors files in the inference kit",
     *     then reproduces the official CC text unmodified. The HF API agrees on
     *     both repos (`license: cc-by-nc-4.0`, queried 2026-09-11). THIS is the
     *     layer that decides whether a song may be sold; see `outputRights`.
     *   INFERENCE CODE — Apache-2.0, stated by the package itself:
     *     `yue2_infer-0.1.6.dist-info/METADATA` carries
     *     `License-Expression: Apache-2.0` beside a full Apache LICENSE *and* a
     *     separate MODEL_LICENSE. That separation is the vendor drawing this
     *     same line, which is why it can be relied on.
     *   THE COMMUNITY ComfyUI NODE PACK — MIT. ComfyUI-YuE2
     *     (github.com/EmeraldApple-AI/ComfyUI-YuE2), whose own README says the
     *     MIT "covers only the node source, not the weights". Studio does not
     *     use it and does not need it; it is named because it is where the
     *     Windows environment fixes in `note` below came from, and because a
     *     reader who finds it must not read its MIT as reaching the weights.
     *
     * ⚠ THE LAYERS MUST NOT BE COLLAPSED, in either direction. "YuE2 is
     * CC BY-NC" is wrong about the code; "YuE2 is Apache-2.0" — which is what a
     * glance at the GitHub repo gives you — is wrong about the song. This is
     * the frontmatter-is-a-tag problem the engine row above documents, one
     * level up: here the publisher really does ship two licences and means
     * both, so the row states both rather than picking the friendlier one. */
    licence: "CC BY-NC 4.0 (weights) — Apache-2.0 inference code, MIT community node pack",

    /* ⚠ CHANGED 2026-09-24 (owner's decision): the label now follows the YuE2
     * authors' statement of 15 Sep 2026, YUE2_AUTHORS_RIGHTS above —
     * "sellable by individuals; companies need a commercial licence" — with
     * the licence file's grant kept verbatim beside it in `licenceFile`. The
     * reading below is still the reading of that FILE, and it is why the
     * file is shown next to the label rather than dropped. It is kept, not
     * rewritten, so the change is visible as a change.
     *
     * 🔴 THE FIRST `not-for-sale` ROW IN THIS CATALOGUE (until 2026-09-24), which is why the
     * reasoning is written out rather than assumed: the "not for sale" marker
     * in scripts/models_table.mjs and the "bad" chip in web/app.js have both
     * existed unused since they were written, and this is the row that lights
     * them.
     *
     * The quote is §2(a)(1) VERBATIM, whitespace-normalised out of the
     * 70-column hard wrap in the LICENSE that ships beside the weights — the
     * same normalisation MIT_GRANT above records. Nothing else is quoted
     * because nothing else is the operative grant.
     *
     * ⚠ WHERE THE READING SITS, said out loud instead of hidden inside the
     * verdict. CC BY-NC never uses the word "Output" — unlike H3 §VI.4 and
     * LTX §5, which each say in terms that the licensor claims no rights in it.
     * So the reach is not a sentence about songs: it is the "for NonCommercial
     * purposes only" limit on exercising the Licensed Rights AT ALL, together
     * with §1(i), which defines NonCommercial as "not primarily intended for or
     * directed towards commercial advantage or monetary compensation".
     * Rendering a track you intend to sell is exercising those rights for a
     * commercial purpose, and that is not granted. The vendor reads it the same
     * way: the same lab licensed YuE v1's weights Apache-2.0 and explicitly
     * encouraged monetising its outputs, and chose differently here.
     *
     * `unknown` would be the WRONG answer rather than the modest one. The
     * operative text has been read, it is quoted below, and the licence is not
     * silent — rule 2 of the block above cuts both ways, and repeating a
     * plausible permission is the same failure as repeating a plausible
     * restriction. A user who needs commercial has the v1 route in `note`. */
    outputRights: YUE2_AUTHORS_RIGHTS,

    /* ⚠ DELIBERATELY NO `region` FIELD, and this is not a shortcut.
     *
     * The quoted sentence grants a WORLDWIDE licence in those words, and CC
     * BY-NC 4.0 has no Applicable Territory clause anywhere in it — there is
     * nothing to surface. `region` exists for H3, whose grant really does stop
     * at a border and whose download therefore refuses without a blocking
     * acknowledgement; reusing it here would block four territories for no
     * legal reason at all. Same rule and same reason as the
     * deliberately-no-region note on LTX further down: a gate built for one
     * licence's shape does not travel to another's. The excluded list is never
     * retyped outside this file either — `server/territory_test.js` fails the
     * build when any other source or document hand-types it. */

    /* ⚠ DELIBERATELY NO `gated` BLOCK. Both weight URLs below resolve to an
     * anonymous caller: the HF API reports `gated: false, private: false` on
     * both repos (queried 2026-09-11), and the paths-info API returned each
     * file's size and LFS oid without a token — which is also where the byte
     * counts were checked. This is not LTX: there is no licence to accept on a
     * model page and nothing for `scripts/` to hand-fetch, so the built-in
     * downloader can do the whole job. */

    /* ⚠ `required: false` IS THE LOAD-BEARING WORD ON THIS ROW, and it is
     * written out rather than omitted so that the choice is visible.
     *
     * server/fit.js derives the music slot as `CATALOG.filter((c) => c.required)`
     * — by the FLAG, not by an id, deliberately, "so the day a second required
     * capability appears it is recommended automatically instead of being
     * silently left out of the total bytes a newcomer is quoted". A second music
     * engine is that day, and `true` here would have meant it: recommendFor()
     * would put BOTH engines in the music slot as downloads there is no choice
     * about, and bytesFor() would add 7.79 GB to the figure a newcomer is
     * quoted before they have made one song. MiniMax Music 3 is required
     * because Studio does not render without it. Nothing depends on this one.
     * `scripts/models_table.mjs` and `server/docs_test.js` both find "the
     * engine" with `CATALOG.find((c) => c.required)`, which is a second and a
     * third reader that must keep getting exactly one answer. */
    required: false,

    files: [
      /* `identifies` — THE FILE THAT MAY CLAIM A RENDER. The whole argument is
       * in the TripoSG block further down; this row is the case that argument
       * was written about, twice over.
       *
       * Both basenames here are `model.safetensors` — the most generic weight
       * name there is — and neither file is anywhere near the engine's tree
       * (see YUE() at the top), so without a declared tail both of these could
       * sit in MODEL_TO_CAPABILITY and be invisible to modelKeyFromFiles(),
       * which stamps such a render `unknown`. A BASENAME match would be worse
       * than nothing: it would hand CC BY-NC — the strictest record in this
       * catalogue — to any graph that loaded any diffusers checkpoint. The tail
       * cannot do that, and a reference that carries only the basename fails to
       * match and stamps `unknown`, which is the honest answer.
       *
       * BOTH files carry it, unlike TripoSG where only the transformer does,
       * and for the reason given there: a tail may only go on a file that is
       * not shared. Neither of these is general-purpose — the VAE is YuE2's own
       * Oobleck autoencoder, per THIRD_PARTY_NOTICES.md — and the decode path
       * can load the VAE alone (the receipt's `latent.npy` is what it reads),
       * so a render that touched only the VAE must still be nameable.
       *
       * MEASURED 2026-09-11, three ways that agree: both byte counts were
       * stat'd off this disk, both match the vendor's own weights_manifest.json
       * sha256, and both match the size AND LFS oid the HuggingFace paths-info
       * API returns for the same path. The render's own receipt recorded the
       * same two hashes independently. */
      { url: `${HF}/m-a-p/YuE2-3B/resolve/main/model.safetensors`,
        dest: YUE("YuE2-3B/model.safetensors"),
        identifies: "YuE2-3B/model.safetensors",
        bytes: 7_261_441_640,
        sha256: "1d55c42c1a9875c34f5d736e15078449992b044e807ce2a138e6cf289a1e59e9" },
      { url: `${HF}/m-a-p/YuE2-Vae/resolve/main/model.safetensors`,
        dest: YUE("YuE2-Vae/model.safetensors"),
        identifies: "YuE2-Vae/model.safetensors",
        bytes: 530_512_720,
        sha256: "807ce9d5149fa27c5ad3e6582058469852e908f6c5acc8c8aa338e7ab7751346" },
      /* ⚠ THE SIDECARS ARE NOT LISTED, and that is a decision rather than an
       * oversight. The loader also needs each repo's config.json,
       * modeling_*.py and (for the transformer) qwen.tiktoken — kilobytes, and
       * the files the vendor's weights_manifest.json pointedly does NOT cover.
       * Pinning a 959-byte config.json by exact size would make this row report
       * "7.79 GB missing" the first time upstream fixes a typo in it, which is
       * a worse failure than the one it would prevent. So `ready` here means
       * "the weights are present and the right size", and a runner must fetch
       * the repo's small files with them. */
    ],
    note: "7.79 GB, 7.26 GB of it the transformer. A second engine with an editable-score step, not a replacement: MEASURED here 2026-09-11 at 167.0 s of 48 kHz 24-bit stereo in 399.6 s end to end — 2.39x realtime, against MiniMax Music 3's 1.53x on the same card (config.js, music.engines['minimax-music3'].realtimeRatio). The stages were 281.0 s of semantic sampling (4177 tokens, 14.87 tok/s), 106.3 s of NAR and 5.7 s of VAE, plus 6.6 s to load the weights warm; execution eager, attention sdpa, one CFG branch. Planning the ABC score costs nothing when you supply one. ⚠ Lyrics must carry NO bracketed section labels: MEASURED on the MiniMax engine, which SANG “[verse]” — three tracks were rejected for it and one ran 202 s instead of 64 s carrying the brackets — and nothing measured makes YuE2 different, so the same rule holds here until something does. It runs in its own interpreter rather than in ComfyUI, and on Windows it needs PYTHONUTF8=1 set before that interpreter starts, because the vendor writes its plan with no encoding argument and CJK lyrics hit cp1252 and raise. Selling: the YuE2 authors say individuals may sell what it makes and companies need a commercial licence (15 Sep 2026); the licence file still reads CC BY-NC 4.0 — the rights chip has both.",
    requires: {
      /* The 24 GB card and the 24 GB of host RAM are the VENDOR's
       * recommendation, and `fitFor()` already words `vramRecGb` as
       * "recommended" in every sentence it builds, which is the same way the H3
       * row's 24 carries its claim. What is MEASURED is the 10.6 GiB peak, and
       * it is in the note beside them so the two cannot be read as one number.
       *
       * ⚠ THE MINIMUM WAS 12 AND IT WAS WRONG — corrected 2026-09-11 from
       * ESTIMATED-and-untested to 16, because the allocator arithmetic now
       * settles it without needing a 12 GiB card to try it on. The pipeline
       * reserves 2 GiB whatever budget it is handed: pipeline.py:162 computes
       * `min((budget - 2) * GiB, total - 2 * GiB)`. So a 12 GiB card leaves
       * PyTorch 10 GiB, against a MEASURED peak of 10.5-10.6 GiB. It does not
       * fit, and "the smallest card above the measured peak" was the wrong way
       * to derive a minimum — the peak is not the whole requirement when the
       * runtime takes a fixed cut off the top first.
       *
       * Estimating downward from one machine is how a row ends up promising
       * hardware it has never seen work, which is the failure this catalogue
       * exists to prevent. 16 is what has actually rendered.
       *
       * The RAM minimum is the vendor's own figure and is about AVAILABLE host
       * RAM, not installed; the only machine this has run on had 32 GB fitted. */
      vramMinGb: 16, vramRecGb: 24, ramMinGb: 24, ramRecGb: 32,
      note: "Python YuE2: vendor recommends 24 GB VRAM and 24 GB available RAM. Studio measured a 167-second song at about 10.6 GiB peak on a 16 GB RTX 4070 Ti SUPER; the Python runtime reserves extra memory, so do not infer a 12 GB floor from that peak. FP8 and AR offload do not remove the synthesis-prefill peak. Longer songs need separate measurement. Native GGUF uses a different runtime: see its own experimental row, whose minimum GPU size is not established.",
    },
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
    /* Three packages, one line — the same line INSTALL.md prints, now sourced
     * from here so the guide and the screen cannot disagree about it. */
    packageInstall: "python -m pip install numpy torch av",
    note: "ComfyUI ships the DAV decoder only — sd.py refuses to encode audio — so this is the missing half, and it runs outside ComfyUI. Its decoder tensors are bit-identical to the copy the engine already uses, which is what makes the latent it produces one the sampler understands: the round trip measures +26.26 dB SI-SDR. Encoding is capped at 60 seconds, enough to establish structure and short of the out-of-memory a full track hit while the music stack was resident. The publisher states no licence; these are Music 3 weights, so treat them as the engine's. Needs numpy, torch and PyAV in the system Python — INSTALL.md has the one pip line.",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Falls back to the CPU when there is no CUDA, several times slower. These figures follow from the 60-second cap rather than a per-tier measurement: a 2-minute stereo decode allocates over 4 GB and did OOM alongside the resident music stack, which is why the cap exists.",
    },
  },
  {
    id: "coverArt",
    /* One of the five rows that MAKE PICTURES — see isPictureModel() below the
     * catalogue for why this is a field rather than a subtraction. */
    makes: "picture",
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
    id: "chatQwen3",
    /* THE LANGUAGE MODEL, WHICH HAD NO ROW. Chat, Simple mode and every
     * Enhance button run a text encoder that can also generate (ComfyUI's
     * TextGenerate), found at run time by server/chat/models.js. So the one file
     * they all default to was only ever downloaded as a side effect of an image
     * model, the Models screen had no Chat section, and a machine without an
     * image model had no way to get it: Enhance failed with ComfyUI's refusal. */
    group: "chat",
    label: "Chat — Qwen3 4B",
    why: "Answers the Chat tab, runs Simple mode, and writes or polishes styles and lyrics when you press Enhance. Runs on this machine; nothing is sent anywhere.",
    licence: "Apache-2.0",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: APACHE_GRANT,
      clause: "Apache-2.0 §2 (Grant of Copyright License)",
      url: "https://huggingface.co/Qwen/Qwen3-4B/blob/main/LICENSE",
      note: PERMISSIVE_NOTE,
    },
    files: [ZIMAGE_ENCODER],
    note: "The same file FLUX.2 klein and Z-Image use as their text encoder, so it is downloaded once whichever comes first. Any other Qwen3, Gemma or Llama file ComfyUI can load also appears in the chat model menus.",
    requires: {
      vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "The weights are 8.0 GB in bf16. On a smaller card ComfyUI streams them from system RAM, which works but is slower; not measured per card. An API key (Settings, Agent) needs no card at all.",
    },
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
    /* The line to type, held HERE rather than in INSTALL.md, because INSTALL.md
     * did not have one: it said "install them somewhere and point Studio at that
     * Python", which is true and is not a command. One string, read by the
     * Models screen, by the recommendation block and by the docs generator, so
     * the three cannot drift and none of them has to invent it. */
    packageInstall: "python -m pip install demucs",
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
        alt: ["minimax_h3_fl2va_pruned_int4_convrot.safetensors", "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors", "MiniMax_H3_FL2VA_pruned_mixed_int4_int8_convrot.safetensors"],
        /* A light machine (config.js h3Light) fetches the w4a8 build: 12.5 GB
         * instead of 21. Rendered 2026-09-25 on an RX 9060 XT, same seed as
         * the int8: sampling ~7% faster, as good to the eye. */
        light: { url: `${HF}/Winnougan/MiniMax-H3-INT4_Convrot_ComfyUI/resolve/6387f8cd370fd8b4deaa9aa7e9e1be4d7298e7df/minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors`,
          dest: M("diffusion_models/minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors"), bytes: 12540857840,
          sha256: "8b624de0ab7554bb507c4486093d4c93e0bf2eb2a40c2382f26eb0af7cd97407",
          alt: ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3_fl2va_pruned_int4_convrot.safetensors", "MiniMax_H3_FL2VA_pruned_mixed_int4_int8_convrot.safetensors"] } },
      ...H3_SHARED_FILES,
      /* NO SPEED-UP LORA HERE. H3 renders without one (the bare model, Best,
       * 20 steps), so a missing LoRA must not make the engine "not
       * downloaded": that refused H3 on a disk holding everything but the
       * 4-step file. The 3-, 4- and 8-step speed-ups are their own optional
       * rows (addonFor "video"), and a step count whose file is missing is
       * refused with its download offered (video-plain.js videoPlan). */
    ],
    note: "41 GB, or 30 GB on AMD, Intel and lower-end PCs, which get lighter builds measured as good and a little faster — by far the largest thing here, and entirely optional. H3 always renders audio even when you only want pictures; Studio discards it, because the song already exists. Measured on this rig at roughly 15 s fixed cost plus 1.7 s per step. "
      + "The speed-ups (3, 4 and 8 steps) are optional add-ons below; without one, H3 renders at 20 steps. "
      + H3_AMD_NOTE,
    /* The card decides the size, not a floor (server/h3tier.js, from the H3
     * lab of 2026-09-24): this row used to say 16 GB minimum, which told a
     * 12 GB owner "below the minimum" for a card measured bit-identical. */
    requires: h3Requires("The heaviest capability in Studio by a wide margin. Never runs while music is generating."),
    variants: [
      { label: "DiT FL2VA pruned int8 convrot, official (offered)", bytes: 20970379616, note: "Measured 08-24: a class above the third-party int4 prune — real prompt-following close-ups — at ~15% more render time." },
      { label: "DiT FL2VA pruned int4 convrot (third-party)", bytes: 11337536848, note: "What this rig originally measured. Visibly worse than the official int8; kept as a fallback for small disks." },
      { label: "DiT FL2VA pruned fp8 scaled, official", bytes: 20956702112, note: "Same size as int8; not measured here." },
      { label: "DiT FL2VA pruned bf16, official (unquantised)", bytes: 40225724176, note: "Twice the download; not measured here." },
      { label: "Text encoder Qwen3-VL-32B int4 convrot (offered)", bytes: 14173709116 },
      { label: "Text encoder nvfp4 awq, official", bytes: 15690000000, note: "What the ComfyUI templates name. Blackwell-native; not measured here." },
      { label: "Text encoder int8 convrot, official", bytes: 27141342152, note: "Nearly twice the size." },
      { label: "Video VAE fp16, official (offered)", bytes: 5207808496 },
      { label: "Video VAE int8 convrot, official (Comfy-Org, 2026-09-15; not offered yet)", bytes: 2811065184, note: "The name config.js loads first. Not the 3.17 GB int8 this rig measured (about 12% a clip) under the same name, and never rendered here; the download stays fp16 until it is." },
      { label: "Audio VAE fp32, official (offered)", bytes: 605254808 },
    ],
  },
  {
    id: "videoFastH3",
    label: "Video clips — FastH3 (8 steps, experimental)",
    why: "FastVideo's 8-step distillation of MiniMax H3: text or opening and closing pictures to a clip with sound, in 8 steps and no speed-up LoRA. It uses H3's text encoder and VAEs, so with H3 installed only the model file is new. No references; those stay on H3.",
    licence: "MiniMax H3 Community Licence (derived from H3)",
    home: "https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy",
    /* The repo names H3's licence as its own, so everything the H3 row says
     * about outputs and territory applies unchanged, like the TaoMate row. */
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "MiniMax claims no rights over the Outputs you generate. You and your users are entirely responsible for the Outputs and any subsequent use thereof.",
      clause: "MiniMax H3 Community License Agreement §VI.4 (Intellectual Property); FastH3 is a distillation of H3 and its card names that licence",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
      conditions: [
        "§V.4 — the Applicable Territory excludes the EU, the UK, the Republic of Korea and the USA; a clip made with FastH3 is an H3 output and carries the same limit.",
        "§V.3 — Outputs may not be used to improve any other AI model.",
        "§IV.2 — a commercial product or service using H3 must display “MiniMax H3” prominently.",
      ],
      note: "A distillation of H3's weights, not a model of its own: everything the H3 row says about outputs and territory applies unchanged.",
    },
    region: {
      excluded: ["European Union", "United Kingdom", "Republic of Korea", "United States of America"],
      text: "Derived from MiniMax H3, so its Community Licence applies: rights only inside the Applicable Territory, which excludes the EU, the UK, the Republic of Korea and the United States of America. AIPLAY Studio does not host the weights; the download goes straight to the publisher.",
      url: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    },
    files: [
      { url: `${HF}/FastVideo/FastVideo-FastH3-Comfy/resolve/main/diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors`,
        dest: M("diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors"), bytes: 22128378696,
        alt: ["fastvideo_fasth3_8step_v2_pruned_bf16.safetensors"] },
      ...H3_SHARED_FILES,
    ],
    note: "22.1 GB on a machine that already has H3; 42 GB without it (40 GB on AMD, Intel and lower-end PCs, which get the lighter int8 video VAE). Trained with FastVideo's sparse attention (VSA), which ComfyUI runs where its kernel exists and skips elsewhere. "
      + "⚠ Experimental. Measured 2026-09-24 on a 16 GB card against H3's Fast setting (TaoMate 3-step): about 1.4x the wait at 1344x768, 8 s (236 s against 172 s); good on 1 of 3 prompts, "
      + "while the others showed a recurring white blob and a subject changing colour, so check each take. VSA made it about 1.45x faster than dense on the whole clip. "
      + H3_AMD_NOTE,
    /* The same tiers as H3: under an 8 GB cap its DiT phase was within 50 MiB
     * of TaoMate's at 960x544 (measured); at full size under 16 GB that is a
     * prediction, and the "fasth3" path makes the verdict say so. */
    requires: h3Requires("The same size of model as H3, run for 8 steps. Never runs while music is generating.",
      { path: "fasth3" }),
    variants: [
      { label: "DiT 8-step v2 pruned int8 convrot (offered)", bytes: 22128378696 },
      { label: "DiT 8-step v2 pruned bf16", bytes: 44079246824, note: "Twice the download; not measured here." },
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
    /* H3's tiers. Measured under an 8 GB cap: the 8-step reference path with
     * one picture fit at 960x544, 5 s, with only 314 MiB to spare (lab L8r);
     * several pictures and the song under the clip were never capped, and it
     * was never run at 1344x768 under a cap. The "refs" path quotes that
     * instead of the Fast setting's measurement. */
    requires: h3Requires("Same weight class as the H3 video capability; the two never load together. "
      + "Reference pictures add memory.", { path: "refs" }),
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
    makes: "picture",
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
        dest: M("text_encoders/qwen3vl_8b_nvfp4.safetensors"), bytes: 6305221764,
        alt: ["qwen3vl_8b_fp8_scaled.safetensors"],
        // nvfp4 has no kernel on ROCm; the vendor's fp8 build of the same encoder.
        amd: { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/text_encoders/qwen3vl_8b_fp8_scaled.safetensors`,
          dest: M("text_encoders/qwen3vl_8b_fp8_scaled.safetensors"), bytes: 10588637512 } },
      { url: `${HF}/Comfy-Org/Ideogram-4/resolve/main/vae/flux2-vae.safetensors`,
        dest: M("vae/flux2-vae.safetensors"), bytes: 336211292 },
    ],
    note: "25.2 GB (the VAE is shared with FLUX.2 and is usually already present). ⚠ fp8_scaled ON PURPOSE: the int8_convrot conversions of this model are BROKEN — the conversion damages the conditioning head and every render comes back as the model's trained-in 'blocked by safety filter' card (measured; the vendor's own fp8 renders perfectly). And the deeper finding: the open weights are NOISE-LOCKED — only a sparse, deterministic set of seeds renders at all (1 in 23 probed; seed 777 is the shipped one) and every other seed draws the card regardless of prompt. The app renders from its pass-seed list automatically; scripts/harvest_ideogram_seeds.mjs finds more overnight. Composition variety per prompt = the size of that list. Hunyuan Image 3.0 was evaluated and rejected: 48 GB of weights even at NF4, physically over this machine's memory.",
    requires: { vramMinGb: 12, vramRecGb: 16, ramMinGb: 32, ramRecGb: 32 },
  },
  {
    id: "narration",
    label: "Narration — TTS voices (Kokoro + Qwen3-TTS)",
    why: "Reads a book aloud. Kokoro-82M is the instant engine: 50+ named voice personas, tiny, runs between renders. Qwen3-TTS 1.7B is the rich engine: preset voices (Ryan, Aiden), a voice DESIGNER that mints new personas from a text description, and cloning to hold a minted persona steady across a whole audiobook.",
    licence: "Apache-2.0 (both engines)",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: APACHE_GRANT,
      clause: "Apache-2.0 §2 (Grant of Copyright License) — held for both engines",
      url: "https://huggingface.co/hexgrad/Kokoro-82M/blob/main/LICENSE",
      conditions: [],
      note: "Kokoro-82M and Qwen3-TTS are both Apache-2.0, which places no restriction "
        + "on what you do with the audio. A voice you MINT with the designer, or clone, "
        + "is yours on the same terms — but cloning a real person's voice raises rights "
        + "that no model licence speaks to, and that is your call, not this one's.",
    },
    /* Both engines install as python packages and cache their weights through
     * the HF hub, so there are no files[] for the downloader to verify —
     * `viaPackage` capabilities report ready from an import probe instead.
     * Qwen3-TTS lives in its OWN venv (tts-venv): its transformers pin would
     * fight ComfyUI's stack if it shared one. Kokoro rides the main venv.
     * ⚠ Never runs while music renders — narration waits for the queues to
     * drain, and the synth releases its VRAM when the process exits. */
    files: [],
    viaPackage: "kokoro + qwen-tts (sidecar venv at tts-venv/)",
    approxBytes: 15.5e9,
    note: "Kokoro ~330 MB, instant. Qwen3-TTS ~15 GB across CustomVoice + VoiceDesign + Base, 5-6 GB VRAM while narrating. Watchlist: Audio8-TTS-Preview-0.1b (44.1 kHz, cloning-only, custom revenue-capped licence) — small enough to matter if a preset-voice build appears.",
    requires: {
      vramMinGb: 0, vramRecGb: 8, ramMinGb: 16, ramRecGb: 32,
      note: "Kokoro runs anywhere. Qwen3-TTS wants 8 GB of momentarily-free VRAM; the audiobook runner evicts the music stack first and the next song pays ~15 s to reload.",
    },
  },
  {
    id: "sfx",
    label: "Sound effects — Stable Audio 3 Small SFX",
    why: "Text to sound effect: glass shattering, rain on a window, a door creak — the accents an audiobook or a video timeline drops on a cue. 3-5 s renders through the ordinary render queue.",
    licence: "Stability AI Community License — free commercial use below $1M/year aggregate revenue (terminates above it); registration with Stability and a \"Powered by Stability AI\" attribution are required. No territory clause.",
    files: [
      { url: `${HF}/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_small_sfx_base.safetensors`,
        dest: M("checkpoints/stable_audio_3_small_sfx_base.safetensors"), bytes: 2270384940 },
      { url: `${HF}/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors`,
        dest: M("text_encoders/t5gemma_b_b_ul2.safetensors"), bytes: 1187264003 },
    ],
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "Subject to your compliance with this Agreement, Stability AI grants you a "
        + "non-exclusive, worldwide, non-transferable, non-sublicensable, revocable, "
        + "royalty-free and limited license under Stability AI's intellectual property "
        + "rights in the Stability AI Materials to use, reproduce, distribute, and create "
        + "Derivative Works of the Stability AI Materials, in each case for Non-Commercial "
        + "Uses or Commercial Uses permitted herein.",
      clause: "Stability AI Community License §I.1 (Licence Rights)",
      url: "https://stability.ai/community-license-agreement",
      conditions: [
        "Free commercial use only while your ANNUAL AGGREGATE REVENUE is under USD 1 million "
        + "— across your whole organisation, not per product. Above it the licence terminates "
        + "and you need an Enterprise agreement from Stability.",
        "You must register with Stability AI for commercial use.",
        "Attribution is mandatory: a product using it must display “Powered by Stability AI”.",
      ],
      note: "The revenue ceiling is the condition people miss — it is measured on the "
        + "ORGANISATION's turnover, so it can be crossed by work that has nothing to do "
        + "with these sounds. No territory clause.",
    },
    note: "3.5 GB. Rejected alternatives were all non-commercial (AudioGen, Tango 2, AudioLDM 2, TangoFlux, MMAudio) — this is the one open SFX model a product can ship on.",
    requires: { vramMinGb: 6, vramRecGb: 8, ramMinGb: 16, ramRecGb: 32 },
  },
  {
    id: "imageZImage",
    makes: "picture",
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
    // Official ComfyUI repack, checked against Hugging Face's LFS metadata on
    // 2026-09-21. These are Qwen Image 2.1 components; the older Qwen image VAE
    // used by Anima/Krea is not interchangeable with this model's VAE.
    id: "qwen-image-2.1",
    makes: "picture",
    label: "Images — Qwen Image 2.1 (research licence)",
    why: "Create images from text or edit with reference pictures using Qwen Image 2.1's native ComfyUI workflow.",
    licence: "Qwen Research License Agreement — research and evaluation only; commercial use requires a separate licence",
    home: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1",
    outputRights: {
      class: "not-for-sale",
      sellable: false,
      quote: '"Non-Commercial" shall mean for research or evaluation purposes only.',
      clause: "Qwen Research License Agreement §1(i), with §2(a)-(b) limiting use to noncommercial purposes",
      url: "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/790c92633540aa0cb11d9abf19eb46d861714758/LICENSE",
      conditions: [
        "Use of the model is limited to research or evaluation. Commercial use requires a separate licence from Qwen.",
        "Redistributing weights or derivatives requires the agreement, attribution notice and notices of modifications.",
      ],
      note: "Studio conservatively marks results not for sale because generating them for commercial purposes requires a separate model licence. This does not assert that every generated image inherits the weights' licence. The open weights are not Apache-2.0.",
    },
    required: false,
    files: [
      { url: `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/ace0edeb3791a594ddfa36ed5f41a178a394e921/diffusion_models/qwen_image_2.1_int8_convrot.safetensors`,
        dest: M("diffusion_models/qwen_image_2.1_int8_convrot.safetensors"),
        bytes: 7_256_783_064,
        sha256: "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d" },
      { url: `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/ace0edeb3791a594ddfa36ed5f41a178a394e921/text_encoders/qwen3vl_8b_int8_convrot.safetensors`,
        dest: M("text_encoders/qwen3vl_8b_int8_convrot.safetensors"),
        bytes: 9_350_798_360,
        sha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f" },
      { url: `${HF}/Comfy-Org/Qwen-Image-2.1/resolve/ace0edeb3791a594ddfa36ed5f41a178a394e921/vae/qwen_image_2.1_vae_bf16.safetensors`,
        dest: M("vae/qwen_image_2.1_vae_bf16.safetensors"),
        bytes: 675_509_688,
        sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9" },
    ],
    note: "17.28 GB in three files: the official INT8 diffusion model, Qwen3-VL 8B INT8 encoder and dedicated Qwen Image 2.1 VAE. This is the native ComfyUI build supported by Studio. Requires ComfyUI's Qwen Image 2.1 nodes; no custom node pack is installed by this download. Limited 512px generation/edit checks passed on a 16 GB card; see docs/QWEN_IMAGE.md for timings. Minimum memory, large canvases and ten-reference performance remain unmeasured.",
    requires: {
      experimental: true,
      note: "No minimum VRAM or RAM requirement has been established for this integration. Download size is not peak VRAM; ComfyUI can stage models and offload, while resolution and reference count affect memory use.",
    },
  },
  {
    /* FAST DRAFT FOR QWEN IMAGE 2.1 — Viggle's v0.2 5-step turbo LoRA, the
     * rank-128 cut (the r256 is 1.36 GB and was not needed). A LoRA on the
     * qwen-image-2.1 row's own files, not a model of its own: no `makes`, so
     * it never appears as a picture engine, and `addonFor` names the row it
     * needs. Read off HuggingFace 2026-09-24 at commit 2b85c1fc; the file on
     * the lab rig matched the LFS sha256 below.
     *
     * MEASURED 2026-09-24 (lab/qwen_turbo: 302 renders, five arms, two blind
     * judges), through the stock LoraLoaderModelOnly at 1.0 with five
     * ManualSigmas, euler, CFG 1 — what server/qwen-image.js builds. */
    id: "imageQwenFastDraft",
    group: "images",
    addonFor: "qwen-image-2.1",
    label: "Images — Fast draft for Qwen Image 2.1 (Viggle turbo LoRA)",
    why: "About 3x quicker Qwen Image 2.1 pictures for storyboards, board thumbnails and ideas: 5 steps instead of 25. It may garble small text and, in crowds or close hands, add extra faces or fingers, so the full render stays the default and is the one for lettering, two-reference style edits and finals.",
    licence: "Qwen Research License Agreement — research and evaluation only, like the Qwen Image 2.1 it patches; commercial use requires a separate licence",
    home: "https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo",
    outputRights: {
      class: "not-for-sale",
      sellable: false,
      quote: '"Non-Commercial" shall mean for research or evaluation purposes only.',
      clause: "Qwen Research License Agreement §1(i), with §2(a)-(b) limiting use to noncommercial purposes; the LoRA is a derivative of Qwen-Image-2.1 and its NOTICE ships it under the same agreement",
      url: "https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/blob/2b85c1fcb7b2584c4133fe0c547ec968ff2ae20e/LICENSE",
      conditions: [
        "Use is limited to research or evaluation, exactly as for Qwen Image 2.1 itself. Commercial use requires a separate licence from Qwen.",
        "Redistributing the LoRA requires a copy of the agreement, notices on modified files, and the §3(c) Qwen copyright notice in a Notice file; using its outputs to train a model you release requires \"Built with Qwen\" (§4(b)).",
      ],
      note: "A patch on Qwen Image 2.1's weights, not a model of its own: a Fast draft is a Qwen Image 2.1 picture, and Studio marks it not for sale as it marks every Qwen picture.",
    },
    required: false,
    files: [
      { url: `${HF}/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/2b85c1fcb7b2584c4133fe0c547ec968ff2ae20e/Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r128.safetensors`,
        dest: M("loras/Qwen-Image-2.1-viggle-turbo-v0.2-5step-lora-r128.safetensors"),
        bytes: 679_604_800,
        sha256: "7096a791d0f19cd083a8d2984b4524398d1d6bdd4e720c303ed17200df83ae2b" },
    ],
    note: "0.68 GB, one file in models/loras. Needs Qwen Image 2.1 (the row above): it rides on that model's own files and adds the Fast draft chip on Pictures. "
      + "Measured 2026-09-24 on a 16 GB card at 1024²: 3.1 s a picture warm against the full render's 11.2 s; batch of 4 at 1344x768 12.1 s against 45.4 s; 1920x1088 6.7 s against 27.2 s; one-reference edit 3.9 s against 15.7 s; two-reference edit only 9.1 s against 20.8 s (2.3x), and both judges preferred the full render there. "
      + "A new prompt still pays the text encode (12.2 s against 22.9 s, about 2x), and switching between a draft and a full render costs a model re-patch each way (+8.8 s into a draft, +2.5 s into a full render), so group drafts together. "
      + "Where it fails: small text (a mirrored R, a reversed E), neon and stencil lettering, and at 1 megapixel fused fingers or a melted face in a crowd; two blind judges put it level with or ahead of the full render on 3 and 8 of 17 prompts. Skin is not waxy. "
      + "Base only: transparent output, masked edits, more than 3 references, CFG above 1, negative prompts and canvases above about 2 MP (measured up to 1920x1088).",
    requires: {
      experimental: true,
      note: "Rides on Qwen Image 2.1 and needs what it needs. Peak VRAM measured the same as the full render (about 15.5 GB of 16 GB, staged): it saves time, not memory.",
    },
  },
  {
    /* KREA 2 TURBO — the 12B open-weights image model, in Comfy-Org's int8
     * repack, run by ComfyUI's own Krea2 model class (a Qwen3-VL 4B encoder
     * read as CLIP type "krea2", the Qwen image VAE). Read off HuggingFace
     * 2026-09-17: revisions pinned per file, sizes and hashes as the files
     * on this rig measured, which matched the publisher's LFS sha256 for
     * both. The VAE is the same file Anima carries (ANIMA_VAE), so a machine
     * with Anima pays nothing for it.
     *
     * The LICENCE is the weights' own: the Krea 2 Community License
     * Agreement (krea.ai/krea-2-licensing, dateModified 2026-06-22) — NOT the
     * Apache-2.0 that krea-ai/krea-2 on GitHub carries, which covers the
     * inference code only. Outputs are yours; commercial use is gated on
     * company-wide revenue; hosts owe content filtering. */
    id: "imageKrea2",
    makes: "picture",
    label: "Images — Krea 2 Turbo (community licence)",
    why: "The frontier open-weights look: photographic realism and fine detail in eight steps. Slower and larger than FLUX.2 klein, and it takes no reference pictures; the one to pick when the picture itself is the product.",
    licence: "Krea 2 Community License Agreement — outputs are yours; commercial use only under USD 1M company-wide annual revenue; content filtering owed by hosts",
    home: "https://huggingface.co/Comfy-Org/Krea-2",
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "You own all Outputs you generate, subject to your compliance with this Agreement.",
      clause: "Krea 2 Community License Agreement (Outputs), with §3 (Commercial Use) setting the condition",
      url: "https://www.krea.ai/krea-2-licensing",
      conditions: [
        "§3, verbatim: \"Commercial Use under this Agreement of the Krea Model, Derivatives, or Outputs is permitted only if you (including all affiliated entities under common ownership or control) have total company-wide annual revenue of less than one million United States dollars ($1,000,000 USD)\". Above that, a commercial licence from opensource@krea.ai.",
        "Press coverage of the licence also cites a 50-seat limit; that figure is not in the sentence quoted here — read the page before relying on either number.",
        "Anyone hosting the model \"must implement reasonable and appropriate Content Filter measures to detect, prevent, and mitigate the generation or distribution of prohibited, harmful, or unlawful content\".",
        "A derived model's name must begin with \"Krea\", and this notice travels with redistributed weights: \"Krea 2 is licensed under the Krea 2 Community License Agreement. For more information, visit https://krea.ai/krea-2-licensing.\"",
        "Worldwide, subject to US export control and sanctions law; no territory list.",
      ],
      note: "The GitHub repository's LICENSE.md is Apache-2.0 and covers the inference code, not these weights. The weights' terms are the community licence above, read from krea.ai on 2026-09-17.",
    },
    required: false,
    files: [
      { url: `${HF}/Comfy-Org/Krea-2/resolve/6b1d7191d84d5ded74d83a1a98211dad0ac8ae25/diffusion_models/krea2_turbo_int8_convrot.safetensors`,
        dest: M("diffusion_models/krea2_turbo_int8_convrot.safetensors"),
        bytes: 13_492_686_496,
        sha256: "8e4eeda70dd5037ab1ba2bef6b417f9f901e26093117cf397f741fc1fdaaf3f1" },
      { url: `${HF}/Comfy-Org/Krea-2/resolve/4aa0eed112bd2780ceea37583edbdcd2df6c2c09/text_encoders/qwen3vl_4b_fp8_scaled.safetensors`,
        dest: M("text_encoders/qwen3vl_4b_fp8_scaled.safetensors"),
        bytes: 5_242_467_968,
        sha256: "54bd5144df0bbc25dd6ccadfcb826b521445a1b06ae5a42570bdd2974ca87094" },
      ANIMA_VAE,
    ],
    note: "18.99 GB in three files: the int8 DiT (13.49 GB), the Qwen3-VL 4B fp8 encoder (5.24 GB, shared with nothing else here) and the Qwen image VAE (254 MB, the same file Anima uses). ComfyUI stages the DiT and the encoder in turn, so it runs on a 16 GB card; the publisher's own recipe is 8 steps at cfg 1.0, euler/simple. No negative prompt (distilled) and no references (FLUX.2's trick). Measured here: see the row's requires note.",
    requires: {
      vramMinGb: 12, vramRecGb: 16, ramMinGb: 32, ramRecGb: 48,
      note: "A 13.5 GB DiT staged into a 16 GB card. MEASURED 2026-09-17 on this RTX 4070 Ti SUPER, 1024² at 8 steps: 52 s for the first picture (most of it the load), 26 s warm — against FLUX.2 klein's 3 s and Z-Image Turbo's 5.8 s. The picture is the reason to wait.",
    },
    variants: [
      { label: "DiT int8 convrot (shipped)", bytes: 13_492_686_496, note: "int8_convrot is native on Ada; the smallest build that is not fp4-emulated here." },
      { label: "DiT fp8 scaled", bytes: 14_100_000_000, note: "The build the published recipes were tested on (approximate size)." },
      { label: "DiT nvfp4", bytes: 7_500_000_000, note: "Blackwell-only fp4; emulated on this card (approximate size)." },
    ],
  },
  {
    id: "imageZImageBase",
    makes: "picture",
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
    makes: "picture",
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
        dest: M("vae/ltx-2.5-video-vae-conv-bf16.safetensors"), bytes: 1452269922,
        /* The DIFFUSION-decoder VAE (CausalDiffusionVAE, 1.47 GB) is what the
         * ComfyUI LTX 2.5 template names. ComfyUI's VAELoader reads either,
         * and config.js loads it when the conv one is absent. */
        alt: ["ltx-2.5-video-vae-bf16.safetensors"] },
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
  /* ─────────────────────────────────────── the control pair (server/control)
   *
   * THE TWO ENTRIES BELOW EXIST BECAUSE A GATE PASSED AND THE CATALOGUE COULD
   * NOT SAY SO. The camera gate (2026-09-02..03) and the pose gate (2026-09-03)
   * both ran on weights fetched onto the bench rig by hand and catalogued
   * nowhere — so server/control/vace.js shipped a licence line that called
   * itself "a pointer, not a settled grant", and NOTICE, which is generated
   * from this file, listed neither model. A capability whose weights are
   * uncatalogued is a capability whose licence does not travel with a fork.
   *
   * ⚠ THE FILES ARE NOT FROM THE REPOSITORY THE MODEL COMES FROM, and the WAN
   * entry turns on that. Every one of the three WAN files on this rig is
   * byte-for-byte Comfy-Org's ComfyUI repackage, proven by sha256 against that
   * repository's own published LFS records:
   *
   *   wan2.1_vace_1.3B_fp16       640ccc0577e6a5d4bb15cd91b11b699ef914fc55f126c5a1c544e152130784f2
   *   umt5_xxl_fp8_e4m3fn_scaled  c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68
   *   wan_2.1_vae                 2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b
   *
   * Upstream Wan-AI/Wan2.1-VACE-1.3B publishes a diffusers layout and does not
   * contain these filenames at all. The repackage ships NO LICENSE FILE — only
   * `license: apache-2.0` in README frontmatter, which is exactly the situation
   * ZIMAGE_RIGHTS documents: frontmatter is a tag, not a document. So the text
   * quoted below is Wan-AI's own LICENSE.txt at a pinned revision, and the
   * entry says out loud that the bytes came from somewhere else. An entry that
   * quoted a document it did not get its bytes from, without mentioning the
   * gap, would be the same failure as trusting the frontmatter.
   *
   * ⚠ THE URLS ARE PINNED TO A COMMIT rather than to `main`, which is different
   * from every other entry here and is deliberate. The licence claim is a claim
   * about THOSE BYTES: each sha256 above was matched against the LFS record at
   * that revision, and `main` can move under a pin the next time a publisher
   * re-uploads. Nothing about this requires the older entries to be changed,
   * and homeFor() still derives a repository page by cutting at /resolve/.
   */
  {
    id: "videoControl",
    /* The CREDIT goes to the authors, not to the repackager whose bytes these
     * are: the Thanks page turns this label into a link to `home`, and a credit
     * pointing at a conversion is half a credit. The download URLs point where
     * the files actually live. The two are allowed to differ, and this is the
     * one entry in the catalogue where they do. */
    home: "https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B",
    label: "Structural control — WAN 2.1 VACE 1.3B",
    why: "Carries a camera move you blocked out yourself. A gray Blender playblast goes in as a control video and the render follows ITS camera instead of inventing one — measured at CMA 0.924 against a 0.50 floor and against its own time-shift null of 0.402 (the arm that really turns the control off, W8 at strength 0.00, scored -0.056). It is the only path here where the camera is yours: H3 has no structural input at all, and LTX's appearance guides were tested on the same blockout and did not follow the move.",
    licence: "Apache-2.0",

    /* VERIFIED to this repository's own standard rather than to a badge.
     * Wan-AI/Wan2.1-VACE-1.3B LICENSE.txt at 574e6a7 is 11,357 bytes and 1,581
     * words; canonical Apache-2.0 fetched from apache.org is 11,358 bytes and
     * 1,581 words. Word-normalised diff: similarity 1.000000, ZERO differing
     * runs across the whole file INCLUDING the appendix, whitespace-normalised
     * md5 identical, and the `[yyyy] [name of copyright owner]` placeholders
     * left unfilled. No addendum, no acceptable-use annexe, no revenue ceiling
     * and NO TERRITORY CLAUSE — which is why this adds no row to
     * server/territory_test.js and H3 stays the only region-locked entry. */
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: APACHE_GRANT,
      clause: "Apache-2.0 §2 (Grant of Copyright License)",
      url: "https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B/blob/574e6a744642ce3bee319afc31496b88bde8aac4/LICENSE.txt",
      note: PERMISSIVE_NOTE + " WAN then says it a second time in its own words, and this is the "
        + "sentence to read if one is all you want — README, “License Agreement”, at the same "
        + "revision, quoted with its own typo intact: “The models in this repository are licensed "
        + "under the Apache 2.0 License. We claim no rights over the your generated contents, granting "
        + "you the freedom to use them while ensuring that your usage complies with the provisions of "
        + "this license.” ⚠ The gap, stated rather than smoothed over: the three files Studio "
        + "downloads are Comfy-Org's ComfyUI repackage, matched to their published sha256 byte for "
        + "byte, and that repository carries no LICENSE file — only a frontmatter tag. That its fp16 "
        + "build is a conversion of Wan-AI's own weights rests on Comfy-Org's `base_model` declaration "
        + "plus the filename, which is an inference: far stronger than a tag, weaker than the licence "
        + "text, and provable outright only by downloading the upstream original to compare.",
    },
    files: [
      { url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/617a7633e636506f850e043bc4605f290a466a8e/split_files/diffusion_models/wan2.1_vace_1.3B_fp16.safetensors`,
        dest: M("diffusion_models/wan2.1_vace_1.3B_fp16.safetensors"), bytes: 4309519800 },
      { url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/617a7633e636506f850e043bc4605f290a466a8e/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`,
        dest: M("text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"), bytes: 6735906897 },
      { url: `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/617a7633e636506f850e043bc4605f290a466a8e/split_files/vae/wan_2.1_vae.safetensors`,
        dest: M("vae/wan_2.1_vae.safetensors"), bytes: 253815318 },
    ],
    note: "11.3 GB, and the cheapest way in this catalogue to get a camera you chose rather than one the model invented. Measured here at 32 minutes for 1280x704 x 121 frames at 20 steps — slow, because the point is the move and not the minute. ⚠ ONE OPERATING POINT: that size is the only one anything has been measured at, and server/control/vace.js refuses every other size WITH THE REASON rather than snapping to a number nobody rendered. Residual strength 1.00 is the shipped default and the ladder either side of it was measured too — 0.50 also passes, 0.25 does nothing, and 2.00 stops generating and hands the blockout back. The umt5-xxl text encoder is shared with nothing else here, so this row costs its full size.",
    requires: {
      vramMinGb: 8, vramRecGb: 16, ramMinGb: 16, ramRecGb: 32,
      note: "16 GB of VRAM and 32 GB of RAM is what the gate actually ran on, at 32 minutes for a "
        + "121-frame 1280x704 clip, so the recommendation is exactly the machine that was measured. "
        + "The MINIMA are derived rather than measured, by the same argument Z-Image's entry sets out: "
        + "the 6.74 GB encoder and the 4.31 GB transformer never have to be resident together, because "
        + "ComfyUI encodes the prompt, frees the encoder and then loads the DiT. Nothing has been "
        + "rendered on a smaller card — treat 8 GB as the floor the file sizes imply, not as a number "
        + "somebody watched work.",
    },
  },
  {
    id: "posePreprocess",
    /* Credit to the authors again rather than to the conversions: DWPose is
     * IDEA-Research's and its detector is Megvii's YOLOX. hr16 re-uploaded both
     * as TorchScript, and that is where the bytes come from. */
    home: "https://github.com/IDEA-Research/DWPose",
    label: "Pose extraction — DWPose (TorchScript)",
    why: "Reads a person out of a video as a skeleton, which is what the control path steers a performance with — the other half of the door the camera control opens. Measured: a 121-frame skeleton drove a render whose own joints landed 33.7 px from the control's, against a frozen-skeleton null of 119.9 px.",

    /* ⚠ TWO FILES, TWO ANSWERS, AND THE WEAKER ONE GOVERNS THE ROW.
     *
     * The bbox detector is settled. hr16/yolox-onnx ships no LICENSE file and a
     * 127-byte model card, but the upstream that card names — Megvii's YOLOX —
     * has one, and it diffs clean: the terms body through END OF TERMS AND
     * CONDITIONS is IDENTICAL to canonical Apache-2.0, 1,413 words on both
     * sides, whitespace-normalised md5 equal, similarity 1.000000. The only two
     * differences sit inside the appendix EXAMPLE — `"[]"` became `"{}"`, and
     * the placeholder copyright line was filled in. No operative clause moved.
     *
     * The pose estimator is NOT settled, and that is where this row's answer
     * comes from. hr16/DWPose-TorchScript-BatchSize5 ships no LICENSE file and
     * its ENTIRE model card is 28 bytes: three lines of frontmatter, no prose,
     * no statement of what was converted. The "original" usually cited,
     * yzd-v/DWPose, is ALSO 28 bytes of frontmatter with no LICENSE file. The
     * only real document anywhere in the chain is IDEA-Research/DWPose's
     * LICENSE on GitHub, and it too diffs clean — same 1,413-word body, md5
     * equal, its differences an appendix copyright and an appended MMPose
     * attribution that is itself Apache-2.0. BUT NOTHING ASSERTS THAT THIS FILE
     * IS THAT MODEL. `dw-ll_ucoco_384` matches a checkpoint in that README's
     * table and `_bs5` reads as the batch-5 conversion: a filename match and a
     * 28-byte tag.
     *
     * By this catalogue's own standard that is a pointer, not a grant — the
     * identical verdict imageIdeogram carries, for the identical reason
     * ZIMAGE_RIGHTS refuses to cite HuggingFace frontmatter. So the row is
     * `unknown`. One of its two halves is verified and the row does not get to
     * average them, because the half nobody has read is the half that draws the
     * skeleton.
     */
    licence: "Split: Apache-2.0 + terms unread — the YOLOX bbox detector's Apache-2.0 was diffed against the canonical text and every operative clause is identical; the DWPose estimator's redistributor ships no LICENSE file and a 28-byte model card, so its terms have been read by nobody here.",
    outputRights: {
      class: "unknown",
      sellable: null,
      quote: "",
      clause: "",
      /* An `unknown` still has to link somewhere a person can read — the
       * catalogue guard in provenance_test.js requires a url on every entry,
       * the unknowns included. This is the document the chain POINTS at and
       * cannot be shown to reach, which is the honest thing to hand somebody
       * who wants to decide for themselves. */
      url: "https://github.com/IDEA-Research/DWPose/blob/main/LICENSE",
      note: "Half of this capability is verified and half is not, and the unread half is the one that "
        + "makes the skeleton, so the row answers with the weaker of the two. The detector "
        + "(yolox_l.torchscript.pt) is Apache-2.0: Megvii's own LICENSE was diffed against the "
        + "canonical text and every operative clause is identical. The estimator "
        + "(dw-ll_ucoco_384_bs5.torchscript.pt) has no readable terms at all — its redistributor's "
        + "entire model card is 28 bytes of frontmatter with no LICENSE file, and so is the card of "
        + "the yzd-v/DWPose repository usually named as its origin. The Apache-2.0 licence linked "
        + "above, IDEA-Research's, is reached only by a filename match, and a filename is not a grant. "
        + "In practice a skeleton is a measurement of a video you supplied, and the clip it goes on to "
        + "steer carries the RENDERING model's terms — WAN 2.1 VACE's, which are settled Apache-2.0 — "
        + "so this is narrower than it sounds. Read the chain yourself before relying on the skeleton "
        + "itself being licensed. Separately, and binding whoever trained the model rather than "
        + "whoever runs it: DWPose was trained on COCO-WholeBody and UBody, which carry dataset terms "
        + "of their own.",
    },

    /* ⚠ THE DESTINATION IS INSIDE A CUSTOM NODE PACK, not models/. That is
     * where comfyui_controlnet_aux looks, and the only place it looks — and
     * pre-placing a file really does prevent the download rather than racing
     * it: its own custom_hf_download() begins `if not os.path.exists(
     * model_path)` (src/custom_controlnet_aux/util.py:297), so a file already
     * sitting there is used as it stands. This is the OPPOSITE of the demucs
     * entry a few hundred lines up, which lists no files at all precisely
     * because demucs ignores anything we could put on disk and fetches its own
     * bundles regardless. Two capabilities, two behaviours, both checked.
     *
     * It also gives this row an honest readiness for free: the path exists only
     * once the node pack is cloned, so a machine without the pack reports these
     * files missing instead of reporting ready and then failing inside the
     * engine on a class_type nobody installed. */
    files: [
      { url: `${HF}/hr16/yolox-onnx/resolve/a124b32c3b7c5cebda1c7cd96178f0f9d2050125/yolox_l.torchscript.pt`,
        dest: CK("hr16/yolox-onnx/yolox_l.torchscript.pt"), bytes: 217697649 },
      { url: `${HF}/hr16/DWPose-TorchScript-BatchSize5/resolve/359d662a9b33b73f6d0f21732baf8845f17bb4be/dw-ll_ucoco_384_bs5.torchscript.pt`,
        dest: CK("hr16/DWPose-TorchScript-BatchSize5/dw-ll_ucoco_384_bs5.torchscript.pt"), bytes: 135059124 },
    ],
    note: "353 MB, and 26.4 s to read a 121-frame 1280x704 clip on this rig. Both files are the TorchScript builds ON PURPOSE, and neither default would have picked them: the node's own default bbox detector is the ONNX one, and loading that drags in onnxruntime — which here is the CPU build the DAW's transcription depends on, so the wrong default breaks a feature in a different half of the app and nothing about a pose extraction would tell you why. ⚠ Needs the ComfyUI node pack comfyui_controlnet_aux (Fannovel16, Apache-2.0 — its LICENSE.txt was diffed against the canonical text and is identical, zero differences across the whole file); the files above live inside that pack's own ckpts/ folder, so this row cannot read ready until the pack is cloned. ⚠ And the limit the pose gate found: DWPose saw no figure in 43 of 121 flat-shaded anime output frames, because yolox is trained on photographs. It reads live footage well and drawings badly.",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "Small and quick beside everything else here — 26.4 s for 121 frames at 1280x704, measured "
        + "in the pose gate and kept in server/control/pose.js as POSE_GATE.extraction_seconds. It "
        + "runs before the render rather than beside it, so it never competes with the clip engine "
        + "for the card.",
    },
  },
  /* ── the depth pair (server/control/depth.js) ─────────────────────────
   *
   * THE THIRD CONTROL DOOR, and the one the video-to-video restyle rests on:
   * a depth video keeps where everything is and how far while the prompt and
   * a reference supply the look. Two rows for one estimator because the two
   * models the card offers carry DIFFERENT terms — the authors' README says it
   * in one sentence: "Depth-Anything-V2-Small model is under the Apache-2.0
   * license. Depth-Anything-V2-Base/Large/Giant models are under the
   * CC-BY-NC-4.0 license." — and a row that averaged them would be the
   * overstatement posePreprocess refuses. The Small row is the default and the
   * sellable one; server/control/depth.js picks it unless asked, because the
   * node's OWN default is the Large model.
   *
   * Destination as the DWPose row: inside comfyui_controlnet_aux's ckpts
   * folder, where its loader looks first and downloads only if the file is
   * absent (util.py:297), so a pre-placed file is used as it stands. */
  {
    id: "depthPreprocess",
    group: "video",   // Models screen section: feeds the video / Motion look path, not music
    home: "https://github.com/DepthAnything/Depth-Anything-V2",
    label: "Depth extraction — Depth Anything V2 Small",
    why: "Reads a video as depth — where everything is and how far — which is what the control path steers a RESTYLE with: the person, the room and the move survive, the look is the prompt's. The third door beside the camera blockout and the DWPose skeleton, and the one the audio-reactive video-to-video recipe rests on.",
    licence: "Apache-2.0 — the model authors' own statement, README “LICENSE”: “Depth-Anything-V2-Small model is under the Apache-2.0 license.” The HuggingFace card carries the same tag. ⚠ A stated grant, not a diffed one: the repository ships Apache-2.0 for its code and states the Small weights' terms in that one sentence; no licence text specific to the weights exists to normalise.",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: "Depth-Anything-V2-Small model is under the Apache-2.0 license.",
      clause: "README, LICENSE section (DepthAnything/Depth-Anything-V2, main); Apache-2.0 §2",
      url: "https://github.com/DepthAnything/Depth-Anything-V2#license",
      note: "Apache-2.0 §2 grants the usual rights over the Work and says nothing about generated material; a depth video is a measurement of a clip you supplied, and the clip it goes on to steer carries the RENDERING model's terms — WAN 2.1 VACE's, settled Apache-2.0. The one thing to know: the Large model in the row beside this one is CC-BY-NC-4.0, and the card defaults to this one for exactly that reason.",
    },
    files: [
      { url: `${HF}/depth-anything/Depth-Anything-V2-Small/resolve/03876f8651c73a60fe4c2c48294e09fcb6838fcf/depth_anything_v2_vits.pth`,
        dest: CK("depth-anything/Depth-Anything-V2-Small/depth_anything_v2_vits.pth"), bytes: 99218434,
        sha256: "715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378" },
    ],
    note: "99 MB. The destination is inside comfyui_controlnet_aux's own ckpts folder, where its loader looks first and downloads only if the file is absent — the same arrangement the DWPose row uses. ⚠ The node's own default is the LARGE model; server/control/depth.js picks this one unless asked, and the control card says which one made each depth video.",
    requires: {
      vramMinGb: 2, vramRecGb: 4, ramMinGb: 8, ramRecGb: 16,
      note: "A ViT-S at 518 px per frame — small beside everything else here, and it runs before the "
        + "render rather than beside it, so it never competes with the clip engine for the card.",
    },
  },
  {
    id: "depthPreprocessLarge",
    group: "video",   // Models screen section: feeds the video / Motion look path, not music
    home: "https://github.com/DepthAnything/Depth-Anything-V2",
    label: "Depth extraction — Depth Anything V2 Large (non-commercial)",
    why: "The same estimator with a ViT-L backbone: finer edges in the depth video, at 1.3 GB and under a NON-COMMERCIAL licence. Offered as a named choice on the control card, never the default.",
    licence: "CC-BY-NC-4.0 — the model authors' own statement, README “LICENSE”: “Depth-Anything-V2-Base/Large/Giant models are under the CC-BY-NC-4.0 license.” Non-commercial use only.",
    outputRights: {
      class: "not-for-sale",
      sellable: false,
      quote: "Depth-Anything-V2-Base/Large/Giant models are under the CC-BY-NC-4.0 license.",
      clause: "README, LICENSE section; CC-BY-NC-4.0 §2(a)(1) licenses reproduction and sharing for NonCommercial purposes only",
      url: "https://github.com/DepthAnything/Depth-Anything-V2#license",
      note: "A depth video from this model is a NonCommercial use of the model, so a clip steered with it should not be sold. Use the Small row for anything commercial; the control card records which model made each depth video.",
    },
    files: [
      { url: `${HF}/depth-anything/Depth-Anything-V2-Large/resolve/cbbb86a30ce19b5684b7a05155dc7e6cbc7685b9/depth_anything_v2_vitl.pth`,
        dest: CK("depth-anything/Depth-Anything-V2-Large/depth_anything_v2_vitl.pth"), bytes: 1341395338,
        sha256: "a7ea19fa0ed99244e67b624c72b8580b7e9553043245905be58796a608eb9345" },
    ],
    note: "1.3 GB, optional, NON-COMMERCIAL. The Small row is the default and the sellable one.",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "A ViT-L at 518 px per frame; still well under the video model it runs before.",
    },
  },
  /* ── the Motion look's three rows (server/animatediff.js) ──────────────
   *
   * Yvann's VideoToVideo stack, the pieces of it whose licences allow them
   * to ship: the AnimateDiff v3 motion module and its domain adapter
   * (Apache-2.0, guoyww), an SD1.5 checkpoint (CreativeML Open RAIL-M) and
   * ControlNet v1.1 depth + line art (OpenRAIL). Every file below is
   * matched to its publisher's sha256; the ones already on this rig were
   * matched before a row was written. The NODE PACK the module needs —
   * ComfyUI-AnimateDiff-Evolved, Apache-2.0 — is a git clone into the
   * engine's custom_nodes at a pinned commit (README, "Motion"), not a file
   * this catalogue downloads; and the two nodes that make core ControlNet
   * work under its sliding window and put one prompt per frame are OURS,
   * shipped in server/comfy_nodes/. What is NOT here, on purpose:
   * IPAdapter_plus and Advanced-ControlNet (GPL-3.0), AnimateLCM (no
   * licence text), the LiquidAF motion LoRA (no readable terms). */
  {
    id: "animateDiffV3",
    group: "video",   // Models screen section: feeds the video / Motion look path, not music
    home: "https://github.com/guoyww/AnimateDiff",
    label: "Motion module — AnimateDiff v3 (SD1.5)",
    why: "What turns SD1.5 into a video model: the motion module renders a whole piece as one batch through sliding 16-frame windows, so the frames agree with each other instead of flickering. The Reactive screen's Motion look runs on it, with depth and line art holding the figure and the look changing on the bars.",
    licence: "Apache-2.0 — guoyww/AnimateDiff ships LICENSE.txt (Apache-2.0) and the HuggingFace weights repository carries the same tag; both files here are matched to that repository's sha256 at a pinned revision.",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: "Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.",
      clause: "Apache-2.0 §2 (Grant of Copyright License)",
      url: "https://github.com/guoyww/AnimateDiff/blob/main/LICENSE.txt",
      note: PERMISSIVE_NOTE + " The motion module is one of three models a Motion render runs on; the SD1.5 checkpoint and the ControlNets carry their own rows and their own terms, and the render's rights are the narrowest of the three (the checkpoint's OpenRAIL-M conditions).",
    },
    files: [
      { url: `${HF}/guoyww/animatediff/resolve/fdfe36afa161e51b3e9c24022b0e368d59e7345e/v3_sd15_mm.ckpt`,
        dest: M("animatediff_models/v3_sd15_mm.ckpt"), bytes: 1673262583,
        sha256: "2412711886f61091846f53204aabc38aa6e09356d62a9808abe4daa802168343" },
      { url: `${HF}/guoyww/animatediff/resolve/fdfe36afa161e51b3e9c24022b0e368d59e7345e/v3_sd15_adapter.ckpt`,
        dest: M("loras/v3_sd15_adapter.ckpt"), bytes: 102134097,
        sha256: "fd2d8e26480f6ab013c1e6af86fdf1dedbb1ed5baf850ccd5f365f39d6c3472c" },
    ],
    note: "1.8 GB: the v3 motion module and its domain-adapter LoRA (loaded on the checkpoint at 1.0, as the reference workflow does). Measured: 60 frames at 768x432 with two ControlNets in 199 s on the 16 GB card. ⚠ Needs the ComfyUI-AnimateDiff-Evolved node pack (Apache-2.0) in the engine's custom_nodes — a git clone at the README's pinned commit, not a download this row makes.",
    requires: {
      vramMinGb: 6, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "SD1.5 plus the motion module plus two ControlNets, a 16-frame window at a time; measured at 768x432 on 16 GB.",
    },
  },
  {
    id: "animateDiffSparseCtrl",
    group: "video",   // Models screen section: feeds the video / Motion look path, not music
    home: "https://github.com/guoyww/AnimateDiff",
    label: "Source on the hits — SparseCtrl RGB (AnimateDiff v3)",
    why: "The reference audio-reactive workflow anchors its render to the SOURCE frame on every drum hit through SparseCtrl: the punch of its hits, and the dancer's own colours flickering through the paint. Reactive's Motion look does the same through our own node (server/comfy_nodes/aiplay_sparsectrl.py), keyframes per sliding window.",
    licence: "Apache-2.0 — guoyww/AnimateDiff ships LICENSE.txt (Apache-2.0) and the HuggingFace weights repository carries the same tag; the file is matched to that repository's LFS sha256 at a pinned revision (checked 2026-09-19).",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: "Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.",
      clause: "Apache-2.0 §2 (Grant of Copyright License)",
      url: "https://github.com/guoyww/AnimateDiff/blob/main/LICENSE.txt",
      note: PERMISSIVE_NOTE + " One of the models a Motion render with the source hold runs on; the SD1.5 checkpoint and the two ControlNets carry their own rows and their own terms, and the render's rights are the narrowest of the set.",
    },
    files: [
      { url: `${HF}/guoyww/animatediff/resolve/fdfe36afa161e51b3e9c24022b0e368d59e7345e/v3_sd15_sparsectrl_rgb.ckpt`,
        dest: M("controlnet/v3_sd15_sparsectrl_rgb.ckpt"), bytes: 1988040333,
        sha256: "c93f27a3cd15edf99bbddf4522509f2e831f515cc7db9c820d955037ddafbe45" },
    ],
    note: "2.0 GB: the v3 SparseCtrl RGB ControlNet — a latent-condition ControlNet with eight temporal layers, loaded by our own node. ⚠ Loads and forwards on the CPU (every key, 2026-09-19); not yet measured on the card.",
    requires: {
      vramMinGb: 8, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "Beside SD1.5, the motion module and the two ControlNets of a Motion render; an extra ControlNet-sized network per window.",
    },
  },
  {
    id: "sd15Dreamshaper8",
    group: "images",  // Models screen section: an SD1.5 image model (the Motion look also uses it)
    home: "https://civitai.com/models/4384/dreamshaper",
    label: "SD1.5 checkpoint — DreamShaper 8 (the Motion look's painter)",
    why: "The image model the motion module animates. DreamShaper 8 is the SD1.5 fine-tune the reference workflow paints with; any SD1.5 checkpoint would run, this one is what was measured.",
    licence: "CreativeML Open RAIL-M — the licence DreamShaper is published under on Civitai and the licence of the SD1.5 base it fine-tunes. ⚠ The HuggingFace mirrors (digiplay, jzli, KatarLegacy — all three carry these exact bytes, matched by sha256) tag it 'other' and ship no licence file, so the terms quoted are the CreativeML Open RAIL-M text, not a document that travels with the file.",
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "Except as set forth herein, Licensor claims no rights in the Output You generate using the Model. You are accountable for the Output you generate and its subsequent uses. No use of the output can contravene any provision as stated in the License.",
      clause: "CreativeML Open RAIL-M, Section III §6 (The Output You Generate)",
      url: "https://huggingface.co/spaces/CompVis/stable-diffusion-license",
      conditions: [
        "Attachment A's use restrictions travel with the model and with what you make with it: nothing unlawful, nothing that harms or exploits people or minors, no medical advice presented as fact, no discrimination, no disinformation, no impersonation without consent (Section III §5 and Attachment A).",
        "A Motion render's rights are these conditions plus nothing narrower from the other two rows — the motion module is Apache-2.0 and the ControlNets are OpenRAIL of the same family.",
      ],
      note: "OpenRAIL-M keeps the outputs yours and puts a use-restriction list on the model; for a music video that list is not in the way. The mirrors' lack of a licence file is why this row quotes the base text and says so.",
    },
    files: [
      { url: `${HF}/digiplay/DreamShaper_8/resolve/a5883e31f50b133f37342aadb482e1405cb4b008/dreamshaper_8.safetensors`,
        dest: M("checkpoints/dreamshaper_8.safetensors"), bytes: 2132625894,
        sha256: "879db523c30d3b9017143d56705015e15a2cb5628762c11d086fed9538abd7fd" },
    ],
    note: "2.1 GB. The same bytes on three HuggingFace mirrors; this row pins one at a revision and checks the hash.",
    requires: {
      vramMinGb: 4, vramRecGb: 8, ramMinGb: 8, ramRecGb: 16,
      note: "An SD1.5 checkpoint; the motion module beside it is what sets the real requirement.",
    },
  },
  {
    id: "controlNetSd15",
    group: "images",  // Models screen section: an SD1.5 image model (the Motion look also uses it)
    home: "https://github.com/lllyasviel/ControlNet-v1-1-nightly",
    label: "ControlNet v1.1 — depth and line art (SD1.5, fp16)",
    why: "What holds the figure while the motion module repaints it: the depth video (from the control path's Depth Anything V2 Small) and a line-art reading of the clip, each pushing the render towards the source's structure at the strengths the reference workflow uses.",
    licence: "OpenRAIL — lllyasviel/ControlNet-v1-1's model card tag. ⚠ The bytes here are comfyanonymous's fp16 repack, matched to that repository's sha256 at a pinned revision; the repack carries no tag and no licence file, and neither does the original ship one, so this is a tag, not a diffed text.",
    outputRights: {
      class: "yours-with-conditions",
      sellable: true,
      quote: "Except as set forth herein, Licensor claims no rights in the Output You generate using the Model.",
      clause: "OpenRAIL family (CreativeML Open RAIL-M Section III §6 wording); the card's tag is \"openrail\"",
      url: "https://huggingface.co/lllyasviel/ControlNet-v1-1",
      conditions: [
        "The OpenRAIL use restrictions (Attachment A of the RAIL-M family) apply to the model and to its outputs.",
        "A ControlNet steers a render; the picture's rights are the checkpoint's row. Read this row as the tag it is.",
      ],
      note: "Two files, one answer: both are v1.1 ControlNets from the same author under the same tag.",
    },
    files: [
      { url: `${HF}/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/ab830a51c5c573a5b85bfdbaa3ae0ab7e1baf5f7/control_v11f1p_sd15_depth_fp16.safetensors`,
        dest: M("controlnet/control_v11f1p_sd15_depth_fp16.safetensors"), bytes: 722601100,
        sha256: "1c4a79aa52fb63f607cb9ff479ea5aa1923b6ceb21267bd14b69bd05d7b617be" },
      { url: `${HF}/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/ab830a51c5c573a5b85bfdbaa3ae0ab7e1baf5f7/control_v11p_sd15_lineart_fp16.safetensors`,
        dest: M("controlnet/control_v11p_sd15_lineart_fp16.safetensors"), bytes: 722601100,
        sha256: "10559106d1bb8196298b7a81565ede9279295d2b2df15165b9dbe189994def56" },
    ],
    note: "1.4 GB for the pair. Under AnimateDiff's sliding window they load through our own AiplayControlNetLoaderSliding (server/comfy_nodes/), which serves each window its own frames of the hint — the reason the GPL Advanced-ControlNet pack is not needed.",
    requires: {
      vramMinGb: 4, vramRecGb: 8, ramMinGb: 8, ramRecGb: 16,
      note: "Two fp16 ControlNets beside SD1.5; measured within the motion module's 16 GB run.",
    },
  },
  /* ── the picture-reference pair (server/comfy_nodes/aiplay_ipadapter.py) ──
   *
   * The reference workflow carries its look on pictures through IP-Adapter.
   * The node pack it uses is GPL-3.0; the METHOD (tencent-ailab/IP-Adapter)
   * and the WEIGHTS (h94/IP-Adapter) are Apache-2.0 and the CLIP tower is
   * laion's MIT model, so the node is ours and these two rows are the files
   * it reads — both matched to h94's repository by sha256. */
  {
    id: "ipAdapterSd15",
    group: "images",  // Models screen section: an SD1.5 image model (the Motion look also uses it)
    home: "https://github.com/tencent-ailab/IP-Adapter",
    label: "Picture references — IP-Adapter Plus (SD1.5)",
    why: "Puts a picture's look into every cross-attention layer of SD1.5 as sixteen extra tokens, so the pictures you pick set the style of a Motion render and can switch on the drum hits with a short cross-fade — the reference audio-reactive workflow's way. Read by our own node (server/comfy_nodes/aiplay_ipadapter.py), written from the Apache-2.0 reference.",
    licence: "Apache-2.0 — tencent-ailab/IP-Adapter's LICENSE and the h94/IP-Adapter weights repository's tag; the file is matched to that repository's sha256 at a pinned revision.",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: "Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form.",
      clause: "Apache-2.0 §2 (Grant of Copyright License)",
      url: "https://github.com/tencent-ailab/IP-Adapter/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " An adapter steers a render; the picture's rights are the checkpoint's row (sd15Dreamshaper8) — and the pictures you feed it are yours to begin with.",
    },
    files: [
      { url: `${HF}/h94/IP-Adapter/resolve/018e402774aeeddd60609b4ecdb7e298259dc729/models/ip-adapter-plus_sd15.safetensors`,
        dest: M("ipadapter/ip-adapter-plus_sd15.safetensors"), bytes: 98183288,
        sha256: "a1c250be40455cc61a43da1201ec3f1edaea71214865fb47f57927e06cbe4996" },
    ],
    note: "98 MB. The Plus variant (a 16-token perceiver projection) is the one the reference workflow runs at high strength. Needs the CLIP tower in the row beside it.",
    requires: { vramMinGb: 4, vramRecGb: 8, ramMinGb: 8, ramRecGb: 16, note: "Two small projections per attention layer; the tower beside it is the real cost." },
  },
  {
    id: "clipVisionH",
    group: "images",  // Models screen section: an SD1.5 image model (the Motion look also uses it)
    home: "https://huggingface.co/laion/CLIP-ViT-H-14-laion2B-s32B-b79K",
    label: "CLIP vision tower — ViT-H/14 (LAION-2B)",
    why: "The eyes of the picture references: IP-Adapter reads each picture through this tower's penultimate layer. The bytes are the copy h94/IP-Adapter ships as its image encoder, which is laion's OpenCLIP ViT-H — matched by sha256.",
    licence: "MIT — laion/CLIP-ViT-H-14-laion2B-s32B-b79K's licence tag; the copy downloaded here sits in h94/IP-Adapter (Apache-2.0) as models/image_encoder/model.safetensors and is matched to it by hash. ⚠ A tag on both sides, not a diffed text.",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.",
      clause: "MIT License, grant paragraph",
      url: "https://huggingface.co/laion/CLIP-ViT-H-14-laion2B-s32B-b79K",
      note: "An encoder that reads pictures; it makes nothing. The rights of what a Motion render makes are the checkpoint's.",
    },
    files: [
      { url: `${HF}/h94/IP-Adapter/resolve/018e402774aeeddd60609b4ecdb7e298259dc729/models/image_encoder/model.safetensors`,
        dest: M("clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"), bytes: 2528373448,
        sha256: "6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030" },
    ],
    note: "2.5 GB. Saved under the name ComfyUI's CLIPVisionLoader lists; loaded for the seconds it takes to read the pictures, then unloaded.",
    requires: { vramMinGb: 4, vramRecGb: 8, ramMinGb: 8, ramRecGb: 16, note: "A 2.5 GB tower, resident only while the pictures are read." },
  },
  /* ──────────────────────────────────────── the mesh pair (server/mesh/)
   *
   * TWO ROWS THAT MAKE NEITHER A PICTURE NOR A VIDEO, and the catalogue can now
   * say so out loud: `makes: "mesh"`. That field is the positive rule
   * isPictureModel() reads, and the reason these rows can exist at all without
   * the Images screen quietly offering a 3D transformer as somebody's picture
   * model — which is exactly what a subtraction did to WAN 2.1 VACE on
   * 2026-09-03, with every suite green while it did it.
   *
   * ⚠ NEITHER ROW CARRIES A `region` FIELD, AND THAT IS LOAD-BEARING RATHER
   * THAN AN OMISSION. `excludedTerritories()` THROWS when two region-limited
   * rows disagree, so a territory list typed here would either have to match
   * H3's (a claim about a licence that says nothing of the sort) or break the
   * build for every reader of that function. Both of these are MIT — code and
   * weights — and that is precisely WHY they were chosen over the obvious
   * alternative: Hunyuan3D's licence excludes the European Union, so it could
   * not be installed, depended on, or catalogued here at all.
   *
   * ⚠ AND WHY THIS IS A SECOND PYTHON. See server/mesh/runner.js: TripoSG needs
   * a modern diffusers, and the engine's interpreter is pinned at
   * diffusers 0.7.0.dev0 under torch 2.5.1+cu121 because the music model's
   * fused kernels exist only on that build. `pip install` into that environment
   * while the owner's engine is resident is not a risk, it is a breakage with a
   * delay on it. So these weights are read by a subprocess in their own venv,
   * and nothing in this app ever imports them.
   */
  {
    id: "meshFromImage",
    /* NOT "picture". A .glb is not something the Images screen may offer, and
     * `makes` is how a row says what it is instead of being sorted by what it
     * is not. */
    makes: "mesh",
    home: "https://huggingface.co/VAST-AI/TripoSG",
    label: "3D mesh from a picture — TripoSG 1.5B",
    why: "Turns one reference sheet into a mesh, so a cast prop is the same object in every shot.",
    licence: "MIT",

    /* MIT reaches the software, not the mesh. Same shape as the demucs entry
     * above it and for the same reason: there is no term in this licence that
     * attaches to what you generate, so the answer to "may I sell it" is yes
     * with nothing after it. */
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: MIT_GRANT,
      clause: "MIT License, grant paragraph (TripoSG LICENSE, VAST-AI-Research)",
      url: "https://github.com/VAST-AI-Research/TripoSG/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " A mesh made from your own reference sheet is yours outright — "
        + "no attribution, no revenue ceiling, and no territory. The territory sentence is not "
        + "decoration: it is the difference between this model and the one it was chosen over.",
    },

    /* ⚠ PLACEHOLDER FILE FACTS — bytes and sha256 are AWAITING_MEASUREMENT, and
     * the URLs below are this side's best reading of the repository rather than
     * a fetch anybody performed. The parallel strand that installs the venv
     * reports all three, and server/mesh/catalogue_test.js fails until they are
     * written in. Until then `ready` is false, download() refuses on
     * `awaiting`, and the runner refuses before it spends anything. */
    /* MEASURED on this machine 2026-09-06: every dest below was stat'd and
     * sha256'd off the disk, and each hash was cross-checked against the HF
     * API's LFS oid for the same path. `awaiting` is gone because the facts
     * are here; server/mesh/catalogue_test.js turns green on that alone. */
    files: [
      /* `identifies` — THE FILE THAT MAY CLAIM A RENDER, and it is a PATH TAIL
       * rather than a flag. engine/record.js's modelKeyFromFiles() otherwise
       * trusts only a dest under diffusion_models or unet, and nothing here is
       * in the engine's tree at all.
       *
       * ⚠ THE TAIL IS THE SAFETY, not decoration. These weights keep the
       * diffusers layout their loader requires, so the basename is
       * `diffusion_pytorch_model.safetensors` — what every diffusers repository
       * on earth calls its weights. Matching on that would hand TripoSG's
       * licence to any graph that loaded any diffusers checkpoint, which is the
       * shared-Qwen3-4B defect in a new coat. Matching on the tail cannot.
       *
       * It is on the transformer alone and deliberately NOT on the DINOv2
       * encoder below: that encoder is a general-purpose file, and a shared file
       * that may claim a render is the exact thing being avoided. */
      { url: `${HF}/VAST-AI/TripoSG/resolve/main/transformer/diffusion_pytorch_model.safetensors`,
        dest: MESH("TripoSG/transformer/diffusion_pytorch_model.safetensors"),
        identifies: "TripoSG/transformer/diffusion_pytorch_model.safetensors",
        bytes: 5_758_280_104,
        sha256: "9192b5923f7b605b394192809aa2ceb73bf0f4009674d8e3b999b45bb97d4bf2" },
      { url: `${HF}/VAST-AI/TripoSG/resolve/main/vae/diffusion_pytorch_model.safetensors`,
        dest: MESH("TripoSG/vae/diffusion_pytorch_model.safetensors"),
        bytes: 970_685_468,
        sha256: "a2e667c24927a5a35e5f19fcb4c75890e9399aa966b6db8131d7df733a750c8b" },
      /* ⚠ THE ENCODER SHIPS INSIDE THE TripoSG REPO, at image_encoder_dinov2/,
       * which is the folder model_index.json names. This row pointed at
       * facebook/dinov2-large, where the weights ORIGINATE — fetching that copy
       * would have written a file the loader never opens and left the one it
       * needs missing, while the row reported ready. */
      { url: `${HF}/VAST-AI/TripoSG/resolve/main/image_encoder_dinov2/model.safetensors`,
        dest: MESH("TripoSG/image_encoder_dinov2/model.safetensors"),
        bytes: 1_217_522_888,
        sha256: "399fba97a95f22c36834418bc69373364a99af3a1153da1c0fb31db567c92e23" },
    ],
    approxBytes: 7_946_488_460,
    note: "7.95 GB, measured. Image to mesh: one single-panel reference in, a .glb out — no "
      + "texture and not watertight: the one measured run came back as 247 separate bodies, of "
      + "which the figure was 92% of the surface area. The missing texture is the point rather "
      + "than a shortfall, because what a cast prop needs to hold is its SHAPE. Runs in its own python (see the pair note above), never in the engine's. "
      + "Byte counts and hashes below were measured off this machine's disk and cross-checked "
      + "against the publisher's LFS oids. ⚠ The geometry comes out of the HIERARCHICAL marching-"
      + "cubes decoder, not TripoSG's DiffDMC flash decoder, because diso is source-only and this "
      + "box has no MSVC — server/mesh/mesh_cli.py says so where it sets the flag.",
    requires: {
      vramMinGb: 4, vramRecGb: 12, ramMinGb: 16, ramRecGb: 32,
      note: "MEASURED on this machine. The two figures are not a range, they are two loading "
        + "strategies, and server/mesh/runner.js picks between them from the live card: with more "
        + "than the RECOMMENDED 12 GB free the three modules stay resident together; below it the "
        + "run pages them in one at a time (enable_model_cpu_offload) and PEAKS AT 3,157 MiB of torch allocation "
        + "(3,777 MiB of nvidia-smi footprint over a whole run, measured against this card's own "
        + "resident baseline). "
        + "The minimum is that peak plus headroom. This is the number the runner refuses against, "
        + "so it decides whether the capability is reachable at all beside somebody else's work — "
        + "the previous 8 GB here was the publisher's stated figure for full residency, and it "
        + "refused every run on this 16 GB card with the music and video engine on it, including "
        + "runs that then fitted in a quarter of the memory it demanded.",
    },
  },
  {
    id: "meshRig",
    makes: "mesh",
    home: "https://huggingface.co/VAST-AI/UniRig",
    label: "Skeleton and skin for a mesh — UniRig",
    why: "Puts joints and weights into a mesh, so the thing that came out of a picture can be posed.",
    licence: "MIT",
    outputRights: {
      class: "unrestricted",
      sellable: true,
      quote: MIT_GRANT,
      clause: "MIT License, grant paragraph (UniRig LICENSE, VAST-AI-Research)",
      url: "https://github.com/VAST-AI-Research/UniRig/blob/main/LICENSE",
      note: PERMISSIVE_NOTE + " The rig is part of your mesh and this licence adds nothing to it.",
    },
    /* MEASURED, same discipline as the row above. ⚠ AND NOTE THE LAYOUT: these
     * are .ckpt files under the variant folders UniRig's own quick-inference
     * configs name (articulation-xl, articulation-xl_quantization_256), not the
     * flat skeleton/model.safetensors this row guessed at before anybody
     * looked. A catalogue naming a file the loader never opens reports ready
     * and then cannot find its own model. */
    files: [
      /* Same rule, and the basename here is `model.safetensors`, which makes the
       * point louder than the row above it. */
      { url: `${HF}/VAST-AI/UniRig/resolve/main/skeleton/articulation-xl_quantization_256/model.ckpt`,
        dest: MESH("UniRig/skeleton/articulation-xl_quantization_256/model.ckpt"),
        identifies: "UniRig/skeleton/articulation-xl_quantization_256/model.ckpt",
        bytes: 1_439_617_174,
        sha256: "d8cf9b42d56e7bc316d293597ecf8c4c39a8631cdd44a261ecf388242fabd0f4" },
      { url: `${HF}/VAST-AI/UniRig/resolve/main/skin/articulation-xl/model.ckpt`,
        dest: MESH("UniRig/skin/articulation-xl/model.ckpt"),
        bytes: 4_375_464_854,
        sha256: "9d40cf42fb9d4c10d8b373d9f4f557c6fbbc5ebacae7ae6b3dce5a0d8a18bc33" },
    ],
    approxBytes: 5_815_082_028,
    note: "Two stages: a skeleton is predicted, then skinning weights are solved onto it, and the "
      + "result is written back into the .glb as glTF joints and inverseBindMatrices — which is the "
      + "format the downstream actually requires, and what server/mesh/glb.js asserts before this "
      + "reports success. ⚠ It is trained on ARTICULATED subjects: asked to rig a crate it will "
      + "invent a skeleton for a crate, so the runner refuses a rig on a mesh with no plausible "
      + "humanoid proportions rather than returning a confident wrong answer. ⚠ Sizes, hashes and "
      + "timings all await the install strand's report.",
    requires: {
      vramMinGb: 4, vramRecGb: 8, ramMinGb: 8, ramRecGb: 16,
      note: "⚠ STATED, NOT MEASURED. Much smaller than the mesh model beside it — it reads a mesh "
        + "rather than sampling one — but it is the same card, so it is refused against free VRAM "
        + "the same way.",
    },
  },
  {
    id: "lyrics",
    home: "https://github.com/openai/whisper",   // faster-whisper fetches into its own cache
    /* The id stays "lyrics" (tests, setup id and saved settings name it); the
     * words say what it now is: Whisper for any transcription, and the timed
     * lyrics that were once its only use (server/whisper.js). */
    label: "Whisper: transcription and timed lyrics",
    why: "Transcribes speech and songs, and times lyrics into LRC files.",
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
    note: "Transcribes any song, clip or file. With known lyrics it keeps your words and takes Whisper's timing. Measured 97.9% of words timed by direct match on a real track.",
    needsPackage: "faster_whisper",
    /* EVERY module server/lrc.py imports, by import name. `needsPackage` names
     * one, and probing only that one badged this row Ready in a fresh venv where
     * every run died on "No module named 'stable_whisper'" (measured
     * 2026-09-23). The Models screen, the welcome panel and Settings are Ready
     * only when all of these import in the lyrics interpreter. */
    needsModules: ["faster_whisper", "stable_whisper"],
    /* pip's name has a hyphen; the module's has an underscore. `needsPackage` is
     * what `importlib.find_spec` is asked for and `packageInstall` is what a
     * person types, and they are genuinely different strings — typing the
     * import name at a pip prompt installs somebody else's abandoned package. */
    packageInstall: "python -m pip install faster-whisper stable-ts",
    requires: {
      vramMinGb: 4, vramRecGb: 6, ramMinGb: 8, ramRecGb: 16,
      note: "About 36 s for a 2.5-minute song at int8_float16. Line timing is reliable; word timing is approximate on sung vocals.",
    },
    variants: [
      { label: "large-v3 (default)", bytes: 3090000000, note: "Best accuracy on sung vocals." },
      { label: "large-v3-turbo", bytes: 1620000000, note: "Much faster, close to large-v3 on speech." },
      { label: "medium", bytes: 1530000000, note: "Faster, more misheard words. With known lyrics the text is fixed, not the timing." },
      { label: "small", bytes: 484000000, note: "Fast; fine for clear speech." },
      { label: "base", bytes: 141000000, note: "Fast but unreliable on singing." },
      { label: "tiny", bytes: 75000000, note: "Fastest; rough drafts of clear speech only." },
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
      /* ⚠ PICK THE WEIGHTS TO MATCH THE MEDIUM. The shipped x2 is trained on
       * photographs, and on flat cel-shaded art a photo-trained upscaler
       * invents pores and film grain where the drawing has none. These two are
       * the same ESRGAN architecture, so both load in the stock
       * ImageUpscaleWithModel with no extra node pack. */
      { label: "Real-ESRGAN 4x anime 6B", bytes: 17938799,
        note: "Trained on ANIME line art. Six blocks instead of twenty-three, so it is a third the size and faster, and it keeps flat colour flat instead of finding texture in it. This is the one for a cel-shaded film." },
      { label: "realesr-animevideov3", bytes: 2508435,
        note: "The anime VIDEO variant — compact architecture, built for exactly the per-frame shimmer noted above. Tiny. ⚠ Not ESRGAN-architecture: whether the stock loader accepts it has to be TESTED on this install, not assumed." },
    ],
    /* ⚠ WAIFU2X IS NOT A DROP-IN, and it is worth writing down why, because it
     * is the first name anybody reaches for on anime.
     *
     * It is a different ARCHITECTURE, not an ESRGAN variant, so
     * ImageUpscaleWithModel cannot load it at all — it needs a custom node pack
     * (or the standalone ncnn binary) to run here. It was the anime standard
     * for years and is still good; the practical objection is only that
     * Real-ESRGAN ships anime-trained weights that work with what is already
     * installed. If the anime 6B weights are not good enough on a real frame,
     * waifu2x is the next thing to try and the cost is a node pack. */
  },
];

/* Rows with an `amd` or `light` build answer `files` for the machine they
 * run on: status, sizes and the downloader all read the same list, so none of
 * them can offer one build and fetch the other. */
for (const cap of CATALOG) {
  const all = cap.files;
  if (!Array.isArray(all) || !all.some((f) => f.amd || f.light)) continue;
  Object.defineProperty(cap, "files", { get: () => forCard(all), enumerable: true, configurable: true });
  // The published list, the same on every machine: the docs tables read this.
  Object.defineProperty(cap, "defaultFiles", { value: all, enumerable: false });
}

/* ───────────────────────────── what a capability MAKES, said POSITIVELY
 *
 * `makes: "picture"` sits on the five rows an image render can come out of and
 * on nothing else, and this predicate is the only way anything asks.
 *
 * IT REPLACES A SUBTRACTION, and the subtraction was not a style problem. Two
 * surfaces — server/fit.js's recommendation and the welcome window's Images
 * screen — used to compute the picture models as "every value in
 * MODEL_TO_CAPABILITY, minus the video engines, minus the required music one".
 * That rule has an answer for kinds nobody has thought of yet, and the answer is
 * always "picture". On 2026-09-03 it gave one: bridging WAN 2.1 VACE and DWPose
 * into that map made a video ControlNet the recommended PICTURE model on a
 * 16 GB machine and put both rows on the Images screen under "any one picture
 * model will do" — while fit_test (47/0) and welcome/catalogue_test (75/0)
 * stayed green, because two surfaces deriving one wrong set from one wrong rule
 * agree with each other perfectly. A census that compares them to each other
 * cannot see it.
 *
 * A positive rule cannot fail that way. The failure it CAN have is the opposite
 * one — somebody adds a picture model and forgets the field — and that is the
 * cheaper error by a wide margin: a model missing from the Images screen is
 * visible on the Images screen. A model wrongly appearing there was visible
 * nowhere.
 *
 * ⚠ DELIBERATELY NOT DERIVED FROM MODEL_TO_CAPABILITY. That map is a bridge
 * from a name the LEDGER writes to a rights record; membership in it says
 * nothing about what a model makes, and reading it as though it did IS the
 * defect above.
 */
export function isPictureModel(cap) {
  return cap?.makes === "picture";
}

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
  /* ⚠ THE SECOND MUSIC ENGINE, and the line without which every YuE2 render
   * stamps its rights `unknown` — silently, exactly as Anima's did (see the
   * "anima" note below) and exactly as this map's own header warns.
   *
   * The name is the one the renderer writes as `data.model`, lowercase, the way
   * every key here is. It is here BEFORE anything renders with it, on purpose:
   * the Anima defect was not that somebody forgot this line, it was that
   * forgetting it cost nothing at the time and was invisible afterwards.
   *
   * The other reader is engine/record.js's modelKeyFromFiles(), and this row
   * reaches it only because both of its weight files declare an `identifies`
   * tail — neither is under `diffusion_models/` or `unet/`, so the directory
   * rule that walk otherwise applies would never claim either of them.
   *
   * ⚠ And the census that would have MISSED this: provenance_test.js drew its
   * engine list from the art whitelist, config.video.engines and one literal,
   * so a music engine in a `config.music.engines` map appeared in none of the
   * three and the pre-commit hook passed. It reads every `<group>.engines` map
   * by rule now, and a fixture proves it can see a music one. */
  "yue2": "musicYue2",
  // The same YuE2 3B weights rendered through ComfyUI's native nodes.
  /* YuE2 through ComfyUI is its own row: the checkpoint ComfyUI loads, not the
   * Python kit's two m-a-p files — mapping it to musicYue2 quoted a 7.8 GB
   * download to a machine already rendering with a bf16 checkpoint. */
  "yue2-comfy": "musicYue2Comfy",
  "yue2-gguf": "musicYue2Gguf",
  // ACE-Step 1.5 through ComfyUI's own nodes; its rows are filed as "ace-step15".
  "ace-step15": "musicAceStep15",
  "flux2": "coverArt",
  "ideogram4": "imageIdeogram",
  // Two engine names, two capabilities, because they are two downloads. Their
  // rights record is the SAME object (ZIMAGE_RIGHTS) — one licence, quoted once.
  "zimage": "imageZImage",
  "zimage-base": "imageZImageBase",
  "krea2": "imageKrea2",
  "qwen-image-2.1": "qwen-image-2.1",
  // The engine name /api/image accepts is "anima"; the two files it needs are
  // the imageAnima entry. Missing here, every Anima render stamped its rights
  // `unknown` while ANIMA_RIGHTS sat in the catalogue two hundred lines up —
  // and, while the picture models were still found by subtracting from THIS
  // map's values, Anima was also absent from the Images screen's dependency
  // list and from the recommendation. That second half is no longer true: the
  // picture models are `makes: "picture"` on the row now, so a row can be an
  // image model without appearing here. The rights half stands on its own.
  "anima": "imageAnima",
  "h3": "video",
  "ltx": "videoLtx",
  // FastVideo's 8-step H3 distillation: config.video.engines.fasth3.
  "fasth3": "videoFastH3",
  /* ⚠ THE CONTROL PAIR, AND WHAT HAD TO CHANGE BEFORE THESE TWO LINES COULD
   * EXIST — this is still the load-bearing comment on this map.
   *
   * `videoControl` (WAN 2.1 VACE) and `posePreprocess` (DWPose) were kept OUT
   * of this map until 2026-09-03, for two reasons. Only one of them survives,
   * and the note stays so a fixed defect does not become folklore.
   *
   *  1. STANDING, PARTLY. This map is keyed on a name the ledger writes, and
   *     nothing writes "vace" or "dwpose" as `data.model` yet: the control path
   *     posts its own graphs from server/control/ and is not wired through
   *     art.js. The lines are here anyway because `data.model` is not the only
   *     reader — server/engine/record.js's modelKeyFromFiles() walks THIS map
   *     to name a render from the diffusion weights a graph actually loaded,
   *     and wan2.1_vace_1.3B_fp16.safetensors is a diffusion_models file. So a
   *     VACE render is recognised and stamped with WAN's settled Apache-2.0
   *     from the moment it is recorded, wiring or no wiring. (DWPose's two
   *     files live inside the node pack's ckpts/ folder, not under
   *     diffusion_models/, so that walk never claims a render for it — the
   *     line is there for outputRightsFor() and for completeness.)
   *
   *  2. GONE. The picture models used to be found BY SUBTRACTION — "every value
   *     in this map, minus the video engines, minus the required one" — in
   *     server/fit.js and server/welcome/catalogue.js both. A control model is
   *     neither a picture nor a video engine, so the subtraction misfiled it:
   *     measured by adding exactly these two lines, recommendFor() on a
   *     16 GB / 32 GB machine returned `image -> videoControl` (a newcomer told
   *     WAN 2.1 VACE is their picture model) and the Images screen listed both
   *     rows under "any one picture model will do — this is the whole choice",
   *     with every suite green while it did. Both surfaces now ask
   *     isPictureModel() above, which reads `makes: "picture"` off the row.
   *     Neither of these rows carries it, so neither can become a picture model
   *     by omission — from here or from anywhere else. */
  "vace": "videoControl",
  "dwpose": "posePreprocess",
  "depth-anything-v2": "depthPreprocess",

  /* ⚠ THE MESH PAIR, AND THE ONE THING THAT HAD TO CHANGE BEFORE THESE TWO
   * LINES MEANT ANYTHING.
   *
   * `server/mesh/runner.js` writes its own ledger rows by hand — it is a second
   * door, not a graph — and it writes `model: "triposg"` / `"unirig"`, so
   * stampRights() resolves through here and every mesh lands stamped MIT rather
   * than `unknown`.
   *
   * The OTHER reader is engine/record.js's modelKeyFromFiles(), which names a
   * render from the weights a graph loaded — and until 2026-09-06 it looked
   * only at dests under `diffusion_models/` and `unet/`. Neither of these is
   * anywhere near the engine's models tree (see MESH() at the top of this
   * file), so both rows would have been in this map and invisible to the one
   * walk that reads it. The restriction is still there and still doing its job:
   * a file may claim a render only if it is a diffusion weight OR its catalogue
   * row marks it `identifies: true`. The shared Qwen3-4B encoder is neither,
   * which is the case that restriction was written for. */
  "triposg": "meshFromImage",
  "unirig": "meshRig",
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
/* DERIVED from MODEL_TO_CAPABILITY, keeping the rows whose `makes` is "picture"
 * (the positive rule isPictureModel). Hand-typed, this table missed anima:
 * /api/image accepted the engine, the ledger recorded it, and the library showed
 * no label and no link for what painted the picture — the drift the paragraph
 * above warns about, one table away. */
const ENGINE_CAP = Object.fromEntries(
  Object.entries(MODEL_TO_CAPABILITY).filter(([, id]) => isPictureModel(CATALOG.find((c) => c.id === id))),
);

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

/** Least restrictive first. A song's add-ons can only move it right. The one
 *  ranking in the server: fit.js orders its picks by it too (rightsRank). */
export const RIGHTS_ORDER = Object.freeze(["unrestricted", "yours-with-conditions", "unknown", "not-for-sale"]);

/** A class's place in RIGHTS_ORDER. A class this file does not know ranks as
 *  `unknown`, never as unrestricted: a mistyped class must not make a song or
 *  a pick look freer than it is. */
export function rightsRank(cls) {
  const i = RIGHTS_ORDER.indexOf(cls);
  return i >= 0 ? i : RIGHTS_ORDER.indexOf("unknown");
}

/** The words a rights row is shown with: its own chip, or the class's. */
export function rightsWords(r) {
  const cls = OUTPUT_RIGHTS_CLASSES[r?.class] ? r.class : "unknown";
  const n = Array.isArray(r?.conditions) ? r.conditions.length : 0;
  const label = r?.chip
    || OUTPUT_RIGHTS_CLASSES[cls].chip + (cls === "yours-with-conditions" && n ? ` — ${n} condition${n === 1 ? "" : "s"}` : "");
  return { label, short: r?.short || label.toLowerCase() };
}

/**
 * WHAT A FINISHED SONG MAY BE SOLD FOR, worked out from the catalogue as it
 * is today — never from the words a sidecar stored when the song was made.
 *
 * The engine that rendered it picks the row (MODEL_TO_CAPABILITY, the same
 * bridge the ledger stamps with). An add-on the song used can only make the
 * answer stricter: a LoRA whose file is a catalogue row's file (meta.lora /
 * meta.loraClip), or a row that names the sidecar key it leaves
 * (`songAddOn`, the real-audio tokenizer's "tokenized"). The strictest class
 * wins, in RIGHTS_ORDER; `addOns` names the rows that raised it.
 *
 * A take with no engine of its own (a MiniMax extension, which records only
 * its parent) follows `extendedFrom` through `parentOf`, a few hops at most.
 * Anything still unnamed is `unknown`: not a verdict, the honest answer.
 */
export function songRights(meta = {}, { parentOf = null, catalog = CATALOG } = {}) {
  let engine = meta?.engine || null;
  for (let at = meta, hops = 0; !engine && at?.extendedFrom && parentOf && hops < 4; hops++) {
    at = parentOf(at.extendedFrom) || null;
    engine = at?.engine || null;
  }
  const key = String(engine || "").trim().toLowerCase();
  const capId = MODEL_TO_CAPABILITY[key] || null;
  const engineRow = capId ? catalog.find((c) => c.id === capId) || null : null;
  let row = engineRow?.outputRights ? engineRow : null;
  let r = row ? row.outputRights : UNRECOGNISED_RIGHTS;
  const rank = rightsRank;

  const loras = [meta?.lora, meta?.loraClip]
    .filter((v) => typeof v === "string" && v)
    .map((v) => path.basename(v.split(" @ ")[0].trim()).toLowerCase());
  const addOns = [];
  const used = [];
  for (const cap of catalog) {
    if (!cap?.outputRights || cap === engineRow) continue;
    const byFile = loras.length && [...(cap.files || []), ...(cap.defaultFiles || [])]
      .some((f) => loras.includes(path.basename(String(f?.dest || f?.url || "")).toLowerCase()));
    const bySidecar = typeof cap.songAddOn === "string" && meta?.[cap.songAddOn] != null && meta[cap.songAddOn] !== false;
    if (!byFile && !bySidecar) continue;
    used.push(cap);
    if (rank(cap.outputRights.class) > rank(r.class)) {
      addOns.push(cap.id);
      row = cap;
      r = cap.outputRights;
    }
  }
  /* A FILE SOMEBODY IMPORTED, with no engine named: Studio did not make it
   * and has read nothing about it, so the class stays `unknown`. But "Rights
   * unverified" on a person's own recording read as Studio doubting her song;
   * the basis and the words say why there is no verdict instead. */
  const imported = !engine && meta?.imported === true && !addOns.length;
  const { label, short } = imported
    ? { label: "Imported file · not made in Studio", short: "imported" }
    : rightsWords(r);
  /* THE CREDIT LINES THE FILE'S TAGS CARRY (tag_audio.py writes them as
   * ATTRIBUTION and COPYRIGHT; the native WAV as ICOP): the engine row's own
   * attribution (YuE2's names the authors and the licence file), and for each
   * catalogued add-on the song used, its attribution or — for a not-for-sale
   * one — its licence and label, so a file that leaves Studio says why it may
   * not be sold. Empty for engines whose licence asks for none. */
  const credit = (cap) => cap?.outputRights?.attribution
    || (cap?.outputRights?.class === "not-for-sale"
      ? `${cap.label}: ${String(cap.licence || "see its licence").split(" — ")[0]} — ${rightsWords(cap.outputRights).label}. ${cap.outputRights.url || ""}`.trim()
      : null);
  const credits = [engineRow, ...used].map(credit).filter(Boolean);
  return {
    class: r.class,
    sellable: r.sellable ?? null,
    label,
    short,
    capability: row?.id || null,
    engineCapability: capId,
    licence: row?.licence || null,
    url: r.url || null,
    basis: imported ? "imported" : r.basis || (r.class === "unknown" ? null : "licence"),
    addOns,
    ...(r.changed ? { changed: r.changed } : {}),
    ...(credits.length ? { attribution: [...new Set(credits)].join("\n") } : {}),
  };
}

/**
 * THE LEDGER'S STAMP FOR A SONG, when it differs from its model's.
 *
 * provenance.js stamps a generate event with its model's row (rightsStampFor)
 * and keeps an `outputRights` the caller supplies. A song that used a
 * not-for-sale add-on (a catalogued LoRA, the real-audio tokenizer) is
 * stricter than its model, and without this the ledger said "yours to sell"
 * while the library row said "not for sale". Null when no add-on raised it:
 * the model's own stamp is then the right one, and the ledger stays as small.
 */
export function songRightsStamp(meta = {}, opts = {}) {
  const r = songRights(meta, opts);
  return r.addOns.length ? { class: r.class, capability: r.capability, url: r.url, addOns: r.addOns } : null;
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
/** The sha256 of a file on disk, streamed so a 7 GB checkpoint costs one read and no RAM. */
/** `cancelled()` is asked as the file is read: a 40 GB check takes minutes,
 *  and Cancel has to stop it too. */
function sha256Of(file, cancelled = () => false) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const rs = createReadStream(file, { highWaterMark: 4 << 20 });
    rs.on("data", (d) => {
      if (cancelled()) {
        rs.once("close", () => reject(new Error("cancelled")));
        rs.destroy();
        return;
      }
      h.update(d);
    })
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/* No bytes from the server for this long and the download is given up as
 * stalled. The .part stays, so pressing Download again resumes it. */
const DOWNLOAD_STALL_MS = Number(process.env.AIPLAY_DOWNLOAD_STALL_MS) || 90_000;

async function filePresent(f) {
  try {
    if ((await stat(f.dest)).size === f.bytes) return true;
  } catch { /* fall through to the alternates */ }
  for (const name of f.alt || []) {
    try {
      if ((await stat(path.join(path.dirname(f.dest), name))).size > 0) return true;
    } catch { /* keep looking */ }
  }
  /* The same file under an EARLIER models folder (config.modelsAlso): the
   * engine still loads from there, so it is installed, not missing. Without
   * this a change of folder offered every model again, hundreds of GB. */
  const rel = path.relative(config.modelsDir, f.dest);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    for (const base of config.modelsAlso || []) {
      try {
        if ((await stat(path.join(base, rel))).size === f.bytes) return true;
      } catch { /* not there either */ }
      for (const name of f.alt || []) {
        try {
          if ((await stat(path.join(base, path.dirname(rel), name))).size > 0) return true;
        } catch { /* keep looking */ }
      }
    }
  }
  return false;
}

/** Bytes already fetched, for resume and for progress on a partial file. */
async function fileHave(f) {
  try { return (await stat(f.dest)).size; } catch { return 0; }
}

/**
 * What THIS install needs, as the Models screen badges it. Not the same
 * question as the catalogue's `required`.
 *
 * An install needs ONE music engine. The catalogue flag marks config.js's
 * starting engine, MiniMax Music 3, and the Models screen used to badge
 * straight from it, so an install running YuE2 was told MiniMax was REQUIRED
 * and shown an 11.92 GB download it would never render with. So, per status
 * row (the list, because one row's answer turns on another row's readiness):
 *
 *   selected engine READY   that row alone is `required`. The choice is made
 *                           and on disk, so it is the one thing not to delete.
 *   selected engine NOT     no music row is `required`; every one carries
 *   ready (a fresh install) `requiredGroup: "music"` and the card says "one
 *                           music engine required". Badging the selected row
 *                           here would be the old defect again: a fresh
 *                           install's selected engine is config.js's default,
 *                           and /api/music refuses to select an engine that is
 *                           not downloaded, so a newcomer would be told MiniMax
 *                           is required before they could ever pick YuE2.
 *   hosted Music 3          nothing: API mode renders on the provider's
 *                           machine, and jobs.js sends exactly this pair
 *                           (api.enabled, engine minimax-music3) to #runApi.
 *
 * A saved engine that names no row is "not ready": it points at nothing, so
 * the group answer is the true one. Readiness is the row's own `ready`, which
 * is what the card beside the badge says. /api/models overlays the native GGUF
 * row's readiness from its setup (status() cannot see that runtime), so it
 * marks again after the overlay; the answer depends only on the rows given.
 *
 * The music rows come from config's engine map (each engine names its
 * capability), not a list typed here, so a new engine is covered the day it is
 * added there. Every other row keeps its catalogue flag.
 */
/** Every module a capability needs, by import name: `needsModules` when the
 *  catalogue lists several (timed lyrics), else its one `needsPackage`. The
 *  Models screen, the welcome panel, Settings and extras_setup.mjs all ask
 *  this, so none of them can go back to checking only the first. */
export function modulesOf(cap) {
  return cap?.needsModules || (cap?.needsPackage ? [cap.needsPackage] : []);
}

export function markRequired(rows, { music = config.music, api = config.api } = {}) {
  const engines = music?.engines || {};
  const musicRows = new Set(Object.values(engines).map((e) => e?.capability).filter(Boolean));
  const selected = engines[music?.engine]?.capability || null;
  const hosted = !!api?.enabled && music?.engine === "minimax-music3";
  const chosen = !hosted && !!selected && rows.some((r) => r.id === selected && r.ready);
  return rows.map((r) => (!musicRows.has(r.id) ? r : {
    ...r,
    required: chosen && r.id === selected,
    requiredGroup: hosted || chosen ? null : "music",
  }));
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
      const files = await Promise.all(cap.files.map(async (f) => {
        /* A local file the user chose to stand in for this one (Models screen).
         * Same folder by construction, so it rides the existing `alt` check. */
        const override = config.modelOverrides?.[path.basename(f.dest)] || null;
        const rel = path.relative(config.modelsDir, path.dirname(f.dest)).split(path.sep)[0];
        const folder = rel && !rel.startsWith("..") ? rel : null;
        /* `alt` names resolve against the file's own folder, so a stand-in in an
         * alias folder (unet for diffusion_models) is reached as ../unet/<name>. */
        const checked = override && folder
          ? { ...f, alt: [...(f.alt || []), ...folderGroup(folder).map((g) => path.join("..", g, override))] }
          : f;
        return {
        name: path.basename(f.dest),
        folder,
        override,
        /* ⚠ THE WHOLE PATH, BESIDE THE BASENAME, because "is this the same
         * file" is a question about a PATH and `bytesFor()` was answering it
         * with a name. That proxy held for as long as no two capabilities used
         * a shared naming convention, and stopped holding the day the mesh rows
         * arrived carrying the diffusers one: two files called
         * `model.safetensors` in different folders would have been counted
         * once, quoting somebody a download smaller than the one they get. The
         * three rows that really do share the Qwen3-4B encoder name the same
         * dest, so the deduplication that matters is unchanged. */
        dest: f.dest,
        bytes: f.bytes,
        present: await filePresent(checked),
        have: await fileHave(f),
        };
      }));
      const totalBytes = cap.files.reduce((s, f) => s + f.bytes, 0) || cap.approxBytes || 0;
      const haveBytes = files.reduce((s, f) => s + (f.present ? f.bytes : f.have), 0);
      out.push({
        id: cap.id,
        group: cap.group || null,
        // Carried so isPictureModel() gives the same answer about a live status
        // row as it does about the catalogue row it came from. A predicate that
        // silently answers "no" on one of the two shapes it will be handed is
        // the subtraction's failure wearing a different hat.
        makes: cap.makes || null,
        /* The row this one only makes sense beside (a LoRA on another row's
         * model, like Fast draft on Qwen Image 2.1). Null for every model of
         * its own. */
        addonFor: cap.addonFor || null,
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
        home: cap.home || homeFor(cap),
        nativeSetup: !!cap.nativeSetup,
        // Null for every capability but H3. The UI must render this as a
        // blocking acknowledgement, not a footnote — download() rejects without
        // one, so a client that ignores it simply cannot fetch the weights.
        region: cap.region || null,
        // Gated repos cannot be fetched by the built-in downloader at all — the
        // UI must say how to get them rather than offering a button that 401s.
        gated: cap.gated || null,
        // Null for every row whose file facts are real. Carried for the same
        // reason `gated` is: a button that cannot work should say why, not 401
        // or, here, fail a size check after a multi-gigabyte fetch.
        awaiting: cap.awaiting || null,
        note: cap.note,
        // The catalogue's flag, until markRequired() below replaces it on the
        // music rows with this install's answer (the badge the screen shows).
        required: !!cap.required,
        requiredGroup: null,
        // What the machine needs, and what else could be used instead. Stated
        // because "4 GB to download" answers a different question from "will it
        // run on my card" — and the second is the one that stops people.
        requires: cap.requires || null,
        variants: cap.variants || null,
        needsPackage: cap.needsPackage || null,
        // Every module that must import, when there is more than one (lyrics).
        needsModules: cap.needsModules || null,
        // The command a person types to get that package. A capability whose
        // only blocker is a pip install used to report the blocker and not the
        // remedy, which is the shape of every "rough edge" complaint about this
        // app: the screen knew exactly what was wrong and made you go and find
        // out how to fix it.
        packageInstall: cap.packageInstall || null,
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
    return markRequired(out);
  }

  /* The fetch of each running download, so Cancel can stop it mid-wait. */
  #aborts = new Map();
  #runs = new Map();
  #pending = new Map();

  /**
   * Stop a download NOW. It used to set a flag the download read between
   * chunks, so a connection that had stopped sending never saw it: the Cancel
   * button stayed, the row stayed "downloading", and Download refused to start
   * it again ("already running"). The fetch is aborted instead, and the row is
   * cleared at once rather than shown as a failure for fifteen seconds.
   */
  cancel(id) {
    this.cancelled.add(id);
    this.#aborts.get(id)?.abort();
    if (this.progress.has(id)) { this.progress.delete(id); this.emit("update"); }
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
    /* A ROW WHOSE FILE FACTS ARE STILL PLACEHOLDERS, refused here rather than
     * three gigabytes later. Without this the download runs, finishes, and dies
     * at `#one`'s size check with "expected 0 bytes, got 4283000000" — which
     * reads as a corrupt file and is really an unfinished catalogue row.
     * AWAITING_MEASUREMENT at the top of this file is the other half. */
    if (cap.awaiting) {
      throw new Error(`${cap.label} cannot be downloaded yet: its file list is a placeholder `
        + `awaiting ${cap.awaiting}. Nothing was fetched.`);
    }
    /* A row showing its failure (kept 15 s so the reason can be read) is not a
     * running download: Download again must start, not answer "already running". */
    if (this.progress.has(id) && this.progress.get(id).state !== "failed") return { alreadyRunning: true };
    if (!cap.files.length) throw new Error(`${cap.label} is fetched by its python package, not by this downloader.`);

    // Reserve the row before the first filesystem await. A cancelled run must
    // close its writer/checksum reader before a retry can touch the same .part.
    const previous = this.#pending.get(id);
    if (previous) {
      if (!this.cancelled.has(id)) return { alreadyRunning: true };
      await previous;
      return this.download(id, { acceptRegion });
    }
    let release;
    this.#pending.set(id, new Promise((resolve) => { release = resolve; }));
    try {
      return await this.#download(id, cap);
    } finally {
      this.#pending.delete(id);
      release();
    }
  }

  async #download(id, cap) {
    this.cancelled.delete(id);
    /* This run's token: a run that was cancelled and is still unwinding must
     * not write "failed" over a new run of the same row started meanwhile. */
    const run = Symbol(id);
    this.#runs.set(id, run);
    const mine = () => this.#runs.get(id) === run;
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
      /* Cancelled: nothing failed. cancel() already cleared the row. */
      if (!mine()) return { cancelled: true };
      if (this.cancelled.has(id)) {
        this.progress.delete(id);
        this.emit("update");
        return { cancelled: true };
      }
      this.progress.set(id, { received: doneBytes, total, file: null, state: "failed", error: String(err.message || err) });
      this.emit("update");
      // Leave the .part behind on purpose: the next attempt resumes from it.
      setTimeout(() => { if (mine() && this.progress.get(id)?.state === "failed") { this.progress.delete(id); this.emit("update"); } }, 15000);
      throw err;
    }
  }

  async #one(id, f, getBase, _setBase) {
    if (fp4Blocked(f)) {
      throw new Error(`${path.basename(f.dest)} is an fp4 build, which needs an NVIDIA card. `
        + "It was not downloaded. Use another build of it from the Models screen.");
    }
    await mkdir(path.dirname(f.dest), { recursive: true });
    const part = `${f.dest}.part`;
    let from = 0;
    try { from = (await stat(part)).size; } catch { /* fresh */ }
    if (from > f.bytes) { await unlink(part).catch(() => {}); from = 0; }

    // A checksum cancellation can leave all bytes present. Verify them below;
    // requesting bytes=<size>- from a real publisher would return HTTP 416.
    if (from < f.bytes) {
      /* ONE ABORT FOR THIS FILE: Cancel and the stall timer both pull it, and
       * either one ends the wait for headers or for the next chunk at once. */
      const ctl = new AbortController();
      this.#aborts.set(id, ctl);
      let stalled = false, timer = null;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; ctl.abort(); }, DOWNLOAD_STALL_MS); };
      const name = path.basename(f.dest);
      let out = null;
      try {
        arm();
        const res = await fetch(f.url, { signal: ctl.signal, ...(from ? { headers: { Range: `bytes=${from}-` } } : {}) });
        if (!res.ok && res.status !== 206) throw new Error(`${name}: HTTP ${res.status}`);
        // A server that ignores Range answers 200 with the whole file; restarting is
        // then the only correct thing to do, rather than appending to a partial.
        if (from && res.status !== 206) from = 0;

        out = createWriteStream(part, { flags: from ? "a" : "w" });
        let received = from;
        const base = getBase();
        for await (const chunk of res.body) {
          arm();
          if (this.cancelled.has(id)) throw new Error("cancelled");
          received += chunk.length;
          /* ⚠ BACKPRESSURE. write() without waiting queued every chunk the
           * network delivered faster than the disk took it, in this process's
           * memory: on a 40 GB model that was gigabytes of RAM and a server too
           * busy collecting garbage to answer the page. Wait for the disk. */
          if (!out.write(chunk)) await once(out, "drain");
          const p = this.progress.get(id);
          if (p) {
            p.received = base + received;
            p.file = name;
            p.state = "downloading";
          }
        }
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
        out = null;
      } catch (err) {
        if (this.cancelled.has(id)) throw new Error("cancelled");
        if (stalled) {
          throw new Error(`${name}: the server sent nothing for ${DOWNLOAD_STALL_MS / 1000} s, so the download was stopped. `
            + "What arrived is kept: press Download again to continue from there.");
        }
        throw err;
      } finally {
        clearTimeout(timer);
        if (this.#aborts.get(id) === ctl) this.#aborts.delete(id);
        // Release the .part before anything else touches it (Windows holds it open).
        if (out && !out.destroyed) await new Promise((r) => { out.once("close", r); out.destroy(); });
      }
    }

    if (this.cancelled.has(id)) throw new Error("cancelled");
    const got = (await stat(part)).size;
    if (got !== f.bytes) {
      throw new Error(`${path.basename(f.dest)}: expected ${f.bytes} bytes, got ${got}`);
    }
    /* THE CATALOGUE'S sha256 IS A CHECK, NOT A DECORATION.
     *
     * Every `files` entry carries the hash the publisher's own repository
     * reports, and until now nothing read it: a file of the right LENGTH was
     * accepted, whatever its contents. That is the one failure a byte count
     * cannot see — a truncated-then-padded proxy response, a mirror serving a
     * different revision at the same size, a disk that wrote zeros. 37 of the
     * catalogue's 79 files record a hash today; the rest were added before the
     * rows carried one, and a file with no recorded hash is accepted on its
     * size exactly as before rather than being refused for a number nobody
     * measured.
     *
     * The .part is read once more instead of being hashed as it streams,
     * because a resumed download (Range, above) never sees its own first
     * bytes. On a mismatch the .part is DELETED: resuming would append to
     * wrong bytes for ever, which is the one case where keeping it costs more
     * than the re-fetch. */
    if (typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256)) {
      const p0 = this.progress.get(id);
      if (p0) { p0.state = "checking"; p0.file = path.basename(f.dest); this.emit("update"); }
      const sum = await sha256Of(part, () => this.cancelled.has(id));
      if (sum !== f.sha256) {
        await unlink(part).catch(() => {});
        throw new Error(`${path.basename(f.dest)}: the file that arrived is not the one the catalogue names `
          + `(sha256 ${sum.slice(0, 12)}…, expected ${f.sha256.slice(0, 12)}…). It has been removed; try again.`);
      }
      if (p0) { p0.state = "downloading"; this.emit("update"); }
    }
    if (this.cancelled.has(id)) throw new Error("cancelled");
    await rename(part, f.dest);
  }
}

// H3's excluded territories, read off the rows that carry one. Every consumer
// (tool descriptions, the welcome window, the docs generator, the client via
// /api/models) derives from here; server/territory_test.js fails the build on
// any hand-typed copy. Several rows are territory-limited and must agree.
export function excludedTerritories() {
  const lists = CATALOG.filter((c) => Array.isArray(c.region?.excluded) && c.region.excluded.length)
    .map((c) => c.region.excluded.join("|"));
  if (!lists.length) throw new Error("no territory-limited catalogue row");
  if (new Set(lists).size !== 1) throw new Error(`territory-limited rows disagree: ${lists.join(" vs ")}`);
  return lists[0].split("|");
}

/** "European Union, United Kingdom, Republic of Korea or United States of America" */
export function excludedTerritoriesText() {
  const x = excludedTerritories();
  return x.length > 1 ? `${x.slice(0, -1).join(", ")} or ${x[x.length - 1]}` : x[0];
}
