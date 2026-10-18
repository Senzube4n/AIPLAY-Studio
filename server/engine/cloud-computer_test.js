import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRunpodV2, CloudError } from './runpod-v2.js';
import { createCloudComputer, storagePrice, sessionEstimate } from './cloud-computer.js';

const pod = (status = 'EXITED') => ({ id: 'pod_123', name: 'AIPLAY Music', status, actions: status === 'EXITED' ? ['start', 'terminate'] : ['stop', 'terminate'],
  gpu: { id: 'GPU', count: 1 }, cloud: 'SECURE', dataCenterId: 'EU-1', cost: status === 'EXITED' ? 0 : .5,
  mounts: { persistent: { path: '/workspace', size: 100 } }, disk: 20, locked: false, startedAt: '2026-10-14T12:00:00Z',
  workerUrl: 'https://pod_123-8787.proxy.runpod.net' });

test('saving valid credentials clears the old account error before computer selection', async t => {
  for (const computers of [[], [pod(), { ...pod(), id: 'second', workerUrl: 'https://second-8787.proxy.runpod.net' }]]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-cloud-account-'));
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aiplay-cloud-account-')));
    let connected = false, manager;
    const create = () => createCloudComputer({ dataDir: dir, intervalMs: 0,
      provider: {
        listPods: async () => { if (!connected) throw new CloudError('credentials_missing', 'Add your account key.'); return computers; },
        getPod: async () => { assert.fail('no computer has been selected'); },
        action: async () => { assert.fail('discovery must not start or stop rental'); },
      }, client: async () => ({ status: () => ({ url: '', jobs: [] }) }) });
    manager = await create();
    t.after(async () => { manager.close(); await rm(dir, { recursive: true, force: true }); });
    await assert.rejects(manager.discover(), e => e.code === 'credentials_missing');
    assert.equal(manager.snapshot().issue.code, 'credentials_missing');
    connected = true;
    const result = await manager.discover();
    assert.equal(result.podId, null);
    assert.equal(result.computers.length, computers.length);
    assert.equal(result.issue, null, 'valid account discovery clears the obsolete account failure');
    assert.equal(result.providerUncertain, false);
    manager.close(); manager = await create();
    assert.equal(manager.snapshot().issue, null, 'the repaired account state survives a restart');
  }
});
async function fixture(t, status = 'EXITED') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-cloud-'));
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aiplay-cloud-')));
  const f = { dir, pod: pod(status), now:Date.parse('2026-10-14T13:00:00Z'), actions: [], busy: false, available: true, rate: .5, availability: 'HIGH', fail: null, localActive: false, localQueued: 0, leases: [] };
  const provider = {
    listPods: async () => { if (f.listFail) throw new CloudError('provider_unreachable','Inventory unavailable'); return f.list || [f.pod]; },
    getPod: async id => { if (f.fail === 'read') throw new CloudError('provider_unreachable', 'Unavailable'); if (f.missing && id === 'pod_123') throw new CloudError('resource_missing','Not available',404); return structuredClone(f.pod); },
    quote: async () => ({ rate: f.rate, availability: f.availability }),
    action: async (id, action) => {
      f.actions.push(action);
      if (f.fail === 'timeout') throw new CloudError('operation_uncertain', 'Response lost');
      if (f.fail === 'allocation') throw new CloudError('state_conflict', 'Cannot allocate');
      if (f.fail === 'host_capacity') throw new CloudError('gpu_unavailable', 'The GPU is busy; keep this computer and check again later.', 400);
      f.pod = { ...pod(action === 'start' ? 'RUNNING' : 'EXITED'), mounts: f.pod.mounts };
      return f.pod;
    },
    grow: async (_, size) => { f.actions.push('grow'); f.pod.mounts.persistent.size = size; },
    billing: async () => ({ metadata: { totals: { totalAmount: 7.25 } } }),
    volumeBilling: async () => ({ metadata: { totals: { totalAmount: 2 } } }),
    volume: async () => { if(f.fail==='volume_missing') throw new CloudError('resource_missing','Storage missing',404); return { size: 100, type: 'STANDARD' }; },
  };
  const c = {
    resourceMissing: async (id, url) => { f.retired = { id, url }; },
    status: () => ({ url: f.pod.workerUrl, jobs: [] }),
    verify: async () => { if (f.fail === 'worker') throw new Error('Worker down'); return { workerId: 'stable', podId: f.pod.id, cloudManagerVersion: 1, capabilities: { comfy: true } }; },
    models: async () => ({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [f.noModels ? [] : ['image.safetensors']] } } } }),
    setup: async () => ({ bundles: [] }), tick: async () => {},
    cloud: async (route = '', body) => {
      if (route === '/stop') {
        if (body.mode === 'now') { assert.equal(body.confirm, 'CANCEL WORK AND STOP'); f.busy = false; }
        if (f.available && !f.busy && !f.localActive && !f.localQueued) f.pod = pod('EXITED');
      }
      if (route === '/storage') return { categories: {}, usedBytes: 0, persistence: { verified: true } };
      if (route === '/stop' || route === '/prepare') return { ready: !f.busy, storageVerified: true,
        permit: { podId: f.pod.id, root: '/workspace', expiresAt: Date.now() + 100000000000 } };
      if (route === '/lease') f.leases.push(body.workActive);
      return { podId: f.pod.id, available: f.available, authorized: true, minutes: body?.minutes ?? 30 };
    },
  };
  f.create = () => createCloudComputer({ dataDir: dir, provider, client: async () => c, now: () => f.now, intervalMs: 0,
    localActivity: () => ({ active: f.localActive, queued: f.queuePaused ? 0 : f.localQueued }), setSchedulingBlocked: value => { f.schedulingBlocked = value; },
    pauseQueuedWork: async () => { f.queuePaused = true; f.savedQueued = f.localQueued; },
    resumeQueuedWork: async () => { f.queuePaused = false; } });
  f.manager = await f.create();
  t.after(async () => { f.manager.close(); await rm(dir, { recursive: true, force: true }); });
  await f.manager.discover();
  f.approvedStart = async (requestId = randomUUID()) => {
    const review = await f.manager.reviewStart();
    return f.manager.start({ requestId, reviewId: review.id, confirm: 'START CLOUD COMPUTER' });
  };
  return f;
}

test('confirmed removal drops the ghost selection, survives restart and permits selecting a replacement', async t => {
  const f = await fixture(t); f.localQueued=2; f.missing = true; f.list = [];
  const result = await f.manager.refresh();
  assert.equal(result.podId,null); assert.equal(result.pod,null); assert.equal(result.storage,null);
  assert.equal(result.providerUncertain,false); assert.equal(result.issue.code,'computer_removed');
  assert.deepEqual(result.removedPodIds,['pod_123']); assert.equal(result.computers.length,0);
  assert.equal(f.retired.id,'pod_123'); assert.deepEqual(f.actions,[],'no provider mutations');
  assert.equal(f.savedQueued,2); assert.equal(f.schedulingBlocked,true);
  f.manager.close(); f.manager = await f.create();
  assert.equal((await f.manager.discover()).podId,null);
  const replacement = { ...pod(), id:'replacement', name:'New computer', workerUrl:'https://replacement-8787.proxy.runpod.net' };
  f.pod = replacement; f.list = [replacement];
  assert.equal((await f.manager.discover()).computers.length,1);
  const selected = await f.manager.select('replacement'); assert.equal(selected.podId,'replacement'); assert.equal(selected.issue,null);
  assert.equal(f.schedulingBlocked,false); assert.equal(f.queuePaused,true,'saved work is not silently run on a replacement');
  assert.deepEqual(f.actions,[]);
});
test('404 with incomplete or contradictory discovery keeps the existing selection; timeout never removes it', async t => {
  const f=await fixture(t); f.missing=true;
  await assert.rejects(f.manager.refresh(),e=>e.code==='resource_missing'); assert.equal(f.manager.snapshot().podId,'pod_123'); assert.equal(f.retired,undefined);
  f.listFail=true;
  await assert.rejects(f.manager.refresh(),e=>e.code==='provider_unreachable'); assert.equal(f.manager.snapshot().podId,'pod_123');
  f.listFail=false; f.fail='read'; f.list=[];
  await assert.rejects(f.manager.refresh(),e=>e.code==='provider_unreachable'); assert.equal(f.manager.snapshot().podId,'pod_123');
});
test('explicit terminated state is retired without leaving a selectable stale row', async t => {
  const f=await fixture(t); f.pod.status='TERMINATED';
  const result=await f.manager.refresh(); assert.equal(result.podId,null); assert.equal(result.computers.length,0); assert.deepEqual(f.actions,[]);
});

test('v2 contracts: pagination, auth header, action body and secret-free projection', async () => {
  const calls = [];
  const api = createRunpodV2({ getApiKey: () => 'private-key', fetchFn: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return Response.json({ ...pod('RUNNING'), env: { SECRET: 'hidden' } });
    const cursor = new URL(url).searchParams.get('cursor');
    return Response.json({ pods: [{ ...pod(), id: cursor ? 'second' : 'first', env: { SECRET: 'hidden' } }],
      pagination: { hasNextPage: !cursor, nextCursor: cursor ? null : 'next' } });
  } });
  const rows = await api.listPods(); assert.equal(rows.length, 2); assert.equal(rows[0].env, undefined);
  const started = await api.action('pod_123', 'start'); assert.equal(started.env, undefined);
  assert.equal(calls[2].url, 'https://api.runpod.io/v2/pods/pod_123/action');
  assert.deepEqual(JSON.parse(calls[2].init.body), { action: 'start' });
  assert.ok(calls.every(c => c.init.headers.Authorization === 'Bearer private-key' && !c.url.includes('private-key')));
  await assert.rejects(api.action('pod_123', 'terminate'), /Only start and stop/);
});
test('invalid credentials and API timeouts have distinct safe messages', async () => {
  for (const [fetchFn, code] of [[async () => new Response('', { status: 401 }), 'credentials_invalid'], [async () => { throw new Error('secret/raw error'); }, 'provider_unreachable']]) {
    const api = createRunpodV2({ getApiKey: () => 'key', fetchFn });
    await assert.rejects(api.getPod('pod_123'), e => e.code === code && !e.message.includes('secret'));
  }
});

test('REST v2 retained-host capacity rejection is actionable without exposing provider errors', async () => {
  const detail = 'There are not enough free GPUs on the host machine to start this pod.';
  for (const [action, message, expected] of [['start', detail, 'gpu_unavailable'], ['stop', detail, 'provider_error'],
    ['start', 'private provider diagnostics and credential details', 'provider_error']]) {
    let writes = 0;
    const api = createRunpodV2({ getApiKey: () => 'private-key', fetchFn: async () => {
      writes++; return Response.json({ title: 'Bad Request', detail: message }, { status: 400 });
    } });
    await assert.rejects(api.action('pod_123', action), e => e.code === expected && e.status === 400 && !e.message.includes(message));
    assert.equal(writes, 1, 'a rejected action is never retried automatically');
  }
});
test('starting an existing computer requires current approval and validates the AI runtime', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.start({ requestId: randomUUID() }), /Review/);
  const result = await f.approvedStart(); assert.equal(result.phase, 'ready');
  assert.deepEqual(f.actions, ['start']); assert.equal(result.worker.generationReady, true);
  const missing = await fixture(t); missing.noModels = true; missing.queuePaused = true;
  assert.equal((await missing.approvedStart()).phase, 'models_needed');
  assert.equal(missing.queuePaused, true, 'saved work waits for a usable AI runtime');
  missing.noModels = false; await missing.manager.refresh();
  assert.equal(missing.queuePaused, false, 'the approved start resumes work once models are ready');
});
test('price changes require a fresh review before any paid action', async t => {
  const f = await fixture(t), review = await f.manager.reviewStart(); f.rate = .8;
  await assert.rejects(f.manager.start({ requestId: randomUUID(), reviewId: review.id, confirm: 'START CLOUD COMPUTER' }), /price or storage changed/);
  assert.deepEqual(f.actions, []);
});
test('timeout and restart reconcile the SAME resource without retrying creation or power mutations', async t => {
  const f = await fixture(t), id = randomUUID(); f.fail = 'timeout';
  await assert.rejects(f.approvedStart(id), /Response lost/);
  f.manager.close(); f.manager = await f.create();
  await f.manager.start({ requestId: id }); assert.equal(f.actions.length, 1);
  f.fail = null; f.pod = pod('RUNNING'); await f.manager.refresh();
  assert.equal(f.manager.snapshot().phase, 'ready'); assert.equal(f.actions.length, 1);
});
test('idle stop reports stopped only after provider confirmation and retains persistent storage', async t => {
  const f = await fixture(t, 'RUNNING'); f.available = false;
  await f.manager.stop({ mode: 'idle', requestId: randomUUID() });
  assert.notEqual(f.manager.snapshot().phase, 'stopped');
  await f.manager.refresh(); assert.equal(f.manager.snapshot().phase, 'stopped');
  assert.deepEqual(f.actions, ['stop']); assert.equal(f.pod.mounts.persistent.size, 100);
});
test('finish before stop protects work, then observes remote watchdog completion', async t => {
  const f = await fixture(t, 'RUNNING'); f.busy = true;
  await assert.rejects(f.manager.stop({ mode: 'idle', requestId: randomUUID() }), /Work is active/);
  await f.manager.stop({ mode: 'after-job', requestId: randomUUID() });
  assert.equal(f.manager.snapshot().phase, 'waiting_to_stop'); assert.deepEqual(f.actions, []);
  f.busy = false; f.pod = pod('EXITED'); await f.manager.refresh();
  assert.equal(f.manager.snapshot().phase, 'stopped');
});
test('cancellation requires explicit confirmation', async t => {
  const f = await fixture(t, 'RUNNING'); f.busy = true;
  await assert.rejects(f.manager.stop({ mode: 'now', requestId: randomUUID() }), /Confirm cancelling/);
  assert.equal(f.busy, true);
  await f.manager.stop({ mode: 'now', requestId: randomUUID(), confirm: 'CANCEL WORK AND STOP' });
  assert.equal(f.busy, false);
});
test('unavailable GPU preserves the existing resource and offers non-destructive alternatives', async t => {
  const f = await fixture(t); f.availability = 'NONE';
  await assert.rejects(f.manager.reviewStart(), /GPU is unavailable/);
  assert.equal(f.manager.snapshot().issue.alternatives.length, 2); assert.deepEqual(f.actions, []);
  f.availability = 'HIGH'; f.fail = 'allocation'; await assert.rejects(f.approvedStart(), /could not be allocated/);
  assert.equal(f.pod.id, 'pod_123'); assert.equal(f.pod.mounts.persistent.size, 100);
});

test('host capacity refusal survives read-only refresh and restart without losing storage or retrying', async t => {
  const f = await fixture(t); f.fail = 'host_capacity';
  await assert.rejects(f.approvedStart(), e => e.code === 'gpu_unavailable');
  assert.equal(f.manager.snapshot().operation, null);
  assert.equal(f.manager.snapshot().phase, 'stopped');
  await f.manager.refresh();
  f.manager.close(); f.manager = await f.create();
  await f.manager.discover(); await f.manager.refresh();
  const result = f.manager.snapshot();
  assert.equal(result.issue.code, 'gpu_unavailable');
  assert.equal(result.issue.alternatives.length, 2);
  assert.equal(result.pod.id, 'pod_123'); assert.equal(result.pod.mounts.persistent.size, 100);
  assert.deepEqual(f.actions, ['start']);
  f.fail = null; await f.approvedStart();
  assert.equal(f.manager.snapshot().issue, null);
  assert.equal(f.manager.snapshot().phase, 'ready');
});
test('worker failure leaves provider running and AI unready without unsafe shutdown', async t => {
  const f = await fixture(t, 'RUNNING'); f.fail = 'worker'; await f.manager.refresh();
  assert.equal(f.manager.snapshot().pod.status, 'RUNNING'); assert.equal(f.manager.snapshot().phase, 'worker_unavailable');
  await assert.rejects(f.manager.stop({ requestId: randomUUID(), mode: 'idle' })); assert.deepEqual(f.actions, []);
});
test('restart retains storage; growth is explicit, increase-only and stopped-only', async t => {
  const f = await fixture(t);
  const review = await f.manager.grow({ size: 200 }); assert.equal(review.review.monthlyEstimate, 40);
  assert.deepEqual(f.actions, []);
  await f.manager.grow({ size: 200, expectedMonthly: 40, requestId: randomUUID(), confirm: 'INCREASE STORAGE' });
  await f.approvedStart(); assert.equal(f.pod.mounts.persistent.size, 200);
  await assert.rejects(f.manager.grow({ size: 300 }), /Stop the computer/);
});
test('storage costs distinguish stopped disks, standard network tiers and unknown prices', () => {
  assert.equal(storagePrice(pod()).monthlyStopped, 20);
  assert.equal(storagePrice({ ...pod(), mounts: { ...pod().mounts, network: [{ volumeId: 'volume1', path: '/data' }] } }).monthlyCurrent, null,
    'multiple storage resources must not display only one resource charge');
  const network = { ...pod(), mounts: { network: [{ volumeId: 'vol_1', path: '/workspace' }] } };
  assert.equal(storagePrice(network, { type: 'STANDARD', size: 1500 }).monthlyCurrent, 95);
  assert.equal(storagePrice(network, { type: 'HIGH_PERFORMANCE', size: 100 }).monthlyCurrent, null);
  assert.equal(sessionEstimate([{ start: 0, end: 3600000, rate: .5 }], 9999999), .5);
});
test('provider billing remains separate from local estimates and alerts are not caps', async t => {
  const f = await fixture(t, 'RUNNING'); await f.manager.alerts({ alertUSD: .25 });
  await f.manager.loadBilling();
  const view = f.manager.snapshot(); assert.equal(view.spending.provider.amount, 7.25);
  assert.equal(view.spending.sessionEstimate, .5); assert.equal(view.spending.alert, true); assert.deepEqual(f.actions, []);
  const onDisk = await readFile(path.join(f.dir, 'runpod/cloud-computer.json'), 'utf8'); assert.ok(!onDisk.includes('private-key'));
});

test('unknown regional availability never causes an automatic allocation or resource replacement', async t => {
  const f = await fixture(t); f.availability = 'UNKNOWN';
  await assert.rejects(f.manager.reviewStart(), /could not be verified/); assert.deepEqual(f.actions, []);
});

test('idle preferences can be saved while stopped and applied on an approved start', async t => {
  const f = await fixture(t); const saved = await f.manager.policy({ minutes: 60 });
  assert.equal(saved.policyPending, true); assert.deepEqual(f.actions, []);
  const started = await f.approvedStart(); assert.equal(started.policyPending, false); assert.equal(started.idleMinutes, 60);
});
test('desktop queue lease and enqueue gate preserve existing scheduled work before stop', async t => {
  const f = await fixture(t, 'RUNNING'); f.localActive = true; f.localQueued = 2;
  await assert.rejects(f.manager.stop({ mode: 'idle', requestId: randomUUID() }), /Work is active/);
  await f.manager.stop({ mode: 'after-job', requestId: randomUUID() });
  assert.equal(f.schedulingBlocked, true); assert.equal(f.leases.at(-1), true); assert.equal(f.pod.status, 'RUNNING');
  assert.equal(f.savedQueued, 2, 'future work is saved rather than billed before stopping');
});

test('periodic inventory sees a new replacement after removal without selecting or starting it',async t=>{
 const f=await fixture(t);f.missing=true;f.list=[];await f.manager.refresh();
 f.pod={...pod(),id:'new-pod',workerUrl:'https://new-pod-8787.proxy.runpod.net'};f.list=[f.pod];f.now+=31000;
 await f.manager.tick();assert.equal(f.manager.snapshot().computers[0].id,'new-pod');assert.equal(f.manager.snapshot().podId,null);assert.deepEqual(f.actions,[]);
});
test('missing storage does not retire a still-existing computer',async t=>{
 const f=await fixture(t);f.pod.mounts={network:[{volumeId:'separate',path:'/workspace'}]};f.fail='volume_missing';
 await assert.rejects(f.manager.refresh(),e=>e.code==='resource_missing');assert.equal(f.manager.snapshot().podId,'pod_123');assert.equal(f.retired,undefined);
});
