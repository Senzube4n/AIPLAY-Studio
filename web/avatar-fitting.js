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
  setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  const $ = id => documentRef.getElementById(id), form = $('fitting-form');
  let live = true, busy = false, ready = false, version = 0, inspection = null, job = null, submitted = null, timer;
  const current = token => live && isCurrent() && token === version;
  const note = (message = '', error = false) => {
    $('fitting-note').textContent = message;
    $('fitting-note').hidden = !message;
    $('fitting-note').className = `hint${error ? ' warnhint' : ''}`;
  };
  const paint = () => {
    $('fitting-inspect').disabled = busy || !ready || job?.state === 'running';
    $('fitting-submit').disabled = busy || !inspection || job?.state === 'running';
    $('fitting-add').disabled = busy || job?.state !== 'complete';
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
        try { display(await api({action:'get', id}), nextToken); }
        catch(error) { if(current(token) && job?.id===id && job.state==='running') schedulePoll(id, token); throw error; }
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
    $('fitting-state').textContent = next.state === 'complete' ? 'Ready to review' : next.state === 'running' ? 'Preparing fit' : 'Fit stopped';
    if (next.error) note(next.error, true);
    else if(next.state === 'running') note();
    if (next.state === 'complete') {
      const result = next.result;
      $('fitting-result').textContent = `${result.vertices.toLocaleString()} vertices · ${result.joints} joints`;
      note('Add the part to preview its fit and movement.');
    }
    clearTimer(timer);
    if (next.state === 'running') schedulePoll(next.id, token);
    paint();
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
      if(!['outfit','hair','head','body','shoes','accessory'].includes(slot)) throw Error('Choose a part slot.');
      submitted = Object.freeze({...input,slot}); job = null; note(); $('fitting-state').textContent = 'Preparing fit';
      display(await api({action:'submit', ...input}), token);
    });
  };
  $('fitting-add').onclick = () => work(async token => {
    if (job?.state !== 'complete' || !submitted) return;
    await onPrepared({path:job.result.output, name:submitted.name, slot:submitted.slot, source:submitted.source, license:submitted.license});
    if (current(token)) { $('fitting-state').textContent = 'Added to wardrobe'; note('Select the part to preview it.'); job = null; }
  });
  form.elements.name.maxLength=80;
  $('fitting-panel').hidden = false; paint();
  $('fitting-state').textContent = 'Checking local tools';
  void api({action:'status'}).then(value => {
    if (!live || !isCurrent()) return;
    ready = value.available;
    $('fitting-state').textContent = ready ? 'Choose a part' : 'Setup needed';
    if (!ready) note(value.reason, true);
    paint();
  }).catch(error => { if (live && isCurrent()) { note(error.message,true); $('fitting-state').textContent = 'Unavailable'; } });
  return {dispose() { live = false; version++; clearTimer(timer); }};
}
