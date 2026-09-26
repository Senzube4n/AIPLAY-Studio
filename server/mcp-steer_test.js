/**
 * Steering, 2026-09-17: the simple way on the page, and the last MCP gaps.
 *
 * §1 the Video screen's quality chips are the step slider in three words, and
 * every number on them is the server's: config.js resolves Fast, Standard and
 * Best from the turbo files on disk (four disks are built in a temp folder and
 * read through its own pick()), the status sends them, the slider opens on
 * Standard, and make_clip's quality words map through the same numbers. The
 * row hides with the slider on LTX. §2
 * make_song declares and forwards every dial the door range-checks. §3
 * set_image_engine and download_model exist, post the right doors, send the
 * territory acknowledgement only when it is true, and are withheld from the
 * in-app chat by sentence. No card.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TOOLS } from "./mcp.js";
import { ROUTABLE, WITHHELD } from "./chat/router.js";
import { config } from "./config.js";
import { KNOBS } from "./videolab/catalog.js";
import { COST_ROWS } from "./mv/plancost.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tool = (name) => TOOLS.find((t) => t.name === name);

console.log("\n§1  the simple way on the Video screen");
{
  const html = src("../web/index.html"), app = src("../web/app.js"), index = src("./index.js");
  ok("three chips above More controls", /id="vidQualityRow"[\s\S]*?data-vq="fast"[\s\S]*?data-vq="standard"[\s\S]*?data-vq="best"[\s\S]*?id="vidAdv"/.test(html));
  ok("...a click sets the slider and repaints", /\$\("vidSteps"\)\.value = String\(steps\);\n\s+vidPaint\(\);/.test(app));
  ok("...the chips light up on the slider's value", /aria-pressed", !get && stNow === want \? "true" : "false"/.test(app));
  /* ...and in RunPod GPU mode (`remote`), where the Pod's LTX preset takes no steps. */
  ok("...and the row hides with the slider on LTX and on a fixed-step engine (FastH3)",
    /const noSteps = remote \|\| cur === "ltx" \|\| !!eng\.fixedSteps;/.test(app) && /qRow\.hidden = noSteps;/.test(app));
  ok("the status carries turbo3Ready per engine", /turbo3Ready: \/taomate\/i\.test\(String\(e\.turboLora3 \|\| ""\)\),/.test(index));

  /* EVERY STEP COUNT ON THE SCREEN IS THE SERVER'S, and the server's follows
   * the disk. The chips' numbers used to be literals (Fast 3-or-8, Standard 8,
   * Best 20) and the slider opened on a typed 8, which on a Models-screen
   * install (it fetches the 4-step turbo files only) ran a 4-step LoRA at 8
   * steps. Now config.js resolves stepDefaults from what pick() found, the
   * status sends them, and app.js reads them through one function. That
   * function is lifted out and run here with only the names it reads. */
  /* Keep my character adds an optional second argument (2026-09-24): the
   * one-argument answer is unchanged. */
  const qsSrc = /\nfunction vidQualitySteps\(eng(?:, keeping = false)?\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] || "";
  const vidQualitySteps = (() => { try { return new Function(qsSrc + "return vidQualitySteps;")(); } catch { return () => ({}); } })();
  ok("the status sends the disk's step defaults, its builds and each file's step count",
    /stepDefaults: e\.stepDefaults \?\? null,/.test(index) && /turboBuilds: e\.turboBuilds \?\? null,/.test(index)
    && /loraSteps: Object\.fromEntries\(\["turboLora", "turboLora4", "turboLora3", "refTurboLora", "refTurboLora4"\]\s*\.map\(\(k\) => \[k, loraStepsOf\(e\[k\]\)\]\)\)/.test(index));
  ok("the chips and their click read vidQualitySteps, not literals",
    /const want = qs\[b\.dataset\.vq\];/.test(app) && /const steps = vidQualitySteps\(eng(?:, !!state\.vidKeeping)?\)\[b\.dataset\.vq\];/.test(app)
    && /small\.textContent = want \+ " steps";/.test(app) && !/eng\.turbo3Ready \? 3 : 8/.test(app));
  /* With the speed-ups known (turboBuilds) Fast is TaoMate's 3 and always
   * shows, dimmed when its file is missing (server/taomate_test.js). */
  ok("...and Fast hides where it would equal Standard, only without the builds",
    /\$\("vidQFast"\)\.hidden = !tb && qs\.fast === qs\.standard;/.test(app));
  ok("the slider opens on Standard, once, from the status",
    /if \(!state\.vidStepsOpened && eng\.stepDefaults\) \{\n\s+state\.vidStepsOpened = true;\n\s+\$\("vidSteps"\)\.value = String\(vidQualitySteps\(eng\)\.standard\);/.test(app));
  /* Before the first status lands the page shows index.html's typed numbers,
   * so they must be vidQualitySteps' own fallbacks: the slider, its readout
   * and the Standard chip on one number no chip is missing, Fast hidden
   * because it would equal Standard. */
  const slider = /<input id="vidSteps"[^>]*\bvalue="(\d+)"/.exec(html)?.[1];
  const readout = /<b id="vidStepsV">(\d+)<\/b>/.exec(html)?.[1];
  const chipOf = (vq) => new RegExp(`data-vq="${vq}"[^>]*>\\w+<small>(\\d+) steps</small>`).exec(html)?.[1];
  const fb = vidQualitySteps({});
  ok("before the status, the page shows vidQualitySteps' fallbacks",
    Number(slider) === fb.standard && readout === slider && Number(chipOf("standard")) === fb.standard
    && Number(chipOf("fast")) === fb.fast && Number(chipOf("best")) === fb.best && /id="vidQFast" hidden/.test(html),
    `slider ${slider}, readout ${readout}, chips ${chipOf("fast")}/${chipOf("standard")}/${chipOf("best")}, fallbacks ${JSON.stringify(fb)}`);
  ok("...and this process's config agrees with itself: steps IS stepDefaults.standard",
    config.video.engines.h3.steps === config.video.engines.h3.stepDefaults?.standard,
    `steps ${config.video.engines.h3.steps}, stepDefaults ${JSON.stringify(config.video.engines.h3.stepDefaults)}`);

  /* THE DISKS, THROUGH config.js's OWN pick(). Each is a temp models folder
   * holding only the named LoRA files (a byte each: pick() wants size > 0),
   * read by a child process the way models-screen_test.js reads a fresh
   * install. Nothing is written outside the temp folder. */
  const L = {
    fl2v8: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
    fl2v4: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
    ref8: "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
    ref4: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    tao: "taomate_h3_3step_comfy.safetensors",
  };
  const url = (rel) => JSON.stringify(new URL(rel, import.meta.url).href);
  const probe = `import { config, loraStepsOf } from ${url("./config.js")}; import { h3TurboLoraFor } from ${url("./workflow.js")};`
    + "const h3 = config.video.engines.h3, eng = { ...config.video, ...h3 };"
    + "const slots = ['turboLora', 'turboLora4', 'turboLora3', 'refTurboLora', 'refTurboLora4'];"
    + "const at = (refs) => loraStepsOf(h3TurboLoraFor(eng, { refs }).lora);"
    + "console.log(JSON.stringify({ steps: h3.steps, stepDefaults: h3.stepDefaults, turboBuilds: h3.turboBuilds,"
    + " loraSteps: Object.fromEntries(slots.map((k) => [k, loraStepsOf(h3[k])])), loaded: { fl2v: at(false), refs: at(true) },"
    + " turboMaxSteps: h3.turboMaxSteps, turbo3MaxSteps: h3.turbo3MaxSteps, turbo4MaxSteps: h3.turbo4MaxSteps }));";
  /* `extra`: the files go in a SECOND models folder named in settings
   * `modelsAlso` ("Add as extra", or the folder "Use this folder" left
   * behind), and the main folder holds no LoRA at all. The engine loads from
   * both, so pick() and the step defaults must both look in both. */
  const disk = (files, { extra = false } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-disk-"));
    try {
      const shelf = path.join(dir, extra ? "extra" : "models", "loras");
      fs.mkdirSync(path.join(dir, "models", "loras"), { recursive: true });
      fs.mkdirSync(shelf, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(shelf, f), "x");
      if (extra) {
        fs.mkdirSync(path.join(dir, "settings"), { recursive: true });
        fs.writeFileSync(path.join(dir, "settings", "settings.json"), JSON.stringify({ modelsAlso: [path.join(dir, "extra")] }));
      }
      const env = { ...process.env, AIPLAY_APPDATA: path.join(dir, "settings"), AIPLAY_MODELS_DIR: path.join(dir, "models"),
        AIPLAY_RIG: path.join(dir, "rig"), AIPLAY_OUTPUT: path.join(dir, "output") };
      delete env.AIPLAY_MUSIC_ONLY;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 60_000 });
      return JSON.parse(out.trim().split("\n").at(-1));
    } catch (e) { return { error: String(e.message || e).slice(0, 300) }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rig = disk([L.fl2v8, L.fl2v4, L.ref8, L.ref4, L.tao]);          // this rig: fetched by hand
  const shop = disk([L.fl2v4, L.ref4]);                                 // the Models screen's "video" + "videoRefs"
  const shopTao = disk([L.fl2v4, L.ref4, L.tao]);                        // ...plus its TaoMate row
  const halfEight = disk([L.fl2v8, L.fl2v4, L.ref4]);                    // an 8-step file on ONE path only
  ok("a disk with both 8-step builds defaults to 8: Fast 3 with TaoMate, Best 20",
    rig.steps === 8 && same(rig.stepDefaults, { fast: 3, standard: 8, best: 20 })
    && same(rig.turboBuilds, { three: true, four: true, eight: true }), JSON.stringify(rig));
  ok("the Models screen's disk (4-step files only) defaults to 4, never 8 and never the bare 20",
    shop.steps === 4 && same(shop.stepDefaults, { fast: 4, standard: 4, best: 20 })
    && same(shop.turboBuilds, { three: false, four: true, eight: false }), JSON.stringify(shop));
  ok("...with TaoMate installed, Fast is 3 and Standard stays 4",
    shopTao.steps === 4 && same(shopTao.stepDefaults, { fast: 3, standard: 4, best: 20 }), JSON.stringify(shopTao));
  ok("8 needs BOTH paths: the fl2v 8-step alone, with only the ref2v 4-step, stays 4",
    halfEight.steps === 4 && halfEight.stepDefaults?.standard === 4 && halfEight.turboBuilds?.eight === false, JSON.stringify(halfEight));
  /* THE SECOND MODELS FOLDER. pick() and the step defaults ask one onDisk(),
   * and it searches every folder the engine loads from. Asked two ways, a
   * LoRA only in the extra folder made pick() choose the 8-step file while
   * the step defaults, looking in the main folder alone, said 4: an 8-step
   * distillation run at 4 steps on every render that named no count. */
  const extraRig = disk([L.fl2v8, L.fl2v4, L.ref8, L.ref4, L.tao], { extra: true });
  ok("with every LoRA in an EXTRA models folder, the answers equal the same files in the main one",
    !extraRig.error && same(extraRig, rig), JSON.stringify(extraRig));
  ok("...8-step names, Standard 8, and the 8-step builds counted",
    extraRig.loraSteps?.turboLora === 8 && extraRig.stepDefaults?.standard === 8 && extraRig.turboBuilds?.eight === true
    && extraRig.steps === 8, JSON.stringify(extraRig));
  ok("config.js: pick() and the step defaults share ONE onDisk(), and it reads the extra folders",
    /const pick = \(sub, \.\.\.names\) => names\.find\(\(n\) => onDisk\(sub, n\)\)/.test(src("./config.js"))
    && (src("./config.js").match(/function onDisk\(/g) || []).length === 1
    && /function onDisk\(sub, name\) \{\n\s+const bases = \[MODELS_DIR, \.\.\.MODELS_ALSO\];/.test(src("./config.js")));
  /* The point of all of it: on every disk the default loads a file distilled
   * for exactly that many steps, on both paths, which is what workflow.js
   * h3TurboLoraFor picks when a render names no step count. */
  for (const [name, d] of [["the hand-fetched disk", rig], ["the Models screen's disk", shop], ["Models screen + TaoMate", shopTao], ["the one-path 8-step disk", halfEight]]) {
    ok(`${name}: the default step count loads a matched file on both paths`,
      !d.error && d.loaded?.fl2v === d.steps && d.loaded?.refs === d.steps && d.steps <= d.turboMaxSteps, JSON.stringify(d));
  }
  ok("...and the screen's chips read those numbers as they are",
    same(vidQualitySteps({ stepDefaults: shop.stepDefaults }), shop.stepDefaults)
    && same(vidQualitySteps({ stepDefaults: rig.stepDefaults }), rig.stepDefaults));

  /* WHAT THE ESTIMATE SAYS AT EACH SETTING, on those same disks. The lines are
   * lifted out of vidPaint and run with only the names they read, so this
   * pins what the screen says, not how it is spelled. A build is named by the
   * file's own step count: the old text named it by turbo4MaxSteps, a
   * threshold of 5, and said "5-step build run at 8 steps" for a 4-step file. */
  const lines = /\n  const hasRefs = [\s\S]*?\n  const betweenBuilds = [^\n]*\n/.exec(app)?.[0] || "";
  const paint = (d, st, refs) => {
    try {
      /* `keeping` is vidPaint's own (a picture or a saved character on H3,
       * 2026-09-24): a reference picture here keeps. */
      return new Function("state", "eng", "cur", "st", "t4", "t8", "keeping",
        lines + "return { stepPath, mismatch, betweenBuilds };")(
        { refImages: refs ? ["x.png"] : [], refAudios: [] }, { loraSteps: d.loraSteps, turbo3MaxSteps: d.turbo3MaxSteps },
        "h3", st, d.turbo4MaxSteps, d.turboMaxSteps, !!refs);
    } catch (e) { return { error: String(e) }; }
  };
  const has8 = paint(rig, 8, true), lack8 = paint(shop, 8, true), six = paint(rig, 6, true);
  const fl8 = paint(shop, 8, false), four = paint(shop, 4, false), three = paint(rig, 3, false), rigFl8 = paint(rig, 8, false);
  ok("with a reference and the ref2v 8-step on disk, 8 steps is a matched build",
    has8.mismatch === false && has8.stepPath === " · 8-step reference build", JSON.stringify(has8));
  ok("...without it, the 4-step v0.1 at 8 is named by its own count, as the mismatch it is",
    lack8.mismatch === true && lack8.stepPath === " · 4-step build run at 8 steps", JSON.stringify(lack8));
  ok("...and 6 with the 8-step file is the same orphaned band as the fl2v path",
    six.mismatch === false && six.betweenBuilds === true, JSON.stringify(six));
  ok("the fl2v path on the Models screen's disk warns at 8 too: it has no 8-step file",
    fl8.mismatch === true && fl8.stepPath === " · 4-step build run at 8 steps", JSON.stringify(fl8));
  ok("...where the hand-fetched disk at 8 is the matched 8-step path",
    rigFl8.mismatch === false && rigFl8.stepPath === " · 8-step turbo path", JSON.stringify(rigFl8));
  ok("4 steps is \"the 4-step turbo path\", not the threshold's 5",
    four.stepPath === " · 4-step turbo path" && four.mismatch === false, JSON.stringify(four));
  ok("...and 3 with TaoMate is the 3-step path", three.stepPath === " · 3-step turbo path", JSON.stringify(three));
  ok("the status sends the reference build in ownLoras", /ownLoras: \[[^\]]*\be\.refTurboLora\b/.test(index));

  /* THE SAME MEASUREMENTS, EACH WITH ITS SCOPE, beside the slider. The Video
   * Lab's Steps knob and the plan-cost row used to call the bare 20 "11 m 00
   * s, and visibly the best"; that verdict was the turbo LoRA run at 20. */
  const knob = KNOBS.find((k) => k.id === "steps")?.effect || "";
  const bare = COST_ROWS.find((r) => r.id === "h3-bare-native")?.what || "";
  for (const [where, text] of [["the Video Lab's Steps knob", knob], ["the h3-bare-native cost row", bare]]) {
    ok(`${where} gives the 660 s its scope and cites arm H vs C`,
      /11 m 00 s/.test(text) && /either path|any 20-step render/.test(text) && /arm H vs C/.test(text)
      && !/and visibly the best/i.test(text), text);
  }

  /* make_clip's `quality` WORDS, END TO END. They mapped to literals (fast
   * 3-or-8, best 20), so "fast" on the Models screen's disk ran a 4-step LoRA
   * at 8. They now read the status's stepDefaults, and studio_status shows
   * them. mcp.js runs as its own stdio process pointed (AIPLAY_URL) at a stub
   * on a free local port, the way mcp-workspace_test.js drives it, so no
   * request reaches a real Studio. */
  const clip = tool("make_clip");
  const qDesc = clip?.inputSchema?.properties?.quality?.description || "";
  ok("make_clip's quality text names no current step count and says where to read it",
    !/currently \d+ steps?/i.test(qDesc) && /studio_status/.test(qDesc) && /h3_quality_steps/.test(qDesc), qDesc);
  const posts = [];
  let defaults = null;
  const stub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/api/status") {
      return res.end(JSON.stringify({ art: {}, config: { video: { enabled: true, engine: "h3",
        engines: { h3: { stepDefaults: defaults, turboBuilds: { three: defaults?.fast === 3 } } } } } }));
    }
    if (req.method === "GET" && req.url === "/api/clips") return res.end(JSON.stringify({ clips: [] }));
    if (req.method === "POST" && req.url === "/api/video") {
      posts.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      return res.end(JSON.stringify({ ok: true, job: { id: `j${posts.length}` } }));
    }
    return res.end("{}");
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const proc = spawn(process.execPath, [fileURLToPath(new URL("./mcp.js", import.meta.url))], {
    env: { ...process.env, AIPLAY_URL: `http://127.0.0.1:${stub.address().port}` }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  let buffer = "", serial = 0;
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let cut; (cut = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
      try { const r = JSON.parse(line); replies.get(r.id)?.(r); } catch { /* only JSON-RPC replies matter */ }
    }
  });
  const call = (name, args) => new Promise((resolve) => {
    const id = ++serial, timer = setTimeout(() => resolve({ error: "timed out" }), 20_000);
    replies.set(id, (r) => { clearTimeout(timer); replies.delete(id); resolve(r); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  try {
    for (const [name, d] of [["the hand-fetched disk", rig], ["the Models screen's disk", shop]]) {
      defaults = d.stepDefaults;
      posts.length = 0;
      const status = await call("studio_status", {});
      const shown = (() => { try { return JSON.parse(status.result?.content?.[0]?.text || "{}").video?.h3_quality_steps; } catch { return null; } })();
      ok(`${name}: studio_status shows the quality steps`, same(shown, d.stepDefaults), JSON.stringify(status).slice(0, 300));
      for (const quality of ["fast", "best", undefined]) {
        const r = await call("make_clip", { prompt: "a lamp", ...(quality ? { quality } : {}) });
        if (r.error || r.result?.isError) posts.push({ failed: JSON.stringify(r).slice(0, 300) });
      }
      const sent = posts.map((p) => p.failed ?? (p.steps === undefined ? "unset" : p.steps));
      ok(`${name}: make_clip sends fast ${d.stepDefaults?.fast}, best ${d.stepDefaults?.best}, and no quality leaves the engine's default`,
        same(sent, [d.stepDefaults?.fast, d.stepDefaults?.best, "unset"]), JSON.stringify(sent));
    }
  } finally {
    proc.kill();
    await new Promise((resolve) => stub.close(resolve));
  }
}

console.log("\n§2  make_song forwards every dial the door takes");
{
  const t = tool("make_song");
  const props = Object.keys(t?.inputSchema?.properties || {});
  for (const p of ["key", "bpm", "meter", "temperature", "top_p", "top_k", "repetition_penalty", "plan_temperature", "plan_top_p", "lora", "lora_strength", "abc", "abc_open"]) {
    ok(`make_song declares ${p}`, props.includes(p));
  }
  const run = String(t?.run || "");
  ok("...and forwards the three that were missing under the door's names",
    /topK: Number\.isFinite\(a\.top_k\) \? a\.top_k : undefined,/.test(run) && /repetitionPenalty: Number\.isFinite\(a\.repetition_penalty\) \? a\.repetition_penalty : undefined,/.test(run) && /planTopP: Number\.isFinite\(a\.plan_top_p\) \? a\.plan_top_p : undefined,/.test(run));
  const index = src("./index.js");
  ok("...which the door range-checks", /top_k: dial\(body\.topK, 1, 32768, true\), repetition_penalty: dial\(body\.repetitionPenalty, 0\.01, 10\)/.test(index) && /top_p: dial\(body\.planTopP, 0\.01, 1\)/.test(index));
}

console.log("\n§3  the two tools that were missing");
{
  const sie = tool("set_image_engine"), dm = tool("download_model");
  ok("set_image_engine exists and offers every image engine, krea2 included, and \"auto\" (forget the choice)",
    JSON.stringify(sie?.inputSchema?.properties?.engine?.enum) === JSON.stringify(["auto", "qwen-image-2.1", "flux2", "zimage", "zimage-base", "anima", "ideogram4", "krea2", "checkpoint"]));
  ok("...posting the Images page's own door", /\{ engine: a\.engine/.test(String(sie?.run || "")) && /api\("POST", "\/api\/artconfig", body\)/.test(String(sie?.run || "")));
  ok("...and naming the licences that matter", /NON-COMMERCIAL/.test(sie?.description || "") && /USD 1M/.test(sie?.description || ""));
  ok("download_model exists and posts the catalogue door", /api\("POST", "\/api\/models", \{\s+action: "download", id: String\(a\.id \|\| ""\),/.test(String(dm?.run || "")));
  ok("...sending the territory acknowledgement only when it is true", /\.\.\.\(a\.accept_region === true \? \{ acceptRegion: true \} : \{\}\),/.test(String(dm?.run || "")));
  ok("...and saying never to assume it", /never assume it/i.test(dm?.description || "") && /Never assumed/.test(dm?.inputSchema?.properties?.accept_region?.description || ""));
  ok("both are withheld from the in-app chat by sentence, like set_video_engine",
    typeof WITHHELD?.set_image_engine === "string" && /Pictures page/.test(WITHHELD.set_image_engine)
    && typeof WITHHELD?.download_model === "string" && /Models page/.test(WITHHELD.download_model)
    && !(("set_image_engine" in (ROUTABLE || {})) || ("download_model" in (ROUTABLE || {}))));
  const api = src("../API.md");
  ok("the API doc has the steering section", /### Steering the defaults from an agent/.test(api) && /download_model/.test(api) && /Fast \/ Standard \/ Best/.test(api));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
