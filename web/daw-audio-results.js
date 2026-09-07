/** Labels shared by the DAW's imported-audio and rendered-stem views. */
const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function audioResultDetails(audio = {}, projectSr = 48000) {
  const sr = finite(audio.sr) && audio.sr > 0 ? audio.sr : projectSr;
  const samples = audio.durSamples ?? audio.n_samples;
  const seconds = finite(audio.seconds) ? audio.seconds
    : finite(samples) && sr > 0 ? samples / sr : null;
  const channels = audio.channels === 1 ? "Mono" : audio.channels === 2 ? "Stereo"
    : Number.isInteger(audio.channels) && audio.channels > 2 ? `${audio.channels} channels` : "";
  const format = String(audio.format || audio.file?.split(".").pop() || "").toLowerCase();
  const headroom = format === "wav" && finite(audio.peak) && audio.peak > 1;
  const formatLabel = headroom ? "float32 WAV" : format.toUpperCase();
  const summary = [channels, finite(seconds) ? `${seconds.toFixed(1)}s` : "", formatLabel,
    finite(audio.sr) && sr > 0 ? `${Number((sr / 1000).toFixed(3))} kHz` : ""].filter(Boolean).join(" · ");
  const notes = [];
  if (headroom) notes.push(`Peak +${(20 * Math.log10(audio.peak)).toFixed(1)} dBFS; float headroom preserved. Reduce clip gain if needed.`);
  if (finite(audio.source_channels) && finite(audio.channels) && audio.source_channels > audio.channels) {
    notes.push(`${audio.source_channels}-channel source downmixed to ${audio.channels === 2 ? "stereo" : `${audio.channels} channel(s)`}.`);
  }
  if (audio.note && !headroom) notes.push(String(audio.note));
  return { summary, notice: notes.join(" "), headroom };
}

export function stemResultDetails(result = {}, project = {}) {
  const regions = Array.isArray(result.regions) ? result.regions : [];
  const requested = new Set((result.tracks || []).map((track) => track.id));
  const trackIds = (project.tracks || []).map((track) => track.id);
  const returnIds = (project.returns || []).map((ret) => ret.id);
  const allTracks = trackIds.length > 0 && trackIds.every((id) => requested.has(id));
  const complete = allTracks && regions.length > 0 && regions.every((region) => {
    const supplied = new Set([...(region.stems || []).map((stem) => stem.track_id), ...(region.silent_tracks || [])]);
    const returns = new Set((region.returns || []).map((stem) => stem.return_id));
    return region.exported_complete !== false && trackIds.every((id) => supplied.has(id))
      && returnIds.every((id) => returns.has(id));
  });
  const measured = regions.filter((region) => region.exported_complete === true && finite(region.exported_residual_db));
  const residual = complete && measured.length
    ? ` Measured reconstruction residual: ${Math.max(...measured.map((region) => region.exported_residual_db)).toFixed(1)} dB or lower (${measured.length}/${regions.length} regions).`
    : "";
  let summary = complete
    ? "All track stems plus effect returns reconstruct the pre-master mix."
    : !allTracks
      ? "Selected track stems only; this selection does not reconstruct the full mix. Open every track's waveform lane for the complete set."
      : "The returned files are incomplete; they do not establish a complete mix reconstruction.";
  summary += " Master processing and the master fader are excluded.";
  if (returnIds.length || regions.some((region) => region.returns?.length)) {
    summary += " Shared effect returns include sends from all tracks, even when only some track lanes are open.";
  }
  return { note: "Post-fader · pre-master", summary: summary + residual, complete };
}
