import test from "node:test";
import assert from "node:assert/strict";
import { machineBusy, readWorkload } from "./free.js";

const reading = (engine) => ({
  art: { paused: false, current: null, queued: 0 },
  jobs: { current: null, queue: [] },
  plansRunning: [],
  engine: { ready: true, queue: { running: 0, pending: 0 }, running: [], ...engine },
});

test("a running chat turn alone does not make the card unavailable", () => {
  const state = machineBusy(reading({ queue: { running: 1, pending: 0, briefChatRunning: 1, briefChatPending: 0 },
    running: [{ via: "chat", state: "running" }] }));
  assert.equal(state.busy, false);
  assert.equal(state.reason, null);
});

test("untracked GPU work remains busy beside a running chat turn", () => {
  const state = machineBusy(reading({ queue: { running: 2, pending: 0, briefChatRunning: 1, briefChatPending: 0 },
    running: [{ via: "chat", state: "running" }] }));
  assert.equal(state.busy, true);
  assert.equal(state.reason, "engine-busy");
});

test("queued chat work cannot be subtracted from running GPU work", () => {
  const state = machineBusy(reading({ queue: { running: 1, pending: 1 },
    running: [{ via: "chat", state: "queued" }] }));
  assert.equal(state.reason, "engine-busy");
  assert.match(state.why, /running on the card/);
});

test("a queued chat turn is discounted but an unrelated queued render is not", () => {
  const chat = [{ via: "chat", state: "queued" }];
  assert.equal(machineBusy(reading({ queue: { running: 0, pending: 1, briefChatPending: 1 }, running: chat })).busy, false);
  const other = machineBusy(reading({ queue: { running: 0, pending: 2, briefChatPending: 1 }, running: chat }));
  assert.equal(other.reason, "engine-busy");
  assert.match(other.why, /waiting on the card/);
});

test("a stale local chat row cannot hide an unrelated engine job", () => {
  const state = machineBusy(reading({ queue: { running: 1, pending: 0, briefChatRunning: 0 },
    running: [{ via: "chat", state: "running" }] }));
  assert.equal(state.reason, "engine-busy");
});

test("a ready engine with no trustworthy queue reading cannot report idle", () => {
  for (const queue of [null, { running: null, pending: 0 }, { running: 0 }]) {
    const state = machineBusy(reading({ queue }));
    assert.equal(state.busy, true);
    assert.equal(state.reason, "engine-unreachable");
  }
});

test("unreadable local queues cannot become idle or an overridable busy verdict", async () => {
  const engineStatus = async () => ({ ready: true, queue: { running: 0, pending: 0 }, running: [] });
  const readings = await readWorkload({ artStatus: async () => { throw new Error("disk read failed"); },
    jobsStatus: async () => ({ current: null, queue: [] }), anyRunning: async () => [], engineStatus });
  assert.deepEqual(readings.unreadable, ["render queue"]);
  assert.equal(machineBusy(readings).reason, "workload-unreachable");

  const mixed = await readWorkload({ artStatus: async () => ({ art: { paused: false, queued: 0, current: { kind: "clip" } } }),
    jobsStatus: async () => ({ current: null, queue: [] }), anyRunning: async () => { throw new Error("plan unavailable"); }, engineStatus });
  assert.equal(machineBusy(mixed).reason, "workload-unreachable");

  const engineOnly = await readWorkload({ artStatus: async () => ({ art: { paused: false, current: null, queued: 0 } }),
    jobsStatus: async () => ({ current: null, queue: [] }), anyRunning: async () => [],
    engineStatus: async () => { throw new Error("engine unavailable"); } });
  assert.equal(machineBusy(engineOnly).reason, "engine-unreachable");
});
