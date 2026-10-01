// Audio is the clock. Notation timing is an estimate, never forced alignment.
export function scorePosition(audioSeconds, { offset = 0, scale = 1 } = {}) {
  return Math.max(0, (audioSeconds - offset) / scale);
}
export function eventAt(events, seconds) {
  let lo = 0, hi = events.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].milliseconds <= seconds * 1000) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found < 0 ? null : events[found];
}
export async function mountScoreFollow() {
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search), slug = query.get('slug'), version = query.get('version');
  const nativeRun=query.get('run');
  if ((!slug || !version) && !nativeRun) throw new Error('Choose a saved score version.');
  const r = await fetch(nativeRun?'/api/music-tools':'/api/score', {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify(nativeRun?{action:'read',run:nativeRun}:{action:'read', slug, version})});
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || 'Could not open the score.');
  const row = nativeRun?{score:{text:data.run?.score||data.run?.request?.abc},artifacts:[]}:data.versions?.[0];
  if (!row?.score?.text) throw new Error('This version has no readable notation.');
  $('title').textContent = nativeRun?'Native YuE2 score · seed '+data.run.request.seed:data.score.title || slug;
  const tunes = window.ABCJS.renderAbc('paper', row.score.text, {add_classes:true, responsive:'resize',
    clickListener: (abcElement) => {
      if (!abcElement || !Number.isFinite(abcElement.startChar)) return;
      const event = events.find(e => e.startChar === abcElement.startChar || e.startCharArray?.includes(abcElement.startChar));
      if (event) audio.currentTime = event.milliseconds / 1000 * alignment().scale + alignment().offset;
    }});
  const tune = tunes[0];
  const allEvents = tune.setTiming(tune.getBpm(tune.metaText?.tempo), 0);
  const events = allEvents.filter(e => e.type === 'event');
  const last = allEvents.at(-1)?.milliseconds / 1000 || 0;
  const audio = $('audio');
  const name = row.artifacts.find(a => /\.(flac|wav|mp3)$/i.test(a.name))?.name;
  if(nativeRun && data.run.outputUrl)audio.src=data.run.outputUrl;
  else if (name) audio.src = '/api/score/file/' + [slug, version, name].map(encodeURIComponent).join('/');
  else { $('status').textContent = 'Draft score. Choose a recording to follow.'; }
  const alignment = () => ({offset:Number($('offset').value) || 0, scale:Number($('scale').value) || 1});
  let selected = [], previous = null;
  function paint() {
    cancelAnimationFrame(frame);
    const event = eventAt(events, scorePosition(audio.currentTime, alignment()));
    if (event !== previous) {
      for (const element of selected) element.classList.remove('playing-note');
      selected = (event?.elements || []).flat().filter(Boolean);
      for (const element of selected) element.classList.add('playing-note');
      if ($('follow').checked && selected[0]) selected[0].scrollIntoView({block:'center', behavior:'smooth'});
      $('position').textContent = event ? 'Bar ' + (event.measureNumber + 1) : 'Ready';
      previous = event;
    }
    if (!audio.paused) frame = requestAnimationFrame(paint);
  }
  let frame;
  audio.addEventListener('play', () => {cancelAnimationFrame(frame); paint();});
  for (const event of ['pause','seeked','ended']) audio.addEventListener(event, () => {cancelAnimationFrame(frame); paint();});
  for (const id of ['offset','scale']) $(id).addEventListener('input', paint);
  $('fit').addEventListener('click', () => {
    if (last > 0 && Number.isFinite(audio.duration)) {
      const scale = (audio.duration - alignment().offset) / last;
      if (scale >= 0.1 && scale <= 10) { $('scale').value = scale.toFixed(4); paint(); }
    }
  });
  $('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch (e) { $('status').textContent = e.message; }
  });
  let recordingUrl;
  $('recording').addEventListener('change', () => {
    const file = $('recording').files[0]; if (!file) return;
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    recordingUrl = URL.createObjectURL(file); audio.src = recordingUrl;
    $('status').textContent = 'Local recording selected';
  });
  window.addEventListener('pagehide', () => {cancelAnimationFrame(frame); if(recordingUrl) URL.revokeObjectURL(recordingUrl);});
  paint();
}
