import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const route = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const imageRoute = route.slice(route.indexOf('if (p === "/api/image" && req.method === "POST")'),
  route.indexOf('if (p === "/api/images" && req.method !== "POST")'));
const begin = imageRoute.indexOf("const collabImageBase = engine === QWEN_IMAGE_ENGINE");
const end = imageRoute.indexOf("/* Two friend jobs can be queued", begin);
assert.ok(begin >= 0 && end > begin, "the image route must pin peer reference bytes before queuing");
const pinSource = imageRoute.slice(begin, end);

test("peer reference bytes are pinned at enqueue and checked again before the Qwen graph", { timeout: 15_000 }, async () => {
  const temporaryRoot = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "aiplay-image-ref-integrity-"));
  assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
  const oldEnv = Object.fromEntries(["AIPLAY_OUTPUT", "AIPLAY_INPUT", "AIPLAY_APPDATA", "AIPLAY_CLOUD_ONLY"]
    .map((key) => [key, process.env[key]]));
  const input = path.join(root, "input");
  process.env.AIPLAY_OUTPUT = path.join(root, "output");
  process.env.AIPLAY_INPUT = input;
  process.env.AIPLAY_APPDATA = path.join(root, "appdata");
  process.env.AIPLAY_CLOUD_ONLY = "1";
  try {
    await mkdir(input, { recursive: true });
    const name = "aiplay_frame_0123456789ab.png";
    const original = Buffer.from("reference bytes when accepted");
    await writeFile(path.join(input, name), original);
    const pin = (actor) => vm.runInNewContext(`(async () => { ${pinSource}\nreturn { collabImageBase, collabRefHashes }; })()`, {
      engine: "qwen-image-2.1", QWEN_IMAGE_ENGINE: "qwen-image-2.1", req: { headers: { "x-aiplay-actor": actor } },
      refImages: [name], createHash, readFile, path, config: { inputDir: input },
    });
    const bound = await pin("script:collab-image");
    assert.equal(bound.collabImageBase, true);
    assert.deepEqual(Array.from(bound.collabRefHashes), [createHash("sha256").update(original).digest("hex")]);
    assert.match(imageRoute, /\.\.\.\(collabImageBase \? \{ collabImageBase: true, collabRefHashes \} : \{\}\)/,
      "the pinned hash array must ride into job.video rather than stay only in the route");
    const ordinary = await pin("script:manual-image");
    assert.equal(ordinary.collabImageBase, false);
    assert.equal(ordinary.collabRefHashes, null);

    // The queued job waits behind music in normal use. Replacing a staged file
    // during that wait must fail before readiness or graph construction.
    const { ArtRunner } = await import("../art.js");
    let readinessCalls = 0;
    const runner = new ArtRunner({ ready: true }, { current: null, queue: [], loaded: null }, {
      qwenStatus: async () => { readinessCalls++; return { ready: true }; },
    });
    const failed = once(runner, "failed");
    const job = runner.request({ file: "image:i0123456789abcdef", kind: "cover", asked: true, force: true,
      seed: 7, title: "A dancer", video: { engine: "qwen-image-2.1", prompt: "An adult dancer",
        width: 1024, height: 1024, steps: 25, cfg: 1, refImages: [name],
        collabImageBase: true, collabRefHashes: Array.from(bound.collabRefHashes) } });
    assert.ok(job, runner.lastRefusal || "the peer job should enter the local queue");
    assert.deepEqual(job.collabRefHashes, Array.from(bound.collabRefHashes));
    await writeFile(path.join(input, name), Buffer.from("substituted reference bytes"));
    const [failure] = await failed;
    assert.match(failure.error, /Peer image reference 1 changed while waiting in the render queue/);
    assert.equal(readinessCalls, 0, "changed bytes must be refused before Qwen graph/readiness work");
    assert.equal(job.preflightFailed, undefined);
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
