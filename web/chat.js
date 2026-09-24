/**
 * The Chat panel — the first entry under More tools, and the one screen you can
 * arrive at knowing nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE BINDING PRINCIPLE (web/daw.js states it; server/chat/ui_test.js enforces
 * it here): everything this page does, the server really does. Every fetch in
 * this file hits a path server/chat/routes.js really serves, every field it
 * sends is really read, and the confirm button is a CONVENIENCE — it types the
 * word "yes" into the same conversation you could have typed it into. The gate
 * that actually stops a spend lives in server/chat/loop.js, not here, because a
 * gate in a page is a decoration.
 *
 * ── WHY A SEPARATE MODULE AND NOT PART OF app.js ──────────────────────────
 *
 * The same bargain web/engine.js makes: one <script> tag, it reaches its own
 * <div id="chat"> through the DOM, it posts its own route, and deleting it
 * leaves no hole anywhere. app.js keeps three lines — the nav entry's
 * visibility, the ⓘ mount, and the boot default — and knows nothing else.
 *
 * ⚠ addEventListener, never `onclick =`. app.js owns those properties on the
 * rail links; assigning one would silently delete its handler.
 *
 * ── WHAT STREAMS ──────────────────────────────────────────────────────────
 *
 * The model is ONE NODE OUTPUT, not a token stream — ComfyUI's TextGenerate
 * hands back its whole string when the graph finishes. So what arrives down
 * this event stream is the loop's PHASES, and that is what the transcript
 * shows: thinking, the tool it called, what the tool said, then the answer.
 * Every event the route can send is drawn by onEvent() below and none is
 * invented: thinking, reask, repeat, promise, raw, tool_call, tool_result,
 * confirmed, proposal, busy, say, error, done, end, open.
 *
 * ── THE ONE SECURITY RULE ON THIS SCREEN ──────────────────────────────────
 *
 * ⚠ THE MODEL'S OUTPUT IS UNTRUSTED TEXT AND MUST NEVER REACH innerHTML
 * UNESCAPED. It is a 4B that has just read a tool result, and that tool result
 * came off disk — a file named `<img onerror=…>.wav` is a perfectly legal file
 * name and the model will happily repeat it. So renderMarkdown() ESCAPES FIRST
 * and formats the escaped string afterwards: every `<` in the source is `&lt;`
 * before a single markdown rule is applied, which means no rule can produce a
 * tag the model asked for. server/chat/ui_test.js feeds it a script tag and
 * asserts it comes back as visible text.
 */

/* Whether a writing model can answer Make song (UI_PLAN B3), one answer shared
 * with the Pictures and Video boxes (web/assist.js). */
import { writerFrom, whyNoWriter, notYetLine } from "./writer.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The conversation this tab is in. Null until the server names one. */
let SESSION = null;
let SENDING = false;
/** The in-flight stream, so Stop has something to pull on. */
let STREAM = null;

const log = () => $("chatLog");

/* ══ MARKDOWN ═════════════════════════════════════════════════════════════
 *
 * Small, dependency-free and deliberately unambitious: paragraphs, headings,
 * lists (nested by indent), block quotes, rules, fenced code, inline code,
 * bold, italic, strikethrough and links. No HTML passthrough — there is no
 * markdown feature worth an XSS hole on a screen whose text a language model
 * wrote. This app has no build step and loads no CDN, so a renderer is forty
 * lines here or it is nothing.
 *
 * ORDER IS THE WHOLE SAFETY ARGUMENT: esc() runs on the raw text BEFORE any
 * formatting rule sees it, and every rule below only ever inserts tags of its
 * own around already-escaped content.
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$/;
const ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEAD_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE_RE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;

/** Only these can become an href. Everything else is shown as plain text. */
const HREF_OK = /^(?:https?:\/\/|mailto:|\/|#)/i;

/** Inline formatting, on text that has ALREADY been escaped by inline(). */
function inlineOnEscaped(s) {
  /* Code spans are lifted out first and put back last, so a `*` inside
     backticks is not read as emphasis. \u0000 cannot appear in the source: it
     is stripped by renderMarkdown before anything else happens. */
  const spans = [];
  let out = s.replace(/(`+)([\s\S]*?)\1/g, (_m, _t, code) => {
    spans.push(`<code>${code.replace(/^ (.*) $/, "$1")}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  out = out.replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, href) =>
    (HREF_OK.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label || href}</a>`
      : m));

  out = out.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1<em>$2</em>");
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");

  return out.replace(/\u0000(\d+)\u0000/g, (_m, n) => spans[Number(n)]);
}

const inline = (text) => inlineOnEscaped(esc(text));

function codeBlock(lang, body) {
  const tag = lang ? esc(lang) : "code";
  return `<div class="chat-code"><div class="chat-code-top"><span>${tag}</span>`
    + `<button type="button" class="edtool chat-copy" data-copy>copy</button></div>`
    + `<pre><code>${esc(body)}</code></pre></div>`;
}

/**
 * Markdown → HTML. The ONLY function on this screen that produces markup from
 * model text, and it escapes before it formats.
 */
export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const mark = fence[1][0];
      const body = [];
      i++;
      while (i < lines.length) {
        const close = FENCE_RE.exec(lines[i]);
        if (close && close[1][0] === mark) { i++; break; }
        body.push(lines[i]); i++;
      }
      out.push(codeBlock(fence[2], body.join("\n")));
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (RULE_RE.test(line)) { out.push("<hr>"); i++; continue; }

    const head = HEAD_RE.exec(line);
    if (head) {
      const n = head[1].length;
      out.push(`<h${n}>${inline(head[2])}</h${n}>`);
      i++; continue;
    }

    if (QUOTE_RE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim()) {
        const q = QUOTE_RE.exec(lines[i]);
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    if (ITEM_RE.test(line)) {
      const [html, next] = listAt(lines, i, ITEM_RE.exec(line)[1].length);
      out.push(html); i = next;
      continue;
    }

    /* A paragraph runs to the blank line, and a single newline inside it is a
       line break — the model writes lyrics, and lyrics are lines. */
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !FENCE_RE.test(lines[i]) && !HEAD_RE.test(lines[i])
           && !RULE_RE.test(lines[i]) && !QUOTE_RE.test(lines[i])
           && !ITEM_RE.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${para.map((l) => inline(l.trim())).join("<br>")}</p>`);
  }

  return out.join("");
}

/**
 * One list, starting at `start`, whose markers are indented `indent` spaces.
 * Deeper-indented lines belong to the item they follow and are rendered by a
 * recursive call, which is how a nested list gets to be a nested list.
 * Returns [html, indexAfterTheList].
 */
function listAt(lines, start, indent) {
  const first = ITEM_RE.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = ITEM_RE.exec(lines[i]);
    if (!m || m[1].length < indent) break;
    if (m[1].length > indent) break;              // deeper: eaten as content below
    if (/\d/.test(m[2]) !== ordered) break;       // a different list starts here

    const body = [m[3]];
    i++;
    while (i < lines.length) {
      if (!lines[i].trim()) {
        /* A blank line ends the item unless the list carries on under it. */
        const nxt = lines[i + 1];
        if (nxt === undefined || !nxt.trim()) break;
        const nm = ITEM_RE.exec(nxt);
        if (!nm && nxt.search(/\S/) <= indent) break;
        body.push(""); i++; continue;
      }
      const nm = ITEM_RE.exec(lines[i]);
      if (nm && nm[1].length <= indent) break;
      if (!nm && lines[i].search(/\S/) <= indent) break;
      body.push(lines[i].slice(Math.min(lines[i].search(/\S/), indent + 2)));
      i++;
    }

    const rendered = renderMarkdown(body.join("\n"));
    /* A single leading paragraph unwraps, so a short item is one line rather
       than three and a nested list sits directly under its parent. An item with
       two paragraphs keeps both — that is a loose list and it should look it. */
    const tight = (rendered.match(/<p>/g) || []).length === 1 && rendered.startsWith("<p>");
    items.push(`<li>${tight ? rendered.replace(/^<p>([\s\S]*?)<\/p>/, "$1") : rendered}</li>`);
  }

  const tag = ordered ? "ol" : "ul";
  const startAt = ordered && first[2].length > 1 && first[2].slice(0, -1) !== "1"
    ? ` start="${Number(first[2].slice(0, -1)) || 1}"` : "";
  return [`<${tag}${startAt}>${items.join("")}</${tag}>`, i];
}

/* ══ THE TRANSCRIPT ═══════════════════════════════════════════════════════ */

function scroll() {
  const el = $("chatScroll");
  if (el) el.scrollTop = el.scrollHeight;
}

/** One row in the transcript. `kind` is also the CSS hook. */
/* The warning a GPU tool shows when it starts, in either assistant. Cancel
 * is the app's one Stop (app.js aiplay:gpu-cancel -> /api/cancel: the song,
 * pictures and clips in progress), which also drops a remix transcription the
 * page was about to follow with Create. */
function gpuWarning(ev) {
  return `<span class="gpuwarn">⚠ ${esc(ev.text || "Using the graphics card.")}</span> `
    + `<button type="button" class="btn sm ghost gpucancel">Cancel</button>`;
}
if (typeof document !== "undefined") document.addEventListener("click", async (e) => {
  const b = e.target.closest?.(".gpucancel");
  if (!b || b.disabled) return;
  b.disabled = true;
  b.textContent = "Cancelling…";
  /* The Stop itself is app.js's (it owns /api/cancel); it answers in `detail`. */
  const detail = { done: null };
  document.dispatchEvent(new CustomEvent("aiplay:gpu-cancel", { detail }));
  const ok = await (detail.done || Promise.resolve(false));
  b.textContent = ok ? "Cancelled" : "Could not cancel";
  b.disabled = ok;
});

function row(kind, html) {
  const el = log();
  if (!el) return null;
  clearEmpty();
  const d = document.createElement("div");
  d.className = `chat-row chat-${kind}`;
  d.innerHTML = html;
  el.appendChild(d);
  /* The phase line always sits last, whatever was appended after it. */
  if (phaseEl && phaseEl.parentNode === el) el.appendChild(phaseEl);
  scroll();
  return d;
}

/** A phase row that is replaced as the step moves on, rather than piling up. */
let phaseEl = null;
function phase(html) {
  const el = log();
  if (!el) return;
  if (!phaseEl) { clearEmpty(); phaseEl = document.createElement("div"); phaseEl.className = "chat-row chat-phase"; }
  phaseEl.innerHTML = html;
  el.appendChild(phaseEl);
  scroll();
}
function clearPhase() {
  if (phaseEl) phaseEl.remove();
  phaseEl = null;
}
const dot = (text) => `<i class="chat-dot"></i><span>${text}</span>`;

/** The card of the tool that is running right now, so its result lands in it. */
let toolEl = null;
/** The turn's collected raw model replies, tucked into one fold. */
let rawEl = null;

/** Arguments, small and readable. Flat by construction — the protocol forbids
 *  anything else — so one line each is the whole of it. */
function argList(args) {
  const rows = Object.entries(args || {}).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const cut = s.length > 600 ? `${s.slice(0, 600)}…` : s;
    return `<dt>${esc(k)}</dt><dd>${esc(cut)}</dd>`;
  });
  return rows.length
    ? `<dl class="chat-args">${rows.join("")}</dl>`
    : `<dl class="chat-args"><dt>—</dt><dd>no arguments</dd></dl>`;
}

/** What the eight tools actually do, in the words a person would use. */
const PLAIN = {
  make_song: "write and render a song",
  song_status: "check how a render is going",
  list_library: "look through what you already have",
  make_image: "draw a picture",
  list_images: "look through the pictures already made",
  mv_create_project: "start a music-video project",
  mv_previz_shot: "block a shot in Blender",
  mv_control_check: "check a clip is legal to steer a render with",
};

/** A one-line reading of what came back, for the folded summary. */
function summarise(result) {
  if (result === null || result === undefined) return "answered";
  if (Array.isArray(result)) return `${result.length} item${result.length === 1 ? "" : "s"}`;
  if (typeof result !== "object") return String(result).slice(0, 60);
  /* `image` leads, because a picture's file name IS the answer to the only
   * question its card raises — which of the 500 in that folder is mine. */
  for (const k of ["image", "note", "status", "stage", "state", "title", "job_id", "verdict"]) {
    const v = result[k];
    if (typeof v === "string" || typeof v === "number") return `${k}: ${String(v).slice(0, 54)}`;
  }
  const n = Object.keys(result).length;
  return `${n} field${n === 1 ? "" : "s"}`;
}

function toolCard(ev) {
  const d = document.createElement("details");
  d.className = "chat-row chat-tool";
  d.open = true;
  d.dataset.state = "run";
  d.innerHTML =
    `<summary><span class="chat-caret">▶</span>`
    + `<b>${esc(ev.tool)}</b><span class="chat-tool-what">${esc(PLAIN[ev.tool] || "")}</span>`
    + (ev.spends ? `<span class="chat-spends">spends</span>` : "")
    + `<span class="chat-tool-state">running…</span></summary>`
    + `<div class="chat-tool-body">${argList(ev.args)}</div>`;
  const el = log();
  if (!el) return null;
  clearEmpty();
  el.appendChild(d);
  if (phaseEl && phaseEl.parentNode === el) el.appendChild(phaseEl);
  scroll();
  return d;
}

/** The one image a tool result may show, and ONLY from this app's own image
 *  route. An absolute URL, a data: URI, or a name carrying a quote is not a
 *  picture this app made, so it is not drawn at all. */
function imageUrl(result) {
  const u = result && typeof result.url === "string" ? result.url : "";
  return /^\/api\/image\/[^"'<>\s?#]+$/.test(u) ? u : null;
}

function finishTool(ev) {
  const d = toolEl;
  toolEl = null;
  const body = d ? d.querySelector(".chat-tool-body") : null;
  if (!d || !body) {                              // a result with no card: draw one
    row("tool", `<b>${esc(ev.tool)}</b> answered`);
    return;
  }
  const state = d.querySelector(".chat-tool-state");
  if (ev.error) {
    d.dataset.state = "fail";
    if (state) state.textContent = "did not work";
    body.insertAdjacentHTML("beforeend", `<div class="chat-toolfail">${esc(ev.error)}</div>`);
    return;                                        // a failure stays open
  }
  d.dataset.state = "ok";
  if (state) state.textContent = summarise(ev.result);
  /* THE PICTURE ITSELF, when the tool made one. "It landed in your Images
   * library" is a sentence about a file; this is the file. The src is built
   * ONLY from a result field matching this app's own image route, and it is
   * escaped like everything else on this screen — a picture's name comes off
   * disk, and `<img onerror=…>.png` is a legal file name. */
  const shot = imageUrl(ev.result);
  if (shot) {
    body.insertAdjacentHTML("beforeend",
      `<img class="chat-shot" src="${esc(shot)}" alt="the picture this tool just made" loading="lazy">`);
  }
  body.insertAdjacentHTML("beforeend",
    `<pre class="chat-json">${esc(JSON.stringify(ev.result, null, 1) || "").slice(0, 4000)}</pre>`);
  /* Folded once it has answered — EXCEPT when it is showing a picture, where
   * folding would hide the only part of the card worth looking at. */
  d.open = !!shot;
  scroll();
}

/** The model's whole reply, kept but folded — evidence, not reading. */
function addRaw(ev) {
  const el = log();
  if (!el) return;
  if (!rawEl) {
    rawEl = document.createElement("details");
    rawEl.className = "chat-row chat-raw";
    rawEl.innerHTML = `<summary>the model's reply</summary>`;
    clearEmpty();
    el.appendChild(rawEl);
  }
  rawEl.insertAdjacentHTML("beforeend",
    `<pre>step ${esc(ev.step)}\n${esc(ev.text)}</pre>`);
  if (phaseEl && phaseEl.parentNode === el) el.appendChild(phaseEl);
}

/* ── the decision card ───────────────────────────────────────────────────── */

function showConfirm(ev) {
  const box = $("chatConfirm");
  if (!box) return;
  $("chatConfirmText").innerHTML =
    `<div class="chat-toolname">${esc(ev.tool)} — ${esc(PLAIN[ev.tool] || "spends GPU time")}</div>`
    + `<div class="chat-cost">${esc(ev.cost || "GPU time")}</div>`
    + argList(ev.args);
  box.hidden = false;
  const yes = $("chatYes");
  if (yes) yes.focus();
}
function hideConfirm() { const b = $("chatConfirm"); if (b) b.hidden = true; }

function showBusy(text) {
  const b = $("chatBusyText");
  const box = $("chatBusy");
  if (!b || !box) return;
  b.textContent = text;
  box.hidden = false;
}
function hideBusy() { const b = $("chatBusy"); if (b) b.hidden = true; }

/* ══ ONE EVENT FROM THE LOOP ══════════════════════════════════════════════ */

function onEvent(ev) {
  switch (ev.type) {
    case "open":
      SESSION = ev.session;
      break;
    case "thinking":
      phase(dot(`thinking &middot; step ${esc(ev.step)} of ${esc(ev.of)}`));
      break;
    case "reask":
      phase(dot("that reply did not parse &mdash; asking once more"));
      break;
    /* The loop refused to run a tool it had already run this turn. Shown rather
     * than hidden: it is a second of card that a person watching should be able
     * to account for. */
    case "repeat":
      phase(dot(`${esc(ev.tool)} already answered &mdash; asking for words`));
      break;
    /* The reply announced an action and called no tool. Shown for the same
     * reason as `repeat`: it is a second of card, and a person who watched a
     * promise go by should be able to see why the answer took a moment longer. */
    case "promise":
      phase(dot("that reply promised something and did nothing &mdash; asking once more"));
      break;
    /* THE ROUTER REACHED INTO THE WIDER LIBRARY. The chat carries eight
     * written tools; the rest of the studio's surface is matched against the
     * message and only the handful that fit are described to the model. Shown,
     * because otherwise the chat appears to know things it was never told, and
     * because when it picks the wrong ones this line is the explanation. */
    case "routed":
      phase(dot(`reached for ${esc(ev.tools.join(", "))}`));
      break;
    case "raw":
      addRaw(ev);
      break;
    case "tool_call":
      clearPhase();
      toolEl = toolCard(ev);
      phase(dot(`running ${esc(ev.tool)}&hellip;`));
      break;
    case "tool_result":
      clearPhase();
      finishTool(ev);
      break;
    case "confirmed":
      hideConfirm();
      row("note", `Confirmed &mdash; running <b>${esc(ev.tool)}</b>.`);
      break;
    case "proposal":
      clearPhase();
      row("say", `<div class="chat-md">${renderMarkdown(ev.text)}</div>`);
      showConfirm(ev);
      break;
    /* GPU work that ran without asking (loop.js "GO, WITH A WARNING"): say the
     * card is in use and offer the app's own Stop. */
    case "gpu":
      clearPhase();
      row("note", gpuWarning(ev));
      break;
    case "busy":
      clearPhase();
      showBusy(ev.text);
      row("note", esc(ev.text));
      break;
    case "say":
      clearPhase();
      row("say", `<div class="chat-md">${renderMarkdown(ev.text)}</div>`);
      break;
    case "error":
      clearPhase();
      row("fail", `<b>That did not work.</b> ${esc(ev.text)}`);
      break;
    case "done":
      break;                                   // `end` closes the turn; this is its shape
    case "end":
      clearPhase();
      break;
    default:
      break;
  }
}

/* ══ SENDING ══════════════════════════════════════════════════════════════ */

function inFlight(on) {
  SENDING = on;
  const send = $("chatSend");
  const stop = $("chatStop");
  if (send) send.disabled = on;
  if (stop) stop.hidden = !on;
}

/**
 * POST /api/chat and read the event stream.
 *
 * EventSource cannot POST, and the message has to go in a body — so this is
 * fetch plus a reader over the same `data: {...}` framing EventSource would
 * have parsed. Nothing else about the protocol differs.
 */
async function send(message) {
  if (SENDING || !String(message).trim()) return;
  inFlight(true);
  hideBusy();
  hideConfirm();
  rawEl = null;
  toolEl = null;
  row("me", esc(message));

  const fresh = !SESSION;
  STREAM = new AbortController();
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session: SESSION }),
      signal: STREAM.signal,
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* a partial frame */ }
        }
      }
    }
    if (fresh) loadSessions();
  } catch (e) {
    clearPhase();
    /* STOP IS HONEST. Aborting the read closes this page's ear; it does not
     * reach into the graphics card and take back a render that already began.
     * Saying so is the difference between a stop button and a lie. */
    if (e?.name === "AbortError") {
      row("note", "Stopped listening. Anything already started on the graphics card keeps going &mdash; "
        + "the Engine tab shows it.");
    } else {
      row("fail", `<b>That did not work.</b> ${esc(e.message || e)}`);
    }
  } finally {
    STREAM = null;
    inFlight(false);
    scroll();
  }
}

/* ══ EARLIER CONVERSATIONS ════════════════════════════════════════════════ */

/**
 * GET /api/chat/sessions, and — when one is chosen — the same route with `id`
 * for its turns. Two reads, no third path.
 */
async function loadSessions() {
  const sel = $("chatSessions");
  if (!sel) return;
  try {
    const d = await (await fetch("/api/chat/sessions?limit=30")).json();
    const rows = d.sessions || [];
    sel.innerHTML = `<option value="">new conversation</option>`
      + rows.map((s) => `<option value="${esc(s.id)}">${esc(s.opened_with || s.id)}</option>`).join("");
    sel.disabled = rows.length === 0;
    if (SESSION) sel.value = SESSION;
  } catch { sel.disabled = true; }
}

async function openSession(id) {
  const el = log();
  if (!el) return;
  el.innerHTML = "";
  clearPhase(); hideConfirm(); hideBusy();
  rawEl = null; toolEl = null;
  SESSION = id || null;
  if (!id) { greet(); return; }
  try {
    const d = await (await fetch(`/api/chat/sessions?id=${encodeURIComponent(id)}`)).json();
    for (const t of d.turns || []) {
      if (t.role === "user") row("me", esc(t.text));
      else if (t.role !== "event") continue;
      else if (t.type === "say") row("say", `<div class="chat-md">${renderMarkdown(t.text)}</div>`);
      else if (t.type === "tool_call") { toolEl = toolCard(t); if (toolEl) toolEl.open = false; toolEl = null; }
      else if (t.type === "busy") row("note", esc(t.text));
    }
  } catch { row("fail", "That conversation could not be read back."); }
  scroll();
}

/* ══ THE EMPTY STATE ══════════════════════════════════════════════════════
 *
 * The eight tools, named as the eight things they do. A person who has never
 * seen this screen should be able to read it and know what to type — and the
 * cards type it for them, which is the difference between a suggestion and a
 * hint.
 */
const CANS = [
  { t: "Write and render a song", s: "Words, a style and a voice, rendered here.",
    spends: true, ask: "Write and render a song about " },
  { t: "Check on a render", s: "How far through a song is, by its job id.",
    ask: "How is my last song doing?" },
  { t: "Look through what you have", s: "Every track on this disk, newest first.",
    ask: "What is in my library?" },
  /* ⚠ THE CARD THIS SCREEN WAS MISSING. Asked for a picture the chat used to
   * answer "Sure! Let me create the brainrot image for you" and then do
   * nothing, because none of its tools could draw. The card is here as much as
   * an admission as an invitation. */
  { t: "Draw a picture", s: "One picture, into the Images library.",
    spends: true, ask: "Draw me a picture of " },
  { t: "Look through your pictures", s: "Every picture on this disk, newest first.",
    ask: "What pictures have I made?" },
  { t: "Start a music-video project", s: "A project for a track you already made.",
    ask: "Start a music-video project for " },
  { t: "Block a shot in Blender", s: "A camera move, previz'd as a real clip.",
    spends: true, ask: "Block a slow push-in shot for " },
  { t: "Check a clip can steer a render", s: "Whether a control clip is legal to use.",
    ask: "Can I use this clip to steer a render? " },
];

function clearEmpty() {
  const el = log();
  const e = el && el.querySelector(".chat-empty");
  if (e) e.remove();
}

function greet() {
  const el = log();
  if (!el) return;
  const d = document.createElement("div");
  d.className = "chat-row chat-empty";
  d.innerHTML =
    `<h3>What do you want to make?</h3>`
    + `<p>A language model — a local one on this machine, or a cloud API connected on the Agent page — can work the Studio for you. It reads what you already `
    + `have, writes and renders new music, draws pictures into your Images library, and blocks `
    + `shots for a video. Anything that spends time on the graphics card is proposed first and `
    + `waits for you to say yes.</p>`
    + `<div class="chat-cans">`
    + CANS.map((c) =>
      `<button type="button" class="chat-can" data-ask="${esc(c.ask)}">`
      + `<b>${esc(c.t)}</b><span>${esc(c.s)}</span>`
      + (c.spends ? `<em>spends GPU time</em>` : "")
      + `</button>`).join("")
    + `</div>`;
  el.appendChild(d);
}

/* ══ THE COMPOSER ═════════════════════════════════════════════════════════ */

function grow() {
  const t = $("chatText");
  if (!t) return;
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
}

function ask(text) {
  const t = $("chatText");
  if (!t) return;
  t.value = text;
  grow();
  t.focus();
  t.setSelectionRange(text.length, text.length);
}

/* ══ WIRING ═══════════════════════════════════════════════════════════════ */

/* ══ THE MODEL PICKER ════════════════════════════════════════════════════ */

/**
 * Fill a model menu from a /models answer: cloud APIs connected on the Agent
 * page first, then the local files ComfyUI can load. Shared by the Chat tab
 * and Simple mode. The engine being down only hides the local group — a
 * connected API still works without it. Returns the current row, or null.
 *
 * `opts.lead`: a first option worth "" (Settings' Enhance picker: "Same as
 * Simple mode (then Chat)"), selected unless the answer's `own` choice is in
 * the list. All six writer pickers come through here (UI_PLAN B2).
 */
export function fillModelMenu(sel, d, emptyTitle, opts = {}) {
  /* `models` is what can write, by name (server/chat/models.js writerVerdict);
   * `every` is every file, behind "Show every file" (UI_PLAN B2). */
  const all = sel.dataset?.every === "1" && Array.isArray(d?.every);
  const models = all ? d.every : Array.isArray(d?.models) ? d.models : [];
  writerExtras(sel, d, models, all, emptyTitle, opts);
  const apis = models.filter((m) => m.api);
  const local = models.filter((m) => !m.api);
  if (!models.length) {
    sel.innerHTML = `<option value="">${d?.offline ? "waiting for the engine…" : d ? "no chat model found" : "unavailable"}</option>`;
    sel.disabled = true;
    sel.title = d && !d.offline ? emptyTitle : "";
    return null;
  }
  const opt = (m) => `<option value="${esc(m.file)}" title="${esc(m.api ? m.model : m.file)}">${esc(m.label)}${m.why ? ` — ${esc(m.why)}` : ""}</option>`;
  sel.innerHTML = (opts.lead ? `<option value="">${esc(opts.lead)}</option>` : "") + (apis.length ? `<optgroup label="Cloud API">${apis.map(opt).join("")}</optgroup>` : "")
    + (local.length ? `<optgroup label="Local · this machine">${local.map(opt).join("")}</optgroup>`
      : d.offline ? '<optgroup label="Local · this machine"><option value="" disabled>waiting for the engine…</option></optgroup>' : "");
  const cur = models.find((m) => m.file === d.current) || null;
  if (opts.lead) sel.value = d.own && models.some((m) => m.file === d.own) ? d.own : "";
  else sel.value = cur ? cur.file : models[0].file;
  sel.title = cur?.api ? `${cur.label} — answers over the internet, billed to your API account` : (d.current || "");
  sel.disabled = false;
  return cur;
}

/* ONE CHOICE IS PLAIN TEXT, NOT A MENU, and every file stays one click away.
 * A span after the picker (the picker itself, its id and its change handler
 * are untouched): the one writer's name, "Show every file" when the server
 * filtered some out, and the way back. Only in a real document. */
function writerExtras(sel, d, models, all, emptyTitle, opts = {}) {
  if (typeof document === "undefined" || !sel?.parentNode || typeof sel.after !== "function") return;
  let box = sel.nextElementSibling?.classList?.contains("mpick1") ? sel.nextElementSibling : null;
  if (!box) {
    box = document.createElement("span");
    box.className = "mpick1";
    sel.after(box);
    box.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-every]");
      if (!b || !box.fill) return;
      sel.dataset.every = b.dataset.every;
      fillModelMenu(sel, box.fill.d, box.fill.emptyTitle, box.fill.opts);
    });
  }
  box.fill = { d, emptyTitle, opts };
  const single = !all && models.length === 1 && !d?.offline;
  const filtered = Array.isArray(d?.every) && d.every.length > (d?.models?.length || 0);
  sel.hidden = single;
  box.innerHTML = (single ? `<b title="${esc(models[0].file)}">${esc(models[0].label)}</b>` : "")
    + (!all && filtered ? '<button type="button" class="linkbtn" data-every="1">Show every file</button>' : "")
    + (all ? '<button type="button" class="linkbtn" data-every="">Only writers</button>' : "");
  box.hidden = !box.innerHTML;
}

/* GET /api/chat/models lists what ComfyUI can load plus connected APIs; POST
 * saves the choice. ComfyUI not running yet is not an error — ask again when
 * the view opens. */
async function loadModels() {
  const sel = $("chatModel");
  if (!sel) return;
  let d;
  try { d = await (await fetch("/api/chat/models")).json(); } catch { d = null; }
  const cur = fillModelMenu(sel, d, "Put a Qwen3 (or Gemma) text encoder in models/text_encoders, or connect an API on the Agent page");
  const head = $("chatHead");
  if (head) head.textContent = cur?.api ? `via ${cur.label.split(" · ")[0]}` : "on this machine";
}

function init() {
  if (!$("chatLog")) return;                 // not this page
  /* A key saved or removed on the Agent page changes both menus at once. */
  document.addEventListener("aiplay:llm-changed", () => { loadModels(); loadSimpleModels(); });
  greet();
  loadSessions();
  loadModels();
  $("chatModel")?.addEventListener("focus", () => { if ($("chatModel").disabled) loadModels(); });
  $("chatModel")?.addEventListener("change", async (e) => {
    const sel = e.target;
    sel.disabled = true;
    try {
      const r = await (await fetch("/api/chat/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: sel.value }),
      })).json();
      if (r.error) alert(r.error);
    } catch { /* offline */ }
    await loadModels();
  });

  $("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("chatText");
    const v = t.value;
    t.value = "";
    grow();
    send(v);
  });
  /* Enter sends, shift+Enter is a new line — a caption is three sentences and
   * has to be typeable. */
  $("chatText").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("chatForm").requestSubmit();
    }
  });
  $("chatText").addEventListener("input", grow);

  /* STOP closes this page's ear on the stream. It is not a kill switch for the
   * graphics card and does not claim to be; the note it writes says so. */
  $("chatStop").addEventListener("click", () => { if (STREAM) STREAM.abort(); });

  /* THE CONFIRM BUTTON IS A CONVENIENCE. It sends the word "yes" as an ordinary
   * message, which is exactly what typing it would do; the loop's gate reads
   * the message and nothing about this button. */
  $("chatYes").addEventListener("click", () => { hideConfirm(); send("yes"); });
  $("chatNo").addEventListener("click", () => { hideConfirm(); send("no"); });

  $("chatSessions").addEventListener("change", (e) => openSession(e.target.value));
  $("chatNew").addEventListener("click", () => {
    const sel = $("chatSessions");
    if (sel) sel.value = "";
    openSession("");
    const t = $("chatText");
    if (t) t.focus();
  });

  /* One delegated listener for everything the transcript draws: the copy button
   * on a code block, and the eight cards in the empty state. */
  $("chatLog").addEventListener("click", (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      const pre = copy.closest(".chat-code")?.querySelector("pre");
      if (pre && navigator.clipboard) {
        navigator.clipboard.writeText(pre.textContent).then(() => {
          copy.textContent = "copied";
          setTimeout(() => { copy.textContent = "copy"; }, 1200);
        }).catch(() => { copy.textContent = "no"; });
      }
      return;
    }
    const can = e.target.closest("[data-ask]");
    if (can) ask(can.dataset.ask);
  });
}

/* ══ SIMPLE MODE — the Music panel's assistant ═════════════════════════════
 *
 * The same loop and model as this tab, reached at /api/chat/music with only
 * three tools (server/chat/music-tools.js). The page's form is web/app.js's, so
 * this code never touches it directly: it asks for a snapshot, hands back the
 * patches the tools return, and asks for Create — all as document events. */

let SIMPLE_SESSION = null;
let SIMPLE_SENDING = false;
/* Stop for Simple mode: while a reply runs, Send is a ■ that aborts it (the
 * server stops the turn at its next step). A hung stream used to leave Send
 * greyed out until a reload. */
let SIMPLE_STREAM = null;
function simpleBusy(on) {
  const b = $("simpleSend");
  if (!b) return;
  b.disabled = false;
  b.classList.toggle("stop", on);
  b.textContent = on ? "■ Stop" : "Make song";
  b.setAttribute("aria-label", on ? "Stop" : "Make song");
  b.title = on ? "Stop the assistant" : "";
}

/* MAKE SONG (UI_PLAN B3, E1). The button says Make song, so a press makes one
 * or says plainly why not.
 *
 *   WITH A WRITING MODEL the words go to the assistant, and the press is the
 *   person's go-ahead: when the reply wrote the song or changed its settings
 *   and did not start it, Create is pressed for them (simpleSend's `make`), and
 *   the log says so.
 *   WITH NONE (the server answered, and has no model) a song already in the
 *   form (a preset, or one written under Song) is made through the page's own
 *   door, aiplay:simple-generate, which reports back as usual. Typed words
 *   cannot become a song without a writer: that is said, the words stay in the
 *   box, and the form's song is offered, never made in their place unasked.
 *   NOT KNOWN YET (the engine is still starting) nothing is sent, and the log
 *   says why (web/writer.js).
 *
 * SIMPLE_WRITER is true, false or null (web/writer.js writerFrom), and is read
 * again at every press until it is true. */
let SIMPLE_WRITER = null;
function simpleFormSong() {
  const form = {};
  document.dispatchEvent(new CustomEvent("aiplay:simple-snapshot", { detail: form }));
  return !!String(form.style || "").trim() && (!!form.instrumental || !!String(form.lyrics || "").trim());
}
function simpleMakeForm() {
  simpleRow("note", "Making the song that is in the form.");
  document.dispatchEvent(new CustomEvent("aiplay:simple-generate"));
}
function simpleWithoutWriter(typed, musicOnly) {
  const song = simpleFormSong();
  if (song && !String(typed || "").trim()) return simpleMakeForm();
  /* Music only has no Models row for a writing model; its door is a key. */
  const get = musicOnly
    ? 'or connect an API key on the <a href="#" data-go="mcp">Agent</a> page'
    : 'or get one on <a href="#" data-go="models">Models</a>';
  if (song) {
    simpleRow("note", `No writing model here, so your words cannot become a song yet; they are still in the box. `
      + `<a href="#" data-simple-form>Make the song already in the form</a> instead, ${get}.`);
    return;
  }
  simpleRow("note", `No writing model here yet. Pick a preset, write it under <a href="#" data-simple-song>Song</a>, ${get}.`);
}

function simpleRow(kind, html) {
  const log = $("simpleLog");
  if (!log) return;
  log.querySelector(".simple-hello")?.remove();
  const d = document.createElement("div");
  d.className = `simple-row ${kind}`;
  d.innerHTML = html;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}
function simpleStatus(text) {
  const s = $("simpleStatus");
  if (!s) return;
  s.hidden = !text;
  if (text) $("simpleStatusText").textContent = text;
}
const SIMPLE_DOING = {
  write_song: "Writing the lyrics and style…",
  change_settings: "Changing the settings…",
  generate: "Starting the song…",
  remix_song: "Setting up the remix…",
};
/* Long steps the page runs for the assistant (a remix's transcription). */
if (typeof document !== "undefined") document.addEventListener("aiplay:simple-progress", (e) => {
  if (e.detail?.text) simpleRow("note", esc(e.detail.text));
});
/* The page's answer to generate: did Create really start (app.js)? */
if (typeof document !== "undefined") document.addEventListener("aiplay:simple-generated", (e) => {
  const { ok, why } = e.detail || {};
  simpleRow(ok ? "did" : "fail", ok ? "✓ Rendering started" : `Create did not start: ${esc(why || "unknown reason")}`);
});
/* What the running reply did, for Make song's go-ahead (simpleSend `make`). */
let SIMPLE_TURN = null;
function onSimpleEvent(ev) {
  const turn = SIMPLE_TURN || {};
  if (ev.type === "open") { SIMPLE_SESSION = ev.session; return; }
  if (ev.type === "thinking") { simpleStatus("Thinking…"); return; }
  if (ev.type === "tool_call") { simpleStatus(SIMPLE_DOING[ev.tool] || "Working…"); return; }
  if (ev.type === "tool_result") {
    if (ev.error) { turn.failed = true; simpleRow("fail", `${esc(ev.tool)} did not work: ${esc(ev.error)}`); return; }
    const r = ev.result || {};
    if (["write_song", "change_settings", "remix_song"].includes(ev.tool)) turn.wrote = true;
    if (r.action === "generate") turn.started = true;
    if (r.form) document.dispatchEvent(new CustomEvent("aiplay:simple-form", { detail: r.form }));
    if (r.action === "generate") document.dispatchEvent(new CustomEvent("aiplay:simple-generate"));
    const what = ev.tool === "write_song" ? `Wrote the ${esc(r.written || "song")}`
      : ev.tool === "change_settings" ? `Changed ${esc(r.changed || "settings")}`
      : ev.tool === "generate" ? "Asked the page to press Create"
      : ev.tool === "remix_song" ? `Set up the remix: ${esc(r.remix || "")}` : esc(ev.tool);
    simpleRow("did", `✓ ${what}`);
    return;
  }
  if (ev.type === "say") { simpleRow("bot", esc(ev.text).replace(/\n/g, "<br>")); return; }
  if (ev.type === "proposal") { turn.proposed = true; simpleStatus(""); $("simpleConfirm").hidden = false; return; }
  if (ev.type === "gpu") { simpleRow("note", gpuWarning(ev)); return; }
  if (ev.type === "busy") { turn.failed = true; simpleRow("note", esc(ev.text)); return; }
  if (ev.type === "error") { turn.failed = true; simpleRow("fail", esc(ev.text)); return; }
  if (ev.type === "done" || ev.type === "end") simpleStatus("");
}

/* `make`: the words came from pressing Make song (or Enter in its box), so a
 * reply that set the song up and did not start it is followed by Create. */
async function simpleSend(message, { make = false } = {}) {
  message = String(message || "").trim();
  if (SIMPLE_SENDING || !message) return;
  SIMPLE_SENDING = true;
  SIMPLE_TURN = { make, wrote: false, started: false, proposed: false, failed: false, stopped: false };
  SIMPLE_STREAM = new AbortController();
  $("simpleConfirm").hidden = true;
  simpleBusy(true);
  simpleRow("me", esc(message));
  simpleStatus("Thinking…");
  const form = {};
  document.dispatchEvent(new CustomEvent("aiplay:simple-snapshot", { detail: form }));
  try {
    const r = await fetch("/api/chat/music", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session: SIMPLE_SESSION, form }),
      signal: SIMPLE_STREAM.signal,
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { onSimpleEvent(JSON.parse(line.slice(5).trim())); } catch { /* a partial frame */ }
        }
      }
    }
  } catch (e) {
    SIMPLE_TURN.stopped = true;
    if (e?.name === "AbortError") simpleRow("note", "Stopped.");
    else simpleRow("fail", `That did not work. ${esc(e.message || e)}`);
  } finally {
    const turn = SIMPLE_TURN;
    SIMPLE_TURN = null;
    SIMPLE_SENDING = false;
    SIMPLE_STREAM = null;
    simpleBusy(false);
    simpleStatus("");
    if (turn?.make && turn.wrote && !turn.started && !turn.proposed && !turn.failed && !turn.stopped) {
      simpleRow("note", "You pressed Make song, so Studio pressed Create.");
      document.dispatchEvent(new CustomEvent("aiplay:simple-generate"));
    }
  }
}

/* The Simple panel's own model choice: GET /api/chat/music/models lists what
 * ComfyUI can load, POST saves it for Simple mode only. */
async function loadSimpleModels() {
  const sel = $("simpleModel");
  if (!sel) return;
  let d;
  try { d = await (await fetch("/api/chat/music/models")).json(); } catch { d = null; }
  fillModelMenu(sel, d, "Put a Qwen3, Qwen3-VL or Gemma 3 text encoder in models/text_encoders, or connect an API on the Agent page");
  SIMPLE_WRITER = writerFrom(d);
}

function initSimple() {
  if (!$("simplePanel")) return;
  loadSimpleModels();
  $("simpleModel").addEventListener("focus", () => { if ($("simpleModel").disabled) loadSimpleModels(); });
  $("simpleModel").addEventListener("pointerdown", () => { if ($("simpleModel").disabled) loadSimpleModels(); });
  $("simpleModel").addEventListener("change", async (e) => {
    const sel = e.target;
    sel.disabled = true;
    try {
      const r = await (await fetch("/api/chat/music/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: sel.value }),
      })).json();
      if (r.error) alert(r.error);
    } catch { /* offline */ }
    await loadSimpleModels();
  });
  $("simpleForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (SIMPLE_SENDING) { SIMPLE_STREAM?.abort(); return; }   // the button is Stop while a reply runs
    const t = $("simpleText");
    const v = t.value;
    (async () => {
      /* Asked again at every press until the answer is yes (web/writer.js). */
      if (SIMPLE_WRITER !== true) await loadSimpleModels();
      if (SIMPLE_WRITER === null) {
        const why = await whyNoWriter();
        /* No engine in this mode at all (Music only's native engine): no local
         * writing model can answer, which is the same as none. */
        if (why.kind !== "noengine") return simpleRow("note", esc(notYetLine(why.kind, "Make song")));
        return simpleWithoutWriter(v, why.musicOnly);
      }
      /* No writer: the words stay in the box for when there is one. */
      if (SIMPLE_WRITER === false) return simpleWithoutWriter(v, false);
      /* Nothing typed, but a song in the form (a preset): Make song makes it. */
      if (!v.trim()) return simpleFormSong() ? simpleMakeForm() : t.focus();
      t.value = "";
      return simpleSend(v, { make: true });
    })();
  });
  /* The links in the no-writer lines: "Song" leaves Simple for the full form;
   * "Make the song already in the form" does that, asked for. */
  $("simpleLog")?.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-simple-song]")) { e.preventDefault(); $("modeSong")?.click(); return; }
    if (e.target.closest?.("[data-simple-form]")) { e.preventDefault(); simpleMakeForm(); }
  });
  $("simpleText").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!SIMPLE_SENDING) $("simpleForm").requestSubmit(); }
  });
  /* Make song / Not yet are conveniences: they send "yes" / "no", which is what
   * the loop's confirm gate reads. (The confirm button says Make song, the same
   * words as the button that asked, since UI_PLAN B3.) */
  $("simpleYes").addEventListener("click", () => { $("simpleConfirm").hidden = true; simpleSend("yes"); });
  $("simpleNo").addEventListener("click", () => { $("simpleConfirm").hidden = true; simpleSend("no"); });
  $("simpleNew").addEventListener("click", () => {
    SIMPLE_SESSION = null;
    $("simpleConfirm").hidden = true;
    $("simpleLog").innerHTML = "";   // empty collapses the log; the "!" holds the introduction
    $("simpleText").focus();
  });
}

if (typeof document !== "undefined") {
  const boot = () => { init(); initSimple(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
