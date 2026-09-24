/**
 * THE ⓘ IN THE CORNER OF EVERY SCREEN.
 *
 * The owner: "for each component we need to show a little Info part which
 * explains the page and shows what you need for models or other dependencies."
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THIS FILE WRITES NO COPY. Not the paragraph, not the limit, not the badge
 * words, not the sentence a page with no dependencies shows. Every one of them
 * comes from /api/welcome's `screen_info`, which is server/welcome/catalogue.js
 * joined against /api/models — the same document `studio_screen_info` hands an
 * agent and the same fit the Models screen renders. The strings below are
 * labels for controls and nothing else, and server/welcome/ui_test.js is what
 * keeps it that way.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * WHY IT IS ONE FILE AND NOT FIFTEEN. Every screen in this app is a section of
 * one document, and a "little Info part" written per screen would be fifteen
 * copies of the same control, fifteen chances to describe a page in the page
 * rather than in the catalogue, and fifteen places to forget when a sixteenth
 * screen arrives. So `mountInfo` is called once per view from web/app.js, and
 * the census in server/welcome/ui_test.js fails the commit if a view in the
 * rail is not among the mounts.
 *
 * IT BORROWS ITS BADGES. `.fitbadge.fit-<tone>` is web/modelfit.css's, already
 * on the page, already dressed, already the four tones server/fit.js sends.
 * The Models screen and this panel therefore cannot colour the same verdict
 * differently — the alternative was a second badge and a second palette, which
 * is how a screen ends up telling somebody not to bother with a model the
 * agent beside them is recommending.
 *
 * TWO BADGES PER ROW, NEVER ONE. "On disk" and "fits your machine" are
 * different questions with different answers, and a model can be downloaded
 * and far too big for the card. Collapsing them is how somebody spends an
 * evening on a fetch that was never going to run.
 *
 * OPEN OR CLOSED IS REMEMBERED PER VIEW, in this browser, and that is the one
 * piece of state here that is allowed to be local: it is a preference about
 * furniture, invisible to the work, and nothing an agent could want to read.
 * The welcome window's seen-flag is the opposite case and lives on the server —
 * server/welcome/routes.js says why at length. Remembering is only safe because
 * the panel is BOUNDED: an unbounded one that pushed the form off the screen
 * remembered that too, on every visit. mountInfo has the measurement.
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

/* Sizes spelled the way the Models screen spells them, character for character
 * — web/modelfit.js line 50 and web/app.js line 2874 are this same expression.
 * It was written here as plain GB first, which rendered RIFE's 22 MB checkpoint
 * as "0.0 GB" beside the Models screen calling it "23 MB". One file, two
 * numbers, and the panel's whole claim is that it is showing you what that
 * screen shows you. */
const gb = (n) => (!n ? "" : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);

/* What counts as a screen's own header, most specific first. Every screen in
 * this app already leads with one of these; the list is here rather than inline
 * so it stays one line per shape and reads as the vocabulary it is. */
const HEADERS = [".stagehead", ".wfhead", ".commhero", "h1", "h2"];

/* ── remembered, per view ────────────────────────────────────────────────── */
const KEY = (view) => `aiplayInfo:${view}`;
const remembered = (view) => {
  try { return localStorage.getItem(KEY(view)) === "1"; } catch { return false; }
};
const remember = (view, open) => {
  try {
    if (open) localStorage.setItem(KEY(view), "1");
    else localStorage.removeItem(KEY(view));
  } catch { /* private window, blocked storage — the panel still works */ }
};

/* ── the badges, from the server's own vocabularies ──────────────────────── */

/**
 * One chip. `states` is whichever table this verdict came from — NEED_STATES
 * for "is it here", FIT_STATES for "will it run" — and both arrive in the
 * payload rather than being known to this file, which is the only reason a
 * fifth state added on the server arrives here already knowing how to look.
 */
function chip(state, states, why) {
  const s = states?.[state];
  if (!s) return "";
  return `<span class="fitbadge fit-${esc(s.tone)}" title="${esc(why || s.line)}"
    ><b>${esc(s.chip)}</b></span>`;
}

/** One thing this screen needs. */
function needRow(n, info) {
  /* THE WHOLE SIZE OR WHAT IS LEFT OF IT, and which one is the state's call,
   * not this file's. A row whose files are all here shows what it cost; a row
   * with a download outstanding shows what that download is. Written here as
   * `state === "ready"` it got the new "files here, package missing" state
   * wrong the day that state existed — every file on disk, remainder zero, and
   * a row that showed no size at all. */
  const state = info.needStates?.[n.state] || null;
  const size = n.kind === "package"
    ? ""
    : (state?.nothingToFetch ? gb(n.totalBytes) : gb(n.missingBytes));
  return `
    <li class="inforow">
      <div class="inforowhead">
        <b>${esc(n.label)}</b>
        ${/* The Models screen's words for the same flags (web/app.js requiredBadge). */
          n.required ? '<span class="infoneed">required</span>'
          : n.requiredGroup === "music" ? '<span class="infoneed">one music engine required</span>' : ""}
        ${chip(n.state, info.needStates)}
        ${chip(n.fit?.state, info.fitStates, n.fit?.why)}
        ${size ? `<span class="fitsize">${esc(size)}</span>` : ""}
      </div>
      ${n.for ? `<p class="fitwhy">${esc(n.for)}</p>` : ""}
      ${/* The verdict's full sentence, inline, wherever the STATE says it must
           be — `inline` on the server's own table, never a list of state names
           here. It was a list of three, and `via-package` was not on it: the one
           state whose chip reads "Ready" while meaning "its package will fetch
           the weights on first run" had a sentence in the vocabulary that
           nothing in this app could ever render. A page that keeps its own copy
           of which states matter goes stale the moment a sixth is added, and
           silently — exactly the way that one did. Every other state's sentence
           is on the chip's own title, where the Models screen puts it too. */
        state?.inline ? `<p class="fitwhy">${esc(state.line || "")}</p>` : ""}
      ${n.install ? `<pre class="fitcmd">${esc(n.install)}</pre>` : ""}
      ${/* Which python answered. A package row that says "Not installed" with no
           interpreter beside it is certain about nothing: the probe writes a hard
           false when the spawn itself fails, and two rows on one panel can be
           answered by two different pythons (whisper has its own venv). The Models
           screen prints the path; this panel must not disagree with it by omission. */
        n.kind === "package" && n.interpreterLine
          ? `<p class="fitwhy">${esc(n.interpreterLine || "")}</p>` : ""}
      ${n.region?.excluded?.length
        ? `<p class="fitregion">⚠ ${n.region.excluded.map(esc).join(" · ")}</p>` : ""}
      ${/* The hand-fetch steps, and ONLY while there is something to fetch. A
           gated repository stays gated after you have fetched it, so this line
           rendered unconditionally told somebody holding 39.7 GB of LTX how to
           go and get LTX. `nothingToFetch` is that condition, on the server's
           table, rather than the two state names it used to be — the list would
           have needed a third name the day a third state meant "the files are
           here", which is exactly what happened. The territory warning above it
           is the opposite case and is always shown: it is a fact about the
           licence, not about the download. */
        n.gated?.how && !state?.nothingToFetch
          ? `<p class="fitwhy">${esc(n.gated.how)}</p>` : ""}
      ${n.licence ? `<p class="infolic">${esc(n.licence)}</p>` : ""}
    </li>`;
}

/**
 * The panel.
 *
 * ⚠ `info.open` — the screen's own "Open X" target — is deliberately NOT
 * rendered. The panel is mounted INSIDE the screen it describes, so a link
 * offering to open where you already are is furniture. It is in the payload
 * because `studio_screen_info` is the other reader, and an agent that has just
 * been told what a screen does needs to be told how to get to it.
 */
/* The screen's "How it runs" lines (catalogue.js howItRuns), folded: the engine
 * internals that used to sit under the Make button (UI_PLAN C2). */
function howItRuns(lines) {
  return `<details class="infohow"><summary>How it runs</summary><ul>`
    + lines.map((l) => `<li>${esc(l)}</li>`).join("") + "</ul></details>";
}

function render(info) {
  return `
    <div class="infohead">
      <i>${esc(info.icon)}</i><b>${esc(info.name)}</b>
      <button type="button" class="infoclose" title="Close">×</button>
    </div>
    <p class="infolead">${esc(info.lead)}</p>
    ${info.makes?.length
      ? `<ul class="infomakes">${info.makes.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
    ${info.howItRuns?.length ? howItRuns(info.howItRuns) : ""}
    <p class="infocant"><b>Can't:</b> ${esc(info.cant)}</p>
    <p class="infofirst"><b>First move:</b> ${esc(info.first)}</p>

    <div class="infoneeds">
      <h4>What it needs</h4>
      ${info.needsNothing
        ? `<p class="infonone">${esc(info.needsLine)}</p>`
        : `${info.needs?.length
              ? `<ul class="inforows">${info.needs.map((n) => needRow(n, info)).join("")}</ul>` : ""}
           ${info.needsNote ? `<p class="fitwhy infonote">${esc(info.needsNote)}</p>` : ""}`}
      ${/* The sentence comes with the failure, from the server's vocabulary. It
           was looked up here by state name, which is the last place this file
           knew one — and knowing one is how the two lists above went stale. */
        info.machineUnavailable
          ? `<p class="fitwhy">${esc(info.machineUnavailableLine || "")}</p>` : ""}
      ${info.needs?.length
        ? `<p class="infofoot"><a href="#" data-go="${esc(info.modelsView)}">Open the Models screen &rsaquo;</a>
             ${info.machine?.gpu
               ? `<span class="fitmachine" title="${esc(info.machine.readingNote || "")}"
                    >${esc(info.machine.gpu.name)} &middot; ${esc(info.machine.gpu.vramExactGb)} GB</span>`
               : ""}</p>`
        : ""}
    </div>`;
}

/* ── one mount, called once per view by web/app.js ───────────────────────── */

/**
 * Put an ⓘ in one screen's header and hang its panel under it.
 *
 * `host` is the screen's container. The header inside it is FOUND rather than
 * named: every screen in this app already leads with a `.stagehead`, a
 * `.wfhead`, a `.commhero` or an `<h1>`, and looking for one of those is what
 * makes this work without editing fifteen blocks of markup. Only DIRECT
 * children count — a screen whose heading is buried two divs down (Images) gets
 * the control at the top of the container instead, which is still the right
 * place and is why there is no branch that gives up.
 *
 * IT IS IDEMPOTENT AND MEANT TO BE CALLED AGAIN. The guard is the panel's own
 * presence in the DOM rather than a flag, so a screen that rebuilds its
 * container from scratch — the compositor does exactly that, `root.innerHTML =`
 * on first open — gets its ⓘ back the next time app.js runs the mounts. A flag
 * would have left VFX as the one screen in the app with no info button, and it
 * would have looked like a bug in this file rather than in the guard.
 *
 * @param {string} view      the data-view id, which is also the catalogue's screen id
 * @param {string} selector  CSS for that screen's container in web/index.html
 */
export function mountInfo(view, selector) {
  const host = document.querySelector(selector);
  if (!host || host.querySelector(":scope > .infopanel")) return null;

  /* ⚠ ONE LEVEL DOWN COUNTS. The library headings are wrapped in `.libhead`
   * so they can be sticky (sticky siblings do not stack, so the four controls
   * had to become one element), and `:scope >` does not follow that. Measured
   * without this: Images and Video both fell into the `infoloose` branch below,
   * with the ⓘ floating above the page instead of sitting in the title — and
   * nothing failed, because "no header" is a case this function handles. */
  const header = host.querySelector(
    HEADERS.flatMap((h) => [`:scope > ${h}`, `:scope > .libhead > ${h}`]).join(", "));
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "infobtn";
  btn.dataset.infoFor = view;
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", `info-${view}`);
  btn.title = "What this page is, and what it needs";
  btn.textContent = view === "create" ? "About" : "ⓘ";

  const panel = document.createElement("section");
  panel.className = "infopanel";
  panel.id = `info-${view}`;
  panel.hidden = true;

  /* The button goes in the header where there is one, so it reads as part of
   * the title rather than as a floating widget; the panel goes directly after
   * whatever the button landed in and opens DOWNWARD from there, at the bounded
   * height web/info.css gives it.
   *
   * THE BOUND IS THE WHOLE OF IT, and it is measured rather than picked. This
   * panel is prose about a screen and can run to any length. Measured at
   * 1440x900: Music renders 1492 px of it into a column 846 px tall that
   * scrolls its own content, so unbounded it pushed that screen's first control
   * — the Song/Instrumental switch — from y=64 to y=1556, about 700 px below
   * the bottom of the column it lives in. Images put its prompt box at 1064,
   * Video its search field at 929, Workflow its project picker at 1288: all off
   * a 900 px screen. And because open/closed is remembered, that was not a
   * moment's surprise but how those screens looked on every later visit.
   *
   * Bounded, the same five land at 460, 504, 421, 471 and 455 — still on
   * screen, with the panel scrolling its own overflow. An overlay was the other
   * way to keep them there and is not needed: nothing here is positioned
   * absolutely, and covering the controls a panel is explaining is a worse
   * bargain than borrowing two fifths of the height and giving it back on
   * close. */
  if (header) {
    header.appendChild(btn);
    /* ⚠ THE PANEL GOES AFTER THE BLOCK, THE BUTTON INSIDE THE HEADING. Where
     * the heading sits in `.libhead`, "after the heading" is INSIDE the sticky
     * wrapper — which would pin up to 1492px of prose to the top of the window
     * and never let it scroll away. Going after the wrapper also keeps the
     * panel a direct child of the host, which is what the `:scope > .infopanel`
     * guard at the top of this function tests for. parentElement, not closest():
     * the only case is one level, and closest() would walk past the host. */
    const block = header.parentElement?.classList.contains("libhead") ? header.parentElement : header;
    block.after(panel);
  } else {
    /* No header to sit in, so it sits above everything — and says so in a class
     * rather than being detected in CSS, because "the button whose parent is
     * not a header" is a rule that would have to be rewritten every time a new
     * header shape is added to HEADERS. */
    btn.classList.add("infoloose");
    host.prepend(panel);
    host.prepend(btn);
  }

  let loaded = false;
  const setOpen = async (open) => {
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.classList.toggle("on", open);
    remember(view, open);
    if (!open || loaded) return;
    loaded = true;
    /* One request. Its failure is swallowed into the panel rather than thrown:
     * an older server with no `screen_info` costs a reader this panel and
     * nothing else on the page. */
    try {
      const r = await post({ action: "screen_info", view });
      if (r?.error) throw new Error(r.error);
      panel.innerHTML = render(r);
      panel.querySelector(".infoclose")?.addEventListener("click", () => setOpen(false));
    } catch (err) {
      loaded = false;
      panel.innerHTML = `<p class="fitwhy">${esc(err?.message || String(err))}</p>`;
    }
  };

  btn.addEventListener("click", () => setOpen(panel.hidden));
  if (remembered(view)) setOpen(true);
  return btn;
}
