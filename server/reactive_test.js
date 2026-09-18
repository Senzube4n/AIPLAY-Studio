/**
 * Reactive on the Studio's own compositor, 2026-09-18.
 *
 * §1 the cut times: bars by default, beats or onsets on request, never inside
 * the last 50 ms, never closer than the least gap. §2 the plan: one slot per
 * cut, pictures round-robin, exact holds for a cut, overlapping eases for a
 * crossfade, the last slot reaching the end. §3 the recipe against a fake
 * compositor door: the order and shape of the calls a style produces (audio
 * layer, timed picture layers, bass on scale, beat on exposure, effects on one
 * look layer, a render), refusals by sentence. §4 the page, the door, the tool,
 * the router, the doc and the second engine gone. No card.
 */
import fs from "node:fs";
import { cutTimes, planReactive, styleRecipe, runReactive, coverScale, driveKeys, STYLES, CUTS, status } from "./reactive.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

console.log("\n§1  the cut times");
{
  const beats = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0], bars = [2.0, 4.0];
  eq("bars by default, starting at 0", cutTimes({ beats, bars, duration: 5, cut: "bar" }), [0, 2, 4]);
  eq("beats on request", cutTimes({ beats, bars, duration: 5, cut: "beat" }), [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  eq("no cut inside the last 50 ms", cutTimes({ beats, bars, duration: 4.02, cut: "bar" }), [0, 2]);
  const onsets = [{ t: 0.3, v: 0.9 }, { t: 0.4, v: 0.95 }, { t: 1.2, v: 0.2 }, { t: 2.2, v: 0.7 }];
  eq("hits: above the threshold and not closer than the least gap", cutTimes({ onsets, duration: 5, cut: "hit", threshold: 0.5, minGap: 0.25 }), [0, 0.3, 2.2]);
  eq("no bars: beats stand in", cutTimes({ beats: [1, 2], bars: [], duration: 3, cut: "bar" }), [0, 1, 2]);
}

console.log("\n§2  the plan");
{
  const p = planReactive({ pictures: ["a.png", "b.png"], times: [0, 2, 4], duration: 5, style: "cuts" });
  eq("one layer per cut, pictures round-robin", p.layers.map((l) => l.src), ["a.png", "b.png", "a.png"]);
  eq("exact slots, the last reaching the end", p.layers.map((l) => [l.start, l.end]), [[0, 2], [2, 4], [4, 5]]);
  eq("a cut is a hold at 100", p.layers[1].opacityKeys, [{ t: 2, v: 100, ease: "hold" }]);
  const x = planReactive({ pictures: ["a.png", "b.png"], times: [0, 2, 4], duration: 5, style: "crossfade", fade: 0.35 });
  eq("a crossfade starts a fade early and ends a fade late", [x.layers[1].start, x.layers[1].end], [1.65, 4.35]);
  eq("...fading in over the cut and out over the next", x.layers[1].opacityKeys.map((k) => [k.t, k.v]), [[1.65, 0], [2.35, 100], [3.65, 100], [4.35, 0]]);
  eq("the first picture holds from 0, the last never fades out", [x.layers[0].opacityKeys[0], x.layers[2].opacityKeys.length], [{ t: 0, v: 100, ease: "hold" }, 2]);
  let refused = false;
  try { planReactive({ pictures: [], times: [0], duration: 5 }); } catch (e) { refused = /at least one picture/.test(e.message); }
  ok("no pictures is a refusal by sentence", refused);
  eq("the styles and cuts the page offers", [Object.keys(STYLES), Object.keys(CUTS)], [["cuts", "crossfade", "pulse", "film", "psychedelic"], ["bar", "beat", "hit"]]);
  eq("film: grain, vignette, a slow push", styleRecipe("film").effects.map((e) => e[0]).concat([styleRecipe("film").push]), ["addGrain", "vignette", 8]);
  eq("pulse: a bass breath and a flash", [styleRecipe("pulse").pulse, styleRecipe("pulse").flash], [[100, 116], [0, 0.9]]);
}

console.log("\n§3  the recipe, against a fake compositor");
{
  const calls = [];
  let ids = 0;
  const deps = {
    analyse: async () => ({ beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], bars: [2, 4], onsets: [], duration: 6, bpm: 120,
      tracks: { bass: [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2.5, v: 0.5 }, { t: 3, v: 1 }, { t: 5, v: 0 }],
        beat: [{ t: 0.5, v: 1 }, { t: 0.7, v: 0 }, { t: 1, v: 1 }], amplitude: [{ t: 1, v: 0.5 }] } }),
    vfx: async (b) => {
      calls.push(b);
      if (b.action === "create") return { ok: true, slug: "reactive-test" };
      if (b.action === "add_layer") return { ok: true, layerId: `L${++ids}`, layer: { id: `L${ids}`, ...(b.type === "image" ? { srcWidth: 1024, srcHeight: 1024 } : {}) } };
      if (b.action === "add_effect") return { ok: true, effectId: `fx_${b.type}` };
      if (b.action === "render") return { ok: true, jobId: "job1", clip: "vfx_reactive-test.mp4", out: "D:/x/vfx_reactive-test.mp4" };
      return { ok: true };
    },
    image: async () => ({ ok: true }), images: async () => [], waitIdle: async () => {},
  };
  const r = await runReactive({ song: "song.flac", pictures: ["a.png", "b.png"], style: "pulse", cut: "bar", orientation: "portrait" }, deps);
  eq("the reply names the comp, the render and the movie", [r.slug, r.jobId, r.clip, r.cuts, r.seconds, r.orientation], ["reactive-test", "job1", "vfx_reactive-test.mp4", 3, 6, [1080, 1920]]);
  const kinds = calls.map((c) => c.action);
  eq("the order: create, the song, three timed pictures with their keys, the look, the render", kinds.filter((k) => k !== "set_prop" && k !== "audio_keys"),
    ["create", "add_layer", "add_layer", "add_layer", "add_layer", "add_layer", "add_effect", "render"]);
  const song = calls.find((c) => c.action === "add_layer" && c.type === "audio");
  eq("the song is an audio layer, so the render carries it", [song.src, song.name], ["song.flac", "song"]);
  const pics = calls.filter((c) => c.action === "add_layer" && c.type === "image");
  eq("the pictures are timed to the bars", pics.map((c) => [c.src, c.start, c.end]), [["a.png", 0, 2], ["b.png", 2, 4], ["a.png", 4, 6]]);
  const scales = calls.filter((c) => c.action === "set_prop" && c.path === "transform.scale");
  const vs = (c) => c.keys.map((k) => k.v[0]);
  // a 1024² picture fills a 1080×1920 frame at 187.5 %; pulse breathes it up to ×1.16 of that
  eq("every picture fills the frame and breathes with the bass between the style's bounds",
    [scales.length, Math.min(...vs(scales[0])), Math.max(...vs(scales[0])), scales[0].keys[0].t, scales[0].keys[scales[0].keys.length - 1].t],
    [3, 187.5, 217.5, 0, 2]);
  eq("...cut from the one analysis, not analysed again per picture", calls.filter((c) => c.action === "audio_keys").length, 0);
  eq("the keys are comp-time, inside the picture's own slot", scales[1].keys.map((k) => k.t), [2, 2.5, 3, 4]);
  const flash = calls.find((c) => c.action === "set_prop" && c.path === "effects.fx_exposure.exposure");
  eq("the beat flashes the look layer's exposure", [Math.max(...flash.keys.map((k) => k.v)), flash.keys[0].t, flash.keys[flash.keys.length - 1].t], [0.9, 0, 6]);
  eq("no source size: the picture sits at 100 %", coverScale({}, 1920, 1080), 100);
  eq("a wide picture covers a tall frame by height", coverScale({ srcWidth: 1344, srcHeight: 768 }, 1080, 1920), 250);
  eq("a push grows the picture over its slot", driveKeys([], { from: 0, to: 2, lo: 100, hi: 100, shape: (t, v) => v * (1 + 0.08 * (t / 2)) }).map((k) => k.v), [100, 108]);
  const render = calls.find((c) => c.action === "render");
  eq("rendered as an mp4", [render.slug, render.format], ["reactive-test", "mp4"]);
  let refused = null;
  try { await runReactive({ song: "song.flac" }, deps); } catch (e) { refused = e.message; }
  ok("no pictures and no prompt is a refusal that says what to do", /pick some from the Images library, or give a prompt and a count/.test(refused || ""));
  // pictures from a prompt: the image door is asked once for `count`, and the new names are taken
  const calls2 = [];
  const deps2 = { ...deps, vfx: async (b) => { calls2.push(b); return deps.vfx(b); }, image: async (b) => { calls2.push(b); return { ok: true }; },
    images: (() => { let n = 0; return async () => (n++ ? [{ name: "old.png" }, { name: "new1.png" }, { name: "new2.png" }] : [{ name: "old.png" }]); })() };
  const r2 = await runReactive({ song: "song.flac", prompt: "neon city", count: 2, style: "cuts" }, deps2);
  eq("a prompt makes the pictures first and uses the new ones", [calls2[0].action, calls2[0].count, r2.made, r2.pictures], ["create", 2, ["new1.png", "new2.png"], ["new1.png", "new2.png"]]);
  const calls3 = [];
  const deps3 = { ...deps2, image: async (b) => { calls3.push(b); return { ok: true }; },
    images: (() => { let n = 0; return async () => (n++ ? [{ name: "n1.png" }, { name: "n2.png" }] : []); })() };
  await runReactive({ song: "song.flac", prompt: "neon city", count: 6 }, deps3);
  eq("the image door makes four per request, so six pictures are two requests", calls3.map((c) => c.count), [4, 2]);
  const st = await status();
  ok("the status needs nothing but the compositor", st.ok === true && st.engine === "compositor" && !!st.styles.film);
}

console.log("\n§4  the page, the door, the tool, the router, the doc");
{
  const html = src("../web/index.html"), app = src("../web/app.js"), index = src("./index.js"), mcp = src("./mcp.js"), router = src("./chat/router.js"), api = src("../API.md"), readme = src("../README.md");
  ok("the page has song, pictures, prompt+count, style chips, cut, length, orientation and Render", ["reactSong", "reactImgs", "reactPrompt", "reactCount", "reactStyles", "reactCut", "reactSecs", "reactOrient", "reactGo"].every((id) => new RegExp(`id="${id}"`).test(html)));
  ok("...and no second-engine setup", !/reactSetup/.test(html) && !/second ComfyUI/i.test(html.slice(html.indexOf('id="reactive"'), html.indexOf('id="about"'))));
  ok("the page posts /api/reactive/run and polls the comp's renders", /fetch\("\/api\/reactive\/run"/.test(app) && /\/api\/vfx\/comp\//.test(app));
  ok("the door runs the recipe with the compositor's own doors", /runReactive\(b, \{/.test(index) && /analyse[,:]/.test(index) && /"\/api\/vfx"/.test(index));
  ok("...and waits on the art queue where its status really lives", /art\.status\(\)\.art \|\| \{\}/.test(index));
  ok("reactive_render exists, takes pictures or a prompt, and posts the door", /name: "reactive_render"/.test(mcp) && /"\/api\/reactive\/run"/.test(mcp) && /pictures: \{ type: "array"/.test(mcp));
  ok("...routed to the gpu lane", /reactive_render: "gpu",/.test(router));
  ok("the API doc describes it", /### `POST \/api\/reactive\/run`/.test(api) && /reactive_render/.test(api));
  ok("the README no longer sends people to a second engine", !/second ComfyUI that\s+you set up/.test(readme) && /Reactive/.test(readme));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
