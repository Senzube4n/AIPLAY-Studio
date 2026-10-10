/** Local fitting jobs prepare a new file. Wardrobe admission is a separate action. */
export async function avatarFileBase64(file, limit = 32 * 1024 * 1024) {
  if (!file || file.size <= 0 || file.size > limit) throw Error('Choose a GLB up to 32 MiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length > limit) throw Error('The selected file changed. Choose it again.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

export async function avatarLocalPost(url, body, {signal} = {}) {
  signal ??= AbortSignal.timeout(180000);
  const response = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal});
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error(value.error || `HTTP ${response.status}`), {status:response.status});
  return value;
}

export function mountAvatarFitting({row, onPrepared, isCurrent = () => true,
  api = body => avatarLocalPost('/api/avatar-fitting', body), documentRef = document,
  setTimer = setTimeout, clearTimer = clearTimeout,
  storage = (() => { try { return globalThis.localStorage; } catch { return null; } })()} = {}) {
  const $ = id => documentRef.getElementById(id), form = $('fitting-form');
  const slots = ['outfit','hair','head','body','shoes','accessory'];
  const fitId = /^fit_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const storageKey = `aiplay.avatar-fitting.v1:${row.id}:${row.inspection.sha256}`;
  let live = true, busy = false, ready = false, version = 0, inspection = null, job = null, submitted = null, timer;
  const current = token => live && isCurrent() && token === version;
  const forget = id => {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
      if (!id || saved?.job_id === id) storage?.removeItem(storageKey);
    } catch { try { storage?.removeItem(storageKey); } catch {} }
  };
  const savedJob = () => {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) || 'null');
      if (!saved) return null;
      if (saved.avatar_id === row.id && saved.source_sha256 === row.inspection.sha256 && fitId.test(saved.job_id) && slots.includes(saved.slot)) return saved;
    } catch {}
    forget(); return null;
  };
  const remember = (id, slot) => {
    if (!fitId.test(id) || !slots.includes(slot)) return;
    try { storage?.setItem(storageKey, JSON.stringify({job_id:id, avatar_id:row.id, source_sha256:row.inspection.sha256, slot})); } catch {}
  };
  const validateJob = (next, id) => {
    if (!next || next.id !== id || next.avatar_id !== row.id || next.source_sha256 !== row.inspection.sha256)
      throw Object.assign(Error('This fit belongs to another avatar or an older avatar file.'), {status:409});
    if (!['running','complete','failed','interrupted'].includes(next.state)) throw Error('Fitting job returned an unknown state.');
    if (['running','complete'].includes(next.state) && ['name','source','license'].some(key => typeof next[key] !== 'string' || !next[key].trim()))
      throw Error('Fitting job metadata is incomplete.');
    if (next.state === 'complete' && (!next.result?.output || !Number.isInteger(next.result.vertices) || !Number.isInteger(next.result.joints)))
      throw Error('Fitting result is incomplete.');
    return next;
  };
  const note = (message = '', error = false) => {
    $('fitting-note').textContent = message;
    $('fitting-note').hidden = !message;
    $('fitting-note').className = `hint${error ? ' warnhint' : ''}`;
  };
  const paint = () => {
    $('fitting-inspect').disabled = busy || !ready || job?.state === 'running';
    $('fitting-submit').disabled = busy || !inspection || job?.state === 'running';
    $('fitting-add').disabled = busy || job?.state !== 'complete';
    $('fitting-find').disabled = busy;
    form.elements.reference_node.disabled = busy || !inspection;
  };
  const work = async task => {
    if (!live || !isCurrent() || busy) return;
    const token = version; busy = true; paint();
    try { await task(token); }
    catch (error) { if (current(token)) { $('fitting-state').textContent = 'Check inputs'; note(error.message, true); } }
    finally { if (live && isCurrent()) { busy = false; paint(); } }
  };
  function invalidate() {
    version++; inspection = null; job = null; submitted = null; clearTimer(timer);
    $('fitting-state').textContent = 'Choose a part'; $('fitting-job').textContent = '';
    $('fitting-result').textContent = ''; note(); paint();
  }
  function schedulePoll(id, token) {
    clearTimer(timer);
    timer = setTimer(() => {
      if(!current(token)) return;
      if(busy) { schedulePoll(id, token); return; }
      void work(async nextToken => {
        try { await fetchJob(id, submitted?.slot, nextToken); }
        catch(error) {
          if (current(token) && job?.id===id && job.state==='running') {
            if ([404,409].includes(error.status)) {
              forget(id); job = null; submitted = null; $('fitting-state').textContent = 'Fit unavailable';
              note(error.message, true); paint(); return;
            }
            schedulePoll(id, token);
          }
          throw error;
        }
      });
    }, 1200);
  }
  form.elements.file.onchange = () => {
    invalidate();
    const file = form.elements.file.files[0];
    if (file && !form.elements.name.value) form.elements.name.value = file.name.replace(/\.glb$/i, '').slice(0, 80);
  };
  function display(next, token) {
    if (!current(token)) return;
    job = next; $('fitting-job').textContent = next.id;
    $('fitting-find-id').value = next.id;
    $('fitting-state').textContent = next.state === 'complete' ? 'Ready to review' : next.state === 'running' ? 'Preparing fit' : 'Fit stopped';
    if (next.error) note(next.error, true);
    else if(next.state === 'running') note();
    if (next.state !== 'complete') $('fitting-result').textContent = '';
    if (next.state === 'complete') {
      const result = next.result;
      $('fitting-result').textContent = `${result.vertices.toLocaleString()} vertices · ${result.joints} joints`;
      note('Add the part to preview its fit and movement.');
    }
    clearTimer(timer);
    if (next.state === 'running') schedulePoll(next.id, token);
    paint();
  }
  async function fetchJob(id, slot, token) {
    const next = validateJob(await api({action:'get', id}), id);
    if (!current(token)) return;
    if (next.state === 'running' || next.state === 'complete') {
      if (!slots.includes(slot)) throw Error('Choose a part slot before reopening this fit.');
      submitted = Object.freeze({name:next.name, source:next.source, license:next.license, slot});
      remember(id, slot);
    } else {
      forget(id); submitted = null;
    }
    display(next, token);
  }
  $('fitting-inspect').onclick = () => {
    if(!live || !isCurrent() || busy || !ready || job?.state==='running') return;
    invalidate();
    return work(async token => {
    const file = form.elements.file.files[0];
    inspection = null; job = null; note(); $('fitting-state').textContent = 'Inspecting';
    const target_data_base64 = await avatarFileBase64(file);
    if (!current(token)) return;
    const next = await api({action:'inspect', avatar_id:row.id, target_data_base64});
    if (!current(token) || form.elements.file.files[0] !== file) return;
    if (next.source_sha256 !== row.inspection.sha256) throw Error('Avatar changed. Reopen it before fitting.');
    inspection = next;
    for (const key of ['clearance','max_displacement','max_scale_change']) {
      const bounds = next.limits?.[key];
      if (bounds) { form.elements[key].min = bounds[0]; form.elements[key].max = bounds[1]; }
    }
    const select = form.elements.reference_node; select.replaceChildren();
    for (const [index, surface] of next.reference_surfaces.entries()) {
      const option = documentRef.createElement('option'); option.value = String(index); option.textContent = surface.name;
      select.append(option);
    }
    if (!next.reference_surfaces.length) throw Error('No weighted reference surface is available.');
    select.value = '0'; $('fitting-state').textContent = 'Choose base surface';
    note('Choose the matching body or clothing surface.');
    });
  };
  form.onsubmit = event => {
    event.preventDefault();
    return work(async token => {
      if (!inspection) throw Error('Inspect the part first.');
      if(job?.state==='running') throw Error('Wait for the current fit to finish.');
      const surface = inspection.reference_surfaces[Number(form.elements.reference_node.value)];
      if (!surface) throw Error('Choose a base surface.');
      const input = {avatar_id:row.id, source_sha256:inspection.source_sha256, target_id:inspection.target_id,
        target_sha256:inspection.target_sha256, expected_skeleton:inspection.skeleton,
        reference_mesh_node:surface.mesh_node, reference_primitive:surface.primitive,
        alignment:form.elements.alignment.value, clearance:Number(form.elements.clearance.value),
        max_displacement:Number(form.elements.max_displacement.value), max_scale_change:Number(form.elements.max_scale_change.value),
        name:form.elements.name.value.trim(), source:form.elements.source.value.trim(), license:form.elements.license.value.trim()};
      if(!input.name || input.name.length>80) throw Error('Use a part name up to 80 characters.');
      const slot=form.elements.slot.value;
      if(!slots.includes(slot)) throw Error('Choose a part slot.');
      submitted = Object.freeze({...input,slot}); job = null; note(); $('fitting-state').textContent = 'Preparing fit';
      const next = await api({action:'submit', ...input});
      if (!fitId.test(next?.id)) throw Error('Fitting job returned an invalid ID.');
      validateJob(next, next.id);
      remember(next.id, slot);
      if (!current(token)) return;
      display(next, token);
    });
  };
  $('fitting-find').onclick = () => work(async token => {
    const id = $('fitting-find-id').value.trim();
    if (!fitId.test(id)) throw Error('Paste a valid fitting job ID.');
    const saved = savedJob();
    const slot = saved?.job_id === id ? saved.slot : form.elements.slot.value;
    await fetchJob(id, slot, token);
  });
  $('fitting-add').onclick = () => work(async token => {
    if (job?.state !== 'complete' || !submitted) return;
    await onPrepared({path:job.result.output, name:submitted.name, slot:submitted.slot, source:submitted.source, license:submitted.license});
    if (current(token)) { forget(job.id); $('fitting-state').textContent = 'Added to wardrobe'; note('Select the part to preview it.'); job = null; paint(); }
  });
  form.elements.name.maxLength=80;
  $('fitting-panel').hidden = false; paint();
  $('fitting-state').textContent = 'Checking local tools';
  const initialToken = version;
  void (async () => {
    try {
      const value = await api({action:'status'});
      if (!current(initialToken)) return;
      ready = value.available;
      $('fitting-state').textContent = ready ? 'Choose a part' : 'Setup needed';
      if (!ready) note(value.reason, true);
      paint();
    } catch(error) {
      if (current(initialToken)) { note(error.message,true); $('fitting-state').textContent = 'Unavailable'; }
    }
    if (!current(initialToken)) return;
    const saved = savedJob();
    if (!saved) return;
    try { await fetchJob(saved.job_id, saved.slot, initialToken); }
    catch(error) {
      if (current(initialToken)) {
        if ([404,409].includes(error.status)) forget(saved.job_id);
        $('fitting-state').textContent = 'Check job'; note(error.message, true); paint();
      }
    }
  })();
  return {dispose() { live = false; version++; clearTimer(timer); }};
}
