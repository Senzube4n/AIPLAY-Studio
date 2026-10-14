/** Remote idle/finish watchdog. Desktop connectivity is deliberately not an input.
 * Unknown workload or storage state vetoes shutdown. Only a persisted user-authorized
 * policy can spend the restricted stop credential; no start/terminate operation exists. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJSON, jsonStore } from '../server/engine/remote-common.js';
import { resourceId, createRunpodV2 } from '../server/engine/runpod-v2.js';
import { appendFile } from 'node:fs/promises';

export async function createCloudWatchdog({ stateDir, podId, activity, persist, cancelWork, fetchFn = fetch,
  now = Date.now, getSecret, setSecret, intervalMs = 10000 }) {
  const state = await readJSON(path.join(stateDir, 'cloud-policy.json'), { version: 1, minutes: 30, authorized: false, pending: null, lastActivity: now() });
  const save = jsonStore(path.join(stateDir, 'cloud-policy.json'));
  if (state.podId && state.podId !== podId) { state.authorized = false; state.pending = null; }
  let busy = false, frozen = false, keyPresent = !!(await getSecret()), error = null, errorCode = null, confirmed = false;
  let prepareRun = null;
  const provider = createRunpodV2({ getApiKey: getSecret, fetchFn });
  const snapshot = () => ({ version: 1, podId: podId || null, minutes: state.minutes, authorized: state.authorized,
    available: !!podId && keyPresent, lastActivity: state.lastActivity, pending: state.pending?.mode || null,
    pendingRequestId: state.pending?.requestId || null, leaseUntil: state.desktopLeaseUntil || null, frozen, error, errorCode, computeStopped: confirmed });
  const touch = () => { state.lastActivity = now(); };
  async function configure(input) {
    if (!podId || input.podId !== podId) throw new Error('This worker does not belong to the selected cloud computer.');
    if (![0, 15, 30, 60].includes(input.minutes)) throw new Error('Choose 15, 30, 60 minutes or Disabled.');
    if (input.removeKey === true) {
      if (input.confirm !== 'REMOVE REMOTE STOP KEY' || state.pending) throw new Error('Finish the current stop and confirm removing its saved key.');
      await setSecret(null); keyPresent = false; state.authorized = false; state.minutes = 0; error = null; await save(state); return snapshot();
    }
    if (input.apiKey) {
      if (input.confirm !== 'SAVE REMOTE STOP KEY') throw new Error('Confirm saving the separate automatic-stop key on this computer.');
      const key = String(input.apiKey).trim();
      if (key.length < 20 || /[\r\n]/.test(key)) throw new Error('Enter a valid restricted RunPod key.');
      await createRunpodV2({ getApiKey: () => key, fetchFn }).getPod(podId);
      await setSecret(key); keyPresent = true;
      // A definite provider rejection can be tried again after the user repairs
      // the credential. An uncertain network result remains reconciliation-only.
      if (state.pending?.rejected) { state.pending.rejected = false; state.pending.sentAt = null; }
    }
    if (input.minutes && !keyPresent) throw new Error('Add a separate automatic-stop key to enable shutdown after AIPLAY closes.');
    state.podId = podId; state.minutes = input.minutes; state.authorized = !!input.minutes; touch(); error = null; await save(state);
    return snapshot();
  }
  async function resume(input) {
    if (input.podId !== podId) throw new Error('This worker belongs to a different cloud computer.');
    state.pending = null; state.permit = null; state.desktopLeaseUntil = 0; frozen = false; confirmed = false; error = null; touch(); await save(state);
    return snapshot();
  }
  async function prepareOnce(mode = 'idle') {
    const work = await activity();
    if (!work.known || work.busy || state.desktopLeaseUntil > now()) return { ready: false, ...snapshot(), workload: work };
    if (frozen && state.permit?.podId === podId && state.permit.expiresAt > now())
      return { ready: true, permit: state.permit, storageVerified: true, ...snapshot() };
    frozen = true;
    try {
      const storage = await persist();
      const check = await activity();
      if (!check.known || check.busy || state.desktopLeaseUntil > now()) { frozen = false; return { ready: false, ...snapshot(), workload: check }; }
      const permit = { id: randomUUID(), podId, issuedAt: now(), expiresAt: now() + 30000, root: storage.root };
      state.permit = permit; await save(state);
      return { ready: true, permit, storageVerified: true, ...snapshot() };
    } catch (e) { frozen = false; error = e.message; throw e; }
  }
  function prepare(mode = 'idle') {
    if (prepareRun) return prepareRun;
    prepareRun = prepareOnce(mode).finally(() => { prepareRun = null; });
    return prepareRun;
  }
  async function requestStop(input) {
    if (input.podId !== podId) throw new Error('Check the selected cloud computer again.');
    if (!['idle', 'after-job', 'now'].includes(input.mode)) throw new Error('Choose how to stop.');
    if (state.pending) {
      if (state.pending.requestId === input.requestId) return prepare(input.mode);
      throw new Error('A stop is already being checked.');
    }
    if (input.mode === 'now') {
      if (input.confirm !== 'CANCEL WORK AND STOP') throw new Error('Confirm cancelling active work before stopping.');
      frozen = true;
      try { await cancelWork(); } catch (e) { frozen = false; throw e; }
    }
    // A durable stop intent survives desktop disconnection; with no remote key
    // the desktop must stay open and the UI explicitly says so.
    state.pending = { mode: input.mode, requestId: input.requestId, requestedAt: now(), sentAt: null }; await save(state);
    return prepare(input.mode);
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!podId) return;
      const work = await activity();
      if (!work.known || work.busy || state.desktopLeaseUntil > now()) {
        if (!work.known) { error = 'Current workload could not be verified.'; errorCode = 'workload_unknown'; }
        else if (errorCode === 'workload_unknown') { error = null; errorCode = null; }
        touch(); await save(state); return;
      }
      if (errorCode === 'workload_unknown') { error = null; errorCode = null; }
      const due = state.pending || (state.authorized && state.minutes && now() - state.lastActivity >= state.minutes * 60000);
      if (!due || !keyPresent) return;
      if (state.pending?.rejected) { error = 'Stop needs attention. Update the stop key before trying again.'; return; }
      if (state.pending?.sentAt) {
        const pod = await provider.getPod(podId);
        if (pod.status === 'EXITED') { confirmed = true; error = null; }
        else error = 'Stop requested. Waiting for provider confirmation.';
        return; // An uncertain mutation is never automatically repeated.
      }
      const permit = await prepare();
      if (!permit.ready) return;
      const pod = await provider.getPod(podId);
      if (pod.status === 'EXITED') { confirmed = true; return; }
      if (!pod.actions.includes('stop') || pod.locked) throw new Error('The provider is not allowing this computer to stop.');
      const paths = [pod.mounts.persistent?.path, ...(pod.mounts.network || []).map(m => m.path), ...(pod.mounts.global || []).map(m => m.path)];
      if (!paths.includes(permit.permit.root)) throw new Error('Provider storage and worker storage do not match.');
      const final = await activity();
      if (!final.known || final.busy || state.desktopLeaseUntil > now()) { frozen = false; return; }
      state.pending ||= { mode: 'automatic', requestedAt: now() };
      state.pending.sentAt = now(); await save(state); // write-ahead journal, before billing mutation
      try { await provider.action(podId, 'stop'); }
      catch (e) {
        if ([400, 401, 403, 409, 422, 429].includes(e.status)) { state.pending.rejected = true; state.pending.sentAt = null; await save(state); }
        throw e;
      }
      const after = await provider.getPod(podId);
      confirmed = after.status === 'EXITED'; error = confirmed ? null : 'Stop requested. Waiting for provider confirmation.';
    } catch (e) {
      error = e.message; errorCode = e.code || 'storage_or_workload_check';
      await appendFile(path.join(stateDir, 'cloud-diagnostics.jsonl'), JSON.stringify({ at: now(), operation: 'watchdog_stop',
        code: errorCode, status: e.status || null, resource: podId }) + '\n', { mode: 0o600 }).catch(() => {});
    }
    finally { busy = false; }
  }
  const timer = intervalMs ? setInterval(() => { tick(); }, intervalMs) : null; timer?.unref();
  const lease = async input => {
    if (input.podId !== podId) throw new Error('Check the selected computer again.');
    state.desktopLeaseUntil = input.workActive === true ? now() + 90000 : 0;
    if (input.workActive === true) touch(); await save(state); return snapshot();
  };
  return { snapshot, configure, resume, prepare, requestStop, touch, tick, lease,
    accepting: () => !frozen && (!state.pending || state.pending.mode === 'after-job' && state.desktopLeaseUntil > now()),
    transferring: () => !frozen, close: () => { if (timer) clearInterval(timer); } };
}
