import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const begin = source.indexOf('if (action === "image_render")');
const end = source.indexOf('if (action === "image_send_back")', begin);
assert.ok(begin > 0 && end > begin, "extract the real image render route");
const route = source.slice(begin, end);

function fixture({ state = "failed", retry = false, fetchResult = "ok" } = {}) {
  const fromFp = "a".repeat(32);
  const row = { id: "o_0123456789ab", jobType: "image", state,
    imageId: state === "failed" ? "iold" : null, stagedRefs: [], imageJob: {}, from: { fp: fromFp } };
  const settings = { prompt: "A dancer", seed: 42, width: 1024, height: 1024, steps: 25,
    cfg: 1, sampler: "euler", scheduler: "simple", references: [], count: 1, refSizing: "custom" };
  const calls = { fetch: 0, transitions: [] };
  const book = {
    findOrder: async () => ({ ...row }),
    transitionOrderState: async ({ from, to, patch }) => {
      if (row.state !== from) throw Object.assign(new Error("concurrent change"), { reason: "order-state-changed" });
      calls.transitions.push([from, to]);
      Object.assign(row, patch, { state: to });
      return { ...row };
    },
  };
  const context = {
    action: "image_render", b: { id: row.id, ...(retry ? { retry: true } : {}) }, res: {}, outDir: "collab", appData: "app",
    book, config: { inputDir: "input", uiPort: 4173 }, QWEN_IMAGE_FILES: { dit: "dit", encoder: "enc", vae: "vae" },
    collabIdentity: async () => ({ fp: "b".repeat(32) }),
    collabRoster: { roster: async () => ({ peers: [{ fp: fromFp, verified: true, role: "lender" }] }) },
    readStoredImageJob: () => ({ returnTo: { fp: fromFp }, job: settings }),
    qwenImageStatus: async () => ({ ready: true }),
    fetch: async () => {
      calls.fetch++;
      if (fetchResult === "uncertain") throw new Error("socket lost");
      return fetchResult === "refused" ? { ok: false, status: 409, json: async () => ({ error: "Queue refused" }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, id: "inew", seed: 42 }) };
    },
    art: { status: () => ({ art: { recent: [] } }) }, recentImageOutcome: () => null,
    recordImageOutcome: async () => {},
    json: (_res, status, body) => ({ status, body }),
  };
  return { row, calls, run: () => vm.runInNewContext(`(async () => { ${route} })()`, context) };
}

test("failed image requires an explicit retry; uncertain rendering is never retried", async () => {
  const failed = fixture();
  const refused = await failed.run();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, "retry-review-required");
  assert.equal(failed.calls.fetch, 0);
  const uncertain = fixture({ state: "rendering", retry: true });
  const locked = await uncertain.run();
  assert.equal(locked.status, 409);
  assert.equal(locked.body.reason, "already-rendering");
  assert.equal(uncertain.calls.fetch, 0);
});

test("explicit retry claims only a confirmed failed row and queues one new image", async () => {
  const f = fixture({ retry: true });
  const r = await f.run();
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "queued");
  assert.equal(f.calls.fetch, 1);
  assert.deepEqual(f.calls.transitions, [["failed", "rendering"], ["rendering", "queued"]]);
  assert.equal(f.row.imageId, "inew");
  assert.equal(f.row.lastFailedImageId, "iold");
  assert.equal(f.row.retryCount, 1);
});

test("a lost queue answer stays locked; a definite refusal returns to failed", async () => {
  const lost = fixture({ retry: true, fetchResult: "uncertain" });
  const unknown = await lost.run();
  assert.equal(unknown.body.reason, "render-uncertain");
  assert.equal(lost.row.state, "rendering");
  const refused = fixture({ retry: true, fetchResult: "refused" });
  const no = await refused.run();
  assert.equal(no.body.reason, "render-refused");
  assert.equal(refused.row.state, "failed");
  assert.equal(refused.calls.fetch, 1);
});
