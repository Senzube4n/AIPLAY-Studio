/**
 * KEEP MY CHARACTER: the REWIND A/B's recommended setup, built into the
 * screens (2026-09-24, DIRECTING.md §2).
 *
 * Four shots at the same seeds: with 1-3 tight pictures of the lead, the
 * reference build at its own 8 steps, res_multistep and the song under the
 * clip, the lead matched in all four; from words alone his hair, mask and coat
 * changed between clips. This lane holds the pieces that make that the easy
 * choice:
 *
 *   1. the sampler     res_multistep on the reference path under "auto"; the
 *                      fl2v turbo builds keep Euler; an explicit one wins.
 *   2. the steps       referenceSteps: the reference file's own count, one
 *                      answer for the status, the plan and the music video.
 *   3. the plan        video-plain.js videoPlan binds a saved character, runs
 *                      the reference count when none is named, and says what
 *                      the render keeps (`character`) in its own words: the
 *                      measured setup is a constant (a 4-step-only disk is
 *                      said to run an unmeasured one), pictures the words
 *                      never name are said, and Song under the clip's words
 *                      follow the engine (no lip-sync promised on LTX).
 *   4. the door        /api/video resolves the character BEFORE the safety
 *                      check, so the check sees its pictures and its words,
 *                      and stages them with the request's own resolver (a
 *                      character saved from uploads rides; run for real).
 *   5. the page        the Keep my character row, shown in Simple, its words
 *                      the server's; the Fast chip's while a character is kept.
 *   6. make_clip       `persona`, and the rule in its description.
 *
 * No server, no engine: the plan runs for real, the page's lines are lifted
 * and run with only the names they read, make_clip runs against a mocked door.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const { config } = await import("./config.js");
const { h3SamplerFor, referenceSteps, videoGraphH3 } = await import("./workflow.js");
const { videoPlan, refsIgnored, personaUnknown, personaMissing, KEEP_MEASURED, measuredBuildHere, keepFast, songUnderSay } =
  await import("./video-plain.js");
const { bindPersonaForClip, personaFits, stagePersonaForClip } = await import("./personas.js");
const clipsteps = await import("./mv/clipsteps.js");
const E = config.video.engines;
const H3 = E.h3;

/* The file names the graph and the plan pick between, as config.js names them. */
const eng = (over = {}) => ({ ...H3, sampler: "auto", ...over });

/* ── 1. the sampler ─────────────────────────────────────────────────────── */
test("1: the reference path runs res_multistep under auto; fl2v turbo keeps Euler; an explicit sampler wins", () => {
  for (const steps of [4, 8, 20]) {
    assert.equal(h3SamplerFor(eng(), { steps, refs: true }), "res_multistep", `refs at ${steps}`);
  }
  assert.equal(h3SamplerFor(eng(), { steps: 4 }), "euler", "fl2v 4-step: the publisher's recipe");
  assert.equal(h3SamplerFor(eng(), { steps: 8 }), "euler", "fl2v 8-step: the publisher's recipe");
  if (H3.turboLora3) assert.equal(h3SamplerFor(eng(), { steps: 3 }), "res_multistep", "TaoMate 3-step keeps its measured sampler");
  assert.equal(h3SamplerFor(eng(), { steps: 20 }), "res_multistep", "the bare model keeps its measured sampler");
  for (const steps of [3, 4, 8, 20]) for (const refs of [false, true]) {
    assert.equal(h3SamplerFor(eng({ sampler: "dpmpp_2m" }), { steps, refs }), "dpmpp_2m", `explicit wins at ${steps}, refs ${refs}`);
  }
  const saved = H3.sampler;
  H3.sampler = "auto";
  try {
    const g = videoGraphH3({ prompt: "<Picture 1> is Mira. Mira runs", seed: 1, seconds: 4, width: 1344, height: 768,
      prefix: "p", steps: 8, refImages: ["ref.png"] });
    assert.equal(g[9].inputs.sampler_name, "res_multistep", "the graph with a reference picture carries it (node 9)");
  } finally { H3.sampler = saved; }
  const knob = read("./videolab/catalog.js");
  assert.match(knob, /Auto uses res_multistep on the reference path/, "the Video Lab knob says it");
  assert.doesNotMatch(knob, /Euler's effect on this rig's image quality has not yet been measured/);
});

/* ── 2. the steps ───────────────────────────────────────────────────────── */
test("2: referenceSteps is the reference file's own count, else Standard, and the music video reads the same answer", () => {
  assert.equal(referenceSteps({ refTurboSteps: 8, stepDefaults: { standard: 4 } }), 8);
  assert.equal(referenceSteps({ refTurboSteps: 4, stepDefaults: { standard: 8 } }), 4);
  assert.equal(referenceSteps({ refTurboSteps: null, stepDefaults: { standard: 4 } }), 4, "no reference file: Standard");
  assert.equal(referenceSteps({ steps: 20 }), 20);
  assert.equal(referenceSteps(null), null);
  const saved = { refTurboSteps: H3.refTurboSteps, stepDefaults: H3.stepDefaults };
  try {
    for (const [ref, standard] of [[8, 4], [4, 4], [null, 4], [8, 8]]) {
      H3.refTurboSteps = ref; H3.stepDefaults = { fast: standard, standard, best: 20 };
      assert.equal(clipsteps.defaultClipSteps({ refs: true }), referenceSteps(H3), `ref file ${ref}, standard ${standard}`);
    }
  } finally { H3.refTurboSteps = saved.refTurboSteps; H3.stepDefaults = saved.stepDefaults; }
  /* A scene with cast pictures never runs below the reference build's own
   * count: the brief's 3 was Hex Appeal v1's "burned" setting. */
  assert.equal(clipsteps.clipStepsFor({ videoSteps: 3 }, { refs: true }), 4);
  assert.match(clipsteps.clipStepsNote({ videoSteps: 3 }, { refs: true }), /^With cast pictures this scene runs 4 steps, not the brief's 3/);
  assert.equal(clipsteps.clipStepsFor({ videoSteps: 3 }, { refs: false }), 3, "the text path is left alone");
  assert.equal(clipsteps.clipStepsNote({ videoSteps: 8 }, { refs: true }), null, "a count at the file's own says nothing");
  const index = read("./index.js");
  assert.match(index, /referenceSteps: e\.stepDefaults \? referenceSteps\(e\) : null,/, "/api/status sends it per engine");
  assert.match(read("./mcp.js"), /h3_reference_steps: st\.config\?\.video\?\.engines\?\.h3\?\.referenceSteps \?\? null,/, "studio_status carries it");
});

/* ── 3. the plan ────────────────────────────────────────────────────────── */
/* Two disks, named rather than read, so the lane says the same on every PC:
 * DISK8 holds the measured build (the ref2v 8-step v1.0), DISK4 only the
 * Models screen's 4-step v0.1 reference file. */
const L = {
  fl8: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  fl4: "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",
  ref8: KEEP_MEASURED.file,
  ref4: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
  tao: "taomate_h3_3step_comfy.safetensors",
};
const VAE8 = "minimax_h3_video_vae_int8_convrot.safetensors";
const DISK8 = eng({ turboLora: L.fl8, turboLora4: L.fl4, turboLora3: L.tao, refTurboLora: L.ref8, refTurboLora4: L.ref4,
  refTurboSteps: 8, stepDefaults: { fast: 3, standard: 8, best: 20 }, steps: 8, videoVae: VAE8 });
const DISK4 = eng({ turboLora: L.fl4, turboLora4: L.fl4, turboLora3: L.tao, refTurboLora: L.ref4, refTurboLora4: L.ref4,
  refTurboSteps: 4, stepDefaults: { fast: 3, standard: 4, best: 20 }, steps: 4, videoVae: VAE8 });
const MIRA = { name: "Mira", fragment: "a tall woman with cropped silver hair", refImages: ["m1.png", "m2.png", "m3.png", "m4.png"] };
const plan = (b, o = {}) => videoPlan({ prompt: "Mira runs through the rain", ...b }, { engineKey: "h3", eng: DISK8, ...o });

test("3: with references and no count named, the reference build's own count runs; a named count stays and is noted", () => {
  const p = plan({ prompt: "<Picture 1> is Mira. Mira runs", refImages: ["a.png"] });
  assert.equal(p.steps, 8);
  assert.equal(p.sampler, "res_multistep");
  assert.equal(p.character.measuredSteps, 8);
  assert.equal(p.character.measuredHere, true);
  assert.equal(p.notes.find((n) => n.id === "steps-measured"), undefined, "the measured setup: nothing to say");
  const low = plan({ prompt: "<Picture 1> is Mira. Mira runs", refImages: ["a.png"], steps: 4 });
  assert.equal(low.steps, 4, "a count the request named is kept");
  assert.equal(low.notes.find((n) => n.id === "steps-measured")?.text,
    "Keeping a character was measured on the 8-step reference build at 8 steps; this runs 4 on the 4-step reference build.");
  assert.match(low.character.receipt, /\+ 4 steps \(measured with 8\)$/);
  const text = plan({ steps: 8 });
  assert.equal(text.character.keeps, false);
  assert.equal(text.notes.find((n) => n.id === "steps-measured"), undefined, "no character, nothing measured to fall short of");
  /* The live config reads the same way (whatever this PC holds). */
  assert.equal(videoPlan({ prompt: "a", refImages: ["a.png"] }, { engineKey: "h3", eng: H3 }).steps, referenceSteps(H3));
});

test("3: on a disk with only the 4-step reference file, keeping a character is said to run an unmeasured setup", () => {
  assert.equal(measuredBuildHere(DISK8), true);
  assert.equal(measuredBuildHere(DISK4), false);
  assert.equal(measuredBuildHere(eng({ refTurboLora: L.fl8, refTurboSteps: 8 })), false, "an fl2v 8-step fallback is not the measured build");
  const p = plan({ prompt: "<Picture 1> is Mira. Mira sings", refImages: ["a.png"], song: true }, { eng: DISK4 });
  assert.equal(p.steps, 4, "the disk's own reference count");
  assert.equal(p.character.measuredSteps, 8, "the measured count is the A/B's, not the disk's");
  assert.equal(p.character.measuredHere, false);
  assert.equal(p.character.receipt, "1 reference picture + 4 steps (measured with 8, not on this PC) + song (lip-sync)");
  assert.equal(p.character.hint, "Keeping a character was measured on the 8-step reference build, which is not on this PC: "
    + "this runs the 4-step reference build.");
  assert.equal(p.notes.find((n) => n.id === "steps-measured")?.text,
    "Keeping a character was measured on the 8-step reference build at 8 steps; this runs 4 on the 4-step reference build. "
    + `That file (${KEEP_MEASURED.file}, in models/loras) is not on this PC, and the Models screen does not fetch it yet.`);
  const noSong = plan({ prompt: "<Picture 1> is Mira. Mira runs", refImages: ["a.png"] }, { eng: DISK4 });
  assert.match(noSong.character.hint, /^If they sing, choose Song under the clip \(lip-sync\) and where the sung line starts\. Keeping a character was measured on the 8-step reference build, which is not on this PC/,
    "the missing build is said after the first line");
  /* The Fast chip while keeping: TaoMate is text-only, so the reference build's count, said. */
  assert.deepEqual(keepFast(DISK8), { steps: 4, note: "Fast with a character: 4 steps on the 4-step reference build (the TaoMate "
    + "3-step build takes no pictures). Keeping a character was measured at 8 steps on the 8-step reference build." });
  assert.equal(keepFast(DISK4).steps, 4);
  assert.equal(keepFast(E.ltx ?? {}), null, "no chips, no note");
  assert.match(read("./index.js"), /keepFast: k === "h3" \? keepFast\(e\) : null,/, "/api/status sends it for H3");
});

test("3: pictures the words never name are said, in the receipt and the Keep line", () => {
  const none = plan({ prompt: "Mira runs down the street", refImages: ["a.png", "b.png"] });
  assert.equal(none.character.receipt, "2 reference pictures, not named + 8 steps");
  assert.equal(none.character.unnamed, 2);
  assert.equal(none.character.hint, "Name each picture in the words (\"<Picture 1> is Mira.\"), then write that name where they "
    + "act (\"Mira runs…\"): a picture the words never name barely shapes the clip.");
  const one = plan({ prompt: "<Picture 1> is Mira. Mira runs", refImages: ["a.png", "b.png"], song: true });
  assert.equal(one.character.receipt, "2 reference pictures, 1 not named + 8 steps + song (lip-sync)");
  assert.match(one.character.hint, /^Name the picture in the words \("<Picture 2> is Mira\."\)/);
  const all = plan({ prompt: "<Picture 1> is Mira. <Picture 2> is Mira side. Mira runs", refImages: ["a.png", "b.png"], song: true });
  assert.equal(all.character.receipt, "2 reference pictures + 8 steps + song (lip-sync)");
  assert.equal(all.character.hint, null, "named, the measured build, the song: nothing to add");
  /* A saved character is named by its bindings; the person's own unnamed picture is still said. */
  const mixed = plan({ refImages: ["own.png"] }, { persona: MIRA });
  assert.equal(mixed.character.receipt, "keeps Mira: 4 pictures, 1 not named + 8 steps");
  assert.match(mixed.character.hint, /^Name the picture in the words \("<Picture 1> is Mira\."\)/);
});

test("3: a saved character: bound after the request's pictures, its tag kept, its words folded, and said", () => {
  const p = plan({ prompt: "<Picture 1> is the red car. Mira runs through the rain", refImages: ["own.png"] }, { persona: MIRA });
  assert.deepEqual(p.refImages, ["own.png", "m1.png", "m2.png", "m3.png"], "the first three ride, after the request's own");
  assert.match(p.prompt, /^<Picture 2> is Mira\. <Picture 3> is Mira\. <Picture 4> is Mira\. Mira: a tall woman with cropped silver hair\. <Picture 1> is the red car\. Mira runs through the rain$/);
  assert.equal(p.warnings.find((w) => w.id === "persona-pictures")?.text,
    "Mira has 4 pictures; a clip takes the first 3 (the measured setup is 1–3 of one character).");
  assert.equal(p.notes.find((n) => n.id === "persona-unnamed"), undefined, "the words name her");
  assert.equal(p.character.persona, "Mira");
  assert.equal(p.character.receipt, "keeps Mira: 4 pictures + 8 steps");
  const tagged = bindPersonaForClip(MIRA, { prompt: "<Picture 1> is Mira in red. Mira waits" });
  assert.equal((tagged.prompt.match(/<Picture 1>/g) || []).length, 1, "a tag the words already use is not bound again");
  assert.match(tagged.prompt, /^<Picture 2> is Mira\. <Picture 3> is Mira\. /);
  const unnamed = plan({ prompt: "a woman runs" }, { persona: { ...MIRA, refImages: ["m1.png"] } });
  assert.match(unnamed.notes.find((n) => n.id === "persona-unnamed")?.text || "", /^The description never names Mira: write Mira where they act/);
  assert.equal(unnamed.character.hint, "The words never name Mira: write Mira where they act (\"Mira runs…\") so the pictures "
    + "attach to that person.");
  /* The person's own nine fill the node: the character does not ride, and the receipt does not claim it. */
  const nine = Array.from({ length: 9 }, (_, i) => `r${i}.png`);
  const full = plan({ prompt: nine.map((_, i) => `<Picture ${i + 1}> is Kai.`).join(" ") + " Kai runs", refImages: nine },
    { persona: MIRA });
  assert.equal(full.character.persona, null);
  assert.match(full.character.receipt, /^9 reference pictures \+ 8 steps/);
  assert.match(full.warnings.find((w) => w.id === "persona-pictures")?.text || "", /^Mira's pictures do not ride: 9 reference pictures are attached already/);
  assert.equal(full.notes.find((n) => n.id === "persona-unnamed"), undefined, "nothing of hers rides, so nothing to name");
  const many = plan({ refImages: ["a.png", "b.png", "c.png", "d.png"] });
  assert.equal(many.notes.find((n) => n.id === "pictures")?.text, "4 reference pictures ride. The measured setup is 1–3 per "
    + "character (face for a close-up; body + face for a medium; body + side + face for action); a fourth of one person was "
    + "never tried, and neither was its cost (up to three, each extra picture adds about 9 s at 8 steps, fitted on four clips "
    + "with 1–3 pictures on a 16 GB card).");
  const sound = plan({ refAudios: [{ name: "s.flac" }] });
  assert.match(sound.notes.find((n) => n.id === "audio-ref")?.text || "", /re-sings it in its own time; for a mouth that follows your song, use Song under the clip instead\.$/);
  assert.equal(p.notes.find((n) => n.id === "runs")?.text, "Runs: the 8-step reference build · 8 steps · res_multistep sampler · int8 video decoder.");
  /* The decoder: the measured setup used fp16, said while keeping; a request naming fp16 is not told. */
  assert.equal(p.notes.find((n) => n.id === "decoder")?.text, "The measured setup used the fp16 video decoder; this runs int8 "
    + "(the decoder was not isolated in that test). Engine settings → Video VAE can pick an fp16 file.");
  const fp16 = plan({ refImages: ["own.png"], videoVae: "minimax_h3_video_vae_fp16.safetensors" }, { persona: MIRA });
  assert.equal(fp16.notes.find((n) => n.id === "decoder"), undefined);
  assert.match(fp16.notes.find((n) => n.id === "runs")?.text || "", / · fp16 video decoder\.$/, "the runs line names the request's own");
  assert.equal(plan({ prompt: "a lamp", steps: 8 }).notes.find((n) => n.id === "decoder"), undefined, "no character, no decoder note");
});

test("3: the receipt and the Keep line, in the server's words", () => {
  const keep = plan({ prompt: "<Picture 1> is Mira. <Picture 2> is Mira. Mira sings", refImages: ["a.png", "b.png"], song: true });
  assert.equal(keep.character.receipt, `2 reference pictures + ${keep.steps} steps + song (lip-sync)`);
  assert.equal(keep.character.hint, null, "keeping, named, with the song: nothing to add");
  const who = plan({ audioTrack: { name: "song.flac", start: 12 } }, { persona: { ...MIRA, refImages: ["m1.png"] } });
  assert.equal(who.character.receipt, `keeps Mira: 1 picture + ${who.steps} steps + song (lip-sync)`, "audioTrack is the song too");
  const noSong = plan({ prompt: "<Picture 1> is Mira. Mira runs", refImages: ["a.png"] });
  assert.equal(noSong.character.hint, "If they sing, choose Song under the clip (lip-sync) and where the sung line starts.");
  const text = plan({ prompt: "a lamp", steps: 8, song: true });
  assert.equal(text.character.receipt, "text only · 8 steps · song under the clip");
  assert.equal(text.character.hint, "Lip-sync was measured with pictures of the singer; without them it is untested, and their "
    + "face can change from clip to clip.");
  const named = plan({ steps: 8 }, { characters: [{ name: "Mira", pictures: 2 }] });
  assert.equal(named.character.hint, "No picture of Mira rides: Mira can look different from clip to clip. Pick Mira under Keep my character.");
  const saved = plan({ prompt: "a lamp", steps: 8 }, { characters: [{ name: "Mira", pictures: 2 }] });
  assert.match(saved.character.hint, /No one in the shot\? Text only is fine, and so is Fast\. To keep someone, pick a saved character or drop 1–3 pictures of them here\.$/);
  const none = plan({ prompt: "a lamp", steps: 8 });
  assert.match(none.character.hint, /drop 1–3 pictures of them here \(tight, one person, a plain dark background\), or save a character on Pictures\.$/);
  assert.match(none.character.hint, /^No reference picture: a person in this clip can look different from clip to clip\. No one in the shot\? Text only is fine, and so is Fast\./);
});

test("3: Song under the clip says what it does on each engine; lip-sync only where mouths follow", () => {
  const h3With = plan({ prompt: "<Picture 1> is Mira. Mira sings", refImages: ["a.png"] }).songLine;
  assert.equal(h3With.meta, "lip-sync · optional");
  assert.match(h3With.hint, /^The mouth follows this stretch of the song \(measured with pictures of the singer\)/);
  const h3Text = plan({ prompt: "a lamp" }).songLine;
  assert.equal(h3Text.meta, "lip-sync with pictures · optional");
  assert.match(h3Text.hint, /from words alone lip-sync is untested\./);
  const ltx = videoPlan({ prompt: "a singer" }, { engineKey: "ltx", eng: E.ltx }).songLine;
  assert.equal(ltx.meta, "optional", "no lip-sync promised on LTX");
  assert.equal(ltx.hint, "The clip plays this stretch of the song, but mouths do not follow it on LTX (measured on 18 clips). "
    + "Set “start at” to where it should begin.");
  assert.doesNotMatch(ltx.meta + ltx.hint, /lip-sync/);
  const refused = videoPlan({ prompt: "a", refImages: ["a.png"] }, { engineKey: "ltx", eng: E.ltx });
  assert.equal(refused.refusal?.reason, "refs-ignored");
  assert.deepEqual(refused.songLine, ltx, "a refusal still carries the engine's song words");
  if (E.fasth3) {
    const f = videoPlan({ prompt: "a singer" }, { engineKey: "fasth3", eng: E.fasth3 }).songLine;
    assert.equal(f.meta, "optional");
    assert.match(f.hint, /lip-sync on .+ was never measured\./);
  }
  assert.deepEqual(songUnderSay("ltx"), ltx);
});

test("3: no character on LTX or FastH3, and a saved character there is refused like any reference", () => {
  for (const key of ["ltx", "fasth3"]) {
    const bare = videoPlan({ prompt: "a lamp" }, { engineKey: key, eng: E[key] });
    assert.equal(bare.character ?? null, null, `${key}: no character`);
    assert.equal(bare.sampler ?? null, null);
    const p = videoPlan({ prompt: "Mira runs" }, { engineKey: key, eng: E[key], persona: MIRA });
    assert.equal(p.refusal?.reason, "refs-ignored");
    assert.equal(p.refusal.error, refsIgnored(key, E[key].label));
  }
  const gone = videoPlan({ prompt: "Zed runs" }, { engineKey: "h3", eng: H3, persona: { name: "Zed", missing: true } });
  assert.deepEqual(gone.refusal, { error: personaUnknown("Zed"), reason: "persona" });
  assert.equal(personaUnknown("Zed"), 'No saved character called "Zed". Pictures → Character… (or list_personas) shows the saved ones.');
});

/* ── 4. the door ────────────────────────────────────────────────────────── */
const createDoor = () => {
  const index = read("./index.js");
  return index.slice(index.indexOf('if (b.action === "create") {\n        if (!config.video.enabled)'), index.indexOf('if (b.action === "engine") {'));
};

test("4: /api/video resolves the character before the safety check, and the check sees its pictures and its words", () => {
  const index = read("./index.js");
  const create = createDoor();
  const at = (s) => { const i = create.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("const persona = await clipPersona(b.persona);") < at("const clipLineage = lineage(["), "resolved before the lineage");
  assert.match(create, /if \(persona\?\.missing\) return json\(res, 400, \{ error: personaUnknown\(persona\.name\), reason: "persona" \}\);/);
  assert.match(create, /const boundPrompt = persona \? bindPersonaForClip\(persona, \{ prompt, refImages: b\.refImages \}\)\.prompt : prompt;/);
  assert.match(create, /const clipLineage = lineage\(\[[\s\S]{0,200}\.\.\.\(persona\?\.refImages \|\| \[\]\),[\s\S]{0,120}b\.sourceVideo/, "the character's pictures are context");
  assert.match(create, /safetyRefusal\(\{ door: "api\.video\.create", actor: prov\.actorFrom\(req\), texts: \[boundPrompt\],/, "the bound words are checked");
  assert.ok(at('door: "api.video.create"') < at("stageFrame(b.fromCover)"), "and the check still comes before anything is staged");
  assert.match(create, /persona: personaStaged,/, "the plan binds the staged pictures");
  assert.match(create, /refImages = plan\.refImages \|\| refImages;/, "the job carries them");
  assert.match(create, /if \(persona && personaLost > 0\) \{\n\s+plan\.warnings\.push\(\{ id: "persona-missing", text: personaMissing\(persona\.name, personaLost\) \}\);/);
  assert.match(create, /character: plan\.character \?\? null, sampler: plan\.sampler \?\? null \}\);/);
  const check = index.slice(index.indexOf('if (b.action === "check") {'), index.indexOf('if (b.action === "create") {'));
  assert.match(check, /persona: await clipPersona\(b\.persona\), characters: await clipCharacters\(\),/, "the check plans with the character too");
  assert.match(index, /return \(await personas\.get\(String\(name\)\.trim\(\)\)\) \|\| \{ name: String\(name\)\.trim\(\), missing: true \};/);
  assert.equal(personaFits("h3").fit, "yes", "a character can be used on H3");
  assert.equal(personaFits("ltx").fit, "no");
});

test("4: a saved character's pictures are staged like the request's own: an upload on Pictures rides, a lost one is said", async () => {
  /* The door's own resolvers, lifted and run against a temp library: the
   * character's pictures once went through stageFrame alone, which looks in
   * the library folders only, so a character saved from uploads (aiplay_frame_
   * names in ComfyUI's input folder) rendered text-only while the check said
   * "keeps Mira", and the reply blamed the library. */
  const index = read("./index.js");
  const from = index.indexOf("        const stageFrame = async (cover) => {");
  const to = index.indexOf("        /* ── VIDEO-TO-VIDEO, AND THE MODEL IT NEEDS");
  const refLine = /\n\s+const stageRef = async \(v\) => \{ try \{ return staged\(v\) \|\| await stageFrame\(v\); \} catch \{ return undefined; \} \};/.exec(index)?.[0];
  assert.ok(from > 0 && to > from && refLine, "stageFrame, staged and stageRef are where the door defines them");
  const create = createDoor();
  assert.match(create, /refImages = \(await Promise\.all\(wantedRefs\.map\(stageRef\)\)\)\.filter\(Boolean\);/, "the request's pictures use it");
  assert.match(create, /\(\{ persona: personaStaged, lost: personaLost \} = await stagePersonaForClip\(persona, \{ own: refImages\.length, stage: stageRef \}\)\);/,
    "and so do the character's");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "keep-stage-"));
  try {
    const COVER_DIR = path.join(tmp, "covers"), IMAGE_DIR = path.join(tmp, "images"), inputDir = path.join(tmp, "input");
    for (const d of [COVER_DIR, IMAGE_DIR, inputDir]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(IMAGE_DIR, "lib.png"), "png");
    const fsp = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const stageRef = new Function("path", "stat", "mkdir", "writeFile", "readFile", "createHash", "COVER_DIR", "IMAGE_DIR", "config",
      `${index.slice(from, to)}${refLine}\nreturn stageRef;`)(path, fsp.stat, fsp.mkdir, fsp.writeFile, fsp.readFile, createHash,
      COVER_DIR, IMAGE_DIR, { inputDir });
    const persona = { name: "Mira", refImages: ["aiplay_frame_0123456789ab.png", "lib.png", "gone.png", "m4.png"] };
    const { persona: staged, lost } = await stagePersonaForClip(persona, { own: 0, stage: stageRef });
    assert.equal(staged.refImages[0], "aiplay_frame_0123456789ab.png", "a picture uploaded on Pictures rides under its own name");
    assert.match(staged.refImages[1] || "", /^aiplay_frame_[0-9a-f]{10}\.png$/, "a library picture is copied into the input folder");
    assert.ok(existsSync(path.join(inputDir, staged.refImages[1])));
    assert.equal(staged.refImages.length, 2);
    assert.equal(lost, 1, "the missing third is lost; the fourth was never going to ride, so it is not counted");
    assert.equal(staged.pictures, 4);
    const room = await stagePersonaForClip(persona, { own: 8, stage: stageRef });
    assert.equal(room.persona.refImages.length, 1, "beside eight of the person's own, one of hers fits");
    assert.equal(room.lost, 0);
    const p = videoPlan({ prompt: "Mira runs" }, { engineKey: "h3", eng: DISK8, persona: staged });
    assert.deepEqual(p.refImages, staged.refImages, "the render carries the staged pictures");
    assert.equal(p.character.receipt, "keeps Mira: 2 pictures + 8 steps");
    assert.equal(p.warnings.find((w) => w.id === "persona-pictures")?.text,
      "Mira has 4 pictures; a clip takes the first 3 (the measured setup is 1–3 of one character).");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(personaMissing("Mira", 1), "1 of Mira's pictures could not be found and was left out.");
  assert.equal(personaMissing("Mira", 2), "2 of Mira's pictures could not be found and were left out.");
});

/* ── 5. the page ────────────────────────────────────────────────────────── */
test("5: Keep my character sits under the description, shows in Simple, and holds no words of its own", async () => {
  const html = read("../web/index.html"), app = read("../web/app.js"), css = read("../web/styles.css");
  const vidfit = read("../web/vidfit.js"), tips = read("../web/tips.js");
  for (const id of ["vidKeepField", "vidCharacter", "vidKeepDrop", "vidKeepPrev", "vidKeepNote", "vidSndHint"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  const p = html.slice(html.indexOf('id="vidPanel"'));
  assert.ok(p.indexOf('id="vidPrompt"') < p.indexOf('id="vidKeepField"') && p.indexOf('id="vidKeepField"') < p.indexOf('id="vidQualityRow"'),
    "between the description and the quality chips");
  assert.match(html, /<select id="vidCharacter" class="sel2" data-receipt="">/, "a slot for the server's receipt");
  const keepRule = /\.assist-on > ((?::not\([^)]+\))+) \{ display: none !important; \}/.exec(css)?.[1] || "";
  assert.match(keepRule, /:not\(#vidKeepField\)/, "Simple shows Keep my character");
  assert.match(keepRule, /:not\(#vidSndWrap\)/, "...and the song under the clip");
  /* Song under the clip promises nothing before the server speaks: its label's
   * words and its line are the server's per engine (songUnderSay). */
  const snd = html.slice(html.indexOf('id="vidSndWrap"'), html.indexOf('id="vidSndRow"'));
  assert.match(snd, /Song under the clip <span class="sp meta" id="vidSndMeta">optional<\/span>/);
  assert.doesNotMatch(html.slice(html.indexOf('id="vidSndWrap"'), html.indexOf('<div class="vsec">Fine tuning</div>')), /mouth follows|lip-sync &middot;/,
    "no lip-sync claim in the page's own words");
  const songSrc = /\nfunction paintSong\(r\) \{[\s\S]*?\n\}\n/.exec(vidfit)?.[0] || "";
  const els = { vidSndMeta: { textContent: "optional" }, vidSndHint: { textContent: "static" } };
  const paintSong = new Function("$", `${songSrc}return paintSong;`)((id) => els[id] || null);
  paintSong({ songLine: songUnderSay("ltx") });
  assert.deepEqual([els.vidSndMeta.textContent, els.vidSndHint.textContent], [songUnderSay("ltx").meta, songUnderSay("ltx").hint]);
  paintSong({ songLine: songUnderSay("h3", { pictures: 2 }) });
  assert.equal(els.vidSndMeta.textContent, "lip-sync · optional");
  paintSong({});
  assert.equal(els.vidSndMeta.textContent, "lip-sync · optional", "a reply without the words leaves the last ones");
  assert.match(html, /<select id="vidCharacter" class="sel2" data-receipt=""><option value="">No saved character<\/option><\/select>/,
    "the empty choice stays true while dropped pictures are kept");
  assert.match(app, /sel\.innerHTML = '<option value="">No saved character<\/option>'/);
  const refs = html.slice(html.indexOf('id="vidRefWrap"'), html.indexOf('id="vidSndWrap"'));
  assert.doesNotMatch(refs, /sings <b>&lt;Audio/, "the references help no longer offers <Audio 1> as the way to sing");
  assert.match(refs, /are re-sung; for lip-sync to your song use Song under the clip/);
  assert.match(tips, /vidKeep: \{ at: 'label\[for="vidCharacter"\]'/);
  assert.match(tips, /vidSnd: \{ at: 'label\[for="vidSndSong"\]', text: "The song sits under the clip while it renders, and the finished clip plays it\. On MiniMax H3 with pictures of the singer/);
  assert.match(tips, /on LTX mouths were measured not to follow it/);
  assert.match(tips, /Name each dropped picture in the description/);
  /* web/vidfit.js: the words are the server's, the check carries the character and the song. */
  for (const f of ["r.character?.hint", "r.character?.receipt", 'persona: $("vidCharacter")?.value || undefined',
    'song: $("vidSndRow") && !$("vidSndRow").hidden ? true : undefined']) {
    assert.ok(vidfit.includes(f), f);
  }
  assert.match(vidfit, /"vidCharacter", "vidSndSong", "vidSndStart", "vidVideoVae"\]\);/, "a change to any of them asks again");
  assert.ok(vidfit.includes("videoVae: videoVaeChosen(),"), "the check names Engine settings' decoder, so the Runs line is true");
  assert.ok(vidfit.includes("paintSong(r);"), "and paints Song under the clip's words");
  /* web/receipt.js: the steps field reads Keep my character's words first. */
  const { RECEIPTS } = await import("../web/receipt.js");
  assert.deepEqual(RECEIPTS.video.fields.find((f) => f.id === "steps").controls, ["vidCharacter", "vidSteps"]);
  assert.match(read("../web/receipt.js"), /attributeFilter: \["data-receipt"\]/, "and repaints when they change");
  /* The render sends the character by name, never picked by the page. */
  assert.match(app, /persona: \$\("vidCharacter"\)\?\.value \|\| undefined,/);
  assert.match(app, /fetch\("\/api\/personas\?for=h3"\)/);
  assert.match(app, /state\.vidClipPictures = d\?\.clipPictures \?\? null;/, "how many of a character's pictures ride is the server's");
  assert.match(read("./index.js"), /\.\.\.\(eng === "h3" \? \{ clipPictures: CLIP_PERSONA_PICTURES \} : \{\}\),/);
  /* vidPaint's lines are lifted and run alone, so every new name is guarded. */
  const line = /\n  const keeping = [^\n]+;/.exec(app)?.[0] || "";
  const keeping = (dollar, state, cur) => new Function("$", "state", "cur", `${line}\nreturn keeping;`)(dollar, state, cur);
  assert.equal(keeping(() => null, { refImages: [] }, "h3"), false, "no select, no pictures: text only");
  assert.equal(keeping(() => null, {}, "h3"), false, "no state yet");
  assert.equal(keeping(() => null, { refImages: [{}] }, "h3"), true, "a picture keeps");
  assert.equal(keeping(() => ({ value: "Mira" }), { refImages: [] }, "h3"), true, "a saved character keeps");
  assert.equal(keeping(() => ({ value: "Mira" }), { refImages: [{}] }, "ltx"), false, "LTX keeps no one");
  /* The Standard chip is the reference build's own count while keeping. */
  const qsSrc = /\nfunction vidQualitySteps\(eng, keeping = false\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] || "";
  const vidQualitySteps = new Function(`${qsSrc}return vidQualitySteps;`)();
  const status = { stepDefaults: { fast: 3, standard: 4, best: 20 }, referenceSteps: 8, keepFast: { steps: 4, note: "N" } };
  assert.deepEqual(vidQualitySteps(status), { fast: 3, standard: 4, best: 20 });
  assert.deepEqual(vidQualitySteps(status, true), { fast: 4, standard: 8, best: 20 }, "Fast while keeping is the reference path's own");
  assert.deepEqual(vidQualitySteps({ ...status, keepFast: { steps: 8 }, referenceSteps: 8 }, true), { fast: 8, standard: 8, best: 20 },
    "where Fast would run Standard's count it equals it, and hides");
  assert.deepEqual(vidQualitySteps({ stepDefaults: status.stepDefaults }, true), { fast: 4, standard: 4, best: 20 }, "an older status: Standard");
  assert.match(app, /const qs = vidQualitySteps\(eng, keeping\);/);
  /* The Fast chip never makes the TaoMate claim for a kept character. */
  assert.match(app, /\$\("vidQFast"\)\.title = keeping \? \(eng\.keepFast\?\.note \|\| build\(qs\.fast\)\) : /);
  assert.match(app, /\$\("vidQualityNote"\)\.textContent = keeping \? \(\(qs\.fast !== qs\.standard && eng\.keepFast\?\.note\) \|\| ""\) : \(eng\.fastNote \|\| ""\);/);
  /* The estimate: a kept character loads the reference files, and still says references cost time. */
  assert.match(app, /const hasRefs = keeping \|\| \(\(state\.refImages \|\| \[\]\)\.length \+ \(state\.refAudios \|\| \[\]\)\.length\) > 0;/);
  assert.match(app, /\+ \(cur === "h3" && \(keeping \|\| \(state\.refAudios \|\| \[\]\)\.length\)\n\s+\? " · references ride along, expect it slower" : ""\)/);
  /* The strip: a character's picture uploaded on Pictures has no library route; its place shows the name. */
  const stripSrc = /\nfunction paintKeepStrip\(\) \{[\s\S]*?\n\}\n/.exec(app)?.[0] || "";
  const box = { innerHTML: "", hidden: true };
  const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const strip = new Function("$", "state", "esc", "REF_IMG_MAX", "picDrops", "imgRefCandidates", `${stripSrc}return paintKeepStrip;`)(
    (id) => (id === "vidKeepPrev" ? box : id === "vidCharacter" ? { value: "Mira" } : null),
    { refImages: [], vidClipPictures: 3, vidCharacters: [{ name: "Mira", refImages: ["aiplay_frame_0123456789ab.png", "lib.png"] }] },
    esc, 9, {}, () => [{ name: "lib.png", url: "/api/image/lib.png" }]);
  strip();
  assert.equal(box.hidden, false);
  assert.match(box.innerHTML, /<div class="keepph" title="&lt;Picture 1&gt; Mira \(uploaded on Pictures; no preview here\)">Mira<\/div>/);
  assert.match(box.innerHTML, /<img src="\/api\/image\/lib\.png" alt="" title="&lt;Picture 2&gt; Mira">/);
  assert.doesNotMatch(box.innerHTML, /\/api\/image\/aiplay_frame_/, "no broken library URL for an upload");
  assert.match(app, /if \(typeof vidLoadCharacters === "function"\) vidLoadCharacters\(\);/, "typeof-guarded where it is called from another screen");
});

test("5: the Simple assistant and the H3 guide say how to keep a person and make them sing", async () => {
  const { formIntro } = await import("./chat/form-tools.js");
  const { VIDEO_GUIDES } = await import("./chat/model-guides.js");
  const intro = formIntro("video").join("\n");
  assert.match(intro, /KEEPING A PERSON\. If the clip shows someone who must look the same as in other clips, set vidCharacter/);
  assert.match(intro, /never claim it is kept without\npictures/);
  assert.match(intro, /set vidSndSong to the song and vidSndStart to where the sung line starts: on MiniMax\nH3 with pictures of the singer that is lip-sync \(on LTX mouths do not follow it\)/);
  assert.match(intro, /Name each dropped picture in the description \("<Picture 1> is Mira\."\)/);
  const h3 = VIDEO_GUIDES.h3.rules.join(" ");
  assert.match(h3, /To keep a person the same across clips: 1–3 tight pictures of them/);
  assert.match(h3, /To make them sing in time: the song under the clip \(Song under the clip\), not a sound reference \(<Audio 1>\), which re-sings\./);
});

/* ── 6. make_clip ───────────────────────────────────────────────────────── */
test("6: make_clip takes persona, refuses it where references are refused, and says what the render keeps", async () => {
  const { TOOLS } = await import("./mcp.js");
  const { videoLoraInput } = await import("./video-lora-validation.js");
  const { emptyResultNote } = await import("./art-wait.js");
  const t = TOOLS.find((x) => x.name === "make_clip");
  const run = (api) => new Function("api", "safeName", "waitForArt", "videoLoraInput", "emptyResultNote",
    `return (${String(t.run).replace(/^async run\(/, "async function(")});`)(api, (v) => v, async () => {}, videoLoraInput, emptyResultNote);
  const mock = ({ engine, sentence, door = {} }) => {
    const posts = [];
    const api = async (method, p, body) => {
      if (method === "POST") posts.push(body);
      if (p === "/api/status") return { config: { video: { enabled: true, ready: true, engine,
        engines: { [engine]: { label: E[engine].label, ...(sentence ? { refsIgnored: sentence } : {}) } } } } };
      if (p === "/api/clips") return { clips: [] };
      return door;
    };
    return { api, posts };
  };
  const receipt = "keeps Mira: 3 pictures + 8 steps + song (lip-sync)";
  const h = mock({ engine: "h3", door: { job: { id: "v1" }, character: { keeps: true, receipt, hint: null } } });
  const r = await run(h.api)({ prompt: "Mira sings on a rooftop", persona: "Mira", soundtrack_song: "song.flac", soundtrack_start: 42 });
  assert.equal(h.posts.at(-1).persona, "Mira", "the character reaches the door by name");
  assert.deepEqual(h.posts.at(-1).audioTrack, { name: "song.flac", start: 42 });
  assert.equal(r.character, receipt);
  const said = refsIgnored("ltx", E.ltx.label);
  const l = mock({ engine: "ltx", sentence: said });
  await assert.rejects(run(l.api)({ prompt: "Mira runs", persona: "Mira" }), (e) => e.message.startsWith(said));
  assert.equal(l.posts.length, 0, "nothing was rendered");
  const c = mock({ engine: "h3", door: { ok: true, engine: "h3", steps: 8, sampler: "res_multistep",
    character: { keeps: false, receipt: "text only · 8 steps", hint: "No reference picture: …" }, warnings: [], notes: [],
    songLine: songUnderSay("h3") } });
  const chk = await run(c.api)({ prompt: "a lamp", check_only: true });
  assert.equal(c.posts.at(-1).action, "check");
  assert.deepEqual([chk.keeps_character, chk.character, chk.character_hint, chk.sampler, chk.soundtrack],
    [false, "text only · 8 steps", "No reference picture: …", "res_multistep", songUnderSay("h3").hint]);
  assert.match(t.inputSchema.properties.soundtrack_song.description, /on LTX mouths do not follow it/);
  const d = String(t.description);
  assert.match(d, /KEEPING A CHARACTER \(measured 2026-09-24, same seeds, two blind judges\)/);
  assert.ok(d.includes("If they sing, add `soundtrack_song` and `soundtrack_start` (where the sung line starts)"), "the song rule");
  assert.match(d, /the clip re-sings it in its own time/);
  assert.doesNotMatch(d, /which is the tool for a performance shot/);
  assert.doesNotMatch(d, /performs the song from <Audio 1>/);
  assert.match(t.inputSchema.properties.persona.description, /^A saved character by name \(list_personas\)\. Up to 3 of its pictures ride/);
  assert.match(t.inputSchema.properties.ref_song.description, /Re-sung in the clip's own time; not lip-sync \(use soundtrack_song\)\./);
});

test("6: the music-video tools say where the song goes, and the lint's fixes are one call", async () => {
  const src = read("./mcp-mv.js");
  assert.doesNotMatch(src, /the output plays it; a lyrical shot lip-syncs it/, "mv_generate_clip's old claim is gone");
  assert.match(src, /mv_shot says before you spend whether the song is under this scene/);
  assert.match(src, /always \(new projects since 2026-09-24, Hex Appeal's setup\)/);
  assert.match(src, /Its render-time cost was never measured on its own\./);
  assert.match(src, /refProminence, crowd, lipSync\}/, "mv_set_board names crowd and lipSync");
  assert.match(src, /tool: "mv_set_shot", args: \{ slug: a\.slug, segment: i\.fix\.segmentId, refs: i\.fix\.refs \}/);
  assert.match(src, /tool: "mv_set_brief", args: \{ slug: a\.slug, \.\.\.snake\(i\.fix\.brief\) \}/);
  const { mvTools } = await import("./mcp-mv.js").catch(() => ({}));
  if (typeof mvTools === "function") {
    const lint = mvTools(async () => ({ issues: [
      { level: "warn", where: "scene 2", msg: "m", fix: { label: "Tick Mira", action: "set_shot", segmentId: "s1_1", refs: ["Mira"] } },
      { level: "warn", where: "brief", msg: "m", fix: { label: "Send cast pictures", action: "set_brief", brief: { videoEngine: "hybrid", castRefs: true } } },
      { level: "warn", where: "style", msg: "m" },
    ] }), (v) => v)?.find?.((x) => x.name === "mv_lint");
    assert.ok(lint, "mv_lint is in the table");
    if (lint) {
      const out = await lint.run({ slug: "p" });
      assert.deepEqual(out[0].fix, { label: "Tick Mira", tool: "mv_set_shot", args: { slug: "p", segment: "s1_1", refs: ["Mira"] } });
      assert.deepEqual(out[1].fix, { label: "Send cast pictures", tool: "mv_set_brief", args: { slug: "p", video_engine: "hybrid", cast_refs: true } });
      assert.equal(out[2].fix, undefined);
    }
  }
});
