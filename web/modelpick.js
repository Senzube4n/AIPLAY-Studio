/**
 * THE "YOU NEED A MODEL FOR THAT" WINDOW.
 *
 * Pressing Enhance with no chat model, or picking a music model that is not on
 * disk, used to end in a sentence: a raw ComfyUI refusal in the toolbar, or an
 * OK box saying "Open the Models screen", which left a newcomer to find a
 * screen and a row by themselves. This puts the answer where the question was:
 * the models that do the job, whether each fits this machine, a Download button
 * on each, and the paid way round it at the bottom.
 *
 * A floating window rather than a dialog on purpose. A download takes minutes,
 * so it can be dragged out of the way and minimised to its title bar while the
 * rest of the page stays usable. Only the × closes it: clicking outside or
 * pressing Escape would lose a download's progress somebody was watching.
 *
 * Everything it shows comes from /api/models (the same rows, fit verdicts and
 * chips the Models screen uses); it writes none of its own judgements.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const gb = (b) => `${(Number(b || 0) / 1073741824).toFixed(1)} GB`;

/* Which Models-screen rows answer each kind of question. The music and video
 * lists are the engines their pickers offer; images are every picture model. */
const MUSIC_ROWS = ["engine", "musicAceStep15", "musicYue2Comfy", "musicYue2Gguf", "musicYue2"];
const VIDEO_ROWS = ["video", "videoLtx"];

/** The rows to list: the model asked about first, then the others that do the
 *  same job. `kind` "auto" takes the job from the asked-about row's section. */
function rowsFor(caps, kind, focus) {
  const asked = caps.find((c) => c.id === focus);
  /* An add-on (a LoRA on another row's model, `addonFor`): the others on the
   * same model beside it, such as H3's 3-, 4- and 8-step speed-ups. */
  if (kind === "auto" && asked?.addonFor) return caps.filter((c) => c.id === focus || c.addonFor === asked.addonFor);
  const job = kind === "auto" ? (asked?.group || "music") : kind;
  const same = job === "chat" ? (c) => c.group === "chat"
    : job === "music" ? (c) => MUSIC_ROWS.includes(c.id)
    : job === "images" ? (c) => c.makes === "picture"
    : job === "video" ? (c) => VIDEO_ROWS.includes(c.id)
    : () => false;
  return caps.filter((c) => c.id === focus || same(c));
}

let win = null;
let poll = null;
let current = null;   // the options the window was last opened with

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/**
 * @param {object} o
 * @param {"chat"|"music"} o.kind
 * @param {string} o.title      one line: what was asked for and why it cannot run
 * @param {string} [o.lead]     one sentence under it
 * @param {string} [o.focus]    a capability id to list first (the model picked)
 * @param {string} [o.apiLabel] the footer button's words
 * @param {() => void} [o.onApi] the footer button
 * @param {(id: string) => boolean} [o.onSetup] a row that installs somewhere else
 *   (native YuE2 GGUF) — return true when handled
 */
export function openModelPicker(o) {
  current = o;
  if (!win) build();
  win.hidden = false;
  win.classList.remove("min");
  win.querySelector(".mp-title").textContent = o.title || "This needs a model";
  win.querySelector(".mp-lead").textContent = o.lead || "";
  win.querySelector(".mp-lead").hidden = !o.lead;
  const api = win.querySelector(".mp-api");
  api.textContent = o.apiLabel || "Use an API instead";
  api.hidden = !o.onApi;
  paint();
}

function build() {
  win = el(`
    <div class="mpick" role="dialog" aria-modal="false" aria-labelledby="mpTitle">
      <div class="mp-bar">
        <span class="mp-title" id="mpTitle"></span>
        <button class="mp-min" type="button" title="Minimise" aria-label="Minimise">&#8211;</button>
        <button class="mp-x" type="button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="mp-body">
        <p class="mp-lead"></p>
        <div class="mp-list" aria-live="polite"></div>
        <p class="mp-msg" role="status"></p>
      </div>
      <div class="mp-foot">
        <button class="btn ghost mp-api" type="button"></button>
      </div>
    </div>`);
  document.body.appendChild(win);

  win.querySelector(".mp-x").onclick = () => { win.hidden = true; clearTimeout(poll); };
  win.querySelector(".mp-min").onclick = () => win.classList.toggle("min");
  win.querySelector(".mp-api").onclick = () => current?.onApi?.();
  win.querySelector(".mp-list").addEventListener("click", onRow);

  /* Dragged by its title bar, kept on screen. */
  const bar = win.querySelector(".mp-bar");
  bar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = win.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 120);
      const y = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40);
      Object.assign(win.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
    };
    const up = () => { bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  });
}

function say(text, bad = false) {
  const m = win.querySelector(".mp-msg");
  m.textContent = text || "";
  m.classList.toggle("bad", !!bad);
}

async function paint() {
  clearTimeout(poll);
  const list = win.querySelector(".mp-list");
  let d;
  try { d = await (await fetch("/api/models")).json(); }
  catch { list.innerHTML = ""; say("Could not reach Studio's server.", true); return; }
  if (win.hidden) return;

  const states = d.fitStates || {};
  /* The server's order (fitStates[state].rank, from fit.js), not a copy of it:
   * installed rows last, a state this page has no rank for just before them. */
  const rank = (c) => (c.id === current.focus ? 0 : 1) * 10 + (c.ready ? 9 : states[c.fit?.state]?.rank ?? 8);
  const rows = rowsFor(d.capabilities || [], current.kind, current.focus).sort((a, b) => rank(a) - rank(b));

  if (!rows.length) {
    list.innerHTML = `<p class="mp-empty">No model for this is listed here yet.</p>`;
  } else {
    list.innerHTML = rows.map((c) => {
      const fit = states[c.fit?.state];
      const pr = c.progress;
      const pct = pr?.total ? Math.round((100 * pr.received) / pr.total) : 0;
      const left = Math.max(0, (c.totalBytes || 0) - (c.haveBytes || 0));
      const act = c.ready
        ? `<span class="mp-ok">Installed</span>`
        : c.downloading
          ? `<span class="mp-pct">${pct}%</span>`
          : c.nativeSetup
            ? `<button class="btn sm mp-get" type="button" data-setup="${esc(c.id)}">Set up</button>`
          /* A gated repository (LTX 2.5): Studio has no token and deliberately
           * nowhere to keep one, so the row says how, right here, instead of
           * a Download button that can only fail. */
          : c.gated
            ? `<button class="btn sm mp-get" type="button" data-how="${esc(c.id)}">How to get it</button>`
            : `<button class="btn sm mp-get" type="button" data-get="${esc(c.id)}"${c.fit?.state === "wont-run" ? " disabled" : ""}>Download${left ? ` · ${gb(left)}` : ""}</button>`;
      return `<div class="mp-row${c.id === current.focus ? " focus" : ""}">
        <div class="mp-name">
          <b>${esc(c.label)}</b>
          ${fit ? `<span class="mp-fit ${esc(fit.tone || "")}" title="${esc(c.fit?.why || fit.line || "")}">${esc(fit.chip)}${c.fit?.short ? ` · ${esc(c.fit.short)}` : ""}</span>` : ""}
          ${c.fit?.warning ? `<span class="mp-warn">⚠ ${esc(c.fit.warning)}</span>` : ""}
          ${c.why ? `<span class="mp-why">${esc(c.why)}</span>` : ""}
          ${c.downloading ? `<span class="mp-bar2"><i style="width:${pct}%"></i></span>` : ""}
          ${c.region && !c.ready ? `<label class="mp-region"><input type="checkbox" data-ack="${esc(c.id)}">
            I am outside ${(c.region.excluded || []).map(esc).join(", ")} and accept the
            <a href="${esc(c.region.url || "")}" target="_blank" rel="noopener">licence</a>.</label>` : ""}
          ${c.gated ? `<span class="mp-how" data-howfor="${esc(c.id)}" hidden>${esc(c.gated.how || "")}
            ${c.gated.url ? `<a href="${esc(c.gated.url)}" target="_blank" rel="noopener">Open the model page</a>` : ""}</span>` : ""}
        </div>
        <div class="mp-act">${act}</div>
      </div>`;
    }).join("");
  }
  if (rows.some((c) => c.downloading)) poll = setTimeout(() => { if (!win.hidden) paint(); }, 2000);
}

async function onRow(e) {
  const how = e.target.closest("[data-how]");
  if (how) {
    const box = win.querySelector(`[data-howfor="${CSS.escape(how.dataset.how)}"]`);
    if (box) box.hidden = !box.hidden;
    return;
  }
  const setup = e.target.closest("[data-setup]");
  if (setup) { if (current.onSetup?.(setup.dataset.setup)) return; }
  const get = e.target.closest("[data-get]");
  if (!get) return;
  /* A territory-limited model (MiniMax H3) is refused by the downloader until
   * the person confirms where they are, the same box the Models screen has.
   * Without it here, H3 could never be downloaded from this window. */
  const ack = win.querySelector(`[data-ack="${CSS.escape(get.dataset.get)}"]`);
  if (ack && !ack.checked) { say("Tick the licence box for this model first.", true); ack.focus(); return; }
  get.disabled = true;
  say("");
  try {
    const r = await fetch("/api/models", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "download", id: get.dataset.get, acceptRegion: !!ack?.checked }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) say(b.error || `The download did not start (${r.status}).`, true);
    else say("Downloading. You can minimise this window and keep working.");
  } catch { say("Could not reach Studio's server.", true); }
  paint();
}
