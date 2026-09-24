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
globalThis.history = { replaceState() {} };
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
/* web/videolab.js watches the size <select> for the rebuild app.js does on an
 * engine switch, which is more reliable than racing the fetch that caused it.
 * Stubbed here so this gate can evaluate that module too. */
globalThis.MutationObserver = function () { return { observe() {}, disconnect() {} }; };

try {
  /* Relative to THIS script, not a hardcoded path: an absolute path here meant
   * every clone at a different directory — and every git worktree — evaluated
   * the original tree's app.js, or none at all. A gate that tests a different
   * checkout than the one being committed is not a gate. */
  await import(new URL("../web/app.js", import.meta.url));
  console.log("app.js evaluated with NO top-level throw");
  /* THE SECOND MODULE THE PAGE LOADS. web/videolab.js is a separate <script>,
   * so a top-level throw in it is swallowed by the browser exactly the way
   * app.js's was — and it is template-literal-heavy, which is a shape that
   * fails to parse in ways nothing else here would catch. It self-mounts on
   * import, so this exercises its mount path as well as its parse. */
  await import(new URL("../web/videolab.js", import.meta.url));
  console.log("videolab.js evaluated and mounted with NO top-level throw");
  /* THE THIRD. web/engine.js is the same shape — its own <script>, self-mounting
   * on import — and it is the one screen whose whole job is to tell the truth
   * about what rendered here, so a silent parse failure in it would be the
   * failure that hides every other failure. */
  await import(new URL("../web/engine.js", import.meta.url));
  console.log("engine.js evaluated and mounted with NO top-level throw");
  /* THE VIDEO SCREEN'S CARD MODULE. Its own <script> as well, booting on
   * import, and app.js calls into it with every status, so a throw here would
   * leave the size chips, the fit line and the RAM note silently absent. */
  await import(new URL("../web/vidfit.js", import.meta.url));
  if (typeof globalThis.aiplayVidFit !== "function") throw new Error("vidfit.js did not register aiplayVidFit");
  globalThis.aiplayVidFit({ config: { video: {} }, art: {} });
  console.log("vidfit.js evaluated, booted and took a status with NO top-level throw");
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
