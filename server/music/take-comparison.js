/** Saved-song auditions share one immutable receipt and one revisioned choice.
 * Measurement and audio serving use existing Studio helpers. This store never
 * generates, rewrites, masters, deletes or moves a recording. */
import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const identity = value => typeof value === 'string' && /^takes-[a-f0-9]{24}$/.test(value) ? value : fail('Choose a saved take comparison.');
const filename = value => typeof value === 'string' && value.length <= 255 && !/[\\/:\0]|\.\./.test(value) && /\.(flac|wav|mp3|opus)$/i.test(value) ? value : fail('Choose a library audio filename.');
function only(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Expected a take comparison request.');
  const extra = Object.keys(body).filter(field => !fields.includes(field));
  if (extra.length) fail(`Unsupported take comparison fields: ${extra.join(', ')}.`);
}
function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) fail(`${name} must be nonempty text, at most ${maximum} characters.`);
  return value;
}
function measured(input) {
  const integrated = input?.loudness?.integrated ?? input?.integrated;
  const truePeakDb = input?.loudness?.true_peak_db ?? input?.truePeakDb;
  if (!Number.isFinite(integrated) || integrated < -90 || integrated > 10 || !Number.isFinite(truePeakDb) || truePeakDb < -120 || truePeakDb > 12)
    fail('This recording has no usable loudness or true-peak measurement.', 409);
  return { integrated, truePeakDb, method: 'BS.1770-4 integrated LUFS and oversampled true peak' };
}

/** Attenuation only. A shared target includes headroom for every recording;
 * the extra .1 dB protects against rounded meter values. An impossible range
 * is refused rather than silently applying different loudness targets. */
export function comparisonGains(takes) {
  if (!Array.isArray(takes) || ![2, 4, 8].includes(takes.length)) fail('Select 2, 4 or 8 recordings.');
  const facts = takes.map(take => measured(take.measurement));
  const targetLufs = Math.min(...facts.map(fact => fact.integrated + Math.min(0, -1.1 - fact.truePeakDb)));
  const gains = facts.map(fact => targetLufs - fact.integrated);
  if (gains.some(gain => gain < -24 - 1e-8 || gain > 1e-8)) fail('These recordings need more than 24 dB of matching attenuation. Choose a closer group.', 409);
  return { targetLufs, ceilingDb: -1, marginDb: .1, gainRangeDb: [-24, 0],
    takes: gains.map((gainDb, i) => ({ gainDb, volume: 10 ** (gainDb / 20), expectedPeakDb: facts[i].truePeakDb + gainDb })) };
}

export function createTakeComparisons({ appData, listSongs, inspectSource, sourceReceipt = async () => ({}), measureSource,
  setFavourite = async () => {}, recordEvent = async () => {}, now = Date.now }) {
  const directory = path.join(appData, 'music-take-comparisons'), locks = new Map();
  const file = value => path.join(directory, `${identity(value)}.json`);
  function lock(value, work) {
    const previous = locks.get(value) || Promise.resolve(), pending = previous.catch(() => {}).then(work);
    locks.set(value, pending); pending.finally(() => { if (locks.get(value) === pending) locks.delete(value); }).catch(() => {}); return pending;
  }
  async function save(row) {
    await mkdir(directory, { recursive: true }); const temp = `${file(row.id)}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(row, null, 2), 'utf8'); await rename(temp, file(row.id)); }
    finally { await rm(temp, { force: true }).catch(() => {}); }
  }
  async function load(value) {
    let row;
    try { row = JSON.parse(await readFile(file(value), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') fail('No such take comparison.', 404); fail('This comparison could not be read; its file was retained.', 500); }
    if (row.v !== 1 || row.id !== value || !Number.isInteger(row.revision) || row.revision < 1 || !Array.isArray(row.takes) || ![2, 4, 8].includes(row.takes.length)) fail('Unsupported take comparison record.', 500);
    for (const [index, take] of row.takes.entries()) {
      filename(take.file);
      if (take.id !== String.fromCharCode(65 + index) || !Number.isFinite(take.seconds) || take.seconds <= 0
        || !digest(take.sha256) || !digest(take.receiptHash) || hash(take.receipt) !== take.receiptHash) fail('A saved take receipt is invalid; create a new comparison.', 409);
    }
    const matching = comparisonGains(row.takes);
    if (hash(matching) !== hash(row.matching)) fail('Saved playback measurements changed; create a new comparison.', 409);
    return row;
  }
  function view(row) {
    const out = clone(row); delete out.createHash;
    out.takes.forEach((take, index) => {
      take.playback = clone(out.matching.takes[index]);
      take.audioUrl = `/api/music-take-comparison/audio?id=${encodeURIComponent(row.id)}&takeId=${take.id}&sha256=${take.sha256}`;
    }); return out;
  }
  const unchanged = async take => {
    const actual = await inspectSource(take.file);
    if (!actual || actual.sha256 !== take.sha256 || actual.seconds !== take.seconds) fail(`“${take.title}” is missing or changed. Create a new comparison.`, 409);
  };
  async function verifyRow(row) { for (const take of row.takes) await unchanged(take); }
  function expected(row, revision) {
    if (!Number.isInteger(revision) || revision !== row.revision) fail('This comparison changed. Refresh before applying your choice.', 409);
  }
  async function list() {
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const comparisons = [], errors = [];
    for (const name of names.filter(name => /^takes-[a-f0-9]{24}\.json$/.test(name))) {
      try { const row = await load(name.slice(0, -5)); comparisons.push({ id: row.id, name: row.name, revision: row.revision, count: row.takes.length, chosen: row.chosen, updatedAt: row.updatedAt }); }
      catch (error) { errors.push({ file: name, error: error.message }); }
    }
    comparisons.sort((a, b) => b.updatedAt - a.updatedAt);
    const songs = (await listSongs()).map(song => ({ file: song.file, title: song.title || song.file, engine: song.engine || null,
      seed: song.seed, seconds: song.durationSeconds ?? null, starred: !!song.starred, createdAt: song.createdAt ?? null }));
    return { comparisons, songs, errors };
  }
  async function create(body, actor) {
    only(body, ['action', 'idempotencyKey', 'name', 'files']);
    const token = text(body.idempotencyKey, 'Creation key', 100);
    if (!/^[A-Za-z0-9_-]+$/.test(token)) fail('Use letters, numbers, _ or - for the creation key.');
    if (!Array.isArray(body.files) || ![2, 4, 8].includes(body.files.length) || new Set(body.files).size !== body.files.length) fail('Select 2, 4 or 8 different recordings.');
    body.files.forEach(filename); text(body.name, 'Comparison name', 120);
    const value = `takes-${hash(token).slice(0, 24)}`, createHash = hash(body);
    return lock(value, async () => {
      const prior = await load(value).catch(error => { if (error.status === 404) return null; throw error; });
      if (prior) {
        if (prior.createHash !== createHash) fail('This creation key already describes a different comparison.', 409);
        await verifyRow(prior); return { comparison: view(prior), replayed: true };
      }
      const available = new Set((await listSongs()).map(song => song.file)), takes = [];
      for (const [index, name] of body.files.entries()) {
        if (!available.has(name)) fail('Choose recordings present in the song library.', 404);
        const source = await inspectSource(name);
        if (!digest(source?.sha256) || !Number.isFinite(source?.seconds) || source.seconds <= 0) fail('The recording could not be measured and fingerprinted.', 409);
        const receipt = clone(await sourceReceipt(name));
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || JSON.stringify(receipt).length > 512 * 1024) fail('The stored settings receipt could not be captured.', 409);
        const take = { id: String.fromCharCode(65 + index), file: name, title: source.title || name, seconds: source.seconds, sha256: source.sha256,
          receipt, receiptHash: hash(receipt), receiptEvidence: 'stored_metadata_and_events', measurement: measured(await measureSource(name, actor)) };
        await unchanged(take); takes.push(take);
      }
      const row = { v: 1, id: value, revision: 1, name: body.name, createHash, createdAt: now(), updatedAt: now(), createdBy: actor,
        takes, matching: comparisonGains(takes), chosen: null, choices: [] };
      await verifyRow(row);
      await recordEvent({ type: 'choice', actor, asset: row.id, data: { op: 'take-comparison-create', id: row.id,
        takes: takes.map(take => ({ file: take.file, sha256: take.sha256, receiptHash: take.receiptHash })) } });
      await save(row); return { comparison: view(row) };
    });
  }
  async function choose(body, actor) {
    only(body, ['action', 'id', 'expectedRevision', 'takeId', 'favourite']);
    if (body.favourite !== undefined && typeof body.favourite !== 'boolean') fail('favourite must be boolean.');
    const value = identity(body.id);
    return lock(value, async () => {
      const row = await load(value); expected(row, body.expectedRevision);
      const take = row.takes.find(take => take.id === body.takeId);
      if (!take) fail('Choose a take from this comparison.');
      await verifyRow(row);
      const favourite = body.favourite ?? true, choice = { takeId: take.id, file: take.file, sha256: take.sha256,
        receiptHash: take.receiptHash, favourite, at: now(), actor };
      await setFavourite(take.file, favourite);
      await recordEvent({ type: 'choice', actor, asset: take.file, data: { op: 'take-comparison-choose', id: row.id, ...choice } });
      row.chosen = choice; row.choices.push(choice); row.updatedAt = now(); row.revision++; await save(row);
      return { comparison: view(row) };
    });
  }
  async function request(body, actor = 'user') {
    const action = body?.action;
    if (action === 'list') { only(body, ['action']); return list(); }
    if (action === 'create') return create(body, actor);
    if (action === 'choose') return choose(body, actor);
    if (action === 'get' || action === 'verify') {
      only(body, ['action', 'id']); const row = await load(identity(body.id));
      if (action === 'verify') await verifyRow(row);
      return { comparison: view(row), ...(action === 'verify' ? { verified: true } : {}) };
    }
    fail('Choose list, create, get, verify or choose.');
  }
  async function audio(input) {
    only(input, ['id', 'takeId', 'sha256']); const row = await load(identity(input.id)), take = row.takes.find(take => take.id === input.takeId);
    if (!take || !digest(input.sha256) || input.sha256 !== take.sha256) fail('This audio receipt is stale. Refresh the comparison.', 409);
    await unchanged(take); return { file: take.file, sha256: take.sha256 };
  }
  return { request, audio, list };
}

export function createTakeComparisonRoutes({ json, readBody, actorFrom, serveAudio, ...dependencies }) {
  const store = createTakeComparisons(dependencies);
  const route = async (req, res, url) => {
    if (url.pathname !== '/api/music-take-comparison' && url.pathname !== '/api/music-take-comparison/audio') return false;
    try {
      if (url.pathname.endsWith('/audio')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail('Use GET or HEAD.', 405);
        const source = await store.audio(Object.fromEntries(url.searchParams));
        await serveAudio(req, res, source.file, source.sha256); return true;
      }
      const body = req.method === 'GET' ? url.searchParams.has('id') ? { action: 'get', id: url.searchParams.get('id') } : { action: 'list' }
        : req.method === 'POST' ? await readBody(req, 32 * 1024) : fail('Use GET or POST.', 405);
      json(res, 200, { ok: true, ...await store.request(body, actorFrom(req)) });
    } catch (error) { json(res, error.status || 400, { error: error.message }); }
    return true;
  };
  route.store = store; return route;
}
