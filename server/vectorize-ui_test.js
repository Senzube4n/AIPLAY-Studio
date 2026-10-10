import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVectorizer, vectorOptions, vectorCleanup } from '../web/vectorize-controls.js';

function setup(request) {
  const values = { iedVecMode: 'logo', iedVecQuality: 'high', iedVecColors: '16', iedVecDetail: '1.2',
    iedVecArea: '0', iedVecAlpha: '127', iedVecTolerance: '0.5', iedVecSize: '4096',
    iedVecFillColor: '#ff0000', iedVecStart: '#112233', iedVecEnd: '#ddeeff', iedVecAngle: '90',
    iedVecCleanType: 'smooth', iedVecCleanStrength: '0.7', iedVecCleanDeviation: '4', iedVecCompareMode: 'after' };
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, { value: values[id] || '', hidden: false, disabled: false,
      textContent: '', className: '', children: [],
      replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); },
      removeAttribute(key) { delete this[key]; },
      get selectedOptions() { return this.children.filter((option) => option.selected); } });
    return els.get(id);
  };
  let name = 'badge.png';
  const errors = [], results = [];
  const controller = createVectorizer({ get, currentName: () => name, request,
    onResult: async (r, show) => { results.push({ r, show }); if (show) { name = r.name; controller.open(name); } },
    onError: (e) => errors.push(e.message) });
  return { get, controller, errors, results, open(n, meta) { name = n; controller.open(n, meta); } };
}

const result = (options = {}) => ({ ok: true, name: 'badge_v_unique.svg', width: 4096, height: 4096,
  sourceWidth: 4096, sourceHeight: 4096, paths: 2, bytes: 2048,
  palette: ['#ff0000', '#c3c3c3'], warnings: [], settings: options });
const shapes = [
  { id: 'red-0', color: '#ff0000', contour: 0, bounds: [10, 20, 200, 200], hole: false, area: 25000 },
  { id: 'red-1', color: '#ff0000', contour: 1, bounds: [40, 50, 140, 140], hole: true, area: 12000 },
  { id: 'red-2', color: '#ff0000', contour: 2, bounds: [240, 30, 50, 100], hole: false, area: 3000 },
  { id: 'gray-0', color: '#c3c3c3', contour: 0, bounds: [30, 240, 150, 100], hole: false, area: 12000 },
];
const traceFingerprint = 'a'.repeat(64);
const cleanResult = (options = {}, overrides = {}) => ({ ...result(options), shapes, traceFingerprint,
  url: '/api/image/badge_v_unique.svg', ...overrides });
const select = (h, ...contours) => {
  for (const option of h.get('iedVecShapes').children) option.selected = contours.includes(Number(option.value.split(':')[1]));
  h.get('iedVecShapes').onchange();
};

test('all visible trace controls reach the request, including zero minimum area', async () => {
  const bodies = [];
  const h = setup(async (body) => { bodies.push(body); return result(body); });
  await h.get('iedVecGo').onclick();
  assert.deepEqual(bodies[0], { name: 'badge.png', mode: 'logo', quality: 'high', colors: 16,
    detail: 1.2, minArea: 0, alphaThreshold: 127, tolerance: .5, maxSize: 4096 });
  assert.match(h.get('iedVecStatus').textContent, /4096 × 4096.*2 paths.*2.0 KB/);
  assert.equal(h.get('iedVecFill').hidden, false);
  assert.equal(h.get('iedVecGo').disabled, true, 'SVG cannot be submitted as a raster');
  assert.equal(h.controller.hasSource(), true, 'the generated SVG retains a fill source');
  assert.equal(h.get('iedVecTolerance').disabled, true, 'SVG trace settings describe captured geometry');
});

test('gradient workflow retains source/options, maps only the selected fill, and keeps prior maps', async () => {
  const bodies = [];
  const h = setup(async (body) => { bodies.push(body); return result(body); });
  await h.controller.trace();
  h.get('iedVecTolerance').value = '3'; // A fill uses the captured geometry settings.
  await h.controller.fill();
  assert.equal(bodies[1].name, 'badge.png');
  assert.equal(bodies[1].tolerance, .5);
  assert.deepEqual(bodies[1].gradients, [{ color: '#ff0000', angle: 90,
    stops: [{ offset: 0, color: '#112233' }, { offset: 1, color: '#ddeeff' }] }]);
  h.get('iedVecFillColor').value = '#c3c3c3';
  await h.controller.fill();
  assert.equal(bodies[2].gradients.length, 2);
  h.get('iedVecFillColor').value = '#ff0000';
  await h.controller.fill();
  assert.equal(bodies[3].gradients.length, 2, 'editing an existing map replaces it');
});

test('worker failure and network errors restore controls and report the error', async () => {
  for (const request of [async () => ({ error: 'Too many contours' }), async () => { throw new Error('Network failed'); }]) {
    const h = setup(request);
    await h.controller.trace();
    assert.equal(h.get('iedVecGo').disabled, false);
    assert.equal(h.get('iedVecGo').textContent, 'Trace to SVG');
    assert.equal(h.get('iedVecStatus').textContent, 'Trace failed');
    assert.equal(h.errors.length, 1);
    assert.equal(h.get('iedVecFill').hidden, true);
  }
});

test('opening unrelated images clears gradients; saved generated SVG restores its raster receipt', async () => {
  const h = setup(async (body) => result(body));
  await h.controller.trace();
  h.open('other.png');
  assert.equal(h.get('iedVecFill').hidden, true);
  h.open('saved.svg', { vectorFrom: 'badge.png', vectorization: result({ mode: 'logo', quality: 'high', colors: 6 }) });
  assert.equal(h.get('iedVecFill').hidden, false);
  assert.equal(h.get('iedVecGo').disabled, true);
  assert.equal(h.get('iedVecColors').value, '6', 'saved SVG settings are restored');
  h.open('unrelated.svg');
  assert.equal(h.controller.hasSource(), false);
  assert.equal(h.get('iedVecFill').hidden, true);
  await h.controller.trace();
  assert.match(h.errors.at(-1), /original raster/);
});

test('late results do not replace an image opened while tracing; duplicate clicks submit once', async () => {
  let resolve, calls = 0;
  const h = setup(() => { calls++; return new Promise((r) => { resolve = r; }); });
  const pending = h.controller.trace();
  await h.controller.trace();
  h.open('other.png');
  resolve(result()); await pending;
  assert.equal(calls, 1);
  assert.equal(h.results[0].show, false);
  assert.equal(h.get('iedVecFill').hidden, true);
});

test('auto preset fields are omitted and invalid values never submit', async () => {
  const h = setup(async () => result());
  h.get('iedVecTolerance').value = ''; h.get('iedVecSize').value = '';
  const opts = vectorOptions(h.get);
  assert.equal('tolerance' in opts, false); assert.equal('maxSize' in opts, false);
  h.get('iedVecAlpha').value = 'NaN';
  await h.controller.trace();
  assert.match(h.errors.at(-1), /Invalid alphaThreshold/);
});

test('alpha shape mode reaches the shared worker contract', async () => {
  let body;
  const h = setup(async (options) => { body = options; return result(options); });
  h.get('iedVecMode').value = 'silhouette';
  await h.controller.trace();
  assert.equal(body.mode, 'silhouette');
});

test('reopening a saved multi-stop fill restores endpoints and keeps interior stops when edited', async () => {
  let body;
  const h = setup(async (options) => { body = options; return result(options); });
  const gradients = [{ color: '#ff0000', angle: 45, stops: [
    { offset: 0, color: '#aa00ff' }, { offset: .4, color: '#00ff00' }, { offset: 1, color: '#00aaff' }] }];
  h.open('saved.svg', { vectorFrom: 'badge.png', vectorization: result({ gradients }) });
  assert.equal(h.get('iedVecStart').value, '#aa00ff');
  assert.equal(h.get('iedVecEnd').value, '#00aaff');
  assert.equal(h.get('iedVecAngle').value, '45');
  h.get('iedVecEnd').value = '#0000ff';
  await h.controller.fill();
  assert.deepEqual(body.gradients[0].stops, [gradients[0].stops[0], gradients[0].stops[1], { offset: 1, color: '#0000ff' }]);
});

test('selected cleanup sends original trace settings, whole outline indices and fingerprint, then opens the new SVG', async () => {
  const bodies = [];
  const h = setup(async (body) => { bodies.push(body); return cleanResult(body, { name: `take_${bodies.length}.svg` }); });
  await h.controller.trace();
  assert.equal(h.get('iedVecClean').hidden, false);
  assert.equal(h.get('iedVecCleanGo').disabled, true);
  assert.match(h.get('iedVecShapes').children[1].textContent, /Hole 2/);
  select(h, 0, 1);
  assert.equal(h.get('iedVecCleanGo').disabled, false);
  h.get('iedVecCleanType').value = 'concentric';
  h.get('iedVecTolerance').value = '3';
  await h.get('iedVecCleanGo').onclick();
  assert.equal(bodies[1].name, 'badge.png');
  assert.equal(bodies[1].tolerance, .5);
  assert.equal(bodies[1].basis, traceFingerprint);
  assert.deepEqual(bodies[1].cleanup, { operations: [{ type: 'concentric', color: '#ff0000', contours: [0, 1], maxDeviation: 4 }] });
  assert.equal(h.results[1].r.name, 'take_2.svg');
  assert.equal(h.results[1].show, true);
  assert.equal(h.get('iedVecGo').disabled, true);
});

test('successive cleanup retains untouched operations and replaces overlapping selected outlines', async () => {
  const bodies = [];
  const h = setup(async (body) => { bodies.push(body); return cleanResult(body); });
  await h.controller.trace();
  select(h, 0, 1); await h.controller.clean();
  select(h, 2); h.get('iedVecCleanType').value = 'parallelogram'; await h.controller.clean();
  assert.equal(bodies[2].cleanup.operations.length, 2);
  assert.deepEqual(bodies[2].cleanup.operations[0].contours, [0, 1]);
  select(h, 1); h.get('iedVecCleanType').value = 'circle'; await h.controller.clean();
  assert.deepEqual(bodies[3].cleanup.operations.map((operation) => operation.contours), [[0], [2], [1]]);
  assert.equal(bodies[3].cleanup.operations[0].strength, .7);
  assert.equal('strength' in bodies[3].cleanup.operations[2], false);
});

test('partial replacement of concentric rings is rejected while independent cleanup and full replacement remain valid', async () => {
  const bodies = [];
  const h = setup(async (body) => { bodies.push(body); return cleanResult(body); });
  await h.controller.trace();
  h.get('iedVecCleanType').value = 'concentric'; select(h, 0, 1); await h.controller.clean();
  h.get('iedVecCleanType').value = 'parallelogram'; select(h, 2); await h.controller.clean();
  assert.deepEqual(bodies[2].cleanup.operations[0].contours, [0, 1], 'unrelated cleanup retains the whole concentric pair');
  h.get('iedVecCleanType').value = 'circle'; select(h, 0); await h.controller.clean();
  assert.equal(bodies.length, 3, 'a partial replacement never submits an invalid leftover concentric operation');
  assert.match(h.errors.at(-1), /Select all outlines of the earlier concentric edit/);
  assert.equal(h.get('iedVecCleanGo').disabled, false, 'selection can be corrected after rejection');
  select(h, 0, 1); await h.controller.clean();
  assert.equal(bodies.length, 4);
  assert.deepEqual(bodies[3].cleanup.operations.map((operation) => [operation.type, operation.contours]),
    [['parallelogram', [2]], ['circle', [0, 1]]], 'full replacement preserves the unrelated operation');
});

test('restored cleanup and composition survive gradient editing without tracing the SVG', async () => {
  let body;
  const h = setup(async (request) => { body = request; return cleanResult(request); });
  const cleanup = { operations: [{ type: 'circle', color: '#ff0000', contours: [0], maxDeviation: 4 }] };
  const composition = { groups: [{ color: '#ff0000', contours: [0, 1] }] };
  h.open('saved.svg', { vectorFrom: 'badge.png', vectorization: cleanResult({ tolerance: .8, cleanup, composition }) });
  await h.controller.fill();
  assert.equal(body.name, 'badge.png');
  assert.equal(body.tolerance, .8);
  assert.equal(body.basis, traceFingerprint);
  assert.deepEqual(body.cleanup, cleanup); assert.deepEqual(body.composition, composition);
  assert.equal(body.gradients.length, 1);
});

test('cleanup rejects cross-palette, stale selections, invalid bounds and receipts without a fingerprint', async () => {
  let calls = 0;
  const h = setup(async (body) => { calls++; return cleanResult(body); });
  await h.controller.trace();
  const get = (id) => id === 'iedVecShapes' ? { selectedOptions: [{ value: '#ff0000:0' }, { value: '#c3c3c3:0' }] } : h.get(id);
  assert.throws(() => vectorCleanup(get, cleanResult()), /one traced color/);
  select(h, 0); h.get('iedVecCleanDeviation').value = '33'; await h.controller.clean();
  assert.equal(calls, 1); assert.match(h.errors.at(-1), /0.5 to 32/);
  h.get('iedVecCleanDeviation').value = '4'; h.get('iedVecCleanType').value = 'concentric'; await h.controller.clean();
  assert.equal(calls, 1); assert.match(h.errors.at(-1), /2 to 16/);
  h.get('iedVecCleanType').value = 'smooth';
  h.get('iedVecCleanDeviation').value = '4'; h.get('iedVecCleanStrength').value = 'NaN'; await h.controller.clean();
  assert.equal(calls, 1); assert.match(h.errors.at(-1), /Smoothness/);
  const stale = (id) => id === 'iedVecShapes' ? { selectedOptions: [{ value: '#ff0000:5000' }] } : h.get(id);
  assert.throws(() => vectorCleanup(stale, cleanResult()), /current trace/);
  h.open('old.svg', { vectorFrom: 'badge.png', vectorization: { ...cleanResult(), traceFingerprint: undefined } });
  assert.equal(h.get('iedVecCleanGo').disabled, true);
  await h.controller.clean(); assert.equal(calls, 1); assert.match(h.errors.at(-1), /Trace this image again/);
});

test('comparison switches original/result, updates a new SVG, clears unrelated images and ignores late cleanup', async () => {
  let resolve;
  const h = setup(async (body) => cleanResult(body));
  await h.controller.trace();
  assert.equal(h.get('iedVecCompareImage').src, '/api/image/badge_v_unique.svg');
  h.get('iedVecCompareMode').value = 'before'; h.get('iedVecCompareMode').onchange();
  assert.equal(h.get('iedVecCompareImage').src, '/api/image/badge.png');
  h.get('iedVecCompareMode').value = 'after';
  h.open('saved.svg', { vectorFrom: 'badge.png', vectorization: cleanResult({}, { url: '/api/image/saved.svg' }) });
  assert.equal(h.get('iedVecCompareImage').src, '/api/image/saved.svg');
  h.open('other.png');
  assert.equal(h.get('iedVecCompare').hidden, true); assert.equal(h.get('iedVecCompareImage').src, undefined);
  const pending = setup(() => new Promise((r) => { resolve = r; }));
  pending.open('saved.svg', { vectorFrom: 'badge.png', vectorization: cleanResult() });
  select(pending, 0); const task = pending.controller.clean();
  assert.equal(pending.get('iedVecCleanGo').disabled, true);
  pending.open('other.png'); resolve(cleanResult({}, { name: 'cleaned.svg' })); await task;
  assert.equal(pending.results[0].show, false);
  assert.equal(pending.get('iedVecCompare').hidden, true);
  assert.equal(pending.get('iedVecCompareImage').src, undefined);
});

test('outline list is capped and old SVG receipts keep cleanup gated', () => {
  const h = setup(async () => cleanResult());
  const many = Array.from({ length: 1000 }, (_, contour) => ({ ...shapes[0], contour }));
  h.open('many.svg', { vectorFrom: 'badge.png', vectorization: cleanResult({}, { shapes: many, shapesTruncated: true }) });
  assert.equal(h.get('iedVecShapes').children.length, 512);
  assert.match(h.get('iedVecShapeNote').textContent, /512 outlines/);
  h.open('legacy.svg', { vectorFrom: 'badge.png', vectorization: result() });
  assert.equal(h.get('iedVecShapes').disabled, true);
  assert.match(h.get('iedVecShapeNote').textContent, /Trace again/);
});

test('editor binds the controller and keeps all trace controls in the existing panel', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  for (const id of ['iedVec', 'iedVecGo', 'iedVecColors', 'iedVecMode', 'iedVecQuality', 'iedVecDetail', 'iedVecTolerance',
    'iedVecArea', 'iedVecAlpha', 'iedVecSize', 'iedVecFillColor', 'iedVecStart', 'iedVecEnd', 'iedVecAngle',
    'iedVecClean', 'iedVecCleanGo', 'iedVecShapes', 'iedVecShapeColor', 'iedVecCleanType', 'iedVecCleanStrength',
    'iedVecCleanDeviation', 'iedVecCompare', 'iedVecCompareMode', 'iedVecCompareImage']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /iedVectorizer\.open\(name, m\)/);
  assert.match(app, /createVectorizer\(\{/);
  assert.match(app, /\$\("iedVec"\)\.hidden = isFinal && !iedVectorizer\?\.hasSource\(\)/);
});

// Controller tests need only DOM construction, never a browser or image engine.
globalThis.document = { createElement: () => ({ value: '', textContent: '' }) };
