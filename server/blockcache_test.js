/**
 * H3's block cache (T8mars's MiniMaxH3BlockCacheT8 custom node), opt-in:
 * video_settings block_cache. Plain H3 clips only, never beside sparse
 * attention (the node refuses BlockSparseAttention), never on FastH3, and
 * only where the engine has the node (art.js videoBlockCache).
 *
 * The node goes into ComfyUI only while the switch is on (comfy_nodes.js).
 *
 *   node --test server/blockcache_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { videoGraph, h3BlockCacheFor } = await import("./workflow.js");
const { config } = await import("./config.js");
const { H3_BLOCK_CACHE } = await import("./h3tier.js");
const { CATALOG } = await import("./videolab/catalog.js").catch(() => ({ CATALOG: null }));

const nodes = (g, re) => Object.entries(g).filter(([, v]) => re.test(v.class_type));

test("the recipe is the node's own defaults, and it is off unless asked", () => {
  assert.equal(H3_BLOCK_CACHE.node, "MiniMaxH3BlockCacheT8");
  assert.deepEqual([H3_BLOCK_CACHE.threshold, H3_BLOCK_CACHE.startPercent, H3_BLOCK_CACHE.endPercent,
    H3_BLOCK_CACHE.maxConsecutiveHits, H3_BLOCK_CACHE.cacheDevice, H3_BLOCK_CACHE.metricStride], [0.12, 0.08, 0.95, 2, "cpu", 8]);
  assert.equal(config.video.engines.h3.blockCache, false);
  assert.equal(config.video.engines.fasth3.blockCacheRecipe, null, "FastH3 always runs VSA, which the node refuses");
});

test("the graph carries it on the plain path only, after the shift, and feeds the sampler", () => {
  const g = videoGraph({ engine: "h3", prompt: "x", seed: 1, seconds: 5, steps: 8, blockCache: true, sparse: "off" });
  const c = nodes(g, /BlockCache/);
  assert.equal(c.length, 1);
  assert.equal(c[0][0], "82");
  assert.deepEqual(c[0][1].inputs.model, ["6", 0]);
  assert.deepEqual(g[7].inputs.model, ["82", 0]);
  assert.deepEqual(g[8].inputs.model, ["82", 0]);
  assert.equal(nodes(videoGraph({ engine: "h3", prompt: "x", seed: 1, seconds: 5, steps: 8, sparse: "off" }), /BlockCache/).length, 0, "not asked, not there");
  const eng = config.video.engines.h3;
  assert.equal(h3BlockCacheFor(eng, { blockCache: true, refs: true }), null, "references stay uncached");
  assert.equal(h3BlockCacheFor(eng, { blockCache: true, continuation: true }), null);
  assert.equal(h3BlockCacheFor(eng, { blockCache: true, control: true }), null);
  assert.equal(h3BlockCacheFor(eng, { blockCache: true, sparse: { method: "sol-attn" } }), null, "never beside sparse attention");
  const fast = videoGraph({ engine: "fasth3", prompt: "x", seed: 1, seconds: 5, blockCache: true });
  assert.equal(nodes(fast, /BlockCache/).length, 0);
  assert.equal(nodes(fast, /BlockSparseAttention/).length, 1);
});

test("art.js asks the engine for the node, says when it is missing, and records whether it ran", () => {
  const art = read("./art.js");
  assert.match(art, /blockCache: await this\.videoBlockCache\(job\),/);
  assert.match(art, /engineDoor\.objectInfo\(eng\.blockCacheRecipe\.node\)/);
  assert.match(art, /job\.blockCacheNote = "This clip ran without the block cache/);
  assert.match(art, /this\.#cacheOffered = undefined;/, "asked again after an engine restart");
  assert.match(art, /blockCache: !!job\.blockCacheRan, blockCacheNote: job\.blockCacheNote \|\| null,/);
});

test("the setting is a Video Lab row that agents reach through video_settings", () => {
  const cat = read("./videolab/catalog.js");
  assert.match(cat, /id: "block_cache",[\s\S]{0,160}kind: "bool", onValue: true, offValue: false,\s*path: \["video", "engines", "h3", "blockCache"\],/);
  assert.doesNotMatch(cat.slice(cat.indexOf('id: "block_cache"'), cat.indexOf('id: "block_cache"') + 900), /—/, "no em dash on screen");
});

test("Studio ships the node pinned with its licence", async () => {
  const { VENDORED_NODES } = await import("./comfy_nodes.js");
  assert.deepEqual([...VENDORED_NODES], ["comfyui-minimax-h3-blockcache-T8"]);
  const src = new URL("./comfy_nodes/comfyui-minimax-h3-blockcache-T8/", import.meta.url);
  for (const f of ["__init__.py", "nodes.py", "h3_block_cache.py", "LICENSE"]) assert.ok(fs.existsSync(new URL(f, src)), f);
  assert.match(fs.readFileSync(new URL("nodes.py", src), "utf8"), /node_id="MiniMaxH3BlockCacheT8"/, "the node id the graph names");
  assert.match(fs.readFileSync(new URL("LICENSE", src), "utf8"), /Apache License/);
  assert.match(read("../NOTICE"), /MiniMax H3 Block Cache \(T8\)\s+Apache-2\.0, Copyright T8mars\./);
  assert.match(read("../NOTICE"), /Copied into ComfyUI's\s+custom_nodes only when the engine starts with\s+video_settings block_cache switched on, and Studio's\s+copy is removed again when it starts with it off\./);
});

/* COPIED ONLY WHILE THE SWITCH IS ON (the owner's decision, 2026-09-26).
 * 40f5859 copied the node into every ComfyUI at every engine start, the
 * owner's included, with the switch off. Temp folders only. */
test("the node goes into custom_nodes only while block_cache is on, and Studio's copy comes out when it is off", async () => {
  const { deployStudioNodes, MARKER } = await import("./comfy_nodes.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const T8 = "comfyui-minimax-h3-blockcache-T8";
  const SHIPS = ["LICENSE", "__init__.py", "h3_block_cache.py", "nodes.py"];
  const on = { want: { [T8]: true } }, off = { want: { [T8]: false } };
  const src = new URL(`./comfy_nodes/${T8}/`, import.meta.url);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-nodes-"));
  const t8 = path.join(dir, T8);
  const ls = (p) => (fs.existsSync(p) ? fs.readdirSync(p).sort() : null);
  const pyc = (p) => { fs.mkdirSync(path.join(p, "__pycache__"), { recursive: true }); fs.writeFileSync(path.join(p, "__pycache__", "nodes.cpython-312.pyc"), "x"); };
  try {
    /* Off, the default: Studio's own nodes as ever, and no T8 at all. */
    const first = deployStudioNodes(dir);
    assert.ok(first.copied.includes("aiplay_safety_gate.py"), "Studio's own nodes still ride in at every start");
    assert.equal(ls(t8), null, "the switch is off by default: nothing of T8's is copied");
    assert.equal(deployStudioNodes(dir, undefined, off).copied.length, 0);

    /* On: copied and marked; a second start rewrites nothing. */
    const put = deployStudioNodes(dir, undefined, on);
    assert.deepEqual(put.copied.sort(), SHIPS.map((n) => `${T8}/${n}`));
    assert.deepEqual(ls(t8), [MARKER, ...SHIPS].sort());
    const mark = JSON.parse(fs.readFileSync(path.join(t8, MARKER), "utf8"));
    assert.deepEqual(Object.keys(mark.files).sort(), SHIPS, "the marker lists every file Studio wrote");
    assert.equal(mark.createdFolder, true);
    assert.equal(deployStudioNodes(dir, undefined, on).copied.length, 0, "unchanged bytes are never rewritten");

    /* Off again: Studio's copy is removed, Python's bytecode for it and the folder too. */
    pyc(t8);
    const out = deployStudioNodes(dir, undefined, off);
    assert.deepEqual(out.removed.sort(), SHIPS.map((n) => `${T8}/${n}`));
    assert.equal(ls(t8), null, "the folder Studio made is gone");

    /* 40f5859's copy (no marker, only the shipped files byte for byte) is Studio's. */
    fs.mkdirSync(t8);
    for (const n of SHIPS) fs.copyFileSync(new URL(n, src), path.join(t8, n));
    pyc(t8);
    assert.equal(deployStudioNodes(dir, undefined, off).removed.length, 4);
    assert.equal(ls(t8), null, "a copy 40f5859 left with the switch off is removed");
    fs.mkdirSync(t8);
    for (const n of SHIPS) fs.copyFileSync(new URL(n, src), path.join(t8, n));
    const adopt = deployStudioNodes(dir, undefined, on);
    assert.equal(adopt.copied.length, 0, "...and taken over, not rewritten, with the switch on");
    assert.ok(fs.existsSync(path.join(t8, MARKER)));

    /* A file somebody changed or added in Studio's copy stays, and so does the folder. */
    fs.writeFileSync(path.join(t8, "nodes.py"), "# my edit\n");
    fs.writeFileSync(path.join(t8, "notes.txt"), "mine");
    const kept = deployStudioNodes(dir, undefined, off);
    assert.deepEqual(kept.removed.sort(), ["LICENSE", "__init__.py", "h3_block_cache.py"].map((n) => `${T8}/${n}`));
    assert.deepEqual(ls(t8), [MARKER, "nodes.py", "notes.txt"].sort());
    assert.equal(deployStudioNodes(dir, undefined, on).copied.length, 4, "still marked as Studio's, so on fills it again");
    fs.rmSync(t8, { recursive: true, force: true });

    /* A marker that no longer parses (a cut-off write, a hand edit) does not make
     * Studio's copy somebody else's: judged by the rest, it still comes out. */
    deployStudioNodes(dir, undefined, on);
    fs.writeFileSync(path.join(t8, MARKER), '{ "files": ');
    const cut = deployStudioNodes(dir, undefined, off);
    assert.deepEqual([cut.foreign, cut.removed.sort()], [[], SHIPS.map((n) => `${T8}/${n}`)]);
    assert.equal(ls(t8), null, "not left in custom_nodes with the switch off");

    /* Somebody else's (ComfyUI Manager's clone): never written into, never removed. */
    fs.mkdirSync(path.join(t8, ".git"), { recursive: true });
    fs.writeFileSync(path.join(t8, "README.md"), "clone");
    fs.writeFileSync(path.join(t8, "nodes.py"), "# upstream, a newer one\n");
    const theirs = deployStudioNodes(dir, undefined, on);
    assert.deepEqual(theirs.foreign, [T8]);
    assert.equal(theirs.copied.filter((n) => n.startsWith(T8)).length, 0, "not written into");
    assert.equal(fs.readFileSync(path.join(t8, "nodes.py"), "utf8"), "# upstream, a newer one\n");
    assert.ok(!fs.existsSync(path.join(t8, MARKER)));
    deployStudioNodes(dir, undefined, off);
    assert.deepEqual(ls(t8), [".git", "README.md", "nodes.py"], "not removed either");
    fs.rmSync(t8, { recursive: true, force: true });

    /* An empty folder is filled, and left empty again, never removed. */
    fs.mkdirSync(t8);
    assert.equal(deployStudioNodes(dir, undefined, on).copied.length, 4);
    deployStudioNodes(dir, undefined, off);
    assert.deepEqual(ls(t8), [], "the folder was not Studio's");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ASKED AGAIN AFTER EVERY ENGINE START. The node comes and goes only as the
 * engine starts, and on a pinned port (AIPLAY_COMFY_PORT) a restart keeps its
 * number, so the engine door's "rebound" never comes. A remembered yes would
 * name a node that engine no longer has, and ComfyUI refuses the whole clip.
 * ArtRunner for real, the engine door stubbed, temp folders only. */
test("art.js asks the engine for the node again after every engine start, the port unchanged", async () => {
  const { ArtRunner } = await import("./art.js");
  const { engine } = await import("./engine/client.js");
  const { deployStudioNodes } = await import("./comfy_nodes.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const T8 = "comfyui-minimax-h3-blockcache-T8";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-cache-epoch-"));
  const keep = { objectInfo: engine.objectInfo, on: config.video.engines.h3.blockCache };
  let offered = true;
  engine.objectInfo = async (node) => (offered ? { [node]: {} } : {});
  const clip = () => ({ engine: "h3", steps: 8, sparse: "off", prompt: "a lamp on a table", seconds: 2 });
  const start = (on) => { deployStudioNodes(dir, undefined, { want: { [T8]: on } }); offered = on; };
  try {
    const runner = new ArtRunner({ ready: true }, { current: null, queue: [] });
    config.video.engines.h3.blockCache = true;
    start(true);
    assert.equal(await runner.videoBlockCache(clip()), true, "on at the start: the engine has it");
    config.video.engines.h3.blockCache = false;
    start(false);                                    // the same port: Studio's copy left at this start
    config.video.engines.h3.blockCache = true;       // switched on while that engine runs
    const job = clip();
    assert.equal(await runner.videoBlockCache(job), false, "not a remembered yes: this engine has no node");
    assert.match(job.blockCacheNote, /restart Studio to use it\./);
    start(true);
    assert.equal(await runner.videoBlockCache(clip()), true, "nor a remembered no once a start brought it back");
  } finally {
    engine.objectInfo = keep.objectInfo;
    config.video.engines.h3.blockCache = keep.on;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the engine start passes the switch, and the words say when it applies", () => {
  const comfy = read("./comfy.js");
  assert.match(comfy, /const cacheOn = config\.video\?\.engines\?\.h3\?\.blockCache === true;/);
  assert.match(comfy, /deployStudioNodes\(path\.join\(config\.comfyDir, "custom_nodes"\), undefined,\s*\{ want: \{ "comfyui-minimax-h3-blockcache-T8": cacheOn \} \}\);/);
  /* Switched on while the engine runs: ComfyUI reads custom_nodes only as it starts. */
  assert.match(read("./art.js"), /if you switched it on while the engine was running, restart Studio to use it\./);
  const cat = read("./videolab/catalog.js");
  const row = cat.slice(cat.indexOf('id: "block_cache"'), cat.indexOf("cite:", cat.indexOf('id: "block_cache"')));
  assert.match(row, /which Studio copies into ComfyUI when the engine starts with this on, and takes "\s*\+ "out again when it starts with this off; switched on while the engine runs, it applies after Studio restarts\)/);
});

test("an independently installed H3 node folder is never overwritten or mixed with bundled files", async () => {
  const { deployStudioNodes, VENDORED_NODES } = await import("./comfy_nodes.js");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-user-h3-"));
  const folder = path.join(root, VENDORED_NODES[0]);
  try {
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "nodes.py"), "# user-installed version\n");
    fs.writeFileSync(path.join(folder, "extra.py"), "# keep this too\n");
    const before = fs.readdirSync(folder).sort();
    /* With the block cache on (the only time Studio would copy it): kept, and said. */
    const result = deployStudioNodes(root, undefined, { want: { [VENDORED_NODES[0]]: true } });
    assert.deepEqual(fs.readdirSync(folder).sort(), before, "no bundled file fills a partial user installation");
    assert.equal(fs.readFileSync(path.join(folder, "nodes.py"), "utf8"), "# user-installed version\n");
    assert.equal(result.copied.some(name => name.startsWith(VENDORED_NODES[0] + "/")), false);
    assert.match(result.warnings.join("\n"), /Preserved existing.*move that folder aside and restart Studio/);
    /* With it off: not removed either, and nothing to say. */
    const off = deployStudioNodes(root);
    assert.deepEqual(fs.readdirSync(folder).sort(), before, "and never removed");
    assert.deepEqual([off.removed, off.warnings], [[], []]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
