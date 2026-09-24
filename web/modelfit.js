/**
 * "FOR THIS MACHINE" — the Models screen's missing sentence.
 *
 * THE DEFECT THIS CLOSES, in the owner's words: the Models screen "lists
 * everything and recommends nothing". Seventeen rows, one of them 43 GB, each
 * one honestly stating a VRAM and a RAM requirement, and nothing anywhere
 * dividing one by the other. A newcomer arriving at that screen has to know
 * their own card's memory, find it in seventeen small grey requirement lines,
 * compare four numbers per row and then rank what is left by licence. Nemyra
 * did not do that. She handed the whole job to an agent, which is the report
 * that started this work.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE COMPUTES NOTHING AND JUDGES NOTHING.
 *
 * Every verdict, every reason sentence, every chip word and every byte total
 * is read from /api/models, where server/fit.js produced it. That is not
 * tidiness — it is the only way the screen and `models_for_this_machine` can
 * be guaranteed to say the same thing about the same card. The moment this
 * file contains its own idea of what "8 GB" means, a person and their
 * assistant are reading two different answers off one machine, and the
 * assistant's is the one with no way to notice.
 *
 * server/modelfit_test.js enforces it: no threshold literal, no chip word, no
 * reason sentence may appear in this file's source.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * WHY IT IS A SEPARATE MODULE FROM web/app.js. Two reasons, and only one of
 * them is about the other strand editing app.js this week. The lasting one is
 * that app.js's loadModels() renders the CATALOGUE — seventeen rows of what
 * exists. This renders a JUDGEMENT about the person reading it. They change
 * for different reasons: a new capability changes the first, a new fit state
 * or a new licence class changes the second. Keeping the judgement in a file
 * of its own is what let it be written without touching the row renderer at
 * all, and what lets the parity gate read it as one document.
 *
 * IT ADDS NO ACTION. Every button in the block scrolls to a row that already
 * exists and highlights it; downloading stays the row's own button, which is
 * the one that carries the territory acknowledgement. So there is no new
 * action for an agent to be missing, and the parity gate checks the thing that
 * IS at risk here instead: that every field this page renders is a field
 * models_for_this_machine also returns.
 */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* Base 1000, matching web/app.js's own `gb` and Windows Explorer, because the
 * two numbers sit inches apart on this screen and a reader comparing "43 GB to
 * download" against "39.9 GB free" must not be comparing two different GBs. */
const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);

/**
 * The numeric tail on a badge.
 *
 * The chip word comes from the server (`fitStates[state].chip`). What the
 * server cannot hand over as a fixed string is the pair of numbers that makes
 * the verdict checkable — "needs 16, you have 8" — because those differ per
 * row and per machine. So the words are the server's and the arithmetic is
 * already the server's too: this only chooses WHICH of the numbers already in
 * `fit` to put in front of someone, and never derives a new one.
 *
 * Each state shows the comparison that decided it, not a generic pair:
 *   wont-run  the floor it missed and the machine's figure — the actionable one.
 *   streams   the recommendation it is under, since the minimum is already met.
 *   fits      the machine's own two numbers, so "fits" is a claim with evidence.
 *   unknown   the card figure is absent by definition; say the RAM that is not.
 */
function tail(fit) {
  if (!fit) return "";
  /* The server's own tail, where the generic pairs below would mislead: H3's
   * answer on a smaller card is a SIZE, not a recommendation it is under. */
  if (fit.short) return fit.short;
  if (fit.needVramGb == null) return fit.why || "";
  const you = fit.yourVramGb;
  const ram = fit.yourRamGb;
  if (fit.state === "wont-run") {
    /* Which limit failed decides which pair is quoted. A machine with a big
     * card and too little RAM told "needs 16 GB, you have 16" reads as a bug. */
    if (you !== null && you < fit.needVramGb) return `needs ${fit.needVramGb} GB of VRAM, you have ${you}`;
    return `needs ${fit.needRamGb} GB of RAM, you have ${ram}`;
  }
  if (fit.state === "streams") {
    const bits = [];
    if (you !== null && you < fit.recVramGb) bits.push(`${you} GB card where ${fit.recVramGb} is recommended`);
    if (ram < fit.recRamGb) bits.push(`${ram} GB RAM where ${fit.recRamGb} is recommended`);
    return bits.join(", ");
  }
  if (fit.state === "fits") {
    return you !== null
      ? `${you} GB card, ${ram} GB RAM · asks for ${fit.needVramGb}/${fit.needRamGb}`
      : `${ram} GB RAM · asks for ${fit.needRamGb}`;
  }
  return `no card reading · asks for ${fit.needVramGb} GB of VRAM`;
}

/**
 * The badge, stamped onto a row.
 *
 * `title` carries the server's full reason so the short chip is never the only
 * thing available — hovering a row that says "Below the minimum" gives the
 * paragraph explaining exactly which of the two limits it missed and why RAM
 * is not the softer one.
 */
function badge(fit, states) {
  if (!fit) return "";
  const s = states?.[fit.state];
  if (!s) return "";
  const t = tail(fit);
  /* The tone is the server's too — five states map to four colours there, and
   * a sixth state added in fit.js arrives here already knowing how to look. */
  return `<span class="fitbadge fit-${esc(s.tone)}" title="${esc(fit.why || s.line)}"
    ><b>${esc(s.chip)}</b>${t ? `<span>${esc(t)}</span>` : ""}</span>`;
}

/**
 * The verdict's warning, in full, under a row's badge: H3's "only measured
 * with 32 GB of RAM" and "no AMD render tested yet". Too long for a chip and
 * too important for a hover, so it is a line of its own. The server's words.
 */
function warnLine(fit) {
  return fit?.warning ? `<span class="fitwarn">⚠ ${esc(fit.warning)}</span>` : "";
}

/** One pick in the block at the top. */
function pickRow(p, states) {
  const s = states?.[p.fit?.state];
  return `
    <div class="fitpick">
      <div class="fitpickhead">
        <span class="fitslot">${esc(p.slotLabel || p.slot)}</span>
        <b>${esc(p.label)}</b>
        ${badge(p.fit, states)}
        <span class="fitsize">${p.ready ? "already on disk" : gb(p.bytes)}</span>
      </div>
      <p class="fitwhy">${esc(p.why)}</p>
      ${/* THE TERRITORY, AS A LIST AND NOT AS A SENTENCE.
           The pick's `why` already ends with the server's own warning about
           this — "Licensed only outside …, the download asks you to confirm".
           Writing a second sentence here would be exactly the drift this file
           forbids elsewhere: two territory warnings that a later edit can make
           disagree. So the names are repeated (they are the fact a reader scans
           for) and the explanation is not. */
        p.region ? `<p class="fitregion">⚠ ${p.region.excluded.map(esc).join(" · ")}</p>` : ""}
      ${p.ready ? "" : `<button type="button" class="btn sm ghost" data-fitgoto="${esc(p.id)}">Show me this row</button>`}
    </div>`;
}

/* WHAT TO DO INSTEAD, as buttons: a note may carry `instead` (fit.js: the
 * "No video engine" note names asking a friend first and a paid service on the
 * person's own key second). The order and the words are the server's; a way
 * whose screen this launch mode hides (Collab in Music only) gets no button,
 * and the sentence above it still says it. */
function insteadRow(n, root) {
  const reachable = (view) => {
    const a = typeof root.querySelector === "function" ? root.querySelector(`.nav a[data-view="${view}"]`) : null;
    return !!a && !a.hidden && a.style?.display !== "none";
  };
  const ways = (n.instead || []).filter((w) => w?.view && reachable(w.view));
  if (!ways.length) return "";
  return `<p class="fitinstead">${ways.map((w, i) => `<button type="button" class="btn sm${w.paid ? " ghost" : ""}"
    data-fitview="${esc(w.view)}">${i + 1}. ${esc(w.title)}${w.paid ? " (paid)" : ""}</button>`).join(" ")}</p>`;
}

/**
 * Render the block and stamp the rows.
 *
 * Called by web/app.js immediately after it writes #modelList, with the same
 * payload it just fetched — so there is no second request, and the block and
 * the rows are guaranteed to be describing one reading of the card rather than
 * two taken seconds apart.
 */
export function paintFit(d, root = document) {
  const list = root.getElementById("modelList");
  if (!list) return;

  /* Created on first paint, reused after. Sitting immediately before the list
   * rather than inside it so the list stays exactly what app.js writes. */
  let box = root.getElementById("modelFit");
  if (!box) {
    /* A disclosure, closed by default: the headline in its summary is the
     * answer, and the picks and notes under it are the working. */
    box = root.createElement("details");
    box.id = "modelFit";
    box.className = "fitbox";
    list.parentNode.insertBefore(box, list);
  }

  const rec = d?.recommended;
  const states = d?.fitStates;
  /* An older server, or one where the fit could not be computed, gets an empty
   * block rather than a broken one — the catalogue below is still perfectly
   * usable, which is what it was before this feature existed. */
  if (!rec || !states) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;

  const m = rec.machine || d.machine || {};
  const disk = d.disk ? gb(d.disk.freeBytes) : null;

  /* The download line: LABELS AND NUMBERS, not sentences.
   *
   * The headline above already states in words whether there is anything to
   * fetch — fit.js writes "… — 43 GB to download" or "… — all of it already on
   * disk" into it. This line's job is the arithmetic beside the free space, so
   * a reader can see the two figures against each other rather than take a
   * sentence's word for it. The three cases are not interchangeable: a total
   * larger than the free disk is the most useful warning on this screen,
   * because the alternative is finding out 80% of the way through. */
  const need = rec.missingBytes > 0
    ? (rec.diskFits === false
        ? `<b class="fitbad">${gb(rec.missingBytes)} to download · only ${disk} free</b>`
        : `<b>${gb(rec.missingBytes)} to download</b>${disk ? ` · ${disk} free` : ""}`)
    : `<b class="fitok">Nothing to download</b>`;

  const wasOpen = box.open === true;
  box.innerHTML = `
    <summary class="fithead">
      <h3>For this machine</h3>
      ${/* The machine's own numbers, quoted, before any advice is given. A
           recommendation whose inputs are invisible cannot be checked by the
           person it is aimed at, and this screen's whole job is to be trusted
           by somebody who has no other way to find out. */
        m.gpu
          ? `<span class="fitmachine" title="${esc(m.readingNote || "")}">${esc(m.gpu.name)} ·
              ${esc(m.gpu.vramExactGb)} GB VRAM · ${esc(m.ram?.totalExactGb)} GB RAM</span>`
          : `<span class="fitmachine fit-unknown">No NVIDIA card could be read · ${esc(m.ram?.totalExactGb)} GB RAM</span>`}
      <span class="fitline">${esc(rec.headline)}</span>
    </summary>
    ${m.gpu ? "" : `<p class="fitwhy">${esc(m.readingNote || "")}</p>`}
    ${rec.picks?.length ? `<div class="fitpicks">${rec.picks.map((p) => pickRow(p, states)).join("")}</div>` : ""}
    ${rec.picks?.length ? `<p class="fittotal">${need}
      ${rec.bytesNote ? `<span class="hint">${esc(rec.bytesNote)}</span>` : ""}</p>` : ""}
    ${/* The notes are where the honest bad news goes, and it is never hidden
         behind a click. The one that matters most: LTX 2.5 is the better video
         engine and Studio cannot fetch it, so it appears here with the
         publisher's own steps rather than as a row with a button that 401s. */
      rec.notes?.length ? `<div class="fitnotes">${rec.notes.map((n) => `
        <div class="fitnote">
          <b>${esc(n.headline)}</b>
          <p>${esc(n.detail)}</p>
          ${insteadRow(n, root)}
          ${n.url ? `<p><a href="${esc(n.url)}" target="_blank" rel="noopener">Open the model page</a></p>` : ""}
        </div>`).join("")}</div>` : ""}
    ${/* pip packages are not downloads and the screen has always half-admitted
         it. The command is the server's, filled in with the interpreter Studio
         really spawns, so it can be copied rather than adapted. */
      (rec.packages || []).some((k) => !k.packageReady)
        ? `<div class="fitnote">
            <b>Two of these are Python packages, not files — Studio cannot fetch them.</b>
            ${rec.packages.filter((k) => !k.packageReady).map((k) => `
              <p>${esc(k.label)} — ${esc(k.why)}</p>
              ${k.install ? `<pre class="fitcmd">${esc(k.install)}</pre>` : ""}`).join("")}
          </div>`
        : ""}`;
  box.open = wasOpen;

  /* ── the badges ────────────────────────────────────────────────────────
   * Stamped after the fact rather than woven into app.js's template. The rows
   * carry `data-cap`, so this is a lookup and not a guess about ordering. */
  for (const c of d.capabilities || []) {
    const card = list.querySelector(`[data-cap="${CSS.escape(c.id)}"]`);
    if (!card) continue;
    let slot = card.querySelector(".fitbadgeslot");
    if (!slot) {
      slot = root.createElement("span");
      slot.className = "fitbadgeslot";
      /* Into the head row, beside the licence, where the eye already goes. */
      (card.querySelector(".mhead") || card).appendChild(slot);
    }
    slot.innerHTML = badge(c.fit, states) + warnLine(c.fit);
  }
}

/**
 * "Show me this row" — the only interaction in the block.
 *
 * Delegated from the list's own container so it survives every repaint, and
 * deliberately NOT a download: the row's button carries the territory
 * acknowledgement and the disk check, and a second path to a download that can
 * skip either of those is how a licence gets accepted by accident.
 */
export function initFit(root = document) {
  root.addEventListener("click", (e) => {
    /* A "what to do instead" button: the rail link does the navigating, so
     * this file needs no setView of its own. */
    const go = e.target.closest?.("[data-fitview]");
    if (go) {
      root.querySelector(`.nav a[data-view="${CSS.escape(go.dataset.fitview)}"]`)?.click();
      if (go.dataset.fitview === "settings") root.getElementById("set-hosted")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const b = e.target.closest?.("[data-fitgoto]");
    if (!b) return;
    const card = root.querySelector(`[data-cap="${CSS.escape(b.dataset.fitgoto)}"]`);
    if (!card) return;
    /* The row may sit in a collapsed section of the list. */
    const section = card.closest?.("details");
    if (section) section.open = true;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    /* A flash rather than a permanent mark: the block sends you to a row and
     * then gets out of the way. */
    card.classList.remove("fitflash");
    void card.offsetWidth;
    card.classList.add("fitflash");
  });
}
