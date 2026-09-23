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
import { cutTimes, planReactive, styleRecipe, runReactive, coverScale, driveKeys, STYLES, CUTS, HITS, CLIP_RE, status } from "./reactive.js";
import { paintArgs, paintDials, PAINT_DEFAULTS, PAINT_SIZES } from "./reactive_paint.js";

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
  eq("the styles and cuts the page offers", [Object.keys(STYLES), Object.keys(CUTS)], [["cuts", "crossfade", "pulse", "film", "psychedelic", "paint", "motion"], ["bar", "beat", "hit"]]);
  eq("motion: a soft flash, the faintest breath, and the motion flag", [styleRecipe("motion").flash, styleRecipe("motion").motion], [[0, 0.5], true]);
  eq("paint: a soft flash, the faintest breath, and the paint flag", [styleRecipe("paint").flash, styleRecipe("paint").pulse, styleRecipe("paint").paint], [[0, 0.5], [100, 103], true]);
  eq("film: grain, vignette, a slow push", styleRecipe("film").effects.map((e) => e[0]).concat([styleRecipe("film").push]), ["addGrain", "vignette", 8]);
  eq("pulse: a bass breath and a flash", [styleRecipe("pulse").pulse, styleRecipe("pulse").flash], [[100, 116], [0, 0.9]]);
}

console.log("\n§3  the recipe, against a fake compositor");
{
  const calls = [];
  const analysed = [];
  let ids = 0;
  const deps = {
    analyse: async (song, fps, opts) => (analysed.push({ song, fps, ...opts }), { beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], bars: [2, 4], onsets: [], duration: 6, bpm: 120,
      tracks: { bass: [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2.5, v: 0.5 }, { t: 3, v: 1 }, { t: 5, v: 0 }],
        beat: [{ t: 0.5, v: 1 }, { t: 0.7, v: 0 }, { t: 1, v: 1 }], amplitude: [{ t: 1, v: 0.5 }] } }),
    vfx: async (b) => {
      calls.push(b);
      /* The real door (server/vfx/routes.js) reads `layerId ?? id` and answers
       * an error for anything else — the fake does the same, so a recipe that
       * says `layer_id` fails here the way it failed silently in production. */
      if (["set_layer", "set_prop", "add_effect"].includes(b.action) && !(b.layerId ?? b.id)) return { error: "No such layer: ." };
      if (b.action === "create") return { ok: true, slug: "reactive-test" };
      if (b.action === "add_layer") return { ok: true, layerId: `L${++ids}`, layer: { id: `L${ids}`, ...(b.type === "image" ? { srcWidth: 1024, srcHeight: 1024 } : {}), ...(b.type === "video" ? { srcWidth: 1280, srcHeight: 704, srcDuration: 5 } : {}) } };
      if (b.action === "add_effect") return { ok: true, effectId: `fx_${b.type}` };
      if (b.action === "render") return { ok: true, jobId: "job1", clip: "vfx_reactive-test.mp4", out: "D:/x/vfx_reactive-test.mp4" };
      return { ok: true };
    },
    image: async () => ({ ok: true }), images: async () => [], waitIdle: async () => {},
  };
  const r = await runReactive({ song: "song.flac", pictures: ["a.png", "b.png"], style: "pulse", cut: "bar", orientation: "portrait" }, deps);
  eq("the reply names the comp, the render and the movie", [r.slug, r.jobId, r.clip, r.cuts, r.seconds, r.orientation], ["reactive-test", "job1", "vfx_reactive-test.mp4", 3, 6, [1080, 1920]]);
  const kinds = calls.map((c) => c.action);
  eq("the order: create, the song, three timed pictures with their keys, the look, the render", kinds.filter((k) => k !== "set_prop" && k !== "audio_keys" && k !== "set_layer"),
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
  eq("...and it lists where the hits can come from", Object.keys(st.hits), ["mix", "drums"]);
  // hits from the drum stem: the analysis is asked for them by name, and the result says so
  eq("by default the hits come from the mix", analysed[0].hits, "mix");
  const r4 = await runReactive({ song: "song.flac", pictures: ["a.png"], hits: "drums" }, deps);
  eq("asked for the drums, the analysis is asked for the drums, and the reply says so", [analysed[analysed.length - 1].hits, r4.hits], ["drums", "drums"]);
  // a clip in a slot: a video layer, in sync with the song, wrapped over its own length
  const calls5 = [];
  const deps5 = { ...deps, vfx: async (b) => { const reply = await deps.vfx(b); calls5.push({ ...b, reply }); return reply; } };
  await runReactive({ song: "song.flac", pictures: ["a.png", "b.mp4"], style: "cuts", cut: "bar" }, deps5);
  const vid = calls5.find((c) => c.action === "add_layer" && c.type === "video");
  const sync = calls5.find((c) => c.action === "set_layer");
  eq("a clip becomes a video layer in its slot, played in sync with the song (start 2 s into a 5 s clip = in-point 2)",
    [vid?.src, vid?.start, vid?.end, sync?.layerId === vid?.reply?.layerId, sync?.inPoint], ["b.mp4", 2, 4, true, 2]);
  ok("...addressed by the field the door reads (layerId), never layer_id", !/layer_id/.test(src("./reactive.js")) && calls5.filter((c) => c.action === "set_prop").every((c) => c.layerId));
  // the door's answer is READ: an error on a layer call stops the recipe with the action named
  const deps5b = { ...deps, vfx: async (b) => b.action === "set_prop" && b.path === "transform.scale" ? { error: "no such key" } : deps.vfx(b) };
  const err5 = await runReactive({ song: "song.flac", pictures: ["a.png"], style: "cuts" }, deps5b).then(() => null, (e) => e.message);
  ok("a door error on a layer call is thrown with the action and the path in it (the Paint and Motion pieces before 2026-09-19 shipped letterboxed because it was not)", /compositor set_prop transform\.scale: no such key/.test(err5 || ""));
  ok("the clip regex admits the library's video names and nothing else", CLIP_RE.test("x.mp4") && CLIP_RE.test("x.webm") && !CLIP_RE.test("x.png") && Object.keys(HITS).length === 2);
  // starting a second in: the song's in-point moves, the bars and the drive tracks shift with it
  const calls6 = [];
  const deps6 = { ...deps, vfx: async (b) => { const reply = await deps.vfx(b); calls6.push({ ...b, reply }); return reply; } };
  const r6 = await runReactive({ song: "song.flac", pictures: ["a.png"], style: "pulse", cut: "bar", start: 1, seconds: 3 }, deps6);
  const songIn = calls6.find((c) => c.action === "set_layer" && c.inPoint === 1);
  const pics6 = calls6.filter((c) => c.action === "add_layer" && c.type === "image").map((c) => [c.start, c.end]);
  eq("start 1 s: the song plays from 1 s, the bars at 2 and 4 become cuts at 1 and 3, the piece is 3 s", [!!songIn, pics6, r6.start, r6.seconds], [true, [[0, 1], [1, 3]], 1, 3]);
  const flash6 = calls6.find((c) => c.action === "set_prop" && c.path === "effects.fx_exposure.exposure");
  eq("...and the beat track shifted with it (a beat at 1 s is now at 0)", flash6.keys[0].t, 0);
  // the Paint look: the clip is repainted with the pictures as the look, and becomes the one slot
  const painted = [];
  const calls7 = [];
  const deps7 = { ...deps, vfx: async (b) => { calls7.push(b); return deps.vfx(b); },
    paint: async (po) => { painted.push(po); return { file: "aiplay_paint_abc.mp4", frames: 48, seconds: 300, run: "paint_abc" }; } };
  const r7 = await runReactive({ song: "song.flac", pictures: ["b.mp4", "a.png", "c.png"], style: "paint", cut: "bar", start: 2, seconds: 4, orientation: "portrait", paint: { denoiseMin: 0.7 } }, deps7);
  eq("paint: the renderer gets the clip, the pictures as the look, the window and the dials",
    [painted[0].clip, painted[0].styles, painted[0].start, painted[0].seconds, painted[0].orientation, painted[0].dials], ["b.mp4", ["a.png", "c.png"], 2, 4, "portrait", { denoiseMin: 0.7 }]);
  const vid7 = calls7.filter((c) => c.action === "add_layer" && (c.type === "video" || c.type === "image"));
  eq("...and the painted clip is the ONE slot, spanning the piece", [vid7.length, vid7[0].type, vid7[0].src, vid7[0].start, vid7[0].end, r7.cuts, r7.paint.file], [1, "video", "aiplay_paint_abc.mp4", 0, 4, 1, "aiplay_paint_abc.mp4"]);
  let noClip = null;
  try { await runReactive({ song: "song.flac", pictures: ["a.png"], style: "paint" }, deps7); } catch (e) { noClip = e.message; }
  ok("paint without a clip is a refusal that says where to pick one", /pick one in the Clips grid/.test(noClip || ""));
  let noLook = null;
  try { await runReactive({ song: "song.flac", pictures: ["b.mp4"], style: "paint" }, deps7); } catch (e) { noLook = e.message; }
  ok("paint without a picture is a refusal that says why", /at least one picture for the look/.test(noLook || ""));
  // the renderer's argv and dials
  const argv = paintArgs({ srcDir: "aiplay_paint_src_x", song: "s.flac", start: 25.6, styles: ["p1.png", "p2.png"], run: "paint_x", width: 1024, height: 576, dials: PAINT_DEFAULTS });
  ok("the renderer is asked for the source frame on the conditioning, the pictures on the bars, and the measured dials",
    argv.includes("--source-ref") && argv[argv.indexOf("--style-refs") + 1] === "p1.png,p2.png" && argv[argv.indexOf("--denoise-min") + 1] === "0.66" && argv[argv.indexOf("--start") + 1] === "25.6");
  eq("the dials are bounded, not trusted", [paintDials({ denoiseMin: 5 }).denoiseMin, paintDials({ fps: 1 }).fps, paintDials({}).seed, PAINT_SIZES.portrait], [0.95, 6, 77000, [576, 1024]]);
  // the Motion look: the clip, the song's bars and the dials go to the renderer; the clip it makes is the one slot
  const moved = [];
  const calls8 = [];
  const deps8 = { ...deps, vfx: async (b) => { calls8.push(b); return deps.vfx(b); },
    motion: async (mo) => { moved.push(mo); return { file: "motion_abc_00001_.mp4", frames: 48, seconds: 150, runId: "run8" }; } };
  const r8 = await runReactive({ song: "song.flac", pictures: ["b.mp4"], style: "motion", start: 1, seconds: 4, orientation: "square", motion: { depth: 0.3, looks: ["A", "B"] } }, deps8);
  eq("motion: the renderer gets the clip, the window, the song's bars and beats, the pictures (none here) and the dials",
    [moved[0].clip, moved[0].start, moved[0].seconds, moved[0].orientation, moved[0].bars, moved[0].beats.length, moved[0].pictures, moved[0].dials], ["b.mp4", 1, 4, "square", [2, 4], 8, [], { depth: 0.3, looks: ["A", "B"] }]);
  await runReactive({ song: "song.flac", pictures: ["a.png", "b.mp4", "c.png"], style: "motion" }, { ...deps8, vfx: deps.vfx });
  eq("...and the pictures picked beside the clip go to the renderer as the look, in order", moved[moved.length - 1].pictures, ["a.png", "c.png"]);
  const { motionDials: md, peakFrames } = await import("./reactive_motion.js");
  eq("the picture dials default to the reference's (weight 1, five-frame switch, the six-word prompt)", [md({}).ipWeight, md({}).transition, md({}).lookWithPictures], [1, 5, "4k, beautiful, high quality, highly detailed, art"]);
  eq("the hits the pictures switch on are the beats inside the piece, at least five frames apart", peakFrames({ beats: [1, 1.2, 1.5, 2, 9], start: 1, fps: 12, frames: 60, minGap: 5 }), [0, 6, 12]);
  const vid8 = calls8.filter((c) => c.action === "add_layer" && (c.type === "video" || c.type === "image"));
  eq("...and the rendered clip is the ONE slot, spanning the piece", [vid8.length, vid8[0].type, vid8[0].src, vid8[0].end, r8.cuts, r8.motion.file, r8.paint], [1, "video", "motion_abc_00001_.mp4", 4, 1, "motion_abc_00001_.mp4", null]);
  let noClip8 = null;
  try { await runReactive({ song: "song.flac", pictures: ["a.png"], style: "motion" }, deps8); } catch (e) { noClip8 = e.message; }
  ok("motion without a clip is a refusal that says where to pick one", /Motion look repaints a clip.*Clips grid/.test(noClip8 || ""));
  const motionDials = (await import("./reactive_motion.js")).motionDials;
  eq("the motion dials are bounded, and the looks default to the three palettes", [motionDials({ depth: 9 }).depth, motionDials({}).looks.length, motionDials({ looks: ["x"] }).looks], [1.5, 3, ["x"]]);
  eq("with pictures the holds default to the reference's (0.3 / 0.5 / cfg 7); with prompts to the painted look's; a dial the caller set wins either way",
    [[motionDials({}, { pictures: true }).depth, motionDials({}, { pictures: true }).lineart, motionDials({}, { pictures: true }).cfg],
     [motionDials({}).depth, motionDials({}).lineart, motionDials({}).cfg], motionDials({ depth: 0.1 }, { pictures: true }).depth],
    [[0.4, 0.5, 7], [0.2, 0.25, 8], 0.1]);
  eq("the source on the hits is a dial: off until asked for, with prompts and with pictures (measured worse on 2026-09-20), until 0.5 of each pass, bounded",
    [motionDials({}).sourceHold, motionDials({}, { pictures: true }).sourceHold, motionDials({}).sourceHoldEnd, motionDials({ sourceHold: 9, sourceHoldEnd: 0 }).sourceHold, motionDials({ sourceHold: 9, sourceHoldEnd: 0 }).sourceHoldEnd, motionDials({ sourceHold: 1 }, { pictures: true }).sourceHold],
    [0, 0, 0.5, 2, 0.1, 1]);
  ok("...on the page (Source on the hits, Source hold until), sent only when moved, and on the tool", /id="reactMotionSourceHold"/.test(src("../web/index.html")) && /sourceHold: moved\("reactMotionSourceHold"\)/.test(src("../web/app.js")) && /sourceHold: \{ type: "number"/.test(src("./mcp.js")));
  eq("the holds' lengths are dials, bounded, with pictures depth held a little longer (0.6) than the reference's 0.5",
    [motionDials({}).depthEnd, motionDials({}).lineartEnd, motionDials({}, { pictures: true }).depthEnd, motionDials({}, { pictures: true }).lineartEnd, motionDials({ depthEnd: 3, lineartEnd: 0 }).depthEnd, motionDials({ depthEnd: 3, lineartEnd: 0 }).lineartEnd],
    [0.5, 0.7, 0.6, 0.7, 1, 0.1]);
  eq("the hits' density and the bring-your-own names are dials: bars or beats, a least gap, file names stripped of path characters, samplers from the list only",
    [motionDials({}).hitsOn, motionDials({}).hitGap, motionDials({ hitsOn: "bars", hitGap: 900 }).hitsOn, motionDials({ hitsOn: "bars", hitGap: 900 }).hitGap, motionDials({ hitsOn: "x" }).hitsOn,
     motionDials({ motionLora: "../evil/LiquidAF.safetensors", motionLoraStrength: 9 }).motionLora, motionDials({ motionLoraStrength: 9 }).motionLoraStrength, motionDials({ sampler: "lcm", scheduler: "nope" }).sampler, motionDials({ sampler: "lcm", scheduler: "nope" }).scheduler],
    ["beats", 5, "bars", 120, "beats", "..evilLiquidAF.safetensors", 2, "lcm", ""]);
  ok("...on the page (Switch on, Least gap, Your own motion module / motion LoRA / model LoRA, Sampler), filled from the status door, and on the tool",
    /id="reactMotionHitsOn"/.test(src("../web/index.html")) && /id="reactMotionLora"/.test(src("../web/index.html")) && /fillOwn\("reactMotionModel"/.test(src("../web/app.js")) && /motionLora: \$\("reactMotionLora"\)\.value/.test(src("../web/app.js"))
    && /hitsOn: \{ type: "string", enum: \["beats", "bars"\]/.test(src("./mcp.js")) && /motionLora: \{ type: "string"/.test(src("./mcp.js")) && /motion: \(\) => motionChoices\(engineDoor\)/.test(src("./index.js")));
  ok("...on the page (Depth hold until, Line hold until), sent only when moved, and on the tool", /id="reactMotionDepthEnd"/.test(src("../web/index.html")) && /depthEnd: moved\("reactMotionDepthEnd"\)/.test(src("../web/app.js")) && /depthEnd: \{ type: "number"/.test(src("./mcp.js")));
  ok("...and the page sends a dial only when it was moved off its default, so the recipe can pick", /const moved = \(id\) => \{ const el = \$\(id\); return el\.value === el\.defaultValue/.test(src("../web/app.js")) && /depth: moved\("reactMotionDepth"\)/.test(src("../web/app.js")));
  eq("the motion look's layer sharpens and opens the render (unsharp, contrast, vibrance) on top of the beat flash", styleRecipe("motion").effects.map((e) => e[0]), ["unsharpMask", "brightnessContrast", "vibrance"]);
  eq("the detail pass and the 24 fps smoothing are on by default, bounded, and switchable", [motionDials({}).hires, motionDials({}).hiresDenoise, motionDials({}).smooth, motionDials({ hires: false, hiresDenoise: 5, smooth: 0 }).hires, motionDials({ hiresDenoise: 5 }).hiresDenoise, motionDials({ smooth: 0 }).smooth], [true, 0.55, true, false, 0.9, false]);
  ok("...on the page (Detail pass, Detail repaint, Smooth to 24 fps), sent only when flipped, and on the tool", /id="reactMotionHires" checked/.test(src("../web/index.html")) && /id="reactMotionSmooth" checked/.test(src("../web/index.html")) && /hires: flipped\("reactMotionHires"\)/.test(src("../web/app.js")) && /hires: \{ type: "boolean"/.test(src("./mcp.js")) && /smooth: \{ type: "boolean"/.test(src("./mcp.js")));
}

console.log("\n§4  the page, the door, the tool, the router, the doc");
{
  const html = src("../web/index.html"), app = src("../web/app.js"), index = src("./index.js"), mcp = src("./mcp.js"), router = src("./chat/router.js"), api = src("../API.md"), readme = src("../README.md");
  ok("the page has the Motion dials and posts them; the tool takes them; the door wires the renderer",
    /id="reactMotionDials"/.test(html) && /reactMotionLooks/.test(app) && /paint, motion,/.test(app) && /motion: \{\s*type: "object"/.test(mcp) && /motionClip\(\{ \.\.\.mo/.test(index));
  ok("the page has the Paint dials and posts them; the tool takes them; the door wires the renderer",
    /id="reactPaintDials"/.test(html) && /reactPaintDenoise/.test(app) && /paint, motion,/.test(app) && /paint: \{\s*type: "object"/.test(mcp) && /paintClip\(\{ \.\.\.po/.test(index));
  const requestBuilder = app.slice(app.indexOf("function reactRequest()"), app.indexOf('$("reactGo")?.addEventListener', app.indexOf("function reactRequest()")));
  ok("the page has a start second in its shared request builder and the tool takes it", /id="reactStart"/.test(html) && /const start = Number\(\$\("reactStart"\)/.test(requestBuilder) && /start: start > 0 \? start : undefined/.test(requestBuilder) && /start: a\.start/.test(mcp));
  ok("the page has a clips grid and a hits select, and posts the hits", /id="reactClips"/.test(html) && /id="reactHits"/.test(html) && /hits: \$\("reactHits"\)\.value/.test(app) && /#reactClips \[data-rimg\]/.test(app));
  ok("the door reads the drum stem when asked", /ensureStem\(song, "drums"/.test(index) && /hits === "drums"/.test(index));
  ok("the tool offers hits and clips", /hits: \{ type: "string", enum: \["mix", "drums"\]/.test(mcp) && /clip names from list_clips/.test(mcp));
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

/* ⚠ AND THE SAME CHECK OVER EVERY SHIPPED DOCUMENT, BECAUSE TWO OF THEM KEPT
 * SAYING IT FOR FIVE DAYS AFTER THE PAGE STOPPED.
 *
 * The block above pinned web/index.html and README.md, which is where anybody
 * looking for this claim would look. It is not where a person INSTALLING finds
 * it. INSTALL.md carried a whole section headed "Optional: the audio-reactive
 * engine" telling the reader to stand up a second ComfyUI and about 8.7 GB of
 * weights for a page that had not used either since 2026-09-18, and
 * docs/DEEP_DIVE.md told them that engine wrote no provenance — on a door that
 * stamps its actor from the request and has a test in provenance_test.js
 * saying so. Two documents, both shipped, both wrong, neither read by any
 * check.
 *
 * So the sweep is over the whole documentation set rather than the two files
 * somebody thought of, and the way it PASSES is the point: a document may
 * still contain the phrase as long as it is saying it is no longer true. A
 * changelog entry ("no longer asks for a second ComfyUI") and a withdrawal
 * note ("this section used to describe a second ComfyUI") both read fine to a
 * person and both have to survive, or the honest fix is the thing that breaks
 * the build. */
{
  const dir = new URL("../docs/", import.meta.url);
  const docs = ["../README.md", "../INSTALL.md", "../API.md",
    ...fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `../docs/${f}`)];
  ok(`the documentation sweep reads the whole set (${docs.length} files)`, docs.length >= 8,
    "a sweep that reads two files proves what two files say");
  /* "is gone / used to / no longer / stopped" anywhere in the sentence marks it
   * as history. Anything else asserting a second engine is still an instruction. */
  /* ⚠ "not a second" WAS IN THIS LIST AND IT MADE THE CHECK UNFALSIFIABLE. The
   * replacement prose says "the engine you installed above — not a second one",
   * so any paragraph that kept those four words was read as history no matter
   * what else it said: a sabotage that put "they need a second ComfyUI" back
   * into that same paragraph passed. A retraction marker has to be a word the
   * fixed text does not casually contain. */
  const RETRACTED = /(no longer|used to|stopped|is gone|never came|nothing .{0,30}uses it)/i;
  for (const rel of docs) {
    const text = src(rel);
    const bad = text.split(/\n\s*\n/).filter((para) =>
      /second ComfyUI|second (render )?engine/i.test(para) && !RETRACTED.test(para));
    ok(`${rel.replace("../", "")} does not still ask for a second engine`, bad.length === 0,
      bad.map((b) => b.replace(/\s+/g, " ").slice(0, 150)).join("  ||  "));
    /* ⚠ AND THE OTHER HALF OF THE SAME SENTENCE, WHICH THE PHRASE SWEEP ABOVE
     * CANNOT SEE. docs/DEEP_DIVE.md did not only place Reactive on a second
     * port - it told the reader that door wrote NO provenance, which would make
     * it the one render path in the app with no ledger entry. The door stamps
     * `prov.actorFrom(req)` and provenance_test.js fails if it stops, so this is
     * a claim about a security property that was never true and would not have
     * tripped a search for "second ComfyUI". Its own check, in its own words. */
    const noProv = text.split(/\n\s*\n/).filter((para) =>
      /[Rr]eactive[^.]{0,120}(no|never)[^.]{0,40}provenance/.test(para) && !RETRACTED.test(para));
    ok(`${rel.replace("../", "")} does not claim the Reactive door skips the ledger`, noProv.length === 0,
      noProv.map((b) => b.replace(/\s+/g, " ").slice(0, 150)).join("  ||  "));
  }
  const install = src("../INSTALL.md");
  ok("INSTALL.md says what Reactive actually needs instead of leaving a hole",
    /server\/vfx/.test(install) && /AnimateDiff/.test(install) && /Models screen/.test(install),
    "deleting a wrong instruction without writing the right one leaves the reader guessing");
}

console.log("\n§  how hard it moves, and the circle on the bass (2026-09-20)");
{
  const { motionDials } = await import("./reactive_motion.js");
  const { animateGraph } = await import("./animatediff.js");
  const GBASE = { source: "x.mp4", frames: 16, width: 512, height: 288, schedule: { 0: "a" }, seed: 1 };
  const ad = src("./animatediff.js"), rm = src("./reactive_motion.js"), rx = src("./reactive.js");
  const mcp = src("./mcp.js"), html = src("../web/index.html"), app = src("../web/app.js");

  /* MOTION SCALE. AnimateDiff's module has a scale input we were not sending,
   * so every piece ran at its own 1.0 while the reference's animation changed
   * far harder frame to frame. The graph at 1 must stay byte-identical to the
   * one every earlier piece rendered, or no old render can be compared. */
  eq("at 1 the graph is the old graph: no scale node, no extra input",
    [("11" in animateGraph({ ...GBASE })), Object.keys(animateGraph({ ...GBASE })[4].inputs).join(",")],
    [false, "motion_model"]);
  eq("above 1 the node appears and carries the number",
    [("11" in animateGraph({ ...GBASE, motionScale: 1.4 })),
     animateGraph({ ...GBASE, motionScale: 1.4 })[11].inputs.float_val,
     animateGraph({ ...GBASE, motionScale: 1.4 })[4].inputs.scale_multival[0]],
    [true, 1.4, "11"]);
  ok("...and a scale outside (0,3] is refused rather than clamped",
    /motionScale must be in \(0, 3\]/.test(ad));
  eq("the dial defaults to 1 and is bounded",
    [motionDials({}).motionScale, motionDials({ motionScale: 9 }).motionScale, motionDials({ motionScale: 0 }).motionScale],
    [1, 3, 0.1]);

  /* THE IRIS. A compositor shape, measured before it was written: a probe on
   * 2026-09-20 showed a mask growing with its layer's transform, which is the
   * whole mechanism. */
  eq("the iris is off by default and bounded", [motionDials({}).iris, motionDials({ iris: 5 }).iris, motionDials({ iris: -1 }).iris], [0, 1, 0]);
  ok("it is a black card with an inverted round hole, over everything",
    /type: "solid", name: "iris", index: 0/.test(rx)
    && /color: \[0, 0, 0, 255\]/.test(rx)
    && /invert: true,/.test(rx));
  ok("...and the BASS scales the card, which is what opens the hole",
    /driveKeys\(bass, \{ from: 0, to: duration, lo: 100, hi: peak/.test(rx));
  /* ⚠ THE HOLE MUST REACH THE CORNER, and the first version never could. Its
   * base radius was (short/2)*0.62 and its ceiling 220 %, so on a 1344x768
   * frame it opened to 524 px against the 774 the corners need: black corners
   * at every value of the dial, including 1, while the tool's own description
   * promised the whole picture on every hit. */
  ok("...to the CORNER radius, so a bass peak really does clear the frame",
    /const corner = Math\.hypot\(width \/ 2, height \/ 2\);/.test(rx)
    && /const peak = Math\.ceil\(\(corner \/ rest\) \* 100\);/.test(rx));
  ok("...and the number now sets how CLOSED it is between the hits, not how far it opens",
    /const rest = corner \* \(1 - 0\.5 \* a\);/.test(rx)
    && /THE NUMBER SETS HOW CLOSED IT IS BETWEEN THE HITS/.test(mcp));
  ok("...the circle is a polygon, because a mask has no ellipse", /export function circlePoints/.test(rx));
  ok("...the measurement that justified it is written where the code is",
    /a three-frame probe on 2026-09-20\n \* showed the hole growing with the card/.test(rx));
  ok("the recipe takes it from the Motion dials and clamps it there",
    /if \(style === "motion"\) \{\n\s+const asked = Number\(\(o\.motion \|\| \{\}\)\.iris\);/.test(rx));
  /* THE HINT LIFT. The owner's third note on the Motion look was that "the
   * shape of the dancer is more visible" in the reference and ours needed "a
   * better depth mapping perhaps". Measured before anything was written: on
   * frame 24 of a real dance clip 83.5% of the frame sits under luminance 0.05
   * and the figure's own column averages 0.068, so the estimator is not weak,
   * it is blind. These pins hold the three things that reading implies — the
   * lift reaches the preprocessors, it reaches NOTHING else, and off is
   * bit-identical to every piece rendered before it existed. */
  eq("at 1 no lift node exists and both preprocessors read the source",
    [("23" in animateGraph({ ...GBASE })),
     animateGraph({ ...GBASE })[24].inputs.image[0], animateGraph({ ...GBASE })[25].inputs.image[0]],
    [false, "22", "22"]);
  eq("above 1 the node appears, carries the gamma, and BOTH preprocessors move onto it",
    [animateGraph({ ...GBASE, hintLift: 2.2 })[23].class_type,
     animateGraph({ ...GBASE, hintLift: 2.2 })[23].inputs.gamma,
     animateGraph({ ...GBASE, hintLift: 2.2 })[24].inputs.image[0],
     animateGraph({ ...GBASE, hintLift: 2.2 })[25].inputs.image[0]],
    ["AiplayHintLift", 2.2, "23", "23"]);
  /* ⚠ THE ONE WAY THIS FEATURE FAILS BADLY: lifting what gets PAINTED. The
   * render comes back washed out and the fault looks like the model's. */
  eq("...and the sampler's own branch is untouched by it",
    [animateGraph({ ...GBASE, hintLift: 2.2 })[22].inputs.image[0],
     JSON.stringify(animateGraph({ ...GBASE, hintLift: 2.2 })).split('["23",0]').length - 1],
    [animateGraph({ ...GBASE })[22].inputs.image[0], 2]);
  ok("a lift outside [1, 4] is refused rather than clamped", /hintLift must be in \[1, 4\]/.test(ad));
  eq("the dial is off on the plain path and on at 2.2 where the pictures are",
    [motionDials({}).hintLift, motionDials({}, { pictures: true }).hintLift,
     motionDials({ hintLift: 9 }).hintLift, motionDials({ hintLift: 0 }).hintLift],
    [1, 2.2, 4, 1]);
  ok("the node ships with the sweep that chose the default, not just the number",
    /gamma   1\.0    1\.4    1\.8    2\.2    2\.6    3\.0/.test(
      fs.readFileSync(new URL("./comfy_nodes/aiplay_hint_lift.py", import.meta.url), "utf8")));
  ok("...and it is one of ours, so it deploys with the rest",
    /NODE_CLASS_MAPPINGS = \{"AiplayHintLift"/.test(
      fs.readFileSync(new URL("./comfy_nodes/aiplay_hint_lift.py", import.meta.url), "utf8")));
  ok("the lift has a page control and a tool parameter of its own",
    /id="reactMotionHintLift"/.test(html) && /hintLift: moved\("reactMotionHintLift"\)/.test(app)
    && /hintLift: \{ type: "number", minimum: 1, maximum: 4/.test(mcp));

  ok("both ship a page control and a tool parameter",
    /id="reactMotionScale"/.test(html) && /id="reactMotionIris"/.test(html)
    && /motionScale: moved\("reactMotionScale"\), iris: moved\("reactMotionIris"\)/.test(app)
    && /motionScale: \{ type: "number", minimum: 0\.1, maximum: 3/.test(mcp)
    && /iris: \{ type: "number", minimum: 0, maximum: 1/.test(mcp));
}

console.log(`\n  ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
