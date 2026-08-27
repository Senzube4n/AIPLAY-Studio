/**
 * End-to-end check of the Images screen's REFERENCE PICKER — the real handlers,
 * driven by real events, talking to a real server.
 *
 * server/mcp-image_test.js proves the wiring exists by reading the source. That
 * is a static gate and it cannot tell you whether pressing the button does
 * anything: this project's recurring failure is a feature that is present in
 * every file and joined in none of them. So this script evaluates web/app.js
 * itself, under a DOM small enough to fit here and real enough to run it, and
 * then DISPATCHES the gestures:
 *
 *   navigate to Images   → the page loads the library from the running server
 *   pick two references  → the strip paints them, numbered, in order
 *   press ▶ on the first → the order changes, and so do the numbers, because
 *                          the prompt says "image 1" by POSITION
 *   press ✕              → it goes
 *   switch to Ideogram   → the block STAYS VISIBLE and explains itself, which
 *                          is the whole point: the old form hid it and dropped
 *                          the user's pictures out of the POST in silence
 *   press Make image     → a real POST to the real server, asserted on the wire
 *
 * The render itself is asserted separately (it needs the GPU and several
 * seconds); pass --render to include it.
 *
 * Needs the server running:
 *   AIPLAY_UI_PORT=4280 node server/index.js
 * Then:
 *   node scripts/e2e_imgrefs.mjs 4280 [--render]
 */
const PORT = (process.argv[2] || "").match(/^\d+$/) ? process.argv[2] : "4173";
const BASE = `http://127.0.0.1:${PORT}`;
const WITH_RENDER = process.argv.includes("--render");

let pass = 0;
const fails = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ── a DOM, in about a hundred lines ──────────────────────────────────────
 * Every id app.js asks for gets a real node, because a Proxy that answers
 * everything cannot tell you what the page ended up saying. Only the handful
 * of behaviours app.js actually uses are implemented. */
const NODES = new Map();
const BY_SELECTOR = new Map();

class El {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this._html = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.files = [];
    this.placeholder = "";
    this.options = [];
    this.selectedOptions = [];
    this.selectionStart = null;
    this.selectionEnd = null;
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" };
    this._listeners = new Map();
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on === undefined ? (this.classList._s.has(c) ? this.classList._s.delete(c) : this.classList._s.add(c)) : on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    /* Elements the painted markup declares, as click targets. Attribute scan
     * only — enough for the delegated handlers, which all `closest()` the
     * control they were painted onto. */
    this.children = [...this._html.matchAll(/<(\w+)([^>]*)>/g)].map((m) => {
      const el = new El();
      for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
        el._attrs ??= {};
        el._attrs[a[1]] = a[2];
        if (a[1].startsWith("data-")) {
          el.dataset[a[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = a[2];
        }
      }
      el._attrs ??= {};
      if (/\bdisabled\b/.test(m[2])) el.disabled = true;
      el.tag = m[1];
      return el;
    });
  }
  get parentElement() { return (this._parent ??= new El()); }
  get previousElementSibling() { return (this._prev ??= new El()); }
  closest(sel) {
    const m = sel.match(/^\[([\w-]+)\]$/);
    if (m) return this._attrs && m[1] in this._attrs ? this : null;
    return null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener() {}
  dispatch(type, ev = {}) {
    const e = { type, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
    for (const fn of this._listeners.get(type) || []) fn(e);
    const on = this[`on${type}`];
    if (typeof on === "function") return on(e);
    return undefined;
  }
  focus() {}
  blur() {}
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  scrollIntoView() {}
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }; }
  getContext() { return new Proxy({}, { get: () => () => {} }); }
  appendChild(c) { return c; }
  after() {}
  before() {}
  prepend() {}
  append() {}
  replaceWith() {}
  contains() { return false; }
  matches() { return false; }
  cloneNode() { return new El(); }
  remove() {}
  insertAdjacentHTML() {}
  setAttribute(k, v) { (this._attrs ??= {})[k] = v; }
  getAttribute(k) { return this._attrs?.[k] ?? null; }
  click() { return this.dispatch("click"); }
}

const el = (id) => {
  if (!NODES.has(id)) NODES.set(id, new El(id));
  return NODES.get(id);
};

/* Rows the engine dropdown hides and shows. Registered so the real onchange
 * loop has something real to act on. */
for (const eng of ["checkpoint", "checkpoint", "ideogram4", "ideogram4"]) {
  const n = new El();
  n.dataset.engineonly = eng;
  n._attrs = { "data-engineonly": eng };
  if (!BY_SELECTOR.has("[data-engineonly]")) BY_SELECTOR.set("[data-engineonly]", []);
  BY_SELECTOR.get("[data-engineonly]").push(n);
}

const docListeners = new Map();
globalThis.document = {
  getElementById: (id) => el(id),
  querySelector: () => new El(),
  querySelectorAll: (sel) => BY_SELECTOR.get(sel) || [],
  addEventListener: (t, fn) => {
    if (!docListeners.has(t)) docListeners.set(t, []);
    docListeners.get(t).push(fn);
  },
  createElement: () => new El(),
  hidden: false,
  body: new El(),
  documentElement: new El(),
  head: new El(),
};
const docDispatch = (type, ev) => {
  const e = { type, preventDefault() {}, stopPropagation() {}, ...ev };
  for (const fn of docListeners.get(type) || []) fn(e);
};

globalThis.window = globalThis;
globalThis.location = { host: `127.0.0.1:${PORT}`, href: `${BASE}/`, hash: "", origin: BASE };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.WebSocket = function () { return { onmessage: null, onclose: null, onerror: null, close() {} }; };
globalThis.AudioContext = function () {
  return {
    state: "running",
    createMediaElementSource: () => ({ connect() {} }),
    createAnalyser: () => ({ connect() {}, frequencyBinCount: 128, getByteFrequencyData() {} }),
    destination: {}, resume: () => Promise.resolve(),
  };
};
globalThis.addEventListener = () => {};
globalThis.open = () => null;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.setInterval = () => 0;
globalThis.prompt = () => null;
globalThis.confirm = () => false;
const alerts = [];
globalThis.alert = (m) => alerts.push(String(m));
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true,
});
globalThis.AbortSignal = { timeout: () => undefined };
globalThis.Audio = function () { return new El(); };
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};

/* THE REAL WIRE. A relative URL is what the page would send, and it is sent —
 * to the server this script was pointed at. Every call is recorded so the
 * request the button makes can be asserted, not assumed. */
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (u, init) => {
  const url = String(u).startsWith("/") ? BASE + u : String(u);
  if (init?.body && typeof init.body === "string") {
    try { sent.push({ url, body: JSON.parse(init.body) }); } catch { sent.push({ url, body: init.body }); }
  } else {
    sent.push({ url, body: null });
  }
  return realFetch(url, init);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const attrs = (html, attr) => [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].map((m) => m[1]);
/* The strip in order. Only the THUMBNAIL carries a "name — click to say"
 * title; the four controls under it have titles of their own. */
const orderOf = (html) => attrs(html, "title").filter((t) => t.includes(" — click to say"))
  .map((t) => t.split(" — ")[0]);

console.log(`\nImages-screen reference picker — against ${BASE}\n`);

try {
  await realFetch(`${BASE}/api/status`);
} catch {
  console.log(`  the server is not answering on ${BASE}. Start it first:\n`
    + `    AIPLAY_UI_PORT=${PORT} node server/index.js\n`);
  process.exit(1);
}

await import(new URL("../web/app.js", import.meta.url));
ok("app.js evaluates against a real DOM", true);

/* ── navigate to Images, the way an in-page link does ─────────────────────── */
const goTarget = new El();
goTarget._attrs = { "data-go": "images" };
goTarget.dataset.go = "images";
docDispatch("click", { target: goTarget });
await wait(600);                                   // loadImages() is a real fetch

const pick = el("imgRefPick");
const prev = el("imgRefPrev");
ok("navigating to Images loaded the library from the server",
  sent.some((s) => s.url.endsWith("/api/images")));
const offered = attrs(pick.innerHTML, "value").filter(Boolean);
ok("...and the picker offers what the library holds", offered.length > 0,
  `picker: ${pick.innerHTML.slice(0, 160)}`);
ok("the picker groups images and song covers",
  /optgroup label="Images"/.test(pick.innerHTML) || /optgroup label="Song covers"/.test(pick.innerHTML));
ok("the strip starts empty and hidden", prev.hidden === true && prev.innerHTML === "");
ok("the cost note is not shown before there is a cost", el("imgRefCostNote").hidden === true);

/* ── pick two ─────────────────────────────────────────────────────────────── */
const [a, b] = offered;
if (!b) {
  console.log("\n  need at least two library pictures to exercise ordering — make some first.\n");
  process.exit(1);
}
pick.value = a; pick.dispatch("change");
pick.value = b; pick.dispatch("change");

ok("both references are attached", orderOf(prev.innerHTML).length === 2);
ok("...numbered 1 and 2 on the pictures themselves",
  />1</.test(prev.innerHTML) && />2</.test(prev.innerHTML));
ok("...and the numbers are what the prompt is told to say",
  prev.innerHTML.includes(">image 1<") && prev.innerHTML.includes(">image 2<"));
ok("the strip is visible now", prev.hidden === false);
ok("the limit is on screen", /2 of 10/.test(el("imgRefLimit").textContent),
  el("imgRefLimit").textContent);
ok("the honest cost is on screen",
  el("imgRefCostNote").hidden === false
  && /4 s per reference past the second/.test(el("imgRefCostNote").textContent));
ok("the first reference cannot move earlier and the last cannot move later",
  /data-refup="0" disabled/.test(prev.innerHTML) && /data-refdown="1" disabled/.test(prev.innerHTML),
  prev.innerHTML.replace(/\s+/g, " ").slice(0, 400));
ok("...and a picture already chosen is no longer offered twice",
  !attrs(pick.innerHTML, "value").includes(a));

/* ── reorder: the gesture the numbering depends on ────────────────────────── */
const order1 = orderOf(prev.innerHTML);
const later = prev.children.find((c) => c.dataset.refdown === "0");
ok("the ▶ control exists on the first reference", !!later);
el("imgRefWrap").dispatch("click", { target: later });
const order2 = orderOf(prev.innerHTML);
ok("pressing ▶ swaps the two references",
  order2[0] === order1[1] && order2[1] === order1[0], `${order1} -> ${order2}`);
ok("...so \"image 1\" now points at the other picture",
  prev.innerHTML.indexOf(order2[0]) < prev.innerHTML.indexOf(order2[1]));

/* ── the description that names a reference nobody attached ───────────────── */
const promptBox = el("imgPrompt");
promptBox.value = "the character from image 1 walking through the room from image 3";
promptBox.dispatch("input");
ok("naming image 3 with two attached is called out",
  el("imgRefTagNote").hidden === false && /image 3/.test(el("imgRefTagNote").textContent),
  el("imgRefTagNote").textContent);
promptBox.value = "the character from image 1 in the room from image 2, cinematic";
promptBox.dispatch("input");
ok("...and the warning clears when the numbers are real", el("imgRefTagNote").hidden === true);

/* ── clicking a thumbnail writes the number into the description ──────────── */
const say = prev.children.find((c) => c.tag === "img" && c.dataset.refsay);
promptBox.value = "a portrait of";
promptBox.selectionStart = promptBox.selectionEnd = promptBox.value.length;
el("imgRefWrap").dispatch("click", { target: say });
ok("clicking a thumbnail drops its number into the description",
  promptBox.value === "a portrait of image 1", promptBox.value);

/* ── the engine gate: visible and explaining, never silent ────────────────── */
const engine = el("imgEngine");
engine.value = "ideogram4";
await engine.dispatch("change");
ok("switching to Ideogram does NOT hide the references away",
  prev.hidden === false && prev.innerHTML.includes("image 1"));
ok("...it says Ideogram has no reference input",
  el("imgRefEngineNote").hidden === false
  && /Ideogram 4 has no reference input/.test(el("imgRefEngineNote").textContent));
ok("...and warns that the render will be refused rather than ignore them",
  /will NOT be used/.test(el("imgRefEngineNote").textContent)
  && /refused/.test(el("imgRefEngineNote").textContent));
ok("...and the picker is closed while that engine is selected", pick.disabled === true);

engine.value = "checkpoint";
await engine.dispatch("change");
ok("a bring-your-own checkpoint gets the same treatment",
  el("imgRefEngineNote").hidden === false
  && /checkpoint has no reference input/.test(el("imgRefEngineNote").textContent));

engine.value = "flux2";
await engine.dispatch("change");
ok("back on FLUX.2 the warning goes and the picker reopens",
  el("imgRefEngineNote").hidden === true && pick.disabled === false);

/* ── remove ───────────────────────────────────────────────────────────────── */
const x = prev.children.find((c) => c.dataset.refx === "0");
el("imgRefWrap").dispatch("click", { target: x });
ok("✕ removes a reference", attrs(prev.innerHTML, "data-refx").length === 1);
ok("...and the survivor is renumbered to 1", prev.innerHTML.includes(">image 1<")
  && !prev.innerHTML.includes(">image 2<"));
el("imgRefClear").dispatch("click");
ok("Clear empties the strip", prev.hidden === true);
ok("...and the cost note goes with it", el("imgRefCostNote").hidden === true);

/* ── the POST: what the button actually puts on the wire ──────────────────── */
pick.value = a; pick.dispatch("change");
pick.value = b; pick.dispatch("change");
promptBox.value = "put the subject of image 1 into the scene from image 2";
el("imgSize").value = "1024x1024";
el("imgCount").value = "1";
el("imgSteps").value = "4";
el("imgSeed").value = "";

sent.length = 0;
engine.value = "ideogram4";
await engine.dispatch("change");
await el("imgGo").dispatch("click");
const ideoPost = sent.find((s) => s.url.endsWith("/api/image"));
ok("on Ideogram the references are STILL sent — not dropped in the client",
  Array.isArray(ideoPost?.body?.refImages) && ideoPost.body.refImages.length === 2,
  JSON.stringify(ideoPost?.body?.refImages));
ok("...and the server's own refusal is what the user is shown",
  alerts.some((m) => /Ideogram 4 has no reference input/.test(m)), alerts.join(" | "));

sent.length = 0;
alerts.length = 0;
engine.value = "flux2";
await engine.dispatch("change");
const before = await (await realFetch(`${BASE}/api/images`)).json();
const had = new Set((before.images || []).map((i) => i.name));
const go = el("imgGo").dispatch("click");
await wait(1500);
const fluxPost = sent.find((s) => s.url.endsWith("/api/image"));
ok("on FLUX.2 the POST carries both references, IN THE ORDER SHOWN",
  JSON.stringify(fluxPost?.body?.refImages) === JSON.stringify(orderOf(prev.innerHTML)),
  JSON.stringify(fluxPost?.body?.refImages));
ok("...and the prompt that talks about them", /image 1/.test(fluxPost?.body?.prompt || ""));
ok("...and the server accepted it", !alerts.length, alerts.join(" | "));

if (WITH_RENDER) {
  console.log("\n  waiting for the render (this is the GPU, not the code) …");
  let made = [];
  for (let i = 0; i < 120 && !made.length; i++) {
    await wait(5000);
    const now = await (await realFetch(`${BASE}/api/images`)).json();
    made = (now.images || []).filter((im) => !had.has(im.name));
  }
  ok("a two-reference FLUX render lands in the library", made.length > 0);
  for (const m of made) console.log(`        ${m.name}  ${(m.bytes / 1e6).toFixed(2)} MB  ${BASE}/api/image/${m.name}`);
}
await go.catch?.(() => {});

console.log(fails.length ? `\n  ${pass} ok, ${fails.length} FAILED\n` : `\n  all ${pass} checks pass\n`);
process.exit(fails.length ? 1 : 0);
