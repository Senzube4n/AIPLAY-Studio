export function frameKind(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

export function audioLevel(samples) {
  if (!samples?.length) return 0;
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  return Math.sqrt(squares / samples.length);
}

export function nextSpeechState(previous, level, threshold, now, holdMs = 120) {
  const wasTalking = previous?.talking === true;
  const lastLoudAt = Number.isFinite(previous?.lastLoudAt) ? previous.lastLoudAt : -Infinity;
  const strong = level >= threshold;
  const continuing = wasTalking && level >= threshold * 0.6;
  if (strong || continuing) return { talking: true, lastLoudAt: now };
  return { talking: wasTalking && now - lastLoudAt <= holdMs, lastLoudAt };
}
