/** A shared human interface for the same experimental service used by MCP. */
export function inputSelection({ library, dataUrl, name, path, start, duration }) {
  const offset = Number(start), length = Number(duration);
  if (start === '' || !Number.isFinite(offset) || offset < 0) throw new Error('Choose a start time of zero or more seconds.');
  if (duration === '' || !Number.isFinite(length) || length < .25 || length > 15) throw new Error('Choose between 0.25 and 15 seconds of input.');
  const source = dataUrl ? { data_url: dataUrl, name } : library?.trim() ? { library_file: library.trim() } : path ? { path } : null;
  if (!source) throw new Error('Choose a WAV or FLAC file, or enter a library filename.');
  return { action: 'prepare', source, start_seconds: offset, duration_seconds: length };
}

/* A BLANK SEED BOX IS "RANDOM". Both boxes used to open on one fixed number and refuse to
 * be emptied, so every continuation was the same one. Blank now leaves the seed
 * out: the server rolls one (server/music-input.js seedValue), and a blank mix
 * seed follows the composition seed. A number is still honoured exactly. */
export function continuationSettings({ reference, caption, lyrics, seed, mixSeed, seconds, title }) {
  if (!reference) throw new Error('Prepare or select a ready reference first.');
  if (!caption?.trim()) throw new Error('Describe the music to continue.');
  const blank = (value) => value === undefined || value === null || String(value).trim() === '';
  const integer = (value, label) => {
    if (blank(value)) return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 4294967295) throw new Error(`${label} must be a whole number from 0 to 4294967295, or blank for random.`);
    return n;
  };
  const length = Number(seconds);
  if (seconds === '' || !Number.isFinite(length) || length < .25 || length > 30) throw new Error('Choose between 0.25 and 30 seconds of new audio.');
  const s = integer(seed, 'Composition seed'), m = integer(mixSeed, 'Mix seed');
  return { action: 'continue', reference_id: reference, caption: caption.trim(), lyrics: lyrics || '[Instrumental]',
    ...(s === undefined ? {} : { seed: s }), ...(m === undefined ? {} : { mix_seed: m }),
    seconds: length, title: title?.trim() || 'Audio-input continuation' };
}

export function musicResultUrl(value) {
  return typeof value === 'string' && /^\/api\/audio\/[A-Za-z0-9_.%()-]+\.(wav|flac|mp3|ogg)$/.test(value) ? value : null;
}

const terminal = state => ['ready', 'done', 'completed', 'succeeded', 'failed', 'error', 'cancelled', 'canceled', 'unknown', 'paused'].includes(state);

function mountMusicInput(host) {
  host.innerHTML = `
    <p class="mi-intro">Experimental: give it a few seconds of audio to generate a continuation. Musical continuity varies.</p>
    <p class="mi-capability" data-mi="capability" role="status">Checking…</p>
    <button type="button" data-mi="refresh">Refresh</button>
    <pre data-mi="requirements" hidden></pre>
    <fieldset data-mi="prepareFields"><legend>1 · Audio to continue</legend>
      <label>WAV or FLAC, up to 50 MB<input data-mi="file" type="file" accept="audio/wav,audio/flac,.wav,.flac"></label>
      <label>Or a song from the library<input data-mi="library" type="text" placeholder="song.flac"></label>
      <p data-mi="sourceName"></p>
      <div class="mi-grid"><label>Start · seconds<input data-mi="start" type="number" min="0" step="0.01" value="0"></label>
        <label>Length · seconds<input data-mi="duration" type="number" min="0.25" max="15" step="0.01" value="7.5"></label></div>
      <button type="button" data-mi="prepare">Prepare</button>
    </fieldset>
    <label>Recent jobs<select data-mi="jobs"><option value="">Choose a job…</option></select></label>
    <p data-mi="jobStatus" role="status" aria-live="polite">No job selected.</p>
    <button type="button" data-mi="cancel" disabled>Cancel job</button>
    <fieldset data-mi="continueFields"><legend>2 · Continue it</legend>
      <p data-mi="reference">Prepare some audio first.</p>
      <label>Title<input data-mi="title" value="Audio-input continuation"></label>
      <label>Direction<textarea data-mi="caption" rows="3" placeholder="Tempo, key, instruments, where it goes"></textarea></label>
      <label>Lyrics<textarea data-mi="lyrics" rows="2">[Instrumental]</textarea></label>
      <div class="mi-grid"><label>New audio · seconds<input data-mi="seconds" type="number" min="0.25" max="30" step="0.01" value="7.5"></label>
        <label>Composition seed<input data-mi="seed" type="number" min="0" max="4294967295" step="1" placeholder="random"></label>
        <label>Mix seed<input data-mi="mixSeed" type="number" min="0" max="4294967295" step="1" placeholder="same as composition"></label></div>
      <button type="button" data-mi="continue">Generate</button>
    </fieldset>
    <p data-mi="error" role="alert" hidden></p><div data-mi="result" hidden></div>`;
  const q = name => host.querySelector(`[data-mi="${name}"]`);
  let available = false, busy = false, selected = null, reference = null, sourcePath = null, poll = null, request = 0;
  let selectedJob = null, submitting = false, cancelling = false, discovery = 0, errorScope = null;
  const error = (err, scope = 'action') => { errorScope = scope; q('error').textContent = err.message || String(err); q('error').hidden = false; };
  const controls = () => {
    q('prepareFields').disabled = !available || busy || submitting;
    q('continueFields').disabled = !available || busy || submitting || !reference;
    q('cancel').disabled = submitting || cancelling || !selectedJob || terminal(selectedJob.state);
    q('jobs').disabled = submitting;
  };
  async function api(body) {
    const response = await fetch('/api/music-input', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await response.json().catch(() => { throw new Error(`Music input returned HTTP ${response.status}; refresh availability or check the Studio server.`); });
    if (!response.ok || data.error) throw new Error(data.error || `Music input returned ${response.status}.`);
    return data;
  }
  function drawJobs(jobs) {
    q('jobs').replaceChildren(new Option('Choose a job…', ''));
    for (const j of jobs || []) q('jobs').add(new Option(`${j.title || j.source?.name || j.kind || 'Job'} · ${j.state} · ${j.id}`, j.id));
    if (selected && !Array.from(q('jobs').options).some(o => o.value === selected)) q('jobs').add(new Option(selected, selected));
    q('jobs').value = selected || '';
  }
  async function discover() {
    const token = ++discovery, selection = request;
    q('refresh').disabled = true;
    try {
      const data = await api(); if (token !== discovery || selection !== request) return;
      available = data.available === true;
      q('capability').textContent = available ? 'Ready.' : data.reason || 'Not set up on this machine.';
      q('requirements').textContent = JSON.stringify({ requirements: data.requirements, limits: data.limits, modes: data.modes }, null, 2);
      drawJobs(data.jobs); if (errorScope === 'availability') q('error').hidden = true;
    } catch (err) {
      if (token !== discovery || selection !== request) return;
      available = false; q('capability').textContent = 'Not available on this server.';
      q('requirements').textContent = 'Run the updated Studio server to discover the optional encoder setup.'; error(err, 'availability');
    } finally { if (token === discovery) { q('refresh').disabled = false; controls(); } }
  }
  function showResult(job) {
    const box = q('result'); box.replaceChildren(); box.hidden = true;
    const url = musicResultUrl(job.url); if (!url) return;
    box.hidden = false;
    /* The seeds actually used, so a random one can be kept: type it back into the box. */
    const seeds = Number.isInteger(job.seed)
      ? ` · seed ${job.seed}${Number.isInteger(job.mix_seed) && job.mix_seed !== job.seed ? ` · mix seed ${job.mix_seed}` : ''}` : '';
    const p = document.createElement('p'); p.textContent = `Generated: ${job.file}${seeds}`; box.append(p);
    const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none'; audio.src = url; box.append(audio);
    const link = document.createElement('a'); link.href = url; link.download = job.file; link.textContent = 'Download audio'; box.append(link);
    if (host.dataset.daw === 'true' && job.path) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Import at playhead on selected DAW track';
      button.onclick = () => {
        window.dispatchEvent(new CustomEvent('music-input-result', { detail: { file: job.file, path: job.path } }));
        host.closest('dialog')?.close(); // Reveal the DAW's guarded import progress or missing-target error.
      };
      box.append(button);
    }
  }
  function paintJob(job) {
    selectedJob = job;
    const progress = job.overall ?? job.progress;
    q('jobStatus').textContent = `${job.state} · ${job.stage || ''}${Number.isFinite(progress) ? ` · ${Math.round(progress * 100)}%` : ''} · ${job.id}${job.error ? ` · ${job.error}` : ''}`;
    reference = job.reference_id || null;
    q('reference').textContent = reference ? `Reference ${reference}${job.encoding?.prefix_seconds ? ` · ${job.encoding.prefix_seconds}s of encoded input` : ''}` : 'Prepare an input or select a ready reference above.';
    busy = !terminal(job.state); controls();
    if (terminal(job.state)) showResult(job);
  }
  async function selectJob(id) {
    if (submitting) return;
    const token = ++request; clearTimeout(poll); selected = id; reference = null; selectedJob = null; busy = !!id;
    q('result').querySelector('audio')?.pause(); q('result').hidden = true; q('error').hidden = true; controls();
    if (!id) { q('jobStatus').textContent = 'No job selected.'; q('reference').textContent = 'Prepare an input or select a ready reference above.'; return; }
    q('jobStatus').textContent = `Loading job ${id}…`;
    q('reference').textContent = 'Prepare an input or select a ready reference above.';
    async function tick() {
      try {
        const data = await api({ action: 'status', job_id: id }); if (token !== request) return;
        paintJob(data.job);
        if (!terminal(data.job.state)) poll = setTimeout(tick, 2000);
        else await discover();
      } catch (err) { if (token === request) { busy = false; controls(); error(err); } }
    }
    await tick();
  }
  q('refresh').onclick = discover;
  q('jobs').onchange = () => selectJob(q('jobs').value);
  q('cancel').onclick = async () => {
    if (submitting || cancelling || !selectedJob || terminal(selectedJob.state)) return;
    const id = selected, token = request; cancelling = true; controls();
    try { await api({ action: 'cancel', job_id: id }); if (token === request && selected === id) await selectJob(id); }
    catch (err) { if (token === request) error(err); }
    finally { cancelling = false; controls(); }
  };
  const clearReference = () => { reference = null; q('reference').textContent = 'Prepare an input or select a ready reference above.'; controls(); };
  q('file').onchange = () => { q('library').value = ''; sourcePath = null; q('sourceName').textContent = ''; clearReference(); };
  q('library').oninput = () => { q('file').value = ''; sourcePath = null; q('sourceName').textContent = ''; clearReference(); };
  q('prepare').onclick = async () => {
    if (busy || submitting) return;
    const token = ++request; clearTimeout(poll);
    submitting = true; controls(); q('error').hidden = true;
    try {
      const f = q('file').files?.[0]; let dataUrl;
      if (f) {
        if (f.size > 50 * 1024 * 1024 || !/\.(wav|flac)$/i.test(f.name)) throw new Error('Choose a WAV or FLAC file up to 50 MB.');
        dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read that audio file.')); reader.readAsDataURL(f); });
        dataUrl = dataUrl.replace(/^data:[^;]*;base64,/, `data:audio/${/\.flac$/i.test(f.name) ? 'flac' : 'wav'};base64,`);
      }
      const body = inputSelection({ library: q('library').value, dataUrl, name: f?.name, path: sourcePath, start: q('start').value, duration: q('duration').value });
      const data = await api(body); if (token !== request) return;
      submitting = false; await selectJob(data.job.id);
    } catch (err) { if (token === request) { submitting = false; controls(); error(err); } }
  };
  q('continue').onclick = async () => {
    if (busy || submitting) return;
    let token;
    try {
      const body = continuationSettings({ reference, caption: q('caption').value, lyrics: q('lyrics').value,
        seed: q('seed').value, mixSeed: q('mixSeed').value, seconds: q('seconds').value, title: q('title').value });
      token = ++request; clearTimeout(poll); submitting = true; controls(); q('error').hidden = true;
      const data = await api(body); if (token !== request) return;
      submitting = false; await selectJob(data.job.id);
    } catch (err) { if (token === undefined || token === request) { submitting = false; controls(); error(err); } }
  };
  host.addEventListener('music-input-source', event => {
    if (busy || submitting) { error(new Error('Finish or cancel the selected job before choosing another input.')); return; }
    sourcePath = event.detail.path; q('file').value = ''; q('library').value = '';
    q('sourceName').textContent = `Selected export: ${event.detail.name}`;
    q('title').value = `${event.detail.name} · continuation`; clearReference();
  });
  host.closest('dialog')?.addEventListener('close', () => q('result').querySelector('audio')?.pause());
  discover();
}

if (typeof document !== 'undefined') for (const host of document.querySelectorAll('[data-music-input]')) mountMusicInput(host);
