/**
 * Read selected DAW bars as the bounded, two-monophonic-voice YuE2 dialect.
 * This is a pure export: it never moves/quantizes notes, writes a score, or
 * starts a render. DAW durations walk local beats across meter changes; the
 * score clock is L:1/32. Unsupported timing/polyphony refuses explicitly.
 */
import { createHash } from "node:crypto";
import { buildTimeline, TICKS_PER_BEAT, PATCHES } from "../daw/store.js";
import { parseScore, checkScore, TICKS_PER_QUARTER } from "../mcp-music-score.js";

const VOICES = ["Vocal", "Ins"];
const LENGTHS = [48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];
const UNITS_PER_QUARTER = 8;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
};
const exactUnits = (value, label) => {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is off the YuE2 1/32-note grid. Quantize the DAW notes before exporting.`);
  return value;
};

/** An explicit accidental on every note avoids key/accidental carry changing pitch. */
function pitchToken(pitch) {
  const names = ["=C", "^C", "=D", "^D", "=E", "=F", "^F", "=G", "^G", "=A", "^A", "=B"];
  const octave = Math.floor(pitch / 12) - 5;
  const name = names[pitch % 12];
  if (octave >= 1) return name.toLowerCase() + "'".repeat(octave - 1);
  return name + ",".repeat(-octave);
}

function durationTokens(units, token, continuing = false) {
  let left = units;
  const out = [];
  while (left > 0) {
    const take = LENGTHS.find((length) => length <= left);
    left -= take;
    out.push(token + (take === 1 ? "" : take) + (token !== "z" && (left > 0 || continuing) ? "-" : ""));
  }
  return out.join("");
}

/** The DAW's duration is counted in local denominator beats, including across meter changes. */
function noteInterval(note, rows) {
  const row = rows[note.bar - 1];
  if (!row) return null; // Notes stored beyond the project length are silent.
  integer(note.beat, 1, row.num, "Note beat");
  integer(note.tick, 0, TICKS_PER_BEAT - 1, "Note tick");
  integer(note.durTicks, 1, TICKS_PER_BEAT * 256, "Note duration");
  const ticksInto = (note.beat - 1) * TICKS_PER_BEAT + note.tick;
  const start = row.qStart * UNITS_PER_QUARTER + ticksInto / (row.den * 30);
  let bar = note.bar - 1, into = ticksInto, remaining = note.durTicks, held = 0;
  while (remaining > 0) {
    const local = rows[Math.min(bar, rows.length - 1)];
    const take = Math.min(remaining, local.ticksPerBar - into);
    held += take / (local.den * 30);
    remaining -= take;
    bar++; into = 0;
  }
  return { start, end: start + held };
}

function trackMapping(doc, opts) {
  const trackById = new Map(doc.tracks.map((track) => [track.id, track]));
  let mapping;
  if (opts.voiceTracks !== undefined) {
    if (!opts.voiceTracks || typeof opts.voiceTracks !== "object" || Array.isArray(opts.voiceTracks)
      || Object.keys(opts.voiceTracks).some((key) => !VOICES.includes(key))) throw new Error("voiceTracks must map Vocal and/or Ins to track IDs.");
    mapping = Object.fromEntries(VOICES.map((voice) => [voice, opts.voiceTracks[voice] ?? null]));
  } else {
    const ids = opts.trackIds ?? doc.tracks.map((track) => track.id);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) throw new Error("Choose one or two distinct melody tracks. YuE2 scores have two monophonic voices.");
    if (ids.length === 1) mapping = { Vocal: null, Ins: ids[0] };
    else if (VOICES.every((voice) => ids.some((id) => trackById.get(id)?.name === voice))) {
      mapping = Object.fromEntries(VOICES.map((voice) => [voice, ids.find((id) => trackById.get(id).name === voice)]));
    } else mapping = { Vocal: ids[0], Ins: ids[1] };
  }
  const selected = Object.values(mapping).filter((id) => id !== null);
  if (!selected.length || new Set(selected).size !== selected.length) throw new Error("Choose distinct tracks for the Vocal and Ins voices.");
  for (const id of selected) if (typeof id !== "string" || !trackById.has(id)) throw new Error(`No such DAW track: ${id}.`);
  return Object.fromEntries(VOICES.map((voice) => [voice, mapping[voice] === null ? null : trackById.get(mapping[voice])]));
}

function sourceMetadata(abc, rows, fromBar, toBar) {
  if (abc === undefined || abc === null || abc === "") return null;
  if (typeof abc !== "string" || Buffer.byteLength(abc) > 65536) throw new Error("Source ABC must be at most 64 KiB.");
  const check = checkScore(abc);
  if (!check.ok) throw new Error("Source ABC is not a valid native score. Repair it or omit sourceAbc before exporting.");
  const parsed = parseScore(abc);
  const bars = parsed.bars.filter((bar) => bar.voice === "Vocal");
  if (bars.length < toBar) throw new Error("Source ABC does not cover the selected DAW bars.");
  for (let bar = fromBar; bar <= toBar; bar++) {
    if (bars[bar - 1].meter !== `${rows[bar - 1].num}/${rows[bar - 1].den}`) throw new Error("Source ABC and DAW meters differ in the selection. Align them or omit sourceAbc.");
  }
  const startTick = bars[fromBar - 1].start_quarter * TICKS_PER_QUARTER;
  const last = bars[toBar - 1];
  const endTick = last.start_quarter * TICKS_PER_QUARTER + last.held_ticks;
  const unit = (tick) => (tick - startTick) * UNITS_PER_QUARTER / TICKS_PER_QUARTER;
  const keys = parsed.voices.Vocal.keys;
  const initialKey = keys.filter(([tick]) => tick <= startTick).at(-1)?.[1] || parsed.header.key;
  const chords = parsed.voices.Vocal.chords.filter(([tick]) => tick >= startTick && tick < endTick).map(([tick, symbol]) => ({ at: unit(tick), symbol }));
  // Harmony is stateful: carry the active chord into a passage cut mid-progression.
  if (!chords.some((chord) => chord.at === 0)) {
    const prior = parsed.voices.Vocal.chords.filter(([tick]) => tick < startTick).at(-1);
    if (prior) chords.unshift({ at: 0, symbol: prior[1] });
  }
  return {
    key: initialKey,
    keys: keys.filter(([tick]) => tick > startTick && tick < endTick).map(([tick, key]) => ({ at: unit(tick), key })),
    chords,
    sections: bars.slice(fromBar - 1, toBar).map((bar) => bar.section || "passage"),
  };
}

function musicBar(row, voice, notes, chords, keys, selectionStart) {
  const start = row.qStart * UNITS_PER_QUARTER - selectionStart;
  const end = start + row.qLen * UNITS_PER_QUARTER;
  const localNotes = notes.filter((note) => note.start < end && note.end > start);
  const localChords = voice === "Vocal" ? chords.filter((chord) => chord.at >= start && chord.at < end) : [];
  const localKeys = keys.filter((key) => key.at >= start && key.at < end);
  const cuts = [...new Set([start, end, ...localNotes.flatMap((note) => [Math.max(start, note.start), Math.min(end, note.end)]), ...localChords.map((chord) => chord.at), ...localKeys.map((key) => key.at)])].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const at = cuts[i], next = cuts[i + 1];
    for (const key of localKeys.filter((key) => key.at === at)) out.push(`[K:${key.key}]`);
    for (const chord of localChords.filter((chord) => chord.at === at)) out.push(`"${chord.symbol}"`);
    const note = localNotes.find((note) => note.start <= at && note.end > at);
    out.push(durationTokens(exactUnits(next - at, "Source notation timing"), note ? pitchToken(note.pitch) : "z", !!note && note.end > next));
  }
  return out.join("") + "|";
}

/**
 * { fromBar, toBar } are inclusive; trackIds select one/two tracks in voice
 * order, or voiceTracks explicitly assigns Vocal/Ins. sourceAbc, if supplied,
 * is the complete parent score on the same absolute bar grid.
 */
export function dawSelectionToScore(doc, opts = {}) {
  if (!doc || !Array.isArray(doc.tracks) || !Array.isArray(doc.meterMap) || !Array.isArray(doc.tempoMap)) throw new Error("Choose a complete DAW project.");
  integer(doc.lengthBars, 1, 256, "Project length");
  if (opts.quantizeTo32nd !== undefined && typeof opts.quantizeTo32nd !== "boolean") throw new Error("quantizeTo32nd must be true or false.");
  for (const [name, map] of [["Meter map", doc.meterMap], ["Tempo map", doc.tempoMap]]) {
    if (!map.length || map[0].atBar !== 1) throw new Error(`${name} must start at bar 1.`);
    for (let i = 0; i < map.length; i++) {
      integer(map[i].atBar, 1, 256, `${name} bar`);
      if (i && map[i].atBar <= map[i - 1].atBar) throw new Error(`${name} must have distinct ascending bars.`);
      if (name === "Meter map") {
        integer(map[i].num, 1, 32, "Meter numerator");
        if (![1, 2, 4, 8, 16, 32].includes(map[i].den)) throw new Error("Unsupported DAW meter denominator.");
      } else if (!Number.isFinite(map[i].bpm) || map[i].bpm < 20 || map[i].bpm > 400) throw new Error("Tempo must be from 20 to 400 BPM.");
    }
  }
  const fromBar = integer(opts.fromBar ?? 1, 1, doc.lengthBars, "First bar");
  const toBar = integer(opts.toBar ?? doc.lengthBars, fromBar, doc.lengthBars, "Last bar");
  const rows = buildTimeline(doc);
  const selectedRows = rows.slice(fromBar - 1, toBar);
  const first = selectedRows[0], last = selectedRows.at(-1);
  integer(first.bpm, 20, 400, "YuE2 tempo");
  if (selectedRows.some((row) => row.bpm !== first.bpm)) throw new Error("YuE2 ABC supports one tempo. Select bars with a constant tempo.");
  const mapping = trackMapping(doc, opts);
  const metadata = sourceMetadata(opts.sourceAbc, rows, fromBar, toBar);
  const start = exactUnits(first.qStart * UNITS_PER_QUARTER, "Selection start");
  const end = exactUnits((last.qStart + last.qLen) * UNITS_PER_QUARTER, "Selection end");
  const warnings = [];
  const warn = (code, message, extra = {}) => warnings.push({ code, message, ...extra });
  const voiceNotes = {}, voices = [], noteMetadata = [];
  const fingerprints = [];
  for (const voice of VOICES) {
    const track = mapping[voice];
    const notes = [];
    let trimmed = 0, snappedOnsets = 0, snappedLengths = 0, minimumLengths = 0;
    if (track) {
      const instrument = typeof track.instrument === "object" ? track.instrument : { patch: track.instrument, params: {} };
      if (PATCHES[instrument.patch]?.family === "drums" || instrument.params?.drum_kit) throw new Error(`Track ${track.name || track.id} is percussion. Choose a pitched melody track.`);
      const transpose = integer(instrument.params?.transpose ?? 0, -48, 48, "Track transpose");
      for (const clip of track.clips || []) {
        for (const note of clip.notes || []) {
          // Same container rule as DAW rendering: a note hidden by its clip is silent.
          if (note.bar < clip.fromBar || note.bar > clip.toBar) continue;
          const interval = noteInterval(note, rows);
          if (!interval || interval.start >= end || interval.end <= start) continue;
          const pitch = integer(note.pitch + transpose, 0, 127, "Sounding pitch");
          const rawLeft = Math.max(interval.start, start) - start;
          const rawRight = Math.min(interval.end, end) - start;
          let left, right;
          if (opts.quantizeTo32nd) {
            left = Math.max(0, Math.min(end - start - 1, Math.round(rawLeft)));
            right = Math.max(left + 1, Math.min(end - start, Math.round(rawRight)));
            if (left !== rawLeft) snappedOnsets++;
            if (right - left !== rawRight - rawLeft) snappedLengths++;
            if (Math.round(rawRight) <= left) minimumLengths++;
          } else {
            left = exactUnits(rawLeft, `Note ${note.id || ""} start`);
            right = exactUnits(rawRight, `Note ${note.id || ""} end`);
          }
          if (interval.start < start || interval.end > end) trimmed++;
          notes.push({ start: left, end: right, pitch, noteId: note.id ?? null, velocity: note.vel ?? 100 });
          noteMetadata.push({ voice, trackId: track.id, clipId: clip.id ?? null, noteId: note.id ?? null,
            sourceStartUnits: interval.start, sourceEndUnits: interval.end,
            startUnits: left, endUnits: right, pitch, velocity: note.vel ?? 100 });
        }
      }
      notes.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
      for (let i = 1; i < notes.length; i++) {
        if (notes[i].start < notes[i - 1].end) throw new Error(`Track ${track.name || track.id} contains overlapping notes. YuE2 ${voice} must be monophonic; split the notes into separate melody tracks.`);
      }
      if (trimmed) warn("boundary_trim", `${trimmed} note(s) trimmed at the passage boundary.`, { voice, notes: trimmed });
      if (snappedOnsets || snappedLengths) warn("quantized", "The ABC preview snaps notes to 1/32 notes; the DAW stays unchanged.", { voice, onsets: snappedOnsets, lengths: snappedLengths, minimumLengths });
      if (notes.some((note) => note.velocity !== 100)) warn("velocity_omitted", "Note velocities are not represented in YuE2 ABC.", { voice });
      if (transpose) warn("transpose_applied", "Track transpose is applied to exported pitches.", { voice, semitones: transpose });
      if ((track.audioClips || []).length) warn("audio_omitted", "Audio clips are not represented in the notation.", { voice });
      if (track.mute || track.solo) warn("mixer_omitted", "The selected track is exported independently of mixer mute and solo.", { voice });
      fingerprints.push({ voice, id: track.id, instrument: track.instrument, notes, clips: (track.clips || []).map((clip) => ({ id: clip.id, fromBar: clip.fromBar, toBar: clip.toBar })) });
    }
    voiceNotes[voice] = notes;
    voices.push({ voice, trackId: track?.id ?? null, trackName: track?.name ?? null, notes: notes.length });
  }
  if (!voices.some((voice) => voice.notes > 0)) throw new Error("The selected tracks have no sounding notes in these bars.");
  if (!metadata) warn("harmony_unavailable", "The DAW does not store chord symbols or key changes. Supply the parent ABC to preserve them.");
  warn("performance_omitted", "Instrument sound, effects and articulation are not encoded in YuE2 notation.");
  const key = metadata?.key || "C";
  const header = ["X:1", "T:", `M:${first.num}/${first.den}`, "L:1/32", `Q:1/4=${first.bpm}`,
    'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"', 'V: Ins clef=treble name="Ins Melody" snm="Inst."', `K:${key}`];
  const body = [];
  let priorSection = null, priorMeter = `${first.num}/${first.den}`;
  selectedRows.forEach((row, index) => {
    const section = metadata?.sections[index] || "passage";
    if (section !== priorSection) body.push(`% ${section}`);
    priorSection = section;
    const meter = `${row.num}/${row.den}`;
    for (const voice of VOICES) {
      body.push(`V: ${voice}`);
      if (meter !== priorMeter) body.push(`M:${meter}`);
      body.push(musicBar(row, voice, voiceNotes[voice], metadata?.chords || [], metadata?.keys || [], start));
    }
    priorMeter = meter;
  });
  const abc = [...header, ...body].join("\n") + "\n";
  if (Buffer.byteLength(abc) > 65536) throw new Error("The exported score exceeds 64 KiB. Select fewer bars.");
  const check = checkScore(abc);
  if (!check.ok) throw new Error(`The DAW export failed native score validation: ${JSON.stringify(check.problems || check.fatal || check)}.`);
  const selection = { fromBar, toBar, bars: toBar - fromBar + 1,
    startSeconds: first.sec, endSeconds: last.sec + last.secLen, durationSeconds: last.sec + last.secLen - first.sec,
    startQuarters: first.qStart, endQuarters: last.qStart + last.qLen };
  return {
    abc, check, warnings, selection, voices, noteMetadata,
    sourceFingerprint: hash({ projectId: doc.id, selection, meterMap: doc.meterMap, tempoMap: doc.tempoMap, voices: fingerprints, noteMetadata, sourceAbc: opts.sourceAbc || null, quantizeTo32nd: !!opts.quantizeTo32nd }),
    projectFingerprint: hash({ id: doc.id, lengthBars: doc.lengthBars, meterMap: doc.meterMap, tempoMap: doc.tempoMap, tracks: doc.tracks }),
    project: { id: doc.id ?? null, slug: doc.slug ?? null, updatedAt: doc.updatedAt ?? null },
    preserved: { key: !!metadata, chords: metadata?.chords.length || 0, sections: !!metadata },
  };
}
