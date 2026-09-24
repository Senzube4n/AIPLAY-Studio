import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { qwenReferenceCandidates } from "./qwen-status.js";
import { QWEN_DRAFT } from "./qwen-image.js";

const SCRIPT = fileURLToPath(new URL("./image_editor.py", import.meta.url));
const ENGINE = "qwen-image-2.1";
const MODES = new Set(["edit", "style", "inpaint"]);

export function editorOptions(body) {
  const allowed = new Set(["action", "documentId", "source", "mode", "prompt", "refImages", "selection",
    "steps", "cfg", "seed", "refResolution", "transparent", "dit", "encoder", "vae"]);
  /* Fast draft is a Pictures setting. Masked edits are base-only, and edit and
   * style edits were not what the draft was judged on, so the editor says so
   * rather than calling the field unsupported. */
  if (body.draft !== undefined) throw new Error(QWEN_DRAFT.refusals.masked);
  const unsupported = Object.keys(body).filter(key => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported editor fields: ${unsupported.join(", ")}.`);
  const mode = body.mode ?? "edit";
  if (!MODES.has(mode)) throw new Error("mode must be edit, style or inpaint.");
  if (!!body.documentId === !!body.source) throw new Error("Choose exactly one documentId or source image filename.");
  const prompt = String(body.prompt || "").trim();
  if (!prompt || prompt.length > 8000) throw new Error("Describe the edit in 1–8000 characters.");
  const refImages = body.refImages ?? [];
  if (!Array.isArray(refImages) || refImages.length > 9 || refImages.some(n => typeof n !== "string" || !n.trim() || /[/\\]/.test(n)))
    throw new Error("Choose at most nine additional image filenames; the source is always image 1.");
  if (mode === "style" && !refImages.length) throw new Error("Style transfer needs at least one style reference (image 2).");
  if (mode === "inpaint" && refImages.length > 8) throw new Error("Masked edits allow eight extra references: image 1 is the source and image 2 is the selection mask.");
  if (mode === "inpaint" && (!body.selection || !Array.isArray(body.selection.shapes) || !body.selection.shapes.length))
    throw new Error("Draw a selection before requesting a masked edit.");
  const number = (key, fallback, min, max, integer = false) => {
    const value = body[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new Error(`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
    return value;
  };
  const resolution = number("refResolution", 1024, 0, 4096, true);
  if (resolution % 32) throw new Error("refResolution must be a multiple of 32, or 0 to preserve the source resolution.");
  if (body.transparent !== undefined && typeof body.transparent !== "boolean") throw new Error("transparent must be true or false.");
  if (mode === "inpaint" && body.transparent) throw new Error("Masked edits preserve source alpha outside the selection; transparent generation is available in Edit and Style modes.");
  const options = { engine: ENGINE, prompt, count: 1, refImages: [...refImages],
    steps: number("steps", 25, 1, 50, true), cfg: number("cfg", 1, 1, 10),
    seed: number("seed", Math.floor(Math.random() * 4294967296), 0, Number.MAX_SAFE_INTEGER, true),
    refSizing: "reference", refResolution: resolution, transparent: body.transparent ?? false,
    sampler: "euler", scheduler: "simple" };
  for (const key of ["dit", "encoder", "vae"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string" || !body[key].endsWith(".safetensors") || /[/\\]/.test(body[key]))
        throw new Error(`${key} must be a native safetensors model filename.`);
      options[key] = body[key];
    }
  }
  return { mode, options };
}

/** All generation goes through the existing Image API/ArtRunner supplied by index. */
export function createImageEditor({ imageDir, inputDir, coverDir, python, generate, preflight = async () => {},
  register = async () => {}, documentChanged = async () => {}, runPython } = {}) {
  const jobs = new Map();
  let preparing = 0;
  const documentLocks = new Map();
  async function withDocumentLock(key, operation) {
    const previous = documentLocks.get(key) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    documentLocks.set(key, held);
    await previous;
    try { return await operation(); }
    finally { release(); if (documentLocks.get(key) === held) documentLocks.delete(key); }
  }
  const scratch = path.join(inputDir, "aiplay_editor");
  const run = runPython || (async (mode, payload) => {
    await mkdir(scratch, { recursive: true });
    const jobFile = path.join(scratch, `${randomUUID()}.json`);
    await writeFile(jobFile, JSON.stringify({ dir: imageDir, ...payload }));
    try {
      return await new Promise((resolve, reject) => {
        const proc = spawn(python, [SCRIPT, mode, jobFile], { windowsHide: true });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { proc.kill(); reject(new Error("The image editor CPU operation timed out.")); }, 120_000);
        proc.stdout.on("data", b => { stdout += b; });
        proc.stderr.on("data", b => { stderr = (stderr + b).slice(-4000); });
        proc.once("error", error => { clearTimeout(timer); reject(error); });
        proc.once("close", code => {
          clearTimeout(timer);
          try {
            const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
            if (code !== 0 || !result.ok) throw new Error(result.error || stderr || "Image operation failed.");
            resolve(result);
          } catch (error) { reject(new Error(error.message || stderr)); }
        });
      });
    } finally { await unlink(jobFile).catch(() => {}); }
  });
  const publicJob = job => ({ ok: true, id: job.id, status: job.status, mode: job.mode,
    documentId: job.documentId || null, source: job.source || null, seed: job.options.seed,
    referenceCount: job.options.refImages.length, width: job.width, height: job.height,
    coverage: job.coverage, createdAt: job.createdAt, candidate: job.candidate,
    sourcePreview: job.sourcePreview,
    error: job.error, warnings: job.warnings || [], runId: job.runId,
    semantics: job.mode === "inpaint" ? "Reference-guided generation, composited through the frozen selection. Zero-mask pixels are unchanged."
      : "Reference-guided edit. Accept adds a new layer and retains the original layers hidden." });
  async function preview(body) {
    if (!!body.id === !!body.doc) throw new Error("Choose one saved document id or document tree.");
    return run("preview", { documentId: body.id, doc: body.doc });
  }
  async function create(body, actor) {
    const { mode, options } = editorOptions(body);
    if (preparing + [...jobs.values()].filter(j => j.status === "generating").length >= 4)
      throw new Error("Four editor generations are already pending. Wait for one to finish.");
    ++preparing;
    try {
    // Keep the bounded review history without expiring an active generation.
    for (const [id, job] of jobs) if (job.status !== "generating" && Date.now() - job.createdAt > 86400000) jobs.delete(id);
    if (jobs.size >= 100) throw new Error("The editor review history is full; restart the app to clear completed session history.");
    await mkdir(inputDir, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const id = randomUUID(), token = id.replaceAll("-", "").slice(0, 12);
    const sourceName = `aiplay_frame_${token}.png`, sourcePath = path.join(inputDir, sourceName);
    const maskPath = path.join(scratch, `${id}.npy`);
    const maskName = `aiplay_frame_${randomUUID().replaceAll("-", "").slice(0, 12)}.png`;
    const maskImagePath = path.join(inputDir, maskName);
    // Unless transparency is asked for, a reference with alpha is sent as
    // Qwen's vision tower sees it, over white. Its VAE would keep the alpha
    // and hand back a transparent generation.
    const references = options.transparent ? [] : options.refImages.map(name => ({ name,
      candidates: qwenReferenceCandidates(name, { inputDir, coverDir, imageDir }),
      out: path.join(inputDir, `aiplay_frame_${randomUUID().replaceAll("-", "").slice(0, 12)}.png`) }));
    const stagedOptions = { ...options,
      prompt: mode === "inpaint" ? `Edit <image 1> only where the selection mask in <image 2> is white. Black regions must stay unchanged. ${options.prompt}`
        : mode === "style" ? `Edit <image 1> using the visual style of <image 2>, preserving the subject and composition of <image 1>. ${options.prompt}` : options.prompt };
    let prepared;
    try {
      const { references: sent, ...frozen } = await run("prepare", { documentId: body.documentId, source: body.source,
        mode, selection: body.selection, out: sourcePath, maskOut: maskPath, maskImageOut: maskImagePath, references });
      prepared = frozen;
      stagedOptions.refImages = [sourceName, ...(mode === "inpaint" ? [maskName] : []), ...options.refImages.map((name, i) => sent?.[i] ?? name)];
      await preflight(stagedOptions);
    }
    catch (error) {
      await Promise.allSettled([sourcePath, maskPath, maskImagePath, ...references.map(r => r.out)].map(file => unlink(file)));
      throw error;
    }
    const job = { id, status: "generating", actor, createdAt: Date.now(), mode,
      options: stagedOptions, requestedPrompt: options.prompt, documentId: body.documentId, source: body.source,
      sourcePath, maskPath: mode === "inpaint" ? maskPath : null,
      ...prepared };
    jobs.set(id, job);
    // Deliberately detached from the HTTP response: UI and MCP poll the same job.
    job.done = (async () => {
      try {
        const generated = await generate(stagedOptions, actor);
        if (!generated?.name) throw new Error("Qwen did not return an image filename.");
        if (generated.seed != null) { job.options.seed = generated.seed; options.seed = generated.seed; }
        const name = `qwen_edit_${token}.png`;
        const { warnings = [], ...finished } = await run("finish", { sourcePath, generated: generated.name,
          maskPath: job.maskPath, out: path.join(imageDir, name), thumbOut: path.join(imageDir, `qwen_edit_${token}_t.png`) });
        if (warnings.length) job.warnings = [...(job.warnings || []), ...warnings];
        job.runId = generated.runId;
        await register(name, { engine: ENGINE, prompt: options.prompt, seed: options.seed,
          generatedFrom: generated.name, derivedFrom: body.source || null, documentId: body.documentId || null, operation: `qwen-${mode}`,
          refImages: options.refImages, masked: mode === "inpaint", runId: generated.runId }, actor);
        job.candidate = { name, url: `/api/image/${encodeURIComponent(name)}`, ...finished };
        job.status = "ready";
      } catch (error) { job.status = "error"; job.error = error.message; }
    })();
    return publicJob(job);
    } finally { --preparing; }
  }
  async function request(body, actor = "system") {
    const action = body.action || "create";
    if (action === "create") return create(body, actor);
    const job = jobs.get(body.id);
    if (!job) throw new Error("This editor job is unavailable or belongs to a previous app session.");
    if (action === "status") return publicJob(job);
    if (job.mutating) throw new Error("This editor result is already being changed.");
    if (action === "discard") {
      if (job.status !== "ready" && job.status !== "error") throw new Error("Only a finished, unaccepted edit can be discarded.");
      job.status = "discarded";
      return publicJob(job);
    }
    if (!["accept", "undo"].includes(action)) throw new Error("action must be create, status, accept, discard or undo.");
    if (action === "accept" && job.status !== "ready") throw new Error("Only a ready result can be accepted.");
    if (action === "undo" && job.status !== "accepted") throw new Error("Only an accepted result can be undone.");
    job.mutating = true;
    try {
      const result = await withDocumentLock(job.documentId || `source:${job.id}`, () => action === "accept" ? run("accept", {
        documentId: job.documentId, revision: job.revision, sourcePath: job.sourcePath,
        originalName: `qwen_original_${job.id.slice(0, 8)}.png`, title: job.source || "Qwen document edit",
        width: job.width, height: job.height, candidate: job.candidate.name,
        layerId: `qwen_${job.id.replaceAll("-", "")}`, layerName: `Qwen ${job.mode}: ${job.requestedPrompt.slice(0, 60)}`,
      }) : run("undo", { documentId: job.documentId, revision: job.acceptedRevision, before: job.before }));
      job.documentId = result.doc.id;
      if (action === "accept") { job.before = result.before; job.acceptedRevision = result.revision; }
      job.status = action === "accept" ? "accepted" : "undone";
      try { await documentChanged({ action, id: job.id, documentId: job.documentId, layerId: result.layerId,
        candidate: job.candidate.name }, actor); }
      catch (error) { (job.warnings ||= []).push(`Document saved, but its audit note failed: ${error.message}`); }
      return { ...publicJob(job), doc: result.doc, revision: result.revision, layerId: result.layerId };
    } finally { job.mutating = false; }
  }
  return { preview, request, paintTarget: body => run("paint-target", { doc: body.doc, ref: body.ref }),
    flattenReferences: references => run("flatten", { references }).then(result => result.references) };
}
