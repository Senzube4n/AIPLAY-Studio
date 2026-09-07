/** Export UI and MCP use the same bounce action; these are per-export overrides. */
export const EXPORT_PRESETS = Object.freeze({
  project: { mode: 'project', target: -14, ceiling: -1, limiting: 3 },
  edm: { mode: 'custom', target: -10, ceiling: -1.2, limiting: 3 },
  acoustic: { mode: 'custom', target: -17, ceiling: -1.2, limiting: 1 },
  unmastered: { mode: 'off', target: -14, ceiling: -1, limiting: 3 },
});

function numberIn(value, min, max, label) {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max)
    throw new Error(`${label} must be between ${min} and ${max}.`);
  return Number(value);
}

export function exportSettings(form) {
  if (!['flac', 'wav'].includes(form.format)) throw new Error('Choose FLAC or WAV.');
  if (![16, 24].includes(Number(form.depth))) throw new Error('Choose 16-bit or 24-bit audio.');
  if (!['project', 'custom', 'off'].includes(form.mode)) throw new Error('Choose a loudness mode.');
  const settings = { format: form.format, bit_depth: Number(form.depth) };
  if (form.mode === 'off') settings.target_lufs = null;
  if (form.mode === 'custom') settings.target_lufs = numberIn(form.target, -30, -6, 'Loudness target');
  if (form.mode !== 'off') {
    settings.ceiling_db = numberIn(form.ceiling, -12, 0, 'True-peak ceiling');
    settings.max_limit_db = numberIn(form.limiting, 0, 12, 'Maximum limiting');
  }
  return settings;
}

const measured = (value, unit) => Number.isFinite(value) ? `${value.toFixed(2)} ${unit}` : 'Not measured';

export function exportFacts(result) {
  const L = result.loudness;
  const facts = [
    ['Audio', `${String(result.format || 'flac').toUpperCase()} · ${result.bit_depth ?? 24}-bit · ${result.channels === 2 ? 'stereo' : result.channels === 1 ? 'mono' : result.stereo === true ? 'stereo' : result.stereo === false ? 'mono' : 'channels not reported'} · ${result.sr ? `${result.sr} Hz` : 'sample rate unavailable'}`],
    ['Duration', measured(result.seconds, 's')],
    ['Dither', result.dithered === true ? 'Applied' : result.dithered === false ? 'Not applied' : 'Not reported'],
    ['Metadata', result.tagged === true || result.tagged?.ok === true ? 'Written' : 'Not written — see export details'],
    ['Origin', result.origin || result.tagged?.class || 'Not reported'],
  ];
  if (L) {
    facts.push(['Loudness', `${measured(L.before?.lufs, 'LUFS')} → ${measured(L.after?.lufs, 'LUFS')}`],
      ['True peak', measured(L.after?.true_peak_db, 'dBTP')],
      ['Limiting', measured(L.limiter_work_db, 'dB')],
      ['Target', L.reached ? `${result.target_lufs} LUFS reached` : `${result.target_lufs} LUFS · ${measured(L.shortfall_db, 'LU')} below target`]);
  } else facts.push(['Loudness stage', result.target_lufs == null ? 'Off · master inserts and fader still apply' : 'No measurement returned']);
  return facts;
}

/** Accept only this API's local project-bounce route, never a server-supplied external URL. */
export function exportDownloadUrl(value, slug) {
  const prefix = `/api/daw/bounce/${encodeURIComponent(slug)}/`;
  return typeof value === 'string' && value.startsWith(prefix)
    && /^[A-Za-z0-9_.%-]+\.(flac|wav)$/.test(value.slice(prefix.length)) ? value : null;
}
