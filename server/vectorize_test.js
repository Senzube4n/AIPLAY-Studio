import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VECTOR_OPTION_SCHEMA, VECTOR_INPUT_SCHEMA, VECTOR_REVIEW_SCHEMA, normalizeVectorOptions, vectorizeImage, vectorReviewImage } from "./vectorize.js";

async function fixture(t) {
  const imageDir = await mkdtemp(path.join(tmpdir(), "aiplay-vector-"));
  t.after(() => rm(imageDir, { recursive: true, force: true }));
  await writeFile(path.join(imageDir, "mark.png"), "fixture raster");
  return { imageDir, python: "fixture-python" };
}
function worker(operation, calls = []) {
  return (python, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => { proc.killed = true; return true; };
    const call = { proc, python, args, options };
    calls.push(call);
    setImmediate(async () => {
      try { await operation(call); }
      catch (error) { proc.emit("error", error); }
    });
    return proc;
  };
}
async function successfulWorker({ proc, args }) {
  const job = JSON.parse(await readFile(args[2], "utf8"));
  const { in: source, out, ...settings } = job;
  await writeFile(out, '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"/>');
  proc.stdout.end(`${JSON.stringify({ ok: true, out, paths: 2, bytes: 70,
    sourceWidth: 32, sourceHeight: 24, width: 32, height: 24, settings,
    palette: ["#000000", "#ffffff"], stats: { contours: 2, points: 16, cubicSegments: 4 }, warnings: ["fixture warning"] })}\n`);
  proc.emit("close", 0);
}

test("shared schema and defaults name all controls and are deeply frozen", () => {
  assert.ok(Object.isFrozen(VECTOR_INPUT_SCHEMA));
  assert.ok(Object.isFrozen(VECTOR_OPTION_SCHEMA.gradients.items.properties.stops.items.properties));
  assert.deepEqual(normalizeVectorOptions({}), { mode: "logo", quality: "standard", colors: 6,
    detail: 1, tolerance: 0.8, minArea: 1, alphaThreshold: 128, maxSize: 4096, gradients: [] });
  assert.equal(normalizeVectorOptions({ quality: "draft" }).maxSize, 1024);
  assert.equal(normalizeVectorOptions({ quality: "high" }).tolerance, 0.5);
  assert.equal(normalizeVectorOptions({ minArea: 0 }).minArea, 0);
  assert.equal(normalizeVectorOptions({ mode: 'silhouette' }).mode, 'silhouette');
  assert.equal(normalizeVectorOptions({ tolerance: 0.25, detail: 4 }).tolerance, 0.25);
  assert.deepEqual(Object.keys(normalizeVectorOptions({})).sort(), Object.keys(VECTOR_OPTION_SCHEMA).filter(k => !["basis", "cleanup", "composition"].includes(k)).sort());
});

test("invalid named controls and gradient fields fail rather than clamp or disappear", () => {
  const invalid = [null, [], { colors: 1 }, { colors: 17 }, { colors: 2.5 }, { colors: "6" },
    { quality: "ultra" }, { mode: "photo" }, { detail: 0 }, { tolerance: NaN },
    { minArea: -1 }, { alphaThreshold: 0 }, { maxSize: 4097 }, { fit: "curve" },
    { gradients: null }, { gradients: Array(17).fill({}) },
    { gradients: [{ color: "red", stops: [] }] },
    { gradients: [{ color: "#112233", shadow: true, stops: [] }] },
    { gradients: [{ color: "#112233", stops: [{ offset: 1, color: "#000000" }, { offset: 0, color: "#ffffff" }] }] },
    { gradients: [{ color: "#112233", stops: [{ offset: 0, color: "#000000", opacity: 1 }, { offset: 1, color: "#ffffff" }] }] },
    { gradients: [{ color: "#112233", stops: [{ color: "#000000" }, { offset: 1, color: "#ffffff" }] }] },
  ];
  for (const body of invalid) assert.throws(() => normalizeVectorOptions(body), error => error.status === 400, JSON.stringify(body));
  const gradient = { color: "#ABCDEF", angle: 45, stops: [{ offset: 0, color: "#000000" }, { offset: 1, color: "#FFFFFF" }] };
  assert.equal(normalizeVectorOptions({ gradients: [gradient] }).gradients[0].color, "#abcdef");
  assert.throws(() => normalizeVectorOptions({ gradients: [gradient, gradient] }), /Only one gradient/);
});

test("every control reaches the worker and all measured output reaches registration", async t => {
  const deps = await fixture(t), calls = [], saved = [];
  const request = { name: "mark.png", actor: "agent:fixture", mode: "posterize", quality: "high", colors: 8,
    detail: 2, tolerance: 0.3, minArea: 0, alphaThreshold: 64, maxSize: 512,
    gradients: [{ color: "#000000", angle: 90, stops: [{ offset: 0, color: "#123456" }, { offset: 1, color: "#abcdef" }] }] };
  const result = await vectorizeImage({ ...deps, spawnProcess: worker(successfulWorker, calls), register: async record => saved.push(record) }, request);
  assert.deepEqual(result.settings, normalizeVectorOptions(request));
  assert.equal(calls[0].python, deps.python);
  assert.equal(calls[0].args[1], "vectorize");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(saved[0].source, "mark.png");
  assert.equal(saved[0].name, result.name);
  assert.deepEqual(saved[0].result, result);
  assert.equal(result.stats.cubicSegments, 4);
  assert.deepEqual(result.warnings, ["fixture warning"]);
  assert.equal(result.sourceWidth, 32);
  assert.ok((await readdir(deps.imageDir)).every(name => !name.startsWith(".vec_")));
});

test("simultaneous requests have separate job files and never overwrite an earlier SVG", async t => {
  const deps = await fixture(t), calls = [];
  const spawnProcess = worker(successfulWorker, calls);
  const results = await Promise.all(Array.from({ length: 4 }, () => vectorizeImage({ ...deps, spawnProcess }, { name: "mark.png" })));
  assert.equal(new Set(calls.map(call => call.args[2])).size, 4);
  assert.equal(new Set(results.map(result => result.name)).size, 4);
  const files = await readdir(deps.imageDir);
  assert.equal(files.filter(name => name.endsWith(".svg")).length, 4);
  assert.equal(files.filter(name => name.startsWith(".vec_")).length, 0);
});

test("bad filenames, missing images and non-file inputs fail before spawning", async t => {
  const deps = await fixture(t); let launches = 0;
  const spawnProcess = () => { launches++; throw new Error("must not launch"); };
  for (const name of ["../mark.png", "C:\\mark.png", "mark.png:secret", "mark.svg", "", null])
    await assert.rejects(vectorizeImage({ ...deps, spawnProcess }, { name }), error => error.status === 400);
  await assert.rejects(vectorizeImage({ ...deps, spawnProcess }, { name: "missing.png" }), error => error.status === 404);
  assert.equal(launches, 0);
});

test("spawn errors settle and clear temporary files", async t => {
  const deps = await fixture(t);
  for (const spawnProcess of [() => { throw new Error("missing executable"); }, worker(({ proc }) => proc.emit("error", new Error("ENOENT executable")))]) {
    await assert.rejects(vectorizeImage({ ...deps, spawnProcess }, { name: "mark.png" }), error => error.status === 500 && /start vectorization/.test(error.message));
    assert.deepEqual(await readdir(deps.imageDir), ["mark.png"]);
  }
});

test("timeouts kill the worker with a bounded fallback when no close event arrives", async t => {
  const deps = await fixture(t), calls = [];
  await assert.rejects(vectorizeImage({ ...deps, timeoutMs: 20, spawnProcess: worker(() => {}, calls) }, { name: "mark.png" }), error => error.status === 504);
  assert.equal(calls[0].proc.killed, true);
  calls[0].proc.emit("close", 0); // a late event cannot settle twice or recreate an output
  assert.deepEqual(await readdir(deps.imageDir), ["mark.png"]);
});

test("timeout cleanup waits for a terminating worker's last atomic write", async t => {
  const deps = await fixture(t);
  const spawnProcess = worker(async ({ proc, args }) => {
    const job = JSON.parse(await readFile(args[2], 'utf8'));
    proc.kill = () => {
      setTimeout(async () => { await writeFile(job.out, 'late output'); proc.emit('close', 1); }, 25);
      return true;
    };
  });
  await assert.rejects(vectorizeImage({ ...deps, timeoutMs: 30, spawnProcess }, { name: 'mark.png' }), error => error.status === 504);
  assert.deepEqual(await readdir(deps.imageDir), ['mark.png']);
});

test("invalid worker results and metadata persistence failures remove partial output", async t => {
  const deps = await fixture(t);
  for (const operation of [async ({ proc, args }) => {
    const job = JSON.parse(await readFile(args[2], "utf8"));
    await writeFile(job.out, "partial"); proc.stdout.end("not JSON\n"); proc.emit("close", 0);
  }, async ({ proc, args }) => {
    const job = JSON.parse(await readFile(args[2], "utf8"));
    await writeFile(job.out, "partial"); proc.stdout.end('{"ok":false,"error":"bad raster"}\n'); proc.emit("close", 1);
  }]) {
    await assert.rejects(vectorizeImage({ ...deps, spawnProcess: worker(operation) }, { name: "mark.png" }), error => error.status === 500);
    assert.deepEqual(await readdir(deps.imageDir), ["mark.png"]);
  }
  await assert.rejects(vectorizeImage({ ...deps, spawnProcess: worker(successfulWorker), register: async () => { throw new Error("metadata disk full"); } }, { name: "mark.png" }), /metadata disk full/);
  assert.deepEqual(await readdir(deps.imageDir), ["mark.png"]);
});

test("invalid explicit fills return a request error and interrupted atomic temporaries are removed", async t => {
  const deps = await fixture(t);
  const spawnProcess = worker(async ({ proc, args }) => {
    const job = JSON.parse(await readFile(args[2], "utf8"));
    await writeFile(path.join(deps.imageDir, `.${path.basename(job.out)}.vector-fixture.tmp`), "partial atomic SVG");
    proc.stdout.end('{"ok":false,"error":"gradient color not in palette","status":400}\n');
    proc.emit("close", 1);
  });
  await assert.rejects(vectorizeImage({ ...deps, spawnProcess }, { name: "mark.png" }), error => error.status === 400 && /not in palette/.test(error.message));
  assert.deepEqual(await readdir(deps.imageDir), ["mark.png"]);
});

test("worker diagnostic output is bounded and overflow terminates processing", async t => {
  const deps = await fixture(t), calls = [];
  await assert.rejects(vectorizeImage({ ...deps, spawnProcess: worker(({ proc }) => proc.stdout.write("x".repeat(2 * 1024 * 1024)), calls) }, { name: "mark.png" }), /too much diagnostic output/);
  assert.equal(calls[0].proc.killed, true);
  assert.deepEqual(await readdir(deps.imageDir), ["mark.png"]);
});

test("real MCP call forwards the shared schema and returns every measurement", async t => {
  const deps = await fixture(t), bodies = [], saved = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/api/images/vectorize");
      assert.equal(req.method, "POST");
      assert.match(req.headers["x-aiplay-actor"], /^agent:/);
      let body = ""; for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body); bodies.push(parsed);
      const result = await vectorizeImage({ ...deps, spawnProcess: worker(successfulWorker), register: async receipt => saved.push(receipt) }, parsed);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(error.status || 500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = process.env.AIPLAY_URL;
  process.env.AIPLAY_URL = `http://127.0.0.1:${server.address().port}`;
  const { TOOLS } = await import(`./mcp.js?vector-fixture=${Date.now()}`);
  if (previous === undefined) delete process.env.AIPLAY_URL; else process.env.AIPLAY_URL = previous;
  const tool = TOOLS.find(row => row.name === "image_vectorize");
  assert.equal(tool.inputSchema, VECTOR_INPUT_SCHEMA);
  const args = { name: "mark.png", mode: "posterize", quality: "draft", colors: 3, detail: 2,
    tolerance: 0.4, minArea: 0, alphaThreshold: 150, maxSize: 128,
    gradients: [{ color: "#000000", angle: 180, stops: [{ offset: 0, color: "#123456" }, { offset: 1, color: "#ffffff" }] }] };
  const result = await tool.run(args);
  assert.deepEqual(bodies[0], { ...normalizeVectorOptions(args), name: args.name });
  assert.equal(result.svg, result.name);
  assert.deepEqual(result.stats, saved[0].result.stats);
  assert.deepEqual(result.settings, saved[0].result.settings);
  assert.deepEqual(result.palette, ["#000000", "#ffffff"]);
  assert.equal(result.sourceHeight, 24);
  const count = bodies.length;
  await assert.rejects(tool.run({ name: "mark.png", tolerance: 99 }), /tolerance/);
  assert.equal(bodies.length, count);
});

test("the actual HTTP route delegates validation and retains the measured metadata receipt", async () => {
  const index = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const route = index.slice(index.indexOf('if (p === "/api/images/vectorize"'), index.indexOf('if (p === "/api/images" && req.method === "POST")'));
  assert.match(route, /await vectorizeImage\(/);
  assert.match(route, /strict: true/);
  assert.match(route, /vectorFrom: source/);
  assert.match(route, /vectorization: \{ settings, palette, stats, warnings, sourceWidth, sourceHeight, width, height, paths, bytes, traceFingerprint, shapes, shapesTruncated, cleanup, replay \}/);
  assert.match(route, /err\.status \|\| 500/);
});

test("selected finishing preserves the plan and refuses ambiguous or unbound requests", async t => {
  const basis = 'a'.repeat(64), selected = { color: '#123456', contours: [2, 0] };
  const plan = { name: 'mark.png', basis,
    cleanup: { operations: [{ ...selected, type: 'concentric', maxDeviation: 6 }] },
    composition: { fills: [{ ...selected, gradient: { stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#00ffff' }], bounds: [10, 20, 90, 80] } }],
      shadows: [{ ...selected, fill: '#c3c3c3', offset: [12, 14] }], omit: [{ color: '#123456', contours: [3] }] } };
  const deps = await fixture(t), result = await vectorizeImage({ ...deps, spawnProcess: worker(successfulWorker) }, plan);
  assert.deepEqual(result.settings, normalizeVectorOptions(plan));
  assert.deepEqual(result.settings.cleanup.operations[0].contours, [0, 2]);
  assert.deepEqual(result.settings.composition.fills[0].gradient.bounds, [10, 20, 90, 80]);
  for (const bad of [
    { ...plan, basis: undefined }, { ...plan, basis: 'old' },
    { ...plan, cleanup: { operations: [{ color: '#123456', contours: [0], type: 'concentric' }] } },
    { ...plan, cleanup: { operations: [{ color: '#123456', contours: [0], type: 'smooth' }, { color: '#123456', contours: [0], type: 'circle' }] } },
    { ...plan, composition: { fills: [{ ...selected, solid: '#ffffff', gradient: { stops: [] } }] } },
    { ...plan, composition: { shadows: [{ ...selected, fill: '#ffffff', offset: [Infinity, 0] }] } },
  ]) assert.throws(() => normalizeVectorOptions(bad), e => e.status === 400);
});

test("SVG review forwards bounded native-image options and removes its worker job", async t => {
  const deps = await fixture(t), calls = [];
  await writeFile(path.join(deps.imageDir, 'badge.svg'), '<svg/>');
  const spawnProcess = worker(async ({ proc, args }) => {
    assert.equal(args[1], 'vector_review');
    const job = JSON.parse(await readFile(args[2], 'utf8'));
    assert.deepEqual(job.crop, [10, 20, 100, 80]);
    assert.equal(job.maxEdge, 1536); assert.equal(job.background, '#101827');
    proc.stdout.end(JSON.stringify({ ok: true, image: { mimeType: 'image/png', data: 'fixture' }, width: 1536, height: 1229, renderer: 'aiplay-vector-cpu' })+'\n');
    proc.emit('close', 0);
  }, calls);
  const result = await vectorReviewImage({ ...deps, spawnProcess }, { name: 'badge.svg', crop: [10,20,100,80], max_edge: 1536, background: '#101827' });
  assert.equal(result.image.mimeType, 'image/png'); assert.equal(result.name, 'badge.svg');
  assert.ok(!(await readdir(deps.imageDir)).some(n => n.startsWith('.vec_review_')));
  const previous = calls.length;
  for (const args of [{ name: '../badge.svg' }, { name: 'mark.png' }, { name: 'badge.svg', crop: [0,0,.5,10] }, { name: 'badge.svg', max_edge: 9999 }, { name: 'badge.svg', background: 'url(http://bad)' }])
    await assert.rejects(vectorReviewImage({ ...deps, spawnProcess }, args), e => e.status === 400);
  assert.equal(calls.length, previous);
  const { TOOLS } = await import('./mcp.js');
  assert.equal(TOOLS.find(t => t.name === 'image_vector_review').inputSchema, VECTOR_REVIEW_SCHEMA);
});
