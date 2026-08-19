/**
 * Evaluate web/app.js under a stub DOM to surface a module-load throw.
 *
 * The page showed its static default text, which means applyStatus never ran --
 * so app.js is dying during top-level evaluation and the browser swallowed it.
 * Rather than guessing which statement, run it here with a permissive DOM and
 * print the real stack.
 *
 * The stub deliberately returns a Proxy for every element so missing IDs cannot
 * mask the actual fault; anything that still throws is a genuine bug.
 */
const el = () => new Proxy(function () {}, {
  get(_t, k) {
    if (k === "style") return new Proxy({}, { get: () => () => {}, set: () => true });
    if (k === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
    if (k === "dataset") return {};
    if (k === "value") return "1";
    if (k === "textContent" || k === "innerHTML") return "";
    if (k === "checked" || k === "hidden" || k === "complete") return false;
    if (k === "naturalWidth") return 1;
    if (k === "querySelectorAll") return () => [];
    if (k === "querySelector") return () => el();
    if (k === "getContext") return () => new Proxy({}, { get: () => () => {} });
    if (k === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 1, height: 1 });
    if (k === "addEventListener" || k === "removeEventListener") return () => {};
    if (k === Symbol.toPrimitive) return () => "el";
    return el();
  },
  set() { return true; },
  apply() { return el(); },
});

globalThis.document = {
  getElementById: () => el(),
  querySelector: () => el(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => el(),
  hidden: false,
  body: el(),
};
globalThis.window = globalThis;
globalThis.location = { host: "127.0.0.1:4173", href: "http://127.0.0.1:4173/" };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.fetch = () => new Promise(() => {});
globalThis.WebSocket = function () { return { onmessage: null, onclose: null }; };
globalThis.AudioContext = function () {
  return {
    state: "running",
    createMediaElementSource: () => ({ connect() {} }),
    createAnalyser: () => ({ connect() {}, frequencyBinCount: 128, getByteFrequencyData() {} }),
    destination: {},
    resume: () => Promise.resolve(),
  };
};
// Bare addEventListener / open are real window globals in a browser.
globalThis.addEventListener = () => {};
globalThis.open = () => null;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.setInterval = () => 0;
globalThis.prompt = () => null;
globalThis.confirm = () => false;
// Node defines navigator as a getter-only global, so patch rather than replace.
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: () => Promise.resolve() } },
  configurable: true,
});
globalThis.AbortSignal = { timeout: () => undefined };
globalThis.Audio = function () { return el(); };

try {
  await import("file:///C:/temp/AIPLAYStudio/web/app.js");
  console.log("app.js evaluated with NO top-level throw");
} catch (e) {
  console.log("TOP-LEVEL THROW:\n");
  console.log(e && e.stack ? e.stack.split("\n").slice(0, 8).join("\n") : String(e));
  /* Exit nonzero, because this is now a GATE, not only a diagnostic. It was
   * written as a diagnostic, got promoted into `npm test` and a pre-commit hook,
   * and the hook happily let a deliberately broken module through — "prints the
   * error" and "fails the pipeline" are different contracts, and the difference
   * was proven by committing a planted ReferenceError and watching it land. */
  process.exit(1);
}
