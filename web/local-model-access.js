/** Optional local LTX setup. Opening or painting it never authenticates or downloads. */
const mounted = new WeakMap();
const gb = n => Number.isFinite(n) ? `${(n / 1e9).toFixed(2)} GB` : 'Unknown';
export async function requestLocalModelAccess(action, fields = {}) {
  const response = await fetch('/api/models/access' + (action ? '' : '?id=videoLtx'), action ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'videoLtx', action, ...fields }),
  } : {});
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'LTX access could not be checked.');
    if (data.capability === 'videoLtx' && data.auth && data.access) error.snapshot = data;
    throw error;
  }
  return data;
}

export function mountLocalModelAccess(root, { request = requestLocalModelAccess, changed, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!root) return null;
  if (mounted.has(root)) return mounted.get(root);
  const doc = root.ownerDocument;
  const $ = id => root.querySelector(`#${id}`);
  const controls = Object.fromEntries(['Token','Form','Connect','Forget','Check','Terms','Install','Cancel','State','Message','Saved','Storage','Protection','Total','Missing','Destination','Free','Close']
    .map(name => [name, $(`ltxAccess${name}`)]));
  let data = null, busy = false, message = '', error = false, generation = 0, downloadError = '', timer = null;
  const notify = changed || (() => doc.dispatchEvent(new Event('aiplay:local-model-refresh')));
  function paint() {
    const auth = data?.auth || {}, access = data?.access || {}, files = data?.files || {};
    const installing = data?.installing === true || data?.install?.state === 'cancelling';
    const failure = data?.install?.state === 'failed' ? data.install.message || 'Download failed; check Models, then retry.' : downloadError;
    const state = busy ? 'Working…' : files.ready ? 'Files ready' : installing ? 'Downloading' : failure ? 'Download failed' : ({
      granted: 'Access ready', unauthorized: 'Token rejected', 'access-required': 'Publisher access needed',
      network: 'Connection failed', 'rate-limited': 'Try again later', checking: 'Checking access', unchecked: 'Access unchecked', 'not-connected': 'Not connected',
    }[access.state] || 'Not connected');
    controls.State.textContent = state;
    controls.State.className = `chip ${busy || installing ? 'busy' : error || failure ? 'err' : files.ready || access.state === 'granted' ? 'ok' : 'warn'}`;
    controls.Saved.textContent = auth.set ? auth.said || `Saved token ${auth.hint || ''}` : 'No Hugging Face token saved in Studio.';
    controls.Storage.textContent = auth.set ? auth.encrypted ? 'Windows encrypted' : 'Not encrypted' : 'No token saved';
    controls.Storage.className = `chip ${auth.set && !auth.encrypted ? 'warn' : ''}`;
    controls.Protection.textContent = auth.protection || 'Storage protection is reported after connecting.';
    controls.Total.textContent = gb(files.totalBytes);
    controls.Missing.textContent = gb(files.missingBytes);
    controls.Destination.textContent = data?.modelsDir || 'Checking…';
    controls.Free.textContent = gb(data?.diskFree?.freeBytes);
    const shortOfSpace = Number.isFinite(data?.diskFree?.freeBytes) && Number.isFinite(files.missingBytes)
      && data.diskFree.freeBytes < files.missingBytes;
    controls.Message.textContent = message || (shortOfSpace ? 'Choose a model folder with more free space.' : failure || access.message || '');
    controls.Connect.disabled = busy || installing || !controls.Token.value.trim();
    controls.Token.disabled = busy || installing;
    controls.Forget.disabled = busy || installing || !auth.set;
    controls.Check.disabled = busy || installing || !auth.usable;
    controls.Install.disabled = busy || installing || files.ready || !auth.usable || access.state !== 'granted'
      || !controls.Terms.checked || shortOfSpace;
    controls.Install.textContent = failure || data?.install?.state === 'cancelled' ? 'Resume download' : 'Install LTX';
    controls.Cancel.hidden = !installing;
    controls.Cancel.disabled = busy || !installing;
    controls.Terms.disabled = busy || installing;
  }
  function schedule() {
    clearTimer(timer); timer = null;
    const visible = () => !root.hidden && !doc.hidden && !doc.getElementById('models')?.hidden;
    if (visible() && (data?.installing || data?.install?.state === 'cancelling')) {
      // This is local saved status only; it never repeats the provider check.
      timer = setTimer(() => { if (visible()) return refresh(generation); }, 2000);
      timer?.unref?.();
    }
  }
  async function act(action, fields = {}) {
    if (busy) return;
    busy = true; error = false; message = ''; ++generation; paint();
    // Clear the password before awaiting, including rejection and network failure.
    const secret = fields.token;
    controls.Token.value = '';
    try {
      data = await request(action, fields);
      if (action === 'forget') controls.Terms.checked = false;
      if (action === 'install' || action === 'cancel') notify();
    } catch (e) {
      if (e?.snapshot) data = e.snapshot;
      else if (data && ['connect', 'check', 'install'].includes(action)) data = { ...data, access: { state: 'network' } };
      message = String(e?.message || 'LTX setup failed.');
      if (secret) message = message.split(secret).join('[redacted]');
      error = true;
    } finally { busy = false; paint(); schedule(); }
  }
  async function refresh(revision) {
    try {
      const next = await request();
      if (revision !== generation) return;
      data = next; message = ''; error = false; paint();
    } catch (e) {
      if (revision !== generation) return;
      if (e?.snapshot) data = e.snapshot;
      else if (data) data = { ...data, access: { state: 'unchecked' } };
      message = String(e?.message || 'LTX setup could not be checked.'); error = true; paint();
    } finally { if (revision === generation) schedule(); }
  }
  async function show() {
    root.hidden = false;
    root.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    root.focus?.({ preventScroll: true });
    return refresh(++generation);
  }
  function hide() { ++generation; clearTimer(timer); timer = null; controls.Token.value = ''; root.hidden = true; paint(); }
  controls.Form.addEventListener('submit', event => {
    event.preventDefault();
    if (controls.Connect.disabled) return;
    const token = controls.Token.value.trim();
    act('connect', { token });
  });
  controls.Token.addEventListener('input', paint);
  controls.Terms.addEventListener('change', paint);
  controls.Check.addEventListener('click', () => { if (!controls.Check.disabled) act('check'); });
  controls.Forget.addEventListener('click', () => { if (!controls.Forget.disabled) act('forget'); });
  controls.Install.addEventListener('click', () => {
    if (!controls.Install.disabled) act('install', { acceptLicense: controls.Terms.checked === true });
  });
  controls.Cancel.addEventListener('click', () => { if (!controls.Cancel.disabled) act('cancel'); });
  controls.Close.addEventListener('click', hide);
  const controller = { show, hide, update(snapshot) {
    if (!data) return;
    const cap = snapshot.capabilities?.find(row => row.id === 'videoLtx');
    if (!cap) return;
    downloadError = cap.progress?.state === 'failed'
      ? String(cap.progress.error || cap.progress.message || 'Download failed; press Resume download to continue.') : '';
    data = { ...data, installing: cap.progress ? cap.progress.state !== 'failed' : cap.ready ? false : data.installing,
      files: { totalBytes: cap.totalBytes, missingBytes: Math.max(0, cap.totalBytes - cap.haveBytes), ready: cap.ready },
      diskFree: snapshot.disk || data.diskFree };
    if (!root.hidden) paint();
  } };
  mounted.set(root, controller); paint();
  return controller;
}

export function openLocalModelAccess(doc = globalThis.document) {
  const root = doc?.getElementById('localModelAccess');
  if (!root) return;
  doc.querySelector('.rail [data-view="models"]')?.click();
  return mountLocalModelAccess(root).show();
}
export function updateLocalModelAccess(snapshot, doc = globalThis.document) {
  const root = doc?.getElementById('localModelAccess');
  if (root) mounted.get(root)?.update(snapshot);
}
if (typeof document !== 'undefined') {
  mountLocalModelAccess(document.getElementById('localModelAccess'));
  document.addEventListener('click', event => {
    if (event.target.closest?.('[data-local-model-access="videoLtx"]')) openLocalModelAccess(document);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const field = document.getElementById('ltxAccessToken');
      if (field) field.value = '';
    }
  });
}
