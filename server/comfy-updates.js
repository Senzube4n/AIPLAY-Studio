/** Public ComfyUI stable-release checks. No engine files or packages are changed. */
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const RELEASE_API = "https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest";
const RELEASE_URL = "https://github.com/Comfy-Org/ComfyUI/releases/tag/";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const MAX_VERSION_LENGTH = 80;
const FORCE_FLOOR_MS = 60_000;
const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "AIPLAY-Studio" };
class CheckError extends Error {}

/** Numeric release versions only. Nightly descriptions and prereleases are unknown. */
export function compareComfyVersions(a, b) {
  const parts = (value) => {
    if (typeof value !== "string" || value.length > MAX_VERSION_LENGTH
      || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
    return value.replace(/^v/, "").split(".").map(BigInt);
  };
  const left = parts(a), right = parts(b);
  if (!left || !right) return null;
  for (let i = 0; i < left.length; i++) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

function release(tag, publishedAt) {
  if (typeof tag !== "string" || tag.length > MAX_VERSION_LENGTH || !STABLE_TAG.test(tag)
    || typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt))) return null;
  return { tag, url: `${RELEASE_URL}${tag}`, publishedAt };
}
const copy = (result) => ({ ...result, latest: result.latest ? { ...result.latest } : null });

export function createComfyReleaseChecker({ fetchImpl = fetch, now = Date.now, cacheFile = null,
  ttlMs = 6 * 3600e3, timeoutMs = 6000 } = {}) {
  let cached = null, lastSuccessful = null, loading = null, inFlight = null;

  function load() {
    if (!loading) loading = (async () => {
      if (!cacheFile) return;
      try {
        const data = JSON.parse(await readFile(cacheFile, "utf8"));
        if (data?.version !== 1) return;
        lastSuccessful = release(data.lastSuccessful?.tag, data.lastSuccessful?.publishedAt);
        const r = data.result;
        if (typeof r?.ok !== "boolean" || !Number.isFinite(r.checkedAt) || r.checkedAt < 0) return;
        const latest = release(r.latest?.tag, r.latest?.publishedAt);
        if (r.ok && !latest) return;
        lastSuccessful ||= latest;
        cached = { ok: r.ok, latest: r.ok ? latest : lastSuccessful, checkedAt: r.checkedAt,
          ...(!r.ok ? { error: typeof r.error === "string" ? r.error.slice(0, 300) : "Could not reach GitHub." } : {}) };
      } catch { /* a missing, unreadable or corrupt cache never prevents a check */ }
    })();
    return loading;
  }

  async function save() {
    if (!cacheFile) return;
    const temporary = `${cacheFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, result: cached, lastSuccessful }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await rename(temporary, cacheFile);
    } catch { /* persistence is best effort; keep the valid in-memory result */ }
    finally { await unlink(temporary).catch(() => {}); }
  }

  async function request() {
    try {
      const response = await fetchImpl(RELEASE_API, { headers: { ...HEADERS }, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 403 || response.status === 429) throw new CheckError("GitHub is rate-limiting this address. Try again later.");
      if (!response.ok) throw new CheckError(`GitHub answered ${response.status}.`);
      let data;
      try { data = await response.json(); } catch { throw new CheckError("GitHub returned an invalid ComfyUI release."); }
      const latest = release(data?.tag_name, data?.published_at);
      if (data?.draft !== false || data?.prerelease !== false || !latest) throw new CheckError("GitHub returned an invalid stable ComfyUI release.");
      lastSuccessful = latest;
      cached = { ok: true, latest, checkedAt: now() };
    } catch (error) {
      const reason = error instanceof CheckError ? error.message
        : error?.name === "TimeoutError" || error?.name === "AbortError" ? "GitHub did not answer in time." : "Could not reach GitHub.";
      cached = { ok: false, latest: lastSuccessful, checkedAt: now(), error: reason };
    }
    await save();
    return cached;
  }

  async function check({ force = false } = {}) {
    await load();
    if (inFlight) return copy(await inFlight);
    const age = cached ? now() - cached.checkedAt : -1;
    if (cached && age >= 0 && (force ? age < FORCE_FLOOR_MS : age < ttlMs)) return copy(cached);
    inFlight = request().finally(() => { inFlight = null; });
    return copy(await inFlight);
  }

  async function peek() {
    await load();
    return cached ? copy(cached) : null;
  }

  return { check, cached: peek };
}
