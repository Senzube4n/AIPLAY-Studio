import test from "node:test";
import assert from "node:assert/strict";
import { createPreviewStore, assertPreviewFresh, previewHash } from "./preview.js";

const peer = { fp: "a".repeat(32), sign: "sign", seal: "seal", nickname: "Friend", role: "lender" };
const payload = { kind: "resources", at: 1, note: "Evenings" };
const create = (store, extra = {}) => store.create({ payload, peer, name: "card.aiplay", ...extra });

test("snapshots are immutable, single use, and expire without retaining bytes", () => {
  let now = 100;
  const store = createPreviewStore({ now: () => now, ttlMs: 20 });
  const packet = { ...payload };
  const first = create(store, { payload: packet });
  packet.note = "Edited";
  first.packet.note = "Client edit";
  assert.equal(store.take(first.previewId).payload.note, "Evenings");
  assert.throws(() => store.take(first.previewId), { reason: "preview-expired" });
  const expired = create(store);
  now += 20;
  assert.equal(store.size, 0);
  assert.throws(() => store.take(expired.previewId), { reason: "preview-expired" });
});

test("memory and entry bounds evict old previews and reject oversized packets", () => {
  const store = createPreviewStore({ maxBytes: 140, maxEntries: 2 });
  const old = create(store);
  const retained = create(store);
  const newest = create(store);
  assert.equal(store.size, 2);
  assert.throws(() => store.take(old.previewId), { reason: "preview-expired" });
  assert.equal(store.take(retained.previewId).payload.kind, "resources");
  assert.equal(store.take(newest.previewId).payload.kind, "resources");
  assert.throws(() => create(store, { payload: { kind: "resources", note: "x".repeat(141) } }), { reason: "preview-too-large" });
});

test("freshness rejects changed recipient keys, missing assets, and unsafe filenames before a read", async () => {
  const store = createPreviewStore();
  const document = { slug: "example", title: "Scene" };
  const picture = Buffer.from("test fixture");
  const created = create(store, { document, slug: "example", payload: { kind: "shot", refs: [{ file: "ref.png", bytes: picture.length, sha256: previewHash(picture) }] } });
  const frozen = store.take(created.previewId);
  let reads = 0;
  const checks = { peer, readProject: async () => document, assetsDir: () => "assets", readAsset: async () => { reads++; return picture; } };
  await assertPreviewFresh(frozen, checks);
  assert.equal(reads, 1);
  await assert.rejects(assertPreviewFresh(frozen, { ...checks, peer: { ...peer, seal: "different" } }), { reason: "preview-stale" });
  await assert.rejects(assertPreviewFresh(frozen, { ...checks, readAsset: async () => { throw new Error("missing"); } }), { reason: "preview-stale" });
  await assert.rejects(assertPreviewFresh({ ...frozen, manifest: [{ ...frozen.manifest[0], file: "../secret.png" }] }, checks), { reason: "preview-stale" });
  assert.equal(reads, 1);
});
