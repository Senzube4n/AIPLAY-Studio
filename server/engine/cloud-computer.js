/** Persistent beginner lifecycle manager. Discovery/reconciliation are read-only.
 * Creation, termination, mount replacement and automatic availability recovery are
 * deliberately outside this manager. Existing setup owns initial provisioning. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { readJSON, jsonStore, digest, TERMINAL, jobId } from './remote-common.js';
import { CloudError, resourceId } from './runpod-v2.js';

const monthStart = at => new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), 1)).toISOString();
const mounted = pod => !!(pod.mounts.persistent || pod.mounts.network?.length || pod.mounts.global?.length);
const roots = pod => [pod.mounts.persistent?.path, ...(pod.mounts.network || []).map(m => m.path), ...(pod.mounts.global || []).map(m => m.path)].filter(Boolean);
export function storagePrice(pod, volume = null, capacity = null) {
  const resourceCount = Number(!!pod.mounts.persistent) + (pod.mounts.network?.length || 0) + (pod.mounts.global?.length || 0);
  if (resourceCount > 1) return { kind: 'Multiple storage resources', allocatedGB: null,
    monthlyRunning: null, monthlyStopped: null, monthlyCurrent: null, estimate: true, priceChecked: '2026-10-14' };
  const size = capacity ?? volume?.size ?? pod.mounts.persistent?.size ?? null;
  if (pod.mounts.persistent) return { kind: 'Computer storage', allocatedGB: size, monthlyRunning: size * .10, monthlyStopped: size * .20,
    monthlyCurrent: size * (pod.status === 'EXITED' ? .20 : .10), estimate: true, priceChecked: '2026-10-14' };
  if (pod.mounts.network?.length) {
    const rate = volume?.type === 'STANDARD' && Number.isFinite(size) ? Math.min(size, 1000) * .07 + Math.max(0, size - 1000) * .05 : null;
    return { kind: 'Independent storage', allocatedGB: size, monthlyRunning: rate, monthlyStopped: rate, monthlyCurrent: rate, estimate: true, priceChecked: '2026-10-14' };
  }
  return { kind: pod.mounts.global?.length ? 'Growing storage' : 'Temporary only', allocatedGB: null,
    monthlyRunning: null, monthlyStopped: null, monthlyCurrent: null, estimate: true };
}
export function sessionEstimate(sessions, now, from = 0) {
  let total = 0;
  for (const s of sessions) {
    if (!Number.isFinite(s.rate)) continue;
    const end = s.end || now, start = Math.max(from, s.start);
    if (end > start) total += (end - start) / 3600000 * s.rate;
  }
  return total;
}

export async function createCloudComputer({ dataDir, provider, client, now = Date.now, intervalMs = 5000,
  localActivity = () => ({ active: false, queued: 0 }), setSchedulingBlocked = () => {}, cancelLocal = async () => {},
  pauseQueuedWork = async () => {}, resumeQueuedWork = async () => {}, beforeStart = async () => {} }) {
  const dir = path.join(dataDir, 'runpod');
  const state = await readJSON(path.join(dir, 'cloud-computer.json'), { version: 1, podId: null, phase: 'unconfigured',
    pod: null, worker: null, operation: null, review: null, sessions: [], alertUSD: null, minutes: 30 });
  const save = jsonStore(path.join(dir, 'cloud-computer.json'));
  if (!state.podId && state.lastRemoved) state.resourceMissing = true;
  await save(state);
  setSchedulingBlocked(state.operation?.type === 'stop' || !!state.resourceMissing);
  (await client()).setCloudStopping?.(state.operation?.type === 'stop' || !!state.resourceMissing);
  let busy = false, closed = false, storage = null, billing = null, computers = [], workerStatus = null, runtime = null, lastDiscoveryAt = 0;
  const diagnostics = async (operation, e) => appendFile(path.join(dir, 'cloud-diagnostics.jsonl'), JSON.stringify({
    at: new Date(now()).toISOString(), operation, resource: state.podId, code: e.code || 'worker_failure', status: e.status || null }) + '\n', { mode: 0o600 }).catch(() => {});
  function issue(e) { return { code: e.code || 'worker_failure', message: e instanceof CloudError ? e.message : 'The AI worker could not be verified. Check Connection setup.',
    alternatives: e.code === 'gpu_unavailable' ? ['Keep this computer and check later.', 'Back up your files before planning a move.'] : [] }; }
  function recordPod(pod) {
    state.pod = pod; state.providerCheckedAt = now(); state.providerUncertain = false;
    const last = state.sessions.at(-1);
    if (pod.status === 'RUNNING') {
      const start = Date.parse(pod.startedAt) || (!last?.end && last?.providerStart) || now();
      if (!last || last.end || last.providerStart !== start || last.rate !== pod.cost) {
        if (last && !last.end) last.end = now();
        state.sessions.push({ start: Math.max(start, last?.end || 0), providerStart: start, rate: pod.cost });
      }
    } else if (pod.status === 'EXITED' && last && !last.end) last.end = now();
  }
  function snapshot() {
    const session = state.sessions.at(-1), sessionCost = session ? sessionEstimate([session], now()) : null;
    const computeMonth = state.sessions.length ? sessionEstimate(state.sessions, now(), Date.parse(monthStart(now()))) : null;
    return { version: 1, podId: state.podId, phase: state.phase, pod: state.pod, providerCheckedAt: state.providerCheckedAt || null,
      computers, worker: workerStatus, workerPolicy: state.worker?.podId === state.podId ? state.worker : null,
      removedPodIds: state.removedPodIds || [],
      providerUncertain: !!state.providerUncertain,
      operation: state.operation ? { id: state.operation.id, type: state.operation.type, stage: state.operation.stage } : null,
      issue: state.issue || null, storage: storage || state.storagePrice || null, inventory: state.inventory || null,
      idleMinutes: state.minutes, policyPending: !!state.policyPending, alertUSD: state.alertUSD,
      spending: { sessionEstimate: sessionCost, monthlyComputeEstimate: computeMonth, source: 'Local estimate', provider: billing,
        alert: state.alertUSD !== null && sessionCost !== null && sessionCost >= state.alertUSD,
        includesStorage: false }, review: state.review, busy };
  }
  let lane = Promise.resolve();
  function run(name, fn) {
    const result = lane.then(async () => {
      busy = true;
      try { return await fn(); }
      catch (e) {
        state.issue = issue(e);
        if (['provider_unreachable', 'credentials_invalid', 'credentials_missing', 'invalid_response', 'resource_missing'].includes(e.code)) {
          state.providerUncertain = true; workerStatus = null;
        }
        await diagnostics(name, e); await save(state); throw e;
      }
      finally { busy = false; }
    });
    lane = result.catch(() => {}); return result;
  }
  async function readStorage(pod) {
    const volume = pod.mounts.network?.[0] ? await provider.volume(pod.mounts.network[0].volumeId) : null;
    storage = storagePrice(pod, volume); state.storagePrice = storage;
    return { price: storage, volume };
  }
  async function workerFor(pod) {
    const c = await client();
    // Never forward an old token to another worker or let a worker choose the billable resource.
    if (c.status().url !== pod.workerUrl) throw new CloudError('worker_not_connected', 'Connect this computer in Connection setup first.');
    const health = await c.verify();
    if (health.podId !== pod.id || health.cloudManagerVersion !== 1 || !health.capabilities?.comfy)
      throw new CloudError('worker_not_ready', 'The computer is running, but its AI worker needs setup or repair.');
    workerStatus = await c.cloud();
    if (workerStatus.podId !== pod.id) throw new CloudError('worker_mismatch', 'The saved worker belongs to another computer.');
    if (!runtime || runtime.workerId !== health.workerId || now() - runtime.at > 60000) {
      const [setup, models] = await Promise.all([c.setup(), c.models()]);
      const checkpoints = models?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
      const choices = Array.isArray(checkpoints?.[0]) ? checkpoints[0] : checkpoints?.[1]?.options || [];
      runtime = { workerId: health.workerId, at: now(), ready: !!(choices.length || setup.bundles?.some(b => b.state === 'ready')) };
    }
    workerStatus.connectionReady = true; workerStatus.generationReady = runtime.ready;
    state.worker = { podId: pod.id, minutes: workerStatus.minutes, authorized: workerStatus.authorized, available: workerStatus.available };
    const local = localActivity();
    await c.cloud('/lease', { podId: pod.id, workActive: !!(local.active || local.queued) });
    return c;
  }
  async function refreshInternal() {
    if (!state.podId) return snapshot();
    let pod;
    try { pod = await provider.getPod(state.podId); }
    catch (e) {
      if (e.code !== 'resource_missing') throw e;
      // A 404 alone can be transient. Require a complete, successful inventory too.
      computers = (await provider.listPods()).filter(p => p.status !== 'TERMINATED');
      if (computers.some(p => p.id === state.podId)) throw e;
      return retireSelection();
    }
    if (pod.status === 'TERMINATED') return retireSelection();
    recordPod(pod); await readStorage(pod);
    // Reading a stopped Pod does not establish that its retained GPU is free.
    // Keep this actionable refusal until a new review/start or selection.
    if (!(pod.status === 'EXITED' && state.issue?.code === 'gpu_unavailable' && !state.operation)) state.issue = null;
    if (state.operation?.type === 'grow') {
      if (storage.allocatedGB >= state.operation.size) { state.operation = null; state.phase = pod.status === 'EXITED' ? 'stopped' : 'running'; }
    } else if (pod.status === 'EXITED') {
      state.phase = state.operation?.type === 'start' ? 'checking_start' : 'stopped'; workerStatus = null;
      if (state.operation?.type === 'stop') state.operation = null;
    } else if (pod.status === 'RUNNING') {
      try {
        const c = await workerFor(pod);
        if (state.operation?.type === 'start') {
          await c.cloud('/resume', { podId: pod.id });
          if (state.policyPending && (workerStatus.available || state.minutes === 0)) {
            await c.cloud('/policy', { podId: pod.id, minutes: state.minutes }); state.policyPending = false;
          }
          c.setCloudStopping?.(false); setSchedulingBlocked(false);
          state.queueResumePending = true;
          workerStatus = { ...await c.cloud(), connectionReady: true, generationReady: runtime.ready }; state.operation = null;
        }
        if (!state.operation && state.queueResumePending && runtime.ready) {
          await resumeQueuedWork(); state.queueResumePending = false;
        }
        state.phase = state.operation?.type === 'stop' ? 'waiting_to_stop' : workerStatus.generationReady ? 'ready' : 'models_needed';
        if (state.operation?.type === 'stop' && !workerStatus.available && state.operation.stage !== 'sent') {
          const permit = await c.cloud('/prepare', {});
          if (permit.ready) await sendStop(pod, permit);
        }
      } catch (e) {
        workerStatus = { ready: false, error: 'AI worker unavailable' };
        state.phase = state.operation?.type === 'stop' ? 'waiting_to_stop' : 'worker_unavailable'; state.issue = issue(e);
        await diagnostics('worker_check', e);
      }
    } else { workerStatus = null; state.phase = pod.status === 'ERROR' ? 'computer_error' : pod.status === 'TERMINATED' ? 'missing' : 'starting'; }
    await save(state); return snapshot();
  }
  async function retireSelection() {
    const id = state.podId, old = state.pod;
    await pauseQueuedWork();
    await (await client()).resourceMissing?.(id, old?.workerUrl);
    state.removedPodIds = [...new Set([...(state.removedPodIds || []), id])].slice(-100);
    state.lastRemoved = { id, at: now() };
    const last = state.sessions.at(-1); if (last && !last.end) { last.end = now(); last.endEstimated = true; }
    computers = computers.filter(p => p.id !== id && p.status !== 'TERMINATED');
    state.podId = null; state.pod = null; state.worker = null; state.operation = null;
    state.review = null; state.inventory = null; state.storagePrice = null; state.policyPending = false;
    state.queueResumePending = false; state.resourceMissing = true; state.phase = 'missing'; state.providerUncertain = false;
    state.issue = { code: 'computer_removed', message: 'This computer is no longer available in your RunPod account; choose or create another.', alternatives: ['Review any separate storage and charges in RunPod.'] };
    storage = null; billing = null; workerStatus = null; runtime = null;
    (await client()).setCloudStopping?.(true); setSchedulingBlocked(true);
    await save(state); return snapshot();
  }
  async function sendStop(pod, permit) {
    if (!permit.storageVerified || permit.permit?.podId !== pod.id || permit.permit.expiresAt < now() || !roots(pod).includes(permit.permit.root))
      throw new CloudError('storage_unverified', 'Saved files could not be verified. The computer will stay running.');
    const live = await provider.getPod(pod.id);
    if (live.status === 'EXITED') { recordPod(live); state.operation = null; state.phase = 'stopped'; await save(state); return; }
    if (live.locked || !live.actions.includes('stop')) throw new CloudError('stop_unavailable', 'The provider is not allowing this computer to stop.');
    state.operation.stage = 'sent'; state.phase = 'stopping'; await save(state);
    await provider.action(pod.id, 'stop'); // Only GET reconciliation follows an uncertain response.
  }
  async function discover() {
    return run('discover', async () => {
      lastDiscoveryAt = now();
      computers = (await provider.listPods()).filter(p => p.status !== 'TERMINATED');
      state.discoveryCheckedAt = now();
      // A successful list validates the account even when there is no unique
      // computer to select. Do not retain a pre-connection credential error.
      if (!['gpu_unavailable','computer_removed'].includes(state.issue?.code)) state.issue = null;
      state.providerUncertain = false;
      if (!state.podId && !state.lastRemoved) {
        const url = (await client()).status().url;
        const connected = computers.find(p => p.workerUrl === url);
        const owned = computers.filter(p => /^AIPLAY\b/i.test(p.name));
        const picked = connected || (owned.length === 1 ? owned[0] : null);
        if (picked) state.podId = picked.id;
      }
      if (!state.podId) await save(state);
      return refreshInternal();
    });
  }
  async function select(id) {
    return run('select', async () => {
      if (state.operation) throw new CloudError('operation_pending', 'Finish checking the current change before choosing another computer.');
      const c = await client();
      if (c.status().jobs.some(j => !TERMINAL.has(j.state))) throw new CloudError('work_active', 'Finish the current work before choosing another computer.');
      const chosen = resourceId(id);
      if ((state.removedPodIds || []).includes(chosen)) throw new CloudError('resource_missing', 'Choose another computer; this saved computer is no longer available.');
      state.podId = chosen; state.lastRemoved = null; state.pod = null; state.worker = null; state.storagePrice = null;
      state.review = null; state.inventory = null; state.issue = null; runtime = null; billing = null; storage = null; workerStatus = null;
      await save(state);
      const result = await refreshInternal();
      if (state.podId && state.resourceMissing) {
        state.resourceMissing = false; c.setCloudStopping?.(false); setSchedulingBlocked(false); await save(state);
      }
      return result;
    });
  }
  async function reviewStart() {
    return run('review_start', async () => {
      const pod = await provider.getPod(resourceId(state.podId)); recordPod(pod);
      if (!mounted(pod)) throw new CloudError('storage_missing', 'This computer has temporary storage only. Set up persistent storage before starting.');
      if (pod.locked || !pod.actions.includes('start') && pod.status !== 'RUNNING') throw new CloudError('start_unavailable', 'This computer cannot be started in its current state.');
      const quote = await provider.quote(pod), stored = await readStorage(pod);
      if (quote.availability === 'NONE' && pod.status !== 'RUNNING') throw new CloudError('gpu_unavailable', 'The GPU is unavailable here. Your computer and storage have been kept.');
      if (quote.availability === 'UNKNOWN' && pod.status !== 'RUNNING') throw new CloudError('availability_unknown', 'Availability here could not be verified. Check again before starting.');
      state.review = { id: randomUUID(), at: now(), podId: pod.id, quote, storage: stored.price, signature: digest({ mounts: pod.mounts, gpu: pod.gpu, cloud: pod.cloud }) };
      state.issue = null; await save(state); return state.review;
    });
  }
  async function start(input) {
    return run('start', async () => {
      await beforeStart(state.podId);
      if (state.operation) {
        if (state.operation.id === input.requestId) return snapshot();
        throw new CloudError('operation_pending', 'A previous change is still being checked.');
      }
      jobId(input.requestId);
      const review = state.review;
      if (input.confirm !== 'START CLOUD COMPUTER' || !review || review.id !== input.reviewId || review.podId !== state.podId || now() - review.at > 120000)
        throw new CloudError('approval_required', 'Review the current price before starting.');
      const pod = await provider.getPod(state.podId), quote = await provider.quote(pod);
      if (quote.rate !== review.quote.rate || digest({ mounts: pod.mounts, gpu: pod.gpu, cloud: pod.cloud }) !== review.signature)
        throw new CloudError('price_changed', 'The price or storage changed. Review it again before starting.');
      if (quote.availability === 'NONE' && pod.status !== 'RUNNING') throw new CloudError('gpu_unavailable', 'The GPU is unavailable here. Your computer and storage have been kept.');
      if (quote.availability === 'UNKNOWN' && pod.status !== 'RUNNING') throw new CloudError('availability_unknown', 'Availability here could not be verified. Check again before starting.');
      if (pod.locked || !mounted(pod)) throw new CloudError('start_unavailable', 'Check this computer and its storage before starting.');
      if (pod.status !== 'RUNNING' && !pod.actions.includes('start')) throw new CloudError('start_unavailable', 'The provider is not allowing this computer to start.');
      state.operation = { id: input.requestId, type: 'start', stage: pod.status === 'RUNNING' ? 'connecting' : 'sent', at: now() };
      runtime = null;
      state.phase = 'starting'; state.issue = null; state.review = null; await save(state);
      if (pod.status !== 'RUNNING') {
        try { await provider.action(pod.id, 'start'); }
        catch (e) {
          if (e.code !== 'operation_uncertain') { state.operation = null; state.phase = 'stopped'; }
          else state.operation.stage = 'uncertain';
          if (e.code === 'state_conflict') throw new CloudError('gpu_unavailable', 'The GPU could not be allocated. Keep this computer and try checking later.');
          throw e;
        }
      }
      // Connect with the existing saved token only at its original endpoint.
      // A new endpoint needs an explicit token entry in the existing setup form.
      return refreshInternal();
    });
  }
  async function stop(input) {
    return run('stop', async () => {
      if (state.operation) {
        if (state.operation.id === input.requestId) return snapshot();
        throw new CloudError('operation_pending', 'A previous change is still being checked.');
      }
      jobId(input.requestId);
      const pod = await provider.getPod(resourceId(state.podId)); recordPod(pod);
      if (pod.status === 'EXITED') { state.phase = 'stopped'; await save(state); return snapshot(); }
      const c = await workerFor(pod);
      const local = localActivity();
      if (input.mode === 'idle' && (local.active || local.queued || c.status().jobs.some(j => !TERMINAL.has(j.state))))
        throw new CloudError('work_active', 'Work is active. Choose Stop After Current Job or Stop Now.');
      if (input.mode === 'after-job' && !workerStatus.available) throw new CloudError('watchdog_needed', 'Enable automatic stop first so this works even when AIPLAY closes.');
      if (input.mode === 'now' && input.confirm !== 'CANCEL WORK AND STOP') throw new CloudError('approval_required', 'Confirm cancelling active work before stopping.');
      if (!['idle', 'after-job', 'now'].includes(input.mode)) throw new CloudError('invalid_stop', 'Choose how to stop the computer.');
      setSchedulingBlocked(true); c.setCloudStopping?.(true);
      if (input.mode === 'after-job') { await pauseQueuedWork(); await c.cloud('/lease', { podId: pod.id, workActive: !!localActivity().active }); }
      if (input.mode === 'now') {
        await cancelLocal(); await c.cloud('/lease', { podId: pod.id, workActive: false });
      }
      state.operation = { id: input.requestId, type: 'stop', stage: 'preparing', at: now(), remote: workerStatus.available };
      state.phase = 'waiting_to_stop'; await save(state);
      try {
        const permit = await c.cloud('/stop', { podId: pod.id, mode: input.mode, requestId: input.requestId, confirm: input.confirm });
        if (!permit.ready && input.mode === 'idle') {
          await c.cloud('/resume', { podId: pod.id }); state.operation = null; c.setCloudStopping?.(false); setSchedulingBlocked(false);
          throw new CloudError('work_active', 'Work is active. Choose Stop After Current Job or Stop Now.');
        }
        if (permit.ready && !workerStatus.available) await sendStop(pod, permit);
      } catch (e) {
        if ([400, 403, 409, 423].includes(e.status)) {
          const remote = await c.cloud().catch(() => null);
          if (remote && !remote.pending) { state.operation = null; c.setCloudStopping?.(false); setSchedulingBlocked(false); }
        }
        if (state.operation) state.operation.stage = state.operation.stage === 'sent' ? 'sent' : 'uncertain';
        throw e;
      }
      return snapshot();
    });
  }
  async function policy(input) {
    return run('policy', async () => {
      if (![0, 15, 30, 60].includes(input.minutes)) throw new CloudError('invalid_idle', 'Choose 15, 30, 60 minutes or Disabled.');
      const pod = await provider.getPod(resourceId(state.podId));
      if (pod.status === 'EXITED' && !input.apiKey && !input.removeKey) {
        state.minutes = input.minutes; state.policyPending = true; await save(state); return snapshot();
      }
      if (pod.status !== 'RUNNING') throw new CloudError('start_first', 'Start the computer before setting up its automatic-stop key.');
      const c = await workerFor(pod);
      const result = await c.cloud('/policy', { ...input, podId: pod.id });
      state.worker = { podId: pod.id, minutes: result.minutes, authorized: result.authorized, available: result.available };
      state.minutes = result.minutes; state.policyPending = false; workerStatus = { ...result, connectionReady: true, generationReady: runtime.ready }; await save(state); return snapshot();
    });
  }
  async function reviewStorage() {
    return run('storage', async () => {
      const pod = await provider.getPod(resourceId(state.podId)); recordPod(pod); await readStorage(pod);
      if (pod.status !== 'RUNNING') throw new CloudError('start_first', 'Start the computer to review files; capacity and storage cost remain visible.');
      state.inventory = { ...await (await workerFor(pod)).cloud('/storage'), checkedAt: now() }; await save(state); return snapshot();
    });
  }
  async function clean(input) {
    return run('cleanup', async () => {
      if (state.operation) throw new CloudError('operation_pending', 'Wait for the current change before cleaning.');
      const pod = await provider.getPod(resourceId(state.podId)), c = await workerFor(pod);
      const result = await c.cloud('/cleanup', input); state.inventory = null; await save(state); return result;
    });
  }
  async function grow(input) {
    return run('capacity', async () => {
      if (state.operation) throw new CloudError('operation_pending', 'Wait for the current change before resizing.');
      const pod = await provider.getPod(resourceId(state.podId)); const current = await readStorage(pod);
      if (pod.status !== 'EXITED') throw new CloudError('stop_first', 'Stop the computer before changing capacity.');
      const size = Number(input.size);
      if (!Number.isSafeInteger(size) || size <= storage.allocatedGB || size > 4096 || storage.monthlyStopped === null)
        throw new CloudError('invalid_capacity', 'Choose a larger supported storage size.');
      const price = storagePrice(pod, current.volume, size);
      if (input.confirm !== 'INCREASE STORAGE' || input.expectedMonthly !== price.monthlyStopped)
        return { review: { allocatedGB: size, monthlyEstimate: price.monthlyStopped, estimate: true } };
      jobId(input.requestId); state.operation = { id: input.requestId, type: 'grow', stage: 'sent', size, at: now() }; await save(state);
      await provider.grow(pod, size); return refreshInternal();
    });
  }
  async function loadBilling() {
    return run('billing', async () => {
      const start = monthStart(now()), end = new Date(now()).toISOString();
      const pod = await provider.getPod(resourceId(state.podId));
      const bills = [await provider.billing(pod.id, start, end)];
      for (const mount of pod.mounts.network || []) bills.push(await provider.volumeBilling(mount.volumeId, start, end));
      if (bills.some(b => !Number.isFinite(b.metadata?.totals?.totalAmount))) throw new CloudError('billing_unknown', 'Provider billing could not be verified.');
      billing = { amount: bills.reduce((n, b) => n + b.metadata.totals.totalAmount, 0), from: start, to: end,
        checkedAt: now(), source: 'Provider reported', includesAttachedStorage: !!pod.mounts.network?.length, scope: 'Selected computer and attached network storage' };
      return snapshot();
    });
  }
  async function backup() {
    return run('backup', async () => {
      const pod = await provider.getPod(resourceId(state.podId));
      if (pod.status !== 'RUNNING') throw new CloudError('start_first', 'Start the computer to back up its outputs.');
      const c = await workerFor(pod); await c.tick();
      const jobs = c.status().jobs;
      return { completed: !jobs.some(j => !TERMINAL.has(j.state)), files: jobs.filter(j => j.state === 'completed').flatMap(j => j.outputs || []).length,
        scope: 'Tracked generation outputs' };
    });
  }
  async function alerts(input) {
    return run('alerts', async () => {
    const value = input.alertUSD === '' || input.alertUSD === null ? null : Number(input.alertUSD);
    if (value !== null && (!Number.isFinite(value) || value <= 0 || value > 100000)) throw new CloudError('invalid_alert', 'Enter a positive spending alert amount.');
    state.alertUSD = value; await save(state); return snapshot();
    });
  }
  const tick = async () => {
    if (!closed && !busy) {
      if (state.discoveryCheckedAt && now() - lastDiscoveryAt >= 30000) await discover().catch(() => {});
      else if (state.podId) await run('reconcile', refreshInternal).catch(() => {});
    }
  };
  const timer = intervalMs ? setInterval(tick, intervalMs) : null; timer?.unref();
  return { snapshot, discover, select, reviewStart, start, stop, policy, reviewStorage, clean, grow, loadBilling, backup, alerts,
    startExternal: (id, fn) => run('start', async () => { await beforeStart(id); return fn(); }),
    whileStopped: (id, fn) => run('worker_update', async () => {
      if (id !== state.podId || state.operation) throw new CloudError('update_conflict', 'Finish the current computer change before updating.');
      const pod = await provider.getPod(id);
      if (pod.status !== 'EXITED' || pod.locked || !mounted(pod)) throw new CloudError('stop_before_update', 'Stop the computer normally before updating its AI service.');
      return fn(pod);
    }),
    refresh: () => run('refresh', () => { runtime = null; return refreshInternal(); }), tick, close: () => { closed = true; if (timer) clearInterval(timer); } };
}
