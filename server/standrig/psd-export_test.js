import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readPsd } from "ag-psd";
import { createStandRigPsdExporter } from "./psd-export.js";
import { createStandRigPsdRoutes } from "./psd-export-routes.js";

const exec = promisify(execFile);
const SERVER = fileURLToPath(new URL("../", import.meta.url));

function pixels(color, at) {
  const bytes = Buffer.alloc(4 * 4 * 4);
  bytes.set(color, at * 4);
  return bytes;
}

const body = pixels([23, 125, 231, 150], 0);
const hair = pixels([232, 68, 142, 255], 1);
const composite = pixels([23, 125, 231, 150], 0);
composite.set([232, 68, 142, 255], 4);

function prepared(scratch) {
  return Promise.all([
    writeFile(path.join(scratch, "part_00.rgba"), body),
    writeFile(path.join(scratch, "part_01.rgba"), hair),
    writeFile(path.join(scratch, "composite.rgba"), composite),
  ]).then(() => ({ ok: true, width: 4, height: 4, sourceDocumentId: "img1", sourceDocumentUpdatedAt: 12,
    warnings: [], tree: [
      { type: "image", name: "body", hidden: false, raw: "part_00.rgba", width: 4, height: 4 },
      { type: "group", name: "Head", hidden: false, children: [
        { type: "image", name: "hair", hidden: true, raw: "part_01.rgba", width: 4, height: 4 },
      ] },
    ] }));
}

test("saved document parts become a real PSD with alpha, reversed stack and groups", async () => {
  const exportPsd = createStandRigPsdExporter({ imageDir: os.tmpdir(), python: "test-python", prepare: ({ scratch }) => prepared(scratch) });
  const result = await exportPsd("img1");
  assert.ok(result.buffer.subarray(0, 4).equals(Buffer.from("8BPS")));
  assert.equal(result.count, 2);
  const psd = readPsd(result.buffer, { useImageData: true, skipThumbnail: true });
  assert.equal(psd.width, 4);
  assert.deepEqual(psd.children.map(item => item.name), ["Head", "body"]);
  assert.equal(psd.children[0].children[0].hidden, true);
  assert.deepEqual(Buffer.from(psd.children[0].children[0].imageData.data), hair);
  assert.deepEqual(Buffer.from(psd.children[1].imageData.data), body);
  assert.equal(psd.imageData.data[3], 150);
  assert.ok(Math.abs(psd.imageData.data[0] - composite[0]) <= 1);
});

test("export refuses malformed filenames and layer counts before accepting a PSD", async () => {
  const invalid = createStandRigPsdExporter({ imageDir: os.tmpdir(), python: "test-python",
    prepare: async ({ scratch }) => { const result = await prepared(scratch); result.tree.pop(); return result; } });
  await assert.rejects(invalid("img1"), /part budget/);
  await assert.rejects(invalid("../../outside"), /saved image document/);
  const truncated = createStandRigPsdExporter({ imageDir: os.tmpdir(), python: "test-python",
    prepare: async ({ scratch }) => {
      const result = await prepared(scratch);
      result.tree[0].raw = "../outside.rgba";
      return result;
    } });
  await assert.rejects(truncated("img1"), /invalid pixel file/);
});

test("local route guards creation and serves only the exact opaque PSD filename", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiplay-standrig-route-"));
  t.after(async () => {
    const absolute = path.resolve(directory), root = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute), root);
    await rm(absolute, { recursive: true, force: true });
  });
  const made = await createStandRigPsdExporter({ imageDir: directory, python: "test-python",
    prepare: ({ scratch }) => prepared(scratch) })("img1");
  const calls = [];
  const route = createStandRigPsdRoutes({ imageDir: directory,
    exporter: async id => { assert.equal(id, "img1"); return made; },
    json: (_res, status, payload) => ({ status, payload }),
    readBody: async (_req, cap) => { calls.push(cap); return { id: "img1" }; },
    sameOriginLocalJson: request => request.sameOrigin,
    onExport: ({ name, documentId }) => calls.push(`${name}:${documentId}`),
  });
  const req = (method, ip = "127.0.0.1", sameOrigin = true) => ({ method,
    headers: { host: "127.0.0.1:4173" }, socket: { remoteAddress: ip }, sameOrigin });
  const url = pathname => ({ pathname });
  assert.equal((await route(req("POST", "192.168.0.2"), {}, url("/api/images/standrig-psd"))).status, 403);
  assert.equal((await route(req("POST", "127.0.0.1", false), {}, url("/api/images/standrig-psd"))).status, 403);
  assert.deepEqual(calls, []);
  const posted = await route(req("POST"), {}, url("/api/images/standrig-psd"));
  assert.equal(posted.status, 200);
  assert.equal(calls[0], 16 * 1024);
  assert.match(posted.payload.name, /^standrig_[0-9a-f]{32}\.psd$/);
  const saved = await readFile(path.join(directory, "_standrig", posted.payload.name));
  assert.ok(saved.equals(made.buffer));
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(bytes) { this.bytes = bytes; } };
  await route(req("GET"), response, url(posted.payload.downloadUrl));
  assert.equal(response.status, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.ok(response.bytes.equals(made.buffer));
  assert.equal((await route(req("GET"), {}, url("/api/images/standrig-psd/../secret"))).status, 404);
});

test("saved Studio layers bake through imgdoc into a StandRig PSD", {
  skip: !process.env.AIPLAY_STANDRIG_TEST_PYTHON && "Set AIPLAY_STANDRIG_TEST_PYTHON to a Studio Python with numpy, Pillow and OpenCV.",
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiplay-standrig-real-"));
  t.after(async () => {
    const absolute = path.resolve(directory), root = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute), root);
    await rm(absolute, { recursive: true, force: true });
  });
  const script = path.join(directory, "fixture.py");
  await writeFile(script, `import imgdoc
import json
from PIL import Image, ImageDraw
import sys
root = sys.argv[1]
for name, box, color in [
    ("body", (6, 10, 24, 29), (20, 40, 200, 180)),
    ("hair", (5, 3, 25, 12), (220, 30, 100, 255)),
]:
    im = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle(box, fill=color)
    im.save(root + "/" + name + ".png")
doc = imgdoc.blank_doc("Performer", 32, 32)
doc["layers"] = [
    imgdoc.blank_layer("image", name="body", src="body.png"),
    imgdoc.blank_layer("image", name="hair", src="hair.png"),
]
id = imgdoc.store_job({"dir": root, "action": "save", "doc": doc})["id"]
hidden_doc = imgdoc.blank_doc("Hidden hair group", 32, 32)
hidden_doc["layers"] = [
    imgdoc.blank_layer("image", name="body", src="body.png"),
    imgdoc.blank_layer("group", name="Head", enabled=False, layers=[
        imgdoc.blank_layer("image", name="hair", src="hair.png", enabled=True),
    ]),
]
hidden_id = imgdoc.store_job({"dir": root, "action": "save", "doc": hidden_doc})["id"]
print(json.dumps({"id": id, "hiddenId": hidden_id}))
`, "utf8");
  const python = process.env.AIPLAY_STANDRIG_TEST_PYTHON;
  const { stdout } = await exec(python, [script, directory], {
    env: { ...process.env, PYTHONPATH: SERVER }, timeout: 30_000,
  });
  const { id, hiddenId } = JSON.parse(stdout.trim());
  const made = await createStandRigPsdExporter({ imageDir: directory, python })(id);
  assert.equal(made.count, 2);
  assert.deepEqual(made.warnings, []);
  const psd = readPsd(made.buffer, { useImageData: true, skipThumbnail: true });
  assert.deepEqual(psd.children.map(layer => layer.name), ["hair", "body"]);
  assert.equal(psd.children[0].imageData.data[(6 * 32 + 10) * 4 + 3], 255);
  assert.equal(psd.children[1].imageData.data[(15 * 32 + 12) * 4 + 3], 180);
  assert.equal(psd.children[0].imageData.data[(15 * 32 + 12) * 4 + 3], 0);
  const hiddenMade = await createStandRigPsdExporter({ imageDir: directory, python })(hiddenId);
  const hiddenPsd = readPsd(hiddenMade.buffer, { useImageData: true, skipThumbnail: true });
  assert.equal(hiddenPsd.children[0].name, "Head");
  assert.equal(hiddenPsd.children[0].hidden, true);
  assert.equal(hiddenPsd.children[0].children[0].hidden, false);
  assert.equal(hiddenPsd.children[0].children[0].imageData.data[(6 * 32 + 10) * 4 + 3], 255);
  assert.equal(hiddenPsd.imageData.data[(6 * 32 + 10) * 4 + 3], 0);
  if (process.env.AIPLAY_STANDRIG_CORE_ROOT) {
    const upstream = path.resolve(process.env.AIPLAY_STANDRIG_CORE_ROOT);
    const agPsd = await import(pathToFileURL(path.join(upstream, "node_modules", "ag-psd", "dist", "index.js")));
    const { encodePng } = await import(pathToFileURL(path.join(upstream, "packages", "core", "dist", "png.js")));
    agPsd.initializeCanvas((width, height) => {
      let pixels = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      return { width, height, getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: data => { pixels = data; }, getImageData: (x = 0, y = 0, w = width, h = height) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
            const from = ((y + row) * width + x + col) * 4;
            data.set(pixels.data.subarray(from, from + 4), (row * w + col) * 4);
          }
          return { width: w, height: h, data };
        },
      }), toDataURL: () => `data:image/png;base64,${Buffer.from(encodePng(pixels)).toString("base64")}` };
    });
    const { createRigFromPsdFile } = await import(pathToFileURL(path.join(upstream, "packages", "core", "dist", "importers.js")));
    const rig = await createRigFromPsdFile(new File([made.buffer], "performer.psd"));
    assert.equal(rig.assets.length, 2);
    assert.deepEqual(rig.parts.filter(part => part.kind === "image").map(part => part.name), ["hair", "body"]);
    assert.equal(rig.metadata.importReport.totals.imageLayers, 2);
  }
});
