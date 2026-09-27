/**
 * H3's block cache (T8mars's MiniMaxH3BlockCacheT8 custom node), opt-in:
 * video_settings block_cache. Plain H3 clips only, never beside sparse
 * attention (the node refuses BlockSparseAttention), never on FastH3, and
 * only where the engine has the node (art.js videoBlockCache).
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

test("Studio ships the node pinned with its licence and deploys it into custom_nodes", async () => {
  const { deployStudioNodes, VENDORED_NODES } = await import("./comfy_nodes.js");
  const os = await import("node:os");
  const path = await import("node:path");
  assert.deepEqual([...VENDORED_NODES], ["comfyui-minimax-h3-blockcache-T8"]);
  const src = new URL("./comfy_nodes/comfyui-minimax-h3-blockcache-T8/", import.meta.url);
  for (const f of ["__init__.py", "nodes.py", "h3_block_cache.py", "LICENSE"]) assert.ok(fs.existsSync(new URL(f, src)), f);
  assert.match(fs.readFileSync(new URL("nodes.py", src), "utf8"), /node_id="MiniMaxH3BlockCacheT8"/, "the node id the graph names");
  assert.match(fs.readFileSync(new URL("LICENSE", src), "utf8"), /Apache License/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-nodes-"));
  try {
    const first = deployStudioNodes(dir);
    assert.ok(first.copied.includes("comfyui-minimax-h3-blockcache-T8/nodes.py"));
    assert.equal(deployStudioNodes(dir).copied.length, 0, "unchanged bytes are never rewritten");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.match(read("../NOTICE"), /MiniMax H3 Block Cache \(T8\)\s+Apache-2\.0, Copyright T8mars\./);
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
    const result = deployStudioNodes(root);
    assert.deepEqual(fs.readdirSync(folder).sort(), before, "no bundled file fills a partial user installation");
    assert.equal(fs.readFileSync(path.join(folder, "nodes.py"), "utf8"), "# user-installed version\n");
    assert.equal(result.copied.some(name => name.startsWith(VENDORED_NODES[0] + "/")), false);
    assert.match(result.warnings.join("\n"), /Preserved existing.*move that folder aside and restart Studio/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
