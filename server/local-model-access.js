/** Optional local LTX setup. No cache/env credentials, arbitrary models, URLs or paths. */
import { MODEL_BUNDLES } from '../shared/model-bundles.js';
import { authorizeLocalLtxDownload } from './models.js';
import { fetchModelFile, MODEL_PROVIDERS } from './engine/model-catalog.js';

export const LOCAL_MODEL_ACCESS_ID = 'videoLtx';
export const LOCAL_MODEL_ACCESS_KEY = MODEL_PROVIDERS.huggingface;
const BUNDLE = MODEL_BUNDLES.ltx25;
class AccessError extends Error {
  constructor(reason, message, status = 400) { super(message); this.reason = reason; this.status = status; }
}
const fail = (reason, message, status) => { throw new AccessError(reason, message, status); };
function validToken(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value) || value.trim().length < 10 || value.trim().length > 500 || !/^hf_[A-Za-z0-9_.-]+$/.test(value.trim()))
    fail('invalid-token', 'Enter a Hugging Face read token.');
  return value.trim();
}
function safeAuth(s = {}) {
  // Only the existing vault's deliberately public status, never its key value.
  const out = { set: !!s.set, usable: !!s.usable, method: s.method || null, encrypted: !!s.encrypted };
  for (const key of ['hint','said','protection','savedAt','savedHere','savedBy','where'])
    if (s[key] !== undefined) out[key] = s[key];
  return out;
}
const authSignature = a => JSON.stringify([a.set,a.usable,a.method,a.hint,a.savedAt]);

/** HEAD every immutable bundle file; no body bytes are requested or retained.
 * fetchModelFile only permits publisher/CDN HTTPS and strips bearer on redirects. */
export async function checkLocalLtxAccess(token, { fetchFn = fetch } = {}) {
  validToken(token);
  const checks = await Promise.allSettled(BUNDLE.files.map(async file => {
    let response;
    try { response = await fetchModelFile(file.url, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }, fetchFn); }
    catch { fail('network', 'Could not check Hugging Face access. Check the connection and try again.', 503); }
    try {
      if (response.status === 401) fail('unauthorized', 'Hugging Face rejected this key. Connect a valid read token.', 401);
      if (response.status === 403) fail('access-required', 'Approve access on the LTX model page for the account that owns this key, then check again.', 403);
      if (response.status === 429) fail('rate-limited', 'Hugging Face is limiting requests. Wait, then check again.', 429);
      if (!response.ok) fail('network', 'The pinned LTX files could not be reached. Try again later.', 503);
    } finally { await response.body?.cancel().catch(() => {}); }
  }));
  const rejected = checks.find(r => r.status === 'rejected');
  if (rejected) {
    if (rejected.reason instanceof AccessError) throw rejected.reason;
    fail('network','Could not check Hugging Face access. Check the connection and try again.',503);
  }
  return { state: 'granted', reason: null, message: 'This account can download the pinned LTX files.' };
}

export function createLocalModelAccessRoutes({ json, readBody, sameOriginLocalJson, models, secrets,
  modelsDir, diskFree, uiPort, enabled = () => true, fetchFn = fetch }) {
  let access = { state:'unchecked', reason:null, message:'Check access before installing.' }, checkedAuth = null;
  let operation = null, activeDownload = null;
  let installState = { state:'idle', message:null };
  async function snapshot() {
    const [stored, rows, disk] = await Promise.all([secrets.status(LOCAL_MODEL_ACCESS_KEY), models.status(), diskFree()]);
    const auth = safeAuth(stored), row = rows.find(r => r.id === LOCAL_MODEL_ACCESS_ID);
    const totalBytes = row?.totalBytes || BUNDLE.totalBytes, missingBytes = Math.max(0, totalBytes - (row?.haveBytes || 0));
    let shown = access;
    if (!auth.set || !auth.usable) shown = { state:'not-connected', reason:'credentials-missing', message:'Connect a Hugging Face read token.' };
    else if (checkedAuth && checkedAuth !== authSignature(auth)) shown = { state:'unchecked', reason:null, message:'The connected key changed. Check access again.' };
    if (operation) shown = { state:'checking', reason:null, message:'Checking Hugging Face access.' };
    const installing=!!activeDownload || !!(row?.downloading && row.progress?.state !== 'failed');
    const install=installing ? {state:installState.state==='cancelling'?'cancelling':'installing',message:null}
      : row?.ready ? {state:'ready',message:null} : installState;
    return { capability:LOCAL_MODEL_ACCESS_ID, auth, access:shown, install,
      files:{ missingBytes, totalBytes, ready:!!row?.ready }, modelsDir:modelsDir(), diskFree:disk,
      installing };
  }
  async function check() {
    const token = await secrets.get(LOCAL_MODEL_ACCESS_KEY);
    if (!token) fail('credentials-missing', 'Connect a Hugging Face read token first.', 401);
    const before=authSignature(safeAuth(await secrets.status(LOCAL_MODEL_ACCESS_KEY)));
    try {
      const granted = await checkLocalLtxAccess(token, { fetchFn });
      const currentToken=await secrets.get(LOCAL_MODEL_ACCESS_KEY), currentAuth=authSignature(safeAuth(await secrets.status(LOCAL_MODEL_ACCESS_KEY)));
      if (currentToken !== token || currentAuth !== before) fail('credentials-changed','The connected key changed during this check. Check access again.',409);
      access=granted; checkedAuth=currentAuth;
    }
    catch (error) {
      const known=error instanceof AccessError;
      access = { state:known?error.reason:'network', reason:known?error.reason:'setup-failed',
        message:known?error.message:'Could not complete LTX setup. Try again.' };
      throw error;
    }
    return token;
  }
  return async function localModelAccess(req, res, url) {
    if (url.pathname !== '/api/models/access') return false;
    if (!enabled()) { json(res,409,{error:'LTX setup is available in Full Studio with a local engine.'}); return true; }
    // Read status includes account/protection details. Protect GET as well as
    // POST from cross-origin and LAN/DNS-rebinding pages, without enabling CORS.
    const host = String(req.headers.host || '');
    const origin = req.headers.origin;
    const localHost = [`127.0.0.1:${uiPort}`,`localhost:${uiPort}`,`[::1]:${uiPort}`].includes(host);
    const ownOrigin = !origin || origin === `http://${host}`;
    if (!localHost || !ownOrigin) { json(res,403,{error:'Model access is available only from this PC’s Studio.'}); return true; }
    if (req.method === 'GET') {
      if ([...url.searchParams.keys()].some(k => k !== 'id') || (url.searchParams.has('id') && url.searchParams.get('id') !== LOCAL_MODEL_ACCESS_ID)) {
        json(res,400,{error:'Choose the local LTX setup.'}); return true;
      }
      try { json(res,200,await snapshot()); }
      catch { json(res,503,{error:'Could not read model access status.'}); }
      return true;
    }
    if (req.method !== 'POST') { json(res,405,{error:'Use GET for status or POST for setup.'}); return true; }
    if (!sameOriginLocalJson(req)) { json(res,403,{error:'Model access changes require Studio’s own local JSON request.'}); return true; }
    let input;
    try { input = await readBody(req,4096); }
    catch (error) { json(res,error?.tooBig?413:400,{error:'That model access request is too large or is not JSON.'}); return true; }
    try {
      if (!input || input.id !== LOCAL_MODEL_ACCESS_ID) fail('invalid-model','Choose the local LTX setup.');
      const allowed = { connect:['id','action','token'], forget:['id','action'], check:['id','action'], install:['id','action','acceptLicense'], cancel:['id','action'] };
      if (!Object.hasOwn(allowed,input.action) || Object.keys(input).some(k => !allowed[input.action].includes(k))) fail('invalid-request','Choose a supported LTX setup action.');
      if (input.action === 'cancel') { if(activeDownload)installState={state:'cancelling',message:null}; models.cancel(LOCAL_MODEL_ACCESS_ID); json(res,200,await snapshot()); return true; }
      if (operation || activeDownload) fail('busy','Let the current LTX operation finish or cancel its download first.',409);
      if (input.action === 'forget') {
        operation='forget';
        try { await secrets.clear(LOCAL_MODEL_ACCESS_KEY); access={state:'not-connected',reason:'credentials-missing',message:'Connect a Hugging Face read token.'}; checkedAuth=null; }
        finally { operation=null; }
        json(res,200,await snapshot()); return true;
      }
      if (input.action === 'install' && input.acceptLicense !== true) fail('license-required','Review and accept the LTX model terms first.');
      operation=input.action;
      try {
        if (input.action === 'connect') { await secrets.set(LOCAL_MODEL_ACCESS_KEY,validToken(input.token)); checkedAuth=null; }
        const token=await check();
        if (input.action === 'install') {
          const state=await snapshot();
          if (state.diskFree && state.diskFree.freeBytes < state.files.missingBytes) fail('disk-full','There is not enough free space in the models folder.',409);
          if (await secrets.get(LOCAL_MODEL_ACCESS_KEY) !== token) {
            checkedAuth=null; access={state:'unchecked',reason:'credentials-changed',message:'The connected key changed. Check access again.'};
            fail('credentials-changed','The connected key changed. Check access again.',409);
          }
          // The capability, manifest and destinations come from the server
          // catalogue. JSON cannot manufacture this opaque authorization.
          const permission=authorizeLocalLtxDownload(token,{acceptLicense:true});
          const job=models.download(LOCAL_MODEL_ACCESS_ID,{localAccess:permission});
          activeDownload=job; installState={state:'installing',message:null};
          job.then(result => { installState=result?.cancelled ? {state:'cancelled',message:'The partial download is kept. Install again to resume.'} : {state:'idle',message:null}; },
            () => { installState={state:'failed',message:'LTX installation stopped. Check the Models row, free space and other downloads, then install again to resume.'}; })
            .finally(() => { if(activeDownload===job) activeDownload=null; });
        }
      } finally { operation=null; }
      const state=await snapshot();
      json(res,input.action==='install'?(state.install.state==='failed'?409:202):200,state);
    } catch (error) {
      // Never copy a raw provider, vault or transport exception to the browser.
      const known=error instanceof AccessError;
      let state={}; try { state=await snapshot(); } catch { /* No raw status/vault diagnostics cross this boundary. */ }
      json(res,known?error.status:500,{...state,error:known?error.message:'Could not complete LTX setup. Try again.',reason:known?error.reason:'setup-failed'});
    }
    return true;
  };
}
