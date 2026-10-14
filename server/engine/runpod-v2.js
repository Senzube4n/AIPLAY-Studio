/** Runpod control API v2. No credentials in URLs; no terminate/delete surface.
 * Contracts: https://api.runpod.io/v2/openapi.json (reviewed 2026-10-14). */
import { readJsonCapped } from './remote-common.js';

export class CloudError extends Error {
  constructor(code, message, status = null) { super(message); this.code = code; this.status = status; }
}
export function resourceId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new CloudError('invalid_resource', 'Choose a cloud computer first.');
  return id;
}
export function safePod(p) {
  if (!p || !['PROVISIONING', 'STARTING', 'RUNNING', 'EXITED', 'ERROR', 'TERMINATED'].includes(p.status))
    throw new CloudError('invalid_response', 'The provider returned an unrecognized computer state.');
  return { id: resourceId(p.id), name: String(p.name || p.id).slice(0, 100), status: p.status,
    actions: (p.actions || []).filter(a => ['start', 'stop'].includes(a)), cost: Number.isFinite(p.cost) ? p.cost : null,
    gpu: p.gpu ? { id: p.gpu.id, count: p.gpu.count || 1 } : null, cloud: p.cloud,
    dataCenterId: p.dataCenterId, mounts: p.mounts || {}, disk: p.disk,
    locked: !!p.locked, startedAt: p.startedAt || null, createdAt: p.createdAt,
    workerUrl: `https://${p.id}-8787.proxy.runpod.net` };
}

export function createRunpodV2({ getApiKey, fetchFn = fetch, timeoutMs = 30000 }) {
  async function request(route, method = 'GET', body) {
    const key = await getApiKey();
    if (!key) throw new CloudError('credentials_missing', 'Add your RunPod account key in Connection setup.');
    let response;
    try {
      response = await fetchFn(`https://api.runpod.io/v2${route}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new CloudError(method === 'GET' ? 'provider_unreachable' : 'operation_uncertain',
        method === 'GET' ? 'The provider could not be reached. Try checking again.' : 'The response was lost. Checking the existing computer before doing anything else.');
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'credentials_invalid'
        : response.status === 404 ? 'resource_missing' : response.status === 409 ? 'state_conflict'
        : response.status === 429 ? 'rate_limited' : method !== 'GET' && response.status >= 500 ? 'operation_uncertain' : 'provider_error';
      throw new CloudError(code, code === 'credentials_invalid' ? 'Your RunPod key was rejected. Check its permissions.'
        : code === 'resource_missing' ? 'This computer is no longer listed by the provider.'
        : code === 'state_conflict' ? 'The provider cannot make that change in the current state. Check again.'
        : code === 'rate_limited' ? 'The provider is busy. Wait a little before checking again.'
        : 'The provider could not complete this request. Check the computer before retrying.', response.status);
    }
    try { return await readJsonCapped(response); }
    catch { throw new CloudError(method === 'GET' ? 'invalid_response' : 'operation_uncertain', 'The provider response could not be verified. Check again.'); }
  }
  async function list(route, field) {
    const rows = [], seen = new Set(); let cursor = null;
    for (let page = 0; page < 50; page++) {
      const q = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
      const data = await request(`${route}?${q}`);
      if (!Array.isArray(data[field]) || !data.pagination) throw new CloudError('invalid_response', 'The provider resource list could not be verified.');
      rows.push(...data[field]);
      if (!data.pagination.hasNextPage) return rows;
      cursor = data.pagination.nextCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new CloudError('incomplete_discovery', 'The resource list is incomplete. Select and check your existing computer directly.');
  }
  const getPod = async id => {
    const wanted = resourceId(id), pod = safePod(await request(`/pods/${wanted}`));
    if (pod.id !== wanted) throw new CloudError('invalid_response', 'The provider returned a different computer. Check again.');
    return pod;
  };
  return {
    listPods: async () => (await list('/pods', 'pods')).map(safePod), getPod,
    async quote(pod) {
      if (!pod.gpu || !['SECURE', 'COMMUNITY'].includes(pod.cloud)) throw new CloudError('unsupported_computer', 'Choose a supported GPU computer.');
      const q = new URLSearchParams({ include: 'AVAILABILITY', product: 'POD', count: String(pod.gpu.count), cloud: pod.cloud });
      const gpu = await request(`/catalog/gpus/${encodeURIComponent(pod.gpu.id)}?${q}`);
      const rate = gpu.price?.[pod.cloud.toLowerCase()];
      if (!Number.isFinite(rate) || rate < 0) throw new CloudError('price_unknown', 'The current rental price could not be verified.');
      const location = gpu.dataCenters?.find(d => d.id === pod.dataCenterId);
      // Stock elsewhere does not establish availability on this computer's retained host.
      return { rate: rate * pod.gpu.count, source: 'catalog estimate', availability: location?.availability || 'UNKNOWN',
        overallAvailability: gpu.availability || 'UNKNOWN', gpuName: gpu.name || pod.gpu.id };
    },
    async action(id, action) {
      if (!['start', 'stop'].includes(action)) throw new CloudError('unsupported_action', 'Only start and stop are supported.');
      return safePod(await request(`/pods/${resourceId(id)}/action`, 'POST', { action }));
    },
    volume: id => request(`/network-volumes/${resourceId(id)}`),
    async grow(pod, size) {
      const network = pod.mounts.network?.[0];
      if (network) return request(`/network-volumes/${resourceId(network.volumeId)}`, 'PATCH', { size });
      if (!pod.mounts.persistent) throw new CloudError('capacity_unsupported', 'Capacity changes for this storage are managed by the provider.');
      return safePod(await request(`/pods/${resourceId(pod.id)}`, 'PATCH', { mounts: { persistent: { ...pod.mounts.persistent, size } } }));
    },
    billing: (id, start, end) => request(`/billing/pods?${new URLSearchParams({ podId: resourceId(id), startTime: start, endTime: end, bucketSize: 'day' })}`),
    volumeBilling: (id, start, end) => request(`/billing/network-volumes?${new URLSearchParams({ networkVolumeId: resourceId(id), startTime: start, endTime: end, bucketSize: 'day' })}`),
  };
}
