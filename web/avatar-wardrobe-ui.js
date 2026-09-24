import {createAvatarWardrobeRuntime, disposeWardrobeGltf} from './avatar-wardrobe.js';
import {avatarFileBase64, avatarLocalPost} from './avatar-fitting.js';

/** A late/failed load never replaces the last complete outfit. */
export function createWardrobePreview({runtime, load, dispose = disposeWardrobeGltf}) {
  let version = 0, live = true;
  return {
    async apply(parts) {
      if (!live) return false;
      const token = ++version;
      const results = await Promise.allSettled(parts.map(async manifest => ({manifest, gltf:await load(manifest.files.glb)})));
      const loaded = results.filter(result => result.status === 'fulfilled').map(result => result.value);
      const error = results.find(result => result.status === 'rejected');
      if (!live || token !== version || error) {
        for (const item of loaded) dispose(item.gltf);
        if (live && token === version && error) throw error.reason;
        return false;
      }
      try { runtime.replace(loaded); }
      catch (error) { for (const item of loaded) dispose(item.gltf); throw error; }
      return true;
    },
    update() { if (live) runtime.update(); },
    cancelPending() { version++; },
    dispose() { if (!live) return; live = false; version++; runtime.dispose(); },
  };
}

export function mountAvatarWardrobeUI({row, gltf, load, isCurrent = () => true,
  api = body => avatarLocalPost('/api/avatars/wardrobe', body), documentRef = document,
  runtime = createAvatarWardrobeRuntime({gltf, avatarId:row.id, sha256:row.inspection.sha256}), setTimer = setInterval, clearTimer = clearInterval} = {}) {
  const $ = id => documentRef.getElementById(id), form = $('wardrobe-form');
  const preview = createWardrobePreview({runtime, load});
  let live = true, context = 0, lookId = null, lookName = '', version = 0, selection = null,
    parts = [], draft = [], dirty = false, busy = false, previewing = false, previewValid = false, polling = false;
  const current = token => live && isCurrent() && token === context;
  const note = (message = '') => { $('wardrobe-note').textContent = message; $('wardrobe-note').hidden = !message; };
  const paint = () => {
    $('wardrobe-save').disabled = busy || previewing || !dirty || !previewValid;
    $('wardrobe-reset').disabled = busy || !selection || (!dirty && previewValid);
    $('wardrobe-import-submit').disabled = busy;
    $('wardrobe-context').textContent = lookName || 'Base outfit';
    $('wardrobe-state').textContent = previewing ? 'Loading parts' : selection && !previewValid ? 'Preview unavailable' : dirty ? 'Unsaved outfit' : draft.length ? `${draft.length} equipped` : 'Base model';
  };
  async function show(ids, token = context) {
    const ticket = ++version; preview.cancelPending(); previewing = true; previewValid = false; paint();
    try {
      const selected = ids.map(id => {
        const part = parts.find(item => item.id === id);
        if (!part) throw Error('A selected part is unavailable. Refresh the outfit.');
        return part;
      });
      const applied = await preview.apply(selected);
      if (current(token) && ticket === version) { previewValid = applied; if(applied) note(); }
    } catch (error) { if (current(token) && ticket === version) note(error.message); }
    finally { if (current(token) && ticket === version) { previewing = false; paint(); } }
  }
  function draw() {
    $('wardrobe-list').replaceChildren();
    if (!parts.length) {
      const empty = documentRef.createElement('p'); empty.className = 'hint'; empty.textContent = 'Add a prepared part or fit one below.';
      $('wardrobe-list').append(empty);
    }
    for (const part of parts) {
      const line = documentRef.createElement('div'); line.className = 'wardrobe-item';
      const label = documentRef.createElement('label'), check = documentRef.createElement('input'), name = documentRef.createElement('span');
      check.type = 'checkbox'; check.checked = draft.includes(part.id); check.disabled = busy; check.title = 'Preview this part. Save outfit to keep the selection.';
      name.textContent = part.name; label.append(check, name);
      const slot = documentRef.createElement('span'); slot.className = 'hint'; slot.textContent = part.slot; slot.title = `${part.source}\n${part.license}`;
      check.onchange = () => {
        if (!live || !isCurrent() || busy) return;
        const next = new Set(draft);
        if(check.checked && part.slot !== 'accessory') for(const previous of parts) if(previous.slot === part.slot) next.delete(previous.id);
        check.checked ? next.add(part.id) : next.delete(part.id);
        if (next.size > 8) { check.checked = false; note('Choose up to eight parts.'); return; }
        draft = [...next]; dirty = true; note(); void show(draft); draw(); paint();
      };
      const remove = documentRef.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
      remove.className = 'btn sm'; remove.disabled = busy || draft.includes(part.id);
      remove.title = 'Remove an unused part from this wardrobe.';
      let confirmed = false;
      remove.onclick = async () => {
        if (busy || !live || !isCurrent() || draft.includes(part.id)) return;
        if (!confirmed) { confirmed = true; remove.textContent = 'Confirm remove'; return; }
        const token = context; busy = true; paint(); draw();
        try { await api({action:'delete',id:row.id,sha256:row.inspection.sha256,part_id:part.id}); if (current(token)) await refreshParts(token); }
        catch (error) { if (current(token)) note(error.message); }
        finally { if (current(token)) { busy = false; draw(); paint(); } }
      };
      line.append(label, slot, remove); $('wardrobe-list').append(line);
    }
  }
  async function refreshParts(token) {
    const result = await api({action:'list', id:row.id});
    if (!current(token)) return false;
    if (result.sha256 !== row.inspection.sha256) throw Error('Avatar changed. Reopen it.');
    parts = result.parts; draw(); return true;
  }
  async function accept(next, token) {
    if (!current(token)) return;
    if(next.id!==row.id || next.sha256!==row.inspection.sha256 || next.look_id!==lookId) throw Error('Outfit source changed. Reopen the avatar.');
    selection = next; draft = [...next.part_ids]; dirty = false;
    for (const part of next.parts || []) if (!parts.some(item => item.id === part.id)) parts.push(part);
    draw(); await show(draft, token);
  }
  async function setLook(next) {
    const id = next?.id || null;
    if (selection && id === lookId) { lookName = next?.name || ''; paint(); return; }
    const token = ++context; version++; lookId = id; lookName = next?.name || '';
    selection = null; draft = []; dirty = false; busy = false; previewing = false; previewValid = false; note(); draw(); paint();
    try {
      // Clear a previous look while the new context is resolved.
      await preview.apply([]);
      if (!current(token) || !await refreshParts(token)) return;
      const selected = await api({action:'selection', id:row.id, look_id:id});
      await accept(selected, token);
    } catch (error) { if (current(token)) note(error.message); }
  }
  async function importPart(input) {
    if(!live || !isCurrent()) throw Error('Reopen the avatar before importing a part.');
    const part = await api({action:'import', id:row.id, sha256:row.inspection.sha256, slot:'outfit', ...input});
    const token = context;
    if (current(token) && await refreshParts(token) && current(token)) { $('wardrobe-import').open = false; note('Select the part to preview it.'); }
    return part;
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !live) return;
    const token = context; busy = true; paint();
    try {
      const input = Object.fromEntries(['name','slot','source','license'].map(key => [key, form.elements[key].value.trim()]));
      const data_base64 = await avatarFileBase64(form.elements.file.files[0]);
      if (current(token)) await importPart({...input, data_base64});
    } catch (error) { if (current(token)) note(error.message); }
    finally { if (current(token)) { busy = false; draw(); paint(); } }
  };
  $('wardrobe-save').onclick = async () => {
    if (!live || !isCurrent() || busy || previewing || !previewValid || !selection) return;
    const token = context, ticket = version; busy = true; paint(); draw(); note();
    try {
      const next = await api({action:'select', id:row.id, sha256:row.inspection.sha256, look_id:lookId,
        expected_revision:selection.revision, part_ids:[...draft]});
      if (current(token) && ticket === version) { selection = next; dirty = false; }
    } catch (error) { if (current(token)) note(error.status === 409 ? 'Outfit changed elsewhere. Reset preview, then try again.' : error.message); }
    finally { if (current(token)) { busy = false; draw(); paint(); } }
  };
  $('wardrobe-reset').onclick = async () => {
    if (!live || !isCurrent() || busy) return;
    const token = context; busy = true; note(); paint(); draw();
    try { const next = await api({action:'selection', id:row.id, look_id:lookId}); if (current(token)) await accept(next, token); }
    catch (error) { if (current(token)) note(error.message); }
    finally { if (current(token)) { busy = false; draw(); paint(); } }
  };
  const timer = setTimer(async () => {
    if (!live || !isCurrent() || documentRef.hidden || dirty || busy || polling || previewing || !selection) return;
    const token = context; polling = true;
    try {
      const next = await api({action:'selection', id:row.id, look_id:lookId});
      if (current(token) && !dirty && !busy && next.revision !== selection.revision) await accept(next, token);
    } catch (error) { if (current(token) && !dirty) note(error.message); }
    finally { polling = false; }
  }, 2000);
  $('wardrobe-panel').hidden = false;
  void api({action:'inventory',id:row.id}).then(value => {
    if (!live || !isCurrent()) return;
    form.elements.slot.replaceChildren();
    for (const slot of value.slots) { const option=documentRef.createElement('option'); option.value=slot; option.textContent=slot; form.elements.slot.append(option); }
    form.elements.slot.value='outfit';
  }).catch(error => { if(live && isCurrent()) note(error.message); });
  return {setLook, importPart, snapshot:()=>({selection:selection?structuredClone(selection):null,dirty,busy:busy||previewing}),update:() => preview.update(), dispose() {live = false; context++; clearTimer(timer); preview.dispose();}};
}
