// Plugin management uses the same DAW actions as external MCP clients.
export function initDawPlugins({ api, get, context, addInsert, changed }) {
  const $ = id => document.getElementById(id);
  let snapshot = null, busy = false;
  const message = (text, error = false) => {
    $('pluginMessage').textContent = text;
    $('pluginMessage').classList.toggle('d-pluginerror', error);
  };
  const paint = () => {
    const host = snapshot?.host;
    $('pluginHost').textContent = busy ? 'Working…' : host?.ready ? `VST3 ready${host.version ? ` · ${host.version}` : ''}` : 'Host needs setup';
    $('pluginHost').classList.toggle('d-pluginerror', !busy && !host?.ready);
    $('pluginSetup').hidden = !!host?.ready;
    $('pluginHost').title = host?.error || 'Native VST3 audio effects for playback and export.';
    $('pluginFolders').textContent = (snapshot?.folders || []).join('\n');
    $('pluginInstallDir').textContent = snapshot?.installedDir || '';
    const h = context();
    $('pluginTarget').textContent = h ? `Insert on ${h.name}` : 'Open a project to add an effect';
    const box = $('pluginList');
    box.replaceChildren();
    for (const row of snapshot?.plugins || []) {
      const line = document.createElement('div'); line.className = 'd-pluginrow';
      const name = document.createElement('div'); name.className = 'd-pluginname';
      const title = document.createElement('strong'); title.textContent = row.label || row.name || row.path;
      const file = document.createElement('small'); file.textContent = row.path || ''; file.title = row.path || '';
      name.append(title, file);
      const state = document.createElement('span'); state.className = 'd-pluginstate';
      state.textContent = row.status === 'ready' ? 'Ready' : row.status === 'missing' ? 'Missing' : row.status === 'error' ? 'Needs attention' : 'Not checked';
      state.title = row.error || '';
      const check = document.createElement('button'); check.className = 'd-btn';
      check.textContent = row.status === 'ready' ? 'Check again' : 'Check plugin';
      check.disabled = busy || !host?.ready;
      check.onclick = () => task(async () => api({ action: 'plugin_inspect', path: row.path }), 'Plugin checked');
      const add = document.createElement('button'); add.className = 'd-btn'; add.textContent = 'Add to chain';
      add.disabled = busy || !host?.ready || row.status !== 'ready' || !h;
      add.onclick = async () => { const target = context(); if (target) await addInsert(row.id, target); };
      line.append(name, state, check, add); box.append(line);
    }
    if (!box.childElementCount) {
      const empty = document.createElement('p'); empty.className = 'd-note';
      empty.textContent = 'Install a plugin ZIP or scan a folder containing VST3 effects.'; box.append(empty);
    }
    for (const id of ['pluginScan', 'pluginInstall', 'pluginZip', 'pluginFolderAdd', 'pluginSetup']) $(id).disabled = busy;
  };
  async function refresh() {
    snapshot = await get('/api/daw/plugins'); paint(); changed(); return snapshot;
  }
  async function task(fn, success) {
    if (busy) return;
    busy = true; message(''); paint();
    try { await fn(); await refresh(); message(success); }
    catch (err) { message(err.message, true); }
    finally { busy = false; paint(); }
  }
  $('pluginScan').onclick = () => task(() => api({ action: 'plugin_scan', refresh: true }), 'Scan complete');
  $('pluginSetup').onclick = () => task(() => api({ action: 'plugin_setup' }), 'Host ready');
  $('pluginFolderAdd').onclick = () => {
    const folder = $('pluginFolderPath').value.trim();
    if (!folder) return message('Enter a plugin folder.', true);
    task(() => api({ action: 'plugin_scan', folders: [...(snapshot?.configuredFolders || []), folder], refresh: true }), 'Folder added');
  };
  $('pluginInstall').onclick = () => {
    const path = $('pluginSource').value.trim();
    if (!path) return message('Enter a ZIP or VST3 path.', true);
    task(() => api({ action: 'plugin_install', path }), 'Installed. Check the plugin to enable it.');
  };
  $('pluginZip').onclick = () => $('pluginUpload').click();
  $('pluginUpload').onchange = () => {
    const file = $('pluginUpload').files[0]; $('pluginUpload').value = '';
    if (!file) return;
    task(async () => {
      const response = await fetch(`/api/daw/plugins/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
      const result = await response.json(); if (!response.ok || result.error) throw new Error(result.error || 'Plugin installation failed.');
    }, 'Installed. Check the plugin to enable it.');
  };
  return {
    refresh,
    contextChanged: paint,
    ready: () => snapshot?.host?.ready ? (snapshot.plugins || []).filter(p => p.status === 'ready' && p.id) : [],
  };
}
