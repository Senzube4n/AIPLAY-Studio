/** Read only the notation bound to this job, never another history entry. */
export function capturedYue2Score(entry, captureKey) {
  const capture = entry?.outputs?.["11"]?.aiplay_yue2_score;
  if (!Array.isArray(capture) || capture.length !== 1) return null;
  const row = capture[0];
  if (row?.capture_key !== captureKey || typeof row.abc !== "string"
      || !row.abc.trim() || Buffer.byteLength(row.abc, "utf8") > 65536) return null;
  return { abc: row.abc, audioSeconds: Number.isFinite(row.audio_seconds) && row.audio_seconds > 0
    ? row.audio_seconds : null };
}
