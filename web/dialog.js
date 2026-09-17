/**
 * THE APP'S OWN DIALOGS — in place of the browser's alert / confirm / prompt.
 *
 * The browser's boxes say "127.0.0.1:4173 says", ignore the theme, block the
 * whole tab and cannot say which button is the dangerous one. These are the
 * same questions in a window drawn by the app.
 *
 *   await appConfirm("Delete the preset?")          -> true | false
 *   await appPrompt("Name this look:", "")          -> string | null
 *   await appAlert("Saved.")                        -> undefined
 *
 * Importing this module also replaces window.alert, so the ninety-odd
 * informational alerts across the app open here without touching each one.
 * confirm and prompt cannot be replaced that way — the browser's versions
 * return synchronously and these cannot — so their call sites await these.
 *
 * Self-contained: the styles are injected here with fallbacks for every colour
 * token, so the DAW and Avatars pages get the same window without a stylesheet.
 */

const CSS = `
.appdlg-back {
  position: fixed; inset: 0; z-index: 100000;
  display: grid; place-items: center; padding: 16px;
  background: hsla(220,30%,2%,.62); backdrop-filter: blur(3px);
  animation: appdlgFade .14s ease-out;
}
.appdlg {
  width: min(440px, 100%); max-height: calc(100vh - 32px); overflow: auto;
  box-sizing: border-box; padding: 22px 22px 18px;
  background: hsl(220,15%,10%); color: var(--ink, hsl(0,0%,96%));
  border: 1px solid hsla(0,0%,100%,.09); border-radius: 16px;
  box-shadow: 0 24px 70px hsla(0,0%,0%,.6);
  font-family: var(--sans, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif);
  animation: appdlgIn .16s cubic-bezier(.22,.8,.24,1);
}
.appdlg h2 {
  margin: 0 0 8px; font-size: 16px; font-weight: 650; line-height: 1.35; color: var(--ink, hsl(0,0%,96%));
  display: flex; align-items: center; gap: 10px;
}
.appdlg h2 i {
  flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
  font-style: normal; font-size: 14px; font-weight: 700;
  background: hsla(195,100%,60%,.14); color: var(--primary, hsl(195,100%,60%));
}
.appdlg.danger h2 i { background: hsla(0,85%,60%,.14); color: var(--err, hsl(0,85%,60%)); }
.appdlg.warn h2 i { background: hsla(38,92%,55%,.14); color: var(--warn, hsl(38,92%,55%)); }
.appdlg p { margin: 0 0 8px; font-size: 13.5px; line-height: 1.6; color: var(--dim, hsl(0,0%,85%)); white-space: pre-wrap; overflow-wrap: anywhere; }
.appdlg p.more { color: var(--faint, hsl(0,0%,68%)); font-size: 13px; }
.appdlg input {
  width: 100%; box-sizing: border-box; margin: 6px 0 4px; height: 38px; padding: 0 12px;
  font: inherit; font-size: 13.5px; color: var(--ink, hsl(0,0%,96%));
  background: hsla(0,0%,100%,.06); border: 1px solid transparent; border-radius: 10px;
}
.appdlg input:focus { outline: none; border-color: hsla(195,100%,60%,.5); background: hsla(0,0%,100%,.09); }
.appdlg .acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.appdlg button {
  font: inherit; font-size: 13px; font-weight: 600; height: 36px; padding: 0 18px;
  border-radius: 999px; border: 1px solid transparent; cursor: pointer;
  transition: background-color .12s, color .12s, filter .12s;
}
.appdlg button.cancel { background: hsla(0,0%,100%,.06); color: var(--dim, hsl(0,0%,85%)); }
.appdlg button.cancel:hover { background: hsla(0,0%,100%,.1); color: var(--ink, hsl(0,0%,96%)); }
.appdlg button.ok { background: var(--primary, hsl(195,100%,60%)); color: var(--on, hsl(210,45%,7%)); }
.appdlg button.ok:hover { filter: brightness(1.08); }
.appdlg.danger button.ok { background: var(--err, hsl(0,85%,60%)); color: #fff; }
.appdlg button:focus-visible { outline: 2px solid hsla(195,100%,60%,.7); outline-offset: 2px; }
@keyframes appdlgFade { from { opacity: 0; } to { opacity: 1; } }
@keyframes appdlgIn { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .appdlg-back, .appdlg { animation: none; } }
`;

function injectCss() {
  if (document.getElementById("appdlg-css")) return;
  const s = document.createElement("style");
  s.id = "appdlg-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ── wording ─────────────────────────────────────────────────────────────── */

/** The confirm button says what it does: "Delete", not "OK". */
const VERBS = [
  [/^move .* to (the )?trash/i, "Move to trash", "danger"],
  [/^(delete|remove|forget|uninstall|disconnect|discard)\b/i, null, "danger"],
  [/^throw\b.*away/i, "Throw away", "danger"],
  [/^replace\b/i, "Replace", "warn"],
  [/^(stop|reset|rename|switch|open|leave|start|overwrite|restart|clear|cancel)\b/i, null, "warn"],
];

function verbFor(text) {
  const first = String(text).trim();
  for (const [re, label, tone] of VERBS) {
    const m = re.exec(first);
    if (!m) continue;
    const word = label || m[1] || m[0];
    return { ok: word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(), tone };
  }
  return { ok: "Continue", tone: "" };
}

/** Split "Question?\n\nDetails" into a heading and body paragraphs. */
function parts(message, title) {
  const text = String(message ?? "").trim();
  if (title) return { head: title, body: text ? text.split(/\n{2,}/) : [] };
  const paras = text.split(/\n{2,}/);
  let head = paras.shift() || "";
  /* A long first paragraph reads badly as a heading: keep its first sentence. */
  if (head.length > 90) {
    const cut = head.search(/[?.!](\s|$)/);
    if (cut > 0 && cut < head.length - 1) {
      paras.unshift(head.slice(cut + 1).trim());
      head = head.slice(0, cut + 1);
    }
  }
  return { head, body: paras };
}

/* ── the window ──────────────────────────────────────────────────────────── */

let chain = Promise.resolve();

/* The browser's own alert, kept before it is replaced below. */
const hostAlert = typeof window !== "undefined" && typeof window.alert === "function" ? window.alert.bind(window) : null;

/* No real page to draw in (a test's fake DOM, a worker): ask the host's own
 * functions instead, so a stubbed confirm/prompt still sees the question. */
function headless() {
  return typeof document === "undefined" || typeof document.createElement !== "function"
    || typeof document.createTextNode !== "function" || !document.body || typeof document.body.appendChild !== "function";
}

function open(kind, message, opts = {}) {
  if (headless()) {
    const g = globalThis;
    if (kind === "confirm") return Promise.resolve(typeof g.confirm === "function" ? !!g.confirm(message) : false);
    if (kind === "prompt") return Promise.resolve(typeof g.prompt === "function" ? g.prompt(message, opts.value ?? "") : null);
    if (hostAlert) hostAlert(message);
    return Promise.resolve();
  }
  const run = () => new Promise((resolve) => {
    injectCss();
    const { head, body } = parts(message, opts.title);
    const guess = verbFor(head || message);
    const tone = opts.tone ?? (kind === "alert" ? "" : guess.tone);
    const back = document.createElement("div");
    back.className = "appdlg-back";
    const box = document.createElement("div");
    box.className = `appdlg ${tone}`;
    box.setAttribute("role", kind === "alert" ? "alertdialog" : "dialog");
    box.setAttribute("aria-modal", "true");
    const hid = `appdlg-h-${Date.now()}`;
    box.setAttribute("aria-labelledby", hid);

    const h = document.createElement("h2");
    h.id = hid;
    const ic = document.createElement("i");
    ic.textContent = tone === "danger" || tone === "warn" ? "!" : kind === "prompt" ? "✎" : "i";
    h.append(ic, document.createTextNode(head));
    box.appendChild(h);
    body.forEach((para, i) => {
      const p = document.createElement("p");
      if (i > 0 || body.length > 1) p.className = "more";
      p.textContent = para;
      box.appendChild(p);
    });

    let input = null;
    if (kind === "prompt") {
      input = document.createElement("input");
      input.type = "text";
      input.value = opts.value ?? "";
      if (opts.placeholder) input.placeholder = opts.placeholder;
      input.spellcheck = false;
      box.appendChild(input);
    }

    const acts = document.createElement("div");
    acts.className = "acts";
    let cancel = null;
    if (kind !== "alert") {
      cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cancel";
      cancel.textContent = opts.cancel || "Cancel";
      acts.appendChild(cancel);
    }
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "ok";
    ok.textContent = opts.ok || (kind === "alert" ? "OK" : kind === "prompt" ? "Save" : guess.ok);
    acts.appendChild(ok);
    box.appendChild(acts);
    back.appendChild(box);

    const before = document.activeElement;
    const finish = (value) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      try { before?.focus?.({ preventScroll: true }); } catch { /* gone */ }
      resolve(value);
    };
    const yes = () => finish(kind === "prompt" ? input.value : kind === "confirm" ? true : undefined);
    const no = () => finish(kind === "prompt" ? null : kind === "confirm" ? false : undefined);
    function onKey(e) {
      /* While the window is open no key reaches the page's own shortcuts
       * (Delete in VFX, Space in the DAW). Typing in the box still works:
       * stopping propagation does not cancel the key's default action. */
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); no(); }
      else if (e.key === "Enter" && (e.target === input || !e.target.closest?.("button"))) { e.preventDefault(); e.stopPropagation(); yes(); }
      else if (e.key === "Tab") {
        const f = [input, cancel, ok].filter(Boolean);
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    }
    ok.onclick = yes;
    if (cancel) cancel.onclick = no;
    back.addEventListener("mousedown", (e) => { if (e.target === back) no(); });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    /* A destructive question focuses Cancel, so Enter on a stray keypress keeps the work. */
    (input || (tone === "danger" && cancel) || ok).focus();
    if (input) input.select();
  });
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

export const appConfirm = (message, opts) => open("confirm", message, opts);
export const appAlert = (message, opts) => open("alert", message, opts);
export const appPrompt = (message, value = "", opts = {}) => open("prompt", message, { ...opts, value });

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.appConfirm = appConfirm;
  window.appAlert = appAlert;
  window.appPrompt = appPrompt;
  /* Informational alerts return nothing, so they can open here unchanged. */
  window.alert = (message) => { appAlert(message); };
}
