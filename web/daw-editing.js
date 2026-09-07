/** Pure piano-roll resize arithmetic. Time on screen is quarter notes; stored
 * durations count the local meter's beat ticks, including across meter changes.
 * No project mutation, DOM, network or audio rendering happens here. */
export function resizeNoteDurations({ notes, anchorId, deltaQ, timeline, grid = 0, ticksPerBeat = 960 }) {
  if (!Array.isArray(notes) || !notes.length || !Array.isArray(timeline) || !timeline.length) return [];
  if (!Number.isFinite(deltaQ) || !Number.isFinite(ticksPerBeat) || ticksPerBeat <= 0) return [];
  const anchor = notes.find((n) => n.id === anchorId);
  if (!anchor) return [];
  // A vertical wiggle on an edge must not quantize an existing duration.
  if (deltaQ === 0) return notes.map((note) => ({ note: note.id, durTicks: note.durTicks }));

  let ticks = 0;
  const segments = timeline.map((row) => {
    const segment = { ...row, tickStart: ticks, ticksPerQ: ticksPerBeat * row.den / 4 };
    ticks += row.ticksPerBar;
    return segment;
  });
  if (segments.some((r) => !Number.isFinite(r.qStart) || !(r.ticksPerBar > 0) || !(r.ticksPerQ > 0))) return [];
  const last = segments[segments.length - 1];
  const atQ = (q) => {
    let row = segments[0];
    for (const candidate of segments) {
      if (candidate.qStart > q) break;
      row = candidate;
    }
    return row.tickStart + (q - row.qStart) * row.ticksPerQ;
  };
  const atTick = (t) => {
    let row = segments[0];
    for (const candidate of segments) {
      if (candidate.tickStart > t) break;
      row = candidate;
    }
    return row.qStart + (t - row.tickStart) / row.ticksPerQ;
  };
  const startTick = (note) => {
    const row = segments.find((r) => r.bar === note.bar) || last;
    // Match the engine's extension of the last meter beyond the song end.
    const extraBars = Math.max(0, note.bar - last.bar);
    return row.tickStart + extraBars * last.ticksPerBar + (note.beat - 1) * ticksPerBeat + note.tick;
  };
  const original = notes.map((note) => {
    const start = startTick(note);
    return { note, start, endQ: atTick(start + note.durTicks) };
  });
  const grabbed = original.find((entry) => entry.note.id === anchorId);
  const step = Number.isFinite(grid) && grid > 0 ? grid : 1;
  const rawDuration = atQ(grabbed.endQ + deltaQ) - grabbed.start;
  const duration = Math.max(1, Math.round(rawDuration / step) * step);
  const shiftQ = atTick(grabbed.start + duration) - grabbed.endQ;
  return original.map(({ note, start, endQ }) => ({
    note: note.id,
    durTicks: Math.max(1, Math.round(atQ(endQ + shiftQ) - start)),
  }));
}
