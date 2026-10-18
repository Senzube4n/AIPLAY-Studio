/**
 * VOICE PROMPTS: the mic button in Chat and My pages (web/voice.js).
 *
 *   POST /api/voice {audio: base64, type: "audio/webm"}  ->  {text}
 *
 * The browser records; createVoiceTranscriber hands the file to the
 * timed-lyrics whisper on the art queue and deletes it. Only the words come
 * back, and they go into a text box the person reads before sending anything.
 * Same-origin local JSON only: another web page cannot queue whisper. The
 * job is filed under the caller (actorFrom), like every other door.
 */
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { actorFrom } from "./provenance.js";

/** 4 MB of base64 is about 3 MB of audio: far past the two minutes the button records. */
const MAX_BODY = 4 * 1024 * 1024;

/** The browser's own recording formats, as a file extension; anything else is refused. */
export function voiceExt(type) {
  const t = String(type || "").toLowerCase();
  return /^audio\/webm/.test(t) ? "webm" : /^audio\/ogg/.test(t) ? "ogg" : /^audio\/(mp4|aac|x-m4a)/.test(t) ? "m4a" : null;
}

/** Own one temporary recording and its Whisper job, including timeout cleanup.
 * A running worker can still need its input after Stop returns. Keep that file
 * until the runner confirms the exact job has finished; never stop its successor. */
export function createVoiceTranscriber({ art, dir, checkSetup = () => {}, timeoutMs = 10 * 60_000,
  pollMs = 400, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  return async function transcribe(bytes, ext, actor) {
    await checkSetup();
    await mkdir(dir, { recursive: true });
    const input = path.join(dir, `${randomUUID()}.${ext}`);
    const file = `whisper:${randomUUID()}`;
    let job = null, hasRun = false;
    const removeInput = () => unlink(input).catch(() => {});
    const active = () => art.current === job || (art.queue || []).includes(job);
    const terminal = () => {
      if (!job) return true;
      hasRun ||= art.current === job || Number.isFinite(job.startedAt) || !!job.child;
      return !active() && (!hasRun || Number.isFinite(job.finishedAt) || (art.done || []).includes(job));
    };
    try {
      await writeFile(input, bytes);
      try {
        job = art.request({ file, title: "Voice prompt", kind: "whisper", asked: true, actor,
          whisper: { input, vocals: null, lyrics: null, language: null, words: false, outStem: null } });
      } catch (e) {
        // request() can enqueue before an update listener throws.
        job = [art.current, ...(art.queue || [])].find((j) => j?.file === file && j.kind === "whisper") || null;
        throw e;
      }
      if (!job) throw new Error(`Not queued: ${art.lastRefusal || "the queue refused it"}.`);
      const end = now() + timeoutMs;
      for (;;) {
        hasRun ||= art.current === job || Number.isFinite(job.startedAt) || !!job.child;
        if (!active()) {
          if (job.error || !job.transcript) throw new Error(job.error ? String(job.error) : "The transcription stopped.");
          return String(job.transcript.text || "").trim();
        }
        if (now() >= end) throw new Error(`Whisper took longer than ${timeoutMs === 600_000 ? "10 minutes" : `${timeoutMs} ms`}.`);
        await sleep(Math.min(pollMs, Math.max(0, end - now())));
      }
    } catch (e) {
      throw Object.assign(new Error(String(e?.message || e).split(input).join("the recording").split(dir).join("Studio's data folder")), { setup: e?.setup });
    } finally {
      if (job && active()) {
        hasRun ||= art.current === job || Number.isFinite(job.startedAt) || !!job.child;
        // drop() is synchronous and touches only this unique queued file.
        if ((art.queue || []).includes(job)) { try { art.drop(file); } catch { /* inspect the resulting state */ } }
        // stopCurrent() captures current synchronously, before its first await.
        if (art.current === job) { try { await art.stopCurrent(); } catch { /* retain input until terminal */ } }
      }
      if (terminal()) await removeInput();
      else {
        const cleanup = () => {
          if (!terminal()) return;
          art.off("update", cleanup);
          void removeInput();
        };
        art.on("update", cleanup);
        cleanup();
      }
    }
  };
}

export function createVoiceRoute({ json, readBody, sameOriginLocalJson, transcribe }) {
  return async function route(req, res, url) {
    if (url.pathname !== "/api/voice") return false;
    if (req.method !== "POST") { json(res, 405, { error: "POST a recording." }); return true; }
    if (!sameOriginLocalJson(req)) { json(res, 403, { error: "Only Studio's own page can send a recording." }); return true; }
    let b;
    try { b = await readBody(req, MAX_BODY); } catch { json(res, 400, { error: "That recording is too long." }); return true; }
    const ext = voiceExt(b?.type);
    const bytes = typeof b?.audio === "string" ? Buffer.from(b.audio, "base64") : null;
    if (!ext || !bytes?.length) { json(res, 400, { error: "That recording could not be read." }); return true; }
    try { json(res, 200, { text: await transcribe(bytes, ext, actorFrom(req)) }); }
    catch (e) { json(res, 400, { error: String(e?.message || e), ...(e?.setup ? { setup: e.setup } : {}) }); }
    return true;
  };
}
