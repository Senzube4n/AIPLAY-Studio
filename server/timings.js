/**
 * What things ACTUALLY took on THIS machine.
 *
 * Every estimate in this app was a model: a cost curve for video fitted from a
 * single anchor point, a per-step rate for images measured once by hand, a
 * realtime ratio for music. Models are how you answer before you have data, and
 * they stay wrong in the same direction forever because nothing feeds back.
 *
 * This is the feedback. Renders report what they cost, the numbers are kept per
 * shape of job, and the next estimate is the MEDIAN of what that shape really
 * took here — so a machine with a faster card, more RAM or a different driver
 * converges on its own truth instead of inheriting the one measured on mine.
 *
 * MEDIAN, NOT MEAN, and that is the whole robustness story. A cold model load
 * adds thirty seconds; a run that starts with three gigabytes free can take ten
 * times as long as the same run with sixteen (measured, 2026-08-27). Those are
 * real observations and they are not the typical case — a mean chases them, a
 * median ignores them until they become the majority, which is exactly the
 * behaviour an estimate wants.
 *
 * It never claims more than it has. Under MIN_SAMPLES a prediction says
 * "modelled" and the caller keeps its own formula; the count travels with every
 * answer so a screen can say "measured, 7 renders" rather than implying
 * authority it has not earned.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const KEEP = 24;          // observations per bucket
const MIN_SAMPLES = 3;    // below this, the model is still better than the data

/**
 * The SHAPE of a job, coarse enough to collect samples and fine enough to
 * matter. Megapixels are bucketed because 1024x1024 and 1024x1088 are the same
 * job for timing purposes, and treating them as different would mean never
 * gathering three of anything.
 */
export function timingKey(kind, job = {}) {
  const mp = ((job.width || 1024) * (job.height || 1024)) / 1e6;
  const mpb = mp < 0.4 ? "s" : mp < 1.4 ? "m" : mp < 3 ? "l" : mp < 6 ? "xl" : "xxl";
  if (kind === "image") {
    const steps = Number(job.steps) || 0;
    const sb = steps <= 6 ? "fast" : steps <= 16 ? "mid" : steps <= 32 ? "std" : "high";
    return `image:${job.engine || "flux2"}:${sb}:${mpb}:${Math.min(Number(job.count) || 1, 4)}`;
  }
  if (kind === "video") {
    const secs = Number(job.seconds) || 5;
    const sb = secs <= 3 ? "short" : secs <= 6 ? "mid" : "long";
    return `video:${job.engine || "ltx"}:${sb}:${mpb}`;
  }
  return `${kind}:${job.engine || "default"}`;
}

export function createTimingStore(file) {
  /** key -> number[] of observed SECONDS, newest last */
  let byKey = new Map();
  let loaded = false;
  let dirty = false;
  let saveTimer = null;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      for (const [k, v] of Object.entries(raw.timings || {})) {
        if (Array.isArray(v) && v.length) byKey.set(k, v.slice(-KEEP));
      }
    } catch { /* no history yet: every prediction is modelled until there is */ }
  }

  /* Debounced. A batch of fifty renders should not write this file fifty times,
   * and losing the last few seconds of history costs an estimate nothing. */
  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ timings: Object.fromEntries(byKey) }));
      } catch { /* a lost history must never take the app down */ }
    }, 4000);
  }

  return {
    async record(kind, job, seconds) {
      const s = Number(seconds);
      /* Nonsense in, nonsense forever: a zero or a negative would drag a median
       * that nothing later can correct, and an hour-long outlier is a hang
       * rather than a render. */
      if (!Number.isFinite(s) || s <= 0.2 || s > 6 * 3600) return null;
      await load();
      const key = timingKey(kind, job);
      const arr = byKey.get(key) || [];
      arr.push(Math.round(s * 100) / 100);
      while (arr.length > KEEP) arr.shift();
      byKey.set(key, arr);
      scheduleSave();
      return key;
    },

    /** @returns {{seconds:number|null, samples:number, source:"measured"|"modelled", key:string}} */
    async predict(kind, job) {
      await load();
      const key = timingKey(kind, job);
      const arr = byKey.get(key) || [];
      if (arr.length < MIN_SAMPLES) {
        return { seconds: null, samples: arr.length, source: "modelled", key };
      }
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
      return { seconds: median, samples: arr.length, source: "measured", key };
    },

    /** Everything known, for the screen and for a report. */
    async all() {
      await load();
      const out = {};
      for (const [k, arr] of byKey) {
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        out[k] = {
          samples: arr.length,
          median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
          min: sorted[0],
          max: sorted[sorted.length - 1],
        };
      }
      return out;
    },
  };
}
