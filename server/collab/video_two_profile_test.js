import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStoredVideoJob } from "./video-job.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    method: "POST", headers: { "content-type": "application/json", "x-aiplay-actor": "script:collab-video-courier-test" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() };
}
async function start(profile) {
  profile.port = await freePort();
  profile.logs = "";
  profile.child = spawn(process.execPath, ["server/index.js"], {
    cwd: repo,
    env: { ...process.env, AIPLAY_APPDATA: profile.home, AIPLAY_OUTPUT: profile.output,
      AIPLAY_INPUT: profile.input, AIPLAY_RIG: path.join(profile.root, "empty-rig"),
      AIPLAY_UI_PORT: String(profile.port), AIPLAY_CLOUD_ONLY: "1", AIPLAY_OPEN: "0" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  for (const stream of [profile.child.stdout, profile.child.stderr])
    stream.on("data", (chunk) => { profile.logs = (profile.logs + chunk.toString()).slice(-6000); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (profile.child.exitCode !== null) throw new Error(`Studio exited: ${profile.logs}`);
    try {
      const me = await request(profile, { action: "me", nickname: profile.name });
      if (me.status === 200 && me.body.fp) return me.body;
    } catch { /* Startup still in progress. */ }
    await pause(200);
  }
  throw new Error(`Studio did not start: ${profile.logs}`);
}
async function stop(profile) {
  if (!profile.child || profile.child.exitCode !== null) return;
  const gone = once(profile.child, "exit").catch(() => {});
  profile.child.kill();
  await Promise.race([gone, pause(5000)]);
}
async function run(bin, args) {
  return new Promise((resolve, reject) => execFile(bin, args,
    { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) =>
      error ? reject(new Error(`${error.message}: ${stderr}`)) : resolve(stdout)));
}
async function makeClip(file) {
  await mkdir(path.dirname(file), { recursive: true });
  const ffmpeg = process.env.AIPLAY_FFMPEG || (process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=256x256:r=24",
    "-frames:v", "39", "-an", "-c:v", "mpeg4", "-q:v", "3", "-y", file]);
  return readFile(file);
}
function profile(root, name) {
  const base = path.join(root, name.toLowerCase());
  return { name, root: base, home: path.join(base, "home"),
    output: path.join(base, "output"), input: path.join(base, "input") };
}
const video = (prompt, seed) => ({
  engine: "h3", prompt, width: 256, height: 256, seconds: 1, steps: 20,
  guidance: 1, keepAudio: false, seed, negative: "", sparse: "off",
  attention: "pytorch", blockCache: false, bridge: "off", bridgeAlpha: 0, guideStrength: 0.7,
  refImages: [], refAudios: [], midUploads: [], loras: [], loop: false,
});

test("sealed standalone Video job crosses two profiles, returns a checked MP4, and adopts once", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-collab-video-two-profile-"));
  const borrower = profile(root, "Borrower"), lender = profile(root, "Lender");
  try {
    const [borrowerMe, lenderMe] = await Promise.all([start(borrower), start(lender)]);
    for (const [here, other] of [[borrower, lenderMe], [lender, borrowerMe]]) {
      assert.equal((await request(here, { action: "add_peer", card: other.card })).status, 200);
      assert.equal((await request(here, { action: "verify_peer", fp: other.fp, verified: true })).status, 200);
      assert.equal((await request(here, { action: "set_role", fp: other.fp, role: "lender" })).status, 200);
    }
    const prompt = "An adult dancer in a blue studio.";
    for (const [field, value] of [["negative", "unwanted"], ["guidance", 3], ["sparse", "sol-attn"], ["blockCache", true], ["steps", 4], ["refImages", ["source.png"]], ["loop", true], ["engine", "ltx"]]) {
      const bad = await request(borrower, { action: "preview", kind: "video-job", to: lenderMe.fp,
        video: { ...video(prompt, 42), [field]: value } });
      assert.notEqual(bad.status, 200, `${field} must be refused before preview`);
    }
    const preview = await request(borrower, { action: "preview", kind: "video-job", to: lenderMe.fp, video: video(prompt, 42) });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.packet.jobType, "video");
    assert.equal(preview.body.packet.job.prompt, prompt);
    assert.equal(preview.body.packet.job.seed, 42);
    assert.equal(preview.body.packet.job.modelPolicy, "receiver-local-base");
    assert.deepEqual((await request(borrower, { action: "orders", side: "out" })).body.orders, []);
    const packed = await request(borrower, { action: "pack", previewId: preview.body.previewId });
    assert.equal(packed.status, 200, JSON.stringify(packed.body));
    assert.equal(packed.body.order, preview.body.packet.id);
    const sealed = await readFile(packed.body.file);
    assert.equal(sealed.subarray(0, 11).toString(), "AIPLAYSEAL1");
    assert.equal(sealed.toString("utf8").includes(prompt), false);
    const outgoing = JSON.parse(await readFile(path.join(borrower.output, "collab", "orders", "out", `${packed.body.order}.json`)));
    assert.equal(readStoredVideoJob(outgoing.videoJob).job.prompt, prompt);
    assert.equal(outgoing.slug, undefined);
    assert.equal(outgoing.order, undefined);

    const inbox = path.join(lender.output, "collab", "in");
    await mkdir(inbox, { recursive: true });
    const file = path.basename(packed.body.file), delivered = path.join(inbox, file);
    await writeFile(delivered, sealed);
    const opened = await request(lender, { action: "open", file });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.videoJob.job.prompt, prompt);
    assert.deepEqual((await request(lender, { action: "orders", side: "in" })).body.orders, []);
    assert.deepEqual(await readdir(path.join(lender.output, "clips")).catch(() => []), []);
    const review = await request(lender, { action: "video_accept", file });
    assert.equal(review.status, 409, JSON.stringify(review.body));
    assert.equal(review.body.reason, "not-seen");
    assert.match(review.body.reviewDigest, /^[0-9a-f]{64}$/);
    assert.match(review.body.minutes, /minutes of your card a day/);
    assert.match(review.body.readinessNote, /readiness.*Render/);
    const second = await request(borrower, { action: "preview", kind: "video-job", to: lenderMe.fp,
      video: video("A different adult dancer.", 43) });
    assert.equal(second.status, 200);
    const secondPacked = await request(borrower, { action: "pack", previewId: second.body.previewId });
    assert.equal(secondPacked.status, 200);
    await writeFile(delivered, await readFile(secondPacked.body.file));
    const swapped = await request(lender, { action: "video_accept", file, seen: true, expectedDigest: review.body.reviewDigest });
    assert.equal(swapped.status, 409);
    assert.equal(swapped.body.reason, "review-changed");
    await writeFile(delivered, sealed);
    assert.equal((await request(lender, { action: "set_lend_minutes", fp: borrowerMe.fp, minutesPerDay: 0 })).status, 200);
    const overAllowance = await request(lender, { action: "video_accept", file, seen: true, expectedDigest: review.body.reviewDigest });
    assert.equal(overAllowance.status, 409, JSON.stringify(overAllowance.body));
    assert.equal(overAllowance.body.reason, "budget-zero");
    assert.equal(overAllowance.body.overridable, true);
    assert.deepEqual((await request(lender, { action: "orders", side: "in" })).body.orders, [], "the allowance refusal must not book consent");
    const accepted = await request(lender, { action: "video_accept", file, seen: true, expectedDigest: review.body.reviewDigest, anyway: true });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.state, "landed");
    assert.equal((await request(lender, { action: "video_accept", file, seen: true, expectedDigest: review.body.reviewDigest })).body.reason, "already-landed");
    const rowFile = path.join(lender.output, "collab", "orders", "in", `${packed.body.order}.json`);
    const landed = JSON.parse(await readFile(rowFile));
    assert.equal(readStoredVideoJob(landed.videoJob).job.prompt, prompt);
    assert.equal(landed.artJobId, undefined, "accept may not queue");
    assert.ok(landed.renderEstimatedMinutes > 0, "accept reserves estimated GPU minutes before render");
    const noModel = await request(lender, { action: "video_render", id: packed.body.order });
    assert.equal(noModel.status, 409, JSON.stringify(noModel.body));
    assert.ok(["model-not-ready", "video-disabled"].includes(noModel.body.reason),
      "an empty cloud-only rig must refuse before queueing");
    assert.equal(JSON.parse(await readFile(rowFile)).state, "landed");

    // Simulate the completed local renderer at the same durable boundary as
    // art.on('clip'). GPU inference is deliberately absent from this test.
    await stop(lender);
    const clipName = `collab_${packed.body.order}.mp4`;
    const bytes = await makeClip(path.join(lender.output, "clips", clipName));
    const completed = { ...landed, state: "returning", renderStatus: "complete",
      renderClip: clipName, renderSha256: sha(bytes),
      renderModel: "minimax-h3-base.safetensors",
      renderRights: { class: "unknown", why: "Test receiver-local model record." },
      videoReturnFile: `video-return-${packed.body.order}-aaaaaaaa.aiplay`,
      videoReturnSha256: "0".repeat(64) };
    await writeFile(rowFile, JSON.stringify(completed));
    await mkdir(lender.home, { recursive: true });
    await writeFile(path.join(lender.home, "clips.json"), JSON.stringify({ meta: {
      [clipName]: { engine: "h3", prompt, seed: 42, width: 256, height: 256,
        clipSeconds: 1, steps: 20, guidance: 1, firstFrame: null, refImages: null,
        refAudios: null, audioTrack: null, loras: null, bridge: "off",
        bridgeAlpha: 0, sparse: null, blockCache: false, attention: "pytorch" },
    }, times: {} }));
    await start(lender);
    const returned = await request(lender, { action: "video_send_back", id: packed.body.order });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.notEqual(returned.body.name, completed.videoReturnFile,
      "a claimed but unpublished return is recoverable from the same checked clip");
    await writeFile(rowFile, JSON.stringify({ ...JSON.parse(await readFile(rowFile)), state: "returning" }));
    const recoveredPublished = await request(lender, { action: "video_send_back", id: packed.body.order });
    assert.equal(recoveredPublished.status, 200);
    assert.equal(recoveredPublished.body.file, returned.body.file,
      "a published file completes the orderbook without re-sealing");
    const replayReturn = await request(lender, { action: "video_send_back", id: packed.body.order });
    assert.equal(replayReturn.status, 200);
    assert.equal(replayReturn.body.file, returned.body.file);
    const returnBytes = await readFile(returned.body.file);
    assert.equal(returnBytes.subarray(0, 11).toString(), "AIPLAYSEAL1");
    const returnInbox = path.join(borrower.output, "collab", "in");
    await mkdir(returnInbox, { recursive: true });
    await writeFile(path.join(returnInbox, returned.body.name), returnBytes);
    const returnOpen = await request(borrower, { action: "open", file: returned.body.name });
    assert.equal(returnOpen.status, 200, JSON.stringify(returnOpen.body));
    assert.equal(returnOpen.body.videoReturn.result.b64, "[video bytes]");
    assert.equal((await request(borrower, { action: "orders", side: "out" })).body.orders.find((r) => r.id === packed.body.order).state, "sent");
    const received = await request(borrower, { action: "receive", file: returned.body.name });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.video.ok, true);
    assert.equal(received.body.video.measured.frames, 39);
    const quarantine = (await request(borrower, { action: "quarantine" })).body.videos;
    assert.equal(quarantine.length, 1);
    assert.equal(quarantine[0].adopted, false);
    const unreviewed = await request(borrower, { action: "video_adopt", from: lenderMe.fp, file: quarantine[0].file });
    assert.equal(unreviewed.status, 409, "direct API adoption cannot skip return review");
    assert.equal(unreviewed.body.reason, "video-review-required");
    const checked = await request(borrower, { action: "video_review_return", from: lenderMe.fp, file: quarantine[0].file });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.sha256, sha(bytes));
    assert.match(checked.body.reviewReceipt, /^[0-9a-f]{48}$/);
    const stale = await request(borrower, { action: "video_adopt", from: lenderMe.fp, file: quarantine[0].file,
      reviewReceipt: "0".repeat(48) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, "video-review-required");
    const adopted = await request(borrower, { action: "video_adopt", from: lenderMe.fp, file: quarantine[0].file,
      reviewReceipt: checked.body.reviewReceipt });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body.metadata.source, "peer-video");
    assert.equal(adopted.body.metadata.peer.orderId, packed.body.order);
    assert.deepEqual(await readFile(path.join(borrower.output, "clips", adopted.body.name)), bytes);
    assert.equal((await request(borrower, { action: "video_adopt", from: lenderMe.fp, file: quarantine[0].file,
      reviewReceipt: checked.body.reviewReceipt })).body.replay, true);
    assert.equal((await request(borrower, { action: "receive", file: returned.body.name })).body.video.replay, true);
    const order = (await request(borrower, { action: "orders", side: "out" })).body.orders.find((r) => r.id === packed.body.order);
    assert.equal(order.state, "adopted");
    assert.equal(order.returns.length, 1, "replays cannot add duplicate provenance");
  } finally {
    await Promise.all([stop(borrower), stop(lender)]);
    await rm(root, { recursive: true, force: true });
  }
});
