/** Reviewed DAW notation -> saved draft -> the existing protected audition door.
 * No synthesis or compositor is reimplemented here. A score is conditioning,
 * not a promise that the model will reproduce every edited note. */
import path from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, randomInt } from 'node:crypto';
import { dawSelectionToScore } from './daw-score.js';
import { audioName } from './auditions.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const copy = value => structuredClone(value);
const ID = /^passage-[a-f0-9]{24}$/;
const slugOf = value => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(value)) throw fail('Choose a saved DAW project.');
  return value;
};
const text = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max) throw fail(`${label} must be text of at most ${max} characters.`);
  return value;
};
export function createDawPassages({ dir, readProject, inspectSource, inspectAudio, listSources,
  auditions, now = Date.now, newSeed = () => randomInt(0, 4294967296) }) {
  let data, tail = Promise.resolve();
  const inflight = new Map(), file = path.join(dir, 'passages.json');
  const save = async () => {
    await mkdir(dir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, file);
  };
  const loaded = (async () => {
    try { data = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw fail('The passage shelf could not be read; it was not overwritten.', 500); data = { v: 1, drafts: {} }; }
    if (data.v !== 1 || !data.drafts || typeof data.drafts !== 'object') throw fail('Unsupported passage shelf.', 500);
    let changed = false;
    for (const draft of Object.values(data.drafts)) if (draft.state === 'starting') {
      draft.state = 'uncertain'; draft.error = 'Studio restarted during submission. Inspect the audition shelf and queue before creating another draft; this draft will not resubmit.';
      draft.revision++; changed = true;
    }
    if (changed) await save();
  })();
  loaded.catch(() => {});
  const lock = fn => { const next = tail.then(async () => { await loaded; return fn(); }); tail = next.catch(() => {}); return next; };
  const get = id => { if (!ID.test(id || '') || !data.drafts[id]) throw fail('No such DAW passage draft.', 404); return data.drafts[id]; };
  const revision = (draft, value) => { if (!Number.isInteger(value) || value !== draft.revision) throw fail('This draft changed. Refresh before starting it.', 409); };
  async function preview(b) {
    const slug = slugOf(b.slug), project = await readProject(slug);
    if (!project) throw fail('The DAW project no longer exists.', 404);
    if (b.quantizeTo32nd !== undefined && typeof b.quantizeTo32nd !== 'boolean') throw fail('Quantize must be an explicit boolean.');
    const source = b.source ? audioName(b.source) : null;
    const offset = b.sourceOffsetSeconds ?? 0;
    if (!Number.isFinite(offset) || Math.abs(offset) > 86400) throw fail('The recording offset must be a finite number within one day.');
    const options = { fromBar: b.fromBar, toBar: b.toBar, voiceTracks: b.voiceTracks,
      quantizeTo32nd: b.quantizeTo32nd === true };
    const score = dawSelectionToScore(project, options);
    const info = source ? await inspectSource(source, { hash: true }) : null;
    let fullScore = null, reason = null;
    if (!source) reason = 'Choose a saved YuE2 Python recording to make protected passage alternatives. You can load this score in Music to generate a new song.';
    else if (info.engine !== 'yue2') reason = 'Edited ABC passage alternatives currently require a YuE2 Python recording. Quantized and ComfyUI routes can use their supported score controls in Music.';
    else if (!info.available) reason = info.reason || 'The recording has no available saved YuE2 performance.';
    else if (info.cot === 'off') reason = 'This source has score planning off. Choose a recording made with full or melody planning.';
    const fromSeconds = score.selection.startSeconds + offset, toSeconds = score.selection.endSeconds + offset;
    if (!reason && (fromSeconds < 1 || fromSeconds > info.seconds - 1 || toSeconds > info.seconds || toSeconds <= fromSeconds + .5))
      reason = 'The passage must start at least one second into the recording and fit inside its measured length. Review the recording offset.';
    if (!reason) {
      try { fullScore = dawSelectionToScore(project, { ...options, fromBar: 1, toBar: project.lengthBars }); }
      catch (e) { reason = `The complete conditioning score cannot be exported: ${e.message}`; }
    }
    const caption = text(b.caption ?? info?.caption ?? '', 10000, 'Style');
    const lyrics = text(b.lyrics ?? info?.lyrics ?? '', 20000, 'Lyrics');
    const request = { engine: 'yue2', cot: 'full', abc: score.abc, caption, lyrics,
      instrumental: !lyrics.trim(),
      title: `${project.name || slug} · bars ${b.fromBar}–${b.toBar}`,
      maxDuration: score.selection.durationSeconds, narSteps: 32, quantization: 'none' };
    return { slug, title: request.title, score, fullScore, options, request, source,
      sourceHash: info?.sha256 || null, sourceOffsetSeconds: offset, fromSeconds, toSeconds,
      eligibility: { available: !reason, reason }, sourceInfo: info };
  }
  async function create(b, actor) {
    const reviewed = await preview(b);
    return lock(async () => {
      if (Object.keys(data.drafts).length >= 200) throw fail('The DAW passage shelf has reached 200 drafts.', 409);
      const id = `passage-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
      const draft = { ...reviewed, request: { ...reviewed.request, seed: newSeed() }, id, revision: 1, state: 'draft', actor,
        createdAt: now(), updatedAt: now(), auditionId: null };
      data.drafts[id] = draft; await save(); return { draft: copy(draft), audition: null };
    });
  }
  async function read(id) {
    const draft = await lock(() => copy(get(id)));
    const audition = draft.auditionId ? await auditions.read(draft.auditionId) : null;
    return { draft, audition };
  }
  async function fresh(draft) {
    const project = await readProject(draft.slug);
    if (!project) throw fail('The DAW project no longer exists.', 409);
    let current;
    try { current = dawSelectionToScore(project, draft.options); }
    catch (e) { throw fail(`The project changed since this draft was reviewed: ${e.message}`, 409); }
    if (current.projectFingerprint !== draft.score.projectFingerprint) throw fail('The project notes, instruments or timing changed. Review and save a new draft before generating.', 409);
    if (draft.source) {
      const source = await inspectSource(draft.source, { hash: true, requireReplay: false });
      if (source.sha256 !== draft.sourceHash) throw fail('The source recording changed. Review and save a new draft.', 409);
    }
    return current;
  }
  async function request(id) {
    const { draft } = await read(id); await fresh(draft);
    return { draft, request: copy(draft.request) };
  }
  async function start(b, actor) {
    const snapshot = await lock(() => copy(get(b.id)));
    if (snapshot.auditionId) return read(snapshot.id); // A retried submission never starts another session.
    if (inflight.has(b.id)) return inflight.get(b.id);
    revision(snapshot, b.revision);
    if (snapshot.state !== 'draft') throw fail(snapshot.error || 'This draft cannot resubmit. Inspect its queue receipt.', 409);
    if (!snapshot.eligibility.available || !snapshot.fullScore) throw fail(snapshot.eligibility.reason, 409);
    const count = b.count ?? 2, contextSeconds = b.contextSeconds ?? 3;
    if (![2, 3].includes(count)) throw fail('Choose two or three protected alternatives.');
    if (!Number.isFinite(contextSeconds) || contextSeconds < 0 || contextSeconds > 15) throw fail('Seam context must be from 0 to 15 seconds.');
    const seeds = b.seeds ?? Array.from({ length: count }, () => randomInt(0, 4294967296));
    if (!Array.isArray(seeds) || seeds.length !== count || new Set(seeds).size !== count
      || seeds.some(seed => !Number.isInteger(seed) || seed < 0 || seed > 4294967295)) throw fail('Give one distinct unsigned 32-bit seed per take.');
    const operation = (async () => {
      await fresh(snapshot);
      const currentSource = await inspectSource(snapshot.source, { hash: true });
      if (!currentSource.available || currentSource.engine !== 'yue2' || currentSource.cot === 'off'
        || currentSource.sha256 !== snapshot.sourceHash) throw fail(currentSource.reason || 'The saved performance changed; nothing was queued.', 409);
      await lock(async () => {
        const draft = get(b.id); revision(draft, b.revision);
        draft.state = 'starting'; draft.submission = { count, seeds, contextSeconds, actor };
        draft.updatedAt = now(); draft.revision++; await save();
      });
      try {
        const audition = await auditions.create({ source: snapshot.source, fromSeconds: snapshot.fromSeconds,
          toSeconds: snapshot.toSeconds, count, seeds, contextSeconds,
          caption: snapshot.request.caption, lyrics: snapshot.request.lyrics, abc: snapshot.fullScore.abc }, actor);
        await lock(async () => { const draft = get(b.id); draft.auditionId = audition.id; draft.state = 'submitted'; draft.updatedAt = now(); draft.revision++; await save(); });
        return read(b.id);
      } catch (e) {
        await lock(async () => { const draft = get(b.id); draft.state = 'uncertain'; draft.error = `Submission was not acknowledged: ${e.message}. Inspect the audition shelf and queue before starting another draft.`; draft.revision++; draft.updatedAt = now(); await save(); });
        throw fail(`Submission was not acknowledged; this draft will not resubmit. ${e.message}`, e.status || 502);
      }
    })();
    inflight.set(b.id, operation);
    try { return await operation; } finally { inflight.delete(b.id); }
  }
  async function audio(b) {
    const { draft, audition } = await read(b.id);
    let file, sha256, seconds, chosenTake;
    if (b.takeId === 'original') { file = draft.source; sha256 = draft.sourceHash; seconds = draft.sourceInfo?.seconds; }
    else {
      const take = audition?.takes.find(t => t.id === b.takeId);
      if (!take || take.state !== 'ready' || !take.file || !take.sha256) throw fail('Only a composed, ready take can be auditioned.', 409);
      chosenTake = take;
      ({ file, sha256, seconds } = take);
    }
    if (!file || !sha256) throw fail('This draft has no recording.', 409);
    const current = await inspectAudio(audioName(file));
    if (current.sha256 !== sha256 || !(current.seconds > 0)) throw fail('The recording is missing or changed; playback refused.', 409);
    if (b.sha256 && b.sha256 !== sha256) throw fail('The playback fingerprint does not match this draft.', 409);
    const context = audition?.contextSeconds ?? 3;
    const part = b.part ?? 'region', end = chosenTake?.effectiveTo ?? draft.toSeconds;
    if (!['region', 'in', 'out', 'full'].includes(part)) throw fail('Choose region, in, out or full playback.');
    const from = part === 'full' ? 0 : part === 'out' ? end - context : draft.fromSeconds - context;
    const to = part === 'full' ? current.seconds : part === 'in' ? draft.fromSeconds + context : part === 'out' ? end + context : draft.toSeconds + context;
    return { file, sha256, seconds: current.seconds, fromSeconds: Math.max(0, Math.min(current.seconds, from)),
      toSeconds: Math.max(0, Math.min(current.seconds, to)), label: b.takeId === 'original' ? 'Original recording' : `Take ${chosenTake.label || b.takeId}`,
      shortfallSeconds: chosenTake?.shortfallSeconds || 0, effectiveTo: end,
      url: `/api/music-daw-passages/audio?id=${encodeURIComponent(draft.id)}&takeId=${encodeURIComponent(b.takeId)}&sha256=${sha256}` };
  }
  return { preview, create, read, request, start, audio,
    async list(slug) { if (slug) slugOf(slug); const drafts = await lock(() => Object.values(data.drafts).filter(d => !slug || d.slug === slug).sort((a, b) => b.createdAt - a.createdAt).map(copy)); return { drafts, sources: await listSources() }; } };
}

export function createDawPassageRoutes({ store, readBody, json, actorFrom, serveAudio }) {
  return async (req, res, url) => {
    if (url.pathname !== '/api/music-daw-passages' && url.pathname !== '/api/music-daw-passages/audio') return false;
    try {
      if (url.pathname === '/api/music-daw-passages/audio') {
        if (req.method !== 'GET') throw fail('Use GET for playback.', 405);
        const clip = await store.audio({ id: url.searchParams.get('id'), takeId: url.searchParams.get('takeId'), sha256: url.searchParams.get('sha256') });
        if (url.searchParams.get('sha256') !== clip.sha256) throw fail('Playback requires its saved fingerprint.');
        await serveAudio(req, res, clip.file); return true;
      }
      let result;
      if (req.method === 'GET') result = url.searchParams.has('id') ? await store.read(url.searchParams.get('id')) : await store.list(url.searchParams.get('slug'));
      else if (req.method === 'POST') {
        const b = await readBody(req), actor = actorFrom(req);
        const fields = ['slug', 'fromBar', 'toBar', 'voiceTracks', 'source', 'sourceOffsetSeconds', 'quantizeTo32nd', 'caption', 'lyrics'];
        const allowed = { list: ['slug'], get: ['id'], preview: fields, create: fields, request: ['id'],
          start: ['id', 'revision', 'count', 'seeds', 'contextSeconds'], audition: ['id', 'takeId', 'part'] };
        if (!b || !allowed[b.action] || Object.keys(b).some(key => key !== 'action' && !allowed[b.action].includes(key)))
          throw fail('Unsupported DAW passage action or field.');
        switch (b.action) {
          case 'list': result = await store.list(b.slug); break;
          case 'get': result = await store.read(b.id); break;
          case 'preview': result = await store.preview(b); break;
          case 'create': result = await store.create(b, actor); break;
          case 'request': result = await store.request(b.id); break;
          case 'start': result = await store.start(b, actor); break;
          case 'audition': result = await store.audio(b); break;
          default: throw fail('Choose list, get, preview, create, request, start or audition.');
        }
      } else throw fail('Use GET or POST.', 405);
      json(res, 200, { ok: true, ...result });
    } catch (e) { json(res, e.status || 400, { error: e.message }); }
    return true;
  };
}
