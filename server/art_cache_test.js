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

const { config } = await import("./config.js");
const art = await import("./art.js");
const { engine } = await import("./engine/client.js");
const { ArtRunner, CLIP_DIR, graphHash } = art;

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
    histories.set(id, execCache.get(key));
    return { ok: true, json: async () => ({ prompt_id: id }) };
  }
  const m = u.match(/\/history\/(.+)$/);
  if (m) {
    const out = histories.get(m[1]);
    return {
      ok: true,
      json: async () => ({
        [m[1]]: { status: { completed: true }, outputs: { 9: { images: [out] } } },
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
} finally {
  globalThis.fetch = realFetch;
  runner.stopAll?.();
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
process.exit(0);
