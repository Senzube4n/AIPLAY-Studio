/**
 * An OPEN seed score: key, tempo and meter for YuE2, nothing else.
 *
 * The planner writes its scores in one layout (any run's score.abc): X:1, a
 * blank title, M:, L:1/32, Q:1/4=<bpm>, the two voice declarations, K:, then
 * "% intro" and the bars. Handed those headers with the score left OPEN
 * (yue_driver.py --abc-open, no ABC_END), the planner continues from exactly
 * where its own scores begin — so the song it plans is in the key, at the
 * tempo, in the meter you chose, and everything after that is its own. No
 * bars are written here on purpose: a rest bar would be sung as silence, and
 * a note would be a melody nobody asked for.
 *
 * MEASURED 2026-09-17: run 019860f4's own header is exactly this shape
 * (Q:1/4=92, K:Em, then "% intro"), so the seed is a prefix of what the model
 * already writes. Whether it honours the key on every seed is the planner's
 * business; the first live run is the measurement.
 */
const KEY_RE = /^[A-G](b|#)?m?$/;
const METERS = ["4/4", "3/4", "6/8", "2/4"];

export function seedScore({ key = null, bpm = null, meter = null } = {}) {
  const k = key == null || key === "" ? null : String(key).trim();
  const b = bpm == null || bpm === "" ? null : Number(bpm);
  const m = meter == null || meter === "" ? null : String(meter).trim();
  if (k !== null && !KEY_RE.test(k)) {
    throw new Error(`key must be a letter A–G, an optional b or #, and an optional m for minor (Em, Bb, F#m) — not ${JSON.stringify(k)}`);
  }
  if (b !== null && !(Number.isInteger(b) && b >= 40 && b <= 240)) {
    throw new Error(`bpm must be a whole number from 40 to 240 — not ${JSON.stringify(bpm)}`);
  }
  if (m !== null && !METERS.includes(m)) {
    throw new Error(`meter must be one of ${METERS.join(", ")} — not ${JSON.stringify(m)}`);
  }
  if (k === null && b === null && m === null) return null;
  return [
    "X:1", "T:", `M:${m ?? "4/4"}`, "L:1/32", `Q:1/4=${b ?? 120}`,
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
    'V: Ins clef=treble name="Ins Melody" snm="Inst."',
    `K:${k ?? "C"}`,
    "% intro",
    "",
  ].join("\n");
}

export const SEED_METERS = METERS;
export const SEED_KEY_RE = KEY_RE;
