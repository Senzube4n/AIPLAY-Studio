/**
 * LENDING FOR A PERSON WITH NO STRONG CARD — the numbers, pinned where they are
 * computed. collab_test.js walks the door; ui_test.js walks the screen; this
 * lane pins what lending.js, order.js and quarantine.js ANSWER, on the CPU,
 * with no engine, no card and no network. Every fixture that would depend on
 * this machine's disk (the speed-up files) is handed in instead.
 *
 *   1  a take for a scene never rendered here is filed onto that scene
 *   2  the return check centres on the renderer's own frame count
 *   3  a refused take can be watched, from quarantine, by name only — and the
 *      door serving it reads a suffix range as a suffix
 *   4  lip-sync does not travel, and every sentence about the scene says so
 *   8  minutes a day are read at accept: timed (the render alone), estimated
 *      (LTX too), and walkable
 *   9  a step count that overruns the speed-up file that loads is said once,
 *      by one rule, on both machines — naming only files this build can get
 *   D  every sentence that names a screen names the rail's own label
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as L from "./lending.js";
import * as O from "./order.js";
import { quarantineTake } from "./quarantine.js";
import { shotPacket } from "./packet.js";
import { alignFrames } from "../workflow.js";
import { tableMinutes, trapBand } from "../mv/plancost.js";
import { byteRange } from "../byterange.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 7)]);
const SHA = createHash("sha256").update(PNG).digest("hex");
const FP = "ab".repeat(16);
const src = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

/** An order the way the door builds one: a shot packet and its pictures. */
function order({ seconds = 5, engineMode = "hybrid", refs = true, steps = 8, songUnder = null, id = null } = {}) {
  return O.makeOrder({
    shot: { v: 1, kind: "shot", segmentId: "s1_0", prompt: "a dancer", width: 1344, height: 768, seconds,
      refs: refs ? [{ name: "Hex", sha256: SHA, bytes: PNG.length, file: "char_x.png" }] : [], guides: [], baseScale: null, songUnder },
    files: refs ? [{ file: "char_x.png", b64: PNG.toString("base64") }] : [],
    order: { segmentId: "s1_0", seed: 7, steps, engineMode }, returnTo: { fp: FP, nickname: "bucky" }, now: Date.now(), id,
  });
}

/* ───────────────────────────────────────────── 1 — filing a take */

test("1: a take for a scene never rendered here gets that scene's clip row, and is not picked", () => {
  const doc = { segments: [{ id: "s1_0", index: 0 }, { id: "s1_1", index: 1 }], boards: [{ id: "bd_1", segmentId: "s1_1" }], clips: [] };
  const take = { clip: "peer_abababab_000000000000.mp4", seed: 7, peer: { fp: FP } };
  assert.deepEqual(L.fileTakeOnScene(doc, "s1_1", take), { filed: true, created: true });
  assert.deepEqual(doc.clips, [{ id: "c_s1_1", segmentId: "s1_1", clipIndex: 1, boardId: "bd_1", mode: "generate", takes: [take] }]);
  assert.equal(doc.clips[0].clipFile, undefined, "nothing plays until a person chooses it");
});

test("1: a scene that has takes keeps playing what it was playing", () => {
  const doc = { segments: [{ id: "s1_0", index: 0 }], clips: [{ id: "c_s1_0", segmentId: "s1_0", clipFile: "mine.mp4", takes: [{ clip: "mine.mp4" }] }] };
  assert.deepEqual(L.fileTakeOnScene(doc, "s1_0", { clip: "theirs.mp4" }), { filed: true, created: false });
  assert.deepEqual([doc.clips.length, doc.clips[0].clipFile, doc.clips[0].takes.map((t) => t.clip)], [1, "mine.mp4", ["mine.mp4", "theirs.mp4"]]);
});

test("1: only a scene that really is gone is reported gone", () => {
  const doc = { segments: [{ id: "s1_0", index: 0 }], clips: [] };
  assert.deepEqual(L.fileTakeOnScene(doc, "s9_9", { clip: "x.mp4" }), { filed: false, created: false });
  assert.deepEqual(doc.clips, []);
});

test("1: the row is the shape generate.js makes on a first render, and the board is shot.js's own findBoard", async () => {
  const gen = await src("../mv/generate.js");
  assert.match(gen, /row = \{ id: `c_\$\{seg\.id\}`, segmentId: seg\.id, clipIndex: seg\.index,\s*boardId: board\?\.id \?\? null, mode: "generate", takes: \[\] \};/);
  const lending = await src("./lending.js");
  assert.match(lending, /import \{ findBoard, resolveShot \} from "\.\.\/mv\/shot\.js";/);
  assert.doesNotMatch(lending, /b\.segmentId === seg\.id/, "no second copy of findBoard");
  /* A board matched by index only — the second spelling findBoard accepts. */
  const doc = { segments: [{ id: "s1_2", index: 2 }], boards: [{ id: "bd_i", segmentIndex: 2 }], clips: [] };
  L.fileTakeOnScene(doc, "s1_2", { clip: "x.mp4" });
  assert.equal(doc.clips[0].boardId, "bd_i");
});

/* ───────────────────────────────────────────── 2 — the frame count */

test("2: the expected frame count is the renderer's own, on both engines", () => {
  const cases = [
    [{ seconds: 6, engineMode: "hybrid", refs: true }, "h3", 158, 144],
    [{ seconds: 4, engineMode: "h3", refs: false }, "h3", 107, 96],
    [{ seconds: 5.5, engineMode: "ltx", refs: false }, "ltx", 137, 132],
    [{ seconds: 6, engineMode: "hybrid", refs: false }, "ltx", 145, 144],
  ];
  for (const [o, engine, frames, slot] of cases) {
    const e = L.expectForOrder(order(o));
    assert.deepEqual([e.engine, e.frames, e.slotFrames], [engine, frames, slot], JSON.stringify(o));
  }
});

test("2: every scene length an order can carry is centred on alignFrames, never on round(seconds × 24)", () => {
  let oldRuleWouldRefuse = 0;
  for (let s = 1; s <= 15; s += 0.25) {
    for (const [engineMode, refs, engine] of [["h3", true, "h3"], ["ltx", false, "ltx"]]) {
      const e = L.expectForOrder(order({ seconds: s, engineMode, refs }));
      assert.equal(e.frames, alignFrames(s, 24, engine), `${s}s ${engine}`);
      if (Math.abs(e.frames - Math.round(s * 24)) > O.FRAME_SLACK) oldRuleWouldRefuse++;
    }
  }
  assert.ok(oldRuleWouldRefuse > 20, `the old centre refused ${oldRuleWouldRefuse} correct lengths`);
});

test("2: a correct take passes, a hand-rounded one does not, and the refusal says why", () => {
  const e = L.expectForOrder(order({ seconds: 6, engineMode: "h3" }));
  const row = L.withFrameGrid({ id: "o_" + "0".repeat(12), to: { fp: FP }, order: { segmentId: "s1_0", seed: 7, steps: 8 }, expect: e });
  const ret = (frames) => O.checkReturn({ orderId: row.id, segmentId: "s1_0", record: { seed: 7, steps: 8 } }, row,
    { frames, width: 1344, height: 768, videoStreams: 1, audioStreams: 0 });
  assert.equal(ret(158).ok, true);
  assert.equal(ret(156).ok, true, "a couple of frames of encoder slack survive");
  const bad = ret(144);
  assert.deepEqual([bad.ok, bad.reason], [false, "result-not-the-shot"]);
  assert.match(bad.why, /158.*6\.00 s on h3, which H3 renders in steps of 17 frames/);
});

test("2: an order row written before rows named their engine accepts either engine's grid", () => {
  assert.deepEqual(L.framesAccepted({ frames: 144 }), [144, 158, 145]);
  const legacy = L.withFrameGrid({ id: "o_" + "1".repeat(12), to: { fp: FP }, order: { segmentId: "s1_0", seed: 7, steps: 8 }, expect: { width: 1344, height: 768, frames: 144 } });
  const ok = (frames) => O.checkReturn({ orderId: legacy.id, segmentId: "s1_0", record: { seed: 7, steps: 8 } }, legacy,
    { frames, width: 1344, height: 768, videoStreams: 1, audioStreams: 0 }).ok;
  assert.deepEqual([ok(144), ok(158), ok(145), ok(170)], [true, true, true, false]);
});

/* ───────────────────────────────────────────── 3 — watching a refused take */

test("3: a quarantined take can be watched by its own name, and nothing else can", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "aiplay-watch-"));
  try {
    const dir = path.join(outDir, "quarantine", FP.slice(0, 8));
    await mkdir(dir, { recursive: true });
    const name = `peer_${FP.slice(0, 8)}_${"c".repeat(12)}.mp4`;
    await writeFile(path.join(dir, name), Buffer.from("a take"));
    await writeFile(path.join(dir, `${name}.json`), "{}");
    const got = await quarantineTake({ outDir, fromFp: FP, file: name });
    assert.deepEqual([got.type, got.size, path.basename(got.file)], ["video/mp4", 6, name]);
    const refused = async (fromFp, file) => { try { await quarantineTake({ outDir, fromFp, file }); return null; } catch (e) { return e.reason; } };
    assert.equal(await refused(FP, `${name}.json`), "bad-arguments", "the sidecar is not a take");
    assert.equal(await refused(FP, `../${FP.slice(0, 8)}/${name}`), "bad-arguments");
    assert.equal(await refused("cd".repeat(16), name), "bad-arguments", "another friend's folder");
    assert.equal(await refused("../../..", name), "bad-arguments");
    assert.equal(await refused(FP, `peer_${FP.slice(0, 8)}_${"d".repeat(12)}.mp4`), "no-such-return");
  } finally { await rm(outDir, { recursive: true, force: true }); }
});

test("3: the take door and /api/clip read a Range header one way, and a suffix is the END of the file", async () => {
  assert.deepEqual(byteRange("bytes=-500", 10_000), { start: 9500, end: 9999 }, "the last 500 bytes, not the first 501");
  assert.deepEqual(byteRange("bytes=-500", 100), { start: 0, end: 99 }, "a suffix longer than the file is the whole file");
  assert.deepEqual(byteRange("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(byteRange("bytes=0-9", 1000), { start: 0, end: 9 });
  assert.deepEqual(byteRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  for (const h of ["bytes=1000-", "bytes=5-3", "bytes=-0"]) assert.deepEqual(byteRange(h, 1000), { unsatisfiable: true }, h);
  assert.deepEqual(byteRange("bytes=0-9", 0), { unsatisfiable: true }, "an empty file answers no range");
  for (const h of [undefined, "", "bytes=-", "items=0-9", "bytes=0-9,20-29"]) assert.equal(byteRange(h, 1000), null, String(h));
  const index = await src("../index.js");
  const door = index.slice(index.indexOf('if (p.startsWith("/api/collab-take/")'), index.indexOf('if (p === "/api/collab" && req.method === "POST")'));
  assert.match(door, /byteRange\(req\.headers\.range, take\.size\)/);
  const clip = index.slice(index.indexOf('if (p.startsWith("/api/clip/")) {'));
  assert.match(clip.slice(0, clip.indexOf("createReadStream(full).pipe(res)")), /byteRange\(req\.headers\.range, size\)/);
});

/* ───────────────────────────────────────────── 4 — lip-sync */

test("4: a singing board or “always” is marked on the packet, as a word; no song means nothing to say", async () => {
  const assets = await mkdtemp(path.join(tmpdir(), "aiplay-sing-"));
  try {
    await writeFile(path.join(assets, "char_x.png"), PNG);
    const doc = (over = {}) => ({
      song: { file: "song.flac" }, brief: {},
      segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 4, durationSec: 4 }],
      boards: [{ segmentId: "s1_0", shots: [{ action: "She sings." }], characterRefs: ["Hex"] }],
      characters: [{ id: "c1", name: "Hex", imageFile: "char_x.png" }], clips: [], ...over,
    });
    const under = async (d) => (await shotPacket({ doc: d, segmentId: "s1_0", assetsDir: assets })).songUnder;
    assert.equal(await under(doc({ boards: [{ segmentId: "s1_0", shots: [{ action: "x" }], characterRefs: ["Hex"], lipSync: true }] })), "lipsync");
    assert.equal(await under(doc({ brief: { songConditioning: "always" } })), "always");
    assert.equal(await under(doc()), null, "an H3 scene with references and no singing hears no song even at home");
    assert.equal(await under(doc({ song: null, brief: { songConditioning: "always" } })), null);
    const packed = await shotPacket({ doc: doc({ brief: { songConditioning: "always" } }), segmentId: "s1_0", assetsDir: assets });
    assert.ok(!JSON.stringify(packed).includes("song.flac"), "the word travels, the file's name never does");
  } finally { await rm(assets, { recursive: true, force: true }); }
});

test("4: packet.js's song rule is generate.js's, character for character", async () => {
  /* packet.js may import only config.js, so its copy is deliberate — and held
   * to the renderer's text here, so a change there fails this lane instead of
   * drifting. */
  const squash = (x) => String(x).replace(/\s+/g, " ").trim();
  const gen = /const songConditioned = ([\s\S]*?);/.exec(await src("../mv/generate.js"))?.[1];
  const pkt = /const songUnderClip = ([\s\S]*?);/.exec(await src("./packet.js"))?.[1];
  /* The third copy: mv/shot.js says the same rule on the shot before anything
   * is spent (songUnder, songLine; 2026-09-24). */
  const shot = /const songUnderClip = ([\s\S]*?);/.exec(await src("../mv/shot.js"))?.[1];
  assert.ok(gen && pkt && shot, "all three expressions are found");
  assert.equal(squash(pkt), squash(gen));
  assert.equal(squash(shot), squash(gen));
});

test("4: the order's own sentence says lip-sync does not travel, and the returned take's notes repeat it", () => {
  assert.match(O.describeOrder(order({ songUnder: "lipsync" }), Date.now()), /Lip-sync does not travel.*a singing board/);
  assert.match(O.describeOrder(order({ songUnder: "always" }), Date.now()), /“Song under the clip: always”/);
  assert.doesNotMatch(O.describeOrder(order({ songUnder: "engine" }), Date.now()), /Lip-sync/);
  assert.deepEqual(O.returnNotes({ record: { steps: 8 } }, { songUnder: "lipsync" }).length, 1);
  assert.match(O.returnNotes({ record: { steps: 8 } }, { songUnder: "always" })[0], /without the song/);
  assert.deepEqual(O.returnNotes({ record: { steps: 8 } }, { songUnder: "engine" }), []);
});

/* ───────────────────────────────────────────── 9 — speed-up files */

const LORAS = {
  fl2v4: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
  fl2v8: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  ref4: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
  ref8: "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
  tao: "taomate_h3_3step_comfy.safetensors",
  tao19: "minimax_h3_taomate_3step_lora_avg_rank_19_bf16.safetensors",
};
const H3_FOUR = {
  turboMaxSteps: 12, turbo4MaxSteps: 5, turbo3MaxSteps: 3,
  turboLora: LORAS.fl2v4, refTurboLora: LORAS.ref4, turboLora4: LORAS.fl2v4, refTurboLora4: LORAS.ref4, turboLora3: LORAS.fl2v4,
  turboShiftByLora: Object.fromEntries(Object.values(LORAS).map((n) => [n, {}])) };
/** A PC set up from the Models screen: the 4-step files, and pick() fell back to them. */
const FOUR_ONLY = { modelsDir: "/nowhere", modelsAlso: [], video: { engines: { h3: H3_FOUR } } };
/** A rig that fetched the 8-step files by hand, as the owner's did. */
const EIGHT = { ...FOUR_ONLY, video: { engines: { h3: { ...H3_FOUR, turboLora: LORAS.fl2v8, refTurboLora: LORAS.ref8 } } } };
const hasFour = (n) => /4step/.test(n);

test("9: an 8-step order on a 4-step-only PC overruns the file, named on both paths — and the Models screen is not sent for a file it does not offer", () => {
  const withRefs = L.speedUpCheck({ engine: "h3", steps: 8, refs: true }, { cfg: FOUR_ONLY, onDisk: hasFour });
  assert.deepEqual([withRefs.problem, withRefs.loads, withRefs.madeFor, withRefs.needs], ["overrun", LORAS.ref4, 4, [LORAS.ref8]]);
  assert.match(withRefs.why, new RegExp(`8 steps.*${LORAS.ref4.replace(/\./g, "\\.")}.*made for 4.*${LORAS.ref8.replace(/\./g, "\\.")}`));
  /* The real catalogue: the Models screen fetches no 8-step file. */
  assert.match(withRefs.why, /the Models screen does not offer it/);
  assert.match(withRefs.why, /render it as it is.*or leave it unaccepted and ask them to order 4 steps/);
  assert.doesNotMatch(withRefs.why, /add it before you approve/);
  const plain = L.speedUpCheck({ engine: "h3", steps: 8, refs: false }, { cfg: FOUR_ONLY, onDisk: hasFour });
  assert.deepEqual([plain.problem, plain.needs], ["overrun", [LORAS.fl2v8]]);
});

test("9: a file the Models screen DOES offer is named with its row; one already on disk is a restart", () => {
  const offered = L.speedUpCheck({ engine: "h3", steps: 8, refs: true },
    { cfg: FOUR_ONLY, onDisk: hasFour, catalogue: (n) => (n === LORAS.ref8 ? { id: "x", label: "Video references — 8-step" } : null) });
  assert.match(offered.why, /the Models screen offers it \(“Video references — 8-step”\)/);
  /* Downloaded after the Studio started: config.js pick() read the disk once. */
  const onDiskNotLoaded = L.speedUpCheck({ engine: "h3", steps: 8, refs: true }, { cfg: FOUR_ONLY, onDisk: (n) => hasFour(n) || n === LORAS.ref8 });
  assert.match(onDiskNotLoaded.why, /is on this PC but loads only after a restart: restart the Studio/);
  assert.doesNotMatch(onDiskNotLoaded.why, /not on this PC/);
});

test("9: 3 steps with reference pictures says nothing — no 3-step reference file exists, and the 4-step one is the design", () => {
  const r = L.speedUpCheck({ engine: "h3", steps: 3, refs: true }, { cfg: FOUR_ONLY, onDisk: hasFour });
  assert.deepEqual([r.problem, r.why, r.builds], [null, null, [4, 8]]);
  assert.equal(L.speedUpCheck({ engine: "h3", steps: 2, refs: true }, { cfg: FOUR_ONLY, onDisk: hasFour }).problem, null);
  /* Without TaoMate, 3 steps runs the 4-step file below its count — config.js's
   * documented fallback, and not an overrun by the Plan card's rule either. */
  assert.equal(L.speedUpCheck({ engine: "h3", steps: 3, refs: false }, { cfg: FOUR_ONLY, onDisk: hasFour }).problem, null);
});

test("9: the step counts come from the engine's own table of files, not a list typed here", async () => {
  assert.deepEqual(L.speedUpBuilds(H3_FOUR, true).steps, [4, 8]);
  assert.deepEqual(L.speedUpBuilds(H3_FOUR, false).steps, [3, 4, 8]);
  const withRef3 = { ...H3_FOUR, turboShiftByLora: { ...H3_FOUR.turboShiftByLora, "minimax_h3_ref2v_turbo_3step_v9.safetensors": {} } };
  assert.deepEqual(L.speedUpBuilds(withRef3, true).steps, [3, 4, 8], "a new file in the table is a new build, with no edit here");
  assert.doesNotMatch(await src("./order.js"), /SPEEDUP_BUILDS|\[3, 4, 8\]/);
  assert.doesNotMatch(await src("./lending.js"), /\[3, 4, 8\]|SPEEDUP_BUILDS/);
});

test("9: ONE RULE ON BOTH MACHINES — the lender is warned exactly when the borrower's take is noted, at every step count", () => {
  const mismatches = [];
  for (const cfg of [FOUR_ONLY, EIGHT]) {
    for (const refs of [true, false]) {
      for (let steps = 2; steps <= 20; steps++) {
        const lender = L.speedUpCheck({ engine: "h3", steps, refs }, { cfg, onDisk: () => true });
        const noted = O.returnNotes({ record: { steps, turboSteps: lender.madeFor } }).length > 0;
        if ((lender.problem === "overrun") !== noted) mismatches.push({ steps, refs, madeFor: lender.madeFor, lender: lender.problem, noted });
        assert.equal(lender.problem === "overrun", !!lender.madeFor && trapBand(steps, { loaded: lender.madeFor }), `${steps} ${refs}`);
      }
    }
  }
  assert.deepEqual(mismatches, []);
  /* The off-grid counts the old hand-kept list got wrong: 6 on a 4-step file
   * warned the lender and told the borrower nothing; 12 on an 8-step file
   * warned nobody. */
  assert.equal(L.speedUpCheck({ engine: "h3", steps: 6, refs: false }, { cfg: FOUR_ONLY, onDisk: () => true }).problem, "overrun");
  assert.equal(O.returnNotes({ record: { steps: 6, turboSteps: 4 } }).length, 1);
  assert.equal(L.speedUpCheck({ engine: "h3", steps: 12, refs: false }, { cfg: EIGHT, onDisk: () => true }).problem, "overrun");
  assert.match(O.returnNotes({ record: { steps: 12, turboSteps: 8 } })[0], /order 8 steps next time: Collab → Send → “Pin the exact numbers” → Steps/);
});

test("9: a matched file, LTX, and the full model at 20 steps say nothing", () => {
  assert.equal(L.speedUpCheck({ engine: "h3", steps: 4, refs: true }, { cfg: FOUR_ONLY, onDisk: hasFour }).problem, null);
  assert.equal(L.speedUpCheck({ engine: "ltx", steps: 8 }, { cfg: FOUR_ONLY, onDisk: hasFour }).why, null);
  assert.equal(L.speedUpCheck({ engine: "h3", steps: 20, refs: true }, { cfg: FOUR_ONLY, onDisk: hasFour }).loads, null);
  assert.equal(L.speedUpCheck({ engine: "h3", steps: 8, refs: true }, { cfg: EIGHT, onDisk: () => true }).problem, null);
});

test("9: a speed-up file that is not on the PC at all is named as missing, with the Models screen row that fetches it", () => {
  const r = L.speedUpCheck({ engine: "h3", steps: 4, refs: false }, { cfg: FOUR_ONLY, onDisk: () => false });
  assert.equal(r.problem, "missing");
  /* Each speed-up is its own optional row now (models.js, addonFor "video"). */
  assert.match(r.why, /not on this PC.*Download it from the Models screen \(“Video clips — 4-step speed-up for H3/);
  const eight = L.speedUpCheck({ engine: "h3", steps: 8, refs: false }, { cfg: EIGHT, onDisk: () => false });
  assert.match(eight.why, /Download it from the Models screen \(“Video clips — 8-step speed-up for H3/);
  /* The ref2v 8-step file is still one the Models screen does not offer. */
  const unoffered = L.speedUpCheck({ engine: "h3", steps: 8, refs: true }, { cfg: EIGHT, onDisk: () => false });
  assert.match(unoffered.why, /The Models screen does not offer it, so leave this order unaccepted/);
});

test("9: the errand's own engine decides the path — a cast scene rides the reference path", () => {
  const r = L.speedUpForOrder(order({ engineMode: "hybrid", refs: true, steps: 8 }), { cfg: FOUR_ONLY, onDisk: hasFour });
  assert.deepEqual([r.engine, r.refs, r.loads], ["h3", true, LORAS.ref4]);
  const ltx = L.speedUpForOrder(order({ engineMode: "hybrid", refs: false, steps: 8 }), { cfg: FOUR_ONLY, onDisk: hasFour });
  assert.deepEqual([ltx.engine, ltx.problem], ["ltx", null]);
});

test("9: the borrower's note comes from two numbers on the return, and nothing else", () => {
  const made = O.makeReturn({ orderId: "o_" + "2".repeat(12), segmentId: "s1_0", result: { bytes: Buffer.from("x") },
    record: { model: "h3", outputRights: { class: "x" }, steps: 8, seed: 7, turboSteps: 4 }, now: 1 });
  assert.equal(made.record.turboSteps, 4);
  const read = (t) => O.readReturn({ ...made, record: { ...made.record, turboSteps: t } }).doc.record.turboSteps;
  assert.deepEqual([read(4), read(99), read("4; rm -rf /"), read(-1), read(null)], [4, null, null, null, null]);
  assert.match(O.returnNotes({ record: { steps: 8, turboSteps: 4 } })[0], /8 steps on your friend's PC with a speed-up file made for 4 steps/);
  assert.deepEqual(O.returnNotes({ record: { steps: 8, turboSteps: 8 } }), []);
  assert.deepEqual(O.returnNotes({ record: { steps: 8, turboSteps: null } }), [], "no speed-up file is not a zero-step one");
  assert.deepEqual(O.returnNotes({ record: { steps: 20, turboSteps: null } }), []);
  assert.deepEqual(O.returnNotes({ record: { steps: 3, turboSteps: 4 } }), [], "3 steps with references on the 4-step file is its design, not an overrun");
});

/* ───────────────────────────────────────────── 8 — minutes a day */

const DAY = new Date(2026, 8, 24, 15, 0, 0).getTime();
const errandFor = (o, takes = []) => {
  const d = L.provisionalErrand(o);
  d.clips[0].takes = takes;
  return d;
};

test("8: zero minutes refuses, walkably, and says what this scene would cost", async () => {
  const r = await L.budgetCheck({ peer: { fp: FP, nickname: "bucky", lendMinutesPerDay: 0 }, orderDoc: order(), rows: [], readProject: async () => null, now: DAY });
  assert.deepEqual([r.over, r.reason], [true, "budget-zero"]);
  assert.match(r.why, /0 minutes of your card a day.*about \d/);
});

test("8: what was timed today and what was promised both count; yesterday and other friends do not", async () => {
  const today = DAY - 3600_000, yesterday = DAY - 26 * 3600_000;
  const docs = {
    timed: errandFor(order(), [{ clip: "a.mp4", at: today, ms: 70 * 60_000, runMs: 50 * 60_000 }]),
    old: errandFor(order(), [{ clip: "b.mp4", at: yesterday, ms: 500 * 60_000, runMs: 500 * 60_000 }]),
    pending: errandFor(order()),
    abandoned: errandFor(order()),
    theirs: errandFor(order(), [{ clip: "c.mp4", at: today, ms: 900 * 60_000, runMs: 900 * 60_000 }]),
  };
  const rows = [
    { id: "o_" + "a".repeat(12), from: { fp: FP }, slug: "timed", state: "rendered" },
    { id: "o_" + "b".repeat(12), from: { fp: FP }, slug: "old", state: "rendered" },
    { id: "o_" + "c".repeat(12), from: { fp: FP }, slug: "pending", state: "landed", landedAt: today },
    /* Accepted two days ago and never approved: not a promise about today. */
    { id: "o_" + "9".repeat(12), from: { fp: FP }, slug: "abandoned", state: "landed", landedAt: yesterday - 24 * 3600_000 },
    { id: "o_" + "d".repeat(12), from: { fp: "cd".repeat(16) }, slug: "theirs", state: "rendered" },
    { id: "o_" + "e".repeat(12), from: { fp: FP }, slug: null, state: "claimed" },
  ];
  const readProject = async (slug) => docs[slug] ?? null;
  const used = await L.lentToday({ rows, readProject, fp: FP, now: DAY });
  const oneScene = L.estimateErrand(errandFor(order())).minutes;
  assert.deepEqual([used.measuredMinutes, used.rendered, used.withWait, used.pending, used.pendingMinutes], [50, 1, 0, 1, oneScene],
    "the render alone (runMs), not the 20 minutes it waited in the queue");
  /* 50 timed + one pending scene + this one, each priced by the plan's table. */
  const allowance = Math.floor(50 + 2 * oneScene) - 1;
  const peer = { fp: FP, nickname: "bucky", lendMinutesPerDay: allowance };
  const r = await L.budgetCheck({ peer, orderDoc: order(), rows, readProject, now: DAY });
  assert.deepEqual([r.over, r.reason, r.total], [true, "budget-spent", Math.round((50 + 2 * oneScene) * 10) / 10]);
  assert.match(r.why, new RegExp(`${allowance} minutes of your card a day: 50 min timed on this card today, 1 scene accepted today still to render`));
  assert.match(r.why, /— about [\d.]+ min in all\.$/);
  const roomy = await L.budgetCheck({ peer: { ...peer, lendMinutesPerDay: 120 }, orderDoc: order(), rows, readProject, now: DAY });
  assert.deepEqual([roomy.over, roomy.reason], [false, null]);
});

test("8: a take timed before runMs existed still counts, and the sentence says it includes waiting", async () => {
  const rows = [{ id: "o_" + "a".repeat(12), from: { fp: FP }, slug: "timed", state: "rendered" }];
  const docs = { timed: errandFor(order(), [{ clip: "a.mp4", at: DAY - 1000, ms: 30 * 60_000 }]) };
  const used = await L.lentToday({ rows, readProject: async (s) => docs[s], fp: FP, now: DAY });
  assert.deepEqual([used.measuredMinutes, used.withWait], [30, 1]);
  assert.match(L.usedSentence(used), /30 min timed on this card today \(one render was timed from request to finish, so that includes waiting in the queue\)/);
});

test("8: the render's own clock is what generate.js writes on a take", async () => {
  const gen = await src("../mv/generate.js");
  assert.match(gen, /const \{ clip, seconds: ranSeconds(?:, meta: \w+)? \} = await awaitArt\(art, file, \["clip"\]/);
  assert.match(gen, /row\.takes\.push\(\{ clip, seed: usedSeed, at: Date\.now\(\), ms: clipMs, runMs,/);
  const art = await src("../art.js");
  assert.match(art, /this\.emit\("clip", \{\s*file: job\.file, clip,\s*seconds: Math\.round\(\(Date\.now\(\) - this\.startedAt\) \/ 1000\)/,
    "the event's seconds run from when the job STARTED, not when it was queued");
});

test("8: a cast-less scene on LTX is priced, not waved through as 0 minutes", async () => {
  const ltxOrder = order({ engineMode: "hybrid", refs: false, steps: 8 });
  assert.equal(L.resolveErrand(ltxOrder).engine, "ltx");
  const e = L.estimateErrand(L.resolveErrand(ltxOrder).doc);
  assert.ok(e && e.minutes > 0, JSON.stringify(e));
  /* The step count is the order's, and LTX's graph reads none: its rows are "bare". */
  const t = tableMinutes({ engine: "ltx", steps: 8, width: 1344, height: 768, seconds: 5, pass: "two" });
  assert.deepEqual([t?.stepClass, t?.floor, t?.minutes > 0], ["bare", null, true]);
  const r = await L.budgetCheck({ peer: { fp: FP, nickname: "bucky", lendMinutesPerDay: 60 }, orderDoc: ltxOrder, rows: [], readProject: async () => null, now: DAY });
  assert.match(r.why, /this scene is about [\d.]+ min more/);
  assert.doesNotMatch(r.why, /about 0 min in all|could not be estimated/);
  assert.equal(r.thisOne, e.minutes);
});

test("8: a scene with no estimate makes the total “at least”, never “about”", async () => {
  /* A pending errand whose document no longer carries its order: unpriced. */
  const rows = [{ id: "o_" + "c".repeat(12), from: { fp: FP }, slug: "odd", state: "landed", landedAt: DAY - 1000 }];
  const readProject = async () => ({ slug: "odd", clips: [{ segmentId: "s1_0", takes: [] }] });
  const r = await L.budgetCheck({ peer: { fp: FP, nickname: "bucky", lendMinutesPerDay: 60 }, orderDoc: order(), rows, readProject, now: DAY });
  assert.deepEqual([r.used.unpriced, r.unknown], [1, true]);
  assert.match(r.why, /1 scene accepted today still to render \(at least 0 min; 1 with no estimate\)/);
  assert.match(r.why, /— at least [\d.]+ min in all\.$/);
});

test("8: the order being accepted is never counted twice", async () => {
  const o = order({ id: "o_" + "f".repeat(12) });
  const rows = [{ id: o.id, from: { fp: FP }, slug: "self", state: "landed", landedAt: DAY - 1000 }];
  const used = await L.lentToday({ rows, readProject: async () => errandFor(o), fp: FP, now: DAY, except: o.id });
  assert.equal(used.pending, 0);
});

test("8: the estimate is the plan's own, so the number on the card is the number the Plan card shows", async () => {
  assert.match(await src("./lending.js"), /import \{ estimateOne \} from "\.\.\/mv\/plan\.js";/);
  assert.equal(typeof L.estimateErrand(errandFor(order())).minutes, "number");
});

/* ───────────────────────────────────────────── D — screen names */

test("D: the server's screen name is the rail's own label, so a relabel of the rail fails here first", async () => {
  const html = await src("../../web/index.html");
  const rail = /<a href="#" data-view="workflow"[^>]*>[\s\S]*?<span class="lbl">([^<]+)<\/span>/.exec(html)?.[1];
  assert.equal(L.WORKFLOW_SCREEN, rail, "server/collab/lending.js WORKFLOW_SCREEN must equal the rail label of data-view=\"workflow\"");
  assert.equal(L.planPlace("Order o_1 from bucky"), `${rail} → “Order o_1 from bucky” → the Plan card`);
  assert.equal(L.pickPlace(), `${rail} → Video clips → Inspect…`);
  /* The page's static hints are filled from the rail too. */
  assert.match(html, /<b data-screen="workflow">/);
  /* ...and so are the words that send someone there from elsewhere: h3tier's
   * "ask a friend" sentence (the H3 rows on Models), the Settings card's
   * friend step, the README and the lending docs (release critic: they still
   * said Workflow after the rail was renamed). */
  const { H3_MV_SCREEN, H3_ASK_A_FRIEND } = await import("../h3tier.js");
  const { NO_STRONG_CARD, LENDER_ROLE_LABEL } = await import("../cloud-switch.js");
  assert.equal(H3_MV_SCREEN, rail, "server/h3tier.js H3_MV_SCREEN must equal the rail label too");
  assert.ok(H3_ASK_A_FRIEND.includes(`on a scene in ${rail}`));
  assert.ok(NO_STRONG_CARD[0].how.includes(`${rail} → Video clips`));
  for (const doc of ["../../README.md", "../../docs/FRIEND_RENDERING.md", "../../docs/COLLAB.md", "../../docs/DEEP_DIVE.md"]) {
    const text = await src(doc);
    assert.doesNotMatch(text, /Workflow → Video clips|\*\*Workflow\*\* → \*\*Video clips\*\*|Open its plan in Workflow|Plan card in Workflow/,
      `${doc} still names the old Workflow screen`);
  }
  /* The role the Settings card tells people to give, word for word as the
   * Friends row offers it (web/app.js's role select). */
  const app = await src("../../web/app.js");
  assert.ok(app.includes(`["lender", "${LENDER_ROLE_LABEL}"]`), "the Friends row offers the role the Settings card names");
  assert.ok(NO_STRONG_CARD[0].limits.includes(`"${LENDER_ROLE_LABEL}"`));
  assert.doesNotMatch(NO_STRONG_CARD[0].limits, /may render single scenes for me|filing onto its scene by hand/);
});
