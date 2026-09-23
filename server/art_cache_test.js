/**
 * The renderer's cache-hit path — proved without a GPU.
 *
 * THE BUG. ComfyUI caches node outputs by their inputs for the lifetime of the
 * process, and #clip finishes a render by MOVING the engine's file into the
 * clip library — which is a subfolder of the engine's own output folder. Render
 * the same graph twice and the second run is served from cache: SaveVideo never
 * executes, /history hands back the entry the FIRST run wrote, and that file is
 * no longer there. `rename` throws ENOENT and a render that cost nothing is
 * reported as a failure. Reproduced twice by hand on the real engine, and
 * measured on Video Lab's first re-run (both LTX arms dead in four seconds).
 *
 * HOW THIS REPRODUCES IT WITH NO GPU. `globalThis.fetch` is replaced by a fake
 * ComfyUI that models the one behaviour that matters: an execution cache keyed
 * on the submitted graph. A MISS assigns the next `clip_0000N_.mp4`, actually
 * writes that file, and remembers the entry. A HIT writes nothing and replays
 * the remembered entry — which is precisely how the real engine loses the file
 * out from under itself. Nothing here touches the live engine: the fetch stub
 * answers every request, and the engine client is pointed at a port reserved
 * from the OS and immediately closed, so even the progress websocket cannot
 * reach a real render in flight.
 *
 * ⚠ IT ALSO NOW EXERCISES THE ENGINE DOOR, because that is the path #clip
 * takes. Every render below writes a `delegate` and a `generate` event on
 * `engine/<runId>` into this temporary ledger before and after the POST — so
 * this file is, as a side effect, the stubbed-engine proof that a clip job goes
 * through the door and comes back with a record. The cache-hit assertions are
 * unchanged, which is the point: the door did not alter the behaviour they
 * pin.
 *
 * WHAT IS ASSERTED. The miss still works (a file lands in the library under the
 * job's own name). The hit no longer dies: it resolves to the clip that graph
 * already produced, says so in the job's meta, and writes a `regen` event into
 * the ledger carrying `cacheHit` and the graph fingerprint. And the third case
 * — a cache hit whose twin was DELETED from the library — re-renders rather
 * than handing back a name with no file under it.
 *
 * THE INPUT ECHO. On ComfyUI 0.36 LoadVideo reports the file it READ as an
 * output row of type "input", and /history's outputs come back in node-id
 * order. The enhance graph loads at node 1 and saves at node 9, so the echo is
 * the FIRST row: measured 2026-09-23, seven RIFE jobs finished on the GPU and
 * then died with `ENOENT ... rename 'output\aiplay_enh_<hash>.mp4'` while the
 * real result sat in output/clips. The fake engine below echoes every
 * LoadVideo in the shape the rig's own `preview_input_video` writes, so the
 * real #enhance, #restyle and a continuation through #clip must each file the
 * SaveVideo output and leave no orphan behind.
 *
 *   node server/art_cache_test.js
 */
import os from "node:os";
import path from "node:path";
import { mkdir, rm, readFile, writeFile, stat, readdir } from "node:fs/promises";

/* The output dir and the app-data dir MUST be decided before config.js is first
 * imported, and static imports hoist — so every import below is dynamic. */
const TMP = path.join(os.tmpdir(), `art-cache-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = path.join(TMP, "output");
process.env.AIPLAY_APPDATA = path.join(TMP, "appdata");
// #enhance and #restyle STAGE their source here; never the rig's own input folder.
process.env.AIPLAY_INPUT = path.join(TMP, "input");

const { config } = await import("./config.js");
const art = await import("./art.js");
const { engine } = await import("./engine/client.js");
const { ArtRunner, CLIP_DIR, graphHash, savedClip } = art;

/* THE DOOR, STOOD UP WITHOUT AN ENGINE.
 *
 * `dispatch()` refuses unless a port is reserved AND this Studio's child is
 * alive — the identity rule that used to live in comfy.submit(). Both are
 * satisfied here without a process: reservePort() takes a real ephemeral port
 * from the OS and closes it (so the progress websocket #connect opens finds
 * nothing rather than reaching a render in flight on the usual port), and
 * attachChild takes an object with the two fields isOurs() actually reads.
 *
 * A fake child is honest for this test: what is being proved is art.js's
 * behaviour on a cache hit, and the stub below IS the engine. */
await engine.reservePort();
engine.attachChild({ exitCode: null, signalCode: null });

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ── the fake engine ─────────────────────────────────────────────────────── */

/** graph fingerprint -> the output entry that graph produced. ComfyUI's
 *  execution cache, modelled at the only resolution this test needs. */
const execCache = new Map();
const submitted = [];
let counter = 0;
/** Set to make the next submission behave as a cold cache (a real re-render). */
let evictAll = false;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/prompt")) {
    const graph = JSON.parse(init.body).prompt;
    const key = graphHash(graph);
    submitted.push(key);
    const id = `p${submitted.length}`;
    if (evictAll) { execCache.clear(); evictAll = false; }
    if (!execCache.has(key)) {
      // A MISS: SaveVideo runs, picks the next free counter, writes the file.
      const filename = `clip_${String(++counter).padStart(5, "0")}_.mp4`;
      await mkdir(CLIP_DIR, { recursive: true });
      await writeFile(path.join(CLIP_DIR, filename), `frames for ${key}`, "utf8");
      execCache.set(key, { filename, subfolder: "clips", type: "output" });
    }
    // A HIT falls through writing nothing at all — that is the bug.
    /* Filed under the graph's own SaveVideo node, and every LoadVideo echoes
     * the file it read, as ComfyUI 0.36 does: `images` + `animated`, folder
     * type "input" (comfy_extras/nodes_video.py, preview_input_video). */
    const outputs = {};
    for (const [nid, node] of Object.entries(graph)) {
      if (node.class_type === "LoadVideo") {
        outputs[nid] = { images: [{ filename: node.inputs.file, subfolder: "", type: "input" }], animated: [true] };
      }
    }
    const saveNode = Object.keys(graph).find((nid) => graph[nid].class_type === "SaveVideo") ?? "9";
    outputs[saveNode] = { images: [execCache.get(key)], animated: [true] };
    histories.set(id, outputs);
    return { ok: true, json: async () => ({ prompt_id: id }) };
  }
  const m = u.match(/\/history\/(.+)$/);
  if (m) {
    const outputs = histories.get(m[1]);
    return {
      ok: true,
      json: async () => ({
        [m[1]]: { status: { completed: true }, outputs },
      }),
    };
  }
  /* The door asks about more than /prompt and /history: /system_stats at
   * startup, /queue when a prompt is missing from history, /interrupt and
   * /queue on stopAll. None of them changes what is being tested, and throwing
   * on them would fail a render for a reason that has nothing to do with the
   * cache. Answer plausibly and let the assertions do the judging. */
  if (u.endsWith("/system_stats")) return { ok: true, json: async () => ({ system: { comfyui_version: "test", argv: [] } }) };
  if (u.includes("/queue")) return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) };
  if (u.endsWith("/interrupt") || u.endsWith("/free")) return { ok: true, json: async () => ({}) };
  throw new Error(`unexpected fetch in test: ${u}`);
};
const histories = new Map();

/* ── the runner, with music always idle ──────────────────────────────────── */

const runner = new ArtRunner({ ready: true }, { current: null, queue: [] });

/** Queue one standalone clip and wait for its completion event. */
function render(id, extra = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`render ${id} never finished`)), 30_000);
    const onClip = (evt) => {
      if (evt.file !== `clip:${id}`) return;
      clearTimeout(t); runner.off("clip", onClip); resolve(evt);
    };
    const onUpdate = () => {
      if (runner.lastError) {
        clearTimeout(t); runner.off("clip", onClip); runner.off("update", onUpdate);
        reject(new Error(runner.lastError));
      }
    };
    runner.on("clip", onClip);
    runner.on("update", onUpdate);
    runner.request({
      file: `clip:${id}`, kind: "video", seed: 4242,
      video: { prompt: "a paper boat on wet tarmac", seconds: 2, width: 512, height: 320, ...extra },
    });
  });
}

/** Queue any job and resolve with the runner's event for it, or `{ error }`:
 *  a failure is an assertion to report, not a crash that hides the rest.
 *  `lastError` is sticky, so only a NEW one belongs to this job. */
function finish(event, match, req) {
  const was = runner.lastError;
  return new Promise((resolve) => {
    const t = setTimeout(() => settle({ error: `${event} never finished` }), 30_000);
    const settle = (v) => { clearTimeout(t); runner.off(event, onEvent); runner.off("update", onUpdate); resolve(v); };
    const onEvent = (evt) => { if (match(evt)) settle(evt); };
    const onUpdate = () => { if (runner.lastError && runner.lastError !== was) settle({ error: runner.lastError }); };
    runner.on(event, onEvent);
    runner.on("update", onUpdate);
    runner.request(req);
  });
}

async function ledger() {
  const f = path.join(config.paths.appData, "provenance", "library.jsonl");
  const raw = await readFile(f, "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

console.log("\nart.js — the cache hit that used to be an ENOENT\n");

try {
  console.log("  -- a miss renders and lands in the library --");
  const first = await render("aaa");
  ok("the first render returns a clip named for its job", first.clip === "aaa.mp4",
     `got ${first.clip}`);
  ok("and that file is on disk",
     await stat(path.join(CLIP_DIR, "aaa.mp4")).then(() => true, () => false));
  ok("the engine's own file is gone — it was MOVED, which is what starts the bug",
     !(await readdir(CLIP_DIR)).includes("clip_00001_.mp4"));
  ok("a miss records no cache hit", first.meta.cacheHit === null,
     JSON.stringify(first.meta.cacheHit));

  const idx = JSON.parse(await readFile(path.join(CLIP_DIR, ".renders.json"), "utf8"));
  const key = submitted[0];
  ok("the render index remembers which graph made it", idx[key]?.clip === "aaa.mp4",
     JSON.stringify(idx));

  console.log("\n  -- the same graph again: served from cache, file already moved --");
  const before = counter;
  const second = await render("bbb");
  ok("the engine wrote nothing — it was a real cache hit", counter === before);
  ok("the second submission fingerprints identically", submitted[1] === submitted[0]);
  /* THE REGRESSION. Before the fix this render died with
   * `ENOENT: no such file or directory, rename '...clip_00001_.mp4' -> '...bbb.mp4'`. */
  ok("it resolves to the clip that graph already made, instead of ENOENT",
     second.clip === "aaa.mp4", `got ${second.clip}`);
  ok("no second file was invented", !(await readdir(CLIP_DIR)).includes("bbb.mp4"));
  ok("the clip meta says it was a cache hit", second.meta.cacheHit?.clip === "aaa.mp4",
     JSON.stringify(second.meta.cacheHit));
  ok("and carries the graph fingerprint that proves the two are the same render",
     second.meta.cacheHit?.graph === key);
  ok("the meta explains it in words a person can act on",
     /change the seed/i.test(second.meta.cacheHit?.why || ""));

  const events = await ledger();
  const regens = events.filter((e) => e.type === "regen");
  ok("provenance records the cache hit as one regen event", regens.length === 1,
     `got ${regens.length} of ${events.length}`);
  ok("...on the clip that was actually handed back",
     regens[0]?.asset === "clips/aaa.mp4", regens[0]?.asset);
  ok("...as op DATA, not a new event type",
     regens[0]?.data?.cacheHit === true && regens[0]?.data?.graph === key,
     JSON.stringify(regens[0]?.data));
  ok("...and the vocabulary is unchanged",
     (await import("./provenance.js")).EVENT_TYPES.has("regen"));

  console.log("\n  -- a cache hit whose twin was deleted must render for real --");
  await rm(path.join(CLIP_DIR, "aaa.mp4"));
  /* The engine still holds the cached entry, so it keeps offering a file that
   * now exists in NEITHER place. Left alone that is the original dead end. */
  const third = await render("ccc");
  ok("it does not hand back a name with no file under it", third.clip !== "aaa.mp4",
     `got ${third.clip}`);
  ok("it produced a real clip of its own", third.clip === "ccc.mp4"
     && await stat(path.join(CLIP_DIR, "ccc.mp4")).then(() => true, () => false));
  ok("which took a second submission, with a bumped save prefix", submitted.length === 4);
  ok("the two submissions of that render differ only in the save prefix",
     submitted[2] === submitted[0] && submitted[3] !== submitted[0]);
  ok("a re-render is not reported as a cache hit", third.meta.cacheHit === null);
  ok("provenance gained no second regen", (await ledger()).filter((e) => e.type === "regen").length === 1);

  console.log("\n  -- a different graph is not a twin --");
  evictAll = true;
  const other = await render("ddd", { prompt: "a paper boat, but on fire" });
  ok("a changed prompt renders and keeps its own name", other.clip === "ddd.mp4",
     `got ${other.clip}`);
  ok("and is fingerprinted apart from the first", submitted.at(-1) !== submitted[0]);

  /* ── the input echo ─────────────────────────────────────────────────── */
  const INPUT = process.env.AIPLAY_INPUT;
  /** The engine door's completion record for one run: what /history listed, in order. */
  const recorded = async (runId) => (await ledger())
    .find((e) => e.type === "generate" && e.asset === `engine/${runId}`)?.data?.outputs || [];
  await writeFile(path.join(CLIP_DIR, "src.mp4"), "source frames", "utf8");

  console.log("\n  -- enhance: LoadVideo's echo of its input is listed FIRST --");
  let shelf = new Set(await readdir(CLIP_DIR));
  const enh = await finish("enhanced", (e) => e.source === "src.mp4", {
    file: "src.mp4", title: "src.mp4", kind: "enhance", force: true,
    video: {
      interpolate: { model: "rife_v4.26.safetensors", multiplier: 4, slow: false }, upscale: null,
      keepAudio: true, srcWidth: 512, srcHeight: 320, srcSeconds: 2,
    },
  });
  const enhRows = await recorded(enh.runId);
  ok("the run listed the echo first, as the rig does (load node 1, save node 9)",
     enhRows[0]?.type === "input" && enhRows[0]?.node === "1" && /^aiplay_enh_/.test(enhRows[0]?.file || "")
       && enhRows[1]?.node === "9" && enhRows[1]?.type === "output",
     JSON.stringify(enhRows.map((r) => [r.node, r.type, r.file])));
  /* THE REGRESSION. Before the fix this job died with
   * `ENOENT: no such file or directory, rename '...output\aiplay_enh_<hash>.mp4'`. */
  ok("the enhance files what SaveVideo wrote, named for what was done", enh.clip === "src_4xfps.mp4",
     enh.error || `got ${enh.clip}`);
  ok("and those are the engine's frames, not the source's",
     /^frames for /.test(await readFile(path.join(CLIP_DIR, "src_4xfps.mp4"), "utf8").catch(() => "")));
  const enhShelf = (await readdir(CLIP_DIR)).filter((n) => !shelf.has(n));
  ok("no orphan is left in the clip library: the one new file is the named result",
     enhShelf.length === 1 && enhShelf[0] === "src_4xfps.mp4", JSON.stringify(enhShelf));
  ok("the source clip is untouched",
     await readFile(path.join(CLIP_DIR, "src.mp4"), "utf8") === "source frames");
  ok("the staged copy is gone from the input folder",
     !(await readdir(INPUT).catch(() => [])).some((n) => n.startsWith("aiplay_enh_")));
  ok("the echo stays on the record and is never shelved",
     enhRows[0]?.adoptedAs === null);

  console.log("\n  -- restyle: the same echo, at node 30 --");
  shelf = new Set(await readdir(CLIP_DIR));
  const rs = await finish("restyled", (e) => e.source === "src.mp4", {
    file: "src.mp4", title: "src.mp4", kind: "restyle", force: true, seed: 7,
    video: { prompt: "the same boat, drawn in ink", guideEvery: 24, seconds: 2, width: 512, height: 320 },
  });
  ok("the restyle run carried the echo on its record",
     (await recorded(rs.runId)).some((r) => r.type === "input" && /^aiplay_rs_/.test(r.file)));
  ok("the restyle files what SaveVideo wrote", rs.clip === "src_restyled.mp4"
     && /^frames for /.test(await readFile(path.join(CLIP_DIR, "src_restyled.mp4"), "utf8").catch(() => "")),
     rs.error || `got ${rs.clip}`);
  const rsShelf = (await readdir(CLIP_DIR)).filter((n) => !shelf.has(n));
  ok("...and leaves no orphan", rsShelf.length === 1, JSON.stringify(rsShelf));

  console.log("\n  -- a continuation through #clip: the echo at node 70 --");
  await mkdir(INPUT, { recursive: true });
  await writeFile(path.join(INPUT, "aiplay_cont_test.mp4"), "source frames", "utf8");
  shelf = new Set(await readdir(CLIP_DIR));
  const cont = await finish("clip", (e) => e.file === "clip:eee", {
    file: "clip:eee", kind: "video", seed: 4242,
    video: {
      prompt: "a paper boat on wet tarmac", seconds: 2, width: 512, height: 320, engine: "h3",
      continueFrom: { file: "aiplay_cont_test.mp4", frames: 49, fps: 24, hasAudio: false, overlapFrames: 9, extensionFrames: 40 },
    },
  });
  ok("the continuation run carried the echo on its record",
     (await recorded(cont.runId)).some((r) => r.type === "input" && r.node === "70"),
     JSON.stringify((await recorded(cont.runId)).map((r) => [r.node, r.type, r.file])));
  ok("the continuation files what SaveVideo wrote", cont.clip === "eee.mp4"
     && /^frames for /.test(await readFile(path.join(CLIP_DIR, "eee.mp4"), "utf8").catch(() => "")),
     cont.error || `got ${cont.clip}`);
  const contShelf = (await readdir(CLIP_DIR)).filter((n) => !shelf.has(n));
  ok("...and leaves no orphan", contShelf.length === 1, JSON.stringify(contShelf));

  /* Restyle and a continuation are right above partly because their loaders
   * carry the LARGER node id. The pick itself must not depend on that. */
  console.log("\n  -- the pick is by node, whatever the numbering --");
  const g = { 1: { class_type: "LoadVideo" }, 4: { class_type: "SaveImage" }, 21: { class_type: "SaveVideo" } };
  ok("an echo and another saved file ahead of SaveVideo: SaveVideo's row wins",
     savedClip([
       { node: "1", file: "aiplay_rs_x.mp4", subfolder: "", type: "input" },
       { node: "4", file: "still_00001_.png", subfolder: "", type: "output" },
       { node: "21", file: "rs_00001_.mp4", subfolder: "clips", type: "output" },
     ], g)?.file === "rs_00001_.mp4");
  ok("with no SaveVideo row, an echo or a temp preview is never the answer",
     savedClip([
       { node: "1", file: "aiplay_rs_x.mp4", subfolder: "", type: "input" },
       { node: "5", file: "ComfyUI_temp_video_00001_.mp4", subfolder: "", type: "temp" },
       { node: "7", file: "out_00001_.mp4", subfolder: "clips", type: "output" },
     ], {})?.file === "out_00001_.mp4");
  ok("an echo alone is no clip at all, so the job says so instead of renaming the input",
     savedClip([{ node: "1", file: "aiplay_enh_x.mp4", subfolder: "", type: "input" }], g) === null);
} finally {
  globalThis.fetch = realFetch;
  runner.stopAll?.();
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
process.exit(0);
