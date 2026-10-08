/**
 * THE MODELS SCREEN AND THE VIDEO SCREEN AGREE ABOUT THE VIDEO FILES, WITHOUT
 * A RESTART (setF, from a tester's report).
 *
 * The report: the Models screen listed "Video clips — MiniMax H3 (quantised)"
 * as installed, and the Video screen refused the render with "No video
 * weights on this machine yet. Get MiniMax H3 (0.0 GB) from the Models
 * screen". Its Fix opened a window whose H3 row said Installed, with nothing
 * to press. The cause: config.js picked every video file name once, while it
 * loaded, and only the speed-ups were ever picked again. A Studio started
 * before its H3 download finished kept the names pick() chose on an empty
 * disk, and two of those were not the files the Models row fetches (the
 * audio VAE everywhere, the DiT off the light machines). Also a DiT the
 * catalogue counted that no list loaded, a Models-screen stand-in the picks
 * never read, and (since the model subfolders) folders the Models screen and
 * the engine read that the picks did not: the rig's own ComfyUI/models and
 * the extra_model_paths YAML bases.
 *
 * Each case runs in its own process against a temp models folder and
 * settings.json, as Studio would: the tree's own config.js, models.js and
 * workflow.js, with the video gate and the ModelManager handlers lifted from
 * its server/index.js and run with their free names injected (index.js
 * itself would start a server). Placeholder files stand in for the weights,
 * with the catalogue's byte counts shrunk in that process to a few kB each so
 * nothing large is written; the exact-size rule is the catalogue's own.
 * Nothing is downloaded and nothing runs on a card.
 *
 *   node --test server/videopicks_test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = "AIPLAY_VIDEOPICKS_CHILD";
const MARK = "VIDEOPICKS ";

/* ───────────────────────────── the child: one process, one disk, one mode */
async function child() {
  const mode = process.env.VP_MODE;
  /* RAM pinned, so the light rule does not depend on the PC running this. */
  const ram = Number(process.env.VP_RAM_GB || 64) * 2 ** 30;
  os.totalmem = () => ram;
  const here = new URL("./", import.meta.url);
  const cfg = await import(new URL("config.js", here).href);
  const models = await import(new URL("models.js", here).href);
  const wf = await import(new URL("workflow.js", here).href);
  const { applyModelOverrides } = await import(new URL("localmodels.js", here).href);
  const { config } = cfg;
  const { CATALOG } = models;
  if (process.env.VP_ENGINE) config.video.engine = process.env.VP_ENGINE;

  /* The gate and the handlers, lifted from this tree's index.js. */
  const index = fs.readFileSync(new URL("index.js", here), "utf8").replace(/\r\n/g, "\n");
  const grab = (re) => (re.exec(index) || [""])[0];
  const gateSrc = grab(/async function videoWeightsGate\(\) \{[\s\S]*?\n\}/);
  if (!gateSrc) throw new Error("videoWeightsGate not found in index.js");
  const sizeSrc = grab(/function downloadSize\(bytes\) \{[\s\S]*?\n\}/);
  const readySrc = grab(/models\.on\("ready", \(id\) => \{[\s\S]*?\n\}\);/);
  const changedSrc = grab(/models\.on\("changed", \(ids\) => \{[\s\S]*?\n\}\);/);
  const freshSrc = grab(/function videoReadyFresh\(engine\) \{[\s\S]*?\n\}/);
  const mm = new models.ModelManager();
  const inj = {
    models: mm, config, CATALOG, MODEL_TO_CAPABILITY: models.MODEL_TO_CAPABILITY,
    resolveVideoEngine: wf.resolveVideoEngine, videoReady: wf.videoReady,
    isVideoRow: models.isVideoRow, refreshVideoPicks: cfg.refreshVideoPicks,
  };
  const names = Object.keys(inj);
  const lifted = new Function(...names,
    `${sizeSrc}\n${gateSrc}\n${readySrc}\n${changedSrc}\n${freshSrc}\nreturn { videoWeightsGate, videoReadyFresh };`)(...names.map((n) => inj[n]));
  const { videoWeightsGate, videoReadyFresh } = lifted;

  const MODELS = config.modelsDir;
  const RIG_MODELS = path.join(config.comfyDir, "models");
  const cap = (id) => CATALOG.find((c) => c.id === id);
  const base = (p) => path.basename(String(p));
  const folderOf = (f) => path.relative(MODELS, path.dirname(f.dest)).split(path.sep)[0];
  /* A few kB per file, the same in every process for the same name. */
  const small = (f) => 4096 + [...base(f.dest)].reduce((a, c) => a + c.charCodeAt(0), 0) % 997;
  const shrink = (id) => {
    for (const f of cap(id).defaultFiles || cap(id).files) {
      for (const g of [f, f.light, f.amd]) if (g) { try { g.bytes = small(g); } catch { /* a frozen entry keeps its size */ } }
    }
  };
  const place = (f, name = base(f.dest), folder = null, root = MODELS) => {
    const p = path.join(root, folder || folderOf(f), name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(f.bytes, 1));
    return p;
  };
  const land = (ids) => {
    for (const id of ids) { shrink(id); for (const f of cap(id).files) place(f); }
    for (const id of ids) { mm.emit("update"); mm.emit("ready", id); }
  };
  const ENGINE_ROWS = { h3: "video", fasth3: "videoFastH3", ltx: "videoLtx" };
  const picks = () => {
    const h = config.video.engines.h3, fast = config.video.engines.fasth3;
    return {
      h3: { dit: h.dit, ditRef: h.ditRef, textEncoder: h.textEncoder, videoVae: h.videoVae, audioVae: h.audioVae, refTurboLora4: h.refTurboLora4 },
      fasth3: { dit: fast.dit, textEncoder: fast.textEncoder, videoVae: fast.videoVae, audioVae: fast.audioVae },
      ltxVae: config.video.engines.ltx.videoVae,
      steps: h.steps,
      ready: Object.fromEntries(Object.keys(ENGINE_ROWS).map((k) => [k, wf.videoReady(k).ready])),
    };
  };
  const snap = async () => {
    const gate = await videoWeightsGate();
    const cat = await mm.status();
    const rows = Object.fromEntries(["video", "videoRefs", "videoFastH3", "videoLtx"].map((id) => {
      const r = cat.find((c) => c.id === id);
      return [id, { ready: r.ready, left: r.totalBytes - r.haveBytes, files: r.files.map((f) => base(f.dest)) }];
    }));
    return { ...picks(), rows, gate: gate.error ? { refused: true, ...gate.error } : { refused: false, engine: gate.engine } };
  };
  const out = { mode, light: isLight(), rowFiles: cap("video").files.map((f) => base(f.dest)) };
  function isLight() { return cfg.isLightH3 ? cfg.isLightH3(config) : null; }
  /* Studio's own boot: index.js takes the first look that "changed" compares with. */
  await mm.status();

  if (mode === "late") {
    /* The tester's case: Studio running, then the Models download finishes. */
    out.before = await snap();
    land((process.env.VP_ROWS || "video").split(","));
    out.afterReady = picks();          // the handlers alone, before any gate
    out.after = await snap();
  } else if (mode === "hand") {
    /* The same files copied in by hand: no download, so no "ready". */
    out.before = await snap();
    shrink("video");
    for (const f of cap("video").files) place(f);
    await mm.status();                 // what /api/status's disk reading does each minute
    out.afterStatus = picks();
    out.after = await snap();
  } else if (mode === "partial") {
    /* A download that stalled: the first file whole, the second a .part. */
    const [first, second] = cap("video").files;
    try { first.bytes = small(first); } catch { /* frozen */ }
    place(first);
    fs.mkdirSync(path.dirname(second.dest), { recursive: true });
    fs.writeFileSync(`${second.dest}.part`, Buffer.alloc(100, 1));
    out.partial = await snap();
    /* ...and then it finishes. */
    fs.rmSync(`${second.dest}.part`, { force: true });
    land(["video"]);
    out.afterReady = picks();
    out.done = await snap();
  } else if (mode === "stage") {
    /* Files on disk before Studio starts: the H3 row, its DiT as `variant`. */
    const variant = process.env.VP_VARIANT || "dest";
    shrink("video");
    const files = cap("video").files;
    const dit = files.find((f) => folderOf(f) === "diffusion_models");
    for (const f of files) {
      if (variant === "rig") { place(f, undefined, null, RIG_MODELS); continue; }
      if (f !== dit || variant === "dest") { place(f); continue; }
      if (variant === "standin") {
        /* A stand-in chosen on the Models screen, on the unet shelf. */
        place(f, "my_h3_dit.safetensors", "unet");
        const sf = path.join(process.env.AIPLAY_APPDATA, "settings.json");
        const s = JSON.parse(fs.readFileSync(sf, "utf8"));
        s.modelOverrides = { [base(f.dest)]: "my_h3_dit.safetensors" };
        fs.writeFileSync(sf, JSON.stringify(s));
      } else if (variant === "mixed") {
        place(f, "MiniMax_H3_FL2VA_pruned_mixed_int4_int8_convrot.safetensors");
      } else if (variant === "subfolder") {
        place(f, path.join("minimax-h3", base(f.dest)));
      } else throw new Error(`unknown variant ${variant}`);
    }
    out.staged = variant;
  } else if (mode === "boot") {
    /* The sizes the stage child wrote, for the files it wrote under their
     * own names; a file it did not write keeps its real size, so what is
     * left to download is said as it would be. */
    const leaves = new Set([MODELS, RIG_MODELS].flatMap((root) => {
      try { return fs.readdirSync(root, { recursive: true }).map((p) => base(p)); } catch { return []; }
    }));
    const written = (f) => leaves.has(base(f.dest));
    for (const f of cap("video").defaultFiles || cap("video").files) {
      for (const g of [f, f.light, f.amd]) if (g && written(g)) { try { g.bytes = small(g); } catch { /* frozen */ } }
    }
    await mm.status();
    out.boot = await snap();
    /* What the engine is sent: the graph after the engine door's rename. */
    const sent = applyModelOverrides(wf.videoGraph({ engine: "h3", prompt: "p", seed: 1, seconds: 2 }), config.modelOverrides);
    out.sent = [...new Set(Object.values(sent).flatMap((n) => Object.values(n?.inputs || {}))
      .filter((v) => typeof v === "string" && /\.safetensors$/.test(v)))];
    out.onDisk = [MODELS, RIG_MODELS].flatMap((root) => {
      try { return fs.readdirSync(root, { recursive: true }).map((p) => String(p).split(/[\\/]/).slice(1).join(path.sep)); } catch { return []; }
    }).filter((p) => /\.safetensors$/.test(p));
  } else if (mode === "tiny") {
    /* Everything but one small file: what is left is 30 MB. */
    shrink("video");
    const files = cap("video").files;
    const audio = files.find((f) => /audio_vae/.test(base(f.dest)));
    audio.bytes = 30_000_000;
    for (const f of files) if (f !== audio) place(f);
    await mm.status();
    out.tiny = await snap();
  } else if (mode === "stuck") {
    /* The Models row complete while the renderer cannot open a file: here a
     * name the catalogue is told to accept and no pick list names. */
    shrink("video");
    const files = cap("video").files;
    const audio = files.find((f) => /audio_vae/.test(base(f.dest)));
    audio.alt = [...(audio.alt || []), "test_only_audio_vae.safetensors"];
    for (const f of files) place(f, f === audio ? "test_only_audio_vae.safetensors" : undefined);
    await mm.status();
    out.stuck = await snap();
    out.audioDest = audio.dest;
  } else if (mode === "handgate") {
    /* H3 copied in by hand under a DiT build no list picks on an empty disk
     * (the int4), beside FastH3, and a clip asked for before anything looked
     * (no download event, no status()). The empty-disk picks call H3 missing
     * and FastH3 present, so the gate used to render on FastH3, where a
     * restart renders on H3. */
    const h = config.video.engines.h3, fast = config.video.engines.fasth3;
    out.bootPicks = { dit: h.dit, fastDit: fast.dit };
    const INT4 = "minimax_h3_fl2va_pruned_int4_convrot.safetensors";
    const at = (sub, name) => { const p = path.join(MODELS, sub, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(4096, 1)); };
    at("diffusion_models", INT4);
    at("diffusion_models", fast.dit);
    at("text_encoders", h.textEncoder);
    at("vae", h.videoVae);
    at("vae", h.audioVae);
    out.handgate = { gate: await videoWeightsGate(), dit: config.video.engines.h3.dit };
  } else if (mode === "ltxhand") {
    /* LTX copied in by hand (its row is access-gated, so there is no download
     * and no "ready"), its video VAE as the ComfyUI template's file, which
     * the row also accepts. The pick made on the empty disk named the other. */
    out.bootVae = config.video.engines.ltx.videoVae;
    shrink("videoLtx");
    for (const f of cap("videoLtx").files) place(f, /video-vae/.test(base(f.dest)) ? "ltx-2.5-video-vae-bf16.safetensors" : undefined);
    out.ltx = await snap();
    out.ltxFresh = videoReadyFresh("ltx").ready;
  } else if (mode === "cost") {
    /* What videoReady() stats on a disk without the files: the reasons for
     * a refusal (`files`) only when read, so /api/status, which resolves every
     * engine on every poll, pays what it paid before. */
    let stats = 0;
    const real = fs.statSync;
    fs.statSync = (...a) => { stats++; return real(...a); };
    const r = wf.videoReady("h3");
    const plain = stats;
    const files = r.files;
    const withFiles = stats;
    void r.files;
    const again = stats;
    fs.statSync = real;
    out.cost = { plain, withFiles, again, missing: r.missing.length, files: files.map((f) => f.reason),
      json: JSON.parse(JSON.stringify(r)) };
  } else if (mode === "agree") {
    /* Every name each engine's row accepts, one file at a time, placed and
     * then removed by hand, with only status() looking (no event, no gate). */
    const DIRS = new Set(["diffusion_models", "text_encoders", "vae", "latent_upscale_models"]);
    const wipe = () => { fs.rmSync(MODELS, { recursive: true, force: true }); fs.mkdirSync(MODELS, { recursive: true }); };
    out.cases = [];
    out.empty = {};
    for (const [engine, id] of Object.entries(ENGINE_ROWS)) {
      shrink(id);
      const files = cap(id).files;
      wipe();
      await mm.status();
      out.empty[engine] = { missing: wf.videoReady(engine).missing,
        downloads: files.filter((f) => DIRS.has(folderOf(f))).map((f) => base(f.dest)) };
      for (const [i, f] of files.entries()) {
        for (const name of [base(f.dest), ...(f.alt || [])]) {
          wipe();
          files.forEach((g, j) => place(g, j === i ? name : undefined));
          const row = (await mm.status()).find((c) => c.id === id);
          const here = wf.videoReady(engine);
          fs.rmSync(path.join(MODELS, folderOf(f), name), { force: true });
          const rowGone = (await mm.status()).find((c) => c.id === id);
          const gone = wf.videoReady(engine);
          out.cases.push({ engine, file: base(f.dest), name, folder: folderOf(f),
            rowReady: row.ready, ready: here.ready, missing: here.missing,
            rowGone: rowGone.ready, readyGone: gone.ready, missingGone: gone.missing });
        }
      }
    }
    /* A stand-in chosen while Studio runs (the Models screen's override). */
    shrink("video");
    const files = cap("video").files;
    const dit = files.find((f) => folderOf(f) === "diffusion_models");
    wipe();
    for (const f of files) if (f !== dit) place(f);
    place(dit, "my_h3_dit.safetensors", "unet");
    await mm.status();
    config.modelOverrides = { [base(dit.dest)]: "my_h3_dit.safetensors" };
    const row = (await mm.status()).find((c) => c.id === "video");
    out.standIn = { rowReady: row.ready, ready: wf.videoReady("h3").ready, dit: config.video.engines.h3.dit };
  } else throw new Error(`unknown mode ${mode}`);

  console.log(MARK + JSON.stringify(out));
}

if (process.env[CHILD]) {
  await child();
} else {
  /* ─────────────────────────────────────────────── the parent: the cases */
  const SHAPES = {
    nvidia16: { gpu: { vendor: "nvidia", name: "NVIDIA GeForce RTX 4070 Ti SUPER", totalMb: 16376 }, torchBackend: "cuda" },
    /* The tester's likely card: 960x544 is the 8 GB tier's size. */
    nvidia8: { gpu: { vendor: "nvidia", name: "NVIDIA GeForce RTX 4060", totalMb: 8188 }, torchBackend: "cuda" },
    amd: { gpu: { vendor: "amd", name: "AMD Radeon RX 9060 XT", totalMb: 16304 }, torchBackend: "rocm" },
    intel: { gpu: { vendor: "intel", name: "Intel Arc A770", totalMb: 16032 }, torchBackend: "xpu" },
    /* A CPU-only install with enough RAM not to be light. */
    cpu: { gpu: { vendor: "cpu", name: "CPU only", totalMb: 0 }, torchBackend: "cpu" },
    none: {},
  };
  /* `pinned`: the models folder pinned away from the rig (AIPLAY_MODELS_DIR),
   * as a ComfyUI Desktop install has it; the rig's own ComfyUI/models is then
   * a second folder the engine loads from. */
  const run = (shape, modes, env = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videopicks-"));
    try {
      fs.mkdirSync(path.join(dir, "settings"), { recursive: true });
      fs.mkdirSync(path.join(dir, "models"), { recursive: true });
      fs.writeFileSync(path.join(dir, "settings", "settings.json"), JSON.stringify(SHAPES[shape]));
      return modes.map((mode) => {
        const e = { ...process.env, ...env, [CHILD]: "1", VP_MODE: mode,
          AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: path.join(dir, "models"),
          AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output"), AIPLAY_GPU_HELPER: "0" };
        for (const k of ["NODE_TEST_CONTEXT", "AIPLAY_MUSIC_ONLY", "AIPLAY_CLOUD_ONLY", "AIPLAY_REMOTE_ONLY"]) delete e[k];
        const raw = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: e, encoding: "utf8", timeout: 120_000 });
        const line = raw.split(/\r?\n/).find((l) => l.startsWith(MARK));
        assert.ok(line, `the ${mode} child printed its result:\n${raw}`);
        return JSON.parse(line.slice(MARK.length));
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  /* Never a "0.0 GB" download, in any refusal. */
  const noZero = (s, where) => assert.doesNotMatch(String(s?.gate?.error || ""), /\b0\.0 GB\b/, `${where}: never "0.0 GB"`);
  const gbOf = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
  const DIT = { int8: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", w4a8: "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors" };
  const REF2VA = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
  const AUDIO = "minimax_h3_audio_vae_fp32.safetensors";

  test("the tester's case on every card: H3 lands while Studio runs, and the render goes through without a restart", () => {
    for (const shape of Object.keys(SHAPES)) {
      const [r, restart] = run(shape, ["late", "boot"], { VP_ROWS: "video,videoRefs,videoFastH3" });
      const light = r.light;
      /* Before: nothing on disk, the true download offered. */
      assert.equal(r.before.gate.refused, true, `${shape}: nothing on disk, refused`);
      assert.equal(r.before.gate.needsModel, "video", `${shape}: the H3 row offered`);
      assert.ok(r.before.gate.error.includes(`(${gbOf(r.before.rows.video.left)})`), `${shape}: the size left, ${r.before.gate.error}`);
      noZero(r.before, `${shape} before`);
      assert.equal(r.after.rows.video.ready, true, `${shape}: the Models screen says installed`);
      assert.deepEqual(r.after.gate, { refused: false, engine: "h3" }, `${shape}: and the Video screen renders on H3 (was: refused, "Get MiniMax H3 (0.0 GB)")`);
      noZero(r.after, `${shape} after`);
      /* The "ready" handlers alone pick every file again, before any gate. */
      assert.deepEqual(r.afterReady.ready, { h3: true, fasth3: true, ltx: false }, `${shape}: H3 and FastH3 read ready on "ready", before any render asks`);
      /* The names are the files the row fetched on this machine. */
      assert.equal(r.after.h3.dit, light ? DIT.w4a8 : DIT.int8, `${shape}: the DiT this row fetches`);
      assert.equal(r.after.h3.audioVae, AUDIO, `${shape}: the fp32 audio VAE, fetched on every card`);
      for (const k of ["dit", "textEncoder", "videoVae", "audioVae"]) {
        assert.ok(r.after.rows.video.files.includes(r.after.h3[k]), `${shape}: h3.${k} ${r.after.h3[k]} is a file of the row`);
      }
      assert.equal(r.after.h3.ditRef, REF2VA, `${shape}: the references row's DiT, picked when it lands`);
      assert.equal(r.after.h3.refTurboLora4, "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", `${shape}: and its speed-up`);
      assert.deepEqual([r.after.fasth3.textEncoder, r.after.fasth3.videoVae, r.after.fasth3.audioVae],
        [r.after.h3.textEncoder, r.after.h3.videoVae, r.after.h3.audioVae], `${shape}: FastH3 takes H3's encoder and VAEs again`);
      /* And what a restart on the same disk picks: the same, steps included. */
      assert.deepEqual({ h3: r.after.h3, fasth3: r.after.fasth3, ltxVae: r.after.ltxVae, steps: r.after.steps },
        { h3: restart.boot.h3, fasth3: restart.boot.fasth3, ltxVae: restart.boot.ltxVae, steps: restart.boot.steps },
        `${shape}: the running Studio picks what a restart picks`);
    }
  });

  test("files copied in by hand are found at the next look, without a download event", () => {
    for (const shape of ["nvidia8", "amd"]) {
      const [r] = run(shape, ["hand"]);
      assert.equal(r.afterStatus.ready.h3, true, `${shape}: the Models screen's own look (status) picks the files again`);
      assert.deepEqual(r.after.gate, { refused: false, engine: "h3" }, `${shape}: and it renders`);
    }
  });

  test("H3 copied in beside FastH3 renders on H3 before anything looks, not on FastH3", () => {
    for (const shape of ["nvidia8", "amd", "none"]) {
      const [r] = run(shape, ["handgate"]);
      assert.notEqual(r.bootPicks.dit, "minimax_h3_fl2va_pruned_int4_convrot.safetensors", `${shape}: the empty disk picked another DiT build`);
      assert.deepEqual(r.handgate.gate.engine, "h3", `${shape}: the gate looks again before rendering on another engine than the chosen one (was: FastH3)`);
      assert.equal(r.handgate.dit, "minimax_h3_fl2va_pruned_int4_convrot.safetensors", `${shape}: and H3 loads the build on disk`);
    }
  });

  test("FastH3 chosen and downloaded alone while Studio runs renders on FastH3, and its own row was the one offered", () => {
    for (const shape of ["nvidia16", "amd"]) {
      const [r] = run(shape, ["late"], { VP_ROWS: "videoFastH3", VP_ENGINE: "fasth3" });
      assert.equal(r.before.gate.refused, true);
      assert.equal(r.before.gate.needsModel, "videoFastH3", `${shape}: the chosen engine's own row (was: H3's, ${r.before.gate.error})`);
      assert.ok(r.before.gate.error.includes(`Get FastH3 (${gbOf(r.before.rows.videoFastH3.left)})`), `${shape}: ${r.before.gate.error}`);
      assert.equal(r.after.rows.videoFastH3.ready, true, `${shape}: the FastH3 row reads installed`);
      assert.deepEqual(r.after.gate, { refused: false, engine: "fasth3" }, `${shape}: and FastH3 renders (was: "Get MiniMax H3", its audio VAE stale)`);
      assert.equal(r.after.fasth3.audioVae, AUDIO, `${shape}: FastH3's copy of H3's audio VAE is the file its row fetched`);
    }
  });

  test("LTX copied in by hand with the template's video VAE renders on LTX without a restart", () => {
    for (const shape of ["nvidia16", "amd"]) {
      const [r] = run(shape, ["ltxhand"], { VP_ENGINE: "ltx" });
      assert.equal(r.bootVae, "ltx-2.5-video-vae-conv-bf16.safetensors", `${shape}: an empty disk names the VAE the LTX row fetches`);
      assert.equal(r.ltx.rows.videoLtx.ready, true, `${shape}: the LTX row counts the template's VAE`);
      assert.deepEqual(r.ltx.gate, { refused: false, engine: "ltx" }, `${shape}: and the gate renders on LTX (was: "Get MiniMax H3")`);
      assert.equal(r.ltx.ltxVae, "ltx-2.5-video-vae-bf16.safetensors", `${shape}: on the file that is on disk`);
      assert.equal(r.ltxFresh, true);
    }
  });

  test("videoReady works out a refusal's reasons only when they are read, and sends what it sent before", () => {
    const [r] = run("nvidia8", ["cost"]);
    const c = r.cost;
    assert.equal(c.missing, 4, "nothing on disk: H3's four files are missing");
    assert.ok(c.withFiles > c.plain, "reading `files` looks at the disk for the reasons");
    assert.equal(c.again, c.withFiles, "and only the first time it is read");
    assert.deepEqual(c.files, ["missing", "missing", "missing", "missing"]);
    assert.deepEqual(Object.keys(c.json).sort(), ["missing", "ready"], "what a reply that sends it whole carries is unchanged");
  });

  test("a stalled download is refused with the real size left, and renders once it finishes", () => {
    for (const shape of ["nvidia8", "amd", "cpu"]) {
      const [r] = run(shape, ["partial"]);
      assert.equal(r.partial.rows.video.ready, false, `${shape}: a .part is not a file`);
      assert.equal(r.partial.gate.refused, true);
      assert.equal(r.partial.gate.needsModel, "video", `${shape}: the Download is offered`);
      assert.ok(r.partial.rows.video.left > 1e9, `${shape}: gigabytes are left`);
      assert.ok(r.partial.gate.error.includes(`(${gbOf(r.partial.rows.video.left)})`), `${shape}: and said: ${r.partial.gate.error}`);
      noZero(r.partial, `${shape} partial`);
      assert.equal(r.afterReady.ready.h3, true, `${shape}: once it finishes, H3 reads ready`);
      assert.deepEqual(r.done.gate, { refused: false, engine: "h3" }, `${shape}: and renders without a restart`);
    }
  });

  test("files there when Studio starts: the download, a stand-in, a subfolder, the rig's own models folder and the old mixed DiT, and the two screens agree", () => {
    for (const shape of ["nvidia8", "amd"]) {
      const [, plain] = run(shape, ["stage", "boot"], { VP_VARIANT: "dest" });
      assert.equal(plain.boot.rows.video.ready, true, `${shape}: installed`);
      assert.deepEqual(plain.boot.gate, { refused: false, engine: "h3" }, `${shape}: renders`);
      for (const f of plain.sent) assert.ok(plain.onDisk.some((p) => path.basename(p) === path.basename(f)), `${shape}: the graph names ${f}, which is on disk`);

      /* A Models-screen stand-in for the DiT, on the unet shelf. */
      const [, stand] = run(shape, ["stage", "boot"], { VP_VARIANT: "standin" });
      assert.equal(stand.boot.rows.video.ready, true, `${shape}: the Models screen counts the stand-in`);
      assert.deepEqual(stand.boot.gate, { refused: false, engine: "h3" }, `${shape}: and the Video screen renders (was: refused, "(0.0 GB)", after a restart too)`);
      assert.ok(stand.sent.includes("my_h3_dit.safetensors"), `${shape}: the engine is sent the stand-in, by the door's rename`);

      /* The DiT in a subfolder of its shelf (the organised model folders). */
      const [, sub] = run(shape, ["stage", "boot"], { VP_VARIANT: "subfolder" });
      assert.equal(sub.boot.rows.video.ready, true, `${shape}: the Models screen finds the DiT in its subfolder`);
      assert.deepEqual(sub.boot.gate, { refused: false, engine: "h3" }, `${shape}: and it renders`);
      assert.equal(path.dirname(sub.boot.h3.dit), "minimax-h3", `${shape}: the graph names it by its path in the shelf (${sub.boot.h3.dit})`);

      /* The models folder pinned elsewhere, H3 in the rig's own ComfyUI/models,
       * which the engine and the Models screen both read. */
      const [, rig] = run(shape, ["stage", "boot"], { VP_VARIANT: "rig" });
      assert.equal(rig.boot.rows.video.ready, true, `${shape}: the Models screen counts the rig's own models folder`);
      assert.deepEqual(rig.boot.gate, { refused: false, engine: "h3" }, `${shape}: and so does the Video screen (was: refused, "Get MiniMax H3 (0.0 GB)", after a restart too)`);
      noZero(rig.boot, `${shape} rig`);
    }
    /* A DiT the catalogue counted and no pick list loaded: it no longer counts,
     * so both screens say the DiT is to download, and the size is true. */
    const [, mixed] = run("nvidia8", ["stage", "boot"], { VP_VARIANT: "mixed" });
    assert.equal(mixed.boot.rows.video.ready, false, "the mixed DiT is not H3's DiT on the Models screen");
    assert.equal(mixed.boot.gate.refused, true);
    assert.equal(mixed.boot.gate.needsModel, "video");
    assert.ok(mixed.boot.gate.error.includes(`(${gbOf(mixed.boot.rows.video.left)})`), mixed.boot.gate.error);
    noZero(mixed.boot, "mixed");
  });

  test("the refusal never offers a 0.0 GB download, and a file it cannot open is named with its path", () => {
    const [tiny] = run("nvidia8", ["tiny"]);
    assert.equal(tiny.tiny.gate.refused, true);
    assert.match(tiny.tiny.gate.error, /Get MiniMax H3 \(30 MB\) from the Models screen/, "30 MB left is said in MB");
    noZero(tiny.tiny, "tiny");

    for (const shape of ["nvidia8", "amd"]) {
      const [s] = run(shape, ["stuck"]);
      const g = s.stuck.gate;
      assert.equal(s.stuck.rows.video.ready, true, `${shape}: the Models row reads complete`);
      assert.equal(g.refused, true, `${shape}: the renderer cannot open the audio VAE`);
      noZero(s.stuck, `${shape} stuck`);
      assert.doesNotMatch(g.error, /\bGB\b|\bMB\b/, `${shape}: no download is offered: ${g.error}`);
      assert.ok(g.error.includes(AUDIO) && g.error.includes(s.audioDest), `${shape}: the file and the path it was looked for at: ${g.error}`);
      assert.match(g.error, /^The Models screen lists MiniMax H3 as installed, but Studio cannot open one of its files: /);
      assert.equal(g.needsModel, null, `${shape}: no window offering a row that says Installed`);
      assert.equal(g.recheck?.capabilityId, "video", `${shape}: Fix looks again instead`);
      assert.deepEqual(g.recheck.files.map((f) => [f.name, f.reason, f.path]), [[AUDIO, "missing", s.audioDest]]);
    }
  });

  test("every name a video row accepts is one its engine loads, a file that goes is let go, and the last name is the download", () => {
    for (const shape of ["nvidia16", "nvidia8", "amd", "cpu"]) {
      const [r] = run(shape, ["agree"]);
      assert.ok(r.cases.length >= 20, `${shape}: ${r.cases.length} cases`);
      for (const c of r.cases) {
        const at = `${shape} ${c.engine}: ${c.file} as ${c.name}`;
        assert.equal(c.rowReady, true, `${at}: the row counts it`);
        if (["diffusion_models", "text_encoders", "vae", "latent_upscale_models"].includes(c.folder)) {
          assert.equal(c.ready, true, `${at}: and the engine loads it (missing ${c.missing})`);
          assert.equal(c.rowGone, false, `${at}: removed, the row says so`);
          assert.equal(c.readyGone, false, `${at}: and so does the engine`);
          assert.ok(c.missingGone.includes(c.file), `${at}: removed, the file named missing is the row's download, ${c.missingGone}`);
        }
      }
      for (const [engine, e] of Object.entries(r.empty)) {
        assert.deepEqual([...e.missing].sort(), [...e.downloads].sort(), `${shape} ${engine}: nothing on disk names the row's downloads`);
      }
      assert.deepEqual(r.standIn, { rowReady: true, ready: true, dit: r.light ? DIT.w4a8 : DIT.int8 },
        `${shape}: a stand-in chosen while Studio runs: the graph keeps the name the door renames`);
    }
  });

  test("index.js looks at start, on every video row that lands or goes, and before refusing", () => {
    const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const index = read("./index.js");
    assert.match(index, /\nrefreshVideoPicks\(\);\nmodels\.on\("ready", \(id\) => \{\n  if \(isVideoRow\(id\)\) refreshVideoPicks\(\);\n\}\);/,
      "at start, and on a download of any video row (the speed-ups among them)");
    assert.match(index, /models\.on\("changed", \(ids\) => \{\n  if \(ids\.some\(\(id\) => isVideoRow\(id\)\)\) refreshVideoPicks\(\);\n\}\);\n\/\*[^\n]*\*\/\nmodels\.status\(\)\.catch\(\(\) => \{\}\);/,
      "on files that came or went without one, from a first look at start");
    const gate = /async function videoWeightsGate\(\) \{[\s\S]*?\n\}/.exec(index)[0];
    assert.match(gate, /if \(resolution\.ready && !resolution\.substituted\) return \{ engine: resolution\.key, resolution \};\n  refreshVideoPicks\(\);\n  resolution = resolveVideoEngine\(\);/,
      "the gate looks again before it refuses, and before it renders on another engine than the chosen one");
    assert.doesNotMatch(gate, /toFixed\(1\)/, "sizes go through downloadSize");
    assert.match(index, /const vr = videoReadyFresh\(\);\n\s+if \(vr\.ready\) \{\n\s+art\.request\(\{ file: h\.file/, "a batch's video stage looks again before it fails");
    assert.match(index, /config\.modelOverrides = next;\n\s+musicChoicesCache\.at = 0;\n(\s+\/\*[\s\S]*?\*\/\n)?\s+refreshVideoPicks\(\);/, "a stand-in chosen is picked at once");
    for (const [door, re] of [["the extend door", /const vr = videoReadyFresh\("h3"\);\n\s+if \(!vr\.ready\) return json\(res, 400, \{ error: `Continuing a clip/],
      ["restyle", /const vr = videoReadyFresh\("ltx"\);\n\s+if \(!vr\.ready\) return json\(res, 400, \{ error: `LTX is not installed/],
      ["the lending doors", /const readiness = videoReadyFresh\("h3"\);\n\s+if \(!readiness\.ready\) return json\(res, 409/],
      ["the music video's LTX routing", /ltxReady: \(\) => videoReadyFresh\("ltx"\)\.ready,/]]) {
      assert.match(index, re, `${door} looks again too`);
    }
    assert.match(index, /const gb = downloadSize\(cap\.totalBytes - cap\.haveBytes\);\n[\s\S]{0,800}is not downloaded yet \(\$\{gb\} missing\)/,
      "the engine switch never says 0.0 GB either");
  });

  test("the Models screen, the engine door and the picks read the same folders", () => {
    const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.match(read("./models.js"), /async function catalogShelf\(\) \{\n\s+return scanBases\(await engineBases\(config\)\);/);
    assert.match(read("./engine/client.js"), /const files = await scanBases\(await engineBases\(config\)\);/);
    assert.match(read("./index.js"), /async function modelBases\(\) \{\n\s+return engineBases\(config\);/);
    assert.match(read("./config.js"), /const shelfBases = \(\) => engineBasesSync\(live \|\|/);
    assert.match(read("./workflow.js"), /const bases = engineBasesSync\(config\);/);
  });

  test("Fix and the model window lead somewhere that works when the row says Installed", () => {
    const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.match(read("../web/receipt.js"), /const fixable = !!\(reply\?\.needsModel \|\| reply\?\.capability \|\| reply\?\.recheck\);/,
      "a refusal with recheck gets a Fix button");
    const app = read("../web/app.js");
    const offer = app.slice(app.indexOf("function offerModel(r) {"));
    assert.ok(offer.indexOf("if (r?.recheck?.capabilityId) {") < offer.indexOf("const id = typeof r?.needsModel"),
      "offerModel answers recheck before it looks for a row to download");
    assert.match(offer, /openModelPicker\(\{\n\s+kind: "auto", focus: r\.recheck\.capabilityId, recheck: true,/);
    const pick = read("../web/modelpick.js");
    assert.match(pick, /current\.recheck && c\.id === current\.focus\n\s+\? ` <button class="btn sm mp-get" type="button" data-recheck="\$\{esc\(c\.id\)\}">Look again<\/button>`/,
      "the installed row gets Look again");
    assert.match(pick, /const again = e\.target\.closest\("\[data-recheck\]"\);[\s\S]*?body: JSON\.stringify\(\{ action: "check" \}\)[\s\S]*?found = !!r\?\.engine;[\s\S]*?current\?\.onRecheck\?\.\(found\);\n(\s+\/\*[^\n]*\*\/\n)?\s+paint\(\);\n\s+return;/,
      "which asks the video gate (a plan check), an engine in the answer means found, and the rows are read again");
    assert.match(offer, /const fromVideoGate = !!r && Object\.prototype\.hasOwnProperty\.call\(r, "configuredEngine"\);\n\s+openModelPicker\(\{\n\s+kind: "auto", focus: id, title,[\s\S]*?\.\.\.\(fromVideoGate \? \{ recheck: true,\n\s+onRecheck: \(found\) => \{ if \(found && typeof globalThis\.aiplayStartOk === "function"\) globalThis\.aiplayStartOk\("vidEst"\); \} \} : \{\}\),/,
      "a download the video gate offered gets Look again once its row is installed");
    const gateSrc = /async function videoWeightsGate\(\) \{[\s\S]*?\n\}/.exec(read("./index.js"))[0];
    assert.match(gateSrc, /needsModel: want \? want\.capabilityId : null,[\s\S]*?configuredEngine: resolution\.configured,/,
      "and the gate's download refusal names configuredEngine, which is how the page knows it");
    /* The window's Download button says what is left, never "0.0 GB". */
    const gbSrc = /const gb = \(b\) => \{[\s\S]*?\n\};/.exec(pick)?.[0];
    assert.ok(gbSrc, "the window's size words");
    const gb = new Function(`${gbSrc}\nreturn gb;`)();
    for (const b of [1, 30e6, 5e7, 53e6, 1e9, 21.9e9]) assert.doesNotMatch(gb(b), /^0\.0 GB$/, `${b} bytes`);
    assert.equal(gb(30e6), "29 MB");
    assert.equal(gb(21.9e9), "20.4 GB");
  });
}
