/** Optional local LTX setup. Opening or painting it never authenticates or downloads. */
const mounted = new WeakMap();
const gb = n => Number.isFinite(n) ? `${(n / 1e9).toFixed(2)} GB` : 'Unknown';
const pendingLogin = data => ['waiting', 'finishing', 'refreshing'].includes(data?.oauth?.state);
// The one-time authorization URL is used only for the owned popup, never saved.
const savedSnapshot = data => {
  if (!data?.oauth) return data;
  const { authorizationUrl: _url, ...oauth } = data.oauth;
  return { ...data, oauth };
};
const authorizationUrl = value => {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'huggingface.co' && !url.port
      && !url.username && !url.password && url.pathname === '/oauth/authorize' ? url.href : null;
  } catch { return null; }
};
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

export function mountLocalModelAccess(root, { request = requestLocalModelAccess, changed, setTimer = setTimeout, clearTimer = clearTimeout,
  openPopup = () => globalThis.open('about:blank', '_blank', 'popup,width=580,height=760') } = {}) {
  if (!root) return null;
  if (mounted.has(root)) return mounted.get(root);
  const doc = root.ownerDocument;
  const $ = id => root.querySelector(`#${id}`);
  const controls = Object.fromEntries(['Login','LoginCancel','Token','Form','Connect','Forget','Check','Terms','Install','Cancel','State','Message','Saved','Storage','Protection','Total','Missing','Destination','Free','Close']
    .map(name => [name, $(`ltxAccess${name}`)]));
  let data = null, busy = false, message = '', error = false, generation = 0, downloadError = '', timer = null;
  let popup = null, loginEpoch = 0, loginStarting = false, loginCancelling = false;
  const notify = changed || (() => doc.dispatchEvent(new Event('aiplay:local-model-refresh')));
  const visible = () => !root.hidden && !doc.hidden && !doc.getElementById('models')?.hidden;
  function closePopup() { try { popup?.close(); } catch {} popup = null; }
  function receive(next) {
    data = savedSnapshot(next);
    if (!pendingLogin(data)) closePopup();
  }
  function paint() {
    const auth = data?.auth || {}, access = data?.access || {}, files = data?.files || {};
    const installing = data?.installing === true || data?.install?.state === 'cancelling';
    const failure = data?.install?.state === 'failed' ? data.install.message || 'Download failed; check Models, then retry.' : downloadError;
    const loggingIn = loginStarting || pendingLogin(data), checking = access.state === 'checking';
    const locked = busy || installing || loggingIn || loginCancelling || checking;
    const loginState = ({ expired: 'Sign-in expired', cancelled: 'Sign-in cancelled', denied: 'Sign-in declined', error: 'Sign-in failed' })[data?.oauth?.state];
    const state = loginCancelling ? 'Cancelling sign-in' : loginStarting ? 'Opening sign-in' : loggingIn ? 'Finish sign-in'
      : busy ? 'Working…' : files.ready ? 'Files ready' : installing ? 'Downloading' : failure ? 'Download failed'
        : loginState && !auth.usable ? loginState : ({
      granted: 'Access ready', unauthorized: auth.kind === 'oauth' ? 'Sign-in rejected' : 'Token rejected', 'access-required': 'Publisher access needed',
      network: 'Connection failed', 'rate-limited': 'Try again later', checking: 'Checking access', unchecked: 'Access unchecked', 'not-connected': 'Not connected',
    }[access.state] || 'Not connected');
    controls.State.textContent = state;
    controls.State.className = `chip ${locked ? 'busy' : error || failure ? 'err' : files.ready || access.state === 'granted' ? 'ok' : 'warn'}`;
    controls.Saved.textContent = auth.set ? auth.kind === 'oauth' ? auth.said || 'Signed in with Hugging Face.' : auth.said || `Saved token ${auth.hint || ''}` : 'Not connected to Hugging Face.';
    controls.Storage.textContent = auth.set ? auth.encrypted ? 'Windows encrypted' : 'Not encrypted' : 'No credential saved';
    controls.Storage.className = `chip ${auth.set && !auth.encrypted ? 'warn' : ''}`;
    controls.Protection.textContent = auth.protection || 'Storage protection is reported after connecting.';
    controls.Total.textContent = gb(files.totalBytes);
    controls.Missing.textContent = gb(files.missingBytes);
    controls.Destination.textContent = data?.modelsDir || 'Checking…';
    controls.Free.textContent = gb(data?.diskFree?.freeBytes);
    const shortOfSpace = Number.isFinite(data?.diskFree?.freeBytes) && Number.isFinite(files.missingBytes)
      && data.diskFree.freeBytes < files.missingBytes;
    controls.Message.textContent = message || (shortOfSpace ? 'Choose a model folder with more free space.' : failure || access.message || data?.oauth?.message || '');
    controls.Login.disabled = locked;
    controls.Login.textContent = auth.kind === 'oauth' && auth.set ? 'Sign in again' : 'Sign in with Hugging Face';
    controls.LoginCancel.hidden = !loggingIn && !loginCancelling;
    controls.LoginCancel.disabled = loginCancelling;
    controls.Connect.disabled = locked || !controls.Token.value.trim();
    controls.Token.disabled = locked;
    controls.Forget.disabled = locked || !auth.set;
    controls.Forget.textContent = auth.kind === 'oauth' ? 'Disconnect' : 'Forget token';
    controls.Check.disabled = locked || !auth.usable;
    controls.Install.disabled = locked || files.ready || !auth.usable || access.state !== 'granted'
      || !controls.Terms.checked || shortOfSpace;
    controls.Install.textContent = failure || data?.install?.state === 'cancelled' ? 'Resume download' : 'Install LTX';
    controls.Cancel.hidden = !installing;
    controls.Cancel.disabled = busy || !installing;
    controls.Terms.disabled = locked;
  }
  function schedule() {
    clearTimer(timer); timer = null;
    if (visible() && (pendingLogin(data) || data?.access?.state === 'checking' || data?.installing || data?.install?.state === 'cancelling')) {
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
      receive(await request(action, fields));
      if (action === 'forget') controls.Terms.checked = false;
      if (action === 'install' || action === 'cancel') notify();
    } catch (e) {
      if (e?.snapshot) receive(e.snapshot);
      else if (data && ['connect', 'check', 'install'].includes(action)) data = { ...data, access: { state: 'network' } };
      message = String(e?.message || 'LTX setup failed.');
      if (secret) message = message.split(secret).join('[redacted]');
      error = true;
    } finally { busy = false; paint(); schedule(); }
  }
  async function beginLogin() {
    if (controls.Login.disabled) return;
    // Open in the click's synchronous stack, before fetch can lose user activation.
    try { popup = openPopup(); if (popup) popup.opener = null; } catch { popup = null; }
    if (!popup) {
      message = 'Allow pop-ups for Studio, then try signing in again.'; error = true; paint(); return;
    }
    const epoch = ++loginEpoch;
    ++generation; clearTimer(timer); timer = null;
    loginStarting = true; error = false; message = ''; controls.Token.value = ''; paint();
    try {
      const next = await request('login');
      if (epoch !== loginEpoch) return;
      const url = authorizationUrl(next?.oauth?.authorizationUrl);
      if (!url) throw Error('Hugging Face sign-in could not be opened. Try again.');
      data = savedSnapshot(next);
      if (!popup.closed) { popup.location.href = url; popup.focus?.(); }
    } catch (e) {
      if (epoch !== loginEpoch) return;
      if (e?.snapshot) receive(e.snapshot);
      closePopup(); message = String(e?.message || 'Hugging Face sign-in could not be opened.'); error = true;
    } finally {
      if (epoch === loginEpoch) { loginStarting = false; paint(); schedule(); }
    }
  }
  async function cancelLogin() {
    if (controls.LoginCancel.disabled || controls.LoginCancel.hidden) return;
    const epoch = ++loginEpoch;
    ++generation; clearTimer(timer); timer = null; closePopup();
    loginStarting = false; loginCancelling = true; error = false; message = '';
    data = { ...data, oauth: { state: 'cancelled', message: 'Sign-in cancelled.' } }; paint();
    try {
      const next = await request('login-cancel');
      if (epoch === loginEpoch) receive(next);
    } catch (e) {
      if (epoch !== loginEpoch) return;
      if (e?.snapshot) receive(e.snapshot);
      message = 'Sign-in could not be cancelled. Try again.'; error = true;
    } finally { if (epoch === loginEpoch) { loginCancelling = false; paint(); schedule(); } }
  }
  async function refresh(revision) {
    try {
      const next = await request();
      if (revision !== generation) return;
      receive(next); message = ''; error = false; paint();
    } catch (e) {
      if (revision !== generation) return;
      if (e?.snapshot) receive(e.snapshot);
      else if (data) data = { ...data, access: { state: 'unchecked' } };
      message = String(e?.message || 'LTX setup could not be checked.'); error = true; paint();
    } finally { if (revision === generation) schedule(); }
  }
  async function show() {
    root.hidden = false;
    root.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    root.focus?.({ preventScroll: true });
    if (loginStarting || loginCancelling) { paint(); return; }
    return refresh(++generation);
  }
  function hide() { ++generation; clearTimer(timer); timer = null; controls.Token.value = ''; root.hidden = true; paint(); }
  controls.Login.addEventListener('click', beginLogin);
  controls.LoginCancel.addEventListener('click', cancelLogin);
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
  const controller = { show, hide, visibilityChanged() {
    clearTimer(timer); timer = null;
    if (loginStarting || loginCancelling) return;
    if (visible() && (pendingLogin(data) || data?.access?.state === 'checking')) return refresh(++generation);
  }, update(snapshot) {
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
    mounted.get(document.getElementById('localModelAccess'))?.visibilityChanged();
    if (document.hidden) {
      const field = document.getElementById('ltxAccessToken');
      if (field) field.value = '';
    }
  });
}
