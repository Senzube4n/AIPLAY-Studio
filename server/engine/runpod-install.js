/** Automatic creation is journalled before its one paid POST. Recovery only reads.
 * Worker credentials stay in the vault; the account key never enters the Pod. */
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { readJSON, jsonStore, digest, jobId, readJsonCapped, TERMINAL } from './remote-common.js';
import { automaticBootstrap } from './runpod-bootstrap.js';

export async function createAutomaticInstaller({ dataDir, provider, client, getSecret, setSecret,
  bootstrap = automaticBootstrap, fetchFn = fetch, intervalMs = 5000, now = Date.now }) {
  const file = path.join(dataDir, 'runpod', 'automatic-install.json'), save = jsonStore(file);
  let state = await readJSON(file, { phase: 'none' }), busy = false;
  const snapshot = () => ({ phase: state.phase, podId: state.podId || null, name: state.name || null,
    requestId: state.requestId || null, stage: state.stage || null, error: state.error || null,
    workerConnected: !!state.workerConnected, startedAt: state.startedAt || null });
  const store = async () => save(state);
  async function review(input) {
    if (!/^NVIDIA\b.{1,150}$/.test(input.gpuTypeId || '') || !['ALL', 'SECURE', 'COMMUNITY'].includes(input.cloudType)) throw new Error('Choose a supported graphics card and provider pool.');
    const pools = input.cloudType === 'ALL' ? ['COMMUNITY', 'SECURE'] : [input.cloudType], quotes = [];
    for (const cloud of pools) {
      try {
        const quote = await provider.quote({ gpu: { id: input.gpuTypeId, count: 1 }, cloud });
        if (['LOW', 'MEDIUM', 'HIGH'].includes(quote.overallAvailability)) quotes.push({ cloud, ...quote });
      } catch (e) { if (e.code !== 'price_unknown') throw e; }
    }
    quotes.sort((a, b) => a.rate - b.rate);
    if (!quotes.length) throw new Error('This graphics card is unavailable. Review another computer.');
    return quotes[0];
  }
  async function create(input) {
    if (busy) throw new Error('An installation request is already being checked.');
    busy = true;
    try {
      const requestId = jobId(input.requestId);
      if (input.confirm !== 'CREATE PAID POD' || input.installAI !== true) throw new Error('Review and approve creation and AI installation first.');
      const choices = { name: String(input.name || '').trim(), gpuTypeId: input.gpuTypeId, cloudType: input.cloudType,
        size: Number(input.volumeInGb), rate: input.expectedPricePerHr };
      if (!choices.name || choices.name.length > 80 || /[\x00-\x1f]/.test(choices.name)
        || !/^NVIDIA\b.{1,150}$/.test(choices.gpuTypeId || '') || !['ALL', 'SECURE', 'COMMUNITY'].includes(choices.cloudType)
        || ![100, 150, 200, 300].includes(choices.size) || !Number.isFinite(choices.rate) || choices.rate <= 0)
        throw new Error('Review a supported computer configuration.');
      const signature = digest(choices);
      if (state.requestId === requestId) {
        if (state.signature !== signature) throw new Error('This request already names different computer choices.');
        return snapshot();
      }
      if (['creating', 'uncertain', 'waiting', 'connecting', 'failed'].includes(state.phase))
        throw new Error('Check the existing installation before creating another computer.');
      const c = await client();
      if (c.status().jobs.some(j => !TERMINAL.has(j.state))) throw new Error('Finish current work before creating another computer.');
      const pin = bootstrap();
      if (!pin.available) throw new Error(pin.problem);
      // Publication is verified before spending, including source-integrity mismatch.
      const published = await fetchFn(pin.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (!published.ok) throw new Error('This worker build is not published yet. Update AIPLAY before creating a computer.');
      const chunks = []; let size = 0;
      for await (const chunk of published.body) { size += chunk.length; if (size > 100000) throw new Error('Published installer exceeds its size limit.'); chunks.push(chunk); }
      const script = Buffer.concat(chunks);
      if (createHash('sha256').update(script).digest('hex') !== pin.sha256)
        throw new Error('The published installer could not be verified. Update AIPLAY before retrying.');
      const pods = await provider.listPods();
      if (pods.some(p => p.name === choices.name)) throw new Error('A computer with this name already exists. Choose it instead.');
      // Verify a concrete pool; ALL chooses the cheapest available pool, never an unreviewed fallback.
      const quote = await review(choices);
      if (!quote || Math.abs(quote.rate - choices.rate) > .000001)
        throw new Error('Availability or the estimated price changed. Review the computer price again.');
      const token = randomBytes(32).toString('hex');
      await setSecret('RUNPOD_INSTALL_TOKEN', token);
      state = { phase: 'creating', name: choices.name, requestId, signature, commit: pin.commit, startedAt: now() };
      await store(); // The next action may create a resource even if its response is lost.
      let pod;
      try {
        pod = await provider.createPod({ name: choices.name, image: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404',
          gpu: { id: choices.gpuTypeId, count: 1, minCudaVersion: '12.8' }, cloud: quote.cloud, disk: 20,
          mounts: { persistent: { size: choices.size, path: '/workspace' } }, ports: ['8787/http'],
          entrypoint: ['/bin/bash', '-lc'], cmd: [pin.command], startSsh: false, startJupyter: false,
          env: { AIPLAY_WORKER_TOKEN: token, AIPLAY_REPOSITORY: `https://github.com/${pin.repo}.git`, AIPLAY_COMMIT: pin.commit } });
      } catch {
        state.phase = 'uncertain'; state.error = 'Creation could not be confirmed. Check the existing installation; no duplicate request will be sent.';
        await store(); return snapshot();
      }
      state.podId = pod.id; state.phase = 'waiting'; await store(); return snapshot();
    } finally { busy = false; }
  }
  async function refresh() {
    if (busy || ['none', 'removed'].includes(state.phase)) return snapshot();
    busy = true;
    try {
      if (!state.podId) {
        const matches = (await provider.listPods()).filter(p => p.name === state.name);
        if (matches.length !== 1) return snapshot();
        state.podId = matches[0].id;
      }
      const pod = await provider.getPod(state.podId);
      if (pod.status === 'TERMINATED') return await retire();
      if (pod.status === 'EXITED') { state.phase = 'stopped'; state.error = null; await store(); return snapshot(); }
      if (pod.status !== 'RUNNING') { state.phase = 'waiting'; await store(); return snapshot(); }
      if (['models','ready'].includes(state.phase)) return snapshot();
      const token = await getSecret('RUNPOD_INSTALL_TOKEN');
      if (!token) throw new Error('The saved installation connection code is unavailable. Use manual connection.');
      const get = async route => {
        const response = await fetchFn(`${pod.workerUrl}${route}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('The AI service is still starting.');
        return readJsonCapped(response);
      };
      state.phase = 'connecting';
      try {
        const status = await get('/v1/install/status');
        const stages = ['source', 'runtime', 'engine', 'dependencies', 'starting', 'complete', 'failed'];
        if (status.podId !== pod.id || status.commit !== state.commit || !stages.includes(status.stage)) throw new Error('Installation identity could not be verified.');
        state.stage = status.stage;
        if (status.stage === 'failed') { state.phase = 'failed'; state.error = 'AI installation failed. Computing may still be billed. Review diagnostics or stop this computer.'; await store(); return snapshot(); }
      } catch { /* Older workers may have no installation endpoint; health still must match this build. */ }
      const health = await get('/v1/health');
      if (health.podId !== pod.id || health.installCommit !== state.commit || health.cloudManagerVersion !== 1 || !health.capabilities?.comfy)
        throw new Error('The AI service has not passed this installation’s identity and runtime checks.');
      await (await client()).connect({ url: pod.workerUrl, token });
      state.phase = 'models'; state.stage = 'complete'; state.workerConnected = true; state.error = null;
      await store(); return snapshot();
    } catch (e) {
      if (e.code === 'resource_missing' && state.podId) {
        try { if (!(await provider.listPods()).some(p => p.id === state.podId && p.status !== 'TERMINATED')) return await retire(); }
        catch { /* Uncertain inventory cannot establish removal. */ }
      }
      state.error = 'Waiting for the AI service. Computing may still be billed; check again or stop this computer.';
      await store(); return snapshot();
    } finally { busy = false; }
  }
  async function retire() {
    state.removedPodId = state.podId; state.podId = null; state.phase = 'removed';
    state.workerConnected = false; state.stage = null; state.error = 'The previous computer is no longer available; choose or create another.';
    await store(); return snapshot();
  }
  const timer = intervalMs > 0 ? setInterval(() => refresh().catch(() => {}), intervalMs) : null;
  timer?.unref();
  return { create, review, refresh, snapshot, options: () => { const p = bootstrap(); return { available: p.available, problem: p.problem || null }; }, close: () => clearInterval(timer) };
}
