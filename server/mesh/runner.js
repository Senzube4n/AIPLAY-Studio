/**
 * THE SECOND DOOR — image to mesh, and mesh to rig, in a python this app does
 * not own.
 *
 * ══ WHY THERE IS A SECOND DOOR AT ALL ═════════════════════════════════════
 *
 * `docs/ENGINE_DOOR.md` says there is ONE way to the graphics card, and it says
 * it for a reason worth restating: on 2026-09-02 the rig's output folder held
 * 426 files written since the previous noon and 424 of them had no ledger entry
 * of any kind. The fix was to make bypassing the record impossible by
 * construction — the engine's port is ephemeral and unpublished, and
 * `server/engine/client.js` is the only file in the tree that knows it.
 *
 * This module does not go through that door, and the honest reason is a PYTHON
 * VERSION COLLISION, not a preference:
 *
 *   · The engine's interpreter is pinned. `server/config.js` records why —
 *     torch 2.13.0+cu130 in the ComfyUI venv, because the music model's fused
 *     int8 kernels exist only on that build, and torch 2.5.1+cu121 with
 *     diffusers 0.7.0.dev0 in the system python that demucs and ctranslate2
 *     live in.
 *   · TripoSG is a diffusers pipeline that wants a MODERN diffusers.
 *   · `pip install diffusers` into either of those environments does not fail.
 *     It succeeds, and then the owner's next song render dies hours later
 *     inside a kernel, in a place that says nothing whatsoever about a mesh.
 *
 * So the third environment is a hard requirement, and a hard requirement means
 * a subprocess: this file spawns `<mesh venv>/python.exe mesh_cli.py` and reads
 * a JSON line back. It NEVER imports it, and nothing in this tree may add a
 * package to the engine's environment on its behalf.
 *
 * ⚠ WHAT IT DOES NOT GET TO SKIP. A second door is not a second standard. This
 * module writes the SAME two ledger rows the engine door writes, in the same
 * order, with the same actor discipline — a `delegate` before anything is
 * spent, a `generate` after — and the `delegate` append is AWAITED WITH NO
 * `.catch()`. A ledger failure costs the run. That inversion is the whole
 * design over there and it is the whole design here; a mesh is exactly as
 * capable of becoming an unattributable file in a folder as a clip is.
 *
 * ⚠ AND IT IS NOT A LICENCE BOUNDARY, unlike `server/mv/blender.js`. Blender's
 * toolkit is a subprocess because `import bpy` would make this Apache-2.0 tree a
 * derivative work of a GPL program. TripoSG and UniRig are MIT for code AND
 * weights — which is precisely why they were chosen over Hunyuan3D, whose terms
 * exclude the European Union — so `mesh_cli.py` beside this file is an ordinary
 * member of this repository. The boundary here is a version number.
 *
 * ══ REFUSALS BEFORE SPEND ═════════════════════════════════════════════════
 *
 * Five, each with its own sentence, all of them BEFORE a python starts. The
 * expensive failure this replaces is not an error message — it is a CUDA
 * out-of-memory forty seconds in, on a card the owner's engine is living on,
 * which reads as a bug in this feature and is really "something else has the
 * card". See refuse() below; `server/mesh/runner_test.js` drives every one.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { config } from "../config.js";
import * as provenance from "../provenance.js";
import { TOOL, normalizeActor } from "../provenance.js";
import { CATALOG } from "../models.js";
import { jsonAfter } from "../mv/blender.js";
import { referenceSafe } from "../mv/blender.js";
import { readGlbFile, assertSkinned, plausiblyHumanoid } from "./glb.js";
import { assertDeforms } from "./deform.js";
import { killProcessTree } from "../proctree.js";

/**
 * ONE SENTENCE, CARRIED INTO EVERY RECORD THIS MODULE WRITES.
 *
 * A reader three years from now finds a ledger row that did not come through
 * the engine door, and has to be able to tell a DELIBERATE second door from
 * somebody bypassing the record again — which is the thing that produced 424
 * unattributable files and the reason that door exists. So the row says which
 * it is, in the row, not only in this file's header.
 */
export const SECOND_DOOR =
  "server/mesh — a SECOND door. TripoSG needs a modern diffusers and the engine's python is pinned "
  + "at diffusers 0.7.0.dev0, so this runs in its own venv as a subprocess. It writes the same "
  + "delegate/generate pair the engine door writes.";

/** The marker the python prints its answer after. Same shape as previz's. */
const RESULT_MARKER = "MESH_RESULT_JSON:";

/** The two catalogue rows this door reads. Ids, not labels — labels move. */
export const MESH_CAP = "meshFromImage";
export const RIG_CAP = "meshRig";

/** The ledger's name for each, and the key MODEL_TO_CAPABILITY bridges. */
export const MESH_MODEL = "triposg";
export const RIG_MODEL = "unirig";

/** What may be handed in as a picture. The same three extensions server/mv/
 *  control.js's IMAGE_RE names, and for the same reason: one vocabulary. */
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/**
 * The first bytes of each of those formats, because an extension is a claim and
 * a magic number is evidence. A .png that is really a text file fails inside
 * the python with a traceback nobody can act on; here it fails with a sentence.
 */
const MAGIC = [
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  // RIFF....WEBP — the four bytes at offset 8 are checked separately below.
  { name: "WEBP", bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** A refusal, so a caller can branch on the KIND without matching on prose. */
export class MeshRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "MeshRefusal";
    this.refusal = code;
    Object.assign(this, detail);
  }
}

/* ────────────────────────────────────────────── is any of this here yet */

/** A catalogue row, or null. */
const cap = (id) => CATALOG.find((c) => c.id === id) || null;

/** Every file of a capability is on disk at exactly the size the row states. */
async function weightsPresent(id) {
  const c = cap(id);
  if (!c || !c.files?.length) return { ready: false, missing: ["the catalogue row lists no files"] };
  const missing = [];
  for (const f of c.files) {
    /* The catalogue's own definition of present: the EXACT size. A row whose
     * bytes are still AWAITING_MEASUREMENT (0) can therefore never be ready,
     * which is deliberate — see models.js. */
    try {
      const s = await stat(f.dest);
      if (s.size !== f.bytes) missing.push(`${path.basename(f.dest)} is ${s.size} bytes, the catalogue says ${f.bytes}`);
    } catch {
      missing.push(`${path.basename(f.dest)} is not at ${f.dest}`);
    }
  }
  return { ready: !missing.length, missing };
}

/**
 * Are the pythons, the checkouts and the weights here? -> {installed, canRig, why[]}
 *
 * Written the way `blenderStatus()` is written, for a person who has never
 * heard of any of this: it names the missing file and the setting that moves
 * it, so a route can hide a button it cannot honour instead of offering one
 * that dies in a subprocess.
 *
 * ⚠ `canRig` IS TWO QUESTIONS AND IT USED TO ANSWER ONE. Every check in here
 * is a stat() — files, checkouts, checkpoint bytes — and files being on the
 * disk is not a runtime that imports. On this machine that gap had a measured
 * price: with both UniRig checkpoints present and hash-verified, and the
 * interpreter existing at `unirigPython`, this function returned
 * `canRig: true, why: []` in 1 ms while `rigRuntime()` reported flash_attn
 * missing 13.3 s later — so a route, a button and `rigMesh()`'s own first gate
 * all read "ready" for something that refuses the moment it is asked.
 *
 * So canRig now means BOTH, and the file half keeps its own name,
 * `rigWeightsReady`, for the callers that really did mean the files.
 *
 * THE PROBE IS NEVER SPAWNED FROM HERE. It costs 13 s cold, this is a page-load
 * call, and runner_test.js is entitled to its "answers without spawning
 * anything". Instead:
 *   · `probe` given            — use it. The seam the tests drive, exactly as
 *                                 refuseVram() takes its VRAM reading as an
 *                                 argument so both sides can be asserted.
 *   · `awaitProbe: true`       — await rigRuntime(), cached for the process.
 *                                 What meshCatalogue() and the rig paths pass.
 *   · neither                  — read the cached answer if one has landed, and
 *                                 otherwise report `unchecked`, which is NOT
 *                                 `ready`. An unasked question cannot be a yes.
 *
 * The runtime's sentences stay OUT of `why`, which is about files and the
 * settings that move them; they are in `rigProbe.why`, and meshCatalogue()
 * merges the two for a surface. Different problems, different remedies: fetch a
 * file, or install a runtime.
 */
export async function meshStatus({ probe: given, awaitProbe = false } = {}) {
  const { python, unirigPython, triposg, unirig, weights } = config.mesh;
  const why = [];
  try { await stat(python); } catch {
    why.push(`The 3D python is not at ${python} — set AIPLAY_MESH_PYTHON to the venv's python.exe.`
      + ` It must be its OWN virtual environment: installing this stack into the engine's python`
      + ` would replace the diffusers the music model is pinned against.`);
  }
  try { await stat(triposg); } catch {
    why.push(`The TripoSG checkout is not at ${triposg} — set AIPLAY_TRIPOSG. It is MIT, code and weights.`);
  }
  try { await stat(unirig); } catch {
    why.push(`The UniRig checkout is not at ${unirig} — set AIPLAY_UNIRIG. Rigging is unavailable without it; meshing is not.`);
  }
  const rigRuntimeWhy = [];
  try { await stat(unirigPython); } catch {
    rigRuntimeWhy.push(`The UniRig python is not at ${unirigPython} — set AIPLAY_UNIRIG_PYTHON to a separate compatible interpreter.`);
  }
  const mesh = await weightsPresent(MESH_CAP);
  const rig = await weightsPresent(RIG_CAP);
  /* THE FILE HALF — every stat() above, and what canRig used to mean alone. */
  const rigWeightsReady = !why.length && !rigRuntimeWhy.length && mesh.ready && rig.ready;
  /* THE RUNTIME HALF. `undefined` is "not asked yet", which is why the three
   * states below are three and not two. */
  const probe = given !== undefined ? given
    : awaitProbe ? await rigRuntime()
    : rigProbeCached();
  const rigProbe = {
    state: !probe ? "unchecked" : probe.canRig === true ? "ready" : "blocked",
    missing: probe?.missing || [],
    probe: probe || null,
    why: !probe
      ? [`The UniRig prerequisite probe has not been run in this process yet, so the rig is not `
         + `offered. It is one spawn of ${unirigPython} --rig-probe and it is cached for the life `
         + `of the process.`]
      : probe.canRig === true ? []
        : (probe.missing || []).map((m) => `UniRig runtime: ${m.module} does not import in the rig `
            + `python (${m.error}) — ${m.why}`),
  };
  return {
    installed: !why.length && mesh.ready,
    /* BOTH halves. A true here is a promise that a rig would start. */
    canRig: rigWeightsReady && rigProbe.state === "ready",
    rigWeightsReady,
    rigProbe,
    python, unirigPython, triposg, unirig, weights,
    weightsReady: { mesh: mesh.ready, rig: rig.ready },
    /* The catalogue's own admission travels with the status, so a screen can
     * say "these rows are placeholders" rather than "missing", which are
     * different problems with different remedies. */
    awaiting: { mesh: cap(MESH_CAP)?.awaiting || null, rig: cap(RIG_CAP)?.awaiting || null },
    why: [...why, ...rigRuntimeWhy, ...mesh.missing.map((m) => `TripoSG: ${m}`), ...rig.missing.map((m) => `UniRig: ${m}`)],
  };
}

/* ───────────────────────────────────────────────────────────── the card */

/**
 * Free VRAM in MiB, read FRESH, or null when there is no NVIDIA card.
 *
 * ⚠ NOT `server/gpu.js`'s poller, and the difference is the whole point of this
 * function. That one is a 3-second cache that refreshes BEHIND the caller and
 * answers `null` on a cold call — correct for a status panel repainting every
 * four seconds, and useless as a gate: a refusal that lets the run through
 * because its cache had not filled yet is not a refusal. This awaits one
 * nvidia-smi (~40 ms, paid once per run, against a run measured in minutes).
 *
 * `null` means NO READING, never zero. A machine with an AMD card or no card at
 * all must not be told it is out of memory — it must be told the check could
 * not be made, which is what the refusal below does with a null.
 */
export function freeVramMb({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let proc, out = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { proc?.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    try {
      proc = spawn("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                   { windowsHide: true });
    } catch { return finish(null); }
    proc.stdout.on("data", (d) => { out += d; });
    proc.on("error", () => finish(null));
    proc.on("exit", (code) => {
      if (code !== 0) return finish(null);
      const n = Number(String(out).split("\n")[0].trim());
      finish(Number.isFinite(n) ? n : null);
    });
  });
}

/**
 * The card's compute capability as [major, minor], or null if it cannot be
 * read. Gates features whose KERNELS do not exist below a threshold rather than
 * features that are merely slow — YuE2's experimental FP8 path is the case in
 * hand, and quantization.py:74 refuses anything below (8, 9).
 *
 * ⚠ nvidia-smi AND NOT TORCH, deliberately. Reading it through torch means
 * importing torch, which means a python start and several seconds, to answer a
 * question a 40 ms subprocess answers — and the whole point of asking is to
 * refuse BEFORE paying for a load. MEASURED: `--query-gpu=compute_cap` returns
 * "8.9" on this machine's RTX 4070 Ti SUPER.
 *
 * NULL MEANS UNREADABLE, NEVER ZERO, which is the same rule freeVramMb() uses
 * above. A caller that cannot tell must not conclude "too old": on this
 * machine an unreadable capability with an eligible card would silently remove
 * a working configuration.
 */
export function cudaCapability({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let proc, out = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { proc?.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    try {
      proc = spawn("nvidia-smi", ["--query-gpu=compute_cap", "--format=csv,noheader"],
                   { windowsHide: true });
    } catch { return finish(null); }
    proc.stdout.on("data", (d) => { out += d; });
    proc.on("error", () => finish(null));
    proc.on("exit", (code) => {
      if (code !== 0) return finish(null);
      const m = /^\s*(\d+)\.(\d+)/.exec(String(out).split("\n")[0]);
      finish(m ? [Number(m[1]), Number(m[2])] : null);
    });
  });
}

/* ─────────────────────────────────────────── the refusals, before spend */

const GB = 1024;   // MiB per GiB, which is what nvidia-smi reports in

/**
 * Everything that must be true before a python starts, checked in the order
 * that costs least.
 *
 * Each refusal is ONE SENTENCE ABOUT ONE THING, because the point of refusing
 * early is that the person reading it knows what to do next, and a paragraph
 * covering four cases tells them what to do about none of them.
 *
 * Returns nothing and throws a MeshRefusal — the caller has no useful "carry
 * on anyway" branch, and a boolean would be checked in one of the two call
 * sites and forgotten in the other.
 */
export async function refuse({ image, rig, wantRig = false, glbForRig = null } = {}) {
  /* 1 · THE RUNTIME. Cheapest, and the one that is a setup problem rather than
   *     a usage problem, so it goes first. */
  const st = await meshStatus();
  if (st.why.length && !st.weightsReady.mesh) {
    throw new MeshRefusal("weights",
      `The mesh model is not on this machine, so nothing was started.\n`
      + st.why.map((w) => `  - ${w}`).join("\n")
      + `\nOpen the Models screen and fetch "${cap(MESH_CAP)?.label || MESH_CAP}"`
      + (st.awaiting.mesh
        ? `. ⚠ That row is still a placeholder in the catalogue (awaiting ${st.awaiting.mesh}), `
          + `so the button will refuse too — the file facts have to land first.`
        : ` (about ${Math.round((cap(MESH_CAP)?.approxBytes || 0) / 1e9)} GB).`),
      { status: st });
  }
  if (st.why.length) {
    throw new MeshRefusal("runtime",
      `The 3D runtime is not set up, so nothing was started.\n`
      + st.why.map((w) => `  - ${w}`).join("\n"), { status: st });
  }

  /* 2 · THE INPUT. An image-to-3D model given something that is not an image
   *     produces a traceback; given a three-panel contact strip it produces a
   *     mesh OF A STRIP, which is the same lesson DIRECTING.md §2 records about
   *     handing a strip to a picture model, one dimension further on. */
  await refuseInput(image);

  /* 3 · THE CARD. Last of the cheap checks and the most valuable one. The
   *     reading is RETURNED as well as judged: the caller has to decide whether
   *     to page the model in a module at a time, and paying nvidia-smi twice to
   *     answer two questions about the same instant is how those two answers
   *     come to disagree. */
  const vram = await refuseVram(wantRig && !image ? RIG_CAP : MESH_CAP);

  /* 4 · THE RIG, on a mesh that is not a plausible subject for one. Only when
   *     there is already a mesh to look at — before the first stage there is
   *     nothing to measure, and guessing from the picture would be a claim this
   *     module cannot support. */
  if (wantRig && glbForRig) await refuseRig(glbForRig);
  return { ...st, vram };
}

/** REFUSAL 2 — the input is not an image, or carries no subject. */
export async function refuseInput(image) {
  const p = String(image || "");
  if (!p) {
    throw new MeshRefusal("input",
      "There is no picture to build a mesh from. This turns ONE reference panel into geometry, "
      + "so the row needs a rendered sheet first — Generate or Blender on the card, then this.");
  }
  if (!IMAGE_RE.test(p)) {
    throw new MeshRefusal("input",
      `${path.basename(p)} is not an image. This reads a .png, .jpg or .webp — one panel, one `
      + `subject. A video, a mesh or a document cannot be an input here.`);
  }
  let head;
  try {
    const buf = await readFile(p);
    head = buf.subarray(0, 16);
    if (!buf.length) throw new Error("empty");
  } catch (e) {
    throw new MeshRefusal("input", `${path.basename(p)} could not be read: ${e.message}`);
  }
  const looksLike = MAGIC.find((m) => m.bytes.every((b, i) => head[i] === b));
  const webpOk = looksLike?.name !== "WEBP" || head.toString("latin1", 8, 12) === "WEBP";
  if (!looksLike || !webpOk) {
    throw new MeshRefusal("input",
      `${path.basename(p)} has an image extension and is not one — its first bytes match no PNG, `
      + `JPEG or WebP header. Something renamed a file.`);
  }
  /* CARRIES NO SUBJECT — reusing the gate that already owns this question.
   * server/mv/blender.js's referenceSafe() answers "is this ONE panel of ONE
   * subject", by filename, by sidecar and, last, by the contact-sheet marker in
   * the border pixels, which is the only signal that survives a rename. A grid
   * has no subject: it has three of them and a gutter. */
  const gate = await referenceSafe(p);
  if (!gate.safe) {
    throw new MeshRefusal("input",
      `${path.basename(p)} is a contact sheet, not a subject.\n`
      + gate.why.map((w) => `  - ${w}`).join("\n")
      + `\nAn image-to-3D model handed a grid builds a mesh OF THE GRID. Crop one panel out of it, `
      + `or re-render the sheet with the single-panel reference path.`);
  }
}

/** REFUSAL 3 — free VRAM below the row's stated minimum. */
export async function refuseVram(capId = MESH_CAP, opts = {}) {
  const c = cap(capId);
  const needGb = Number(c?.requires?.vramMinGb ?? 0);
  if (!needGb) return { free: null, needGb: 0 };
  /* ⚠ THE READING IS SUPPLIED BY PRESENCE, NOT BY VALUE. `null` is a legal
   * reading here — it MEANS "there is no NVIDIA card to read" — so a default of
   * `free = null` would make an explicit no-reading indistinguishable from
   * "please go and look", and the branch that matters most would be the one
   * that could not be tested. Caught by the test that asserts a card-less
   * machine is not refused: it passed null, this went and read the live card,
   * and refused. */
  const freeMb = "free" in opts ? opts.free : await freeVramMb();
  /* NO READING IS NOT A REFUSAL. An AMD card, a laptop with no discrete GPU, a
   * driver that is mid-update — none of those is evidence of a full card, and
   * refusing on absent evidence is how a gate ends up blocking the first
   * machine that is merely unusual. It runs, and CUDA gets to have its own
   * opinion. */
  if (freeMb === null) return { free: null, needGb };
  if (freeMb < needGb * GB) {
    throw new MeshRefusal("vram",
      `Only ${(freeMb / GB).toFixed(1)} GB of the graphics card is free and `
      + `${c.label} needs ${needGb} GB, so nothing was started.\n`
      + `The music and video engine is resident — that is what is holding the card, and it is `
      + `holding it on purpose. Unload it first (stop the engine from the Models or Engine screen, `
      + `or finish whatever is rendering), then run this again. Nothing here will evict it: a mesh `
      + `is not worth somebody's half-finished song.\n`
      + `This is a refusal rather than an out-of-memory forty seconds in, which is the same failure `
      + `with none of the explanation.`,
      { freeMb, needGb });
  }
  return { free: freeMb, needGb };
}

/** REFUSAL 4 — a rig asked for on something that is not a plausible humanoid. */
export async function refuseRig(glbPath) {
  const g = await readGlbFile(glbPath);
  if (!g.ok) {
    throw new MeshRefusal("rig-input",
      `The mesh at ${path.basename(glbPath)} could not be read as a GLB, so it was not sent to be `
      + `rigged.\n` + g.why.map((w) => `  - ${w}`).join("\n"));
  }
  const h = plausiblyHumanoid(g.json);
  if (!h.plausible) {
    throw new MeshRefusal("not-humanoid",
      `This does not look like something a skeleton belongs in — ${h.why}.\n`
      + `UniRig is trained on ARTICULATED subjects. Asked to rig a crate it does not fail; it `
      + `invents a skeleton for a crate and reports success, which is the expensive kind of wrong. `
      + `The mesh itself is finished and kept — only the rig was refused.`,
      { ratio: h.ratio });
  }
  return h;
}

/* ──────────────────────────────────────── can this machine rig, really */

/** Cached prerequisite probe in the configured UniRig interpreter. No weights
 * are loaded. Readiness is distinct from a validated model result; the adapter
 * reports endToEndValidated:false until an actual output is inspected. */
let rigRuntimeOnce = null;
/* The same answer, once it exists, readable WITHOUT awaiting — meshStatus() is
 * a page-load call and must not block on a 13-second spawn. Set from the one
 * place the promise settles, so it cannot disagree with rigRuntimeOnce. */
let rigProbeAnswer = null;
export function rigRuntime({ timeoutMs = 120e3, force = false } = {}) {
  if (force) { rigRuntimeOnce = null; rigProbeAnswer = null; }
  if (!rigRuntimeOnce) {
    rigRuntimeOnce = runMeshCli(["--rig-probe"], { timeoutMs })
      .then((r) => r?.probe || { canRig: false, missing: [{ module: "?", why: "the probe answered nothing", error: "" }] })
      /* A probe that cannot run is NOT a rig that can. The python being absent
       * is already meshStatus()'s sentence, so this one says only what it saw. */
      .catch((e) => ({ canRig: false, probeFailed: true,
                       missing: [{ module: "(the probe itself)", why: "the 3D python could not answer", error: e.message }] }))
      .then((p) => { rigProbeAnswer = p; return p; });
  }
  return rigRuntimeOnce;
}

/**
 * The probe's answer if this process has one, else null. Never spawns, never
 * waits. `null` is "nobody has asked", which meshStatus() reports as
 * `unchecked` — and unchecked is not ready.
 */
export function rigProbeCached() { return rigProbeAnswer; }

/** The refusal both rig paths share, so its sentence exists once. */
async function refuseRigRuntime() {
  const probe = await rigRuntime();
  if (probe.canRig) return probe;
  throw new MeshRefusal("rig-runtime",
    `A rig was asked for and UniRig cannot run on this machine, so nothing was started.\n`
    + probe.missing.map((m) => `  - ${m.module}: ${m.error}\n    ${m.why}`).join("\n")
    + `\nSet AIPLAY_UNIRIG_PYTHON to a separate compatible UniRig environment. The supported `
    + `upstream stack uses Python 3.11, bpy 4.2, Transformers 4.51.3, NumPy 1.26.4 and CUDA `
    + `extensions. The adapter will not install packages or download weights. TripoSG can `
    + `keep using AIPLAY_MESH_PYTHON.`,
    { probe });
}

/* ────────────────────────────────────────────── facts for the record */

/** sha256 of a file, streamed. Cached per process by path+size+mtime. */
const hashCache = new Map();
export async function sha256File(file) {
  let key;
  try {
    const s = await stat(file);
    key = `${file}|${s.size}|${s.mtimeMs}`;
  } catch { return null; }
  if (hashCache.has(key)) return hashCache.get(key);
  const digest = await new Promise((resolve) => {
    const h = createHash("sha256");
    const rs = createReadStream(file);
    rs.on("data", (d) => h.update(d));
    rs.on("error", () => resolve(null));
    rs.on("end", () => resolve(`sha256:${h.digest("hex")}`));
  });
  hashCache.set(key, digest);
  return digest;
}

/**
 * The sha256 of every weight file a capability uses.
 *
 * ⚠ MEASURED OFF THE DISK, not copied out of the catalogue row, and the two are
 * different claims: the row says what the publisher shipped, this says what
 * this machine loaded. The record needs the second one — that is the whole
 * value of a provenance line about a licence.
 *
 * It is hashed ONCE PER PROCESS per (path, size, mtime). The first mesh of a
 * session pays a few seconds of disk read for roughly 7 GB; every later one is
 * free. It is paid BEFORE the run rather than after, because the record is
 * written before the GPU is touched and a record assembled afterwards is a
 * record that can disagree with what ran.
 */
async function weightFacts(capId) {
  const c = cap(capId);
  const out = [];
  for (const f of c?.files || []) {
    out.push({
      file: path.basename(f.dest), dest: f.dest,
      declaredBytes: f.bytes,
      bytes: await stat(f.dest).then((s) => s.size, () => null),
      sha256: await sha256File(f.dest),
    });
  }
  return out;
}

/**
 * The commit a checkout is pinned at, or null.
 *
 * A model is its weights AND the code that ran them: TripoSG's sampler is in
 * the checkout, not in the safetensors, so a record naming only the file
 * describes half of what happened. `null` when the directory is not a git
 * checkout, which is honest and is not an error — a downloaded zip has no
 * commit and pretending otherwise would invent one.
 */
export function gitHead(dir) {
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), 5000);
    let proc;
    try { proc = spawn("git", ["-C", dir, "rev-parse", "HEAD"], { windowsHide: true }); }
    catch { return finish(null); }
    proc.stdout.on("data", (d) => { out += d; });
    proc.on("error", () => finish(null));
    proc.on("exit", (code) => finish(code === 0 && /^[0-9a-f]{40}$/.test(out.trim()) ? out.trim() : null));
  });
}

/* ─────────────────────────────────────────────────────── the subprocess */

/**
 * Run the driver in the 3D venv and read its answer.
 *
 * Shaped on `server/mv/blender.js`'s runPreviz() deliberately, down to the
 * brace-matched result parse — which is imported from there rather than copied,
 * because the failure it fixes belongs to any subprocess whose stdout is shared
 * with a library's own printing, and two copies of a hardened thing decay into
 * one hardened thing and one that looks like it. (Measured over there on a
 * 121-frame blockout: the JSON arrived complete and the newline after it did
 * not, so Blender's own banner landed on the same line.)
 *
 * Exit codes are the driver's, and mirror the toolkit's so there is one
 * vocabulary: 0 done, 2 REFUSED (a rule the python enforces, reason on stderr),
 * 3 the run failed.
 */
/** Select only an executable path; shell command strings are never evaluated. */
export function meshPythonForArgs(args) {
  return args.includes("--rig-only") || args.includes("--rig-probe")
    ? config.mesh.unirigPython : config.mesh.python;
}

/** Stop only the process tree owned by this invocation, including UniRig stages.
 *  The one implementation lives in server/proctree.js (the art queue's Stop
 *  uses it too); this name stays for yue-gguf.js, yue.js, score/sheet.js and
 *  their tests, which import it from here. */
export const killMeshProcessTree = killProcessTree;

export function runMeshCli(args, { timeoutMs = 20 * 60e3, cwd = null } = {}) {
  const py = meshPythonForArgs(args);
  /* fileURLToPath, not `new URL(...).pathname` — on Windows that yields
   * "/C:/temp/..." with the drive letter behind a slash, and the spawn fails on
   * a path that looks almost right. */
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "mesh_cli.py");
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(py, ["-u", cli, ...args], {
        windowsHide: true, detached: process.platform !== "win32",
        cwd: cwd || os.tmpdir(),
        /* The checkouts are handed in as environment rather than as a
         * sys.path edit in this process — this process has no sys.path. */
        env: { ...process.env, AIPLAY_TRIPOSG: config.mesh.triposg, AIPLAY_UNIRIG: config.mesh.unirig,
               AIPLAY_MESH_WEIGHTS: config.mesh.weights, AIPLAY_UNIRIG_PYTHON: config.mesh.unirigPython },
      });
    } catch (err) {
      reject(new Error(`Could not start the 3D python at ${py}: ${err.message}`));
      return;
    }
    let out = "", err = "", done = false, timedOut = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      timedOut = true;
      killMeshProcessTree(proc).then((stopped) => finish(reject, new Error(
        `The 3D runtime did not finish in ${Math.round(timeoutMs / 1000)}s — `
        + (stopped ? "its owned process tree was stopped." : "process-tree termination could not be confirmed."))));
    }, timeoutMs);

    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => finish(reject, new Error(
      e.code === "ENOENT"
        ? `The selected 3D python is not at ${py}. Set AIPLAY_MESH_PYTHON or AIPLAY_UNIRIG_PYTHON to the corresponding interpreter.`
        : `The 3D python failed to start: ${e.message}`)));
    proc.on("close", (code) => {
      if (timedOut) return;
      const marker = out.lastIndexOf(RESULT_MARKER);
      const payload = marker < 0 ? null : jsonAfter(out, marker + RESULT_MARKER.length);
      if (code === 0 && payload) {
        try { return finish(resolve, JSON.parse(payload)); }
        catch { return finish(reject, new Error("The 3D python answered with a result line that is not JSON.")); }
      }
      let detail = (err.trim() || out.split(/\r?\n/).slice(-8).join("\n")).trim();
      /* LEAD WITH THE SENTENCE, NOT WITH THE STACK — the same hoist previz
       * does, for the same reason: a python traceback puts the stack first and
       * the one useful line last. */
      const lines = detail.split(/\r?\n/);
      const at = lines.findLastIndex((l) => /^[A-Za-z_][\w.]*(?:Error|Exception): \S/.test(l));
      if (at >= 0) detail = `${lines.slice(at).join("\n").trim()}\n\n${detail}`;
      finish(reject, new Error(
        code === 2 ? `The 3D runtime refused this run.\n${detail}`
        : code === 3 ? `The 3D run failed.\n${detail}`
        : code === 0 ? `The 3D python finished without answering — it raised instead:\n${detail}`
        : `The 3D python exited ${code}.\n${detail}`));
    });
  });
}

/* ───────────────────────────────────────────── the run, with its record */

/** Sortable and collision-safe, the same shape the engine door's runIds have. */
const newRunId = () => `${Date.now().toString(36)}${createHash("sha1")
  .update(String(Math.random())).digest("hex").slice(0, 6)}`;

/**
 * Image in, `.glb` out, optionally rigged — with a ledger row on both sides.
 *
 * ── THE RECORD, WRITTEN BY HAND ───────────────────────────────────────────
 *
 * The engine door builds its record from a GRAPH, which this has none of. So it
 * is assembled here, field by field, and it carries the same things for the
 * same reasons: what ran (the pinned commit of each checkout, plus every weight
 * file with its measured sha256), what it was asked (every argument and the
 * seed), what it cost (queued/running/elapsed in seconds), and what came out
 * (the file, its bytes and its sha256).
 *
 * `model` is the catalogue's engine name, so `provenance.append()`'s
 * stampRights() resolves it through MODEL_TO_CAPABILITY and the row lands
 * stamped MIT rather than `unknown`. That single field is why the two lines in
 * that map exist.
 *
 * ⚠ THE DELEGATE APPEND IS AWAITED AND HAS NO `.catch()`. Read the engine
 * door's warning at the same line: a run the ledger refused never started.
 */
export async function meshFromImage({
  image, out, rig = false, seed = 42, steps = 50, guidance = 7,
  actor = "system", via = "mesh.api", project = null, subject = null,
  timeoutMs = 20 * 60e3, prov = provenance, dryRun = false,
  offload: offloadOpt = "auto",
} = {}) {
  const who = normalizeActor(actor);
  if (!out) throw new Error("meshFromImage needs an output path.");
  if (!String(via || "").trim()) {
    throw new Error("meshFromImage needs `via`: a short caller id (mv.mesh_asset, mcp.mesh, api). "
      + "It is what lets the ledger answer which part of the app spent the card.");
  }

  /* ⚠ WHY A DRY RUN IS NOT REFUSED, and what it returns instead.
   *
   * A dry run spends nothing — no python, no card, no ledger row — so refusing
   * it because the card is busy would withhold the one answer that is free, on
   * exactly the machine where somebody most needs to plan around a busy card.
   * The engine door makes the same call for the same reason: its `dryRun`
   * return sits ABOVE the "is our engine alive" check.
   *
   * What it does keep is the INPUT check, because a contact sheet is a contact
   * sheet whether or not anything runs, and a dry run that blessed one would be
   * a promise the real run then breaks. Everything else is REPORTED rather than
   * thrown: `wouldRefuse` carries the first refusal a real run would hit, with
   * its code and its sentence, so a caller can cost the run and act on the
   * blocker in one call instead of two. */
  let wouldRefuse = null;
  /* The card reading taken by refuse(), reused to decide how to load. */
  let free = null;
  if (dryRun) {
    await refuseInput(image);
    try { await refuse({ image, wantRig: rig }); }
    catch (e) { wouldRefuse = { code: e.refusal || null, why: e.message }; }
  } else {
    const status = await refuse({ image, wantRig: rig });
    /* THE FILES, deliberately — this sentence is about checkpoints, and the
     * runtime's own sentence is refuseRigRuntime()'s two lines below. */
    if (rig && !status.rigWeightsReady) {
      throw new MeshRefusal("rig-runtime",
        `A rig was asked for and UniRig is not ready on this machine, so nothing was started.\n`
        + status.why.map((w) => `  - ${w}`).join("\n")
        + `\nRun without the rig to get the mesh, then rig it once the checkpoints are in place.`);
    }
    /* ⚠ AND THE FILES BEING THERE IS NOT THE RUNTIME BEING THERE. Asked BEFORE
     * the mesh is spent, because a rig that fails after the expensive half has
     * run is the exact failure the whole refusal block exists to replace. */
    if (rig) await refuseRigRuntime();
    free = status.vram?.free ?? null;
  }

  /* ⚠ HOW THE MODEL IS LOADED, decided from the reading the refusal already
   * took rather than from a preference. "auto" pages the three modules in one
   * at a time whenever the free card is under the row's RECOMMENDED figure —
   * which on this machine it always is, because the owner's music and video
   * engine is resident and is not going to be evicted for a mesh. Offload is
   * slower per step and it is the difference between running beside somebody's
   * work and refusing to run at all. `true`/`false` override it. */
  const recGb = Number(cap(MESH_CAP)?.requires?.vramRecGb || 0);
  const offload = offloadOpt === "auto"
    ? (free !== null && free < recGb * GB)
    : !!offloadOpt;

  const runId = newRunId();
  const args = {
    image: path.resolve(image), out: path.resolve(out),
    rig: !!rig, seed: Number(seed) || 0, steps: Number(steps) || 50, guidance: Number(guidance) || 7,
    offload,
  };
  const record = {
    runId, via, actor: who, appVersion: TOOL,
    model: MESH_MODEL,
    /* Both models named when both ran, because the rights of the artefact are
     * the union — and both are MIT, which is the point of choosing them. */
    models: rig ? [MESH_MODEL, RIG_MODEL] : [MESH_MODEL],
    project, subject,
    args,
    seed: args.seed,
    runtime: {
      python: config.mesh.python,
      triposgCommit: await gitHead(config.mesh.triposg),
      unirigPython: rig ? config.mesh.unirigPython : null,
      unirigCommit: rig ? await gitHead(config.mesh.unirig) : null,
    },
    weights: [
      ...(await weightFacts(MESH_CAP)),
      ...(rig ? await weightFacts(RIG_CAP) : []),
    ],
    input: { file: path.basename(args.image), sha256: await sha256File(args.image) },
    door: SECOND_DOOR,
  };

  if (dryRun) return { ok: true, dryRun: true, runId, status: "not-run", record, wouldRefuse };

  const t0 = Date.now();
  // ⚠ AWAITED. NO .catch(). A throw here means nothing was spent.
  const delegate = await prov.append("library", {
    actor: who, type: "delegate", asset: `mesh/${runId}`, data: record,
  });

  await mkdir(path.dirname(args.out), { recursive: true });
  let answer, error = null;
  try {
    answer = await runMeshCli([
      "--image", args.image, "--out", args.out,
      "--seed", String(args.seed), "--steps", String(args.steps),
      "--guidance", String(args.guidance),
      ...(offload ? ["--offload"] : []),
    ], { timeoutMs });
    if (rig) {
      const remainingMs = timeoutMs - (Date.now() - t0);
      if (remainingMs <= 0) throw new Error("The mesh completed but no time remained for rigging; the mesh was kept.");
      const rigAnswer = await runMeshCli(["--rig-only", "--glb", args.out, "--out", args.out,
        "--seed", String(args.seed)], { timeoutMs: remainingMs });
      answer = { ...answer, rigged: true, timings: { ...answer?.timings, ...rigAnswer?.timings } };
    }
  } catch (e) {
    error = e.message;
  }
  const elapsedSec = (Date.now() - t0) / 1000;

  /* WHAT ACTUALLY LANDED, checked rather than believed. A python that exits 0
   * and writes nothing is a real failure mode and the ledger must not record a
   * mesh that is not there. */
  const glb = error ? { ok: false, why: [error] } : await readGlbFile(args.out);
  const skin = glb.ok ? assertSkinned(glb.json) : { ok: false, joints: 0, why: glb.why };
  /* ⚠ AND THE SECOND QUESTION, which the structure cannot answer. A skin that
   * binds every vertex to the root passes everything above and cannot be
   * posed — two such GLBs were built and no structural check tells them apart.
   * Closed form, a few milliseconds, no subprocess: this is inside the spend
   * path, and the Blender cross-check belongs one layer up in asset.js where a
   * second of somebody else's arithmetic is affordable. */
  const deform = skin.ok ? assertDeforms(glb.json, glb.binData)
    : { state: "unreadable", ok: false, strain: 0,
        why: ["the skin did not verify, so the mesh was never posed"] };
  const bytes = await stat(args.out).then((s) => s.size, () => null);

  /* THE RIG IS ASSERTED, NOT REPORTED. UniRig writing a file is not UniRig
   * writing a rig — see glb.js. A run that asked for a rig and produced a GLB
   * with no `skins` is a FAILED rig with a successful-looking exit code, and
   * this is the only place that difference is visible. */
  /* And a run that produced a skin which does not deform is the same failure
   * one layer in: the file parses, every field is there, and nothing about it
   * can be posed. */
  const rigOk = rig ? (skin.ok && deform.ok) : null;
  const status_ = error ? "failed" : !glb.ok ? "failed" : (rig && !rigOk) ? "rig-failed" : "completed";

  const data = {
    ...record,
    status: status_,
    error: error || (glb.ok ? null : glb.why.join("; ")),
    elapsedSec: Number(elapsedSec.toFixed(3)),
    /* The driver reports its own split — model load against sampling — because
     * "four minutes" answers a different question from "three of them were
     * loading 7 GB off a spinning disk". */
    timings: answer?.timings || null,
    output: {
      file: path.basename(args.out), path: args.out, kind: "3d",
      bytes, sha256: await sha256File(args.out),
      skinned: skin.ok, joints: skin.joints || 0,
      skinWhy: skin.ok ? [] : (skin.why || []),
      /* The MEASUREMENT is recorded, not only the verdict, so a ledger row read
       * a year from now says what was measured and how far it sat from the
       * floor rather than only which side of it. */
      deforms: deform.state, strain: deform.strain ?? 0,
      deformWhy: deform.ok ? [] : (deform.why || []),
    },
  };
  const generate = await prov.append("library", {
    actor: who, type: "generate", asset: `mesh/${runId}`, data,
  }).catch((e) => { console.warn(`  [mesh] ${runId}: ledger append failed: ${e.message}`); return null; });

  if (error) { const e = new Error(error); e.runId = runId; throw e; }
  if (!glb.ok) {
    const e = new Error(`The 3D run reported success and wrote no usable GLB:\n`
      + glb.why.map((w) => `  - ${w}`).join("\n"));
    e.runId = runId;
    throw e;
  }
  return {
    ok: true, runId, status: status_, elapsedSec: data.elapsedSec,
    out: args.out, bytes, skinned: skin.ok, joints: skin.joints || 0,
    deforms: deform.state, strain: deform.strain ?? 0,
    rigRefused: rig && !rigOk
      ? [...(skin.ok ? [] : skin.why || []), ...(deform.ok ? [] : deform.why || [])] : null,
    record: data, ledger: { delegate, generate },
  };
}

/**
 * Rig a mesh that already exists.
 *
 * Separate from the pass above rather than a flag on it, because it is the one
 * that can be REFUSED on evidence: by the time it runs there is a GLB to
 * measure, so `refuseRig()` can look at the proportions instead of guessing
 * from a picture. Same record, same pair of ledger rows, `model: "unirig"`.
 */
export async function rigMesh({
  glb, out, actor = "system", via = "mesh.rig", project = null, subject = null,
  timeoutMs = 20 * 60e3, prov = provenance, dryRun = false,
} = {}) {
  const who = normalizeActor(actor);
  const st = await meshStatus();
  /* THE FILES. The runtime is refuseRigRuntime()'s sentence four lines down,
   * and asking one question per refusal is why either sentence is actionable. */
  if (!st.rigWeightsReady) {
    throw new MeshRefusal("rig-weights",
      `UniRig's files are not ready on this machine, so nothing was started.\n`
      + st.why.map((w) => `  - ${w}`).join("\n"), { status: st });
  }
  /* The runtime, not the files — see refuseRigRuntime(). This path has no
   * expensive half in front of it, but the sentence is the one that tells a
   * person what is actually wrong, and a duplicated wrong one is worse. */
  await refuseRigRuntime();
  await refuseVram(RIG_CAP);
  const shape = await refuseRig(glb);

  const runId = newRunId();
  const args = { glb: path.resolve(glb), out: path.resolve(out), rigOnly: true };
  const record = {
    runId, via, actor: who, appVersion: TOOL,
    model: RIG_MODEL, models: [RIG_MODEL], project, subject, args, seed: 42,
    runtime: { python: config.mesh.unirigPython, unirigCommit: await gitHead(config.mesh.unirig) },
    weights: await weightFacts(RIG_CAP),
    input: { file: path.basename(args.glb), sha256: await sha256File(args.glb),
             proportions: { ratio: shape.ratio, why: shape.why } },
    door: SECOND_DOOR,
  };
  if (dryRun) return { ok: true, dryRun: true, runId, status: "not-run", record };

  const t0 = Date.now();
  const delegate = await prov.append("library", {
    actor: who, type: "delegate", asset: `mesh/${runId}`, data: record,
  });
  await mkdir(path.dirname(args.out), { recursive: true });
  let answer, error = null;
  try {
    answer = await runMeshCli(["--rig-only", "--glb", args.glb, "--out", args.out], { timeoutMs });
  } catch (e) { error = e.message; }

  const g = error ? { ok: false, why: [error] } : await readGlbFile(args.out);
  const skin = g.ok ? assertSkinned(g.json) : { ok: false, joints: 0, why: g.why };
  /* THE SAME SECOND QUESTION, and this is the verb it matters most for: this
   * one exists to make a rig, so "it wrote a file with joints in it" is the
   * weakest claim in the subsystem. See server/mesh/deform.js. */
  const deform = skin.ok ? assertDeforms(g.json, g.binData)
    : { state: "unreadable", ok: false, strain: 0,
        why: ["the skin did not verify, so the mesh was never posed"] };
  const rigOk = skin.ok && deform.ok;
  const data = {
    ...record,
    status: error ? "failed" : rigOk ? "completed" : "rig-failed",
    error: error || (rigOk ? null
      : [...(skin.ok ? [] : skin.why), ...(deform.ok ? [] : deform.why)].join("; ")),
    elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(3)),
    timings: answer?.timings || null,
    output: { file: path.basename(args.out), path: args.out, kind: "3d",
              bytes: await stat(args.out).then((s) => s.size, () => null),
              sha256: await sha256File(args.out),
              skinned: skin.ok, joints: skin.joints || 0, skinWhy: skin.ok ? [] : (skin.why || []),
              deforms: deform.state, strain: deform.strain ?? 0,
              deformWhy: deform.ok ? [] : (deform.why || []) },
  };
  const generate = await prov.append("library", {
    actor: who, type: "generate", asset: `mesh/${runId}`, data,
  }).catch((e) => { console.warn(`  [mesh] ${runId}: ledger append failed: ${e.message}`); return null; });

  if (error) { const e = new Error(error); e.runId = runId; throw e; }
  if (!rigOk) {
    throw new MeshRefusal("rig-failed", skin.ok
      ? `The rig ran and the result BINDS BUT DOES NOT DEFORM, so it is not a rigged mesh:\n`
        + deform.why.map((w) => `  - ${w}`).join("\n")
        + `\nEvery structural check passes: skins, joints, MAT4 bind matrices, JOINTS_0/WEIGHTS_0,`
        + ` every weight row summing to one. Turning the joints does not change the mesh's shape,`
        + ` which is the only thing a skeleton is for.`
        + `\nThe file was written and the ledger records the failure. The unrigged mesh is untouched.`
      : `The rig ran and the result has no usable skin, so it is not a rigged mesh:\n`
      + skin.why.map((w) => `  - ${w}`).join("\n")
      + `\nThe file was written and the ledger records the failure. The unrigged mesh is untouched.`,
      { runId });
  }
  return { ok: true, runId, out: args.out, joints: skin.joints, skinned: true,
           deforms: deform.state, strain: deform.strain,
           elapsedSec: data.elapsedSec, record: data, ledger: { delegate, generate } };
}

/** Exported for the tests and for anything that wants to clean a scratch dir. */
export const scratchClean = (dir) => rm(dir, { recursive: true, force: true }).catch(() => {});
/** Exported so a caller can write a sidecar beside a mesh without re-deriving it. */
export const writeSidecarJson = (file, obj) => writeFile(file, JSON.stringify(obj, null, 2), "utf8");
