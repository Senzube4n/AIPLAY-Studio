/**
 * FAST COVERS (server/fastcover.js, 2026-09-27): song covers from
 * Supra2-IMG on the processor, Settings > Experimental.
 *
 *   node --test server/fastcover_test.js
 *
 * No model and no Python: the art queue runs a stand-in program that writes
 * the two files and prints the result line, the way fastcover_run.py does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-fastcover-"));
process.env.AIPLAY_APPDATA = tmp;
process.env.AIPLAY_OUTPUT = path.join(tmp, "output");
mkdirSync(process.env.AIPLAY_OUTPUT, { recursive: true });

const { config, PREF_PATHS } = await import("./config.js");
const F = await import("./fastcover.js");
const { CATALOG } = await import("./models.js");
const { ArtRunner, ownProgram, COVER_DIR } = await import("./art.js");
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the prompt is visual nouns: a scene from the genre, the hook's things, no sung line, no 'no text'", () => {
  const p = F.fastCoverPrompt({ caption: "hip-hop, boom bap drums, male vocal",
    lyrics: "[Chorus]\nCheese in my bag, cheese on my plate\nCheese in my bag, cheese on my plate", seed: 1 });
  assert.equal(p, "cheese and plate in a city street at night with graffiti walls and streetlights, vibrant digital painting, cinematic lighting, detailed");
  /* Reported 2026-09-27: the song's subject, not the hook's first words. */
  assert.deepEqual(F.hookNouns("I love raw cheese \n\n".repeat(38))[0], "cheese");
  for (const caption of ["", "Global Metadata. 104 BPM", "trip-hop", "death metal", "folk", "synthwave"]) {
    const q = F.fastCoverPrompt({ caption, lyrics: "", seed: 7 });
    assert.doesNotMatch(q, /\bno (text|words|letters)\b|album|cover|"|evoking|mood/i, "words this model paints as lettering");
    assert.ok(q.length < 200, "well inside Flan-T5's 128 tokens");
  }
  assert.equal(F.fastCoverPrompt({ caption: "", lyrics: "", seed: 7 }), F.fastCoverPrompt({ caption: "", lyrics: "", seed: 7 }), "a song's cover is stable");
  assert.deepEqual(F.hookNouns("[Verse]\nOh baby, you know I'm gonna feel it tonight\nOh baby, you know I'm gonna feel it tonight"), []);
});

test("the runner's arguments and its result line", () => {
  const argv = F.fastCoverArgs({ models: "M", prompt: "p", seed: -12.7, out: "o.png", thumb: "t.png", size: 1024, thumbSize: 256 });
  assert.equal(argv[0], F.FAST_COVER_SCRIPT);
  assert.ok(F.FAST_COVER_SCRIPT.endsWith("fastcover_run.py") && existsSync(F.FAST_COVER_SCRIPT));
  assert.deepEqual(argv.slice(1), ["--models", "M", "--prompt", "p", "--seed", "12", "--steps", "25", "--cfg", "3",
    "--size", "1024", "--thumb-size", "256", "--out", "o.png", "--thumb", "t.png"]);
  assert.deepEqual(F.parseResult(`noise\n${F.RESULT_MARKER} {"steps":25}\n`), { steps: 25 });
  assert.equal(F.parseResult("Traceback"), null);
  const py = read("./fastcover_run.py");
  assert.match(py, /torch\.load\([^\n]*, weights_only=True\)/, "the pickle checkpoint loads tensors only, never code");
  assert.doesNotMatch(py, /weights_only=False/);
  assert.match(py, /HF_HUB_OFFLINE/, "nothing is fetched at draw time");
  assert.match(py, /RESULT_MARKER = "FASTCOVER_RESULT_JSON:"/);
});

test("the Models row is pinned and hashed, a tool and not a picture engine", async () => {
  const row = CATALOG.find((c) => c.id === F.FAST_COVER_ID);
  assert.ok(row);
  assert.equal(row.makes, undefined, "fit.js never offers it for the Pictures screen");
  assert.equal(row.files.length, 8);
  for (const f of row.files) {
    assert.match(f.url, /\/resolve\/[0-9a-f]{40}\//, `${f.url} pinned to a revision`);
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.bytes > 0);
  }
  assert.equal(path.basename(path.dirname(path.dirname(row.files[0].dest))), "fastcover");
  const { MODEL_TO_CAPABILITY } = await import("./models.js");
  assert.equal(MODEL_TO_CAPABILITY[F.FAST_COVER_ENGINE], F.FAST_COVER_ID, "its covers' ledger lines carry their rights, not `unknown`");
});

test("use(): on, answered, its Python there and every file present", async () => {
  const dir = path.join(tmp, "models", "fastcover");
  const row = { id: F.FAST_COVER_ID, files: [{ dest: path.join(dir, "supra2-img", "model_final_ema.pt"), bytes: 3 }] };
  const py = path.join(tmp, "py.exe");
  const saved = [];
  const svc = F.createFastCovers({ config, catalog: [row], models: { status: async () => [], download: async () => ({}) },
    setup: { status: async () => ({ setups: [] }), run: async () => ({}) }, save: async () => saved.push(1) });
  config.art.fastCovers = true; config.art.fastCoversAsked = false; config.art.fastCoverPython = null;
  assert.equal(svc.use(), false, "not answered yet: nothing is used");
  config.art.fastCoversAsked = true;
  assert.equal(svc.use(), false, "no Python");
  writeFileSync(py, ""); config.art.fastCoverPython = py;
  assert.equal(svc.use(), false, "no files");
  mkdirSync(path.dirname(row.files[0].dest), { recursive: true });
  writeFileSync(row.files[0].dest, "abc");
  assert.equal(svc.use(), true);
  config.art.fastCovers = false;
  assert.equal(svc.use(), false, "switched off");
  const s = await svc.setEnabled(true);
  assert.equal(s.enabled, true); assert.equal(s.asked, true); assert.equal(s.ready, true);
  assert.equal(saved.length, 1, "the switch is saved");
});

test("ensure(): switched on and answered, it fetches the files and builds its Python, once", async () => {
  const row = { id: F.FAST_COVER_ID, files: [{ dest: path.join(tmp, "nowhere", "x", "f.pt"), bytes: 3 }] };
  const calls = [];
  const svc = F.createFastCovers({ config, catalog: [row],
    models: { status: async () => [], download: async (id) => { calls.push(["download", id]); } },
    setup: { status: async () => ({ setups: [] }), run: async (id, o) => { calls.push(["setup", id, o.torch]); } }, save: async () => {} });
  config.art.fastCovers = true; config.art.fastCoversAsked = true; config.art.fastCoverPython = null;
  await Promise.all([svc.ensure(), svc.ensure()]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [["download", "fastCover"], ["setup", "covers", "cpu"]]);
  config.art.fastCoversAsked = false; calls.length = 0;
  await svc.ensure();
  assert.deepEqual(calls, [], "not answered: nothing is fetched");
});

test("the art queue: a song cover is drawn fast, without the engine, leaving the music model loaded", async () => {
  let unloads = 0;
  const music = { current: null, queue: [], loaded: { key: "minimax" }, artResident: false, unloadModels: async () => { unloads++; } };
  const runner = new ArtRunner({ ready: false }, music, {});
  const covers = [];
  runner.on("cover", (e) => covers.push(e));
  runner.fastCovers = {
    use: () => true,
    render: async (job, { out, thumb, run }) => {
      const code = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(out)},"p");fs.writeFileSync(${JSON.stringify(thumb)},"t");`
        + `console.log(${JSON.stringify(F.RESULT_MARKER)}+' {"steps":25,"cfg":3,"native":256,"drawSeconds":1}')`;
      const r = await run(() => spawn(process.execPath, ["-e", code]));
      return F.parseResult(r.stdout);
    },
  };
  const job = runner.request({ file: "aiplay_00001.flac", title: "One", caption: "folk", lyrics: "", seed: 3 });
  assert.equal(job.kind, "cover");
  assert.equal(job.fast, true);
  assert.equal(ownProgram(job), true, "Stop kills its program like a separation's");
  const deadline = Date.now() + 10_000;
  while (!covers.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(covers.length, 1, runner.lastError || "no cover event");
  assert.deepEqual(covers[0].covers, ["aiplay_00001.png"]);
  assert.deepEqual(covers[0].thumbs, ["aiplay_00001_t.png"]);
  assert.equal(covers[0].engine, F.FAST_COVER_ENGINE);
  assert.ok(existsSync(path.join(COVER_DIR, "aiplay_00001.png")));
  assert.equal(unloads, 0, "the music model stays on the card");
  assert.equal(music.artResident, false);

  const picture = runner.request({ file: "image:i123", title: "A picture", caption: "x", asked: true, seed: 1 });
  assert.equal(picture.fast, undefined, "the Pictures screen keeps the picture engines");
  runner.queue.length = 0;
  runner.fastCovers.use = () => false;
  assert.equal(runner.request({ file: "aiplay_00002.flac", caption: "folk", seed: 1 }).fast, undefined, "off: the covers engine");
  runner.queue.length = 0;
  /* Reported 2026-09-27: automatic covers off (the covers engine's switch)
   * and fast covers on, and no song got a cover by itself. */
  runner.enabled = false;
  runner.fastCovers.use = () => true;
  assert.equal(runner.request({ file: "aiplay_00003.flac", caption: "folk", seed: 1 })?.fast, true, "fast covers draw every song's cover");
  runner.queue.length = 0;
  runner.fastCovers.use = () => false;
  assert.equal(runner.request({ file: "aiplay_00004.flac", caption: "folk", seed: 1 }), null, "the engine's covers still follow its switch");
  runner.queue.length = 0;
});

test("wired: settings, the gate, the route, Music-only, provenance, the setup recipe and the page", async () => {
  const keys = PREF_PATHS.filter((p) => p[0] === "art").map((p) => p[1]);
  for (const k of ["fastCovers", "fastCoversAsked", "fastCoverPython"]) assert.ok(keys.includes(k), k);
  const index = read("./index.js");
  assert.match(index, /async function coverCanRun\(\) \{\n\s*\/\*[^\n]*\*\/\n\s*if \(fastCovers\.use\(\)\) return true;/);
  assert.match(index, /if \(p === "\/api\/fastcovers"\) \{/);
  assert.match(index, /if \(!sameOriginLocalJson\(req\)\) return json\(res, 403, \{ error: "Fast covers are switched/);
  assert.match(index, /if \(!h\.preview && config\.musicOnly && fastCovers\.use\(\) && \(job\.stages \? job\.stages\.cover : true\)\) \{/);
  assert.match(index, /model: engine === FAST_COVER_ENGINE \? engine : config\.art\.engine/);
  assert.match(index, /art\.fastCovers = fastCovers;/);
  const { coversRecipe, RECIPE_IDS } = await import("./setup/venv.js");
  const r = coversRecipe();
  assert.ok(RECIPE_IDS.includes("covers"));
  assert.equal(r.torchIndex, "cpu");
  assert.match(r.torch.indexUrl, /\/whl\/cpu$/);
  assert.ok(!r.torch.packages.includes("torchaudio"));
  assert.deepEqual(r.modules, ["torch", "transformers", "diffusers", "safetensors", "PIL"]);
  const html = read("../web/index.html");
  assert.match(html, /<section class="pcard" id="set-experimental" data-nav="Experimental">/);
  assert.match(html, /id="qFastCovers"/);
  assert.match(html, /<script type="module" src="fastcovers\.js"><\/script>/);
  const page = read("../web/fastcovers.js");
  assert.match(page, /import \{ appToggle \} from "\.\/dialog\.js";/, "Studio's own window, not the browser's");
  assert.doesNotMatch(page, /window\.confirm|localStorage/);
  assert.doesNotMatch(page, /—/, "no em dashes on screen");
  const { fastCoversChip } = await import("../web/fastcovers.js");
  assert.equal(fastCoversChip({ enabled: true, ready: true }).text, "Ready");
  assert.equal(fastCoversChip({ enabled: false }).text, "Off");
  assert.equal(fastCoversChip({ enabled: true, asked: true, downloading: { receivedBytes: 1, totalBytes: 4 } }).text, "Downloading 25%");
  assert.equal(fastCoversChip({ enabled: true, asked: true, error: "x" }).tone, "err");
  assert.match(read("../web/dialog.js"), /export const appToggle = \(message, opts = \{\}\) => open\("toggle", message, opts\);/);
});
