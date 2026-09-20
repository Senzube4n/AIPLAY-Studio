/**
 * A finished song → the two-voice score YuE2 sings from: the cover recipe.
 *
 * SheetSage2, run as ComfyUI's own audio-encoder node (core from 0.35; this
 * rig is on 0.36), transcribes a recording into the planner's layout — both
 * voices, chords in "full" mode, melody alone in "melody" mode, which the
 * node's tooltip recommends for covers. Then /api/generate with that score
 * (cot melody or full, closed) and a NEW style line re-renders it from
 * scratch: only the melody and chords survive, and "female vocal" → "male
 * vocal" is a change to the style line. That is exactly the published
 * Song-To-ABC workflow (realrebelai/LOW_VRAM_Workflows), read node by node.
 *
 * The hum path (hum.js) is the model-free sibling for a single voice; this
 * one needs the 1.39 GB encoder on the audio_encoders shelf (catalogue row
 * coverSheetSage2) and holds the card for the transcription.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { stageSource, HumRefusal } from "./hum.js";
import { readScoreText } from "../score/abc.js";

export const SHEETSAGE_FILE = "sheetsage2_bf16.safetensors";
export const SHEETSAGE_CAPABILITY = "coverSheetSage2";
export const MODES = ["melody", "full"];

export class CoverRefusal extends Error {
  constructor(message, { status = 400, needsModel = null } = {}) { super(message); this.status = status; this.needsModel = needsModel; }
}

/**
 * The graph, exactly the workflow's transcription lane: encoder → audio →
 * SheetSage2AudioToABC → PreviewAny, whose text is what /history hands back.
 * Node ids are strings on purpose (ComfyUI's own convention for API prompts).
 */
export function buildSongToScoreGraph({ audio, mode = "melody", encoder = SHEETSAGE_FILE } = {}) {
  if (!audio) throw new Error("buildSongToScoreGraph needs the staged audio file name");
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  return {
    "1": { class_type: "AudioEncoderLoader", inputs: { audio_encoder_name: encoder } },
    "2": { class_type: "LoadAudio", inputs: { audio } },
    "3": { class_type: "SheetSage2AudioToABC", inputs: { audio_encoder: ["1", 0], audio: ["2", 0], mode } },
    "4": { class_type: "PreviewAny", inputs: { source: ["3", 0] } },
  };
}

function run(cmd, argv, { timeoutMs = 120e3 } = {}) {
  return new Promise((resolve) => {
    let err = "";
    const p = spawn(cmd, argv, { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, err: `${err}\n${e.message}` }); });
    p.on("exit", (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
}

/** Is the encoder on the shelf ComfyUI loads audio encoders from? */
export async function encoderPresent(modelsDir = config.modelsDir) {
  try { return (await stat(path.join(modelsDir, "audio_encoders", SHEETSAGE_FILE))).size > 0; }
  catch { return false; }
}

/**
 * Transcribe one recording. `engine` is the engine door (server/engine/client.js:
 * run + history). Returns { abc, mode, bpm, key, bars, source, runId }.
 *
 * ⚠ `system`, not `user` — see the note on ensureStem. An unattributable
 * transcription is unattributable, not the person's, and only a `user` stamp
 * moves an asset toward a human origin class. /api/cover passes the door's
 * actor; nothing else should be able to borrow a person's name by omission.
 */
export async function songToScore({ source, mode = "melody", engine, actor = "system", via = "music.cover", ffmpeg = "ffmpeg" } = {}) {
  if (!engine?.run || !engine?.history) throw new Error("songToScore needs the engine door");
  if (!MODES.includes(mode)) throw new CoverRefusal(`mode must be melody or full, not ${JSON.stringify(mode)}.`);
  if (!(await encoderPresent())) {
    throw new CoverRefusal(
      `The SheetSage2 encoder (${SHEETSAGE_FILE}) is not on the audio_encoders shelf. Install "Cover — SheetSage2 song-to-score" on the Models screen; nothing was started.`,
      { needsModel: SHEETSAGE_CAPABILITY });
  }
  const tmp = path.join(os.tmpdir(), "aiplay-cover", randomUUID().slice(0, 8));
  let staged;
  try {
    try { staged = await stageSource(source, tmp); }
    catch (e) { throw new CoverRefusal(e.message, { status: e.status || 400 }); }
    /* ComfyUI's LoadAudio lists the input folder by extension, so a browser
     * recording (webm) or anything exotic is turned into WAV first; the
     * containers it lists are copied as they are. */
    const ext = path.extname(staged.path).toLowerCase();
    let filePath = staged.path, outExt = ext;
    if (![".wav", ".mp3", ".flac", ".ogg", ".m4a"].includes(ext)) {
      const wav = path.join(tmp, "source.wav");
      const conv = await run(ffmpeg, ["-y", "-v", "error", "-i", staged.path, "-f", "wav", wav]);
      if (conv.code !== 0) throw new CoverRefusal(`ffmpeg could not read the recording: ${(conv.err || "").trim().split("\n").pop() || "unknown container"}`);
      filePath = wav; outExt = ".wav";
    }
    const bytes = await readFile(filePath);
    const name = `aiplay_cover_${createHash("sha1").update(bytes).digest("hex").slice(0, 12)}${outExt}`;
    await mkdir(config.inputDir, { recursive: true });
    await writeFile(path.join(config.inputDir, name), bytes);

    const graph = buildSongToScoreGraph({ audio: name, mode });
    const r = await engine.run({ graph, actor, via, label: `Song to score (SheetSage2, ${mode})`, adopt: false, timeoutMs: 20 * 60e3 });
    const status = r?.status ?? r?.result?.status;
    if (status !== "completed") throw new CoverRefusal(`The transcription did not finish: ${r?.error || r?.result?.error || status || "no answer"}`, { status: 500 });
    /* PreviewAny keeps its text in /history under the node's outputs; the
     * door's own output list carries files only. */
    const h = await engine.history(r.promptId);
    const text = h?.[r.promptId]?.outputs?.["4"]?.text;
    const abc = Array.isArray(text) ? String(text.join("")) : (typeof text === "string" ? text : "");
    if (!abc.trim()) throw new CoverRefusal("The engine finished but handed back no score.", { status: 500 });
    let bpm = null, key = null, bars = null;
    try { const s = readScoreText(abc); bpm = s.headers?.bpm ?? null; key = s.headers?.key ?? null; bars = s.bars ?? null; }
    catch { /* the score is returned regardless; the reader's verdict is advisory */ }
    return { abc, mode, bpm, key, bars, runId: r.runId ?? null, promptId: r.promptId ?? null,
             source: { name: staged.name, kind: staged.kind, bytes: staged.bytes, sha256: staged.sha256, staged: name } };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
