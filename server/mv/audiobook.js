/**
 * Audiobook pipeline — ingest, plan, narrate, beds, mix.
 *
 * The unit of output is the BUNDLE: one MP3 of 5-15 minutes holding one or
 * more whole chapters. Chapters are never split across files unless a single
 * chapter alone exceeds the ceiling (webnovel chapters rarely do; a novel's
 * might, and then it splits on scene breaks).
 *
 * ONE VOICE PER BOOK. The voice is chosen once and recorded on the project;
 * every narration run reads it from there, which is what keeps chapter 40
 * sounding like chapter 1. Beds are REUSABLE by design: a bed row carries the
 * mood it was made for, and any bundle can point at any bed — regenerating a
 * bed for every chapter would cost GPU and coherence at the same time.
 *
 * TTS runs as a python subprocess (the lrc.py/beats.py precedent), NEVER
 * through ComfyUI — but it still respects the single GPU: narration waits for
 * the render queues to go idle, and the synth script releases its VRAM when
 * it exits. Beds go through the ordinary music queue like any song.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { readProject, updateProject, assetsDir, noteRun } from "./store.js";

const SCENE_PAUSE = "<<<PAUSE>>>";

/* ─────────────────────────────────────────────────────── subprocesses */

function runPy(script, args, timeoutMs = 30 * 60e3, python = config.python) {
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [script, ...args], { windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`${path.basename(script)} timed out`)); }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.slice(-500) || `${path.basename(script)} exited ${code}`));
      try { resolve(JSON.parse(out.trim().split("\n").pop())); }
      catch { reject(new Error(`bad JSON from ${path.basename(script)}: ${out.slice(-200)}`)); }
    });
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ─────────────────────────────────────────────────────────── ingest */

export async function ingestBook(slug, bookPath) {
  const outJson = path.join(assetsDir(slug), "book.json");
  await mkdir(assetsDir(slug), { recursive: true });
  // the extractor splits chapters bigger than one bundle, so it needs the ceiling
  const pre = await readProject(slug);
  const maxWords = Math.round((pre?.settings?.targetMaxMinutes ?? 15) * (pre?.settings?.wpm ?? 165));
  const sum = await runPy(path.join(HERE, "extract_book.py"), [bookPath, outJson, String(maxWords)], 10 * 60e3);
  if (!sum.ok) throw new Error(sum.error || "extraction failed");
  const data = JSON.parse(await readFile(outJson, "utf8"));

  /* Front matter is real text but not narration: contents pages, copyright,
   * dedications. Skips are HEURISTIC and visible — a skipped chapter stays in
   * the inventory marked skipped, so the chapter manager can un-skip it. */
  const FRONT = /^(contents|copyright|dedication|title page|cover|epigraph|map|also by|discover more|about the (author|publisher)|acknowledg)/i;
  // Copyright pages hide behind generic spine titles ("Part 2") — one test
  // book narrated five minutes of publisher legal front-matter before this
  // caught it. The text knows what it is even when the title doesn't.
  const LEGAL = /all rights reserved|copyright ©|\bISBN\b|Library of Congress|purchased in bulk|supports the right to free expression/i;
  const chapters = data.chapters.map((c, i) => ({
    idx: i, title: c.title, words: c.words,
    skip: !!c.toc || FRONT.test(c.title) || (c.words < 150 && FRONT.test(c.text.slice(0, 80)))
      || (c.words < 1500 && LEGAL.test(c.text.slice(0, 1200))) || c.words < 60,
  }));

  return updateProject(slug, (doc) => {
    doc.book = { path: bookPath, title: data.title, author: data.author, chapters };
    doc.title = doc.title === "Untitled" ? data.title : doc.title;
    doc.bundles = [];
    noteRun(doc, { tool: "ab_ingest", outcome: `${chapters.filter((c) => !c.skip).length} narratable chapters of ${chapters.length}, ${chapters.reduce((a, c) => a + c.words, 0)} words` });
    return doc;
  });
}

/* ──────────────────────────────────────────────────────────── plan */

/**
 * Greedy-pack whole chapters into 5-15 minute bundles at the configured
 * narration rate. A chapter longer than the ceiling gets its own bundle
 * (split-on-scene-breaks is the narrator script's job, not the planner's).
 */
export async function planBundles(slug) {
  // the mood classifier needs the actual text, which lives in book.json
  let bookText = null;
  try { bookText = JSON.parse(await readFile(path.join(assetsDir(slug), "book.json"), "utf8")); }
  catch { /* mood suggestions just stay empty */ }
  return updateProject(slug, (doc) => {
    if (!doc.book) throw new Error("Ingest a book first.");
    const s = doc.settings;
    const minW = s.targetMinMinutes * s.wpm;
    const maxW = s.targetMaxMinutes * s.wpm;
    const bundles = [];
    let cur = null;
    for (const ch of doc.book.chapters) {
      if (ch.skip) continue;
      if (cur && cur.words + ch.words > maxW && cur.words >= minW * 0.6) {
        bundles.push(cur); cur = null;
      }
      if (!cur) cur = { idx: bundles.length, chapterIdxs: [], words: 0, status: "planned" };
      cur.chapterIdxs.push(ch.idx);
      cur.words += ch.words;
      if (cur.words >= maxW) { bundles.push(cur); cur = null; }
    }
    if (cur) bundles.push(cur);
    for (const b of bundles) {
      const first = doc.book.chapters[b.chapterIdxs[0]];
      const last = doc.book.chapters[b.chapterIdxs[b.chapterIdxs.length - 1]];
      b.title = b.chapterIdxs.length === 1 ? first.title : `${first.title} – ${last.title}`;
      b.estMinutes = Math.round(b.words / s.wpm);
      b.narration = []; b.sfx = []; b.bedId = null; b.mixFile = null; b.seed = null;
      // chapter-aware ambience: what this stretch of story reads like, so the
      // ambush chapters get the dark bed and the festival gets the calm one
      if (bookText?.chapters) {
        const sample = b.chapterIdxs.map((i) => (bookText.chapters[i]?.text || "").slice(0, 12000)).join("\n");
        b.suggestedMood = classifyMood(sample);
      }
    }
    doc.bundles = bundles;
    const moods = bundles.map((b) => b.suggestedMood).filter(Boolean);
    noteRun(doc, { tool: "ab_plan", outcome: `${bundles.length} bundles, ${bundles.map((b) => b.estMinutes + "m").join(", ")}${moods.length ? ` · moods: ${moods.join(",")}` : ""}` });
    return doc;
  });
}

/* ─────────────────────────────────────────────────────────── narrate */

/** Split a bundle's text into TTS-sized chunks on paragraph edges. */
function chunkText(text, maxChars = 700) {
  const paras = text.split(/\n\n+/);
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const p of paras) {
    if (p.includes(SCENE_PAUSE)) { push(); chunks.push(SCENE_PAUSE); continue; }
    if ((cur + "\n\n" + p).length > maxChars) {
      push();
      if (p.length > maxChars) {
        // a monster paragraph splits on sentence edges
        let acc = "";
        for (const sent of p.split(/(?<=[.!?…])\s+/)) {
          if ((acc + " " + sent).length > maxChars) { chunks.push(acc.trim()); acc = sent; }
          else acc = acc ? acc + " " + sent : sent;
        }
        if (acc.trim()) chunks.push(acc.trim());
        continue;
      }
    }
    cur = cur ? cur + "\n\n" + p : p;
  }
  push();
  return chunks;
}

/** Narrator-facing cleanup: things TTS reads badly. */
function narratorScript(title, text) {
  let t = text;
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/\bch(?:ap)?\.\s*(\d+)/gi, "chapter $1");
  // A chapter announces itself, then breathes.
  return `${title}.\n\n${SCENE_PAUSE}\n\n${t}`;
}

/* ──────────────────────────────────────────── emotion + mood tagging */

/* The site's deriveEmotion pattern (keyword table, first strong signal wins),
 * grown for prose. The tag rides every chunk into script.json; qwen3 turns it
 * into a delivery instruction, kokoro into a subtle speed nudge. Cheap, local,
 * and wrong at worst by being neutral. */
const EMOTION_RES = [
  [/\b(scream|blood|corpse|dagger|knife at|throat|terror|panic|dread|horror|trembl)/i, "fearful"],
  [/\b(battle|fight|charged|lunged|sprinted|chase|clash|struck|swung|dodged|fled)/i, "tense"],
  [/\b(wept|weep|tears|grief|mourn|farewell|goodbye|buried|sorrow|heartbroken|lonely)/i, "sad"],
  [/\b(laughed|laughter|grinned|joy|delight|celebrat|feast|danced|cheer)/i, "joyful"],
  [/\b(rage|furious|snarl|spat|slammed|cursed|shouted at|bellowed)/i, "angry"],
  [/\b(whisper|shadow|secret|silent|crept|lurk|hidden|mist|eerie|strange light)/i, "mysterious"],
];
const deriveEmotion = (text) => (EMOTION_RES.find(([re]) => re.test(text)) || [, "neutral"])[1];

const EMOTION_INSTRUCT = {
  tense: "Low, taut, urgent delivery; forward momentum.",
  fearful: "Hushed, uneasy, on edge; let pauses breathe.",
  sad: "Soft and slow, heavy, gentle at line ends.",
  joyful: "Bright, warm, a smile in the voice.",
  angry: "Hard-edged, clipped, forceful.",
  mysterious: "Quiet, deliberate, secretive.",
};
const EMOTION_SPEED = { sad: 0.95, mysterious: 0.97, fearful: 0.97, joyful: 1.04, angry: 1.03 };

/* Which ambient bed a stretch of story wants. Scores per 1000 words so a long
 * chapter doesn't out-shout a short one; calm is the resting state. */
const MOOD_RES = {
  dark: /\b(blood|death|corpse|shadow|fear|scream|grave|curse|demon|rot|dread|murder)\b/gi,
  action: /\b(fight|battle|sword|charged|chase|ran|arrow|clash|struck|gallop|fled|attack)\b/gi,
  wonder: /\b(magic|glow|shimmer|marvel|stars|enchant|wondrous|luminous|spell|mystic)\b/gi,
};
export function classifyMood(text) {
  const words = Math.max(text.split(/\s+/).length, 1);
  let best = "calm", bestScore = 1.2;   // calm unless a mood clearly earns it
  for (const [mood, re] of Object.entries(MOOD_RES)) {
    const score = ((text.match(re) || []).length / words) * 1000;
    if (score > bestScore) { best = mood; bestScore = score; }
  }
  return best;
}

/* ─────────────────────────────────────────────── dialogue casting */

const SAID = "(?:said|asked|replied|answered|shouted|whispered|muttered|growled|" +
  "cried|called|snapped|added|continued|exclaimed|murmured|hissed|roared|sighed|" +
  "warned|agreed|admitted|offered|demanded|insisted|began|observed|remarked|grumbled|barked|" +
  "laughed|smiled|grinned|frowned|nodded|shrugged|sneered|scoffed|spat|repeated|echoed|" +
  "wondered|mused|conceded|countered|pressed|urged|promised|corrected|finished|concluded|" +
  "breathed|gasped|stammered|prompted|retorted|interjected|ventured|interrupted|declared|announced)";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which cast member speaks in this paragraph, judged by explicit attribution
 * ("...," said Geralt / Geralt said, "..."). Null = unattributed. */
function speakerOf(paragraph, cast) {
  for (const c of cast) {
    for (const name of [c.name, ...(c.aliases || [])].filter(Boolean)) {
      const n = reEsc(name);
      if (new RegExp(`${SAID}\\s+(?:the\\s+)?${n}\\b`, "i").test(paragraph)) return c;
      if (new RegExp(`\\b${n}[^"\\n]{0,50}?\\b${SAID}\\b`, "i").test(paragraph)) return c;
    }
  }
  return null;
}

/**
 * Turn chapter text into TTS chunks, each carrying the voice that reads it.
 *
 * With no cast this is exactly the old path: everything in the narrator's
 * voice, paragraphs packed into ~700-char chunks. With a cast, quoted spans in
 * an attributed paragraph switch to that character's persona while the prose
 * around them (including the "said X" tail) stays with the narrator — the
 * audiobook convention. A run of unattributed quote-paragraphs alternates
 * between the last two distinct speakers, which is how prose dialogue works.
 */
export function buildChunks(text, cast, narrator) {
  const active = (cast || []).filter((c) => c?.voice?.persona);
  if (!active.length) {
    return chunkText(text).map((c) =>
      c === SCENE_PAUSE ? { text: "", pause: true }
        : { text: c, voice: null, emotion: deriveEmotion(c) });
  }

  const pieces = [];                 // [{text, voice} | {pause:true}]
  let lastTwo = [];                  // most recent distinct speakers, newest last
  let prevSpeaker = null;            // who spoke the previous quote-paragraph
  let prevWasDialogue = false;

  for (const para of text.split(/\n\n+/)) {
    if (!para.trim()) continue;
    if (para.includes(SCENE_PAUSE)) {
      pieces.push({ pause: true });
      prevWasDialogue = false; prevSpeaker = null;
      continue;
    }
    const quoteChars = (para.match(/"[^"]+"/g) || []).join("").length;
    const isDialogue = quoteChars > 0;
    let who = isDialogue ? speakerOf(para, active) : null;
    if (isDialogue && !who && prevWasDialogue && lastTwo.length === 2) {
      // back-and-forth with the attributions dropped: the other one speaks
      who = lastTwo[0] === prevSpeaker ? lastTwo[1] : lastTwo[0];
    }
    if (who) {
      lastTwo = [...lastTwo.filter((s) => s !== who), who].slice(-2);
      // split the paragraph at its quotes; quotes speak, prose narrates
      let idx = 0;
      for (const m of para.matchAll(/"([^"]{2,})"/g)) {
        const before = para.slice(idx, m.index).trim();
        if (before) pieces.push({ text: before, voice: null });
        pieces.push({ text: m[1], voice: who.voice.persona });
        idx = m.index + m[0].length;
      }
      const tail = para.slice(idx).trim();
      if (tail) pieces.push({ text: tail, voice: null });
    } else {
      pieces.push({ text: para, voice: null });
    }
    prevWasDialogue = isDialogue;
    prevSpeaker = isDialogue ? who : null;
  }

  // pack consecutive same-voice pieces back into ~700-char chunks
  const chunks = [];
  let run = [], runVoice = null;
  const flush = () => {
    if (!run.length) return;
    for (const c of chunkText(run.join("\n\n"))) {
      chunks.push(c === SCENE_PAUSE ? { text: "", pause: true }
        : { text: c, voice: runVoice, emotion: deriveEmotion(c) });
    }
    run = [];
  };
  for (const p of pieces) {
    if (p.pause) { flush(); chunks.push({ text: "", pause: true }); continue; }
    if (p.voice !== runVoice) { flush(); runVoice = p.voice; }
    run.push(p.text);
  }
  flush();
  return chunks;
}

export async function narrateBundle(deps, slug, bundleIdx, { waitForIdle } = {}) {
  const doc = await readProject(slug);
  if (!doc?.book) throw new Error("No book.");
  const b = doc.bundles.find((x) => x.idx === Number(bundleIdx));
  if (!b) throw new Error(`No bundle ${bundleIdx}`);
  if (!doc.voice?.model) throw new Error("Choose the voice first (ab_set_voice) — one voice narrates the whole book.");

  const book = JSON.parse(await readFile(path.join(assetsDir(slug), "book.json"), "utf8"));
  const text = b.chapterIdxs.map((i) => narratorScript(book.chapters[i].title, book.chapters[i].text)).join(`\n\n${SCENE_PAUSE}\n\n`);
  const chunks = buildChunks(text, doc.cast, doc.voice.persona);

  /* The GPU is shared. Narration is CPU/GPU-heavy for minutes, so it waits for
   * the render queues to drain rather than fighting a clip mid-flight. */
  if (waitForIdle) await waitForIdle();

  const outDir = path.join(assetsDir(slug), `narration_${b.idx}`);
  await mkdir(outDir, { recursive: true });
  const base = config.tts?.instruct || "Warm, unhurried audiobook narrator.";
  const job = {
    model: doc.voice.model, voice: doc.voice.persona, pauseMs: 650,
    chunks: chunks.map((c, i) => ({
      text: c.text, pause: !!c.pause, voice: c.voice || undefined,
      // emotion applied per engine: qwen3 hears an instruction, kokoro a nudge
      instruct: doc.voice.model === "qwen3" && EMOTION_INSTRUCT[c.emotion]
        ? `${base} ${EMOTION_INSTRUCT[c.emotion]}` : undefined,
      speed: EMOTION_SPEED[c.emotion],
      out: path.join(outDir, `c${String(i).padStart(4, "0")}.wav`),
    })),
  };
  const jobPath = path.join(outDir, "job.json");
  if (doc.voice.model === "qwen3") job.instruct = base;
  await writeFile(jobPath, JSON.stringify(job));
  // The script is the bundle's ground truth for everything that comes after:
  // SFX cue timing reads chunk text against narration durations, the LRC
  // export re-times its sentences, and the chapter manager shows who reads
  // what in which register.
  await writeFile(path.join(outDir, "script.json"),
    JSON.stringify(chunks.map((c) => ({ text: c.text, pause: !!c.pause, voice: c.voice || null, emotion: c.emotion || null }))));
  // Qwen3 lives in the sidecar venv; kokoro in the engine venv. See config.tts.
  const python = doc.voice.model === "qwen3" ? (config.tts?.python || config.python) : config.python;
  const res = await runPy(path.join(HERE, "tts.py"), [jobPath], 90 * 60e3, python);
  if (!res.ok) throw new Error(res.error || "tts failed");

  return updateProject(slug, (doc2) => {
    const b2 = doc2.bundles.find((x) => x.idx === b.idx);
    b2.narration = res.files.map((f, i) => ({ ...f, voice: chunks[i]?.voice || null }));
    b2.narrationSeconds = res.totalSeconds;
    b2.status = "narrated";
    const cast = new Set(chunks.map((c) => c.voice).filter(Boolean));
    noteRun(doc2, { tool: "ab_narrate", outcome: `bundle ${b.idx}: ${Math.round(res.totalSeconds / 60)} min in ${res.files.length} chunks (${doc2.voice.model}/${doc2.voice.persona}${cast.size ? ` + cast: ${[...cast].join(", ")}` : ""})` });
    return doc2;
  });
}

/**
 * Voice auditions: every candidate persona reads the SAME line from THIS book,
 * so casting happens by ear, on the material. Samples are content-addressed
 * (persona + text hash) — re-auditioning costs nothing, and the files sit in
 * the project's assets so the ordinary asset route serves them.
 */
export async function auditionVoices(slug, { personas, text } = {}) {
  const doc = await readProject(slug);
  if (!doc) throw new Error("No such project.");
  let sample = String(text || "").trim();
  if (!sample) {
    try {
      const book = JSON.parse(await readFile(path.join(assetsDir(slug), "book.json"), "utf8"));
      const ch = book.chapters.find((c, i) => !doc.book?.chapters?.[i]?.skip && c.words > 200);
      sample = (ch?.text || "").replace(/\s+/g, " ").slice(0, 220);
    } catch { /* fall through */ }
  }
  if (!sample) sample = "The road wound down into the valley, and the smell of woodsmoke reached them long before the village did.";

  const list = (personas?.length ? personas : [
    { model: "kokoro", persona: "bm_george" }, { model: "kokoro", persona: "bm_fable" },
    { model: "kokoro", persona: "bf_emma" }, { model: "kokoro", persona: "af_heart" },
    { model: "kokoro", persona: "af_bella" }, { model: "kokoro", persona: "am_michael" },
    { model: "kokoro", persona: "am_adam" },
  ]);
  const hash = createHash("sha1").update(sample).digest("hex").slice(0, 8);
  await mkdir(assetsDir(slug), { recursive: true });

  const out = [];
  // one tts.py run per ENGINE (kokoro loads once for all its personas)
  for (const model of [...new Set(list.map((p) => p.model))]) {
    const mine = list.filter((p) => p.model === model);
    const chunks = [];
    for (const p of mine) {
      const file = `aud_${model}_${p.persona}_${hash}.wav`;
      const full = path.join(assetsDir(slug), file);
      out.push({ model, persona: p.persona, file });
      try { await stat(full); continue; } catch { /* render it */ }
      chunks.push({ text: sample, voice: p.persona, out: full });
    }
    if (!chunks.length) continue;
    const job = { model, voice: mine[0].persona, pauseMs: 200, chunks };
    if (model === "qwen3") job.instruct = config.tts?.instruct;
    const jobPath = path.join(assetsDir(slug), `audition_${model}.json`);
    await writeFile(jobPath, JSON.stringify(job));
    const python = model === "qwen3" ? (config.tts?.python || config.python) : config.python;
    const res = await runPy(path.join(HERE, "tts.py"), [jobPath], 20 * 60e3, python);
    if (!res.ok) throw new Error(res.error || "audition tts failed");
  }
  await updateProject(slug, (doc2) => {
    noteRun(doc2, { tool: "ab_audition", outcome: `${out.length} voices auditioned on "${sample.slice(0, 50)}…"` });
    return doc2;
  });
  return { sample, voices: out };
}

/** Assign character voices. cast: [{name, aliases?, voice:{model,persona}, note?}].
 * Narrated bundles keep their audio — re-narrate to apply a cast change. */
export async function setCast(slug, cast) {
  if (!Array.isArray(cast)) throw new Error("cast must be an array");
  return updateProject(slug, (doc) => {
    doc.cast = cast.map((c) => ({
      name: String(c.name || "").trim(),
      aliases: (c.aliases || []).map((a) => String(a).trim()).filter(Boolean),
      voice: c.voice?.persona ? { model: c.voice.model || doc.voice?.model || "kokoro", persona: c.voice.persona } : null,
      note: c.note || "",
    })).filter((c) => c.name);
    noteRun(doc, { tool: "ab_set_cast", outcome: `${doc.cast.length} cast: ${doc.cast.map((c) => `${c.name}→${c.voice?.persona || "narrator"}`).join(", ")}` });
    return doc;
  });
}

/* ────────────────────────────────────────────────────────────── beds */

const BED_PROMPTS = {
  calm: "Ambient instrumental. Global Metadata. 60 BPM, minor key, cinematic ambient, calm and contemplative. Arrangement. warm sustained pads, distant piano notes, very sparse, no drums, no vocals, long evolving textures, quiet.",
  dark: "Ambient instrumental. Global Metadata. 55 BPM, minor key, dark ambient drone, ominous and tense. Arrangement. low drones, subtle dissonant strings, faint metallic textures, no drums, no vocals, slow swells.",
  action: "Instrumental score. Global Metadata. 110 BPM, minor key, cinematic hybrid tension, urgent. Arrangement. pulsing low strings, sparse percussion hits, rising ostinato, no vocals, driving but not busy.",
  wonder: "Ambient instrumental. Global Metadata. 70 BPM, major key, ethereal fantasy ambient, wondrous. Arrangement. shimmering pads, soft choir-like textures, gentle bells, no drums, no vocals, spacious.",
};

/**
 * Make one reusable bed through the ordinary music queue. ~1 minute of audio
 * is plenty: the mixer LOOPS beds with an equal-power crossfade, so a short
 * bed covers any bundle without an audible seam.
 */
export async function makeBed(deps, slug, { mood = "calm", seed } = {}) {
  const { jobs } = deps;
  const caption = BED_PROMPTS[mood] || BED_PROMPTS.calm;
  const usedSeed = Number.isFinite(seed) ? Number(seed) : Math.floor(Math.random() * 4294967296);
  const job = jobs.enqueue({
    title: `bed · ${mood}`, caption, lyrics: "[Instrumental]\n[Outro]",
    seed: usedSeed, maxDuration: 90, instrumental: true,
    /* A bed is never a paid song: nothing here asks the person to pay for
     * one. With the hosted engine on, the runner refuses it in words and
     * sends nothing (server/jobs.js LOCAL_ONLY). */
    requiresLocal: true,
  });
  const done = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { jobs.off("update", onUpd); reject(new Error("bed render timed out")); }, 30 * 60e3);
    const onUpd = () => {
      const h = jobs.history.find((j) => j.id === job.id);
      if (!h) return;
      clearTimeout(timer); jobs.off("update", onUpd);
      if (h.state === "done" && h.file) resolve(h);
      else reject(new Error(h.error || "bed render failed"));
    };
    jobs.on("update", onUpd);
  });

  return updateProject(slug, (doc) => {
    const id = `bed_${doc.beds.length + 1}`;
    doc.beds.push({ id, mood, caption, file: done.file, seed: usedSeed,
                    seconds: done.durationSeconds ?? null });
    noteRun(doc, { tool: "ab_bed", outcome: `${id} (${mood}) ← ${done.file} seed ${usedSeed}` });
    return doc;
  });
}

/* ─────────────────────────────────────────────────────────────── mix */

export async function mixBundle(deps, slug, bundleIdx) {
  const doc = await readProject(slug);
  const b = doc?.bundles.find((x) => x.idx === Number(bundleIdx));
  if (!b) throw new Error(`No bundle ${bundleIdx}`);
  if (!b.narration?.length) throw new Error("Narrate it first.");
  const s = doc.settings;

  // narration chunks laid end to end
  const items = [];
  let t = 0;
  for (const n of b.narration) {
    items.push({ src: n.file, start: t, dur: n.seconds, inPoint: 0 });
    t += n.seconds;
  }

  const tracks = [{ gain: 1.0, items }];
  let duck = null;
  // explicit choice > the bundle's own mood > whatever exists
  const bed = doc.beds.find((x) => x.id === b.bedId)
    || doc.beds.find((x) => x.mood === b.suggestedMood)
    || doc.beds[0];
  if (s.bed && bed) {
    const bedPath = path.join(config.outputDir, bed.file);
    tracks.push({ gain: Math.pow(10, (s.bedGainDb ?? -14) / 20), items: [
      { src: bedPath, start: 0, dur: t + 2, inPoint: 0, loop: true, loopFadeSec: 3, fadeIn: 2, fadeOut: 3 },
    ] });
    duck = { source: 0, targets: [1], depthDb: s.duckDb ?? -13, attackMs: 120, releaseMs: 500, thresholdDb: -45 };
  }
  for (const fx of b.sfx || []) {
    tracks.push({ gain: fx.gain ?? 0.8, items: [{ src: fx.file, start: fx.at, dur: fx.seconds, inPoint: 0 }] });
  }

  const outDir = path.join(config.outputDir, "ab", doc.slug, "out");
  await mkdir(outDir, { recursive: true });
  // map dashes to "-" before stripping, or "Part 1 – Part 4" collapses to a double space
  const fsSafe = (s) => String(s).replace(/[–—]/g, "-").replace(/[^\w ,'-]+/g, "").replace(/\s+/g, " ").trim();
  const outFile = path.join(outDir, `${String(b.idx + 1).padStart(2, "0")} - ${fsSafe(doc.title)} - ${fsSafe(b.title).slice(0, 60)}.mp3`);
  const jobPath = path.join(assetsDir(slug), `mix_${b.idx}.json`);
  await writeFile(jobPath, JSON.stringify({
    out: outFile, sampleRate: 44100, tracks, duck,
    normalize: { rmsDb: -20, peakDb: -3 },
  }));
  const res = await runPy(path.join(HERE, "mix.py"), [jobPath], 30 * 60e3);

  /* Read-along sidecar: the narration chunks already carry exact start times,
   * so an .lrc costs nothing. Sentences inside a chunk are timed by their
   * share of its characters — approximate, but read-along approximate, and
   * any LRC-aware player scrolls the book as it plays. */
  let lrcFile = null;
  try {
    const script = JSON.parse(await readFile(path.join(assetsDir(slug), `narration_${b.idx}`, "script.json"), "utf8"));
    const stamp = (t) => `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}.${String(Math.floor((t % 1) * 100)).padStart(2, "0")}]`;
    const lines = [`[ti:${b.title}]`, `[al:${doc.title}]`, `[by:AIPLAY Studio]`];
    let t = 0;
    for (let i = 0; i < script.length; i++) {
      const dur = b.narration[i]?.seconds || 0;
      const text = script[i]?.text || "";
      if (text.trim()) {
        const sents = text.replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]*/g) || [text];
        const total = sents.reduce((a, s2) => a + s2.length, 0) || 1;
        let off = 0;
        for (const s2 of sents) {
          if (s2.trim()) lines.push(`${stamp(t + (off / total) * dur)}${s2.trim()}`);
          off += s2.length;
        }
      }
      t += dur;
    }
    lrcFile = outFile.replace(/\.mp3$/i, ".lrc");
    await writeFile(lrcFile, lines.join("\n"), "utf8");
  } catch { /* older narrations predate scripts — the MP3 still stands alone */ }

  return updateProject(slug, async (doc2) => {
    const b2 = doc2.bundles.find((x) => x.idx === b.idx);
    b2.mixFile = outFile;
    b2.lrcFile = lrcFile;
    b2.bedId = bed?.id ?? null;
    b2.status = "mixed";
    b2.mixSeconds = res.seconds;
    for (const i of b2.chapterIdxs) {
      const ch = doc2.book.chapters.find((c) => c.idx === i);
      if (ch) ch.done = true;
    }
    noteRun(doc2, { tool: "ab_mix", outcome: `bundle ${b.idx} → ${path.basename(outFile)} (${Math.round(res.seconds / 60)}m${bed ? ", bed " + bed.id : ""})` });
    return doc2;
  });
}

/* ─────────────────────────────────────────────── the chapter manager map */

export function abBoard(doc) {
  const nodes = [], edges = [];
  nodes.push({ id: "book", kind: "book", label: doc.book?.title || "book" });
  if (doc.voice) nodes.push({ id: "voice", kind: "voice", label: `${doc.voice.model}/${doc.voice.persona}` });
  for (const bed of doc.beds) nodes.push({ id: bed.id, kind: "bed", label: `${bed.id} (${bed.mood})`, seed: bed.seed });
  for (const b of doc.bundles) {
    const id = `bundle:${b.idx}`;
    nodes.push({ id, kind: "bundle", label: `${String(b.idx + 1).padStart(2, "0")} ${b.title}`.slice(0, 40),
                 status: b.status || "planned", minutes: b.mixSeconds ? Math.round(b.mixSeconds / 60) : b.estMinutes,
                 has: !!b.mixFile });
    edges.push({ from: "book", to: id, w: 0.3 });
    if (doc.voice && b.narration?.length) edges.push({ from: "voice", to: id, w: 0.8 });
    if (b.bedId) edges.push({ from: b.bedId, to: id, w: 0.6 });
    for (const fx of b.sfx || []) edges.push({ from: `sfx:${fx.label}`, to: id, w: 0.4 });
  }
  const chapters = (doc.book?.chapters || []);
  return {
    nodes, edges,
    chapters: chapters.map((c) => ({ idx: c.idx, title: c.title, words: c.words,
      skip: !!c.skip, done: !!c.done,
      bundle: doc.bundles.find((b) => b.chapterIdxs.includes(c.idx))?.idx ?? null })),
  };
}
