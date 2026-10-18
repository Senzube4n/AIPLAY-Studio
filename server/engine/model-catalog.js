/** Provider metadata only. URLs and destination paths are never accepted from the browser. */
import { createHash } from 'node:crypto';
export const MODEL_PROVIDERS = { huggingface: 'MODEL_HUGGINGFACE_TOKEN', civitai: 'MODEL_CIVITAI_TOKEN' };
export const MODEL_FOLDERS = ['checkpoints', 'loras', 'diffusion_models', 'vae', 'text_encoders', 'upscale_models'];
const text = (s, n = 240) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const sha = s => /^[a-f0-9]{64}$/i.test(s || '');
const safeImage = s => { try { const u = new URL(s); return u.protocol === 'https:' && ['image.civitai.com', 'huggingface.co', 'cdn-thumbnails.huggingface.co'].includes(u.hostname) && !u.username && !u.password ? u.href : null; } catch { return null; } };
function provider(p) { if (!Object.hasOwn(MODEL_PROVIDERS, p)) throw Error('Choose Hugging Face or Civitai.'); return p; }
function repo(s) { if (!/^[\w.-]+\/[\w.-]+$/.test(s || '') || s.includes('..')) throw Error('Choose a valid model repository.'); return s; }
function numeric(s) { if (!/^\d{1,14}$/.test(String(s))) throw Error('Choose a valid model version.'); return String(s); }
async function json(url, token, fetchFn) {
  let r; try { r = await fetchFn(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw Error('The model provider could not be reached. Try again.'); }
  if (!r.ok) throw Error([401, 403].includes(r.status) ? 'Provider access denied. Check your saved key and model access.' : r.status === 429 ? 'Provider request limit reached. Try again later.' : `Model provider returned HTTP ${r.status}.`);
  const raw = await r.text(); if (raw.length > 12e6) throw Error('Provider results are too large; narrow your search.');
  try { return JSON.parse(raw); } catch { throw Error('The provider returned an unreadable response.'); }
}
function civCard(m) {
  const v = m.modelVersions?.[0] || {}, image = v.images?.find(i => i.type !== 'video' && (i.nsfwLevel <= 1 || i.nsfw === false));
  return { provider: 'civitai', id: String(m.id), name: text(m.name), author: text(m.creator?.username, 80), type: text(m.type),
    purpose: text(m.description), baseModel: text(v.baseModel), image: safeImage(image?.url), downloads: m.stats?.downloadCount || 0,
    url: `https://civitai.com/models/${numeric(m.id)}`, versions: (m.modelVersions || []).slice(0, 30).map(v => ({ id: String(v.id), name: text(v.name) })) };
}
export async function searchCatalog(input, { token, fetchFn = fetch } = {}) {
  const p = provider(input.provider), query = String(input.query || '').trim().slice(0, 120), task = input.task || 'pictures';
  if (p === 'huggingface') {
    const u = new URL('https://huggingface.co/api/models');
    Object.entries({ limit: '24', search: query, sort: input.sort === 'newest' ? 'lastModified' : 'downloads', direction: '-1', cardData: 'true', full: 'true',
      ...(input.type === 'lora' ? { filter: 'lora' } : input.type === 'checkpoint' ? { filter: 'safetensors' } : {}), ...({ pictures: { pipeline_tag: 'text-to-image' }, video: { pipeline_tag: 'text-to-video' }, music: { pipeline_tag: 'text-to-audio' } }[task] || {}) }).forEach(([k,v]) => u.searchParams.set(k,v));
    const data = await json(u.href, token, fetchFn);
    if (!Array.isArray(data)) throw Error('The provider returned an unreadable model list.');
    return { items: data.slice(0,24).filter(m => !m.tags?.includes('not-for-all-audiences')).map(m => ({ provider: p, id: repo(m.id), name: text(m.id.split('/').pop()), author: text(m.id.split('/')[0]),
      type: m.tags?.includes('lora') ? 'LoRA' : 'Model', purpose: text(m.pipeline_tag || 'Review model card for its intended use'),
      baseModel: text(m.cardData?.base_model || 'Check model card'), downloads: m.downloads || 0, image: safeImage(`https://cdn-thumbnails.huggingface.co/social-thumbnails/models/${m.id}.png`),
      url: `https://huggingface.co/${m.id}`, versions: [] })) };
  }
  const u = new URL('https://civitai.com/api/v1/models');
  Object.entries({ limit: '24', nsfw: 'false', earlyAccess: 'false', sort: input.sort === 'newest' ? 'Newest' : 'Most Downloaded', period: 'AllTime',
    ...(query ? { query } : {}), types: input.type === 'lora' ? 'LORA' : input.type === 'checkpoint' ? 'Checkpoint' : 'Checkpoint,LORA',
    ...(task === 'video' ? { tag: 'video' } : task === 'music' ? { tag: 'audio' } : {}), ...(input.base ? { baseModels: String(input.base).slice(0,80) } : {}) }).forEach(([k,v]) => u.searchParams.set(k,v));
  const data = await json(u.href, token, fetchFn);
  return { items: (data.items || []).slice(0,24).filter(m => !m.nsfw && !m.mode).map(civCard) };
}
export async function catalogFiles(input, { token, fetchFn = fetch } = {}) {
  const p = provider(input.provider);
  if (p === 'huggingface') {
    const id = repo(input.id);
    if (input.revision && !/^[a-f0-9]{40}$/.test(input.revision)) throw Error('Choose a pinned model revision.');
    const m = await json(`https://huggingface.co/api/models/${id}${input.revision ? `/revision/${input.revision}` : ''}?blobs=true`, token, fetchFn);
    if (!/^[a-f0-9]{40}$/.test(m.sha || '')) throw Error('The model revision could not be verified.');
    return { provider: p, id, revision: m.sha, license: text(m.cardData?.license_name || m.cardData?.license || 'Review model card'), url: `https://huggingface.co/${id}`, baseModel: text(m.cardData?.base_model || 'Check model card'),
      files: (m.siblings || []).filter(f => /\.safetensors$/i.test(f.rfilename) && sha(f.lfs?.sha256)).slice(0,100).map(f => ({ id: f.rfilename, name: text(f.rfilename), bytes: f.lfs.size || f.size, sha256: f.lfs.sha256.toLowerCase() })) };
  }
  const id = numeric(input.id), m = await json(`https://civitai.com/api/v1/models/${id}`, token, fetchFn);
  if (m.mode) throw Error('This model is unavailable from its provider.');
  const v = (m.modelVersions || []).find(v => String(v.id) === String(input.version)) || (!input.version && m.modelVersions?.[0]);
  if (!v) throw Error('Choose an available model version.');
  return { provider: p, id, version: String(v.id), license: 'Review creator permissions on model page', url: `https://civitai.com/models/${id}?modelVersionId=${numeric(v.id)}`, baseModel: text(v.baseModel), triggerWords: (v.trainedWords || []).slice(0,20).map(w => text(w,80)),
    files: (v.files || []).filter(f => /\.safetensors$/i.test(f.name) && sha(f.hashes?.SHA256) && f.virusScanResult !== 'Danger').slice(0,100).map(f => ({ id: String(f.id), name: text(f.name), bytes: Math.round(f.sizeKB * 1024), sha256: f.hashes.SHA256.toLowerCase(), downloadUrl: f.downloadUrl })) };
}
export async function resolveCatalogFile(input, options) {
  if (!MODEL_FOLDERS.includes(input.folder)) throw Error('Choose a supported model folder.');
  const data = await catalogFiles(input, options), file = data.files.find(f => f.id === input.file);
  if (!file || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 100e9) throw Error('Choose a SafeTensors file with verified size and SHA-256.');
  const id = 'catalog-' + createHash('sha256').update(`${data.provider}:${file.sha256}:${input.folder}`).digest('hex').slice(0,32);
  const name = file.name.split('/').pop().replace(/[^a-zA-Z0-9._-]/g,'_').slice(-130);
  const relative = `${input.folder}/aiplay_${file.sha256.slice(0,12)}_${name}`;
  let url;
  if (data.provider === 'huggingface') url = `https://huggingface.co/${data.id}/resolve/${data.revision}/${file.id.split('/').map(encodeURIComponent).join('/')}`;
  else {
    const source = new URL(file.downloadUrl);
    if (source.origin !== 'https://civitai.com' || source.pathname !== `/api/download/models/${numeric(data.version)}` || source.username || source.password) throw Error('The provider returned an unsupported download link.');
    const clean = new URL(source.origin + source.pathname);
    for (const [k,v] of source.searchParams) if (['type','format','size','fp','fileId'].includes(k)) clean.searchParams.set(k,v);
    url = clean.href;
  }
  return { id, label: name, description: `${data.baseModel || 'Check compatibility'}; additional workflow components may be needed.`, external: true, provider: data.provider,
    licenseUrl: data.url, totalBytes: file.bytes, files: [{ relative, bytes: file.bytes, sha256: file.sha256, url, tolerance: data.provider === 'civitai' ? 1024 : 0 }] };
}
/** No credentials follow redirects, and providers cannot redirect to arbitrary networks. */
export async function fetchModelFile(url, init, fetchFn = fetch) {
  let u = new URL(url);
  const allowed = h => ['huggingface.co','civitai.com','cdn-lfs.huggingface.co'].includes(h) || /^(?:[\w-]+\.)?(?:xethub\.hf\.co|cdn-lfs[\w-]*\.hf\.co)$/.test(h) || /^[a-z0-9-]+\.aws\.cdn\.hf\.co$/.test(h) || h.endsWith('.r2.cloudflarestorage.com');
  for (let hop = 0; hop < 6; hop++) {
    if (u.protocol !== 'https:' || u.port || u.username || u.password || !allowed(u.hostname)) throw Error('The model download redirected to an unsupported host.');
    const headers = { ...init.headers }; if (hop) delete headers.Authorization;
    const r = await fetchFn(u.href, { ...init, headers, redirect: 'manual' });
    if (![301,302,303,307,308].includes(r.status)) return r;
    const location = r.headers.get('location'); await r.body?.cancel();
    if (!location) throw Error('The provider returned an invalid download redirect.');
    u = new URL(location, u);
  }
  throw Error('The model download redirected too many times.');
}
