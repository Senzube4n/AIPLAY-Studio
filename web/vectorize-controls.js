// The editor keeps the raster source and effective trace settings when an SVG
// opens. Gradient fills retrace that source; an SVG is never sent to Pillow.
const RASTER = /\.(png|jpe?g|webp)$/i;
const OPTION_KEYS = ['mode', 'quality', 'colors', 'detail', 'tolerance', 'minArea', 'alphaThreshold', 'maxSize'];
const TRACE_CONTROLS = { mode: 'iedVecMode', quality: 'iedVecQuality', colors: 'iedVecColors', detail: 'iedVecDetail',
  tolerance: 'iedVecTolerance', minArea: 'iedVecArea', alphaThreshold: 'iedVecAlpha', maxSize: 'iedVecSize' };
const CLEAN_CONTROLS = ['iedVecShapeColor', 'iedVecShapes', 'iedVecCleanType', 'iedVecCleanStrength', 'iedVecCleanDeviation'];
const SHAPE_LIMIT = 512;
const shapeKey = (shape) => `${shape.color}:${shape.contour}`;
const imageUrl = (name) => `/api/image/${encodeURIComponent(name)}`;
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));

export function vectorOptions(get) {
  const opts = { mode: get('iedVecMode').value, quality: get('iedVecQuality').value,
    colors: Number(get('iedVecColors').value), detail: Number(get('iedVecDetail').value), minArea: Number(get('iedVecArea').value),
    alphaThreshold: Number(get('iedVecAlpha').value) };
  for (const [id, key] of [['iedVecTolerance', 'tolerance'], ['iedVecSize', 'maxSize']]) {
    const value = get(id).value.trim();
    if (value) opts[key] = Number(value);
  }
  const bounds = { colors: [2, 16], detail: [.2, 4], minArea: [0, 10000], alphaThreshold: [1, 255],
    tolerance: [.15, 4], maxSize: [64, 4096] };
  for (const [key, value] of Object.entries(opts)) {
    if (!(key in bounds)) continue;
    const [lo, hi] = bounds[key];
    if (!Number.isFinite(value) || value < lo || value > hi
      || (['colors', 'alphaThreshold', 'maxSize'].includes(key) && !Number.isInteger(value))) {
      throw new Error(`Invalid ${key}. Use ${lo} to ${hi}.`);
    }
  }
  return opts;
}

function effectiveOptions(settings = {}) {
  return Object.fromEntries(OPTION_KEYS.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));
}

/** Selection is checked against the receipt, never inferred from visible option text. */
export function vectorCleanup(get, receipt) {
  if (!receipt || !/^[0-9a-f]{64}$/i.test(receipt.traceFingerprint || '')) {
    throw new Error('Trace this image again before cleaning outlines.');
  }
  const selected = Array.from(get('iedVecShapes').selectedOptions || []);
  if (!selected.length) throw new Error('Select at least one outline.');
  const shapes = new Map((receipt.shapes || []).slice(0, SHAPE_LIMIT).map((shape) => [shapeKey(shape), shape]));
  const chosen = selected.map((option) => shapes.get(option.value));
  if (chosen.some((shape) => !shape)) throw new Error('Choose outlines from the current trace.');
  const color = chosen[0].color;
  if (chosen.some((shape) => shape.color !== color)) throw new Error('Choose outlines from one traced color.');
  const type = get('iedVecCleanType').value;
  if (!['smooth', 'circle', 'concentric', 'parallelogram'].includes(type)) throw new Error('Choose a cleanup operation.');
  const maxDeviation = Number(get('iedVecCleanDeviation').value);
  if (!Number.isFinite(maxDeviation) || maxDeviation < .5 || maxDeviation > 32) {
    throw new Error('Maximum movement must be 0.5 to 32 source pixels.');
  }
  const operation = { type, color, contours: [...new Set(chosen.map((shape) => shape.contour))], maxDeviation };
  if (operation.contours.length > 128) throw new Error('Select up to 128 outlines for one cleanup.');
  if (type === 'concentric' && (operation.contours.length < 2 || operation.contours.length > 16)) {
    throw new Error('Select 2 to 16 outlines for concentric rings.');
  }
  if (type === 'smooth') {
    const strength = Number(get('iedVecCleanStrength').value);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Smoothness must be 0 to 1.');
    operation.strength = strength;
  }
  const contours = new Set(operation.contours);
  const previous = copy(receipt.cleanup?.operations || []).flatMap((prior) => {
    if (prior.color !== color) return [prior];
    const retained = prior.contours.filter((contour) => !contours.has(contour));
    if (prior.type === 'concentric' && retained.length && retained.length !== prior.contours.length) {
      throw new Error('Select all outlines of the earlier concentric edit to replace it.');
    }
    return retained.length ? [{ ...prior, contours: retained }] : [];
  });
  return { operations: [...previous, operation] };
}

export function createVectorizer({ get, currentName, request, onResult, onError = () => {} }) {
  let receipt = null, busy = false;
  const say = (text, tone = 'ok', notes = '') => {
    const status = get('iedVecStatus');
    status.textContent = text; status.className = `chip ${tone}`; status.hidden = !text;
    get('iedVecNotes').textContent = notes; get('iedVecNotes').hidden = !notes;
  };
  const paint = () => {
    const raster = RASTER.test(currentName() || '');
    get('iedVecGo').disabled = busy || !raster;
    for (const id of Object.values(TRACE_CONTROLS)) get(id).disabled = busy || !raster;
    get('iedVecFillGo').disabled = busy || !receipt;
    get('iedVecFill').hidden = !receipt || !receipt.palette?.length;
    const canClean = !!receipt?.shapes?.length && /^[0-9a-f]{64}$/i.test(receipt.traceFingerprint || '');
    get('iedVecClean').hidden = !receipt;
    for (const id of CLEAN_CONTROLS) get(id).disabled = busy || !canClean;
    get('iedVecCleanStrength').disabled ||= get('iedVecCleanType').value !== 'smooth';
    get('iedVecCleanGo').disabled = busy || !canClean || !get('iedVecShapes').selectedOptions?.length;
    get('iedVecCompare').hidden = !receipt;
    get('iedVecCompareMode').disabled = busy || !receipt;
    get('iedVecGo').textContent = busy ? 'Tracing…' : 'Trace to SVG';
  };
  const paintCompare = () => {
    const preview = get('iedVecCompareImage');
    if (!receipt) { preview.removeAttribute('src'); return; }
    const before = get('iedVecCompareMode').value === 'before';
    preview.src = before ? imageUrl(receipt.source) : receipt.url || imageUrl(receipt.name);
    preview.alt = before ? 'Original image before tracing' : 'Vector trace result';
  };
  const paintFill = () => {
    const fill = receipt?.gradients?.find(g => g.color === get('iedVecFillColor').value);
    if (!fill) return;
    get('iedVecStart').value = fill.stops[0].color;
    get('iedVecEnd').value = fill.stops.at(-1).color;
    get('iedVecAngle').value = String(fill.angle || 0);
  };
  const showReceipt = () => {
    if (!receipt) return;
    const r = receipt;
    const dims = `${r.width} × ${r.height}`;
    say(`${dims} · ${r.paths} ${r.paths === 1 ? 'path' : 'paths'} · ${(r.bytes / 1024).toFixed(1)} KB`,
      r.warnings?.length ? 'warn' : 'ok', (r.warnings || []).join(' '));
    const sel = get('iedVecFillColor'), old = sel.value;
    sel.replaceChildren();
    for (const color of r.palette || []) {
      const opt = document.createElement('option'); opt.value = color; opt.textContent = color;
      sel.appendChild(opt);
    }
    if ((r.palette || []).includes(old)) sel.value = old;
    paintFill();
    const shapes = (r.shapes || []).slice(0, SHAPE_LIMIT);
    const colors = [...new Set(shapes.map((shape) => shape.color))];
    const filter = get('iedVecShapeColor'), previous = filter.value;
    filter.replaceChildren();
    for (const color of colors) {
      const opt = document.createElement('option'); opt.value = color; opt.textContent = color;
      filter.appendChild(opt);
    }
    filter.value = colors.includes(previous) ? previous : colors[0] || '';
    paintShapes(); paintCompare();
  };
  const paintShapes = () => {
    const sel = get('iedVecShapes'), chosen = new Set(Array.from(sel.selectedOptions || [], (option) => option.value));
    sel.replaceChildren();
    const shapes = (receipt?.shapes || []).slice(0, SHAPE_LIMIT);
    for (const shape of shapes.filter((shape) => shape.color === get('iedVecShapeColor').value)) {
      const opt = document.createElement('option'); opt.value = shapeKey(shape);
      const [x, y, width, height] = shape.bounds || [];
      opt.textContent = `${shape.hole ? 'Hole' : 'Outline'} ${shape.contour + 1} · ${Math.round(width)} × ${Math.round(height)} · ${Math.round(x)}, ${Math.round(y)}`;
      opt.selected = chosen.has(opt.value); sel.appendChild(opt);
    }
    const note = get('iedVecShapeNote');
    note.textContent = !receipt?.traceFingerprint ? 'Trace again to select outlines.'
      : receipt?.shapesTruncated || (receipt?.shapes?.length || 0) > SHAPE_LIMIT ? 'First 512 outlines shown. Narrow the trace for more.' : '';
    note.hidden = !note.textContent;
    paint();
  };
  const open = (name, meta = {}) => {
    const restore = () => {
      if (/\.svg$/i.test(name) && receipt) {
        for (const [key, id] of Object.entries(TRACE_CONTROLS)) {
          if (receipt.options[key] !== undefined) get(id).value = String(receipt.options[key]);
        }
      }
    };
    if (receipt && (name === receipt.name || name === receipt.source)) {
      restore(); showReceipt(); paint(); return;
    }
    receipt = null;
    if (/\.svg$/i.test(name) && RASTER.test(meta.vectorFrom || '') && meta.vectorization?.palette) {
      receipt = { ...meta.vectorization, name, source: meta.vectorFrom,
        options: effectiveOptions(meta.vectorization.settings),
        gradients: copy(meta.vectorization.settings?.gradients || []),
        cleanup: copy(meta.vectorization.settings?.cleanup || null),
        composition: copy(meta.vectorization.settings?.composition || null) };
    }
    if (receipt) { restore(); showReceipt(); } else { say(''); paintShapes(); paintCompare(); }
    paint();
  };
  const run = async (kind = 'trace') => {
    if (busy) return;
    const active = currentName();
    let source, options, gradients, cleanup = null, composition = null, traceFingerprint;
    try {
      if (kind !== 'trace') {
        if (!receipt) throw new Error('Trace an image before editing outlines or fills.');
        source = receipt.source; options = receipt.options;
        gradients = copy(receipt.gradients || []);
        cleanup = copy(receipt.cleanup); composition = copy(receipt.composition);
        traceFingerprint = receipt.traceFingerprint;
        if (kind === 'cleanup') cleanup = vectorCleanup(get, receipt);
        else {
          const color = get('iedVecFillColor').value;
          const angle = Number(get('iedVecAngle').value);
          if (!receipt.palette.includes(color) || !Number.isFinite(angle) || angle < 0 || angle > 360) {
            throw new Error('Choose a traced fill and an angle from 0 to 360.');
          }
          const previous = receipt.gradients?.find(g => g.color === color);
          const stops = previous ? previous.stops.map(s => ({ ...s })) : [{ offset: 0 }, { offset: 1 }];
          stops[0].color = get('iedVecStart').value;
          stops[stops.length - 1].color = get('iedVecEnd').value;
          if (stops.some((s) => !/^#[0-9a-f]{6}$/i.test(s.color))) throw new Error('Choose valid fill colors.');
          gradients = [...(receipt.gradients || []).filter((g) => g.color !== color), { color, stops, angle }];
        }
      } else {
        if (!RASTER.test(active || '')) throw new Error('Select the original raster image to trace.');
        source = active; options = vectorOptions(get); gradients = [];
      }
      busy = true; paint(); say(kind === 'cleanup' ? 'Cleaning…' : 'Tracing…', 'busy');
      const result = await request({ name: source, ...options, ...(gradients.length ? { gradients } : {}),
        ...(cleanup ? { cleanup } : {}), ...(composition ? { composition } : {}),
        ...(cleanup || composition ? { basis: traceFingerprint } : {}) });
      if (!result?.ok || result.error) throw new Error(result?.error || 'Vector tracing failed.');
      const show = currentName() === active;
      if (show) {
        receipt = { ...result, source, options: effectiveOptions(result.settings || options),
          gradients: copy(result.settings?.gradients || gradients),
          cleanup: copy(result.settings?.cleanup || cleanup), composition: copy(result.settings?.composition || composition) };
        showReceipt();
      }
      await onResult(result, show, active);
    } catch (err) {
      if (currentName() === active) say('Trace failed', 'err', err.message);
      onError(err);
    } finally { busy = false; paint(); }
  };
  get('iedVecGo').onclick = () => run();
  get('iedVecFillGo').onclick = () => run('fill');
  get('iedVecCleanGo').onclick = () => run('cleanup');
  get('iedVecFillColor').onchange = paintFill;
  get('iedVecShapeColor').onchange = paintShapes;
  get('iedVecShapes').onchange = paint;
  get('iedVecCleanType').onchange = paint;
  get('iedVecCompareMode').onchange = paintCompare;
  paint();
  return { open, hasSource: () => !!receipt, trace: () => run(), fill: () => run('fill'), clean: () => run('cleanup') };
}
