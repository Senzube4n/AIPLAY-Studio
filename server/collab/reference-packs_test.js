/** Named views survive Collab's real packet/order/seal/stage/errand path. No server or GPU. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { shotPacket, projectBundle } from "./packet.js";
import { makeOrder, readOrder } from "./order.js";
import { errandDoc, stageOrderFiles } from "./errand.js";
import { identity, privateKeys } from "./identity.js";
import { sealTo, openSealed } from "./seal.js";
import { previewManifest } from "./preview.js";
import { resolveShot } from "../mv/shot.js";
import { projectRowFingerprint } from "../safety/lineage.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const FP = "a".repeat(32);
const now = Date.now();
const document = () => ({
  slug: "views", title: "Pack round trip", styleBible: "Ink illustration", brief: { videoEngine: "h3", videoSteps: 8, quality: "medium" },
  characters: [{ id: "c1", name: "Mara", imageFile: "face.png", referenceImages: [
    { role: "body", file: "body.png" }, { role: "side", file: "side.png" },
  ] }, { id: "c2", name: "Ari", imageFile: "ari.png" }], backgrounds: [], props: [], clips: [],
  segments: [{ id: "s1", index: 0, durationSec: 4, startSec: 0, endSec: 4, mode: "generate", kind: "broll" }],
  boards: [{ segmentId: "s1", segmentIndex: 0, shots: [{ action: "Mara and Ari walk forward." }],
    characterRefs: ["Mara", "Ari"], backgroundRefs: [], propRefs: [],
    refProminence: { Mara: 1, Ari: .5 }, refRoles: { Mara: ["identity", "body", "side"] } }],
});
async function fixture(run) {
  const tempEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  // The environment can spell a Windows directory with forward slashes.
  // Guard cleanup with its physical parent, while preserving both raw env values.
  const tempDir = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tempDir, "aiplay-pack-courier-"));
  const assets = path.join(root, "assets");
  try {
    await mkdir(assets);
    // Identical source bytes under two roles deliberately exercise renaming collisions.
    for (const file of ["face.png", "body.png", "side.png", "ari.png"]) await writeFile(path.join(assets, file), PNG);
    await run({ root, assets, doc: document() });
  } finally {
    assert.equal(await realpath(path.dirname(root)), tempDir);
    assert.ok(path.basename(root).startsWith("aiplay-pack-courier-"));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual({ TEMP: process.env.TEMP, TMP: process.env.TMP }, tempEnv);
  }
}
async function orderFor(shot, assets, { reverseFiles = false } = {}) {
  const fileNames = [...new Set([...shot.refs, ...(shot.guides || [])].map((r) => r.file))];
  if (reverseFiles) fileNames.reverse();
  const files = await Promise.all(fileNames.map(async (file) => ({ file, b64: (await readFile(path.join(assets, file))).toString("base64") })));
  return makeOrder({ shot, files, order: { segmentId: shot.segmentId, seed: 7, steps: 8, engineMode: "h3" }, returnTo: { fp: FP }, now });
}
async function sealedRoundTrip(value, root) {
  const senderHome = path.join(root, "sender"), receiverHome = path.join(root, "receiver");
  const sender = await identity({ appData: senderHome }), receiver = await identity({ appData: receiverHome });
  const senderKeys = await privateKeys({ appData: senderHome }), receiverKeys = await privateKeys({ appData: receiverHome });
  const blob = sealTo({ payload: Buffer.from(JSON.stringify(value)), toSealPublicB64: receiver.sealPublic,
    toSignPublicB64: receiver.signPublic, toFp: receiver.fp, fromFp: sender.fp, signPrivate: senderKeys.signPrivate });
  return JSON.parse(openSealed({ blob, me: receiver.fp, sealPrivate: receiverKeys.sealPrivate, senderSignPublicB64: sender.signPublic }).payload.toString("utf8"));
}

test("selected pack files match local Picture order and survive a sealed order/remapped errand", async () => fixture(async ({ root, assets, doc }) => {
  doc.characters[0].takes = [{ file: "body.png", safety: { minor: true, sexual: false } }];
  const shot = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  const local = resolveShot(doc, "s1");
  assert.deepEqual(shot.refs.map((r) => r.file), local.refs.map((r) => r.file));
  assert.equal(shot.prompt, local.prompt);
  assert.equal(new Set(shot.refs.map((r) => r.name)).size, 4, "older readers need distinct wire names for each image");
  const shipped = await sealedRoundTrip(await orderFor(shot, assets), root);
  const accepted = readOrder(shipped, { now });
  const staged = await stageOrderFiles({ orderDoc: accepted, assetsDir: path.join(root, "received") });
  assert.notEqual(staged[0].name, staged[1].name, "identical bytes with different roles must retain separate slots");
  assert.ok(staged.every((r) => /^peer_[0-9a-f]{12}(?:_(body|side))?\.png$/.test(r.name)));
  const imported = errandDoc({ orderDoc: accepted, from: { fp: FP }, staged, now });
  assert.equal(imported.characters.length, 2);
  assert.deepEqual(imported.boards[0].characterRefs, ["Mara", "Ari"]);
  assert.deepEqual(imported.boards[0].refRoles.Mara, ["identity", "body", "side"]);
  const resolved = resolveShot(imported, "s1_0");
  assert.equal(resolved.prompt, shot.prompt);
  assert.deepEqual(resolved.refs.map((r) => r.file), staged.map((r) => r.name));
  assert.deepEqual(resolved.refs.map((r) => r.role), ["identity", "body", "side", "identity"]);
  const body = imported.characters[0].referenceImages.find((r) => r.role === "body").file;
  assert.equal(projectRowFingerprint(imported.characters[0], body).minor, true);
  assert.equal(projectRowFingerprint(imported.characters[0], imported.characters[0].imageFile).minor, false);
  for (const ref of resolved.refs) assert.deepEqual(await readFile(path.join(root, "received", ref.file)), PNG);
}));

test("whole-project manifests discover pack-only files and retain roles through sealing", async () => fixture(async ({ root, assets, doc }) => {
  const bundle = await projectBundle({ doc, assetsDir: assets });
  assert.deepEqual(bundle.assets.map((r) => r.name), ["ari.png", "body.png", "face.png", "side.png"]);
  assert.equal(previewManifest(bundle).length, 4);
  assert.ok(previewManifest(bundle).every((r) => !r.included), "project packets are document/manifest metadata");
  const opened = await sealedRoundTrip(bundle, root);
  assert.deepEqual(opened.doc.characters[0].referenceImages, doc.characters[0].referenceImages);
  assert.deepEqual(opened.doc.boards[0].refRoles, doc.boards[0].refRoles);
  assert.deepEqual(opened.assets, bundle.assets);
}));

test("friend orders refuse repeated source filenames on both new and legacy wire metadata", async () => fixture(async ({ root, assets, doc }) => {
  const original = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  const valid = await orderFor(original, assets);
  doc.characters[1].imageFile = "body.png";
  const shared = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  const refusal = (err) => err.reason === "bad-shot" && /separate source filename/.test(err.message);
  for (const shot of [shared, { ...shared, refs: shared.refs.map(({ assetName, referenceRole, ...r }) => r) }]) {
    await assert.rejects(() => orderFor(shot, assets), refusal);
  }
  const malformed = { ...valid, shot: shared,
    files: valid.files.filter((f) => shared.refs.some((r) => r.file === f.file)) };
  const oldStaged = malformed.files.map((f) => ({ ...f, name: `peer_${f.sha256.slice(0, 12)}.png` }));
  assert.equal(baseline1488d969Mapping(shared, oldStaged).characterRefs.length, 3,
    "the actual baseline mapping loses one of the four shared-file Picture slots");
  const signed = await sealedRoundTrip(malformed, root);
  assert.throws(() => readOrder(signed, { now }), refusal, "an ambiguous signed order is refused before staging");
}));

// Frozen mapping from server/collab/errand.js at
// 1488d969a2d97fd4b9d868a4794d8c74d2e9e0fe. Keep this independent of Git/HEAD:
// baseline v1 joins each staged attachment to the FIRST wire ref with that file,
// then creates one ordinary character per attachment in attachment order.
function baseline1488d969Mapping(shot, staged) {
  const refNames = new Map();
  for (const s of staged) {
    const row = (shot.refs || []).find((r) => r.file === s.file);
    refNames.set(s.file, row?.name || s.name);
  }
  const refs = staged.filter((s) => s.role === "ref");
  return {
    characterRefs: refs.map((s) => refNames.get(s.file)),
    characters: refs.map((s, i) => ({
      id: `c_${i}_${String(s.sha256).slice(0, 6)}`,
      name: refNames.get(s.file),
      role: "lead",
      description: "",
      imageFile: s.name,
    })),
  };
}

test("baseline 1488d969 receiver preserves supported unique-file packs after reversed attachment input", async () => fixture(async ({ assets, doc }) => {
  const shot = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  const outgoing = await orderFor(shot, assets, { reverseFiles: true });
  assert.deepEqual(outgoing.files.map((f) => f.file), shot.refs.map((r) => r.file), "the maker canonicalizes files to the frozen Picture order");
  // The baseline stager names this PNG fixture by digest alone, without a role suffix.
  const staged = outgoing.files.map((f) => ({ ...f, name: `peer_${f.sha256.slice(0, 12)}.png` }));
  const old = baseline1488d969Mapping(outgoing.shot, staged);
  assert.equal(new Set(old.characters.map((r) => r.id)).size, 4, "equal image digests still create unique baseline character IDs");
  const legacyDoc = { ...doc, characters: old.characters,
    boards: [{ ...doc.boards[0], characterRefs: old.characterRefs, refRoles: undefined, refProminence: {} }],
    clips: [{ segmentId: "s1", promptOverride: outgoing.shot.prompt }] };
  const resolved = resolveShot(legacyDoc, "s1");
  assert.deepEqual(resolved.refs.map((r) => r.name), outgoing.shot.refs.map((r) => r.name));
  assert.deepEqual(resolved.refs.map((r) => r.file), staged.map((r) => r.name));
  assert.equal(resolved.prompt, outgoing.shot.prompt);
}));

test("persisted repeated names produce one pack in local resolution and a lendable packet", async () => fixture(async ({ assets, doc }) => {
  doc.boards[0].characterRefs = ["Mara", "Mara", "Ari"];
  doc.boards[0].propRefs = ["Mara"];
  const shot = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  assert.deepEqual(shot.refs.map((r) => r.file), resolveShot(doc, "s1").refs.map((r) => r.file));
  assert.deepEqual(shot.refs.map((r) => r.assetName), ["Mara", "Mara", "Mara", "Ari"]);
  assert.equal((await orderFor(shot, assets)).files.length, 4);
}));

test("signed v1 orders without pack metadata remain accepted with the same Picture order", async () => fixture(async ({ root, assets, doc }) => {
  const packed = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  const oldReaderShot = { ...packed, refs: packed.refs.map(({ assetName, referenceRole, ...r }) => r) };
  const oldSenderOrder = await orderFor(oldReaderShot, assets);
  oldSenderOrder.files.reverse(); // An older signed sender may attach in a different order.
  const accepted = readOrder(await sealedRoundTrip(oldSenderOrder, root), { now });
  assert.deepEqual(accepted.files.map((f) => f.file), packed.refs.map((r) => r.file));
  const staged = await stageOrderFiles({ orderDoc: accepted, assetsDir: path.join(root, "legacy") });
  const imported = errandDoc({ orderDoc: accepted, from: { fp: FP }, staged, now });
  assert.equal(imported.characters.length, 4);
  assert.equal(imported.boards[0].refRoles, undefined);
  assert.equal(resolveShot(imported, "s1_0").prompt, packed.prompt);
  assert.deepEqual(resolveShot(imported, "s1_0").refs.map((r) => r.file), staged.map((r) => r.name));
}));

test("unknown, duplicate, interleaved and reversed role metadata is refused before importing", async () => fixture(async ({ assets, doc }) => {
  const shot = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  for (const refs of [
    shot.refs.map((r, i) => i === 1 ? { ...r, referenceRole: "typo" } : r),
    shot.refs.map((r, i) => i === 1 ? { ...r, referenceRole: "identity" } : r),
    [shot.refs[1], shot.refs[0], ...shot.refs.slice(2)],
    [shot.refs[0], shot.refs[3], shot.refs[1], shot.refs[2]],
  ]) {
    await assert.rejects(() => orderFor({ ...shot, refs }, assets), (err) => err.reason === "bad-shot");
  }
}));

test("selecting one view ships only it; a missing selected role cannot become a partial lend", async () => fixture(async ({ assets, doc }) => {
  doc.boards[0].characterRefs = ["Mara"];
  doc.boards[0].refRoles = { Mara: ["side"] };
  const shot = await shotPacket({ doc, segmentId: "s1", assetsDir: assets });
  assert.deepEqual(shot.refs.map((r) => r.file), ["side.png"]);
  assert.equal(shot.refs[0].assetName, "Mara");
  doc.characters[0].referenceImages = [{ role: "body", file: "body.png" }];
  await assert.rejects(() => shotPacket({ doc, segmentId: "s1", assetsDir: assets }), (err) => err.reason === "no-refs");
}));
