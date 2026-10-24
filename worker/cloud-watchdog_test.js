import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createCloudWatchdog } from './cloud-watchdog.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWorker } from './runpod-worker.js';
import { cloudWorkerFiles, packageCloudWorker } from '../scripts/package-cloud-worker.mjs';
import { gunzipSync } from 'node:zlib';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-cloud-watchdog-'));
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aiplay-cloud-watchdog-')));
  const f = { at: 1, busy: false, known: true, persisted: true, calls: [], key: null, status: 'RUNNING', timeout: false, cancelled: 0 };
  const create = () => createCloudWatchdog({ stateDir: dir, podId: 'pod1', now: () => f.at, intervalMs: 0,
    activity: async () => ({ known: f.known, busy: f.busy }),
    persist: async () => { if (!f.persisted) throw new Error('Outputs not persisted'); return { verified: true, root: '/workspace' }; },
    cancelWork: async () => { f.cancelled++; f.busy = false; },
    getSecret: async () => f.key, setSecret: async key => { f.key = key; },
    fetchFn: async (url, init) => {
      f.calls.push({ url, method: init.method, body: init.body });
      if (init.method === 'POST') { if (f.timeout) throw new Error('Timeout'); if (f.rejectWrite) return new Response('{}', { status: 403 }); f.status = 'EXITED'; }
      return Response.json({ id: 'pod1', status: f.status, actions: ['stop'], cost: .5, mounts: { persistent: { path: '/workspace', size: 100 } } });
    } });
  f.watchdog = await create(); f.create = create; f.dir = dir;
  f.enable = async minutes => f.watchdog.configure({ podId: 'pod1', minutes, apiKey: 'separate-restricted-stop-key', confirm: 'SAVE REMOTE STOP KEY' });
  t.after(async () => { f.watchdog.close(); await rm(dir, { recursive: true, force: true }); });
  return f;
}
test('idle options/default, explicit credential enrollment and no secret returned', async t => {
  const f = await fixture(t); assert.equal(f.watchdog.snapshot().minutes, 30); assert.equal(f.watchdog.snapshot().authorized, false);
  await assert.rejects(f.watchdog.configure({ podId: 'pod1', minutes: 15 }), /separate automatic-stop key/);
  await f.enable(30); assert.ok(!JSON.stringify(f.watchdog.snapshot()).includes(f.key));
  const file = await readFile(path.join(f.dir, 'cloud-policy.json'), 'utf8'); assert.ok(!file.includes(f.key));
  for (const minutes of [0, 15, 30, 60]) await f.watchdog.configure({ podId: 'pod1', minutes });
  await assert.rejects(f.watchdog.configure({ podId: 'pod1', minutes: 1 }));
});

test('read-only cloud status reports meaningful work without renewing the idle policy or changing resources',async t=>{
 const f=await fixture(t),before=f.watchdog.snapshot().lastActivity;
 f.at+=60000;f.busy=true;const active=await f.watchdog.status();assert.equal(active.workload.busy,true);assert.equal(active.workload.known,true);
 assert.equal(f.watchdog.snapshot().lastActivity,before);assert.equal(f.calls.length,0);assert.equal(f.cancelled,0);
 f.known=false;assert.equal((await f.watchdog.status()).workload.known,false);
});
test('idle shutdown is remote and survives desktop disconnection and worker restart', async t => {
  const f = await fixture(t); await f.enable(30);
  f.watchdog.close(); f.watchdog = await f.create();
  f.at += 31 * 60000; await f.watchdog.tick();
  assert.equal(f.status, 'EXITED'); assert.equal(f.watchdog.snapshot().computeStopped, true);
  assert.deepEqual(JSON.parse(f.calls.find(c => c.method === 'POST').body), { action: 'stop' });
});
test('generation, queued work, downloads, transfers and unknown activity veto automatic stopping', async t => {
  const f = await fixture(t); await f.enable(15);
  for (const kind of ['generation', 'queued', 'download', 'transfer', 'update']) {
    f.busy = true; f.at += 16 * 60000; await f.watchdog.tick(); assert.equal(f.status, 'RUNNING', kind);
  }
  f.busy = false; f.known = false; f.at += 16 * 60000; await f.watchdog.tick(); assert.equal(f.status, 'RUNNING');
  f.known = true; f.at += 16 * 60000; await f.watchdog.tick(); assert.equal(f.status, 'EXITED');
});
test('finish-after-job intent persists; disconnect never cancels generation', async t => {
  const f = await fixture(t); await f.enable(30); f.busy = true;
  await f.watchdog.requestStop({ podId: 'pod1', mode: 'after-job', requestId: randomUUID() });
  f.at += 60 * 60000; await f.watchdog.tick(); assert.equal(f.cancelled, 0); assert.equal(f.status, 'RUNNING');
  f.busy = false; await f.watchdog.tick(); assert.equal(f.status, 'EXITED');
});
test('confirmed cancellation is required; duplicate stop IDs do not cancel work twice', async t => {
  const f = await fixture(t); f.busy = true;
  await assert.rejects(f.watchdog.requestStop({ podId: 'pod1', mode: 'now' }), /Confirm/);
  assert.equal(f.cancelled, 0);
  const input = { podId: 'pod1', mode: 'now', requestId: randomUUID(), confirm: 'CANCEL WORK AND STOP' };
  await f.watchdog.requestStop(input); await f.watchdog.requestStop(input); assert.equal(f.cancelled, 1);
});
test('unsaved outputs veto normal stop and automatic stop', async t => {
  const f = await fixture(t); await f.enable(15); f.persisted = false; f.at += 16 * 60000;
  await f.watchdog.tick(); assert.equal(f.status, 'RUNNING'); assert.equal(f.watchdog.snapshot().error, 'Outputs not persisted');
  assert.ok(!f.calls.some(c => c.method === 'POST'));
});
test('uncertain stop is journalled and reconciled without automatic retries', async t => {
  const f = await fixture(t); await f.enable(15); f.timeout = true; f.at += 16 * 60000;
  await f.watchdog.tick(); await f.watchdog.tick(); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  f.status = 'EXITED'; await f.watchdog.tick(); assert.equal(f.watchdog.snapshot().computeStopped, true);
});
test('the stop key cannot be pointed at a different computer', async t => {
  const f = await fixture(t);
  await assert.rejects(f.watchdog.configure({ podId: 'other', minutes: 30, apiKey: 'key', confirm: 'SAVE REMOTE STOP KEY' }));
  await assert.rejects(f.watchdog.requestStop({ podId: 'other', mode: 'idle' })); assert.equal(f.calls.length, 0);
});

test('desktop queue lease protects preprocessing and expires without interrupting remote generation', async t => {
  const f = await fixture(t); await f.enable(15);
  await f.watchdog.lease({ podId: 'pod1', workActive: true });
  await f.watchdog.requestStop({ podId: 'pod1', mode: 'after-job', requestId: randomUUID() });
  await f.watchdog.tick(); assert.equal(f.status, 'RUNNING'); assert.equal(f.watchdog.accepting(), true);
  f.at += 91000; f.busy = true; await f.watchdog.tick(); assert.equal(f.status, 'RUNNING');
  f.busy = false; await f.watchdog.tick(); assert.equal(f.status, 'EXITED');
});

test('authenticated worker HTTP checks external queues and maintenance; unconfirmed stop does not cancel', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-cloud-http-'));
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aiplay-cloud-http-')));
  const token = 'this-is-a-test-worker-token-1234567890', stateDir = path.join(dir, 'state');
  let queued = true, externalTraining = false;
  const aceCalls = [];
  const worker = await createWorker({ token, comfyURL: 'http://127.0.0.1:1234', aceURL: 'http://127.0.0.1:1235',
    inputDir: path.join(dir, 'input'), outputDir: path.join(dir, 'output'), modelsDir: path.join(dir, 'models'), stateDir,
    persistentRoot: dir, podId: 'pod1', pollMs: 1000000, cloudIntervalMs: 0,
    verifyPersistence: async () => ({ verified: true, root: dir }),
    fetchFn: async (url, init) => {
      const u = new URL(url);
      if (u.port === '1235') aceCalls.push({ route: u.pathname, method: init?.method || 'GET' });
      if (u.pathname === '/system_stats') return Response.json({ system: {}, devices: [] });
      if (u.pathname === '/health') return Response.json({ status: 'ok' });
      if (u.pathname === '/v1/training/status') return Response.json({ is_training: externalTraining });
      if (u.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: queued ? [[0, 'external']] : [] });
      return new Response('{}', { status: 404 });
    } });
  await new Promise(resolve => worker.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await worker.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${worker.server.address().port}`;
  const call = (route, body) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await fetch(base + '/v1/cloud')).status, 401);
  assert.equal((await call('/v1/custom-models')).status, 404);
  for (const action of ['create', 'prepare', 'check', 'start', 'stop', 'delete'])
    assert.equal((await call('/v1/custom-models', { action, id: randomUUID() })).status, 404, action);
  assert.equal((await call(`/v1/custom-models/${randomUUID()}/files?name=sample.wav`, {})).status, 404);
  const blocked = await (await call('/v1/cloud/prepare', {})).json(); assert.equal(blocked.ready, false); assert.equal(blocked.workload.queued, 1);
  const denied = await call('/v1/cloud/stop', { podId: 'pod1', mode: 'now' }); assert.equal(denied.status, 400); assert.equal(queued, true);
  queued = false; await writeFile(path.join(stateDir, 'maintenance.lock'), 'updating');
  const update = await (await call('/v1/cloud/prepare', {})).json(); assert.equal(update.ready, false); assert.equal(update.workload.maintenance, true);
  await rm(path.join(stateDir, 'maintenance.lock'));
  externalTraining = true;
  const training = await (await call('/v1/cloud/prepare', {})).json(); assert.equal(training.ready, false); assert.equal(training.workload.training, true);
  const foreign = await call('/v1/cloud/stop', { podId: 'pod1', mode: 'now', confirm: 'CANCEL WORK AND STOP' });
  assert.equal(foreign.status, 400); assert.equal(externalTraining, true, 'foreign training is not cancelled');
  externalTraining = false;
  const idle = await (await call('/v1/cloud/prepare', {})).json(); assert.equal(idle.ready, true); assert.equal(idle.storageVerified, true);
  await call('/v1/cloud/resume', { podId: 'pod1' });
  // Stop after the current job leaves future recipes queued on persistent
  // storage; neither the job pump nor workload checks should drain them.
  const futureId = randomUUID();
  worker.state.jobs[futureId] = { id: futureId, state: 'queued', graph: {}, outputs: [], createdAt: Date.now() };
  const finish = await (await call('/v1/cloud/stop', { podId: 'pod1', mode: 'after-job', requestId: randomUUID() })).json();
  assert.equal(finish.ready, true);
  await worker.tick();
  assert.equal(worker.state.jobs[futureId].state, 'queued');
  await call('/v1/cloud/resume', { podId: 'pod1' });
  await worker.tick();
  assert.equal(worker.state.jobs[futureId].state, 'failed', 'resuming lets the pump validate the saved recipe');
  const health = await (await call('/v1/health')).json(); assert.equal(health.cloudManagerVersion, 1); assert.equal(health.podId, 'pod1');
  assert.deepEqual(health.capabilities, { comfy: true });
  assert.ok(aceCalls.some(c => c.route === '/v1/training/status'));
  assert.ok(aceCalls.every(c => c.method === 'GET' && ['/health', '/v1/training/status'].includes(c.route)),
    'shutdown observation never calls a training mutation or preprocessing endpoint');
});

test('ACE observation fails closed on outages after restart, malformed status and unresolved legacy training', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-ace-observer-'));
  const stateDir = path.join(dir, 'state'), trainingDir = path.join(dir, 'existing-private-training');
  const token = 'read-only-ace-observer-test-token-1234567890', aceCalls = [];
  let health = 'absent', status = { is_training: false }, worker;
  const create = async () => {
    worker = await createWorker({ token, comfyURL: 'http://127.0.0.1:1234', aceURL: 'http://127.0.0.1:1235', trainingDir,
      inputDir: path.join(dir, 'input'), outputDir: path.join(dir, 'output'), modelsDir: path.join(dir, 'models'), stateDir,
      persistentRoot: dir, podId: 'pod1', pollMs: 1000000, cloudIntervalMs: 0,
      verifyPersistence: async () => ({ verified: true, root: dir }),
      fetchFn: async (url, init) => {
        const u = new URL(url);
        if (u.port === '1234') return Response.json(u.pathname === '/queue' ? { queue_running: [], queue_pending: [] } : { system: {}, devices: [] });
        aceCalls.push({ route: u.pathname, method: init?.method || 'GET' });
        if (health === 'refused') throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
        if (health === 'timeout') throw new Error('timeout');
        if (u.pathname === '/health') return health === 'absent' ? new Response('{}', { status: 404 }) : Response.json({ status: 'ok' });
        if (u.pathname === '/v1/training/status') return Response.json(status);
        throw new Error('Unexpected upstream route');
      } });
    await new Promise(resolve => worker.server.listen(0, '127.0.0.1', resolve));
    return async (route = '/v1/cloud/prepare', body = {}) => (await fetch(`http://127.0.0.1:${worker.server.address().port}${route}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
  };
  t.after(async () => { await worker?.close(); await rm(dir, { recursive: true, force: true }); });
  let call = await create();
  assert.equal((await call()).ready, true, 'a worker without ACE can stop normally');
  await call('/v1/cloud/resume', { podId: 'pod1' });
  health = 'timeout'; assert.equal((await call()).workload.known, false, 'an unclassified first outage is not absence');
  health = 'ready'; status = { is_training: true };
  assert.equal((await call()).workload.training, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, 'ace-activity.json'), 'utf8')), { seen: true });
  await worker.close(); call = await create();
  health = 'refused'; const lost = await call(); assert.equal(lost.ready, false); assert.equal(lost.workload.known, false);
  health = 'ready'; status = { is_training: 'false' }; assert.equal((await call()).workload.known, false);
  status = { data: { is_training: false } }; assert.equal((await call()).ready, true);
  await call('/v1/cloud/resume', { podId: 'pod1' });
  await mkdir(trainingDir, { recursive: true });
  const legacy = JSON.stringify({ aceSeen: true, models: { old: { stage: 'preparing' } } });
  await writeFile(path.join(trainingDir, 'models.json'), legacy);
  const unresolved = await call(); assert.equal(unresolved.ready, false); assert.equal(unresolved.workload.known, false);
  const stopped = await call('/v1/cloud/stop', { podId: 'pod1', mode: 'now', confirm: 'CANCEL WORK AND STOP' });
  assert.match(stopped.error, /Other training/);
  assert.equal(await readFile(path.join(trainingDir, 'models.json'), 'utf8'), legacy, 'historical dataset state is never adopted or rewritten');
  assert.ok(aceCalls.every(c => c.method === 'GET' && ['/health', '/v1/training/status'].includes(c.route)));
});
test('deployment archive is reproducible, self-contained and excludes credentials and model weights', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-cloud-bundle-'));
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'aiplay-cloud-bundle-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.resolve(import.meta.dirname, '..'), files = await cloudWorkerFiles(root);
  assert.ok(files.has('worker/cloud-watchdog.js')); assert.ok(files.has('server/engine/runpod-v2.js'));
  assert.ok(![...files.keys()].some(f => /secrets|worker\.env|\.safetensors|node_modules|connection\.json/.test(f)));
  const one = await packageCloudWorker(root, dir), two = await packageCloudWorker(root, dir);
  assert.equal(one.sha256, two.sha256);
  const tar = gunzipSync(await readFile(one.file)); assert.ok(tar.includes(Buffer.from('cloud-worker-manifest.json')));
});

test('definitely rejected stop waits for credential repair; uncertain outcomes remain non-retryable', async t => {
  const f = await fixture(t); await f.enable(15); f.rejectWrite = true; f.at += 16 * 60000;
  await f.watchdog.tick(); await f.watchdog.tick(); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.status, 'RUNNING'); f.rejectWrite = false; await f.enable(15);
  await f.watchdog.tick(); assert.equal(f.status, 'EXITED'); assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
});

test('acceptance worker keeps authenticated diagnostics readable but rejects new work and policy replacement after cutoff', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'aiplay-acceptance-worker-')), stateDir=path.join(dir,'state');
  await mkdir(stateDir,{recursive:true});
  const deadline={workUntil:Date.now()+60000,stopBy:Date.now()+60000+30*60000};
  // Use one timestamp; even a millisecond difference is an invalid reserve.
  deadline.stopBy=deadline.workUntil+30*60000;
  const file=path.join(stateDir,'acceptance-deadline.json');
  await writeFile(file,JSON.stringify({phase:'draining',podId:'testpod',...deadline}));
  await writeFile(path.join(stateDir,'acceptance-telemetry.json'),JSON.stringify({version:1,samples:3,observedPeaks:{gpu0UsedBytes:100}}));
  const token='acceptance-worker-token-fixture-only';
  const worker=await createWorker({token,comfyURL:'http://127.0.0.1:1234',stateDir,inputDir:path.join(dir,'input'),outputDir:path.join(dir,'output'),
    modelsDir:path.join(dir,'models'),persistentRoot:dir,podId:'testpod',acceptanceDeadline:deadline,cloudIntervalMs:0,pollMs:1000000,
    verifyPersistence:async()=>({verified:true,root:dir}),fetchFn:async()=>Response.json({queue_running:[],queue_pending:[]})});
  await new Promise(resolve=>worker.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await worker.close();await rm(dir,{recursive:true,force:true})});
  const base='http://127.0.0.1:'+worker.server.address().port;
  const call=(route,body,headers={})=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await fetch(base+'/v1/acceptance/telemetry')).status,401);
  assert.equal((await call('/v1/acceptance/telemetry',undefined,{Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await (await call('/v1/acceptance/telemetry')).json()).samples,3);
  assert.equal((await call('/v1/jobs',{id:randomUUID(),graph:{}})).status,423);
  assert.equal((await call('/v1/setup/install',{bundle:'ace15-xl-sft',acceptLicense:true})).status,423);
  assert.equal((await call('/v1/models/disk/delete',{})).status,423);
  const queuedId=randomUUID(),runningId=randomUUID();
  worker.state.jobs[queuedId]={id:queuedId,state:'queued',graph:{}};
  worker.state.jobs[runningId]={id:runningId,state:'running',promptId:'completed-or-lost',graph:{}};
  await worker.tick(); await worker.tick(); await worker.tick();
  assert.equal(worker.state.jobs[queuedId].state,'queued','a queued recipe cannot start after cutoff');
  assert.equal(worker.state.jobs[runningId].state,'uncertain','existing submissions still reconcile after cutoff');
  assert.equal((await call('/v1/cloud/policy',{apiKey:'never-accepted-key-fixture',minutes:15})).status,400);
  await call('/v1/cloud/resume',{podId:'testpod'});
  assert.equal((await call('/v1/jobs',{id:randomUUID(),graph:{}})).status,423,'resume cannot extend the supervisor deadline');
  await writeFile(file,JSON.stringify({phase:'watching'}));
  assert.notEqual((await call('/v1/jobs',{})).status,423,'ordinary validation still owns the open workload window');
  await rm(file);
  assert.equal((await call('/v1/jobs',{})).status,423,'a lost deadline journal fails closed');
});
