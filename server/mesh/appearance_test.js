import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { glbDoc, packGlb } from './fixtures.js';
import { createAppearanceService } from './appearance.js';
import { avatarAppearanceTools } from '../mcp-avatar-appearance.js';

const id = 'av_12345678-1234-1234-1234-123456789abc';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture({vrm = true, nested = false} = {}) {
  const doc = glbDoc({skinned: true});
  doc.materials = [{name: 'Fabric', pbrMetallicRoughness: {baseColorFactor: [.3, .5, .7, 1], baseColorTexture: {index: 0}}}, {name: 'Hair'}];
  doc.meshes[0].primitives[0].material = 0;
  doc.meshes.push({primitives: [{attributes: {POSITION: 0}, material: 1, targets: [{POSITION: 0}, {POSITION: 0}]}], extras: {targetNames: ['Blink', 'Smile']}, weights: [.1, 0]});
  doc.nodes.push({name: 'Hair', mesh: 1});
  if (nested) doc.nodes[0].children = [4];
  else doc.scenes[0].nodes.push(4);
  if (vrm) doc.extensions = {
    VRMC_vrm: {expressions: {preset: {happy: {isBinary: false}, blink: {isBinary: true}}, custom: {wave: {}}}},
    VRMC_springBone: {springs: [{joints: [{node: 3}]}], colliders: [{node: 1}]},
  };
  return packGlb(doc);
}
async function setup(t, opts) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'avatar-appearance-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  let bytes = fixture(opts);
  const events = [];
  const inspectAsset = async requested => {
    assert.equal(requested, id);
    return {row: {id, name: 'Fixture', inspection: {sha256: digest(bytes)}}, bytes};
  };
  const config = {directory, inspectAsset, record: async event => { events.push(event); }};
  const service = createAppearanceService(config);
  const request = (settings = {}) => ({id, expected_revision: 0, sha256: digest(bytes), name: 'Test look', settings});
  return {service, config, directory, events, request, change: next => { bytes = next; }};
}

test('inventory preserves mesh indices, defaults, target names and actual embedded VRM capabilities', async t => {
  const f = await setup(t);
  const inventory = await f.service.inventory(id);
  assert.deepEqual(inventory.nodes.map(node => [node.index, node.name, node.skin, node.activeInScene]), [[0, 'body', 0, true], [4, 'Hair', null, true]]);
  assert.deepEqual(inventory.nodes[1].morphTargets, [{index: 0, name: 'Blink', weight: .1}, {index: 1, name: 'Smile', weight: 0}]);
  assert.deepEqual(inventory.materials[0].baseColor, [.3, .5, .7, 1]);
  assert.deepEqual(inventory.materials[1].baseColor, [1, 1, 1, 1]);
  assert.equal(inventory.materials[0].hasBaseColorTexture, true);
  assert.deepEqual(inventory.expressions, [{name: 'happy', kind: 'preset', isBinary: false}, {name: 'blink', kind: 'preset', isBinary: true}, {name: 'wave', kind: 'custom', isBinary: false}]);
  assert.deepEqual(inventory.spring, {supported: true, chains: 1, colliders: 1});
  inventory.nodes[0].name = 'Caller edit';
  assert.equal((await f.service.inventory(id)).nodes[0].name, 'body');
});

test('a fresh service persists a named look and keeps empty settings as embedded defaults', async t => {
  const f = await setup(t);
  const look = await f.service.save({...f.request(), persona_id: '42'}, 'agent:test');
  assert.equal(look.revision, 1);
  assert.deepEqual(look.settings, {});
  assert.equal(look.personaAttribution.personaId, '42');
  assert.match(look.personaAttribution.authority, /not an account binding/);
  const next = createAppearanceService(f.config);
  assert.deepEqual(await next.get(id, look.id), look);
  assert.deepEqual(await next.list(id), [look]);
  assert.equal(await next.active(id), null);
  assert.equal(f.events[0].type, 'edit');
  assert.equal(f.events[0].data.op, 'appearance_save');
  assert.equal(f.events[0].data.avatarId, id);
  assert.equal(f.events[0].asset, `avatar/${id}/looks/${look.id}`);
  assert.equal(f.events[0].actor, 'agent:test');
});

test('save takes ownership of its input before awaiting and returned objects cannot mutate disk', async t => {
  const f = await setup(t);
  const request = f.request({hidden_nodes: [4], material_colors: {'0': [1, .2, .3, 1]}, expressions: {happy: .4}, spring_enabled: true});
  const pending = f.service.save(request);
  request.settings.hidden_nodes[0] = 0;
  request.settings.material_colors['0'][0] = 0;
  const saved = await pending;
  assert.deepEqual(saved.settings.hidden_nodes, [4]);
  assert.deepEqual(saved.settings.material_colors['0'], [1, .2, .3, 1]);
  saved.settings.expressions.happy = 1;
  assert.equal((await f.service.get(id, saved.id)).settings.expressions.happy, .4);
});

test('settings cannot select bones, unknown materials, arbitrary expressions or out-of-range data', async t => {
  const f = await setup(t);
  for (const settings of [
    {hidden_nodes: [1]}, {hidden_nodes: [4, 4]}, {hidden_nodes: ['4']}, {hidden_nodes: [0, 4]},
    {material_colors: {'01': [1, 1, 1, 1]}}, {material_colors: {'20': [1, 1, 1, 1]}},
    {material_colors: {'0': [1, 1, 1]}}, {material_colors: {'0': [1, 1, 1, 1.1]}},
    {material_colors: {'0': [1, 1, NaN, 1]}}, {expressions: {happy: Infinity}},
    {expressions: {missing: 1}}, {expressions: {happy: -1}}, {spring_enabled: 'true'},
    {path: '../../avatar.glb'}, {script: 'alert(1)'}, {bone_rotation: {head: 90}},
    JSON.parse('{"expressions":{"__proto__":1}}'),
  ]) await assert.rejects(f.service.save(f.request(settings)), {status: 400});
  assert.deepEqual(await f.service.list(id), []);
});

test('hiding a mesh ancestor cannot indirectly hide every active mesh', async t => {
  const f = await setup(t, {nested: true});
  await assert.rejects(f.service.save(f.request({hidden_nodes: [0]})), /remain visible/);
  assert.deepEqual((await f.service.save(f.request({hidden_nodes: [4]}))).settings.hidden_nodes, [4]);
});

test('a plain GLB cannot claim expressions or newly created spring physics', async t => {
  const f = await setup(t, {vrm: false});
  const inventory = await f.service.inventory(id);
  assert.deepEqual(inventory.expressions, []);
  assert.equal(inventory.spring.supported, false);
  await assert.rejects(f.service.save(f.request({spring_enabled: true})), /no embedded VRM spring/);
  await assert.rejects(f.service.save(f.request({expressions: {blink: 1}})), /expression/i);
  assert.equal((await f.service.save(f.request({spring_enabled: false}))).settings.spring_enabled, false);
});

test('two simultaneous edits across service instances cannot overwrite each other', async t => {
  const f = await setup(t);
  const look = await f.service.save(f.request());
  const input = {...f.request({expressions: {happy: 1}}), look_id: look.id, expected_revision: 1};
  const next = createAppearanceService(f.config);
  const results = await Promise.allSettled([f.service.save({...input, name: 'First'}), next.save({...input, name: 'Second'})]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const current = await next.get(id, look.id);
  assert.equal(current.revision, 2);
  assert.equal(current.name, 'First');
  await assert.rejects(next.save({...input, expected_revision: 0}), {status: 409});
  await assert.rejects(next.save({...f.request(), expected_revision: 1}), {status: 409});
  assert.deepEqual((await readdir(path.join(f.directory, id))).filter(name => name.endsWith('.tmp')), []);
});

test('hash pinning blocks saves, loads, activation and deletion after a source replacement', async t => {
  const f = await setup(t);
  const original = f.request();
  const look = await f.service.save(original);
  await f.service.activate({id, look_id: look.id, sha256: original.sha256});
  f.change(fixture({vrm: false}));
  await assert.rejects(f.service.save(original), {status: 409});
  await assert.rejects(f.service.get(id, look.id), {status: 409});
  await assert.rejects(f.service.list(id), {status: 409});
  await assert.rejects(f.service.active(id), {status: 409});
  await assert.rejects(f.service.activate({id, look_id: look.id, sha256: original.sha256}), {status: 409});
  await assert.rejects(f.service.remove({id, look_id: look.id, sha256: original.sha256, expected_revision: 1}), {status: 409});
});

test('activate is explicit, observes later edits and deleting active requires its latest revision', async t => {
  const f = await setup(t);
  const look = await f.service.save(f.request());
  assert.equal(await f.service.active(id), null);
  assert.deepEqual(await f.service.activate({id, look_id: look.id, sha256: look.sha256}), look);
  const edited = await f.service.save({...f.request({expressions: {blink: 1}}), look_id: look.id, expected_revision: 1});
  const next = createAppearanceService(f.config);
  assert.deepEqual(await next.active(id), edited);
  await assert.rejects(next.remove({id, look_id: look.id, sha256: look.sha256, expected_revision: 1}), {status: 409});
  const removed = await next.remove({id, look_id: look.id, sha256: look.sha256, expected_revision: 2});
  assert.equal(removed.deleted, look.id);
  assert.equal(await next.active(id), null);
  assert.deepEqual(await next.list(id), []);
  await assert.rejects(next.get(id, look.id), {status: 404});
});

test('identity and path traversal are refused before asset lookup or filesystem access', async t => {
  const f = await setup(t);
  for (const bad of ['../outside', `${id}/../other`, '/tmp/test', null, {}, `av_${'-'.repeat(36)}/x`]) {
    await assert.rejects(f.service.inventory(bad), /Invalid avatar id/);
    await assert.rejects(f.service.save({...f.request(), id: bad}), /Invalid avatar id/);
  }
  await assert.rejects(f.service.get(id, '../../outside'), /Invalid look id/);
  await assert.rejects(f.service.save({...f.request(), path: 'C:/outside'}), /Unknown look/);
  await assert.rejects(f.service.save({...f.request(), persona_id: 42}), /Persona id/);
  await assert.rejects(f.service.save({...f.request(), name: 'x'.repeat(81)}), /Look name/);
});

test('a failed provenance write leaves no saved look or temporary file', async t => {
  const f = await setup(t);
  const service = createAppearanceService({...f.config, record: async () => { throw new Error('Audit unavailable'); }});
  await assert.rejects(service.save(f.request()), /Audit unavailable/);
  assert.deepEqual(await f.service.list(id), []);
  assert.deepEqual(await readdir(path.join(f.directory, id)), []);
});

test('saved identities and malformed settings are rechecked instead of trusted from disk', async t => {
  const f = await setup(t);
  const look = await f.service.save(f.request());
  const file = path.join(f.directory, id, `${look.id}.json`);
  const original = await readFile(file);
  await writeFile(file, JSON.stringify({...look, avatarId: 'different'}));
  await assert.rejects(f.service.get(id, look.id), /identity mismatch/);
  await writeFile(file, original);
  await writeFile(file, JSON.stringify({...look, settings: {material_colors: {'500': [1, 1, 1, 1]}}}));
  await assert.rejects(f.service.get(id, look.id), /existing material/);
});

test('MCP and UI HTTP action payloads share exactly one service contract', async t => {
  const f = await setup(t);
  const calls = [];
  const tools = avatarAppearanceTools(async (method, route, body) => {
    calls.push({method, route, body});
    const {action, ...input} = body;
    if (action === 'appearance_inventory') return f.service.inventory(input.id);
    if (action === 'appearance_list') return f.service.list(input.id);
    if (action === 'appearance_get') return f.service.get(input.id, input.look_id);
    if (action === 'appearance_save') return f.service.save(input, 'agent:mcp-test');
    if (action === 'appearance_active') return f.service.active(input.id);
    if (action === 'appearance_activate') return f.service.activate(input);
    if (action === 'appearance_delete') return f.service.remove(input);
    assert.fail('Unknown appearance action');
  });
  const run = (name, args) => tools.find(tool => tool.name === `avatar_appearance_${name}`).run(args);
  await run('inventory', {id});
  const request = f.request({hidden_nodes: [4], material_colors: {'1': [.9, .1, .5, 1]}, expressions: {happy: .5}, spring_enabled: true});
  const look = await run('save', request);
  assert.deepEqual(calls.at(-1), {method: 'POST', route: '/api/avatars', body: {...request, action: 'appearance_save'}});
  assert.deepEqual((await run('get', {id, look_id: look.id})).settings, request.settings);
  assert.equal((await run('list', {id})).length, 1);
  assert.equal(await run('active', {id}), null);
  await run('activate', {id, look_id: look.id, sha256: look.sha256});
  assert.equal((await run('active', {id})).id, look.id);
  await run('delete', {id, look_id: look.id, sha256: look.sha256, expected_revision: 1});
  assert.deepEqual(await run('list', {id}), []);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
});
