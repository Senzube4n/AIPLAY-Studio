import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeys } from "./identity.js";
import { makeReturn } from "./order.js";
import { sealTo } from "./seal.js";

// Two actual Studio processes and two independent home/output folders. Their
// only shared data is a copied .aiplay file, as it would be with a file courier.
// No model or engine is started. The synthetic return below exercises the
// receive/quarantine boundary, not a claim that a lender rendered a clip.
const repo = fileURLToPath(new URL("../..", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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
    headers: { "content-type": "application/json", "x-aiplay-actor": "script:collab-courier-test" },
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
    } catch { /* Port is not listening yet. */ }
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

function hasNoQuarantine(output) {
  return stat(path.join(output, "collab", "quarantine")).then(() => false, (error) => {
    if (error.code === "ENOENT") return true;
    throw error;
  });
}

test("two Studio profiles exchange one sealed scene by file and quarantine a synthetic return", { timeout: 100_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-collab-two-profile-"));
  const borrower = { name: "Borrower", root: path.join(root, "borrower"), home: path.join(root, "borrower", "home"), output: path.join(root, "borrower", "output") };
  const lender = { name: "Lender", root: path.join(root, "lender"), home: path.join(root, "lender", "home"), output: path.join(root, "lender", "output") };
  try {
    const [borrowerMe, lenderMe] = await Promise.all([start(borrower), start(lender)]);
    assert.notEqual(borrowerMe.fp, lenderMe.fp);
    assert.notEqual(borrowerMe.signPublic, lenderMe.signPublic);

    for (const [here, other] of [[borrower, lenderMe], [lender, borrowerMe]]) {
      const added = await request(here, { action: "add_peer", card: other.card });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      assert.equal(added.body.peer.verified, false);
      const verified = await request(here, { action: "verify_peer", fp: other.fp, verified: true });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
      const role = await request(here, { action: "set_role", fp: other.fp, role: "lender" });
      assert.equal(role.status, 200, JSON.stringify(role.body));
    }

    const slug = "courier-scene";
    const assets = path.join(borrower.output, "mv", slug, "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, "nova.png"), png);
    await writeFile(path.join(borrower.output, "mv", slug, "project.json"), JSON.stringify({
      v: 1, kind: "mv", slug, title: "Courier scene", styleBible: "soft daylight",
      song: { file: "private-song.flac" }, lyricLines: [{ t: 0, text: "private lyric" }],
      brief: { aspectRatio: "16:9", resolution: "1280x720", qualityMode: "recommended", videoEngine: "h3", videoSteps: 8 },
      segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 4, durationSec: 4 }],
      boards: [{ segmentId: "s1_0", boardPrompt: "An adult performer crosses an empty stage.", shots: [{ action: "Wide shot." }], characterRefs: ["Nova"] }],
      characters: [{ id: "c1", name: "Nova", imageFile: "nova.png" }],
      backgrounds: [], props: [], clips: [], plans: [], runs: [],
    }));

    const preview = await request(borrower, { action: "preview", kind: "order", slug, segmentId: "s1_0", to: lenderMe.fp, seed: 987, steps: 8, engineMode: "h3" });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.packet.order.seed, 987);
    assert.equal(preview.body.packet.files.length, 1);
    assert.equal(JSON.stringify(preview.body.packet).includes("private lyric"), false);
    assert.equal(JSON.stringify(preview.body.packet).includes("private-song.flac"), false);
    assert.deepEqual((await request(lender, { action: "inbox" })).body.items, []);

    const packed = await request(borrower, { action: "pack", previewId: preview.body.previewId });
    assert.equal(packed.status, 200, JSON.stringify(packed.body));
    assert.equal(packed.body.order, preview.body.packet.id);
    assert.equal((await readFile(packed.body.file)).subarray(0, 11).toString(), "AIPLAYSEAL1");
    assert.deepEqual((await request(lender, { action: "inbox" })).body.items, []);
    const inbox = path.join(lender.output, "collab", "in");
    await mkdir(inbox, { recursive: true });
    const landed = path.join(inbox, path.basename(packed.body.file));
    await writeFile(landed, await readFile(packed.body.file));
    assert.equal((await request(lender, { action: "inbox" })).body.items.length, 1);

    const opened = await request(lender, { action: "open", file: path.basename(landed) });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.kind, "order");
    assert.equal((await request(lender, { action: "orders", side: "in" })).body.orders.length, 0);
    const unread = await request(lender, { action: "accept", file: path.basename(landed) });
    assert.equal(unread.status, 409, JSON.stringify(unread.body));
    assert.equal(unread.body.reason, "not-seen");
    assert.match(unread.body.prompt, /Wide shot/);
    assert.equal(unread.body.pictures.length, 1);
    assert.equal((await request(lender, { action: "orders", side: "in" })).body.orders.length, 0);

    // The engine is deliberately absent, so acceptance must refuse without
    // creating an errand or pretending the remote render ran.
    const cannotPromise = await request(lender, { action: "accept", file: path.basename(landed), seen: true });
    assert.equal(cannotPromise.status, 409, JSON.stringify(cannotPromise.body));
    assert.equal(cannotPromise.body.reason, "engine-unreachable");
    assert.equal((await request(lender, { action: "orders", side: "in" })).body.orders.length, 0);

    // A CPU-made clip and a synthetic return test the receive boundary without
    // attributing a model render to this test. The real send_back route needs a
    // rendered errand, which is outside this offline acceptance lane.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const ffmpeg = promisify(execFile);
    try { await ffmpeg("ffmpeg", ["-version"], { timeout: 5000 }); }
    catch (error) {
      if (error.code === "ENOENT") { t.diagnostic("ffmpeg unavailable: order file exchange passed; return video probe was skipped"); return; }
      throw error;
    }
    const sent = (await request(borrower, { action: "orders", side: "out" })).body.orders.find((row) => row.id === packed.body.order);
    assert.ok(sent?.expect, "packed order saved its expected clip measurements");
    const clip = path.join(root, "synthetic.mp4");
    await ffmpeg("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      `color=c=black:s=${sent.expect.width}x${sent.expect.height}:r=${sent.expect.fps}`,
      "-frames:v", String(sent.expect.frames), "-an", "-c:v", "mpeg4", "-q:v", "15", "-y", clip], { timeout: 30_000 });
    const bytes = await readFile(clip);
    const ret = makeReturn({
      orderId: packed.body.order, segmentId: "s1_0", result: { bytes, ext: ".mp4" },
      record: { model: "synthetic-test", outputRights: { class: "test-only" }, engine: "h3", steps: 8, seed: 987, actor: "script:collab-courier-test" },
      now: Date.now(),
    });
    const keys = await privateKeys({ appData: lender.home });
    const sealedReturn = sealTo({
      payload: Buffer.from(JSON.stringify(ret)),
      toSealPublicB64: borrowerMe.sealPublic, toSignPublicB64: borrowerMe.signPublic,
      toFp: borrowerMe.fp, fromFp: lenderMe.fp, signPrivate: keys.signPrivate,
    });
    const returnInbox = path.join(borrower.output, "collab", "in");
    await mkdir(returnInbox, { recursive: true });
    await writeFile(path.join(returnInbox, "synthetic-return.aiplay"), sealedReturn);
    assert.equal(await hasNoQuarantine(borrower.output), true);
    const viewedReturn = await request(borrower, { action: "open", file: "synthetic-return.aiplay" });
    assert.equal(viewedReturn.status, 200, JSON.stringify(viewedReturn.body));
    assert.equal(viewedReturn.body.kind, "return");
    assert.equal(await hasNoQuarantine(borrower.output), true);
    const received = await request(borrower, { action: "receive", file: "synthetic-return.aiplay" });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.ok, true);
    const quarantine = await request(borrower, { action: "quarantine" });
    assert.equal(quarantine.status, 200, JSON.stringify(quarantine.body));
    assert.equal(quarantine.body.takes.length, 1);
    assert.equal(quarantine.body.takes[0].adopted, false);
    assert.equal(quarantine.body.takes[0].orderId, packed.body.order);
    assert.equal((await request(borrower, { action: "orders", side: "out" })).body.orders[0].state, "returned");
  } finally {
    await Promise.all([stop(borrower), stop(lender)]);
    assert.equal(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep), true);
    await rm(root, { recursive: true, force: true });
  }
});
