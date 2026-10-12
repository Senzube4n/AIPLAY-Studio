import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink, stat, realpath, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("./imagetools.py", import.meta.url));
const PROFILES = Object.freeze({ draft: { tolerance: 1.5, maxSize: 1024 }, standard: { tolerance: 0.8, maxSize: 4096 }, high: { tolerance: 0.5, maxSize: 4096 } });
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

const COLOR = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const CONTOURS = { type: "array", minItems: 1, maxItems: 128, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 19999 } };
const STOPS = { type: "array", minItems: 2, maxItems: 8, items: { type: "object", required: ["offset", "color"], additionalProperties: false,
  properties: { offset: { type: "number", minimum: 0, maximum: 1 }, color: COLOR } } };
const GRADIENT = { type: "object", required: ["stops"], additionalProperties: false, properties: {
  angle: { type: "number", minimum: 0, maximum: 360, default: 0 }, stops: STOPS,
  bounds: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" }, description: "Optional [x,y,width,height] gradient span in source pixels; defaults to the selected outlines' bounds." },
} };
const SELECTOR = { color: COLOR, contours: CONTOURS };

/** Shared by the HTTP normalizer and MCP; controls have identical names. */
export const VECTOR_OPTION_SCHEMA = freeze({
  mode: { type: "string", enum: ["logo", "silhouette", "posterize"], default: "logo" },
  quality: { type: "string", enum: ["draft", "standard", "high"], default: "standard" },
  colors: { type: "integer", minimum: 2, maximum: 16, default: 6 },
  detail: { type: "number", minimum: 0.2, maximum: 4, default: 1, description: "Legacy detail multiplier; higher retains more contour detail." },
  tolerance: { type: "number", minimum: 0.15, maximum: 4, description: "Curve fitting tolerance in source pixels. Defaults: draft 1.5, standard 0.8, high 0.5." },
  minArea: { type: "number", minimum: 0, maximum: 10000, default: 1, description: "Discard regions smaller than this area in source pixels." },
  alphaThreshold: { type: "integer", minimum: 1, maximum: 255, default: 128 },
  maxSize: { type: "integer", minimum: 64, maximum: 4096, description: "Maximum working dimension; draft 1024, standard/high 4096. SVG keeps source dimensions." },
  basis: { type: "string", pattern: "^[0-9a-f]{64}$", description: "traceFingerprint returned by the first trace. Required for cleanup or composition; reuse the same source and base trace settings." },
  cleanup: { type: "object", additionalProperties: false, required: ["operations"], properties: {
    operations: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["type", "color", "contours"], properties: {
      ...SELECTOR, type: { type: "string", enum: ["smooth", "circle", "concentric", "parallelogram"] },
      maxDeviation: { type: "number", minimum: 0.5, maximum: 32, default: 4, description: "Maximum measured outline change in source pixels. Unsafe fits fail instead of being forced." },
      strength: { type: "number", minimum: 0, maximum: 1, default: 0.7, description: "Smoothing strength; only valid for smooth operations." },
    } } },
  } },
  composition: { type: "object", additionalProperties: false, properties: {
    fills: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["color", "contours"], properties: { ...SELECTOR, solid: COLOR, gradient: GRADIENT } } },
    shadows: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["color", "contours", "offset", "fill"], properties: {
      ...SELECTOR, fill: COLOR, offset: { type: "array", minItems: 2, maxItems: 2, items: { type: "number", minimum: -4096, maximum: 4096 }, description: "[dx,dy] in source pixels." },
    } } },
    omit: { type: "array", maxItems: 32, items: { type: "object", additionalProperties: false, required: ["color", "contours"], properties: SELECTOR } },
  }, description: "Explicit selected-outline fills, local gradient spans, duplicate offset shadows and removal of inspected artifacts. Include each selected foreground outline's holes in its fill/shadow selection." },
  gradients: {
    type: "array", maxItems: 16, description: "Explicit linear gradients for traced palette colors; no gradient inference.",
    items: { type: "object", required: ["color", "stops"], additionalProperties: false, properties: {
      color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      angle: { type: "number", minimum: 0, maximum: 360, default: 0 },
      stops: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", required: ["offset", "color"], additionalProperties: false, properties: {
        offset: { type: "number", minimum: 0, maximum: 1 }, color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
      } } },
    } },
  },
});
export const VECTOR_INPUT_SCHEMA = freeze({ type: "object", required: ["name"], additionalProperties: false,
  properties: { name: { type: "string", description: "PNG, JPEG or WebP filename in the image library." }, ...VECTOR_OPTION_SCHEMA } });

export class VectorizeError extends Error {
  constructor(message, status = 500) { super(message); this.name = "VectorizeError"; this.status = status; }
}
const invalid = message => { throw new VectorizeError(message, 400); };
function onlyKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) invalid(`Unsupported ${label} fields: ${unknown.join(", ")}.`);
}
function number(value, fallback, key, min, max, integer = false) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    invalid(`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
  return n;
}
function hex(value, label) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) invalid(`${label} must be a #rrggbb color.`);
  return value.toLowerCase();
}

function selector(value, allowed, label) {
  onlyKeys(value, ["color", "contours", ...allowed], label);
  const color = hex(value.color, `${label} color`), ids = value.contours;
  if (!Array.isArray(ids) || !ids.length || ids.length > 128 || new Set(ids).size !== ids.length
      || ids.some(id => !Number.isInteger(id) || id < 0 || id >= 20000)) invalid(`${label} needs 1 to 128 unique contour indexes.`);
  return { color, contours: [...ids].sort((a, b) => a-b) };
}
function list(value, label, parse) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) invalid(`${label} must contain at most 32 selections.`);
  return value.map(parse);
}
function disjoint(values, label) {
  const seen = new Set();
  for (const value of values) for (const id of value.contours) {
    const key = `${value.color}:${id}`;
    if (seen.has(key)) invalid(`${label} selects outline ${key} more than once.`);
    seen.add(key);
  }
}
function gradient(value, label) {
  onlyKeys(value, ["angle", "stops", "bounds"], label);
  if (!Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 8) invalid(`${label} needs 2 to 8 stops.`);
  const stops = value.stops.map(stop => {
    onlyKeys(stop, ["offset", "color"], `${label} stop`);
    return { offset: number(stop.offset, undefined, "gradient stop offset", 0, 1), color: hex(stop.color, "gradient stop color") };
  });
  if (stops.some((stop, i) => i && stop.offset < stops[i-1].offset)) invalid("Gradient stops must be ordered by offset.");
  const result = { angle: number(value.angle, 0, "gradient angle", 0, 360), stops };
  if (value.bounds !== undefined) {
    if (!Array.isArray(value.bounds) || value.bounds.length !== 4) invalid(`${label} bounds must be [x,y,width,height].`);
    result.bounds = value.bounds.map((n, i) => number(n, undefined, "gradient bounds", i < 2 ? -16384 : 0.001, 32768));
  }
  return result;
}

/** Reject unsupported controls instead of pretending that they were applied. */
export function normalizeVectorOptions(body = {}) {
  onlyKeys(body, [...Object.keys(VECTOR_OPTION_SCHEMA), "name", "actor"], "vectorization");
  const mode = body.mode === undefined ? "logo" : body.mode;
  const quality = body.quality === undefined ? "standard" : body.quality;
  if (!VECTOR_OPTION_SCHEMA.mode.enum.includes(mode)) invalid("mode must be logo, silhouette or posterize.");
  if (!VECTOR_OPTION_SCHEMA.quality.enum.includes(quality)) invalid("quality must be draft, standard or high.");
  const result = { mode, quality };
  for (const key of ["colors", "detail", "tolerance", "minArea", "alphaThreshold", "maxSize"]) {
    const field = VECTOR_OPTION_SCHEMA[key];
    result[key] = number(body[key], PROFILES[quality][key] ?? field.default, key, field.minimum, field.maximum, field.type === "integer");
  }
  const gradients = body.gradients === undefined ? [] : body.gradients;
  if (!Array.isArray(gradients) || gradients.length > 16) invalid("gradients must contain at most 16 explicit fill gradients.");
  const used = new Set();
  result.gradients = gradients.map((gradient, i) => {
    onlyKeys(gradient, ["color", "angle", "stops"], `gradient ${i + 1}`);
    const color = hex(gradient.color, "gradient color");
    if (used.has(color)) invalid(`Only one gradient can replace palette color ${color}.`);
    used.add(color);
    if (!Array.isArray(gradient.stops) || gradient.stops.length < 2 || gradient.stops.length > 8)
      invalid("A gradient needs 2 to 8 stops.");
    const stops = gradient.stops.map(stop => {
      onlyKeys(stop, ["offset", "color"], "gradient stop");
      return { offset: number(stop.offset, undefined, "gradient stop offset", 0, 1), color: hex(stop.color, "gradient stop color") };
    });
    if (stops.some((stop, j) => j > 0 && stop.offset < stops[j - 1].offset)) invalid("Gradient stops must be ordered by offset.");
    return { color, stops, angle: number(gradient.angle, 0, "gradient angle", 0, 360) };
  });
  if (body.cleanup !== undefined) {
    onlyKeys(body.cleanup, ["operations"], "cleanup");
    if (!Array.isArray(body.cleanup.operations)) invalid("cleanup.operations must be an array.");
    const operations = list(body.cleanup.operations, "cleanup.operations", (op, i) => {
      const selected = selector(op, ["type", "maxDeviation", "strength"], `cleanup operation ${i+1}`);
      if (!["smooth", "circle", "concentric", "parallelogram"].includes(op.type)) invalid("Unknown cleanup operation type.");
      if (op.type !== "smooth" && op.strength !== undefined) invalid("strength is only valid for smooth operations.");
      if (["circle", "parallelogram"].includes(op.type) && selected.contours.length !== 1) invalid(`${op.type} needs exactly one contour.`);
      if (op.type === "concentric" && (selected.contours.length < 2 || selected.contours.length > 16)) invalid("concentric needs 2 to 16 contours.");
      return { ...selected, type: op.type, maxDeviation: number(op.maxDeviation, 4, "maxDeviation", .5, 32),
        ...(op.type === "smooth" ? { strength: number(op.strength, .7, "strength", 0, 1) } : {}) };
    });
    disjoint(operations, "cleanup.operations");
    result.cleanup = { operations };
  }
  if (body.composition !== undefined) {
    onlyKeys(body.composition, ["fills", "shadows", "omit"], "composition");
    const fills = list(body.composition.fills, "composition.fills", (fill, i) => {
      const selected = selector(fill, ["solid", "gradient"], `fill ${i+1}`);
      if ((fill.solid !== undefined) === (fill.gradient !== undefined)) invalid("A selected fill needs either solid or gradient.");
      return { ...selected, ...(fill.solid !== undefined ? { solid: hex(fill.solid, "selected fill") } : { gradient: gradient(fill.gradient, "selected gradient") }) };
    });
    disjoint(fills, "composition.fills");
    const shadows = list(body.composition.shadows, "composition.shadows", (shadow, i) => {
      const selected = selector(shadow, ["offset", "fill"], `shadow ${i+1}`);
      if (!Array.isArray(shadow.offset) || shadow.offset.length !== 2) invalid("Shadow offset must be [dx,dy].");
      return { ...selected, offset: shadow.offset.map(n => number(n, undefined, "shadow offset", -4096, 4096)), fill: hex(shadow.fill, "shadow fill") };
    });
    const omit = list(body.composition.omit, "composition.omit", (item, i) => selector(item, [], `omit ${i+1}`));
    disjoint(omit, "composition.omit");
    result.composition = { fills, shadows, omit };
  }
  if (body.basis !== undefined) {
    if (typeof body.basis !== "string" || !/^[0-9a-f]{64}$/.test(body.basis)) invalid("basis must be a traceFingerprint from the initial trace.");
    result.basis = body.basis;
  }
  if ((result.cleanup?.operations.length || Object.values(result.composition || {}).some(v => v.length)) && !result.basis)
    invalid("Trace first and supply its traceFingerprint as basis for selected cleanup or composition.");
  return result;
}

function sourceName(value, svg = false) {
  if (typeof value !== "string" || !value || value.length > 240 || /[/\\:\x00-\x1f]/.test(value)
      || value === "." || value === ".." || path.basename(value) !== value || path.win32.basename(value) !== value
      || !(svg ? /\.svg$/i : /\.(png|jpe?g|webp)$/i).test(value)) invalid(svg ? "Choose an SVG filename from the image library." : "Choose a PNG, JPEG or WebP filename from the image library.");
  return value;
}

function runWorker(spawnProcess, python, jobPath, timeoutMs, mode = "vectorize", maxOutputBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let proc, timer, killTimer, failure, settled = false, stdout = "", stderr = "";
    const settle = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      error ? reject(error) : resolve(value);
    };
    const stop = error => {
      if (settled || failure) return;
      failure = error;
      // Wait for process exit before removing its atomic output. A worker can
      // otherwise finish a write between kill() and cleanup on Windows.
      killTimer = setTimeout(() => settle(error), 1000);
      try { proc?.kill(); } catch { settle(error); }
    };
    try {
      proc = spawnProcess(python, [SCRIPT, mode, jobPath], { windowsHide: true });
      timer = setTimeout(() => stop(new VectorizeError("Vectorization timed out after its processing limit.", 504)), timeoutMs);
      proc.once("error", error => settle(new VectorizeError(`Could not start vectorization: ${error.message}`)));
      proc.stdout?.on("data", chunk => {
        if (settled || failure) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) stop(new VectorizeError("Vectorization returned too much diagnostic output."));
      });
      proc.stderr?.on("data", chunk => { if (!settled) stderr = (stderr + chunk).slice(-16384); });
      proc.once("close", code => {
        if (settled) return;
        if (failure) return settle(failure);
        let result;
        try { result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); }
        catch { return settle(new VectorizeError(stderr.trim().slice(-1000) || `Vectorization returned an invalid result (exit ${code}).`)); }
        if (code !== 0 || result?.ok !== true) return settle(new VectorizeError(String(result?.error || stderr.trim() || `Vectorization exited with code ${code}.`).slice(-1000), result?.status === 400 ? 400 : 500));
        if (!result || typeof result !== "object" || Array.isArray(result)) return settle(new VectorizeError("Vectorization returned an invalid result."));
        settle(null, result);
      });
    } catch (error) { settle(new VectorizeError(`Could not start vectorization: ${error.message}`)); }
  });
}

export const VECTOR_REVIEW_SCHEMA = freeze({ type: "object", required: ["name"], additionalProperties: false, properties: {
  name: { type: "string", description: "Saved SVG filename in Pictures. Renders the actual SVG geometry, not the original raster." },
  max_edge: { type: "integer", minimum: 256, maximum: 1536, default: 768 },
  crop: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" }, description: "Optional [x,y,width,height] crop in source pixels for enlarged curve/text review." },
  background: { type: "string", description: "#rrggbb or transparent; default white. Compare on white and dark backgrounds." },
} });

export async function vectorReviewImage({ imageDir, python, spawnProcess = spawn, timeoutMs = 45000 }, request) {
  onlyKeys(request, ["name", "max_edge", "crop", "background"], "vector review");
  const name = sourceName(request.name, true);
  const maxEdge = number(request.max_edge, 768, "max_edge", 256, 1536, true);
  const background = request.background === "transparent" ? "transparent" : hex(request.background ?? "#ffffff", "background");
  const options = { maxEdge, background };
  if (request.crop !== undefined) {
    if (!Array.isArray(request.crop) || request.crop.length !== 4) invalid("crop must be [x,y,width,height].");
    options.crop = request.crop.map((v, i) => number(v, undefined, "crop", i < 2 ? 0 : 1, 16384));
  }
  const src = path.join(imageDir, name);
  let info, rootPath, sourcePath;
  try { [info, rootPath, sourcePath] = await Promise.all([stat(src), realpath(imageDir), realpath(src)]); }
  catch (error) { throw new VectorizeError("No such SVG in the library.", error.code === "ENOENT" ? 404 : 400); }
  const relative = path.relative(rootPath, sourcePath);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !info.isFile()) invalid("SVG must be a file inside the image library.");
  if (info.size > 16_000_000) invalid("SVG exceeds the 16 MB review limit.");
  const jobPath = path.join(imageDir, `.vec_review_${randomUUID()}.json`);
  try {
    await writeFile(jobPath, JSON.stringify({ in: sourcePath, ...options }), { flag: "wx" });
    const result = await runWorker(spawnProcess, python, jobPath, timeoutMs, "vector_review", 16 * 1024 * 1024);
    return { ...result, name, url: `/api/image/${encodeURIComponent(name)}` };
  } finally { await unlink(jobPath).catch(() => {}); }
}

/** Injectable worker boundary, shared by HTTP and behavioral tests. */
export async function vectorizeImage({ imageDir, python, spawnProcess = spawn, timeoutMs = 120000, register = async () => {} }, request) {
  const options = normalizeVectorOptions(request);
  const name = sourceName(request.name);
  const src = path.join(imageDir, name);
  let info, rootPath, sourcePath;
  try { [info, rootPath, sourcePath] = await Promise.all([stat(src), realpath(imageDir), realpath(src)]); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new VectorizeError("No such image in the library.", 404);
    throw new VectorizeError(`Could not read the source image: ${error.message}`);
  }
  const relative = path.relative(rootPath, sourcePath);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid("The source image must stay inside the image library.");
  if (!info.isFile()) invalid("The source image must be a file.");
  if (info.size > 128 * 1024 * 1024) invalid("The source image exceeds the 128 MB input limit.");
  const token = randomUUID();
  const outName = `${name.replace(/\.[^.]+$/, "").slice(0, 112)}_v_${token}.svg`;
  const out = path.join(imageDir, outName);
  const jobPath = path.join(imageDir, `.vec_${token}.json`);
  let successful = false;
  try {
    await mkdir(imageDir, { recursive: true });
    await writeFile(jobPath, JSON.stringify({ in: src, out, ...options }), { flag: "wx" });
    const result = await runWorker(spawnProcess, python, jobPath, timeoutMs);
    let rendered;
    try { rendered = await stat(out); }
    catch { throw new VectorizeError("Vectorization did not produce its SVG file."); }
    if (!rendered.isFile() || rendered.size > 32 * 1024 * 1024) throw new VectorizeError("Vectorization exceeded the 32 MB output limit.");
    const receipt = { ...result, out, name: outName, url: `/api/image/${encodeURIComponent(outName)}` };
    await register({ name: outName, source: name, result: receipt, options });
    successful = true;
    return receipt;
  } catch (error) {
    if (error instanceof VectorizeError) throw error;
    throw new VectorizeError(`Vectorization failed: ${error.message}`);
  } finally {
    await unlink(jobPath).catch(() => {});
    if (!successful) {
      await unlink(out).catch(() => {});
      // Python's atomic write may be interrupted after creating its temporary
      // file. Match only this request's UUID output name, never other jobs.
      const prefix = `.${outName}.vector-`;
      const files = await readdir(imageDir).catch(() => []);
      await Promise.all(files.filter(file => file.startsWith(prefix) && file.endsWith(".tmp"))
        .map(file => unlink(path.join(imageDir, file)).catch(() => {})));
    }
  }
}
