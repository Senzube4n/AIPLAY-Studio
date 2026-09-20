/**
 * Clip continuation arithmetic and the ffmpeg join, 2026-09-17.
 *
 * H3 extends a clip the way the song engines extend a take: the tail of the
 * finished clip is anchored as a native guide at frame zero of a longer window
 * (MiniMaxH3AddGuide takes a 17k+5 frame batch plus its audio), the model
 * continues, the hidden overlap is dropped in the graph, and what comes back is
 * NEW FRAMES ONLY that follow the source's last frame. Joining the two files is
 * pixel-space work, so it is ffmpeg's — this app ships without ffmpeg by
 * promise, so a machine without it keeps the new clip alone and says so.
 *
 * The rolling-overlap method is ttulttul's (ComfyUI-Minimax-H3-Continuation,
 * MIT); his nodes carry the latent tail across, this carries the decoded tail
 * through the VAE again, which costs one re-encode at the seam and needs no
 * custom node.
 *
 * Frame rules (comfy_extras/nodes_minimax_h3.py): a clip is 17k+5 frames; the
 * guide batch must be 17k+5 too; so the window = overlap (17k+5) + extension
 * (17m) is itself a valid length.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function ffmpegPath(explicit = null) {
  if (explicit) return explicit;
  if (process.env.AIPLAY_FFMPEG) return process.env.AIPLAY_FFMPEG;
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}
export function ffprobePath(explicit = null) {
  if (explicit) return explicit;
  if (process.env.AIPLAY_FFPROBE) return process.env.AIPLAY_FFPROBE;
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

function run(bin, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}
const missing = (err) => !!err && (err.code === "ENOENT" || /ENOENT/.test(String(err.message)));

/** The largest 17k+5 that fits both the wish and the clip. Null below 5 frames. */
export function overlapFor(frames, want = 22) {
  const cap = Math.min(Number(want) || 22, Number(frames) || 0);
  if (cap < 5) return null;
  return Math.floor((cap - 5) / 17) * 17 + 5;
}

/** The smallest multiple of 17 that covers the seconds asked for. */
export function extensionFrames(seconds, fps = 24) {
  const n = Math.max(1, Math.round((Number(seconds) || 0) * fps));
  return Math.max(17, Math.ceil(n / 17) * 17);
}

/** What a clip is: frames, fps, size, whether it carries audio. */
export async function probeClip(file, { ffprobe = null, timeoutMs = 60_000 } = {}) {
  const bin = ffprobePath(ffprobe);
  const { err, stdout } = await run(bin, [
    "-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_read_frames",
    "-of", "json", file,
  ], timeoutMs);
  if (missing(err)) {
    return { error: `ffprobe was not found (tried ${bin}). This app ships without ffmpeg by promise: `
      + "install ffmpeg, or point AIPLAY_FFPROBE at an ffprobe binary, and ask again." };
  }
  if (err) return { error: `ffprobe failed: ${String(err.message).split("\n")[0]}` };
  let j;
  try { j = JSON.parse(stdout); } catch { return { error: "ffprobe returned output this could not parse." }; }
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  if (!v) return { error: "no video stream" };
  const [num, den] = String(v.r_frame_rate || "24/1").split("/").map(Number);
  const fps = den ? num / den : num;
  const frames = Number(v.nb_read_frames) || 0;
  return {
    frames, fps, width: Number(v.width) || 0, height: Number(v.height) || 0,
    seconds: fps ? frames / fps : 0,
    hasAudio: (j.streams || []).some((s) => s.codec_type === "audio"),
    /* COUNTS, not just "is there audio". A clip arriving from somebody else's
     * machine is checked for exactly one video stream and no audio at all —
     * "has audio" cannot answer the first half, and a file with two video
     * streams is not a clip, it is a container with something else in it. */
    videoStreams: (j.streams || []).filter((s) => s.codec_type === "video").length,
    audioStreams: (j.streams || []).filter((s) => s.codec_type === "audio").length,
  };
}

/**
 * source + extension -> out, re-encoded once so the two encodes meet cleanly.
 * Audio is kept only when BOTH carry it (the concat filter wants matching
 * streams). Returns { ok, error }.
 */
export async function joinClips(source, extension, out, { crf = 14, ffmpeg = null, timeoutMs = 300_000 } = {}) {
  const [a, b] = await Promise.all([probeClip(source), probeClip(extension)]);
  if (a.error) return { ok: false, error: a.error };
  if (b.error) return { ok: false, error: b.error };
  const audio = a.hasAudio && b.hasAudio;
  const filter = audio
    ? "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]"
    : "[0:v][1:v]concat=n=2:v=1[v]";
  const args = [
    "-v", "error", "-y", "-i", source, "-i", extension,
    "-filter_complex", filter, "-map", "[v]",
    ...(audio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-c:v", "libx264", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    out,
  ];
  const { err, stderr } = await run(ffmpegPath(ffmpeg), args, timeoutMs);
  if (missing(err)) {
    return { ok: false, error: `ffmpeg was not found (tried ${ffmpegPath(ffmpeg)}); the new clip is kept on its own.` };
  }
  if (err) return { ok: false, error: `ffmpeg failed: ${stderr.trim().split("\n").slice(-2).join(" ") || err.message}` };
  return { ok: true, audio, frames: a.frames + b.frames };
}

/** Two tiny synthetic clips for a lane: colour bars + a tone, exact frame counts. */
export async function makeTestClips({ frames = 24, fps = 24, width = 64, height = 64, audio = true, ffmpeg = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-clipjoin-"));
  const mk = async (name, hue) => {
    const file = path.join(dir, name);
    const args = ["-v", "error", "-y",
      "-f", "lavfi", "-i", `color=c=${hue}:s=${width}x${height}:r=${fps}`,
      ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=${hue === "red" ? 440 : 660}:sample_rate=48000`] : []),
      "-frames:v", String(frames),
      ...(audio ? ["-shortest", "-c:a", "aac"] : ["-an"]),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", file];
    const { err, stderr } = await run(ffmpegPath(ffmpeg), args, 60_000);
    if (err) throw Object.assign(new Error(missing(err) ? "ffmpeg missing" : `ffmpeg: ${stderr.trim()}`), { missing: missing(err) });
    return file;
  };
  await writeFile(path.join(dir, ".keep"), "");
  return { dir, a: await mk("a.mp4", "red"), b: await mk("b.mp4", "blue"), out: path.join(dir, "joined.mp4"),
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}
