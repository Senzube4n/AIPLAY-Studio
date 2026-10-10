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
/** Bind notation to an existing transport; never create a second audio clock. */
export function mountNotationTimeline({audio, paper, abc, abcjs, follow, position,
  offset, scale, fit, scrollRoot, schedule = requestAnimationFrame,
  cancel = cancelAnimationFrame}) {
  let events = [], selected = [], previous, frame, disposed = false;
  const alignment = () => {
    const start=Number(offset?.value), speed=Number(scale?.value);
    return {offset:Number.isFinite(start)?start:0, scale:Number.isFinite(speed)&&speed>0?Math.min(10,Math.max(.1,speed)):1};
  };
  const tunes = abcjs.renderAbc(paper, abc, {add_classes:true, responsive:'resize',
    clickListener: element => {
      const event = events.find(e => e.startChar === element?.startChar || e.startCharArray?.includes(element?.startChar));
      if (event && Number.isFinite(element?.startChar)) {
        audio.currentTime = event.milliseconds / 1000 * alignment().scale + alignment().offset;
        paint();
      }
    }});
  const tune = tunes[0];
  if (!tune) throw new Error('This score could not be drawn.');
  const allEvents = tune.setTiming(tune.getBpm(tune.metaText?.tempo), 0);
  events = allEvents.filter(e => e.type === 'event');
  const last = (allEvents.at(-1)?.milliseconds || 0) / 1000;
  function paint() {
    cancel(frame);
    if (disposed) return;
    const event = eventAt(events, scorePosition(audio.currentTime, alignment()));
    if (event !== previous) {
      selected.forEach(element => element.classList.remove('playing-note'));
      selected = (event?.elements || []).flat().filter(Boolean);
      selected.forEach(element => element.classList.add('playing-note'));
      if (follow?.checked && selected[0]) {
        const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (scrollRoot) {
          const note = selected[0].getBoundingClientRect(), box = scrollRoot.getBoundingClientRect();
          if (note.top < box.top + 20 || note.bottom > box.bottom - 35) {
            scrollRoot.scrollTo({top:scrollRoot.scrollTop + note.top - box.top - box.height * .25,
              behavior:reduced ? 'auto' : 'smooth'});
          }
        } else selected[0].scrollIntoView({block:'center', behavior:reduced ? 'auto' : 'smooth'});
      }
      if (position) position.textContent = Number.isFinite(event?.measureNumber) ? 'Bar ' + (event.measureNumber + 1) : 'Ready';
      previous = event;
    }
    if (!audio.paused && !audio.ended) frame = schedule(paint);
  }
  const listeners = [];
  function on(target, event, fn) {
    if (!target) return;
    target.addEventListener(event, fn); listeners.push(() => target.removeEventListener(event, fn));
  }
  for (const event of ['play','pause','seeking','seeked','ended','timeupdate']) on(audio, event, paint);
  for (const control of [offset,scale]) on(control, 'input', () => {previous = undefined; paint();});
  on(follow, 'change', () => {previous = undefined; paint();});
  on(fit, 'click', () => {
    const value = (audio.duration - alignment().offset) / last;
    if (scale && last > 0 && Number.isFinite(value) && value >= .1 && value <= 10) {
      scale.value = value.toFixed(4); previous = undefined; paint();
    }
  });
  paint();
  return {dispose() {disposed = true; cancel(frame); listeners.forEach(remove => remove());
    selected.forEach(element => element.classList.remove('playing-note'));}};
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
  const audio = $('audio');
  const name = row.artifacts.find(a => /\.(flac|wav|mp3|opus)$/i.test(a.name))?.name;
  if(nativeRun && data.run.outputUrl)audio.src=data.run.outputUrl;
  else if (name) audio.src = '/api/score/file/' + [slug, version, name].map(encodeURIComponent).join('/');
  else $('status').textContent = 'Draft score. Choose a recording to follow.';
  const timeline=mountNotationTimeline({audio,paper:$('paper'),abc:row.score.text,abcjs:window.ABCJS,
    follow:$('follow'),position:$('position'),offset:$('offset'),scale:$('scale'),fit:$('fit')});
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
  window.addEventListener('pagehide', () => {timeline.dispose(); if(recordingUrl) URL.revokeObjectURL(recordingUrl);});
}
