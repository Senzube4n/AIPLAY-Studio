/** Reference packs: real persisted API edits plus the renderer's pure resolution. No GPU. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import vm from "node:vm";
import { config } from "../config.js";
import { createProject, updateProject, readProject, assetsDir, cascadeRename } from "./store.js";
import { createMvRoutes } from "./routes.js";
import { commitBible, upsertBoard } from "./bible.js";
import { resolveShot, shotDrift, applyShotEdit } from "./shot.js";
import { projectRowFingerprint } from "../safety/lineage.js";
import { assetReferenceImages, readReferenceImages, readRefRoles, REFERENCE_ROLES } from "./references.js";
import { mvTools } from "../mcp-mv.js";
import { castFlags, pickTake } from "./generate.js";

const fixture = () => ({
  brief: { videoEngine: "h3" },
  characters: [{ id: "c1", name: "Mara", imageFile: "face.png", referenceImages: [
    { role: "body", file: "body.png" }, { role: "side", file: "side.png" },
  ] }], backgrounds: [], props: [], clips: [], styleBible: "Ink on paper",
  segments: [{ id: "s1", index: 0, durationSec: 4, startSec: 0, endSec: 4, kind: "lyrical", mode: "generate", lyricText: "hello" }],
  boards: [{ id: "bd1", segmentId: "s1", segmentIndex: 0, characterRefs: ["Mara"], backgroundRefs: [], propRefs: [], refProminence: { Mara: 1 } }],
});

test("legacy identity remains live and packs select roles without inventing cast names", () => {
  const doc = fixture();
  assert.deepEqual(resolveShot(doc, "s1").refs.map((r) => r.file), ["face.png"]);
  doc.characters[0].imageFile = "face2.png";
  assert.equal(resolveShot(doc, "s1").refs[0].file, "face2.png");
  doc.boards[0].refRoles = { Mara: ["side", "body", "identity"] };
  const shot = resolveShot(doc, "s1");
  assert.deepEqual(shot.refs.map((r) => [r.name, r.role, r.file]), [
    ["Mara", "identity", "face2.png"], ["Mara", "body", "body.png"], ["Mara", "side", "side.png"],
  ]);
  assert.equal(shot.castRefs, 1);
  assert.match(shot.prompt, /<Picture 2> is Mara \(body reference\)/);
  assert.match(shot.prompt, /<Picture 3> is Mara \(side reference\)/);
  doc.brief.videoEngine = "ltx";
  assert.equal(resolveShot(doc, "s1").refsSent, false);
  assert.doesNotMatch(resolveShot(doc, "s1").prompt, /<Picture/);
  doc.characters[0].referenceImages = [{ role: "body", file: "body.png" }];
  doc.brief.videoEngine = "h3";
  assert.equal(resolveShot(doc, "s1").refsMissing[0].role, "side");
});

test("repeated names in persisted scene lists resolve once and shot edits persist unique names", () => {
  const doc = fixture();
  doc.boards[0].characterRefs = ["Mara", "Mara"];
  doc.boards[0].propRefs = ["Mara"];
  doc.boards[0].refRoles = { Mara: ["identity", "body"] };
  assert.deepEqual(resolveShot(doc, "s1").refs.map((r) => r.role), ["identity", "body"]);
  applyShotEdit(doc, "s1", { refs: ["Mara", " Mara ", "Mara"] });
  assert.deepEqual(doc.boards[0].characterRefs, ["Mara"]);
  assert.deepEqual(doc.boards[0].propRefs, []);
});

test("global reference cap drops low prominence images and role drift compares the right view", () => {
  const doc = fixture();
  doc.characters = Array.from({ length: 4 }, (_, i) => ({ ...doc.characters[0], name: `M${i}` }));
  doc.boards[0].characterRefs = doc.characters.map((c) => c.name);
  doc.boards[0].refProminence = { M0: 1, M1: .8, M2: .6, M3: .4 };
  doc.boards[0].refRoles = Object.fromEntries(doc.characters.map((c) => [c.name, ["identity", "body", "side"]]));
  const shot = resolveShot(doc, "s1");
  assert.equal(shot.refs.length, 9);
  assert.equal(shot.dropped.length, 3);
  assert.ok(shot.dropped.every((r) => r.name === "M3"));
  const current = { evidence: true, prompt: shot.prompt, engine: shot.engine, refs: shot.refs.map((r) => ({ ...r })) };
  assert.equal(shotDrift(shot, current).any, false);
  doc.characters[1].referenceImages = [{ role: "body", file: "newbody.png" }, { role: "side", file: "side.png" }];
  const drift = shotDrift(resolveShot(doc, "s1"), current);
  assert.deepEqual(drift.refsRepointed, [{ name: "M1 (body reference)", was: "body.png", now: "newbody.png" }]);
  assert.equal(drift.refsAdded.length, 0);
});

test("malformed pack files, duplicate roles and unavailable scene roles fail explicitly", () => {
  for (const file of ["../face.png", "C:\\face.png", "mesh.glb", "face\u0000.png"]) {
    assert.throws(() => readReferenceImages([{ file, role: "identity" }]));
  }
  assert.throws(() => readReferenceImages([{ file: "a.png", role: "body" }, { file: "b.png", role: "body" }]));
  assert.throws(() => readReferenceImages(Array.from({ length: 7 }, (_, i) => ({ file: `${i}.png`, role: "body" }))));
  assert.throws(() => readRefRoles({ Mara: ["outfit"] }, fixture(), ["Mara"]), /no outfit/);
  assert.throws(() => readRefRoles({ Ghost: ["identity"] }, fixture(), ["Mara"]), /not referenced/);
  assert.throws(() => readRefRoles({ Mara: [] }, fixture(), ["Mara"]));
});

test("imports edit one asset; roles survive scene, bible, rename, and disk round trips", async () => {
  const tempEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  // Windows os.tmpdir() keeps environment separators, while path.join() uses
  // backslashes. Compare physical directories without weakening the delete guard.
  const tempDir = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(tempDir, "aiplay-character-packs-"));
  const previous = { outputDir: config.outputDir, inputDir: config.inputDir };
  config.outputDir = root; config.inputDir = path.join(root, "input");
  try {
    await mkdir(config.inputDir);
    const doc = await createProject("Character reference packs");
    await updateProject(doc.slug, (d) => Object.assign(d, fixture()));
    await updateProject(doc.slug, (d) => {
      d.boards[0].imageFile = "oldboard.png";
      d.clips = [{ id: "clip1", segmentId: "s1", clipFile: "take.mp4" }];
      return d;
    });
    await writeFile(path.join(assetsDir(doc.slug), "face.png"), Buffer.from("fixture"));
    await writeFile(path.join(assetsDir(doc.slug), "body.png"), Buffer.from("fixture"));
    await writeFile(path.join(assetsDir(doc.slug), "side.png"), Buffer.from("fixture"));
    await writeFile(path.join(config.inputDir, "uploaded.png"), Buffer.from("different fixture"));
    const routes = createMvRoutes({ readBody: async (req) => req.body,
      json: (res, status, body) => { res.status = status; res.body = body; },
      library: { meta: new Map() }, art: {}, ltxReady: () => true });
    const call = async (body, handler = routes) => {
      const res = {};
      await handler.handle("/api/mv", { method: "POST", body: { slug: doc.slug, ...body } }, res, new URL("http://localhost/api/mv"));
      return res;
    };
    const imported = await call({ action: "import_asset", kind: "characters", id: "c1", path: "frame:uploaded.png", referenceRole: "outfit" });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.project.characters.length, 1);
    assert.equal(imported.body.project.characters[0].imageFile, "face.png");
    assert.equal(imported.body.project.boards[0].staleRefs, true);
    assert.equal(imported.body.project.clips[0].status, "stale");
    assert.ok(assetReferenceImages(imported.body.project.characters[0]).some((r) => r.role === "outfit"));
    const edited = await call({ action: "set_shot", segmentId: "s1", refRoles: { Mara: ["identity", "outfit"] } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(edited.body.shot.refs.map((r) => r.role), ["identity", "outfit"]);
    assert.equal((await call({ action: "import_asset", kind: "characters", id: "c1", path: "frame:uploaded.png", referenceRole: "typo" })).status, 400);
    assert.equal((await call({ action: "import_asset", kind: "characters", id: "c1", path: "frame:../uploaded.png" })).status, 400);
    assert.equal((await call({ action: "update_asset", kind: "characters", id: "c1", referenceImages: [{ role: "identity", file: "missing.png" }] })).status, 400);
    let persisted = await readProject(doc.slug);
    assert.equal(persisted.characters[0].referenceImages.length, 3);
    await upsertBoard(doc.slug, "s1", { characterRefs: ["Mara", " Mara "], backgroundRefs: ["Mara"], propRefs: [], shots: [] });
    const uniqueBoard = (await readProject(doc.slug)).boards[0];
    assert.deepEqual(uniqueBoard.characterRefs, ["Mara"]);
    assert.deepEqual(uniqueBoard.backgroundRefs, []);
    assert.deepEqual(uniqueBoard.refRoles, { Mara: ["identity", "outfit"] });
    await upsertBoard(doc.slug, "s1", { ...persisted.boards[0], refRoles: { Mara: ["side"] } });
    persisted = await readProject(doc.slug);
    await commitBible(doc.slug, { characters: [{ name: "Mara", description: "updated look" }],
      boards: persisted.boards.map((b) => ({ ...b, characterRefs: ["Mara", "Mara"], propRefs: ["Mara"] })) });
    persisted = await readProject(doc.slug);
    assert.deepEqual(persisted.boards[0].characterRefs, ["Mara"]);
    assert.deepEqual(persisted.boards[0].propRefs, []);
    assert.deepEqual(persisted.boards[0].refRoles, { Mara: ["side"] });
    assert.equal(persisted.characters[0].referenceImages.length, 3);
    await commitBible(doc.slug, { boards: persisted.boards.map(({ refRoles, ...b }) => b) });
    assert.deepEqual((await readProject(doc.slug)).boards[0].refRoles, { Mara: ["side"] });
    await updateProject(doc.slug, (d) => { cascadeRename(d, d.characters[0], "Mara North"); return d; });
    persisted = await readProject(doc.slug);
    assert.deepEqual(persisted.boards[0].refRoles, { "Mara North": ["side"] });
    assert.equal(resolveShot(persisted, "s1").refs[0].role, "side");
    await writeFile(path.join(assetsDir(doc.slug), "face2.png"), Buffer.from("new face"));
    const identity = await call({ action: "update_asset", kind: "characters", id: "c1",
      referenceImages: [...persisted.characters[0].referenceImages, { role: "identity", file: "face2.png" }] });
    assert.equal(identity.status, 200, JSON.stringify(identity.body));
    assert.equal(identity.body.project.characters[0].imageFile, "face2.png");
    await updateProject(doc.slug, (d) => {
      const row = d.characters[0];
      row.takes.push({ file: "body.png" });
      return d;
    });
    await pickTake(doc.slug, { target: "character", id: "c1", file: "body.png" });
    assert.equal(assetReferenceImages((await readProject(doc.slug)).characters[0])[0].file, "body.png");

    const shelf = path.join(root, "images"), lookups = [];
    await mkdir(shelf);
    for (const file of ["private-child.png", "worded-child.png"]) await writeFile(path.join(shelf, file), Buffer.from(file));
    const importRoutes = createMvRoutes({ readBody: async (req) => req.body,
      json: (res, status, body) => { res.status = status; res.body = body; },
      library: { meta: new Map() }, art: {}, ltxReady: () => true, IMAGE_DIR: shelf, COVER_DIR: shelf,
      lineage: (files) => { lookups.push(files); return files[0] === "private-child.png"
        ? { texts: [], flags: [{ minor: true, sexual: false }] }
        : { texts: ["A 12 year old child posing."], flags: [] }; } });
    await updateProject(doc.slug, (d) => {
      d.characters.unshift({ id: "collision", name: "c1", imageFile: null, takes: [] });
      return d;
    });
    const flagged = await call({ action: "import_asset", kind: "characters", id: "c1",
      path: "image:private-child.png", referenceRole: "side" }, importRoutes);
    assert.equal(flagged.status, 200, JSON.stringify(flagged.body));
    const selected = flagged.body.project.characters.find((c) => c.id === "c1");
    const copied = assetReferenceImages(selected).find((r) => r.role === "side").file;
    assert.equal(projectRowFingerprint(selected, copied).minor, true, "copied Library flags travel in friend packets");
    assert.equal(castFlags(flagged.body.project, [selected.name], { board: { refRoles: { [selected.name]: ["side"] } } })[0].minor, true);
    assert.equal(flagged.body.project.characters.find((c) => c.id === "collision").imageFile, null, "an exact ID beats another row's matching name");
    const updated = await call({ action: "update_asset", kind: "characters", id: "c1", description: "Updated appearance" });
    assert.equal(updated.body.project.characters.find((c) => c.id === "c1").description, "Updated appearance");
    assert.equal(updated.body.project.characters.find((c) => c.id === "collision").description, undefined);
    const created = await call({ action: "import_asset", kind: "characters", name: "collision",
      path: "cover:worded-child.png" }, importRoutes);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const named = created.body.project.characters.find((c) => c.name === "collision");
    assert.notEqual(named.id, "collision", "name-only import creates the named asset rather than selecting somebody else's ID");
    assert.equal(projectRowFingerprint(named).minor, true, "stored ancestor words also become the imported take's fingerprint");
    assert.deepEqual(lookups, [["private-child.png"], ["worded-child.png"]]);
  } finally {
    Object.assign(config, previous);
    assert.equal(config.outputDir, previous.outputDir);
    assert.equal(config.inputDir, previous.inputDir);
    assert.equal(await realpath(path.dirname(root)), tempDir);
    assert.ok(path.basename(root).startsWith("aiplay-character-packs-"));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual({ TEMP: process.env.TEMP, TMP: process.env.TMP }, tempEnv);
  }
});

test("reference safety follows the selected pack image", () => {
  const doc = fixture();
  doc.characters[0].takes = [{ file: "face.png", safety: { minor: false } }, { file: "body.png", safety: { minor: true } }];
  assert.equal(castFlags(doc, ["Mara"], { board: doc.boards[0] }).some((r) => r.minor), false);
  doc.boards[0].refRoles = { Mara: ["body"] };
  assert.equal(castFlags(doc, ["Mara"], { board: doc.boards[0] }).some((r) => r.minor), true);
});

test("typed MCP tools forward pack and scene selections through existing actions", async () => {
  const sent = [];
  const tools = mvTools(async (method, url, body) => {
    if (method === "GET") return { sets: { names: [] } };
    sent.push(body);
    return { changed: [], project: { characters: [], backgrounds: [], boards: [], segments: [], clips: [] }, board: body.board, shot: {} };
  }, (s) => s);
  const tool = (name) => tools.find((t) => t.name === name);
  await tool("mv_update_asset").run({ slug: "s", kind: "characters", id: "c", referenceImages: [{ file: "body.png", role: "body" }] });
  await tool("mv_import_asset").run({ slug: "s", path: "frame:crop.png", target: "character", id: "c", referenceRole: "side" });
  await tool("mv_set_shot").run({ slug: "s", segment: "s1", refRoles: { Mara: ["body"] } });
  assert.equal(sent[0].referenceImages[0].role, "body");
  assert.equal(sent[1].id, "c");
  assert.equal(sent[1].referenceRole, "side");
  assert.deepEqual(sent[2].refRoles, { Mara: ["body"] });
  assert.deepEqual(tool("mv_set_board").inputSchema.properties.board.properties.refRoles.additionalProperties.items.enum, REFERENCE_ROLES);
  assert.ok(tool("mv_set_bible").inputSchema.properties.bible.properties.boards.items.properties.refRoles);
});

test("human scene role picks render selected roles and collect only enabled named assets", async () => {
  const source = await readFile(new URL("../../web/mv.js", import.meta.url), "utf8");
  const helpers = source.slice(source.indexOf("const MV_REF_ROLES ="), source.indexOf("const SHOT_TYPES ="));
  const context = vm.createContext({ esc: (s) => String(s), document: { querySelectorAll: () => [
    { checked: true, getAttribute: (k) => k.endsWith("name") ? "Mara" : "side" },
    { checked: true, getAttribute: (k) => k.endsWith("name") ? "Other" : "body" },
  ] } });
  vm.runInContext(helpers, context);
  const html = vm.runInContext(`rolePicks(${JSON.stringify(fixture().characters[0])}, "b", ["side"])`, context);
  assert.match(html, /data-brole="side"[^>]* checked/);
  assert.doesNotMatch(html, /data-brole="body"[^>]* checked/);
  assert.equal(JSON.stringify(vm.runInContext('selectedRoles("b", ["Mara"])', context)), '{"Mara":["side"]}');
  assert.match(source, /mountPicDrop\(host,/);
});

test("repaint teardown removes drop targets and is safe to call twice", async () => {
  const source = (await readFile(new URL("../../web/picdrop.js", import.meta.url), "utf8")).replace(/export /g, "");
  const element = () => {
    const nodes = new Map();
    return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, children: [],
      querySelector(sel) { if (!nodes.has(sel)) nodes.set(sel, element()); return nodes.get(sel); },
      querySelectorAll() { return []; }, setAttribute() {}, addEventListener() {},
      appendChild(child) { child.parent = this; this.children.push(child); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    };
  };
  const context = vm.createContext({ document: { addEventListener() {}, createElement: element }, window: {}, host: element() });
  vm.runInContext(source, context);
  vm.runInContext('var drop1 = mountPicDrop(host, {}); var drop2 = mountPicDrop(host, {});', context);
  assert.equal(vm.runInContext("boxes.size", context), 2);
  vm.runInContext("drop1.destroy(); drop1.destroy(); drop1.paint();", context);
  assert.equal(vm.runInContext("boxes.size", context), 1);
  assert.equal(context.host.children.length, 1);
  vm.runInContext("drop2.destroy();", context);
  assert.equal(vm.runInContext("boxes.size", context), 0);
});
