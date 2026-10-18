import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAutomaticInstaller } from './runpod-install.js';
import { automaticBootstrap } from './runpod-bootstrap.js';
import { CloudError } from './runpod-v2.js';

const COMMIT = 'a'.repeat(40), SCRIPT = 'verified installer';
const ID = '12345678-1234-4234-8234-123456789abc';
const input = { requestId: ID, installAI: true, confirm: 'CREATE PAID POD', name: 'AIPLAY first', gpuTypeId: 'NVIDIA test', cloudType: 'ALL', volumeInGb: 100, expectedPricePerHr: .5 };

test('completed automatic installs retire confirmed removed computers and allow a fresh reviewed creation', async t => {
  const r=await rig(t); await r.manager.create(input); await r.manager.refresh(); assert.equal(r.manager.snapshot().phase,'models');
  r.args.provider.getPod=async()=>{throw new CloudError('resource_missing','Not found',404);};
  r.rows.length=0;
  assert.equal((await r.manager.refresh()).phase,'removed'); assert.equal(r.manager.snapshot().podId,null); assert.equal(r.manager.snapshot().workerConnected,false);
  const restart=await createAutomaticInstaller(r.args);t.after(()=>restart.close()); assert.equal(restart.snapshot().phase,'removed');
  assert.equal((await restart.create(input)).phase,'removed','old request cannot create again');
  await restart.create({...input,requestId:'22345678-1234-4234-8234-123456789abc'});assert.equal(r.writes.length,2,'only an explicit new reviewed creation is allowed');
});
test('installer 404 cannot retire a computer when inventory is unavailable', async t => {
  const r=await rig(t);await r.manager.create(input);await r.manager.refresh();
  r.args.provider.getPod=async()=>{throw new CloudError('resource_missing','Not found',404);};
  r.args.provider.listPods=async()=>{throw new CloudError('provider_unreachable','Unavailable');};
  const result=await r.manager.refresh();assert.equal(result.podId,'new');assert.notEqual(result.phase,'removed');assert.equal(r.writes.length,1);
});
async function rig(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-install-'));
  const secrets = new Map(), writes = [], connections = [];
  const rows = [], pod = { id: 'new', name: input.name, status: 'RUNNING', workerUrl: 'https://new-8787.proxy.runpod.net' };
  let loseResponse = false, liveCommit = COMMIT, rate = .5, active = false;
  const provider = { listPods: async () => rows, getPod: async () => pod,
    quote: async () => ({ rate, overallAvailability: 'HIGH' }),
    createPod: async body => { writes.push(body); if (loseResponse) throw new Error('Timeout'); rows.push(pod); return pod; } };
  const client = async () => ({ status: () => ({ jobs: active ? [{ state: 'running' }] : [] }), connect: async body => { connections.push(body); } });
  const args = { dataDir, provider, client, intervalMs: 0, setSecret: async (k, v) => secrets.set(k, v), getSecret: async k => secrets.get(k),
    bootstrap: () => ({ available: true, repo: 'nemesisone-dev/AIPLAY-Studio', commit: COMMIT, url: 'https://raw.githubusercontent.com/installer', command: 'verified-command', sha256: createHash('sha256').update(SCRIPT).digest('hex') }),
    fetchFn: async url => String(url).includes('raw.githubusercontent.com') ? new Response(SCRIPT)
      : String(url).endsWith('/status') ? Response.json({ stage: 'starting', podId: 'new', commit: COMMIT })
      : Response.json({ podId: 'new', installCommit: liveCommit, cloudManagerVersion: 1, capabilities: { comfy: true } }), ...options };
  const manager = await createAutomaticInstaller(args);
  t.after(async () => { manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { manager, args, dataDir, rows, pod, secrets, writes, connections,
    lose: () => { loseResponse = true; }, wrongIdentity: () => { liveCommit = 'b'.repeat(40); }, changeRate: () => { rate = 1; }, active: () => { active = true; } };
}

test('creation sends one bounded REST v2 configuration, exposes only worker port and never the account key', async t => {
  const r = await rig(t); const first = await r.manager.create(input);
  assert.equal(first.podId, 'new'); assert.equal(first.phase, 'waiting');
  await r.manager.create(input); assert.equal(r.writes.length, 1);
  assert.deepEqual(r.writes[0].ports, ['8787/http']);
  assert.deepEqual(r.writes[0].mounts, { persistent: { size: 100, path: '/workspace' } });
  assert.equal(r.writes[0].env.RUNPOD_ACCOUNT_API_KEY, undefined);
  assert.equal(r.writes[0].env.AIPLAY_WORKER_TOKEN, r.secrets.get('RUNPOD_INSTALL_TOKEN'));
  const journal = await readFile(path.join(r.dataDir, 'runpod/automatic-install.json'), 'utf8');
  assert.equal(journal.includes(r.secrets.get('RUNPOD_INSTALL_TOKEN')), false);
  assert.equal(JSON.stringify(first).includes(r.secrets.get('RUNPOD_INSTALL_TOKEN')), false);
  await assert.rejects(r.manager.create({ ...input, volumeInGb: 200 }), /different computer choices/);
});
test('lost creation response survives desktop restart and reconciliation never resubmits creation', async t => {
  const r = await rig(t); r.lose();
  assert.equal((await r.manager.create(input)).phase, 'uncertain');
  const restored = await createAutomaticInstaller(r.args); t.after(() => restored.close());
  await assert.rejects(restored.create({ ...input, requestId: '22345678-1234-4234-8234-123456789abc' }), /existing installation/);
  r.rows.push(r.pod);
  assert.equal((await restored.refresh()).phase, 'models');
  assert.equal(r.writes.length, 1); assert.equal(r.connections.length, 1);
});
test('unpublished or mismatched installer, changed price and active work all refuse before a paid mutation', async t => {
  const unpublished = await rig(t, { fetchFn: async () => new Response('', { status: 404 }) });
  await assert.rejects(unpublished.manager.create(input), /not published/);
  const corrupt = await rig(t, { fetchFn: async () => new Response('changed') });
  await assert.rejects(corrupt.manager.create(input), /could not be verified/);
  const changed = await rig(t); changed.changeRate(); await assert.rejects(changed.manager.create(input), /price changed/);
  const busy = await rig(t); busy.active(); await assert.rejects(busy.manager.create(input), /Finish current work/);
  for (const r of [unpublished, corrupt, changed, busy]) assert.equal(r.writes.length, 0);
});
test('wrong worker build is never connected and stopping does not restart compute', async t => {
  const r = await rig(t); await r.manager.create(input); r.wrongIdentity();
  assert.equal((await r.manager.refresh()).workerConnected, false); assert.equal(r.connections.length, 0);
  r.pod.status = 'EXITED'; assert.equal((await r.manager.refresh()).phase, 'stopped');
  assert.equal(r.writes.length, 1);
});
test('automatic bootstrap rejects arbitrary repositories and pins its committed installer blob', () => {
  assert.equal(automaticBootstrap({ version: () => ({ repo: 'attacker/repo' }) }).available, false);
  const p = automaticBootstrap({ root: path.resolve('.'), version: () => ({ repo: 'nemesisone-dev/AIPLAY-Studio' }),
    git: args => args[0] === 'rev-parse' ? COMMIT : Buffer.from(SCRIPT) });
  assert.equal(p.commit, COMMIT); assert.match(p.command, new RegExp(COMMIT)); assert.match(p.command, /sha256sum -c/);
  assert.equal(p.command.includes('main/'), false);
});
