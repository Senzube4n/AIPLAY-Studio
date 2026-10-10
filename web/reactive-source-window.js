/** Source-video timing for Reactive Motion. The song region is independent. */
export function reactiveSourceWindow({ duration, start = 0, speed = 1, seconds } = {}) {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0
      || !Number.isFinite(start) || start < 0
      || !Number.isFinite(speed) || speed <= 0
      || !Number.isFinite(seconds) || seconds <= 0) return { known: false };
  const sourceEnd = start + seconds * speed;
  const firstRepeatAt = Math.max(0, duration - start) / speed;
  return {
    known: true, duration, start, speed, seconds, sourceEnd,
    startBeyondEnd: start >= duration,
    // Compare in source seconds so an exact end is not mislabeled a loop.
    repeats: sourceEnd > duration + 1e-6,
    firstRepeatAt,
  };
}
