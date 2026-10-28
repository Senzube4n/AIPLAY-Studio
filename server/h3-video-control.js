/** H3 structural video control. Validation is free; preparation runs in the art queue. */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegPath, ffprobePath } from "./clipjoin.js";
import { engineBases, scanBases, findShelfModel, MODEL_FOLDERS } from "./localmodels.js";
import { h3ControlHeader, h3ControlCheckpointSelection, effectiveH3ControlCheckpoint } from "./h3-control-compat.js";

const execute = promisify(execFile);
const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;
const MAX_SOURCE_BYTES = 2 * 1024 ** 3;
const within = (root, file) => { const rel = path.relative(root, file); return rel !== "" && !rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel); };
const fail = (error, reason = "control-video", extra = {}) => Object.assign(new Error(error), { reason, status: 400, ...extra });
const stopped = () => fail("The video control job was stopped.", "control-stopped");
const cancelled = (fn) => { if (fn?.()) throw stopped(); };
export const videoControlTerminal = (done) => done?.status === "completed" || done?.status === "rejected" ||
  (done?.status === "error" && done?.entry?.status?.status_str === "error");
const choices = (entry) => Array.isArray(entry?.[0]) ? entry[0] : entry?.[0] === "COMBO" ? entry[1]?.options : null;

export async function videoControlSha(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function ownedFile(root, name) {
  if (typeof name !== "string" || name !== path.basename(name) || /[\\/:\x00-\x1f]/.test(name) || name.includes("..") || !VIDEO.test(name))
    throw fail("Name a video in the clips library, not a path.");
  const base = await realpath(root).catch(() => { throw fail("The clips library is not available on this machine."); });
  const file = path.join(base, name);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw fail("That video is not a regular file in the clips library.");
  const canonical = await realpath(file).catch(() => { throw fail("The source video is no longer readable."); });
  if (!within(base, canonical)) throw fail("That video is outside the clips library.");
  if (!info.size || info.size > MAX_SOURCE_BYTES) throw fail("A control source must be a nonempty video under 2 GiB.");
  return { file: canonical, bytes: info.size, mtimeMs: info.mtimeMs };
}

/** Local containers only: do not let a mislabeled playlist fetch other resources. */
export async function probeVideoControl(file) {
  const { stdout } = await execute(ffprobePath(), ["-v", "error", "-protocol_whitelist", "file,pipe",
    "-format_whitelist", "mov,matroska,webm", "-count_frames", "-show_entries",
    "stream=codec_type,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration:format=duration", "-of", "json", file],
  { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout), videos = (data.streams || []).filter((row) => row.codec_type === "video");
  if (videos.length !== 1) throw fail("The control source must contain exactly one video stream.");
  const row = videos[0], ratio = String(row.avg_frame_rate || row.r_frame_rate).split("/").map(Number);
  const fps = ratio.length === 2 ? ratio[0] / ratio[1] : ratio[0];
  const out = { width: Number(row.width), height: Number(row.height), fps, frames: Number(row.nb_read_frames),
    seconds: Number(row.duration || data.format?.duration) };
  if (!Object.values(out).every((n) => Number.isFinite(n) && n > 0) || !Number.isInteger(out.frames) ||
      out.width > 8192 || out.height > 8192 || out.frames > 100_000 || out.seconds > 3600)
    throw fail("The source video could not be measured within the control limits.");
  return out;
}

export function h3ControlOptions(request = {}) {
  const source = request.sourceVideo ?? request.source_video;
  if (!source) {
    if (request.controlMode !== undefined || request.control_mode !== undefined || request.controlStrength !== undefined || request.control_strength !== undefined ||
        request.controlStart !== undefined || request.control_start !== undefined || request.controlEnd !== undefined || request.control_end !== undefined)
      throw fail("Choose a source video before setting video control.", "control-options");
    return null;
  }
  if (request.sourceVideo && request.source_video && request.sourceVideo !== request.source_video)
    throw fail("The two source video names disagree.", "control-options");
  const mode = request.controlMode ?? request.control_mode ?? "depth";
  if (!["depth", "pose", "prepared"].includes(mode)) throw fail("Choose depth, pose or an already prepared control video.", "control-options");
  const number = (camel, snake, fallback, low, high) => {
    const value = request[camel] ?? request[snake] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high)
      throw fail(`${camel} must be a finite number from ${low} to ${high}.`, "control-options");
    return value;
  };
  const strength = number("controlStrength", "control_strength", 1, 0, 2);
  const start = number("controlStart", "control_start", 0, 0, 1), end = number("controlEnd", "control_end", 1, 0, 1);
  if (end <= start) throw fail("Control end must be later than control start.", "control-options");
  return { source: String(source), mode, strength, start, end };
}

/** A pure H3-sized extractor; unlike the VACE helper it has no fixed 121-frame floor. */
export function h3ControlGraph({ source, mode, width, height, frames, fps, prefix }) {
  const graph = {
    20: { class_type: "LoadVideo", inputs: { file: source } },
    21: { class_type: "GetVideoComponents", inputs: { video: ["20", 0] } },
    22: { class_type: "ImageFromBatch", inputs: { image: ["21", 0], batch_index: 0, length: frames } },
    23: mode === "depth" ? { class_type: "AiplayH3DepthGuide", inputs: { images: ["22", 0], model_name: "depth_anything_v2_vits.pth",
      resolution: Math.min(2048, Math.max(64, Math.ceil(Math.min(width, height) / 64) * 64)) } }
      : { class_type: "AiplayH3PoseGuide", inputs: { images: ["22", 0], detector_name: "yolox_l.torchscript.pt", pose_name: "dw-ll_ucoco_384_bs5.torchscript.pt",
        resolution: Math.min(2048, Math.max(64, Math.ceil(Math.min(width, height) / 64) * 64)) } },
    24: { class_type: "ImageScale", inputs: { image: ["23", 0], upscale_method: "bilinear", width, height, crop: "center" } },
    25: { class_type: "CreateVideo", inputs: { images: ["24", 0], fps } },
    26: { class_type: "SaveVideo", inputs: { video: ["25", 0], filename_prefix: prefix, format: "auto", codec: "auto" } },
  };
  return graph;
}

/** The same shelves and ambiguity rules used by the catalogue; never download. */
export async function resolveVideoControlModel(file, { modelConfig = null, shelf = null } = {}) {
  const relative = modelConfig?.modelsDir ? path.relative(modelConfig.modelsDir, file.dest) : null;
  const [folder, ...rest] = relative?.split(path.sep) || [];
  if (relative && within(modelConfig.modelsDir, file.dest) && MODEL_FOLDERS.includes(folder)) {
    const files = shelf || await scanBases(await engineBases(modelConfig));
    const primary = findShelfModel(files, folder, rest.join(path.sep));
    if (primary?.bytes === file.bytes) return { file: primary.full, name: primary.name, bytes: primary.bytes };
    for (const name of file.alt || []) {
      const alternative = findShelfModel(files, folder, name);
      if (alternative?.bytes > 0) return { file: alternative.full, name: alternative.name, bytes: alternative.bytes };
    }
    return null;
  }
  const primary = await stat(file.dest).catch(() => null);
  if (primary?.isFile() && (!file.bytes || primary.size === file.bytes)) return { file: file.dest, name: path.basename(file.dest), bytes: primary.size };
  for (const name of file.alt || []) {
    const candidate = path.join(path.dirname(file.dest), name), info = await stat(candidate).catch(() => null);
    if (info?.isFile() && info.size > 0) return { file: candidate, name, bytes: info.size };
  }
  return null;
}

export function createH3VideoControl({ clipDir, inputDir, outputDir, engine, catalog = [],
  modelConfig = null, probe = probeVideoControl, conform = null, sha = videoControlSha, runCommand = execute,
  selectCheckpoint = h3ControlCheckpointSelection, inspectHeader = h3ControlHeader } = {}) {
  const rowFor = (id) => catalog.find((row) => row.id === id);
  async function checkpoint(request, context, pinned = null) {
    const shelf = await scanBases(await engineBases(modelConfig || {}));
    const selected = pinned ? { file: pinned.requested, reference: pinned.reference } : selectCheckpoint(request, context);
    let resolved, facts;
    try {
      resolved = effectiveH3ControlCheckpoint(selected.file, modelConfig?.modelOverrides, shelf);
      facts = await inspectHeader(resolved.file);
    } catch (error) { throw fail(error.reason ? error.message : "The selected H3 checkpoint compatibility could not be read.", "control-compatibility"); }
    const result = { requested: resolved.requested, overridden: resolved.overridden, name: resolved.name, reference: selected.reference, ...facts };
    if (pinned && JSON.stringify(result) !== JSON.stringify(pinned)) throw fail("The selected H3 checkpoint or its override changed while this job waited. Check and queue it again.", "control-compatibility");
    return result;
  }
  function assertSelection(plan, graph = null) {
    const current = modelConfig?.modelOverrides?.[plan.checkpoint.requested] || plan.checkpoint.requested;
    if (current !== plan.checkpoint.overridden) throw fail("The selected H3 checkpoint override changed before submission.", "control-compatibility");
    const patch = modelConfig?.modelOverrides?.[plan.patch] || plan.patch;
    if (patch !== plan.patchOverride) throw fail("The H3 control patch override changed before submission.", "control-compatibility");
    if (graph && (graph[1]?.inputs?.unet_name !== plan.checkpoint.name || graph[33]?.class_type !== plan.patchLoader || graph[33]?.inputs?.name !== plan.patchName))
      throw fail("The final engine graph no longer names the checked H3 checkpoint and matching control patch. Check and queue it again.", "control-compatibility");
  }
  async function readiness(mode, base, pinnedPatch = null) {
    const shelf = modelConfig?.modelsDir ? await scanBases(await engineBases(modelConfig)) : null;
    const patchId = base.form === "full" ? "videoH3FunControlFull" : "videoH3FunControl";
    const patchLoader = base.form === "full" ? "AiplayH3FullControlPatchLoader" : "ModelPatchLoader";
    let patch, patchFacts, patchOverride, patchName;
    const ids = [patchId, ...(mode === "prepared" ? [] : [mode === "depth" ? "depthPreprocess" : "posePreprocess"])];
    for (const id of ids) {
      const row = rowFor(id), files = row?.files || [];
      let available;
      try { available = await Promise.all(files.map((file) => resolveVideoControlModel(file, { modelConfig, shelf }))); }
      catch { throw fail("A control model has ambiguous copies in the configured model folders. Keep one copy or choose a distinct relative path.", "control-models"); }
      const present = files.length && available.every(Boolean);
      if (!present) throw fail(`Video control needs ${row?.label || id}. Get it on the Models screen before rendering.`
        + (id === patchId ? " This patch carries H3's territory clause; read its terms before downloading." : ""), "needs-model", {
        needsModel: { id, label: row?.label || id, bytes: files.reduce((n, f) => n + (f.bytes || 0), 0), tool: "download_model",
          ...(row?.region ? { region: row.region.excluded || null } : {}) },
      });
      if (id === patchId) {
        patch = available[0].name;
        patchOverride = modelConfig?.modelOverrides?.[patch] || patch;
        if (base.form === "full" && patchOverride.split(/[\\/]/).pop() !== "MiniMax-H3-Fun-Controlnet-Union.safetensors")
          throw fail("The full-width H3 loader requires the original MiniMax-H3-Fun-Controlnet-Union.safetensors filename, including when an override is selected.", "control-compatibility");
        const overridden = patchOverride === patch ? available[0] : findShelfModel(shelf || [], "model_patches", patchOverride);
        if (!overridden) throw fail("The selected control patch override is unavailable or ambiguous.", "control-compatibility");
        patchName = overridden.name;
        try { patchFacts = await inspectHeader(overridden.file || overridden.full, { patch: true }); }
        catch (error) { throw fail(error.reason ? error.message : "The selected H3 control patch header could not be checked.", "control-compatibility"); }
        if (patchFacts.form !== base.form) throw fail("The H3 checkpoint and control patch use different AdaLN forms. Select the matching full-width or verified stock-curve patch.", "control-compatibility");
        if (pinnedPatch && JSON.stringify(patchFacts) !== JSON.stringify(pinnedPatch)) throw fail("The H3 control patch changed while this job waited.", "control-compatibility");
      }
    }
    const required = {
      MiniMaxH3FunControlNetApply: ["model", "model_patch", "vae", "strength", "start_percent", "end_percent"],
      [patchLoader]: ["name"], LoadVideo: ["file"], GetVideoComponents: ["video"], ImageScale: ["image", "upscale_method", "width", "height", "crop"],
      ...(mode === "prepared" ? {} : { ImageFromBatch: ["image", "batch_index", "length"], CreateVideo: ["images", "fps"], SaveVideo: ["video", "filename_prefix", "format", "codec"],
        [mode === "depth" ? "AiplayH3DepthGuide" : "AiplayH3PoseGuide"]: mode === "depth" ? ["images", "model_name", "resolution"] :
          ["images", "detector_name", "pose_name", "resolution"] }),
    };
    const schemas = {};
    for (const [name, fields] of Object.entries(required)) {
      let schema;
      try { schema = (await engine.objectInfo(name))?.[name]; } catch { /* Refuse before any GPU. */ }
      const inputs = { ...schema?.input?.required, ...schema?.input?.optional };
      if (!schema || fields.some((field) => !inputs[field]) || (name === "MiniMaxH3FunControlNetApply" && !inputs.control_video))
        throw fail(`The local engine is missing ${name} for video control. Restart the idle Studio engine to deploy its bundled control nodes.`, "control-nodes", { needsNodes: [name] });
      schemas[name] = inputs;
    }
    for (const [name, field, value] of mode === "depth" ? [["AiplayH3DepthGuide", "model_name", "depth_anything_v2_vits.pth"]] : mode === "pose" ?
      [["AiplayH3PoseGuide", "detector_name", "yolox_l.torchscript.pt"], ["AiplayH3PoseGuide", "pose_name", "dw-ll_ucoco_384_bs5.torchscript.pt"]] : []) {
      if (!choices(schemas[name][field])?.includes(value)) throw fail(`The local ${name} cannot use the required ${value}.`, "control-nodes", { needsNodes: [name] });
    }
    if (!choices(schemas[patchLoader].name)?.includes(patchName)) throw fail("The H3 control patch is not available to this engine. Check the shared model paths and restart the idle engine.", "control-nodes", { needsNodes: [patchLoader] });
    return { patch, patchOverride, patchName, patchLoader, patchFacts, patchId };
  }

  async function check(request, { engineKey = "h3", width, height, fps = 24, frames, customWorkflow = false, models = null, refImages, refAudios } = {}) {
    const options = h3ControlOptions(request);
    if (!options) return null;
    if (engineKey !== "h3") throw fail("Video-to-video is H3's path. Switch the engine to h3.", "control-engine");
    if (customWorkflow) throw fail("Video control requires the built-in H3 workflow. Unassign the custom Video workflow first.", "workflow-incompatible");
    const defaults = { ...modelConfig?.video, ...modelConfig?.video?.engines?.h3 };
    const bridge = request.bridge ?? defaults.bridge;
    const blockCache = request.blockCache ?? defaults.blockCache;
    if (request.continueFrom || request.loop || request.refMods?.length || request.h3Tweaks ||
        (bridge && bridge !== "off") || blockCache === true ||
        (request.sparse && !["off", "auto"].includes(request.sparse)))
      throw fail("Video control cannot be combined with continuation, looping, RefMod, model tweaks, bridge, block cache or sparse attention.", "control-options");
    if (![width, height, frames, fps].every(Number.isFinite) || !Number.isInteger(frames) || frames < 5 || frames % 17 !== 5 || fps !== 24 ||
        width < 64 || height < 64 || width > 3840 || height > 3840 || width % 16 || height % 16)
      throw fail("Video control needs the actual H3 render size, 24 fps and aligned frame count.", "control-options");
    const source = await ownedFile(clipDir, options.source);
    let measured;
    try { measured = await probe(source.file); } catch (error) { throw fail(`The source video could not be read. ${error.reason ? error.message : "Check ffmpeg and try another local video."}`); }
    if (!measured || measured.error || ![measured.width, measured.height, measured.fps, measured.frames, measured.seconds].every((n) => Number.isFinite(n) && n > 0))
      throw fail("The source video could not be measured. Install ffmpeg or choose another video.");
    if (measured.seconds + 0.0001 < frames / fps) throw fail(`The source is too short: ${measured.seconds.toFixed(3)} s; this H3 render needs ${frames} frames (${(frames / fps).toFixed(3)} s). Short sources are not padded.`);
    const digest = await sha(source.file);
    const again = await ownedFile(clipDir, options.source);
    if (source.bytes !== again.bytes || source.mtimeMs !== again.mtimeMs) throw fail("The source video changed while it was checked. Choose it again.");
    const base = await checkpoint(request, { models, refImages, refAudios, width, height, frames, fps });
    const matching = await readiness(options.mode, base);
    return { version: 1, source: { name: options.source, sha256: digest, bytes: source.bytes }, measured, mode: options.mode,
      target: { width, height, fps, frames }, strength: options.strength, start: options.start, end: options.end, checkpoint: base, ...matching };
  }

  async function revalidate(plan) {
    assertSelection(plan);
    const base = await checkpoint(null, null, plan.checkpoint);
    const matching = await readiness(plan.mode, base, plan.patchFacts);
    for (const key of ["patch", "patchOverride", "patchName", "patchLoader", "patchId"]) if (matching[key] !== plan[key])
      throw fail("The matching H3 control patch selection changed while this job waited.", "control-compatibility");
    return matching;
  }

  async function prepare(plan, { actor, label, private: isPrivate = false, cancelled: isCancelled, onRun = () => {}, onStage = () => {} } = {}) {
    onStage("cpu");
    cancelled(isCancelled);
    const { patch, patchLoader } = await revalidate(plan);
    const source = await ownedFile(clipDir, plan.source.name);
    if (source.bytes !== plan.source.bytes || await sha(source.file) !== plan.source.sha256) throw fail("The source video changed while this job was queued. Queue it again.");
    const tag = `aiplay_h3ctl_${randomUUID().replaceAll("-", "")}`, owned = new Map();
    let unknown = false, released = false, held = engine.hold?.("H3 video control and render");
    const register = async (file) => { const info = await lstat(file); owned.set(file, { dev: info.dev, ino: info.ino }); };
    const cleanup = async ({ known = true } = {}) => {
      if (released) return;
      released = true;
      const retained = [];
      try {
        if (!known || unknown) return { retained: [...owned.keys()] };
        for (const [file, expected] of owned) {
          const now = await lstat(file).catch(() => null);
          if (now?.isFile() && !now.isSymbolicLink() && now.dev === expected.dev && now.ino === expected.ino) {
            try { await unlink(file); } catch { retained.push(file); }
          } else if (now) retained.push(file);
        }
      } finally { held?.(); }
      return { retained };
    };
    try {
      await mkdir(inputDir, { recursive: true });
      const raw = path.join(inputDir, tag + "_source" + path.extname(plan.source.name).toLowerCase());
      await copyFile(source.file, raw, constants.COPYFILE_EXCL); await register(raw);
      if (await sha(raw) !== plan.source.sha256) throw fail("The source video changed during staging.");
      cancelled(isCancelled);
      const normalized = path.join(inputDir, tag + "_normalized.mp4");
      const reservation = await open(normalized, "wx"); await reservation.close(); await register(normalized);
      const { width, height, frames, fps } = plan.target;
      if (conform) await conform(raw, normalized, plan.target);
      else await runCommand(ffmpegPath(), ["-v", "error", "-xerror", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", raw,
        "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
        "-frames:v", String(frames), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", normalized],
      { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 });
      const exact = async (file) => { const got = await probe(file); if (got.error || got.width !== width || got.height !== height || got.frames !== frames || Math.abs(got.fps - fps) > 0.0001) throw fail("The prepared control video does not match the H3 frame contract. Nothing was sampled."); };
      await exact(normalized); cancelled(isCancelled);
      const normalizedSha256 = await sha(normalized);
      let control = normalized, preprocessRunId = null;
      if (plan.mode !== "prepared") {
        const prefix = `h3control/${tag}_${plan.mode}`;
        const graph = h3ControlGraph({ source: path.basename(normalized), mode: plan.mode, ...plan.target, prefix });
        let done;
        try {
          cancelled(isCancelled); onStage("preprocess");
          done = await engine.run({ graph, actor, private: isPrivate === true, via: "art.control." + plan.mode, label: label || `${plan.mode} control: ${plan.source.name}`,
            clientId: "aiplay-h3-control", adopt: false, timeoutMs: 20 * 60_000, pollMs: 1000, cancelled: isCancelled });
        } catch (error) { unknown = !error?.safety && !["rejected", "control-stopped"].includes(error?.reason) && !/ComfyUI rejected the job:/.test(error?.message || ""); throw error; }
        onStage("cpu");
        onRun(done); preprocessRunId = done.runId ?? null;
        if (!videoControlTerminal(done)) unknown = true;
        if (done.status !== "completed") throw fail(`The ${plan.mode} extraction did not complete (${done.status}).`, "control-preprocess");
        const result = (done.outputs || []).find((row) => row.type === "output" && String(row.node) === "26" && row.subfolder === "h3control" &&
          typeof row.file === "string" && row.file === path.basename(row.file) && row.file.startsWith(tag + "_" + plan.mode) && VIDEO.test(row.file));
        if (!result) throw fail("The control extractor did not save its owned video output.", "control-preprocess");
        const output = await ownedFile(path.join(outputDir, "h3control"), result.file); await register(output.file);
        await exact(output.file);
        control = path.join(inputDir, tag + "_control.mp4");
        await copyFile(output.file, control, constants.COPYFILE_EXCL); await register(control);
        await exact(control); cancelled(isCancelled);
      }
      const receipt = { mode: plan.mode, patch: plan.patchName, patchLoader, patchFacts: plan.patchFacts, checkpoint: plan.checkpoint, source: plan.source, sourceMeasured: plan.measured, target: plan.target,
        normalizedSha256, controlSha256: await sha(control), preprocessRunId, strength: plan.strength, start: plan.start, end: plan.end };
      return { file: path.basename(control), patch, patchLoader, receipt, cleanup };
    } catch (error) {
      const state = await cleanup({ known: !unknown });
      if (state?.retained?.length) error.controlRetained = state.retained;
      throw error;
    }
  }
  return { check, prepare, revalidate, assertSelection };
}
