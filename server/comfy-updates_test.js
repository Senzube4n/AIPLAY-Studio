// Public release checks: mocked GitHub, synthetic time, and isolated disk cache.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareComfyVersions, createComfyReleaseChecker } from "./comfy-updates.js";

const API = "https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest";
const published = "2026-10-15T22:57:45Z";
const body = (extra = {}) => ({ tag_name: "v0.41.0", published_at: published, draft: false, prerelease: false, ...extra });
const response = (data = body(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-comfy-updates-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("version comparison is numeric, optional-v, exact, and rejects nightly descriptions", () => {
  assert.equal(compareComfyVersions("v0.9.0", "0.10.0"), -1);
  assert.equal(compareComfyVersions("0.41.0", "v0.36.0"), 1);
  assert.equal(compareComfyVersions("v0.41.0", "0.41.0"), 0);
  assert.equal(compareComfyVersions("1.0.0", "0.999.999"), 1);
  assert.equal(compareComfyVersions("9007199254740993.0.0", "9007199254740992.0.0"), 1);
  for (const value of [null, 41, "nightly", "v0.41.0-3-gabc123", "0.41.0rc1", "0.41", "0.041.0", " 0.41.0", "0.41.0+local", `${"9".repeat(81)}.0.0`]) {
    assert.equal(compareComfyVersions(value, "0.41.0"), null, String(value));
    assert.equal(compareComfyVersions("0.41.0", value), null, String(value));
  }
});

test("latest stable check uses only the fixed unauthenticated GitHub endpoint and derives its URL", async () => {
  const calls = [];
  const checker = createComfyReleaseChecker({ now: () => 123456,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(body({ html_url: "https://untrusted.example/release" })); } });
  const found = await checker.check();
  assert.deepEqual(found, { ok: true, latest: { tag: "v0.41.0", url: "https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.41.0", publishedAt: published }, checkedAt: 123456 });
  assert.equal(calls[0].url, API);
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(Object.keys(calls[0].options.headers).some((key) => /authorization|cookie/i.test(key)), false);
  found.latest.tag = "changed";
  assert.equal((await checker.check()).latest.tag, "v0.41.0", "callers cannot mutate cached metadata");
  assert.equal(calls.length, 1);
});

for (const [label, extra] of [
  ["draft", { draft: true }], ["prerelease", { prerelease: true }],
  ["nightly tag", { tag_name: "nightly" }], ["prerelease tag", { tag_name: "v0.42.0-rc1" }],
  ["missing v", { tag_name: "0.41.0" }], ["path in tag", { tag_name: "v0.41.0/other" }],
  ["missing release flags", { draft: undefined }], ["invalid date", { published_at: "not a date" }],
  ["oversized tag", { tag_name: `v${"9".repeat(81)}.0.0` }],
]) {
  test(`invalid latest response: ${label}`, async () => {
    const checker = createComfyReleaseChecker({ now: () => 1000, fetchImpl: async () => response(body(extra)) });
    const found = await checker.check();
    assert.equal(found.ok, false);
    assert.equal(found.latest, null);
    assert.match(found.error, /invalid stable/);
    assert.equal(found.checkedAt, 1000);
  });
}

test("normal requests cache good results for the configured TTL", async () => {
  let time = 0, calls = 0;
  const checker = createComfyReleaseChecker({ now: () => time, ttlMs: 120_000,
    fetchImpl: async () => { calls++; return response(); } });
  await checker.check();
  time = 119_999; await checker.check();
  assert.equal(calls, 1);
  time = 120_000; await checker.check();
  assert.equal(calls, 2);
});

test("offline failures retain known release metadata and are cached as failures", async () => {
  let time = 0, calls = 0, offline = false;
  const checker = createComfyReleaseChecker({ now: () => time, ttlMs: 120_000,
    fetchImpl: async () => { calls++; if (offline) throw new Error("network offline"); return response(); } });
  await checker.check();
  offline = true; time = 120_000;
  const failed = await checker.check();
  assert.equal(failed.ok, false);
  assert.equal(failed.latest.tag, "v0.41.0");
  assert.match(failed.error, /Could not reach GitHub/);
  time = 239_999;
  assert.deepEqual(await checker.check(), failed);
  assert.equal(calls, 2);
  offline = false; time = 240_000;
  assert.equal((await checker.check()).ok, true);
  assert.equal(calls, 3);
});

test("forced checks bypass TTL after a 60-second floor, including rate-limit failures", async () => {
  let time = 0, calls = 0;
  const checker = createComfyReleaseChecker({ now: () => time,
    fetchImpl: async () => { calls++; return calls === 1 ? response(null, 429) : response(); } });
  const failed = await checker.check();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /rate-limiting/);
  time = 59_999;
  assert.deepEqual(await checker.check({ force: true }), failed);
  assert.equal(calls, 1);
  time = 60_000;
  assert.equal((await checker.check({ force: true })).ok, true);
  assert.equal(calls, 2);
  await checker.check({ force: true });
  assert.equal(calls, 2);
});

test("concurrent forced and normal checks coalesce into one request", async () => {
  const pending = deferred();
  let calls = 0;
  const checker = createComfyReleaseChecker({ now: () => 1000, fetchImpl: () => { calls++; return pending.promise; } });
  const first = checker.check(), second = checker.check(), forced = checker.check({ force: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(response());
  const results = await Promise.all([first, second, forced]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.notEqual(results[0].latest, results[1].latest);
});

test("success and last-known release persist; a fresh failure cache survives restart", async (t) => {
  const dir = await directory(t), cacheFile = path.join(dir, "nested", "release.json");
  let time = 1000;
  const first = createComfyReleaseChecker({ cacheFile, now: () => time, fetchImpl: async () => response() });
  await first.check();
  let calls = 0;
  const restarted = createComfyReleaseChecker({ cacheFile, now: () => time,
    fetchImpl: async () => { calls++; throw new Error("offline"); } });
  assert.equal((await restarted.check()).ok, true);
  assert.equal(calls, 0);
  time += 60_000;
  const failed = await restarted.check({ force: true });
  assert.equal(failed.ok, false);
  const saved = JSON.parse(await readFile(cacheFile, "utf8"));
  assert.equal(saved.lastSuccessful.tag, "v0.41.0");
  assert.equal(saved.result.ok, false);
  const offlineRestart = createComfyReleaseChecker({ cacheFile, now: () => time,
    fetchImpl: async () => { assert.fail("fresh persisted failure should be cached"); } });
  assert.deepEqual(await offlineRestart.check(), failed);
  assert.deepEqual(await readdir(path.dirname(cacheFile)), ["release.json"], "atomic writes leave no temporary file");
});

test("a stale persisted success is retained on a failed refresh", async (t) => {
  const dir = await directory(t), cacheFile = path.join(dir, "release.json");
  await createComfyReleaseChecker({ cacheFile, now: () => 0, fetchImpl: async () => response() }).check();
  const checker = createComfyReleaseChecker({ cacheFile, now: () => 6 * 3600e3,
    fetchImpl: async () => response(null, 503) });
  const failed = await checker.check();
  assert.equal(failed.ok, false);
  assert.equal(failed.latest.tag, "v0.41.0");
  assert.match(failed.error, /503/);
});

test("corrupt cache and unwritable cache destinations do not fail a successful check", async (t) => {
  const dir = await directory(t), cacheFile = path.join(dir, "release.json");
  await writeFile(cacheFile, "not JSON");
  assert.equal((await createComfyReleaseChecker({ cacheFile, fetchImpl: async () => response() }).check()).ok, true);
  const destination = path.join(dir, "is-a-directory");
  await mkdir(destination);
  assert.equal((await createComfyReleaseChecker({ cacheFile: destination, fetchImpl: async () => response() }).check()).ok, true);
  assert.equal((await readdir(dir)).some((name) => name.endsWith(".tmp")), false);
});

test("persisted release URLs are re-derived instead of trusted", async (t) => {
  const dir = await directory(t), cacheFile = path.join(dir, "release.json");
  const latest = { tag: "v0.41.0", publishedAt: published, url: "https://untrusted.example/" };
  await writeFile(cacheFile, JSON.stringify({ version: 1, result: { ok: true, latest, checkedAt: 1000 }, lastSuccessful: latest }));
  const checker = createComfyReleaseChecker({ cacheFile, now: () => 1000, fetchImpl: async () => { assert.fail("fresh cache should be used"); } });
  assert.equal((await checker.check()).latest.url, "https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.41.0");
});

test("cached reads memory or disk without fetching, even when the saved result is stale", async (t) => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(); };
  assert.equal(await createComfyReleaseChecker({ fetchImpl }).cached(), null);
  const dir = await directory(t), cacheFile = path.join(dir, "release.json");
  const latest = { tag: "v0.41.0", publishedAt: published };
  await writeFile(cacheFile, JSON.stringify({ version: 1,
    result: { ok: false, latest, checkedAt: 1000, error: "Offline previously." }, lastSuccessful: latest }));
  const checker = createComfyReleaseChecker({ cacheFile, now: () => 12 * 3600e3, fetchImpl });
  const saved = await checker.cached();
  assert.equal(saved.ok, false);
  assert.equal(saved.checkedAt, 1000);
  assert.equal(saved.latest.tag, "v0.41.0");
  saved.latest.tag = "changed by caller";
  assert.equal((await checker.cached()).latest.tag, "v0.41.0");
  assert.equal(calls, 0);
});

test("timeout and malformed JSON failures are safe results", async () => {
  for (const fetchImpl of [
    async () => { throw new DOMException("late", "TimeoutError"); },
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } }),
    async () => response(null, 403),
  ]) {
    const checker = createComfyReleaseChecker({ now: () => 1000, fetchImpl });
    const failed = await checker.check();
    assert.equal(failed.ok, false);
    assert.equal(failed.latest, null);
    assert.ok(failed.error);
  }
});

test("the configured timeout aborts a stalled release request", { timeout: 1000 }, async (t) => {
  // AbortSignal.timeout is unref'd; keep this isolated mock alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const checker = createComfyReleaseChecker({ timeoutMs: 5, now: () => 1000,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const failed = await checker.check();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /did not answer in time/);
});
