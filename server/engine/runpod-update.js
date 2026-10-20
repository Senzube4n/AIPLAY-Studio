/** Guided, stopped-computer updates. Never starts compute or replaces storage. */
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { automaticBootstrap, automaticWorkerCommand } from './runpod-bootstrap.js';
import { readJSON, jsonStore, digest, jobId } from './remote-common.js';

export async function createWorkerUpdater({ dataDir, provider, computer, installer, client, fetchFn = fetch,
  bootstrap = automaticBootstrap, now = Date.now }) {
  const file = path.join(dataDir, 'runpod', 'worker-update.json'), save = jsonStore(file);
  let state = await readJSON(file, { phase: 'none' }), review = null, busy = false;
  const snapshot = () => ({ phase: state.phase, podId: state.podId || null, target: state.target || null, error: state.error || null });
  async function reconcile() {
    if (!['applying', 'uncertain'].includes(state.phase)) return snapshot();
    try {
      const startup = await provider.startup(state.podId);
      if (digest(startup.cmd) === state.commandHash && startup.settingsFingerprint === state.settingsFingerprint) {
        await installer.stageUpdate(state.podId, state.target);
        state.phase = 'staged'; state.error = null; await save(state);
      }
      // A lost PATCH may still finish later. An unchanged read never authorizes replay.
    } catch { /* Keep the durable uncertain operation bound to this computer. */ }
    return snapshot();
  }
  async function inspect() {
    await reconcile();
    const selected = computer.snapshot(), pin = bootstrap(), installation = installer.snapshot();
    const saved = state.podId === selected.podId ? snapshot() : { phase: 'none', podId: selected.podId, target: null, error: null };
    const info = { ...saved, stagedTarget: saved.target || null, selectedPodId: selected.podId, managed: !!selected.podId && installation.podId === selected.podId,
      target: pin.available ? pin.commit : null, repo: pin.available ? pin.repo : null, providerState: selected.pod?.status || null,
      current: null, verified: false, available: false };
    if (!info.managed) { info.error = 'This computer uses a manual installation. Follow the worker update guide.'; return info; }
    if (!pin.available) { info.error = pin.problem; return info; }
    if (selected.pod?.status === 'RUNNING' && !selected.providerUncertain) {
      try { const health = await client.verify(); info.current = health.installCommit; info.verified = health.podId === selected.podId && health.installCommit === pin.commit; }
      catch { info.error = 'The AI service has not connected yet. Check installation progress.'; }
    }
    info.available = selected.pod?.status === 'EXITED' && !selected.providerUncertain && !selected.operation && !['applying','uncertain'].includes(state.phase);
    return info;
  }
  async function reviewUpdate() {
    if (busy) throw Error('An AI update is already being checked.');
    busy = true;
    try {
      await reconcile();
      if (['applying','uncertain'].includes(state.phase)) throw Error('Check the previous update before making another change.');
      const selected = computer.snapshot(), installation = installer.snapshot(), pin = bootstrap();
      if (!selected.podId || installation.podId !== selected.podId) throw Error('This computer needs the manual worker update guide.');
      if (!pin.available) throw Error(pin.problem);
      return await computer.whileStopped(selected.podId, async () => {
        const startup = await provider.startup(selected.podId);
        if (startup.pod.status !== 'EXITED') throw Error('Stop the computer normally before updating its AI service.');
        const sourceHash = startup.cmd?.[0]?.match(/&& echo '([a-f0-9]{64})  \/tmp\/aiplay-automatic\.py'/)?.[1];
        const recognized = sourceHash && /^[a-f0-9]{40}$/.test(installation.commit || '') && [false,true].some(update => startup.cmd[0] === automaticWorkerCommand({ repo: pin.repo, commit: installation.commit, sha256: sourceHash, update }));
        if (startup.image !== 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404'
          || JSON.stringify(startup.entrypoint) !== JSON.stringify(['/bin/bash','-lc'])
          || !startup.hasWorkerToken || startup.repository?.toLowerCase() !== `https://github.com/${pin.repo}.git`.toLowerCase()
          || startup.cmd?.length !== 1 || !recognized
          || startup.pod.mounts.persistent?.path !== '/workspace')
          throw Error('This installation has custom startup settings. Use the manual update guide to preserve them.');
        const r = await fetchFn(pin.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw Error('This AI build is not published yet. Try again after updating AIPLAY.');
        const chunks = []; let bytes = 0;
        for await (const chunk of r.body) { bytes += chunk.length; if (bytes > 100000) throw Error('The published installer could not be verified.'); chunks.push(chunk); }
        if (createHash('sha256').update(Buffer.concat(chunks)).digest('hex') !== pin.sha256) throw Error('The published installer could not be verified.');
        const command = automaticWorkerCommand({ ...pin, update: true });
        review = { id: randomUUID(), podId: selected.podId, target: pin.commit, fingerprint: startup.fingerprint, cmd: [command], expires: now() + 300000 };
        return { id: review.id, podId: review.podId, target: review.target, current: installation.commit || null };
      });
    } finally { busy = false; }
  }
  async function apply(input) {
    if (busy) throw Error('An AI update is already being checked.');
    busy = true;
    try {
      const requestId = jobId(input.requestId);
      if (input.confirm !== 'UPDATE AI SERVICE') throw Error('Review and approve the AI service update first.');
      if (state.requestId === requestId) return await reconcile();
      await reconcile();
      if (['applying','uncertain'].includes(state.phase)) throw Error('Check the previous update before making another change.');
      if (!review || review.id !== input.reviewId || review.expires < now()) throw Error('Review the AI update again.');
      const plan = review;
      return await computer.whileStopped(plan.podId, async () => {
        const startup = await provider.startup(plan.podId);
        if (startup.pod.status !== 'EXITED' || startup.fingerprint !== plan.fingerprint) throw Error('The computer settings changed. Review the AI update again.');
        state = { phase: 'applying', podId: plan.podId, target: plan.target, requestId, commandHash: digest(plan.cmd), settingsFingerprint: startup.settingsFingerprint, error: null };
        await save(state); review = null;
        try { await provider.setStartup(plan.podId, plan.cmd); }
        catch (e) {
          state.phase = e.code === 'operation_uncertain' ? 'uncertain' : 'failed';
          state.error = state.phase === 'uncertain' ? 'Update confirmation was lost. Check again before starting.' : 'The update was refused. Review the computer before retrying.';
          await save(state); if (state.phase === 'failed') return snapshot();
        }
        return await reconcile();
      });
    } finally { busy = false; }
  }
  async function assertStartAllowed(podId) {
    await reconcile();
    if (state.podId === podId && ['applying','uncertain'].includes(state.phase)) throw Error('Confirm the pending AI update before starting this computer.');
  }
  return { inspect, review: reviewUpdate, apply, reconcile, assertStartAllowed };
}
