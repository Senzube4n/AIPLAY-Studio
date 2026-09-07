/**
 * THE PREVIEW CACHE KEY, against real files on real disk.
 *
 * WHAT WENT WRONG. The frame cache was keyed slug|updatedAt|t|scale|draft|view
 * — the ROOT comp's stamp and nothing else. A comp layer renders a CHILD
 * document, so an edit inside the child (turning linear light on, moving a
 * keyframe, anything) changes the parent's pixels while leaving the parent's
 * `updatedAt` exactly where it was. The parent's cached frames were then served
 * after the edit that invalidated them — out of RAM and off disk, at full
 * speed, with no error anywhere — until something else happened to touch the
 * parent. routes.js states the rule above `viewOf`: a render-affecting
 * parameter that is not in the key poisons the cache silently. The one
 * parameter breaking it lived in another file.
 *
 * THE CHOICE THIS PINS. Two designs close the hole — fold every nested comp's
 * `updatedAt` into the key, or bump a comp's parents when the child is written.
 * routes.js `compStamp` picks the FOLD and gives its three reasons. This file
 * exists so the choice cannot be quietly reverted to the cheaper-looking one,
 * and so the property that matters — a child edit invalidates the parent — is
 * proven rather than argued.
 *
 * NO PYTHON AND NO SERVER, which is why it can sit in the pre-commit hook
 * beside routes_test.js. It drives the route factory directly, writes comp
 * documents through the real store, and PLANTS a frame file under the name the
 * cache would give it — the manifest then reports what the cache believes about
 * files that genuinely exist. `GET /api/vfx/cache/<slug>` names the live stamp,
 * which is how a frame can be named from outside without rendering one.
 *
 *   node server/vfx/cachekey_test.js
 *
 * Writes only under its own temp directory and removes it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "vfx_cachekey_"));
/* Before the imports below: config.js reads both of these at module load, and
 * this suite must not touch the real user's output directory or settings. */
process.env.AIPLAY_OUTPUT = SCRATCH;
process.env.AIPLAY_APPDATA = path.join(SCRATCH, "appdata");

const { createComp, updateComp, readComp } = await import("./store.js");
const { createVfxRoutes } = await import("./routes.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/* The handler is (req, res, url) and answers through the injected `json`, so a
 * captured reply is the whole of what a browser would have received. */
let reply = null;
const routes = createVfxRoutes({
  json: (_res, status, body) => { reply = { status, body }; },
  readBody: async () => ({}),
  config: { outputDir: SCRATCH, python: "python" },
  IMAGE_DIR: path.join(SCRATCH, "images"),
  CLIP_DIR: path.join(SCRATCH, "clips"),
  art: {},
});

async function manifest(slug, qs = "scale=1&fps=30") {
  reply = null;
  const url = new URL(`http://x/api/vfx/cache/${slug}?${qs}`);
  const handled = await routes({ method: "GET", url: url.pathname + url.search }, {}, url);
  if (!handled || reply?.status !== 200) throw new Error(`cache manifest for ${slug}: ${JSON.stringify(reply)}`);
  return reply.body;
}

/** One frame on disk at t=0, full scale, active camera — the name frameName
 *  builds, which is why the stamp has to come from the manifest. */
function plantFrame(slug, stamp) {
  const dir = path.join(SCRATCH, "vfx", slug, "preview");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `f_${stamp}_0_1000.png`), "not a png, but it has a size");
}
const previewNames = (slug) => {
  try { return readdirSync(path.join(SCRATCH, "vfx", slug, "preview")).sort(); } catch { return []; }
};
/* frameIndex memoises for 250 ms on (slug, stamp, scale, draft, view). Two
 * reads at the SAME stamp with a write between them have to outlast it, or the
 * suite would be measuring the memo. Reads either side of an edit do not: the
 * stamp is part of the memo key, which is the point. */
const pastMemo = () => new Promise((s) => setTimeout(s, 300));

try {
  console.log("\n  -- a comp with no children keeps exactly the key it had --");

  await createComp("Flat");
  const flat = await readComp("flat");
  const flatMf = await manifest("flat");
  eq("the stamp of a childless comp is its own updatedAt in base 36, unchanged",
    flatMf.stamp, Number(flat.updatedAt).toString(36));
  ok("...so a frame it already rendered is still named the same file",
    /^[0-9a-z]+$/.test(flatMf.stamp), flatMf.stamp);

  console.log("\n  -- planting a frame is enough to be counted --");

  plantFrame("flat", flatMf.stamp);
  await pastMemo();
  eq("a frame on disk under the live stamp counts as cached",
    (await manifest("flat")).grid.cached, 1);

  await updateComp("flat", (d) => { d.duration = 4; return d; });
  const flatEdited = await manifest("flat");
  ok("...and editing the comp itself moves the stamp", flatEdited.stamp !== flatMf.stamp,
    `${flatMf.stamp} -> ${flatEdited.stamp}`);
  eq("...so the frame from before the edit stops counting", flatEdited.grid.cached, 0);

  console.log("\n  -- THE BUG: an edit inside a CHILD comp --");

  await createComp("Child");
  await createComp("Parent");
  await updateComp("parent", (d) => {
    d.layers = [{
      id: "ly_1", name: "the child", type: "comp", src: "child", enabled: true,
      in: 0, out: 5, blend: "normal",
      transform: { position: [0, 0, 0], scale: [100, 100, 100], rotation: 0, opacity: 100, anchor: [0, 0, 0] },
      effects: [], masks: [], trackMatte: null,
    }];
    return d;
  });

  const parent = await readComp("parent");
  const before = await manifest("parent");
  ok("a comp that CONTAINS one no longer keys on its own updatedAt alone",
    before.stamp !== Number(parent.updatedAt).toString(36),
    `stamp ${before.stamp} vs own ${Number(parent.updatedAt).toString(36)}`);
  ok("...and the folded stamp still fits the on-disk frame name",
    /^[0-9a-z]+$/.test(before.stamp), before.stamp);

  plantFrame("parent", before.stamp);
  await pastMemo();
  eq("the parent has a cached frame", (await manifest("parent")).grid.cached, 1);

  /* The edit. Nothing about the parent document changes — this is the whole
   * point — and the parent's pixels change anyway, because the child is what
   * the comp layer draws. */
  const parentBefore = await readComp("parent");
  await updateComp("child", (d) => { d.linearLight = true; return d; });
  const parentAfter = await readComp("parent");
  eq("the child edit really does leave the parent document untouched",
    parentAfter.updatedAt, parentBefore.updatedAt);

  const after = await manifest("parent");
  ok("A CHILD EDIT MOVES THE PARENT'S STAMP", after.stamp !== before.stamp,
    `${before.stamp} -> ${after.stamp} — keyed on the root's updatedAt alone these are equal, `
    + "and the frame below is served as if the edit had not happened");
  eq("...so the parent's frame from before it is no longer cached", after.grid.cached, 0);
  ok("...and the stale frame is still ON DISK — this is invalidation, not deletion, "
    + "so the count is the cache's own answer and not a side effect of a sweep",
    previewNames("parent").length === 1, previewNames("parent").join(", "));

  console.log("\n  -- and it is the child's stamp, not merely 'a child exists' --");

  plantFrame("parent", after.stamp);
  await pastMemo();
  eq("the parent caches again under the new stamp", (await manifest("parent")).grid.cached, 1);
  await updateComp("child", (d) => { d.duration = 3; return d; });
  const after2 = await manifest("parent");
  ok("a SECOND child edit moves it again", after2.stamp !== after.stamp,
    `${after.stamp} -> ${after2.stamp}`);
  eq("...and invalidates again", after2.grid.cached, 0);

  console.log("\n  -- all the way down, and only through layers that render --");

  await createComp("Grandchild");
  await updateComp("child", (d) => {
    d.layers = [{
      id: "ly_2", name: "the grandchild", type: "comp", src: "grandchild", enabled: true,
      in: 0, out: 5, blend: "normal",
      transform: { position: [0, 0, 0], scale: [100, 100, 100], rotation: 0, opacity: 100, anchor: [0, 0, 0] },
      effects: [], masks: [], trackMatte: null,
    }];
    return d;
  });
  const deep = await manifest("parent");
  await updateComp("grandchild", (d) => { d.linearLight = true; return d; });
  const deeper = await manifest("parent");
  ok("an edit TWO levels down moves the root's stamp — nesting is not one level",
    deeper.stamp !== deep.stamp, `${deep.stamp} -> ${deeper.stamp}`);

  /* A disabled comp layer is not resolved and not rendered, so it is not in the
   * key either — the same rule resolveChildComps applies, stated once and
   * followed in both places. */
  await updateComp("child", (d) => { d.layers[0].enabled = false; return d; });
  const offA = await manifest("parent");
  await updateComp("grandchild", (d) => { d.duration = 2; return d; });
  const offB = await manifest("parent");
  eq("a DISABLED comp layer is not drawn, so editing what it points at changes nothing",
    offB.stamp, offA.stamp);

  console.log("\n  -- a cycle is a render error, never a hang or a key that cannot be built --");

  await createComp("Loop");
  await updateComp("loop", (d) => {
    d.layers = [{
      id: "ly_3", name: "itself", type: "comp", src: "loop", enabled: true,
      in: 0, out: 5, blend: "normal",
      transform: { position: [0, 0, 0], scale: [100, 100, 100], rotation: 0, opacity: 100, anchor: [0, 0, 0] },
      effects: [], masks: [], trackMatte: null,
    }];
    return d;
  });
  const loop = await manifest("loop");
  ok("a comp that contains itself still produces a stamp", /^[0-9a-z]+$/.test(loop.stamp), loop.stamp);

  await updateComp("parent", (d) => {
    d.layers.push({
      id: "ly_4", name: "gone", type: "comp", src: "no-such-comp", enabled: true,
      in: 0, out: 5, blend: "normal",
      transform: { position: [0, 0, 0], scale: [100, 100, 100], rotation: 0, opacity: 100, anchor: [0, 0, 0] },
      effects: [], masks: [], trackMatte: null,
    });
    return d;
  });
  const broken = await manifest("parent");
  ok("...and so does one that points at a comp which does not exist — a missing "
    + "child is the RENDER's error to report, with the layer's name, not the cache's",
    /^[0-9a-z]+$/.test(broken.stamp), broken.stamp);
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
