/** Local, hash-pinned looks for an already imported avatar. No geometry or rig is generated here. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { readGlb } from './glb.js';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const avatarPattern = /^av_[a-f0-9-]{36}$/;
const lookPattern = /^look_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const queues = new Map();
const copy = value => structuredClone(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail(`${name} must be an object.`);
  return value;
};
const keys = (value, allowed, name) => {
  object(value, name);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw fail(`Unknown ${name} field.`);
};
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`${name} must contain 1 to ${max} printable characters.`);
  return value.trim();
};
const label = (value, fallback) => typeof value === 'string' && value.length ? value.slice(0, 160) : fallback;
function checkedAvatar(id) {
  if (typeof id !== 'string' || !avatarPattern.test(id)) throw fail('Invalid avatar id.');
  return id;
}
function checkedLook(id) {
  if (typeof id !== 'string' || !lookPattern.test(id)) throw fail('Invalid look id.');
  return id;
}
function checkedHash(value) {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw fail('A source SHA-256 is required.');
  return value;
}
function revision(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) throw fail('Expected revision must be a nonnegative safe integer.');
  return value;
}

/** Serializes edits across service instances within this Studio process. */
async function serialized(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

function inventoryFrom(row, bytes, id) {
  if (!row || row.id !== id || !Buffer.isBuffer(bytes)) throw fail('Avatar identity mismatch.', 409);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (row.inspection?.sha256 !== sha256) throw fail('Avatar changed on disk; import it as a new version.', 409);
  const parsed = readGlb(bytes);
  if (!parsed.ok) throw fail(parsed.why.join('; '), 422);
  const document = parsed.json;
  if ((document.nodes?.length || 0) > 2048 || (document.materials?.length || 0) > 128) throw fail('Avatar exceeds appearance inventory limits.', 422);
  const reachable = new Set();
  const ancestors = new Map();
  const roots = document.scenes?.[document.scene ?? 0]?.nodes || [];
  function visit(index, parents) {
    if (!Number.isInteger(index) || !document.nodes?.[index] || parents.includes(index)) throw fail('Invalid avatar scene hierarchy.', 422);
    if (reachable.has(index)) throw fail('Avatar nodes cannot have multiple scene parents.', 422);
    reachable.add(index);
    ancestors.set(index, parents);
    for (const child of document.nodes[index].children || []) visit(child, [...parents, index]);
  }
  for (const root of roots) visit(root, []);
  const nodes = (document.nodes || []).flatMap((node, index) => {
    if (!Number.isInteger(node.mesh)) return [];
    const mesh = document.meshes?.[node.mesh];
    if (!mesh) throw fail('Avatar references an unknown mesh.', 422);
    const morphCount = Math.max(0, ...(mesh.primitives || []).map(primitive => primitive.targets?.length || 0));
    if (morphCount > 256) throw fail('Avatar exceeds the morph target inventory limit.', 422);
    return [{index, name: label(node.name, `Mesh ${index}`), mesh: node.mesh,
      skin: Number.isInteger(node.skin) ? node.skin : null,
      materials: [...new Set((mesh.primitives || []).map(primitive => primitive.material).filter(Number.isInteger))],
      morphTargets: Array.from({length: morphCount}, (_, target) => ({index: target,
        name: label(mesh.extras?.targetNames?.[target], `Target ${target + 1}`),
        weight: node.weights?.[target] ?? mesh.weights?.[target] ?? 0})),
      activeInScene: reachable.has(index)}];
  });
  const materials = (document.materials || []).map((material, index) => ({index,
    name: label(material.name, `Material ${index + 1}`),
    baseColor: copy(material.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1, 1]),
    hasBaseColorTexture: Boolean(material.pbrMetallicRoughness?.baseColorTexture),
    unlit: Boolean(material.extensions?.KHR_materials_unlit)}));
  const expressions = [];
  for (const kind of ['preset', 'custom']) {
    for (const [name, expression] of Object.entries(document.extensions?.VRMC_vrm?.expressions?.[kind] || {})) {
      if (expressions.length >= 256 || name.length > 100 || !name.length || ['__proto__', 'prototype', 'constructor'].includes(name)) throw fail('Unsupported VRM expression name or count.', 422);
      if (expressions.some(item => item.name === name)) throw fail('VRM expressions must have distinct names.', 422);
      expressions.push({name, kind, isBinary: expression.isBinary === true});
    }
  }
  const springs = document.extensions?.VRMC_springBone;
  const inventory = {avatarId: id, sha256, name: label(row.name, id), nodes, materials, expressions,
    spring: {supported: Boolean(springs?.springs?.length), chains: springs?.springs?.length || 0, colliders: springs?.colliders?.length || 0}};
  return {inventory, ancestors};
}

function settingsFor(value, inventory, ancestors) {
  keys(value, ['hidden_nodes', 'material_colors', 'expressions', 'spring_enabled'], 'appearance settings');
  const result = {};
  if (own(value, 'hidden_nodes')) {
    const hidden = value.hidden_nodes;
    if (!Array.isArray(hidden) || hidden.length > inventory.nodes.length || new Set(hidden).size !== hidden.length || hidden.some(index => !Number.isInteger(index) || !inventory.nodes.some(node => node.index === index))) throw fail('Hidden nodes must be distinct mesh node indices from this avatar.');
    const excluded = new Set(hidden);
    const active = inventory.nodes.filter(node => node.activeInScene);
    if (active.length && !active.some(node => !excluded.has(node.index) && !(ancestors.get(node.index) || []).some(index => excluded.has(index)))) throw fail('At least one mesh in the active scene must remain visible.');
    result.hidden_nodes = [...hidden].sort((a, b) => a - b);
  }
  if (own(value, 'material_colors')) {
    const colors = object(value.material_colors, 'Material colors');
    if (Object.keys(colors).length > inventory.materials.length) throw fail('Too many material overrides.');
    result.material_colors = {};
    for (const [index, rgba] of Object.entries(colors)) {
      if (!/^(0|[1-9]\d*)$/.test(index) || !inventory.materials.some(material => material.index === Number(index)) || !Array.isArray(rgba) || rgba.length !== 4 || !rgba.every(unit)) throw fail('Material colors require an existing material index and four values from 0 to 1.');
      result.material_colors[index] = [...rgba];
    }
  }
  if (own(value, 'expressions')) {
    const expressions = object(value.expressions, 'Expressions');
    if (Object.keys(expressions).length > inventory.expressions.length) throw fail('Too many expression overrides.');
    result.expressions = {};
    for (const [name, weight] of Object.entries(expressions)) {
      if (!inventory.expressions.some(expression => expression.name === name) || !unit(weight)) throw fail('Expressions require an embedded VRM expression and a weight from 0 to 1.');
      result.expressions[name] = weight;
    }
  }
  if (own(value, 'spring_enabled')) {
    if (typeof value.spring_enabled !== 'boolean') throw fail('Spring enabled must be a boolean.');
    if (value.spring_enabled && !inventory.spring.supported) throw fail('This avatar has no embedded VRM spring chains.');
    result.spring_enabled = value.spring_enabled;
  }
  return result;
}

export function createAppearanceService({directory, inspectAsset, record = async () => {}}) {
  if (typeof inspectAsset !== 'function') throw new TypeError('inspectAsset is required.');
  const avatarDirectory = id => path.join(directory, checkedAvatar(id));
  const lookPath = (id, lookId) => path.join(avatarDirectory(id), `${checkedLook(lookId)}.json`);
  async function inspect(id) {
    checkedAvatar(id);
    const {row, bytes} = await inspectAsset(id);
    return inventoryFrom(row, bytes, id);
  }
  async function inventory(id) { return (await inspect(id)).inventory; }
  async function read(id, lookId, context) {
    let row;
    try {
      const bytes = await readFile(lookPath(id, lookId));
      if (bytes.length > 128 * 1024) throw fail('Saved look exceeds the size limit.', 422);
      row = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('Look not found.', 404);
      throw error;
    }
    if (row.schema !== 1 || row.id !== lookId || row.avatarId !== id) throw fail('Look identity mismatch.', 409);
    if (row.sha256 !== context.inventory.sha256) throw fail('Look source has changed; import and review a new avatar version.', 409);
    revision(row.revision, 1);
    settingsFor(row.settings, context.inventory, context.ancestors);
    return row;
  }
  async function get(id, lookId) {
    checkedLook(lookId);
    return read(id, lookId, await inspect(id));
  }
  async function list(id) {
    const context = await inspect(id);
    let names;
    try { names = await readdir(avatarDirectory(id)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const files = names.filter(name => name.endsWith('.json') && lookPattern.test(name.slice(0, -5)));
    if (files.length > 64) throw fail('This avatar exceeds the 64-look limit.', 422);
    const rows = await Promise.all(files.map(name => read(id, name.slice(0, -5), context)));
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  async function writeAtomic(destination, row) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(row, null, 2), {flag: 'wx'});
      await rename(temporary, destination);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function active(id) {
    const context = await inspect(id);
    let selected;
    try { selected = JSON.parse(await readFile(path.join(avatarDirectory(id), 'active.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (selected.schema !== 1 || selected.avatarId !== id || selected.sha256 !== context.inventory.sha256) throw fail('Active look source changed.', 409);
    checkedLook(selected.lookId);
    try { return await read(id, selected.lookId, context); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  async function activate(input, actor = 'system') {
    keys(input, ['id', 'look_id', 'sha256'], 'look activation');
    const request = copy(input);
    checkedAvatar(request.id); checkedLook(request.look_id); checkedHash(request.sha256);
    return serialized(path.resolve(avatarDirectory(request.id)), async () => {
      const context = await inspect(request.id);
      if (request.sha256 !== context.inventory.sha256) throw fail('Avatar source changed; refresh its inventory.', 409);
      const row = await read(request.id, request.look_id, context);
      await record({type: 'preset_apply', actor, asset: `avatar/${request.id}`, data: {op: 'appearance_activate', avatarId: request.id, lookId: row.id, revision: row.revision, sha256: row.sha256}});
      await writeAtomic(path.join(avatarDirectory(request.id), 'active.json'), {schema: 1, avatarId: request.id, sha256: request.sha256, lookId: row.id});
      return row;
    });
  }
  async function save(input, actor = 'system') {
    // Capture a caller-owned request before awaiting I/O or entering the write queue.
    keys(input, ['id', 'look_id', 'expected_revision', 'sha256', 'name', 'settings', 'persona_id'], 'look');
    const request = copy(input);
    checkedAvatar(request.id);
    checkedHash(request.sha256);
    revision(request.expected_revision);
    const name = text(request.name, 'Look name', 80);
    if (request.look_id !== undefined) checkedLook(request.look_id);
    else if (request.expected_revision !== 0) throw fail('A new look requires expected revision 0.', 409);
    const personaId = request.persona_id === undefined || request.persona_id === null || request.persona_id === '' ? null : request.persona_id;
    if (personaId !== null && (typeof personaId !== 'string' || !/^[1-9]\d{0,11}$/.test(personaId))) throw fail('Persona id must be a positive numeric attribution.');
    return serialized(path.resolve(avatarDirectory(request.id)), async () => {
      const context = await inspect(request.id);
      if (context.inventory.sha256 !== request.sha256) throw fail('Avatar source changed; refresh its inventory before saving.', 409);
      const settings = settingsFor(request.settings, context.inventory, context.ancestors);
      const existing = request.look_id ? await read(request.id, request.look_id, context) : null;
      if ((existing?.revision || 0) !== request.expected_revision) throw fail('Look changed; reload it before saving.', 409);
      await mkdir(avatarDirectory(request.id), {recursive: true});
      if (!existing && (await list(request.id)).length >= 64) throw fail('An avatar can have at most 64 looks.', 409);
      const now = new Date().toISOString();
      const row = {schema: 1, id: existing?.id || `look_${randomUUID()}`, avatarId: request.id,
        sha256: request.sha256, name, revision: (existing?.revision || 0) + 1, settings,
        createdAt: existing?.createdAt || now, updatedAt: now, actor,
        personaAttribution: {personaId, authority: 'unverified source attribution; not an account binding'}};
      const destination = lookPath(request.id, row.id);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(row, null, 2), {flag: 'wx'});
        await record({type: 'edit', actor, asset: `avatar/${request.id}/looks/${row.id}`, data: {op: 'appearance_save', avatarId: request.id, lookId: row.id, revision: row.revision, sha256: row.sha256}});
        await rename(temporary, destination);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return copy(row);
    });
  }
  async function remove(input, actor = 'system') {
    keys(input, ['id', 'look_id', 'expected_revision', 'sha256'], 'look deletion');
    const request = copy(input);
    checkedAvatar(request.id); checkedLook(request.look_id); checkedHash(request.sha256); revision(request.expected_revision, 1);
    return serialized(path.resolve(avatarDirectory(request.id)), async () => {
      const context = await inspect(request.id);
      if (request.sha256 !== context.inventory.sha256) throw fail('Avatar source changed; refresh its inventory.', 409);
      const existing = await read(request.id, request.look_id, context);
      if (existing.revision !== request.expected_revision) throw fail('Look changed; reload it before deleting.', 409);
      await record({type: 'edit', actor, asset: `avatar/${request.id}/looks/${existing.id}`, data: {op: 'appearance_delete', avatarId: request.id, lookId: existing.id, revision: existing.revision, sha256: existing.sha256}});
      await unlink(lookPath(request.id, request.look_id));
      const selectedPath = path.join(avatarDirectory(request.id), 'active.json');
      let selected;
      try { selected = JSON.parse(await readFile(selectedPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (selected?.lookId === request.look_id) await unlink(selectedPath);
      return {deleted: existing.id, avatarId: request.id};
    });
  }
  return {inventory, list, get, save, remove, active, activate};
}
