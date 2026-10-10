import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { initializeCanvas, readPsd, writePsdBuffer } from "ag-psd";

const SCRIPT = fileURLToPath(new URL("./export_layers.py", import.meta.url));
const MAX_PSD_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 4_194_304;
const MAX_PARTS = 32;

// Raw ImageData avoids node-canvas, its native build, and premultiplied alpha.
initializeCanvas(() => { throw new Error("PSD export does not use canvas."); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }));

function failures(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateTree(report) {
  const { width, height, tree } = report || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4 || height < 4 || width * height > MAX_PIXELS)
    throw failures("The PSD preparation returned invalid canvas dimensions.", 502);
  if (!Array.isArray(tree)) throw failures("The PSD preparation returned no layer tree.", 502);
  let count = 0;
  const walk = (nodes, depth = 0) => nodes.map(node => {
    if (!node || typeof node !== "object" || typeof node.name !== "string" || !node.name || typeof node.hidden !== "boolean")
      throw failures("The PSD preparation returned an invalid layer.", 502);
    if (depth > 16) throw failures("The PSD preparation returned too many nested groups.", 502);
    if (node.type === "group") {
      if (!Array.isArray(node.children)) throw failures("The PSD preparation returned an invalid group.", 502);
      return { name: node.name, hidden: node.hidden, children: walk(node.children, depth + 1).reverse() };
    }
    if (!/^part_\d{2}\.rgba$/.test(node.raw) || node.width !== width || node.height !== height)
      throw failures("The PSD preparation returned an invalid pixel file.", 502);
    count++;
    return { name: node.name, hidden: node.hidden, raw: node.raw };
  });
  const ordered = walk(tree).reverse();
  if (count < 2 || count > MAX_PARTS || width * height * 4 * count > 40 * 1024 * 1024)
    throw failures("The PSD preparation exceeded its part budget.", 502);
  return { width, height, tree: ordered, count };
}

async function rawImage(scratch, filename, width, height) {
  const bytes = await readFile(path.join(scratch, filename));
  if (bytes.length !== width * height * 4)
    throw failures(`The PSD preparation returned a truncated ${filename}.`, 502);
  return { width, height, data: new Uint8ClampedArray(bytes) };
}

function compareReadback(expected, actual) {
  if (expected.length !== actual.length) throw failures("PSD readback lost a layer.", 502);
  for (let index = 0; index < expected.length; index++) {
    const want = expected[index], got = actual[index];
    if (!got || want.name !== got.name || Boolean(want.hidden) !== Boolean(got.hidden))
      throw failures("PSD readback changed a layer name or visibility.", 502);
    if (want.children) {
      if (!Array.isArray(got.children)) throw failures("PSD readback lost a group.", 502);
      compareReadback(want.children, got.children);
    } else if (!got.imageData || !Buffer.from(want.imageData.data).equals(Buffer.from(got.imageData.data))) {
      throw failures(`PSD readback changed pixels in ${want.name}.`, 502);
    }
  }
}

async function encodePrepared(report, scratch) {
  const { width, height, tree, count } = validateTree(report);
  const fill = async nodes => Promise.all(nodes.map(async node => {
    if (node.children) return { name: node.name, hidden: node.hidden, children: await fill(node.children) };
    return { name: node.name, hidden: node.hidden,
      imageData: await rawImage(scratch, node.raw, width, height) };
  }));
  const children = await fill(tree);
  const imageData = await rawImage(scratch, "composite.rgba", width, height);
  const buffer = writePsdBuffer({ width, height, children, imageData });
  if (buffer.length > MAX_PSD_BYTES) throw failures("The PSD exceeds 64 MiB. Resize or split this document.");
  const checked = readPsd(buffer, { useImageData: true, skipThumbnail: true });
  if (checked.width !== width || checked.height !== height)
    throw failures("PSD readback changed the canvas size.", 502);
  compareReadback(children, checked.children || []);
  if (!checked.imageData || checked.imageData.data.length !== imageData.data.length)
    throw failures("PSD readback lost the composite image.", 502);
  // ag-psd's merged-preview encoder rounds colour by one code value. Layer
  // pixels above must still be exact, because StandRig imports those parts.
  for (let i = 0; i < imageData.data.length; i++) {
    const tolerance = i % 4 === 3 ? 0 : 1;
    if (Math.abs(imageData.data[i] - checked.imageData.data[i]) > tolerance)
      throw failures("PSD readback changed the composite image.", 502);
  }
  return { buffer, width, height, count, layers: report.tree };
}

async function runPreparation({ python, imageDir, id, scratch }) {
  const job = path.join(scratch, "job.json");
  await writeFile(job, JSON.stringify({ imageDir, id, scratch }), "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT, job], { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(failures("PSD layer preparation timed out.", 504)); }, 120_000);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill(); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      let result;
      try { result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); }
      catch { return reject(failures(`The PSD layer renderer failed: ${stderr || "no JSON reply"}.`, 502)); }
      if (code !== 0 || result?.ok !== true) return reject(failures(result?.error || stderr || "The PSD layer renderer failed."));
      resolve(result);
    });
  });
}

export function createStandRigPsdExporter({ python, imageDir, prepare = runPreparation } = {}) {
  if (!python || !imageDir) throw new Error("A Python runtime and image directory are required.");
  let busy = false;
  return async function exportSavedDocument(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(id))
      throw failures("Choose a saved image document by its id or slug.");
    if (busy) throw failures("A PSD export is already running. Try again when it finishes.", 429);
    busy = true;
    let scratch;
    try {
      scratch = await mkdtemp(path.join(os.tmpdir(), "aiplay-standrig-"));
      const report = await prepare({ python, imageDir, id, scratch });
      if (report?.ok !== true) throw failures(report?.error || "The PSD preparation failed.");
      const encoded = await encodePrepared(report, scratch);
      return { ...encoded, warnings: report.warnings || [], sourceDocumentId: report.sourceDocumentId,
        sourceDocumentUpdatedAt: report.sourceDocumentUpdatedAt };
    } finally {
      try {
        if (scratch) {
          const absolute = path.resolve(scratch), root = path.resolve(os.tmpdir());
          if (path.dirname(absolute) !== root || !path.basename(absolute).startsWith("aiplay-standrig-"))
            throw new Error("PSD scratch directory escaped the temporary root.");
          await rm(absolute, { recursive: true, force: true });
        }
      } finally { busy = false; }
    }
  };
}
