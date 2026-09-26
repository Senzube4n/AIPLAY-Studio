/**
 * THIS PC'S OWN SPEED, per video engine.
 *
 * Every clip estimate (the Video screen's "about 4:59", the clip deadline in
 * art.js) comes from one cost curve fitted on the lab's NVIDIA card. On an
 * RX 9060 XT (2026-09-24) an 8-step H3 clip the curve put at 299 s took 1617
 * s, and LTX took 870 s where the page said about two minutes. So after each
 * clip that really rendered (not a cache hit), the ratio of its running time
 * to the curve's estimate is kept, the last few per engine, and their median
 * is this PC's factor. The page multiplies its estimate by it and the clip
 * deadline allows for it. One cold or odd render does not swing it.
 *
 * Kept in <appdata>/video-speed.json: { version: 1, engines: { h3: [ratio, ...] } }.
 */
import fs from "node:fs";
import path from "node:path";

const KEEP = 8;
/* A ratio outside this is a broken measurement (a clock jump, a render that
 * waited on something else), not a speed. */
const SANE = [0.05, 50];

export function createVideoSpeed({ dir, now = Date.now } = {}) {
  const file = dir ? path.join(dir, "video-speed.json") : null;
  let engines = {};
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j && typeof j.engines === "object") {
        for (const [k, v] of Object.entries(j.engines)) {
          if (Array.isArray(v)) engines[k] = v.map(Number).filter((r) => r >= SANE[0] && r <= SANE[1]).slice(-KEEP);
        }
      }
    } catch { /* first run, or unreadable: start empty */ }
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, at: now(), engines }, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) { console.error(`  [video-speed] not saved: ${e.message}`); }
  };
  return {
    /** Keep one render's ratio. Returns it, or null when it was not usable. */
    record(engine, runningSec, expectedSec) {
      const r = Number(runningSec) / Number(expectedSec);
      if (!engine || !Number.isFinite(r) || r < SANE[0] || r > SANE[1]) return null;
      engines[engine] = [...(engines[engine] || []), Math.round(r * 1000) / 1000].slice(-KEEP);
      save();
      return r;
    },
    /** The median ratio of the kept renders, or null before the first one. */
    factor(engine) {
      const list = [...(engines[engine] || [])].sort((a, b) => a - b);
      if (!list.length) return null;
      const mid = list.length >> 1;
      const m = list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
      return Math.round(m * 100) / 100;
    },
    /** How many renders the factor stands on. */
    samples: (engine) => (engines[engine] || []).length,
  };
}
