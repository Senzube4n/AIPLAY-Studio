/** Real toolbar helper with a small event/layout DOM. No browser or services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountToolbarMenus } from '../../web/daw-toolbar.js';

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn, options) {
    const rows = this.listeners.get(name) || []; rows.push({ fn, options }); this.listeners.set(name, rows);
  }
  removeEventListener(name, fn, options) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(row => row.fn !== fn || row.options !== options));
  }
  fire(name, values = {}) {
    const event = { target: this, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...values };
    for (const { fn } of [...this.listeners.get(name) || []]) fn(event);
    return event;
  }
  get listenerCount() { return [...this.listeners.values()].reduce((n, rows) => n + rows.length, 0); }
}
class Style {
  constructor() { this.values = new Map(); }
  setProperty(name, value, priority = '') { this.values.set(name, [String(value), priority]); }
  getPropertyValue(name) { return this.values.get(name)?.[0] || ''; }
  getPropertyPriority(name) { return this.values.get(name)?.[1] || ''; }
  removeProperty(name) { this.values.delete(name); }
}
class Node extends Events {
  constructor(tag, doc, cls = '') {
    super(); this.tagName = tag; this.ownerDocument = doc; this.cls = cls;
    this.children = []; this.style = new Style(); this.open = false; this.disabled = false;
    this.rect = { left: 20, top: 20, right: 100, bottom: 48, width: 80, height: 28 };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  closest(selector) { return this.tagName === selector ? this : this.parentElement?.closest(selector) || null; }
  querySelector(selector) {
    return this.children.find(child => selector === ':scope > summary' ? child.tagName === 'summary'
      : selector === ':scope > .d-morebody' && child.cls === 'd-morebody') || null;
  }
  querySelectorAll(selector) {
    const rows = [];
    for (const child of this.children) {
      if (selector === 'details.d-more' && child.tagName === 'details' && child.cls === 'd-more') rows.push(child);
      rows.push(...child.querySelectorAll(selector));
    }
    return rows;
  }
  getBoundingClientRect() {
    if (this.cls !== 'd-morebody') return this.rect;
    const width = Math.min(this.rect.width, parseFloat(this.style.getPropertyValue('max-width')) || Infinity);
    const height = Math.min(this.rect.height, parseFloat(this.style.getPropertyValue('max-height')) || Infinity);
    const left = parseFloat(this.style.getPropertyValue('left')) || 0;
    const top = parseFloat(this.style.getPropertyValue('top')) || 0;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  focus() { this.ownerDocument.activeElement = this; }
}
function fixture(t, { width = 800, height = 500, initialOpen = false, visualViewport, priorStyle = {} } = {}) {
  const doc = new Events(); doc.activeElement = null;
  const win = new Events(); Object.assign(win, { innerWidth: width, innerHeight: height, visualViewport });
  const header = new Node('header', doc);
  const make = () => {
    const details = new Node('details', doc, 'd-more'), summary = new Node('summary', doc);
    const body = new Node('div', doc, 'd-morebody'); body.rect = { width: 360, height: 220 };
    for (const [name, value] of Object.entries(priorStyle))
      body.style.setProperty(name, Array.isArray(value) ? value[0] : value, Array.isArray(value) ? value[1] : '');
    const button = new Node('button', doc), icon = new Node('span', doc), input = new Node('input', doc), select = new Node('select', doc);
    button.append(icon); body.append(button, input, select); details.append(summary, body); header.append(details);
    details.open = initialOpen;
    return { details, summary, body, button, icon, input, select };
  };
  const a = make(), b = make();
  const cleanup = mountToolbarMenus(header, { window: win, document: doc });
  t.after(cleanup);
  const open = menu => { menu.details.open = true; menu.details.fire('toggle'); };
  const click = target => {
    const event = target.fire('click');
    if (!event.propagationStopped) header.fire('click', event);
    return event;
  };
  return { doc, win, header, a, b, open, click, cleanup };
}

test('native disclosure clicks are untouched; opening a second menu closes the first', t => {
  const f = fixture(t);
  const click = f.click(f.a.summary);
  assert.equal(click.defaultPrevented, false); assert.equal(click.propagationStopped, false);
  assert.equal(f.a.details.open, false, 'the helper does not implement a second summary toggle');
  f.open(f.a); assert.equal(f.a.details.open, true);
  f.open(f.b); assert.equal(f.a.details.open, false); assert.equal(f.b.details.open, true);
  f.b.details.open = false; f.b.details.fire('toggle');
  assert.equal(f.b.body.style.getPropertyValue('position'), '');
});

test('an already-open header starts with at most one popup and no non-header state', t => {
  const f = fixture(t, { initialOpen: true });
  assert.equal(f.a.details.open, true); assert.equal(f.b.details.open, false);
  assert.equal(f.a.body.style.getPropertyValue('position'), 'fixed');
  assert.equal(f.a.details.cls, 'd-more'); assert.equal(f.header.children.length, 2);
});

test('outside pointer dismisses; summary, input and select interaction stay inside', t => {
  const f = fixture(t); f.open(f.a);
  for (const target of [f.a.summary, f.a.input, f.a.select]) {
    assert.equal(f.doc.fire('pointerdown', { target }).defaultPrevented, false);
    assert.equal(f.a.details.open, true); f.click(target); assert.equal(f.a.details.open, true);
  }
  f.doc.fire('pointerdown', { target: f.b.summary }); assert.equal(f.a.details.open, false);
});

test('Escape closes and restores summary focus; a consumed or unrelated key does not', t => {
  const f = fixture(t); f.open(f.a); f.a.input.focus();
  f.doc.fire('keydown', { key: 'Enter', target: f.a.input }); assert.equal(f.a.details.open, true);
  f.doc.fire('keydown', { key: 'Escape', defaultPrevented: true }); assert.equal(f.a.details.open, true);
  const escape = f.doc.fire('keydown', { key: 'Escape', target: f.a.input });
  assert.equal(f.a.details.open, false); assert.equal(f.doc.activeElement, f.a.summary);
  assert.equal(escape.defaultPrevented, true); assert.equal(escape.propagationStopped, true);
  const again = f.doc.fire('keydown', { key: 'Escape' }); assert.equal(again.defaultPrevented, false);
});

test('menu action runs once before dismissal, including a child icon, without cancelling the click', t => {
  const f = fixture(t); f.open(f.a); let runs = 0;
  f.a.button.addEventListener('click', () => { assert.equal(f.a.details.open, true); ++runs; });
  const event = f.a.button.fire('click', { target: f.a.icon }); f.header.fire('click', event);
  assert.equal(runs, 1); assert.equal(f.a.details.open, false);
  assert.equal(event.defaultPrevented, false); assert.equal(event.propagationStopped, false);
  f.open(f.a); f.a.button.disabled = true; f.header.fire('click', { target: f.a.button });
  assert.equal(f.a.details.open, true);
});

test('a large popup near the lower-right corner fits and scrolls inside a narrow viewport', t => {
  const f = fixture(t, { width: 320, height: 260 });
  f.a.summary.rect = { left: 265, right: 315, top: 220, bottom: 248 };
  f.a.body.rect = { width: 900, height: 1000 }; f.open(f.a);
  const box = f.a.body.getBoundingClientRect();
  assert.equal(box.left, 8); assert.equal(box.width, 304); assert.equal(box.top, 8); assert.equal(box.height, 208);
  assert.ok(box.right <= 312 && box.bottom <= 252);
  assert.equal(f.a.body.style.getPropertyValue('overflow'), 'auto');
  assert.equal(f.a.body.style.getPropertyValue('box-sizing'), 'border-box');
});

test('left-edge and visual viewport offsets are respected rather than positioning off screen', t => {
  const viewport = new Events(); Object.assign(viewport, { width: 340, height: 300, offsetLeft: 20, offsetTop: 30 });
  const f = fixture(t, { visualViewport: viewport });
  f.a.summary.rect = { left: 15, right: 80, top: 38, bottom: 66 }; f.open(f.a);
  const box = f.a.body.getBoundingClientRect();
  assert.equal(box.left, 28); assert.equal(box.top, 70);
  assert.ok(box.right <= 352 && box.bottom <= 322);
  viewport.fire('scroll'); assert.equal(f.a.details.open, false);
});

test('popup overflow scrolling stays usable; moving its anchor or resizing dismisses it', t => {
  const f = fixture(t); f.open(f.a);
  f.doc.fire('scroll', { target: f.a.body }); assert.equal(f.a.details.open, true);
  f.doc.fire('scroll', { target: f.a.input }); assert.equal(f.a.details.open, true);
  f.doc.fire('scroll', { target: f.header }); assert.equal(f.a.details.open, false);
  f.open(f.a); f.win.fire('resize'); assert.equal(f.a.details.open, false);
  f.open(f.a); f.win.fire('scroll'); assert.equal(f.a.details.open, false);
});

test('off-screen anchors close and cleanup restores original inline styles and removes every listener', t => {
  const f = fixture(t, { priorStyle: { position: 'absolute', 'max-height': ['77px', 'important'] } });
  f.a.body.style.setProperty('unrelated', 'kept');
  f.a.summary.rect = { left: 900, right: 950, top: 20, bottom: 48 }; f.open(f.a);
  assert.equal(f.a.details.open, false);
  f.a.summary.rect = { left: 20, right: 100, top: 20, bottom: 48 }; f.open(f.a);
  f.cleanup(); f.cleanup();
  assert.equal(f.a.details.open, false); assert.equal(f.a.body.style.getPropertyValue('position'), 'absolute');
  assert.equal(f.a.body.style.getPropertyValue('max-height'), '77px');
  assert.equal(f.a.body.style.getPropertyPriority('max-height'), 'important');
  assert.equal(f.a.body.style.getPropertyValue('unrelated'), 'kept');
  assert.equal(f.doc.listenerCount + f.win.listenerCount + f.header.listenerCount
    + f.a.details.listenerCount + f.b.details.listenerCount, 0);
  f.a.details.open = true; f.a.details.fire('toggle'); assert.equal(f.a.body.style.getPropertyValue('position'), 'absolute');
});

test('a missing header is an inert mount', () => {
  const cleanup = mountToolbarMenus(null); assert.equal(typeof cleanup, 'function'); cleanup();
});
