import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStoredImageJob } from "./image-job.js";
import { deflateSync } from "node:zlib";

// Two independent Studio processes and storage profiles. A copied .aiplay
// file is the only exchange. Neither profile starts an engine or contacts a
// peer; this proves the courier/consent boundary, not a Qwen render.
const repo = fileURLToPath(new URL("../..", import.meta.url));
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, payload) {
  const tag = Buffer.from(type, "ascii"), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([tag, payload])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, tag, payload, checksum]);
}
function tinyPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4);
  header[8] = 8; header[9] = 6;
  const row = Buffer.from([0, 20, 60, 200, 255, 20, 60, 200, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat([row, row]))),
    chunk("IEND", Buffer.alloc(0))]);
}
const reference = tinyPng();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(profile, body) {
  const response = await fetch(`http://127.0.0.1:${profile.port}/api/collab`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aiplay-actor": "script:collab-image-courier-test" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}

async function start(profile) {
  profile.port = await freePort();
  profile.logs = "";
  profile.child = spawn(process.execPath, ["server/index.js"], {
    cwd: repo,
    env: {
      ...process.env,
      AIPLAY_APPDATA: profile.home,
      AIPLAY_OUTPUT: profile.output,
      AIPLAY_INPUT: profile.input,
      AIPLAY_RIG: path.join(profile.root, "empty-rig"),
      AIPLAY_UI_PORT: String(profile.port),
      AIPLAY_CLOUD_ONLY: "1",
      AIPLAY_OPEN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [profile.child.stdout, profile.child.stderr]) {
    stream.on("data", (chunk) => { profile.logs = (profile.logs + chunk.toString()).slice(-6000); });
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (profile.child.exitCode !== null) throw new Error(`Studio exited during startup: ${profile.logs}`);
    try {
      const me = await request(profile, { action: "me", nickname: profile.name });
      if (me.status === 200 && me.body.fp) return me.body;
    } catch { /* Not listening yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Studio did not start on ${profile.port}: ${profile.logs}`);
}

async function stop(profile) {
  if (!profile.child || profile.child.exitCode !== null) return;
  const gone = once(profile.child, "exit").catch(() => {});
  profile.child.kill();
  await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

async function outputPngs(profile) {
  const dir = path.join(profile.output, "images");
  return (await readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter((name) => name.endsWith(".png"));
}

async function compactOrderRow(profile, side, id) {
  const file = path.join(profile.output, "collab", "orders", side, `${id}.json`);
  const raw = await readFile(file, "utf8");
  assert.equal(raw.includes(reference.toString("base64")), false,
    `${side} orderbook JSON must not duplicate the sealed reference bytes`);
  const row = JSON.parse(raw);
  const saved = row.imageJob;
  assert.equal(saved.job.references.length, 1);
  assert.equal(Object.hasOwn(saved.job.references[0], "b64"), false);
  assert.equal(saved.job.references[0].sha256, sha256(reference));
  assert.equal(saved.job.references[0].bytes, reference.length);
  assert.equal(saved.storage.v, 1);
  assert.match(saved.storage.sha256, /^[0-9a-f]{64}$/);
  assert.equal(readStoredImageJob(saved).storage.sha256, saved.storage.sha256,
    "the compact summary must pass its own integrity check");
  return row;
}

test("two Studio profiles hand off one sealed Qwen image request without rendering on receipt", { timeout: 100_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-collab-image-two-profile-"));
  const borrower = { name: "Borrower", root: path.join(root, "borrower"), home: path.join(root, "borrower", "home"), output: path.join(root, "borrower", "output"), input: path.join(root, "borrower", "input") };
  const lender = { name: "Lender", root: path.join(root, "lender"), home: path.join(root, "lender", "home"), output: path.join(root, "lender", "output"), input: path.join(root, "lender", "input") };
  try {
    const [borrowerMe, lenderMe] = await Promise.all([start(borrower), start(lender)]);
    assert.notEqual(borrowerMe.fp, lenderMe.fp);
    for (const [here, other] of [[borrower, lenderMe], [lender, borrowerMe]]) {
      const added = await request(here, { action: "add_peer", card: other.card });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      assert.equal(added.body.peer.verified, false);
      const verified = await request(here, { action: "verify_peer", fp: other.fp, verified: true });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      const role = await request(here, { action: "set_role", fp: other.fp, role: "lender" });
      assert.equal(role.status, 200, JSON.stringify(role.body));
    }

    await mkdir(borrower.input, { recursive: true });
    await writeFile(path.join(borrower.input, "source.png"), reference);
    /* A signed hash does not make compressed picture bytes safe to show in a
     * browser. Even Open/Review must reject a source whose canvas exceeds the
     * receiver's limit, before returning its data URL to the page or MCP. */
    const hugeCanvas = Buffer.from(reference);
    hugeCanvas.writeUInt32BE(5000, 16);
    await writeFile(path.join(borrower.input, "huge.png"), hugeCanvas);
    const hugePreview = await request(borrower, { action: "preview", kind: "image-job",
      to: lenderMe.fp, image: { prompt: "An adult dancer", width: 1024, height: 1024,
        seed: 986, refs: ["huge.png"] } });
    assert.equal(hugePreview.status, 200, JSON.stringify(hugePreview.body));
    const hugePacked = await request(borrower, { action: "pack", previewId: hugePreview.body.previewId });
    assert.equal(hugePacked.status, 200, JSON.stringify(hugePacked.body));
    const hugeInbox = path.join(lender.output, "collab", "in");
    await mkdir(hugeInbox, { recursive: true });
    const hugeName = "huge-reference.aiplay";
    await writeFile(path.join(hugeInbox, hugeName), await readFile(hugePacked.body.file));
    const hugeOpen = await request(lender, { action: "open", file: hugeName });
    assert.equal(hugeOpen.status, 400);
    assert.equal(hugeOpen.body.reason, "reference-canvas");
    assert.equal(hugeOpen.body.packet, undefined, "unsafe reference bytes never reach the browser");
    const hugeConsent = await request(lender, { action: "image_accept", file: hugeName });
    assert.equal(hugeConsent.status, 400);
    assert.equal(hugeConsent.body.reason, "reference-canvas");
    await rm(path.join(hugeInbox, hugeName));
    await rm(path.join(borrower.output, "collab", "orders", "out", `${hugePacked.body.order}.json`));
    await rm(hugePacked.body.file);
    const prompt = "An adult dancer in a rainlit studio, bright paper lanterns behind her.";
    const preview = await request(borrower, {
      action: "preview", kind: "image-job", to: lenderMe.fp,
      image: { prompt, width: 1024, height: 1024, seed: 987, refs: ["source.png"] },
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.kind, "job-order");
    assert.equal(preview.body.packet.jobType, "image");
    assert.equal(preview.body.packet.job.prompt, prompt);
    assert.equal(preview.body.packet.job.seed, 987);
    assert.equal(preview.body.packet.job.engine, "qwen-image-2.1");
    assert.equal(preview.body.packet.job.references.length, 1);
    assert.equal(preview.body.packet.job.references[0].sha256, sha256(reference));
    assert.equal("b64" in preview.body.packet.job.references[0], false);
    assert.equal(preview.body.manifest[0].included, true);
    assert.equal(preview.body.includedBytes, reference.length);
    assert.deepEqual((await request(lender, { action: "inbox" })).body.items, []);
    assert.deepEqual((await request(borrower, { action: "orders", side: "out" })).body.orders, []);

    const packed = await request(borrower, { action: "pack", previewId: preview.body.previewId });
    assert.equal(packed.status, 200, JSON.stringify(packed.body));
    assert.equal(packed.body.kind, "job-order");
    assert.equal(packed.body.order, preview.body.packet.id);
    const sealedBytes = await readFile(packed.body.file);
    assert.equal(sealedBytes.subarray(0, 11).toString(), "AIPLAYSEAL1");
    assert.equal(sealedBytes.toString("utf8").includes(prompt), false);
    assert.deepEqual((await request(lender, { action: "inbox" })).body.items, []);
    const sent = (await request(borrower, { action: "orders", side: "out" })).body.orders;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].state, "sent");
    assert.equal(sent[0].to.fp, lenderMe.fp);
    assert.equal((await compactOrderRow(borrower, "out", packed.body.order)).state, "sent");

    const inbox = path.join(lender.output, "collab", "in");
    await mkdir(inbox, { recursive: true });
    const landed = path.join(inbox, path.basename(packed.body.file));
    await writeFile(landed, sealedBytes);
    const opened = await request(lender, { action: "open", file: path.basename(landed) });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.kind, "job-order");
    assert.equal(opened.body.imageJob.job.prompt, prompt);
    assert.equal(opened.body.imageJob.job.references[0].sha256, sha256(reference));
    assert.equal(opened.body.packet.job.references[0].b64, reference.toString("base64"));
    assert.deepEqual((await request(lender, { action: "orders", side: "in" })).body.orders, []);
    assert.deepEqual(await outputPngs(lender), []);

    const consent = await request(lender, { action: "image_accept", file: path.basename(landed) });
    assert.equal(consent.status, 409, JSON.stringify(consent.body));
    assert.equal(consent.body.reason, "not-seen");
    assert.match(consent.body.reviewDigest, /^[0-9a-f]{64}$/);
    assert.equal(consent.body.imageJob.job.prompt, prompt);
    assert.equal(consent.body.pictures.length, 1);
    assert.equal(consent.body.pictures[0].dataUrl, `data:image/png;base64,${reference.toString("base64")}`);
    assert.deepEqual((await request(lender, { action: "orders", side: "in" })).body.orders, []);

    // The filename was shown to the person, but its bytes can change before
    // the next click. Put a second, valid signed order under the SAME inbox
    // path: the old review digest must not consent to its different prompt.
    const replacementPrompt = "An adult dancer under blue lights, with no lanterns.";
    const replacementPreview = await request(borrower, {
      action: "preview", kind: "image-job", to: lenderMe.fp,
      image: { prompt: replacementPrompt, width: 1024, height: 1024, seed: 988, refs: ["source.png"] },
    });
    assert.equal(replacementPreview.status, 200, JSON.stringify(replacementPreview.body));
    const replacementPack = await request(borrower, { action: "pack", previewId: replacementPreview.body.previewId });
    assert.equal(replacementPack.status, 200, JSON.stringify(replacementPack.body));
    await writeFile(landed, await readFile(replacementPack.body.file));
    const replacementOpen = await request(lender, { action: "open", file: path.basename(landed) });
    assert.equal(replacementOpen.status, 200, JSON.stringify(replacementOpen.body));
    assert.equal(replacementOpen.body.imageJob.job.prompt, replacementPrompt,
      "the replacement is a valid signed job, not a corrupt-file refusal");
    const swapped = await request(lender, { action: "image_accept", file: path.basename(landed),
      seen: true, expectedDigest: consent.body.reviewDigest });
    assert.equal(swapped.status, 409, JSON.stringify(swapped.body));
    assert.equal(swapped.body.reason, "review-changed");
    assert.deepEqual((await request(lender, { action: "orders", side: "in" })).body.orders, []);
    const stagedAfterSwap = (await readdir(lender.input).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })).filter((name) => name.startsWith("aiplay_frame_"));
    assert.deepEqual(stagedAfterSwap, [], "a swapped job cannot stage its references");
    assert.deepEqual(await outputPngs(lender), [], "a swapped job cannot render");
    await writeFile(landed, sealedBytes);

    const unbound = await request(lender, { action: "image_accept", file: path.basename(landed), seen: true });
    assert.equal(unbound.status, 409, JSON.stringify(unbound.body));
    assert.equal(unbound.body.reason, "review-changed");
    assert.deepEqual((await request(lender, { action: "orders", side: "in" })).body.orders, []);
    const accepted = await request(lender, { action: "image_accept", file: path.basename(landed), seen: true, expectedDigest: consent.body.reviewDigest });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.state, "landed");
    assert.equal(accepted.body.order, packed.body.order);
    assert.equal(accepted.body.stagedRefs.length, 1);
    assert.deepEqual(await readFile(path.join(lender.input, accepted.body.stagedRefs[0])), reference);
    assert.deepEqual(await outputPngs(lender), []);
    const awaiting = (await request(lender, { action: "orders", side: "in" })).body.orders;
    assert.equal(awaiting.length, 1);
    assert.equal(awaiting[0].state, "landed");
    assert.equal(awaiting[0].imageId, undefined, "acceptance must not queue a render");
    assert.equal((await compactOrderRow(lender, "in", packed.body.order)).state, "landed");

    const replay = await request(lender, { action: "image_accept", file: path.basename(landed), seen: true, expectedDigest: consent.body.reviewDigest });
    assert.equal(replay.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.reason, "already-landed");
    const unrenderedReturn = await request(lender, { action: "image_send_back", id: packed.body.order });
    assert.equal(unrenderedReturn.status, 409, JSON.stringify(unrenderedReturn.body));
    assert.equal(unrenderedReturn.body.reason, "not-rendered");

    // The empty rig cannot provide the exact Qwen base weights or nodes. This
    // must be a visible refusal, with the accepted order still available.
    const noModel = await request(lender, { action: "image_render", id: packed.body.order });
    assert.equal(noModel.status, 409, JSON.stringify(noModel.body));
    assert.equal(noModel.body.reason, "model-not-ready");
    assert.equal((await request(lender, { action: "orders", side: "in" })).body.orders[0].state, "landed");
    assert.deepEqual(await outputPngs(lender), []);
    assert.equal((await stat(landed)).size, sealedBytes.length);
  } finally {
    await Promise.all([stop(borrower), stop(lender)]);
    assert.equal(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep), true);
    await rm(root, { recursive: true, force: true });
  }
});
