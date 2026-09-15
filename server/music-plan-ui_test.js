import assert from "node:assert/strict";
import { test } from "node:test";
import { mountMusicPlan } from "../web/music-plan-ui.js";

function harness(fetch) {
  const elements = {};
  const doc = { getElementById: id => elements[id] ??= {
    value: "", textContent: "", dataset: {}, disabled: true, handlers: {},
    addEventListener(kind, handler) { this.handlers[kind] = handler; },
  } };
  mountMusicPlan({ document: doc, fetch });
  elements.yPlanBpm.value = '120'; elements.yPlanMeter.value = '4/4'; elements.yPlanLength.value = '180';
  return { elements, fire: (id, kind = 'click') => elements[id].handlers[kind]() };
}
test("planner only proposes; apply is explicit and does not generate or save", async () => {
  const calls = [];
  const h = harness(async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, changed: true, abc: 'new score', bars: 32, bpm: 60, nominal_seconds: 128 }) };
  });
  h.elements.yAbc.value = 'old score';
  await h.fire('yPlanFit');
  assert.deepEqual(calls, [{ url: '/api/music-plan', body: { abc: 'old score', target_seconds: 180 } }]);
  assert.equal(h.elements.yAbc.value, 'old score'); assert.equal(h.elements.yPlanApply.disabled, false);
  h.fire('yPlanApply'); assert.equal(h.elements.yAbc.value, 'new score');
  assert.equal(h.elements.yPlanApply.disabled, true); assert.equal(calls.length, 1);
  assert.match(h.elements.yPlanResult.textContent, /draft only/);
});
test("typing while a request is in flight rejects stale proposed edits", async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  h.elements.yAbc.value = 'old'; const pending = h.fire('yPlanFit');
  h.elements.yAbc.value = 'user edited'; h.fire('yAbc', 'input');
  finish({ ok: true, json: async () => ({ ok: true, changed: true, abc: 'stale' }) }); await pending;
  assert.equal(h.elements.yPlanApply.disabled, true); assert.equal(h.elements.yAbc.value, 'user edited');
});
test("errors and score diagnostics use safe text; outline never applies a melody", async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ ok: false, problems: [{ says: '<script>bad meter</script>' }] }) }));
  await h.fire('yPlanCheck'); assert.match(h.elements.yPlanResult.textContent, /bad meter/);
  assert.equal(h.elements.yPlanApply.disabled, true);
  const o = harness(async (_url, opts) => {
    assert.deepEqual(JSON.parse(opts.body), { bpm: 120, meter: '4/4', target_seconds: 180 });
    return { ok: true, json: async () => ({ ok: true, mode: 'outline', bpm: 120, bars: 90, nominal_seconds: 180 }) };
  });
  await o.fire('yPlanOutline'); assert.equal(o.elements.yPlanApply.disabled, true);
  assert.match(o.elements.yPlanResult.textContent, /Outline only/);
});
