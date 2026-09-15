// Pure score planning: no model, filesystem, generation queue or audio editing.
import { checkScore, applyMechanical } from "./mcp-music-score.js";

const LIMIT = 65536;
export const MUSIC_PLAN_BODY_LIMIT = 128 * 1024;
const fields = new Set(["abc", "bpm", "bars", "meter", "target_seconds"]);
const finite = (n, lo, hi) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
const round = (n) => Math.round(n * 100) / 100;
const caveat = "Notation time is not guaranteed audio duration. This does not extend, preserve or imitate an input recording. Rendering a changed score makes a new take; match any tempo in the style prompt to the score.";

export function planMusic(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a planning object.");
  const unknown = Object.keys(input).filter(k => !fields.has(k) && input[k] !== undefined);
  if (unknown.length) throw new Error(`Unsupported planning fields: ${unknown.join(", ")}. Audio inputs are not supported.`);
  const has = k => input[k] !== undefined;
  if (has("bpm") && (!Number.isInteger(input.bpm) || !finite(input.bpm, 20, 400))) throw new Error("BPM must be a whole number from 20 to 400.");
  if (has("target_seconds") && !finite(input.target_seconds, 1, 900)) throw new Error("Target notation length must be 1–900 seconds.");
  if (has("abc")) {
    if (typeof input.abc !== "string" || !input.abc.trim() || input.abc.includes("\0") || Buffer.byteLength(input.abc) > LIMIT) throw new Error("ABC must be nonempty text, at most 64 KiB, without NUL.");
    if (has("bars") || has("meter")) throw new Error("With ABC, bar counts and meter come from the notes, not overrides.");
    if (has("bpm") && has("target_seconds")) throw new Error("Choose BPM or target notation length, not both.");
    // A Windows text file's CRLF is transport formatting, not a musical edit.
    // The shared strict native checker remains unchanged; returned proposals
    // use LF, and the caller's original file is never modified.
    const sourceAbc = input.abc.replace(/\r\n/g, "\n");
    const check = checkScore(sourceAbc);
    if (!check.ok) return { ok: false, mode: "score", problems: check.problems, diagnosis: check.diagnosis, note: caveat };
    const quarters = check.facts.quarters_as_written;
    if (!quarters || !check.header.bpm) throw new Error("The score needs a positive notated length and quarter-note tempo.");
    const bpm = has("target_seconds") ? Math.round(quarters * 60 / input.target_seconds) : input.bpm ?? check.header.bpm;
    if (!Number.isInteger(bpm) || bpm < 20 || bpm > 400) throw new Error("That length would require a tempo outside 20–400 BPM. Change the arrangement/bar count instead.");
    const changed = bpm !== check.header.bpm;
    const abc = changed ? applyMechanical("tempo", { abc: sourceAbc, bpm }).abc : sourceAbc;
    return { ok: true, mode: "score", changed, abc, bpm, meter: check.header.meter,
      bars: check.facts.bars_per_voice, quarters, nominal_seconds: round(quarters * 60 / bpm),
      original_seconds: check.facts.nominal_seconds, target_seconds: input.target_seconds ?? null,
      note: caveat, generated_audio: false, saved: false };
  }
  if (has("bars") && has("target_seconds")) throw new Error("Choose a bar count or target notation length, not both.");
  const meter = input.meter ?? "4/4";
  if (!["2/4", "3/4", "4/4", "6/8"].includes(meter)) throw new Error("Planner meter must be 2/4, 3/4, 4/4 or 6/8.");
  const [top, bottom] = meter.split("/").map(Number), quartersPerBar = top * 4 / bottom;
  const bpm = input.bpm ?? 120;
  const bars = has("target_seconds") ? Math.max(1, Math.round(input.target_seconds * bpm / (60 * quartersPerBar))) : input.bars ?? 32;
  if (!Number.isInteger(bars) || bars < 1 || bars > 1024) throw new Error("Bar count must be 1–1024.");
  return { ok: true, mode: "outline", bpm, meter, bars, quarters: bars * quartersPerBar,
    nominal_seconds: round(bars * quartersPerBar * 60 / bpm), target_seconds: input.target_seconds ?? null,
    note: `${caveat} This outline is arithmetic only, not a generated melody or model parameter.`, generated_audio: false, saved: false };
}

export function createMusicPlanRoutes({ json, readBody }) {
  const tooLarge = () => Object.assign(new Error("Planning request exceeds 128 KiB."), { status: 413 });
  async function boundedBody(req) {
    if (Number(req.headers?.["content-length"] || 0) > MUSIC_PLAN_BODY_LIMIT) { req.resume?.(); throw tooLarge(); }
    if (typeof req[Symbol.asyncIterator] !== "function") {
      // Preserve dependency injection without letting fixture/alternate readers
      // bypass the same parsed-body limit.
      const body = await readBody(req);
      if (Buffer.byteLength(JSON.stringify(body)) > MUSIC_PLAN_BODY_LIMIT) throw tooLarge();
      return body;
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers?.["content-type"] || "")) {
      req.resume?.(); throw Object.assign(new Error("Use application/json for music planning."), { status: 415 });
    }
    const chunks = [];
    let bytes = 0;
    const input = req.iterator ? req.iterator({ destroyOnReturn: false }) : req;
    for await (const chunk of input) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > MUSIC_PLAN_BODY_LIMIT) { req.resume?.(); throw tooLarge(); }
      chunks.push(buf);
    }
    return bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }
  return async (req, res, url) => {
    if (url.pathname !== "/api/music-plan") return false;
    if (req.method !== "POST") { json(res, 405, { error: "Use POST with an ABC score or musical outline." }); return true; }
    try { json(res, 200, planMusic(await boundedBody(req))); }
    catch (error) { json(res, error.status || 400, { error: error.message }); }
    return true;
  };
}
