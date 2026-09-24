/**
 * THE WELCOME WINDOW — what is what, and what can be done with this studio.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THIS FILE WRITES NO COPY. Every sentence it puts on screen comes from
 * /api/welcome, which is server/welcome/catalogue.js, which is the same
 * document `studio_capabilities` hands an agent. If you find yourself wanting
 * to add a paragraph here, you have found a missing field in the catalogue —
 * the moment this page starts explaining the app in its own words, there are
 * two descriptions of the studio and one of them is wrong.
 *
 * The only strings below are labels for controls and the empty-state line, and
 * server/welcome/ui_test.js is what keeps it that way.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * IT NO LONGER OPENS BY ITSELF (UI_PLAN B5). A new install gets three lines on
 * Home instead (#homeStrip): what Studio read on this PC, which models, and
 * whether video clips fit, word for word from /api/welcome {action:"first_run"}
 * (server/welcome/firstrun.js), the same lines studio_welcome returns. Hide
 * posts `dismiss`; the flag lives in settings.json, not in this browser, so it
 * is one answer for every browser on the machine and an agent can read and
 * change it too. The tour itself is under About ("Take the welcome tour").
 *
 * NAVIGATION IS BORROWED, NOT INVENTED. Every screen card carries
 * `data-go="<view>"`, which app.js's existing delegated handler already turns
 * into a view switch — the same door the About page's cross-links use. The DAW
 * is a real page, so its card is a real link. Nothing here reaches into app.js.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const post = async (body) => {
  const r = await fetch("/api/welcome", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
};

const state = { cat: null, el: null, open: false };

/* ── the sections ───────────────────────────────────────────────────────── */

function whatThisIs(c) {
  return `
    <section class="wcsec" id="wcWhat">
      <h2>${esc(c.identity.name)}</h2>
      <p class="wclead">${esc(c.identity.lead)}</p>
      <ul class="wcpromise">
        ${c.identity.promise.map((p) => `<li>${esc(p)}</li>`).join("")}
      </ul>
    </section>`;
}

function whereToStart(c) {
  return `
    <section class="wcsec" id="wcStart">
      <h3>Where to start</h3>
      <ol class="wcsteps">
        ${c.start.map((s) => `
          <li>
            <b>${esc(s.what)}</b>
            <span class="wcwhere">${esc(s.where)}</span>
            <p>${esc(s.detail)}</p>
          </li>`).join("")}
      </ol>
    </section>`;
}

/* One card per screen. `makes` is the answer to "what can it make" and `cant`
 * is the reason anyone believes the rest of the card. */
function screens(c) {
  const card = (t) => {
    /* The DAW owns its own page; everything else is a view in this document.
     * Two elements rather than one with a branch inside, because a link that
     * is sometimes not a link is how you get a card nobody can open. */
    const open = t.id === "daw"
      ? `<a class="wcopen" href="daw.html">Open ${esc(t.name)} &rsaquo;</a>`
      : `<a class="wcopen" href="#" data-go="${esc(t.id)}">Open ${esc(t.name)} &rsaquo;</a>`;
    return `
      <article class="wccard">
        <header><i>${esc(t.icon)}</i><b>${esc(t.name)}</b></header>
        <p>${esc(t.lead)}</p>
        <ul class="wcmakes">${t.makes.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
        <p class="wccant"><b>Can't:</b> ${esc(t.cant)}</p>
        <p class="wcfirst"><b>First move:</b> ${esc(t.start)}</p>
        ${open}
      </article>`;
  };
  return `
    <section class="wcsec" id="wcScreens">
      <h3>Every screen, and what it honestly cannot do</h3>
      ${c.groups.map((g) => `
        <div class="wcgroup">
          <h4>${esc(g.name)} <span>${esc(g.note)}</span></h4>
          <div class="wcgrid">${c.tabs.filter((t) => t.group === g.id).map(card).join("")}</div>
        </div>`).join("")}
    </section>`;
}

/* The size question, which is the one that costs people a night. */
function quality(c) {
  const v = c.video;
  return `
    <section class="wcsec" id="wcQuality">
      <h3>What size, and why it is decided before the render</h3>
      <div class="wcfacts">
        ${v.quality.map((q) => `
          <div class="wcfact">
            <b>${esc(q.headline)}</b>
            <p>${esc(q.body)}</p>
            <span class="wcsrc">${esc(q.source)}</span>
          </div>`).join("")}
      </div>
      <div class="wcengines">
        ${v.engines.map((e) => `
          <div class="wceng${e.id === v.current ? " on" : ""}">
            <b>${esc(e.label)}</b>
            <span class="wcnative">native ${esc(e.native)}</span>
            <span class="wcnative">${esc(e.stepsNote)}</span>
            <ul>${e.sizes.map((s) => `<li>${esc(s.label)}</li>`).join("")}</ul>
          </div>`).join("")}
      </div>
    </section>`;
}

/* Licences. Quoted and linked, never paraphrased — the app's standing posture,
 * and the reason this section reads longer than a welcome screen usually would.
 * Meeting these on day one is cheaper than meeting them at export. */
function licences(c) {
  const L = c.licences;
  return `
    <section class="wcsec" id="wcRights">
      <h3>What you make is yours &mdash; and the two licences that qualify that</h3>
      <p>${esc(L.lead)}</p>
      ${L.notable.map((n) => `
        <div class="wcrights">
          <header><b>${esc(n.label)}</b><span>${esc(n.licence || "")}</span></header>
          ${n.region ? `<p class="wcterritory"><b>Territory:</b> ${esc(n.region.text)}</p>` : ""}
          ${n.quote ? `<blockquote>&ldquo;${esc(n.quote)}&rdquo;<cite>${esc(n.clause || "")}</cite></blockquote>` : ""}
          ${n.conditions.length ? `<ul class="wccond">${n.conditions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
          ${n.gated ? `<p class="wcgated"><b>Gated:</b> ${esc(n.gated.how)}</p>` : ""}
          ${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">Read the licence itself &rsaquo;</a>` : ""}
        </div>`).join("")}
      <p class="wcnote">${esc(L.nonCommercial)}</p>
      <p class="wcnote">${esc(L.neverBlocks)}</p>
      ${L.unrestrictedLine ? `<p class="wchint">${esc(L.unrestrictedLine)}</p>` : ""}
    </section>`;
}

/* ── the showcase ───────────────────────────────────────────────────────── */
/**
 * Real files or an honest absence — never a placeholder. The empty line the
 * server sends is printed verbatim, including the DAW's "COMING", because a
 * studio that has not bounced an arrangement yet should say that rather than
 * borrow a song from the music engine.
 */
function showcaseItem(it) {
  if (it.kind === "image") {
    return `
      <figure class="wcshot">
        <img src="${esc(it.url)}" alt="" loading="lazy">
        <figcaption>
          <p class="wcprompt">${esc(it.prompt)}</p>
          <span class="wcmeta">${esc([it.engine, it.checkpoint].filter(Boolean).join(" · "))}</span>
        </figcaption>
      </figure>`;
  }
  if (it.kind === "clip") {
    return `
      <figure class="wcshot">
        <video src="${esc(it.url)}" poster="${esc(it.poster)}" controls preload="none" playsinline></video>
        <figcaption>
          <p class="wcprompt">${esc(it.prompt)}</p>
          <span class="wcmeta">${esc([it.engine, it.size, it.seconds ? `${it.seconds}s` : null,
            it.steps ? `${it.steps} steps` : null].filter(Boolean).join(" · "))}</span>
        </figcaption>
      </figure>`;
  }
  if (it.kind === "song") {
    return `
      <figure class="wcshot wcsong">
        ${it.cover ? `<img src="${esc(it.cover)}" alt="" loading="lazy">` : ""}
        <figcaption>
          <b>${esc(it.title)}</b>
          <audio src="${esc(it.url)}" controls preload="none"></audio>
          <p class="wcprompt">${esc(it.caption)}</p>
        </figcaption>
      </figure>`;
  }
  // a bounce
  return `
    <figure class="wcshot wcsong">
      <figcaption>
        <b>${esc(it.title)}</b>
        <audio src="${esc(it.url)}" controls preload="none"></audio>
        <span class="wcmeta">${esc([it.bpm ? `${it.bpm} BPM` : null, it.meter,
          it.bars ? `${it.bars} bars` : null,
          it.trackCount ? `${it.trackCount} track${it.trackCount === 1 ? "" : "s"}` : null,
        ].filter(Boolean).join(" · "))}</span>
        ${it.tracks?.length ? `<p class="wcprompt">${esc(it.tracks.join(", "))}</p>` : ""}
      </figcaption>
    </figure>`;
}

function showcaseHtml(sc) {
  if (!sc) return "";
  return `
    <p class="wchint">${esc(sc.source)}</p>
    ${sc.panels.map((p) => `
      <div class="wcpanel">
        <h4>${esc(p.title)} <span>${p.count || "none yet"}</span></h4>
        ${p.items.length
          ? `<div class="wcshots">${p.items.map(showcaseItem).join("")}</div>`
          : `<p class="wcempty">${esc(p.empty)}</p>`}
      </div>`).join("")}`;
}

function showcase(c) {
  return `
    <section class="wcsec" id="wcShowcase">
      <h3>What this machine has already made
        <button type="button" class="wcrefresh" id="wcRefresh">Refresh</button></h3>
      <div id="wcShowcaseBody">${showcaseHtml(c.showcase)}</div>
    </section>`;
}

/* ── the window ─────────────────────────────────────────────────────────── */

const SECTIONS = [
  ["wcWhat", "What this is"],
  ["wcStart", "Where to start"],
  ["wcScreens", "The screens"],
  ["wcQuality", "Size and quality"],
  ["wcRights", "Licences"],
  ["wcShowcase", "Made here"],
];

function render(c) {
  const el = document.createElement("div");
  el.className = "overlay wcoverlay";
  el.id = "welcomeOverlay";
  el.innerHTML = `
    <div class="wcsheet" role="dialog" aria-modal="true" aria-label="Welcome to AIPLAY Studio">
      <header class="wchead">
        <div class="wctitle"><b>Welcome to ${esc(c.identity.name)}</b>
          <span>what is what, and what you can make with it</span></div>
        <button type="button" class="wcclose" id="wcClose" title="Close">&times;</button>
      </header>
      <nav class="wcindex">
        ${SECTIONS.map(([id, label]) => `<a href="#" data-sec="${id}">${esc(label)}</a>`).join("")}
      </nav>
      <div class="wcbody" id="wcBody">
        ${whatThisIs(c)}
        ${whereToStart(c)}
        ${screens(c)}
        ${quality(c)}
        ${licences(c)}
        ${showcase(c)}
      </div>
      <footer class="wcfoot">
        <button type="button" class="wcbtn" id="wcAgain">Show the Home notes again</button>
        <span class="wcspacer"></span>
        <a class="wcbtn" href="#" data-go="about">The long version, on About &rsaquo;</a>
        <button type="button" class="wcbtn on" id="wcGo">Start making something</button>
      </footer>
    </div>`;
  return el;
}

function wire(el) {
  const close = () => closeWelcome();
  el.querySelector("#wcClose").onclick = close;
  el.querySelector("#wcGo").onclick = close;
  /* Clicking the backdrop closes; clicking inside the sheet must not. */
  el.onclick = (e) => { if (e.target === el) close(); };

  /* Any in-window link that navigates the app also closes the window — a tour
   * that stays open over the screen it just sent you to is a tour you have to
   * dismiss twice. app.js's delegated [data-go] handler does the navigating;
   * this only gets out of its way. */
  for (const a of el.querySelectorAll("[data-go], .wcopen")) {
    a.addEventListener("click", () => setTimeout(close, 0));
  }

  for (const a of el.querySelectorAll(".wcindex a")) {
    a.onclick = (e) => {
      e.preventDefault();
      el.querySelector(`#${a.dataset.sec}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }

  /* "Show this again next launch" — the human half of the `reopen` action an
   * agent reaches through studio_welcome. The label flips to say what happened
   * rather than silently succeeding. */
  const again = el.querySelector("#wcAgain");
  again.onclick = async () => {
    again.disabled = true;
    try {
      const r = await post({ action: "reopen" });
      again.textContent = r.ok ? "Back on Home next launch" : "Could not save that";
    } catch { again.textContent = "Could not save that"; }
  };

  const refresh = el.querySelector("#wcRefresh");
  refresh.onclick = async () => {
    refresh.disabled = true;
    refresh.textContent = "Reading…";
    try {
      const r = await post({ action: "showcase" });
      if (r.showcase) {
        state.cat.showcase = r.showcase;
        el.querySelector("#wcShowcaseBody").innerHTML = showcaseHtml(r.showcase);
      }
    } catch { /* leave what is on screen */ }
    refresh.disabled = false;
    refresh.textContent = "Refresh";
  };
}

function onKey(e) { if (e.key === "Escape") closeWelcome(); }

/** Open it. `auto` distinguishes the first-run open from a person asking. */
export function openWelcome({ auto = false } = {}) {
  if (state.open || !state.cat) return;
  const el = render(state.cat);
  document.body.appendChild(el);
  wire(el);
  state.el = el;
  state.open = true;
  document.addEventListener("keydown", onKey);
  /* Seen it — written on OPEN, see the file header. Fire and forget: a settings
   * write that fails must not stop somebody reading the page. */
  if (auto) post({ action: "dismiss" }).catch(() => {});
}

export function closeWelcome() {
  if (!state.open) return;
  document.removeEventListener("keydown", onKey);
  state.el?.remove();
  state.el = null;
  state.open = false;
}

/**
 * Boot. One request: it answers both "what is the catalogue" and "has this
 * person seen it", so a fresh install opens the window on the same round trip
 * that fills it.
 *
 * Silent on failure by design — an older server with no /api/welcome, or a
 * corrupt settings file, must cost a new user a welcome screen and nothing
 * else. The About button is wired regardless, so the tour stays reachable even
 * if the automatic open never happens.
 */
export async function initWelcome({autoOpen=true}={}) {
  const btn = document.getElementById("welcomeOpen");
  if (btn) btn.onclick = (e) => { e.preventDefault(); openWelcome(); };

  let r = null;
  try { r = await post({ action: "catalogue" }); } catch { return; }
  if (!r?.catalogue) return;
  state.cat = r.catalogue;
  /* `autoOpen` now means "show the first-run lines": false in the launcher's
   * Music-only and Comfy API modes and when a link opened another screen. */
  if (autoOpen && r.firstRun) paintFirstRun();
}

/* ── the first-run lines on Home ────────────────────────────────────────── */
/* The lines, the links (label and view, both from the server) and a Hide.
 * Silent on failure, like the rest of this file: no lines is a quiet Home. */
export async function paintFirstRun() {
  const box = document.getElementById("homeStrip");
  if (!box) return;
  let r = null;
  try { r = await post({ action: "first_run" }); } catch { return; }
  if (!r?.lines?.length || !r.firstRun) { box.hidden = true; return; }
  const lines = document.getElementById("homeStripLines");
  if (lines) lines.innerHTML = r.lines.map((l) => `<span>${esc(l)}</span>`).join("");
  const links = document.getElementById("homeStripLinks");
  if (links) links.innerHTML = (r.links || []).map((k) => `<a href="#" data-go="${esc(k.view)}">${esc(k.label)}</a>`).join("");
  const hide = document.getElementById("homeStripHide");
  if (hide) hide.onclick = () => { box.hidden = true; post({ action: "dismiss" }).catch(() => {}); };
  box.hidden = false;
}
