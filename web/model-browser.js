import { revealSetting } from './settings-sections.js';
import { appConfirm } from './dialog.js';
const $ = id => document.getElementById(id);
const size = n => Number.isFinite(n) ? `${(n / 1e9).toFixed(2)} GB` : 'Size unavailable';
let provider = 'civitai', selected = null, detail = null, onDisk = false, request = 0, busy = false, timer = null, canDownload = false;
let detailsRequest = 0, compatibilityRequest = 0, nextCursor = null, lastQuery = '', pageLoading = false;
const shown = new Set();
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
async function api(route, body) {
  const r = await fetch('/api/runpod/' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b = await r.json(); if (!r.ok) throw Error(b.error || 'The request could not be completed.'); return b;
}
function status(s, bad = false) { $('catalogStatus').textContent = s; $('catalogStatus').classList.toggle('warnhint', bad); }
function tabs() {
  for (const b of document.querySelectorAll('[data-catalog-provider]')) b.setAttribute('aria-pressed', String(!onDisk && b.dataset.catalogProvider === provider));
  $('catalogOnDisk').setAttribute('aria-pressed', String(onDisk));
  $('catalogBase').disabled = provider === 'huggingface';
  $('catalogSearchForm').hidden = onDisk; $('catalogResults').hidden = onDisk; $('catalogDisk').hidden = !onDisk;
  $('catalogMoreRow').hidden = onDisk || !nextCursor;
}
function queryParams() { return new URLSearchParams({ provider, query: $('catalogQuery').value, task: $('catalogTask').value, type: $('catalogType').value, sort: $('catalogSort').value, base: $('catalogBase').value }); }
async function search(more = false) {
  if (more && (pageLoading || !nextCursor || queryParams().toString() !== lastQuery)) return;
  const serial = ++request, cursor = more ? nextCursor : null;
  if (!more) {
    lastQuery = queryParams().toString(); nextCursor = null; shown.clear(); $('catalogResults').replaceChildren();
    ++detailsRequest; ++compatibilityRequest; detail = null; $('catalogDetail').hidden = true;
  }
  onDisk = false; tabs(); pageLoading = true; $('catalogMore').disabled = true;
  status('Searching provider…'); $('catalogResults').setAttribute('aria-busy','true');
  const params = new URLSearchParams(lastQuery); if (cursor) params.set('cursor', cursor);
  try {
    const data = await api('catalog/search?' + params); if (serial !== request) return;
    for (const model of data.items) {
      const key = `${model.provider}:${model.id}`; if (shown.has(key)) continue; shown.add(key);
      const card = el('button', null, 'catalog-card'); card.type = 'button';
      const art = el('div', null, 'catalog-art');
      if (model.image) { const image = el('img'); image.src = model.image; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', () => image.remove()); art.append(image); }
      art.append(el('span', model.type, 'catalog-kind'));
      const copy = el('div', null, 'catalog-copy'); copy.append(el('span', model.author, 'catalog-author'), el('strong', model.name), el('span', model.baseModel || model.purpose, 'hint'), el('small', `${Number(model.downloads).toLocaleString()} downloads`));
      card.append(art, copy); card.addEventListener('click', () => openModel(model)); $('catalogResults').append(card);
    }
    nextCursor = data.nextCursor && data.nextCursor !== cursor ? data.nextCursor : null; tabs();
    status(shown.size ? `${shown.size} models · review compatibility before downloading` : 'No models found. Try a different search or provider.');
  } catch(e) { if (serial === request) status(e.message, true); }
  finally { if (serial === request) { pageLoading = false; $('catalogMore').disabled = queryParams().toString() !== lastQuery; $('catalogResults').removeAttribute('aria-busy'); } }
}
async function openModel(model, version) {
  const serial = ++detailsRequest; ++compatibilityRequest; selected = model; detail = null;
  $('catalogDetail').hidden = false; $('catalogName').textContent = model.name;
  $('catalogPurpose').textContent = model.purpose || 'Review the model page for usage details.';
  $('catalogAccept').checked = false; $('catalogInstall').disabled = true; $('catalogFile').replaceChildren();
  $('catalogInstallState').textContent = 'Checking model files…';
  $('catalogCompatibility').textContent = 'Checking'; $('catalogLicense').textContent = 'Checking';
  $('catalogModelPage').removeAttribute('href'); $('catalogSize').textContent = 'Not checked';
  $('catalogFit').textContent = 'Checking compatibility'; $('catalogFit').className = 'chip busy'; $('catalogFitNote').textContent = '';
  if (!version) {
    $('catalogVersion').replaceChildren(...(model.versions.length ? model.versions.map(v => new Option(v.name,v.id)) : [new Option('Current pinned revision','')]));
    $('catalogFolder').value = /lora/i.test(model.type) ? 'loras' : 'checkpoints';
  }
  try {
    const params = new URLSearchParams({ provider: model.provider, id: model.id, ...(version ? { version } : {}) });
    const data = await api('catalog/files?' + params); if (serial !== detailsRequest) return;
    detail = data; $('catalogFile').replaceChildren(...data.files.map(f => new Option(`${f.name} · ${size(f.bytes)}`, f.id)));
    $('catalogCompatibility').textContent = data.baseModel || 'Check model card'; $('catalogLicense').textContent = data.license;
    $('catalogModelPage').href = data.url; $('catalogInstallState').textContent = data.files.length ? 'SafeTensors files with provider SHA-256 verification.' : 'No supported SafeTensors files with verified hashes are available.';
    updateFile(); checkCompatibility(); $('catalogDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); await refreshTransfers();
  } catch(e) { if (serial === detailsRequest) { $('catalogInstallState').textContent = e.message; $('catalogFit').textContent = 'Compatibility unverified'; $('catalogFit').className = 'chip warn'; } }
}
function selection() { return detail && { provider: detail.provider, id: detail.id, revision: detail.revision, version: detail.version, file: $('catalogFile').value, folder: $('catalogFolder').value }; }
function updateFile() {
  const file = detail?.files.find(f => f.id === $('catalogFile').value);
  $('catalogSize').textContent = size(file?.bytes); $('catalogDestination').textContent = `RunPod saved storage → models/${$('catalogFolder').value}`;
  $('catalogInstall').disabled = busy || !canDownload || !file || !$('catalogAccept').checked;
}
async function checkCompatibility() {
  const serial = ++compatibilityRequest, choice = selection();
  if (!choice || !choice.file) { $('catalogFit').textContent = 'Compatibility unverified'; $('catalogFit').className = 'chip'; return; }
  $('catalogFit').textContent = 'Checking compatibility'; $('catalogFit').className = 'chip busy';
  try {
    const data = await api('catalog/compatibility?' + new URLSearchParams(Object.entries(choice).filter(([,v])=>v != null)));
    if (serial !== compatibilityRequest) return;
    $('catalogFit').textContent = data.label; $('catalogFit').className = `chip ${data.state === 'works' ? 'ok' : 'warn'}`; $('catalogFitNote').textContent = data.note;
  } catch { if (serial === compatibilityRequest) { $('catalogFit').textContent = 'Compatibility unverified'; $('catalogFit').className = 'chip warn'; $('catalogFitNote').textContent = 'Check the creator’s workflow and required components.'; } }
}
async function refreshTransfers() {
  clearTimeout(timer);
  try {
    const [setup, computer] = await Promise.all([api('setup'), api('computer')]);
    const available = computer.pod?.status === 'RUNNING' && computer.worker?.connectionReady && !computer.providerUncertain && !computer.operation;
    canDownload = available && setup.catalogVersion === 1; updateFile();
    if (!available || setup.catalogVersion !== 1) { $('catalogInstall').disabled = true; $('catalogInstallState').textContent = !available ? 'Start and connect your RunPod computer to download.' : 'Update the RunPod worker to enable the model browser.'; }
    const downloads = (setup.bundles || []).filter(b => b.external);
    $('catalogTransfers').hidden = !downloads.length; $('catalogTransferList').replaceChildren();
    for (const b of downloads) { const row = el('div', null, 'catalog-transfer'); row.append(el('strong', b.label), el('span', `${b.state} · ${size(b.downloadedBytes)} / ${size(b.totalBytes)}`, 'hint')); if (b.state === 'downloading') { const p = el('progress'); p.max = b.totalBytes; p.value = b.downloadedBytes; row.append(p); } if (b.error) row.append(el('p', b.error, 'hint warnhint')); $('catalogTransferList').append(row); }
    $('catalogPause').hidden = !setup.active;
    if (setup.active && $('cloudModelBrowser').open) timer = setTimeout(refreshTransfers, 2000);
  } catch { canDownload = false; updateFile(); if (detail) $('catalogInstallState').textContent = 'Connect a running RunPod worker to download; browsing works while it is stopped.'; }
}
async function loadDisk() {
  const serial = ++request; ++detailsRequest; ++compatibilityRequest; pageLoading = false; onDisk = true; tabs(); $('catalogDetail').hidden = true; status('Reading RunPod model storage…');
  try {
    const computer = await api('computer');
    if (computer.pod?.status !== 'RUNNING' || computer.providerUncertain || !computer.worker?.connectionReady) throw Error('Start and connect your RunPod computer to view its model files.');
    const data = await api('catalog/disk'); if (serial !== request || !onDisk) return; $('catalogDiskList').replaceChildren();
    for (const f of data.files) {
      const row = el('div', null, 'catalog-disk-row'), label = el('div'); label.append(el('strong', f.relative.split('/').pop()), el('span', `${f.relative} · ${size(f.bytes)}`, 'hint'));
      const remove = el('button', 'Delete', 'edtool sm'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const plan = await api('catalog/disk/review', { relative: f.relative });
          if (!await appConfirm(`Permanently delete ${plan.relative} (${size(plan.bytes)}) from RunPod? Workflows using it will need the file again.`, { title: 'Delete model', ok: 'Delete this file' })) return;
          await api('catalog/disk/delete', { id: plan.id, confirm: 'DELETE MODEL FILE' });
          await loadDisk(); document.dispatchEvent(new Event('aiplay:cloud-computer-refresh'));
        } catch(e) { status(e.message, true); } finally { remove.disabled = false; }
      }); row.append(label, remove); $('catalogDiskList').append(row);
    }
    status(data.partial ? 'Partial file list. Open individual folders in RunPod for a complete inventory.' : `${data.files.length} model files on RunPod`);
  } catch(e) { if (serial === request && onDisk) status(/404/.test(e.message) ? 'Update the RunPod worker to manage model files.' : e.message, true); }
}
async function keyStatus() {
  try { const data = await api('catalog/connections'); for (const [p, saved] of Object.entries(data.configured)) { const chip = document.querySelector(`[data-model-key-status="${p}"]`); chip.textContent = saved ? 'Key saved' : 'Not saved'; chip.classList.toggle('ok',saved); } } catch(e) { $('catalogKeyState').textContent = e.message; }
}
async function init() {
  if (!$('cloudModelBrowser') || !$('set-model-connections')) return;
  // The catalogue routes exist only in the launcher's RunPod GPU mode.
  let mode;
  try { const r = await fetch('/api/status'); if (!r.ok) return; mode = await r.json(); } catch { return; }
  if (!mode?.config?.remoteOnly) return;
  $('set-model-connections').hidden = false;
  $('catalogResults').before($('catalogDetail'));
  $('cloudModelBrowser').addEventListener('toggle', () => { if ($('cloudModelBrowser').open && !$('catalogResults').children.length && !onDisk) search(); else if (!$('cloudModelBrowser').open) clearTimeout(timer); });
  $('catalogSearchForm').addEventListener('submit', e => { e.preventDefault(); search(); });
  $('catalogMore').addEventListener('click', () => search(true));
  for (const id of ['catalogTask','catalogType','catalogSort','catalogBase']) $(id).addEventListener('change', () => search());
  $('catalogQuery').addEventListener('input', () => { $('catalogMore').disabled = queryParams().toString() !== lastQuery; });
  for (const b of document.querySelectorAll('[data-catalog-provider]')) b.addEventListener('click', () => { provider = b.dataset.catalogProvider; search(); });
  $('catalogOnDisk').addEventListener('click', loadDisk); $('catalogDiskRefresh').addEventListener('click', loadDisk);
  $('catalogVersion').addEventListener('change', () => openModel(selected, $('catalogVersion').value));
  for (const id of ['catalogFile','catalogFolder','catalogAccept']) $(id).addEventListener('change', () => { if (id !== 'catalogAccept') { $('catalogAccept').checked = false; checkCompatibility(); } updateFile(); refreshTransfers(); });
  $('catalogDetailClose').addEventListener('click', () => { ++detailsRequest; ++compatibilityRequest; $('catalogDetail').hidden = true; });
  $('catalogPause').addEventListener('click', async () => { try { await api('setup/cancel', {}); await refreshTransfers(); } catch(e) { status(e.message,true); } });
  $('catalogInstall').addEventListener('click', async () => {
    if ($('catalogInstall').disabled) return;
    const file = detail.files.find(f => f.id === $('catalogFile').value); busy = true; updateFile();
    try { await api('catalog/install', { selection: selection(), acceptLicense: $('catalogAccept').checked, expected: { bytes: file.bytes, sha256: file.sha256 } }); $('catalogInstallState').textContent = 'Download started on RunPod.'; await refreshTransfers(); }
    catch(e) { $('catalogInstallState').textContent = e.message; }
    finally { busy = false; updateFile(); refreshTransfers(); }
  });
  $('catalogConnections').addEventListener('click', () => { document.querySelector('.rail [data-view="settings"]')?.click(); revealSetting($('set-model-connections')); $('catalogHfKey').focus(); });
  for (const form of document.querySelectorAll('[data-model-key]')) form.addEventListener('submit', async e => { e.preventDefault(); const input = form.querySelector('input'); try { await api('catalog/connections', { provider: form.dataset.modelKey, key: input.value }); input.value = ''; $('catalogKeyState').textContent = 'Key saved securely.'; await keyStatus(); } catch(e) { $('catalogKeyState').textContent = e.message; } });
  for (const b of document.querySelectorAll('[data-model-forget]')) b.addEventListener('click', async () => { try { await api('catalog/connections', { provider: b.dataset.modelForget, remove: true }); await keyStatus(); } catch(e) { $('catalogKeyState').textContent = e.message; } });
  await keyStatus();
}
if (typeof document !== 'undefined') init();
