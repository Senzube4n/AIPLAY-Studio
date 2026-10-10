const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const clock = seconds => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;

export function comparisonPlaybackVolume(gainDb, listeningVolume) {
  if (!Number.isFinite(gainDb) || gainDb < -24 || gainDb > 0 || !Number.isFinite(listeningVolume) || listeningVolume < 0 || listeningVolume > 1) return 0;
  return 10 ** (gainDb / 20) * listeningVolume;
}

/** One audio element, gain <= 1, equal-position switches. The server checks
 * saved source identities before playing and independently on range requests. */
export function mountMusicTakeComparison({ root, fetch: request = fetch, onBeforePlay = async () => {} } = {}) {
  if (!root || root.dataset.takeComparisonMounted) return;
  const ownerDocument = root.ownerDocument || document;
  root.dataset.takeComparisonMounted = 'true';
  root.classList.add('music-take-comparison');
  root.innerHTML = `<section class="pcard" id="musicTakesSelect" data-nav="Select">
    <h3>Compare saved takes</h3><p class="pcard-sub">Switch between recordings at the same position with matched loudness.</p>
    <div class="params"><label for="musicTakesCount">group size</label><span class="pv"><select id="musicTakesCount" class="sel2" data-tc="count"><option>2</option><option>4</option><option>8</option></select></span>
    <label for="musicTakesName">name</label><span class="pv"><input id="musicTakesName" class="in2" maxlength="120" data-tc="name" placeholder="Chorus alternatives"></span>
    <label for="musicTakesSearch">find songs</label><span class="pv"><input id="musicTakesSearch" class="in2" data-tc="search" type="search" placeholder="Title or filename"></span></div>
    <div class="tc-library" data-tc="library"></div><div class="cta"><button class="btn2" data-tc-action="latest">Latest 2</button><span class="chip" data-tc="selected">0 selected</span><button class="btn" data-tc-action="create">Compare selected</button></div>
    <span class="chip" data-tc="status" role="status" aria-live="polite">Loading songs</span>
  </section>
  <section class="pcard" id="musicTakesReview" data-nav="Listen"><h3>Listen and choose</h3>
    <div class="params"><label for="musicTakesSaved">saved group</label><span class="pv tc-saved"><select id="musicTakesSaved" class="sel2" data-tc="saved"><option value="">Choose</option></select><button class="btn2" data-tc-action="open">Open</button><button class="btn2" data-tc-action="refresh">Refresh</button></span></div>
    <div data-tc="empty" class="hint">Select recordings to begin.</div>
    <div data-tc="audition" hidden><div class="tc-summary"><h4 data-tc="title"></h4><span class="chip ok" data-tc="matching"></span></div>
    <div class="tc-takes" data-tc="takes"></div>
    <div class="tc-transport"><button class="btn2" data-tc-action="play">Play</button><label class="tc-seek">position<input type="range" min="0" max="1" step=".01" value="0" data-tc="position" aria-label="Playback position"></label><output data-tc="time">0:00</output>
    <label class="tc-volume">volume<input type="range" min="0" max="1" step=".01" value=".85" data-tc="volume" aria-label="Listening volume"></label></div>
    <audio data-tc="audio" preload="none" hidden></audio>
    <div class="cta"><label class="tog"><input type="checkbox" data-tc="favourite" checked> Favourite</label><button class="btn2 go" data-tc-action="choose">Keep this take</button><button class="btn2" data-tc-action="receipts">Save receipts</button><span class="chip" data-tc="choice"></span></div>
    <details class="more"><summary>Stored settings</summary><p class="hint">Receipts preserve recorded text and settings; missing older settings remain unknown.</p><div data-tc="receipts"></div></details>
    <details class="more"><summary>Earlier choices</summary><div data-tc="history"></div></details>
    </div></section>`;
  const $ = name => root.querySelector(`[data-tc="${name}"]`), player = $('audio');
  let songs = [], groups = [], selected = new Set(), current = null, takeId = null, pending = false, disposed = false, epoch = 0, playbackEpoch = 0, creationKey = crypto.randomUUID();
  let loading = false, seekPosition = 0, cancelMediaWait = null;
  const count = () => Number($('count').value);
  const say = (message, tone = '') => { $('status').textContent = message; $('status').className = `chip ${tone}`; };
  async function api(body) {
    const response = await request('/api/music-take-comparison', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`); return data;
  }
  function controls() {
    for (const button of root.querySelectorAll('button')) button.disabled = pending;
    root.querySelector('[data-tc-action="create"]').disabled ||= selected.size !== count();
    root.querySelector('[data-tc-action="open"]').disabled ||= !$('saved').value;
    root.querySelector('[data-tc-action="latest"]').disabled ||= songs.length < count();
    for (const name of ['count', 'name', 'saved', 'favourite']) $(name).disabled = pending;
    for (const input of root.querySelectorAll('[data-tc-file]')) input.disabled = pending || (!selected.has(input.dataset.tcFile) && selected.size >= count());
    for (const name of ['play', 'choose', 'receipts']) root.querySelector(`[data-tc-action="${name}"]`).disabled ||= !current || !takeId;
    root.querySelector('[data-tc-action="play"]').disabled ||= loading;
    for (const button of root.querySelectorAll('[data-tc-action="switch"]')) button.disabled ||= loading;
  }
  function libraryPaint() {
    const needle = $('search').value.trim().toLowerCase(), found = songs.filter(song => `${song.title} ${song.file}`.toLowerCase().includes(needle));
    const visible = found.slice(0, 100);
    $('library').innerHTML = visible.map(song => `<label class="tc-song"><input type="checkbox" data-tc-file="${esc(song.file)}" ${selected.has(song.file) ? 'checked' : ''}><span><strong>${esc(song.title)}</strong><small>${esc(song.engine || 'Imported')} ${song.seconds ? `· ${clock(song.seconds)}` : ''}</small></span></label>`).join('') || '<span class="hint">No matching songs.</span>';
    if (found.length > 100) $('library').insertAdjacentHTML('beforeend', '<span class="hint">Search to narrow this list.</span>');
    $('selected').textContent = `${selected.size} selected`;
    root.querySelector('[data-tc-action="latest"]').textContent = `Latest ${count()}`; controls();
  }
  function groupsPaint() {
    const old = $('saved').value;
    $('saved').innerHTML = '<option value="">Choose</option>' + groups.map(group => `<option value="${esc(group.id)}">${esc(group.name)} · ${group.count} takes</option>`).join('');
    $('saved').value = current?.id || old; controls();
  }
  function takePaint() {
    if (!current) return;
    $('takes').innerHTML = current.takes.map(take => `<article class="tc-take ${take.id === takeId ? 'tc-active' : ''}"><button class="btn2" data-tc-action="switch" data-tc-take="${take.id}" aria-pressed="${take.id === takeId}"><b>${take.id}</b> ${esc(take.title)}</button><small>${clock(take.seconds)} · ${take.measurement.integrated.toFixed(1)} LUFS · ${take.playback.gainDb.toFixed(1)} dB gain</small></article>`).join('');
    const take = current.takes.find(take => take.id === takeId); $('position').max = take?.seconds || 1;
    $('choice').textContent = current.chosen ? `Kept ${current.chosen.takeId}${current.chosen.favourite ? ' · favourite' : ''}` : '';
    $('choice').hidden = !current.chosen;
    $('history').innerHTML = current.choices.map(choice => `<p>${esc(choice.takeId)} · ${esc(new Date(choice.at).toLocaleString())}</p>`).join('') || '<p class="hint">No choices yet.</p>';
    controls();
  }
  function stop() { ++playbackEpoch; loading = false; cancelMediaWait?.(); cancelMediaWait = null; player.pause(); player.removeAttribute('src'); player.load(); root.querySelector('[data-tc-action="play"]').textContent = 'Play'; }
  function reviewPaint(row) {
    stop(); current = row; takeId = row.chosen?.takeId || row.takes[0].id;
    $('empty').hidden = true; $('audition').hidden = false; $('title').textContent = row.name;
    $('matching').textContent = `${row.matching.targetLufs.toFixed(1)} LUFS matched`;
    $('receipts').innerHTML = row.takes.map(take => `<details class="more"><summary>Take ${take.id} receipt</summary><pre>${esc(JSON.stringify({ file: take.file, sha256: take.sha256, receiptHash: take.receiptHash, receipt: take.receipt }, null, 2))}</pre></details>`).join('');
    seekPosition = 0; $('position').value = 0; $('time').textContent = '0:00'; takePaint();
  }
  const applyVolume = () => {
    const take = current?.takes.find(take => take.id === takeId);
    player.volume = comparisonPlaybackVolume(take?.playback?.gainDb, Number($('volume').value));
  };
  async function play(take, position = 0) {
    const ticket = ++playbackEpoch, groupId = current.id; loading = true; player.pause(); say(`Checking take ${take.id}`, 'busy'); controls();
    try {
      await api({ action: 'verify', id: groupId });
      if (disposed || ticket !== playbackEpoch || current?.id !== groupId) return;
      await onBeforePlay();
      if (disposed || ticket !== playbackEpoch || current?.id !== groupId) return;
      takeId = take.id; applyVolume();
      await new Promise((resolve, reject) => {
        const done = () => { player.removeEventListener('loadedmetadata', loaded); player.removeEventListener('error', failed); clearTimeout(timeout); cancelMediaWait = null; };
        const loaded = () => { done(); resolve(); }, failed = () => { done(); reject(new Error('This recording could not play. Refresh the comparison.')); };
        const timeout = setTimeout(() => { done(); reject(new Error('Audio did not open. Try again.')); }, 20_000);
        cancelMediaWait = () => { done(); resolve(); };
        player.addEventListener('loadedmetadata', loaded); player.addEventListener('error', failed); player.src = take.audioUrl; player.load();
      });
      if (disposed || ticket !== playbackEpoch || current?.id !== groupId) return;
      player.currentTime = Math.max(0, Math.min(position, Math.max(0, player.duration - .05))); seekPosition = player.currentTime; await player.play();
      if (disposed || ticket !== playbackEpoch) { player.pause(); return; }
      takePaint(); say(`Take ${take.id} playing`, 'ok');
    } finally { if (ticket === playbackEpoch) { loading = false; controls(); } }
  }
  async function refresh() {
    const ticket = ++epoch, data = await api({ action: 'list' });
    const groupId = current?.id, latest = groupId ? await api({ action: 'get', id: groupId }) : null;
    if (disposed || ticket !== epoch) return;
    songs = data.songs || []; groups = data.comparisons || [];
    selected = new Set([...selected].filter(file => songs.some(song => song.file === file)));
    if (latest && current?.id === groupId) { current = latest.comparison; takePaint(); }
    libraryPaint(); groupsPaint(); say(data.errors?.length ? 'Saved group needs repair' : 'Ready', data.errors?.length ? 'warn' : 'ok');
  }
  const onInput = event => {
    if (event.target === $('search')) libraryPaint();
    if (event.target === $('volume')) applyVolume();
    if (event.target === $('position')) {
      seekPosition = Number(event.target.value);
      if (player.src) player.currentTime = Math.min(seekPosition, Number.isFinite(player.duration) ? player.duration : 0);
      $('time').textContent = clock(seekPosition);
    }
    if (event.target === $('name')) creationKey = crypto.randomUUID();
  };
  const onChange = event => {
    if (event.target.matches('[data-tc-file]')) {
      if (event.target.checked && selected.size < count()) selected.add(event.target.dataset.tcFile); else selected.delete(event.target.dataset.tcFile);
      creationKey = crypto.randomUUID(); libraryPaint();
    } else if (event.target === $('count')) { selected = new Set([...selected].slice(0, count())); creationKey = crypto.randomUUID(); libraryPaint(); }
    else if (event.target === $('saved')) controls();
  };
  const onClick = async event => {
    const button = event.target.closest('[data-tc-action]'); if (!button || !root.contains(button) || pending) return;
    const action = button.dataset.tcAction;
    try {
      if (action === 'latest') { selected = new Set(songs.slice(0, count()).map(song => song.file)); creationKey = crypto.randomUUID(); libraryPaint(); return; }
      if (action === 'receipts') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
        const link = ownerDocument.createElement('a'); link.href = url; link.download = `${current.id}-receipts.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
      }
      if (action === 'play' || action === 'switch') {
        if (loading) return;
        if (action === 'play' && !player.paused) { player.pause(); return; }
        const take = current.takes.find(take => take.id === (button.dataset.tcTake || takeId)), position = seekPosition;
        if (action === 'switch' && player.paused) { ++playbackEpoch; player.removeAttribute('src'); player.load(); takeId = take.id; seekPosition = Math.min(position, take.seconds); takePaint(); $('position').value = seekPosition; $('time').textContent = clock(seekPosition); say(`Take ${takeId} selected`); return; }
        await play(take, position); return;
      }
      pending = true; controls(); ++epoch;
      if (action === 'refresh') await refresh();
      if (action === 'create') {
        say('Measuring selected songs', 'busy');
        const data = await api({ action: 'create', idempotencyKey: creationKey, name: $('name').value || `${count()} takes`, files: [...selected] });
        if (!disposed) { reviewPaint(data.comparison); await refresh(); say('Comparison saved', 'ok'); }
      }
      if (action === 'open') { const data = await api({ action: 'get', id: $('saved').value }); if (!disposed) { reviewPaint(data.comparison); say('Comparison opened', 'ok'); } }
      if (action === 'choose') {
        const data = await api({ action: 'choose', id: current.id, expectedRevision: current.revision, takeId, favourite: $('favourite').checked });
        if (!disposed) { current = data.comparison; takePaint(); say(`Kept take ${takeId}`, 'ok'); }
      }
    } catch (error) { if (!disposed) { player.pause(); say(error.message, 'err'); } }
    finally { pending = false; if (!disposed) controls(); }
  };
  const onTime = () => { if (!player.src || loading) return; seekPosition = player.currentTime; $('position').value = seekPosition; $('time').textContent = clock(seekPosition); };
  const onPlay = () => {
    root.querySelector('[data-tc-action="play"]').textContent = player.paused ? 'Play' : 'Pause';
    if (current && takeId && !pending && !loading) say(`Take ${takeId} ${player.paused ? 'paused' : 'playing'}`, player.paused ? '' : 'ok');
  };
  const onVisibility = () => { if (root.closest('[hidden]') || ownerDocument.hidden) { stop(); if (!disposed) controls(); } };
  root.addEventListener('input', onInput); root.addEventListener('change', onChange); root.addEventListener('click', onClick);
  player.addEventListener('timeupdate', onTime); player.addEventListener('play', onPlay); player.addEventListener('pause', onPlay); player.addEventListener('ended', onPlay);
  ownerDocument.addEventListener('visibilitychange', onVisibility);
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(onVisibility) : null;
  if (observer) observer.observe(root.parentElement || root, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
  refresh().catch(error => { if (!disposed) say(error.message, 'err'); });
  return { refresh, destroy() { if (disposed) return; disposed = true; ++epoch; stop(); observer?.disconnect(); ownerDocument.removeEventListener('visibilitychange', onVisibility);
    root.removeEventListener('input', onInput); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick);
    player.removeEventListener('timeupdate', onTime); player.removeEventListener('play', onPlay); player.removeEventListener('pause', onPlay); player.removeEventListener('ended', onPlay);
    delete root.dataset.takeComparisonMounted; } };
}
