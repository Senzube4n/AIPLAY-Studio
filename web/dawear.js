/**
 * THE EAR — the panel. One self-contained module; the DAW page's only contact
 * with it is `mountEar()`.
 *
 * It builds its own DOM into document.body and loads its own stylesheet, so
 * nothing in daw.html has to make room for it and a rewrite of the arrangement
 * UI cannot break it. Everything it does goes through /api/daw/ear — the same
 * routes the MCP tools call.
 *
 * ── THE GUARDRAILS ARE THE UI, not a policy document (SPEC D1.8.3) ────────
 *  · There is NO "accept all" primary button. The primary controls on a card
 *    are its individual routes. A bulk accept exists — long overnight runs are
 *    real — but it is a small secondary control below the stack, it says out
 *    loud that it will be recorded as bulk, and the server records it as bulk.
 *  · The free-text lane is ALWAYS visible on every card. Not behind a
 *    disclosure triangle, not one click further away than the menu picks.
 *  · Skip is offered and is logged as nothing.
 *  · Auto mode is labelled as delegated everywhere it appears, and the review
 *    checkpoint that follows it is what turns a delegated decision into a real
 *    informed selection.
 *  · Deliberation time is measured from the moment a card is drawn, and is
 *    recorded as texture — the panel never scores or gates on it.
 */

const EL = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

async function post(body) {
  const r = await fetch("/api/daw/ear", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
}
async function get(p) {
  const r = await fetch(p);
  const j = await r.json().catch(() => ({ error: `non-JSON ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j;
}

const fmt = (v, unit = "", dp = 1) =>
  (v === null || v === undefined || !Number.isFinite(Number(v)))
    ? "–" : `${Number(v).toFixed(dp)}${unit}`;

/** The panel. Returns a small handle so a host page can drive it if it wants. */
export function mountEar(opts = {}) {
  if (typeof document === "undefined") return null;          // node/trace_load safety
  if (document.querySelector(".ear-panel")) return null;      // never mount twice

  const getSlug = opts.getSlug || (() => window.__daw?.slug || null);
  const onEdited = opts.onEdited || (() => {});

  if (!document.querySelector('link[data-ear-css]')) {
    const link = EL("link");
    link.rel = "stylesheet";
    link.href = "dawear.css";
    link.setAttribute("data-ear-css", "1");
    document.head.appendChild(link);
  }

  const S = {
    open: false, tab: "listen", run: null, cards: [], notes: [],
    answered: new Set(), shownAt: new Map(), busy: false,
    measure: null, score: null, status: null, review: null,
    listenStart: null, brief: "",
  };

  /* ── chrome ───────────────────────────────────────────────────────── */
  const fab = EL("button", "ear-fab");
  fab.innerHTML = '<span class="ear-dot"></span>The Ear';
  fab.title = "Listen to this mix and get question cards";
  document.body.appendChild(fab);

  const panel = EL("div", "ear-panel");
  const head = EL("div", "ear-head");
  const title = EL("h2", null, "The Ear");
  const tabs = EL("div", "ear-tabs");
  const tabBtn = (id, label) => {
    const b = EL("button", null, label);
    b.addEventListener("click", () => { S.tab = id; render(); });
    b.dataset.tab = id;
    return b;
  };
  const tListen = tabBtn("listen", "Listen");
  const tAuto = tabBtn("auto", "Auto");
  const tTaste = tabBtn("taste", "Taste");
  const tAbout = tabBtn("about", "What it hears");
  tabs.append(tListen, tAuto, tTaste, tAbout);
  const closeBtn = EL("button", "ear-spacer", "✕");
  closeBtn.title = "close";
  closeBtn.addEventListener("click", () => toggle(false));
  head.append(title, tabs, closeBtn);

  const body = EL("div", "ear-body");
  const foot = EL("div", "ear-foot", "idle");
  panel.append(head, body, foot);
  document.body.appendChild(panel);

  const say = (m, warn) => { foot.textContent = m; foot.className = `ear-foot${warn ? " ear-warn" : ""}`; };
  const busy = (on) => { S.busy = on; fab.dataset.busy = on ? "1" : "0"; };

  function toggle(on) {
    S.open = on === undefined ? !S.open : !!on;
    panel.dataset.open = S.open ? "1" : "0";
    fab.dataset.open = S.open ? "1" : "0";
    if (S.open && !S.status) loadStatus();
    if (S.open) render();
  }
  fab.addEventListener("click", () => toggle());

  async function loadStatus() {
    try { S.status = await get("/api/daw/ear/status"); }
    catch (err) { S.status = { error: err.message }; }
    render();
  }

  /* ── the listening pass ───────────────────────────────────────────── */

  async function listen() {
    const slug = getSlug();
    if (!slug) return say("open a project first", true);
    busy(true); say("rendering and measuring…");
    try {
      const r = await post({ action: "critique", slug, genre: genreSel.value });
      S.run = r.run; S.cards = r.cards; S.notes = r.notes;
      S.measure = r.measure; S.score = r.score; S.answered = new Set();
      S.shownAt = new Map(); S.review = null;
      say(`${r.cards.length} card${r.cards.length === 1 ? "" : "s"}`
        + `${r.over_cap ? ` (+${r.over_cap} held back — the stack is capped so nobody rubber-stamps)` : ""}`
        + ` · ${r.notes.length} note${r.notes.length === 1 ? "" : "s"} · ${r.ms} ms`);
    } catch (err) { say(err.message, true); }
    busy(false); render();
  }

  async function answer(card, routeId, freeText, reasoning) {
    busy(true); say("applying and re-measuring…");
    try {
      const decideMs = Date.now() - (S.shownAt.get(card.id) || Date.now());
      const r = await post({
        action: "answer", slug: getSlug(), run: S.run, card: card.id,
        choice: routeId || undefined, free_text: freeText || undefined,
        reasoning: reasoning || undefined, decide_ms: decideMs,
      });
      S.answered.add(card.id);
      card._result = r;
      const v = r.applied;
      say(v
        ? (v.reverted
          ? `REVERTED: ${v.reason}`
          : `${v.verdict} — ${v.reason}`)
        : "recorded (free direction — nothing applied automatically)");
      onEdited();
    } catch (err) { say(err.message, true); }
    busy(false); render();
  }

  async function reject(card, why) {
    busy(true);
    try {
      await post({ action: "reject", slug: getSlug(), run: S.run, card: card.id,
                   reasoning: why || undefined,
                   decide_ms: Date.now() - (S.shownAt.get(card.id) || Date.now()) });
      S.answered.add(card.id);
      card._result = { rejected: true };
      say("recorded: every route refused — a rejection is evidence of your control");
    } catch (err) { say(err.message, true); }
    busy(false); render();
  }

  async function skip(card) {
    try {
      await post({ action: "answer", slug: getSlug(), run: S.run, card: card.id, choice: "skip" });
      S.answered.add(card.id);
      card._result = { skipped: true };
      say("skipped — not written to the ledger, because declining to decide is not a decision");
    } catch (err) { say(err.message, true); }
    render();
  }

  async function bulkAccept() {
    const left = S.cards.filter((c) => !S.answered.has(c.id));
    if (!left.length) return;
    if (!window.confirm(
      `Accept the first route on ${left.length} remaining card${left.length === 1 ? "" : "s"} in one action?\n\n`
      + "This is recorded as a BULK accept — one action, not "
      + `${left.length} individual deliberations. That is what it is, and the `
      + "authorship record will say so.")) return;
    busy(true); say("bulk accepting…");
    try {
      const r = await post({ action: "bulk_accept", slug: getSlug(), run: S.run });
      for (const row of r.results) { S.answered.add(row.card); }
      say(`${r.accepted} accepted in one action, recorded as bulk`);
      onEdited();
    } catch (err) { say(err.message, true); }
    busy(false); render();
  }

  /* ── auto-progression + the review checkpoint ─────────────────────── */

  async function runAuto() {
    const slug = getSlug();
    if (!slug) return say("open a project first", true);
    const brief = briefBox.value.trim();
    if (!brief) return say("write what you are going for — it is recorded as your direction, verbatim", true);
    busy(true); say("the Ear is working through its own cards…");
    try {
      const r = await post({ action: "auto", slug, brief, genre: genreSel.value,
                             iterations: Number(iterSel.value) || 3 });
      S.run = r.run; S.brief = brief;
      const rc = await post({ action: "review_cards", slug, run: r.run });
      S.review = rc;
      S.autoResult = r;
      say(`${r.judgements.length} decision${r.judgements.length === 1 ? "" : "s"} made under your brief`
        + ` — penalty ${fmt(r.before?.penalty_db, " dB", 2)} → ${fmt(r.after?.penalty_db, " dB", 2)}.`
        + " Review them below.");
      onEdited();
    } catch (err) { say(err.message, true); }
    busy(false); S.tab = "auto"; render();
  }

  async function review(row, verdict, choice, freeText, reasoning) {
    busy(true);
    try {
      await post({ action: "review", slug: getSlug(), run: S.run, card: row.card,
                   verdict, choice: choice || undefined, free_text: freeText || undefined,
                   reasoning: reasoning || undefined,
                   decide_ms: Date.now() - (S.shownAt.get(`rev:${row.card}`) || Date.now()) });
      row.already_reviewed = true;
      say(verdict === "keep"
        ? "kept — recorded as YOUR informed selection, alternatives seen"
        : "overridden — recorded as your own decision");
      if (verdict === "override") onEdited();
    } catch (err) { say(err.message, true); }
    busy(false); render();
  }

  async function keepAll() {
    if (!window.confirm(
      "Ratify every remaining auto decision in one action?\n\n"
      + "Recorded as ONE bulk ratification, never as individual reviews.")) return;
    busy(true);
    try {
      const r = await post({ action: "review_keep_all", slug: getSlug(), run: S.run });
      for (const row of S.review.cards) if (r.cards.includes(row.card)) row.already_reviewed = true;
      say(`${r.kept} ratified in one action, recorded as bulk`);
    } catch (err) { say(err.message, true); }
    busy(false); render();
  }

  async function approve() {
    const secs = S.listenStart ? Math.round((Date.now() - S.listenStart) / 1000) : 0;
    busy(true);
    try {
      await post({ action: "approve", slug: getSlug(), run: S.run,
                   listened_seconds: secs, note: approveNote.value || undefined });
      say(`approved after ${secs}s of listening — recorded as your own act`);
    } catch (err) { say(err.message, true); }
    busy(false);
  }

  /* ── controls that live outside the re-rendered body ──────────────── */
  const genreSel = EL("select");
  for (const g of ["neutral", "pop", "edm", "hiphop", "rock", "acoustic"]) {
    const o = EL("option", null, g); o.value = g; genreSel.appendChild(o);
  }
  genreSel.title = "tilts the spectral reference curve (pink noise + a small house tilt)";
  const listenBtn = EL("button", "ear-go", "Listen to this mix");
  listenBtn.addEventListener("click", listen);
  const briefBox = EL("textarea");
  briefBox.placeholder = "What are you going for? Your words are recorded verbatim as your direction…";
  const iterSel = EL("select");
  for (const n of [1, 2, 3]) { const o = EL("option", null, `${n} iteration${n > 1 ? "s" : ""}`); o.value = n; iterSel.appendChild(o); }
  iterSel.value = "3";
  const approveNote = EL("input");
  approveNote.placeholder = "a note on the approval (optional, verbatim)";

  /* ── rendering ────────────────────────────────────────────────────── */

  function meterTiles() {
    const wrap = EL("div", "ear-meters");
    const m = S.measure?.master, st = S.measure?.stereo;
    const tile = (label, val, cls) => {
      const d = EL("div", cls); d.append(EL("b", null, val), EL("span", null, label));
      return d;
    };
    if (!m) return wrap;
    wrap.append(
      tile("integrated", fmt(m.lufs, " LUFS"), m.lufs > -12 || m.lufs < -17 ? "bad" : "good"),
      tile("true peak", fmt(m.true_peak_db, " dBTP"), m.true_peak_db > -1 ? "bad" : "good"),
      tile("crest", fmt(m.crest_db, " dB"), m.crest_db < 6 ? "bad" : "good"),
      tile("width", fmt(st?.width, "", 3), (st?.width ?? 1) < 0.02 ? "bad" : "good"),
      tile("penalty", fmt(S.score?.penalty_db, " dB", 2), (S.score?.penalty_db ?? 0) > 4 ? "bad" : "good"),
    );
    return wrap;
  }

  function cardEl(card) {
    const el = EL("div", `ear-card${S.answered.has(card.id) ? " answered" : ""}`);
    if (!S.shownAt.has(card.id)) S.shownAt.set(card.id, Date.now());
    const obs = EL("div", "ear-obs");
    obs.append(EL("span", `ear-sev ${card.severity}`, card.severity));
    obs.append(document.createTextNode(card.observation));
    el.append(obs, EL("div", "ear-where", `${card.where} · ${card.how_much}`));

    if (S.answered.has(card.id)) {
      const r = card._result;
      const v = r?.applied;
      const line = r?.skipped ? "skipped — nothing recorded"
        : r?.rejected ? "every route refused (recorded)"
          : v ? `${v.reverted ? "reverted" : v.verdict}: ${v.reason}`
            : "recorded";
      el.append(EL("div", `ear-verdict ${v?.reverted ? "reverted" : "kept"}`, line));
      return el;
    }

    /* Declared before the routes so every handler closes over the same box:
     * the human's reason applies whichever way they answer. */
    const whyBox = EL("input");
    whyBox.placeholder = "why — optional, recorded verbatim";
    whyBox.style.width = "100%";

    for (const route of card.routes) {
      const b = EL("button", "ear-route");
      b.append(document.createTextNode(route.text));
      b.append(EL("span", "ear-why", route.why || ""));
      /* The exact MCP call this route would make, shown rather than described —
       * the human can see precisely what the button does before pressing it. */
      b.append(EL("code", null, `${route.op.tool} ${JSON.stringify(route.op.args)}`));
      b.addEventListener("click", () => answer(card, route.id, null, whyBox.value.trim()));
      el.append(b);
    }

    /* The free-text lane: always here, never one tier further away. */
    const own = EL("div", "ear-own");
    own.append(EL("label", null, "…or your own direction (recorded in your words)"));
    const ta = EL("textarea");
    ta.placeholder = "your own direction…";
    own.append(ta);
    el.append(own);

    const whyLbl = EL("label", null, "why (optional, verbatim)");
    whyLbl.style.cssText = "display:block;color:var(--dim,#8b8b9a);font-size:11px;margin-top:6px";
    el.append(whyLbl, whyBox);

    const row = EL("div", "ear-row");
    const send = EL("button", null, "Take my direction");
    send.addEventListener("click", () => {
      if (!ta.value.trim()) return say("write your direction first, or pick a route", true);
      answer(card, null, ta.value.trim(), whyBox.value.trim());
    });
    const no = EL("button", null, "None of these");
    no.addEventListener("click", () => reject(card, whyBox.value.trim()));
    const sk = EL("button", null, "Skip");
    sk.title = "declining to decide — logged as nothing";
    sk.addEventListener("click", () => skip(card));
    row.append(send, no, sk);
    el.append(row);
    return el;
  }

  function renderListen() {
    const row = EL("div", "ear-row");
    row.append(listenBtn, genreSel);
    body.append(row);
    if (!S.measure) {
      body.append(EL("div", "ear-note",
        "Nothing measured yet. The Ear renders the project through the same graph "
        + "the bounce uses, measures it, and turns whatever is off target into cards."));
      return;
    }
    body.append(meterTiles());
    if (!S.cards.length) {
      body.append(EL("div", "ear-note", "Nothing is far enough off target to be worth a card."));
    }
    for (const c of S.cards) body.append(cardEl(c));

    if (S.notes.length) {
      body.append(EL("div", "ear-h", "notes — measured, but only one honest move each"));
      for (const n of S.notes) {
        const d = EL("div", "ear-note");
        d.append(document.createTextNode(`${n.observation} — ${n.how_much}`));
        d.append(EL("div", null, n.why_not_a_card));
        body.append(d);
      }
    }

    const left = S.cards.filter((c) => !S.answered.has(c.id)).length;
    if (left > 1) {
      const bulk = EL("div", "ear-bulk");
      bulk.append(document.createTextNode(
        "Long session? You can take the first route on every remaining card at once. "
        + "It is recorded as one bulk accept — not as individual deliberation. "));
      const b = EL("button", null, `Bulk-accept ${left} remaining`);
      b.addEventListener("click", bulkAccept);
      bulk.append(b);
      body.append(bulk);
    }

    const ap = EL("div", "ear-bulk");
    ap.append(EL("div", null,
      "When you have listened to the result and you are happy with it, record that. "
      + "Approval after listening is your own act and is recorded as one."));
    const arow = EL("div", "ear-row");
    const startBtn = EL("button", null, S.listenStart ? "listening…" : "I'm listening now");
    startBtn.addEventListener("click", () => { S.listenStart = Date.now(); render(); });
    const okBtn = EL("button", "ear-go", "Approve this mix");
    okBtn.addEventListener("click", approve);
    arow.append(startBtn, approveNote, okBtn);
    ap.append(arow);
    body.append(ap);
  }

  function renderAuto() {
    body.append(EL("div", "ear-h", "auto-progression — the Ear answers its own cards"));
    body.append(EL("div", "ear-note",
      "Every decision it makes is recorded as the machine's, delegated by you — never "
      + "as your own deliberation. Your brief below is recorded verbatim and is what "
      + "those decisions are delegated BY. Review afterwards is what turns any of them "
      + "into a real, informed selection of yours."));
    body.append(briefBox);
    const row = EL("div", "ear-row");
    const go = EL("button", "ear-go", "Delegate and run");
    go.addEventListener("click", runAuto);
    row.append(go, iterSel, genreSel);
    body.append(row);

    if (!S.review) return;
    body.append(EL("div", "ear-h", "the review checkpoint"));
    body.append(EL("div", "ear-note", S.review.note));
    for (const rrow of S.review.cards) {
      if (!S.shownAt.has(`rev:${rrow.card}`)) S.shownAt.set(`rev:${rrow.card}`, Date.now());
      const el = EL("div", `ear-card${rrow.already_reviewed ? " answered" : ""}`);
      el.append(EL("div", "ear-obs", rrow.observation));
      const chosen = (rrow.alternatives || []).find((o) => o.id === rrow.the_ear_chose);
      el.append(EL("div", "ear-where",
        `the Ear chose: ${chosen?.text || rrow.the_ear_chose} · `
        + `${rrow.outcome.verdict}${rrow.outcome.reverted ? " (reverted)" : ""}`));
      if (rrow.already_reviewed) { el.append(EL("div", "ear-verdict kept", "reviewed")); body.append(el); continue; }
      const keep = EL("button", "ear-route");
      keep.textContent = "Keep this — I've seen the alternatives";
      keep.addEventListener("click", () => review(rrow, "keep"));
      el.append(keep);
      for (const alt of rrow.alternatives.filter((o) => o.id !== rrow.the_ear_chose)) {
        const b = EL("button", "ear-route", `Change to: ${alt.text}`);
        b.addEventListener("click", () => review(rrow, "override", alt.id));
        el.append(b);
      }
      const own = EL("div", "ear-own");
      own.append(EL("label", null, "…or your own direction"));
      const ta = EL("textarea");
      ta.placeholder = "your own direction…";
      own.append(ta);
      const send = EL("button", null, "Take my direction");
      send.addEventListener("click", () => {
        if (!ta.value.trim()) return say("write your direction first", true);
        review(rrow, "override", null, ta.value.trim());
      });
      own.append(send);
      el.append(own);
      body.append(el);
    }
    const left = S.review.cards.filter((r) => !r.already_reviewed).length;
    if (left > 1) {
      const bulk = EL("div", "ear-bulk");
      bulk.append(document.createTextNode(
        `You can ratify the remaining ${left} in one action. Recorded as bulk. `));
      const b = EL("button", null, "Keep all remaining");
      b.addEventListener("click", keepAll);
      bulk.append(b);
      body.append(bulk);
    }
  }

  async function renderTaste() {
    const mine = S.tab;
    body.append(EL("div", "ear-h", "taste profile"));
    let t;
    try { t = await get("/api/daw/ear/taste"); }
    catch (err) { body.append(EL("div", "ear-note", err.message)); return; }
    if (S.tab !== mine) return;                 // the human switched tabs mid-fetch
    body.append(EL("div", "ear-note",
      `${t.summary.observations} decision${t.summary.observations === 1 ? "" : "s"} recorded`
      + `${t.summary.cold_start ? " — still neutral (" + t.summary.prior + ")" : ""}. `
      + "It changes the ORDER cards appear in and whether a class may be applied "
      + "automatically. It never invents a finding and never hides a measurement."));
    if (t.summary.metrics.length) {
      const tbl = EL("table", "ear-tbl");
      const hr = EL("tr");
      for (const h of ["genre", "metric", "✓", "✗", "over", "weight", "auto"]) hr.append(EL("th", null, h));
      tbl.append(hr);
      for (const r of t.summary.metrics) {
        const tr = EL("tr");
        for (const v of [r.genre, r.metric, r.accepted, r.rejected, r.overridden,
                         r.weight, r.auto_allowed ? "yes" : "no"]) {
          tr.append(EL("td", null, String(v)));
        }
        tbl.append(tr);
      }
      body.append(tbl);
    }
    body.append(EL("div", "ear-note", `stored at ${t.path}`));
    const b = EL("button", null, "Reset to neutral");
    b.addEventListener("click", async () => {
      if (!window.confirm("Reset the taste profile to neutral?\n\n"
        + "The provenance ledger is untouched — it stays the record of what you "
        + "actually decided. Only the derived preference cache is cleared.")) return;
      try { await post({ action: "taste_reset", slug: getSlug() || "x" }); say("taste profile reset"); }
      catch (err) { say(err.message, true); }
      render();
    });
    body.append(b);
  }

  function renderAbout() {
    const st = S.status;
    body.append(EL("div", "ear-h", "the objective critic — no model, cannot be fooled"));
    if (!st) { body.append(EL("div", "ear-note", "loading…")); return; }
    if (st.error || st.objective?.error) {
      body.append(EL("div", "ear-note", st.error || st.objective.error));
    } else {
      const tbl = EL("table", "ear-tbl");
      for (const c of st.objective.critics) {
        const tr = EL("tr");
        tr.append(EL("td", null, c.metric), EL("td", null, c.measures));
        tbl.append(tr);
      }
      body.append(tbl);
      body.append(EL("div", "ear-note",
        `bands: ${st.objective.bands.join(", ")} · reference: pink noise + genre tilt · `
        + `band tables agree: ${st.objective.bands_agree ? "yes" : "NO — report this"}`));
    }
    body.append(EL("div", "ear-h", "the subjective ear"));
    const sub = st.subjective || {};
    if (sub.available) {
      body.append(EL("div", "ear-note", `installed: ${Object.entries(sub.judges || {})
        .filter(([, v]) => v.installed).map(([k]) => k).join(", ")}`));
    } else {
      body.append(EL("div", "ear-note",
        "No aesthetic judge is installed on this machine, so the Ear ran on measurements "
        + "alone. Nothing was faked: there are no aesthetic scores above, because there "
        + "are none to give."));
      const steps = sub.installer?.steps || [];
      if (steps.length) {
        body.append(EL("div", "ear-h", "to install one"));
        body.append(EL("div", "ear-pre", steps.join("\n")));
        body.append(EL("div", "ear-note", sub.installer.where));
      }
      for (const [k, v] of Object.entries(sub.judges || {})) {
        body.append(EL("div", "ear-note", `${k} — ${v.role} (${v.licence})`));
      }
    }
    if (sub.refused) {
      body.append(EL("div", "ear-h", "refused on licence"));
      for (const [k, v] of Object.entries(sub.refused)) {
        body.append(EL("div", "ear-note", `${k}: ${v}`));
      }
    }
    body.append(EL("div", "ear-h", "the loop"));
    body.append(EL("div", "ear-note",
      `at most ${st.loop?.card_cap} cards per pass, at most ${st.loop?.iteration_cap} `
      + `auto iterations, and any edit that raises the objective penalty by more than `
      + `${st.loop?.ab_epsilon} dB is reverted and reported.`));
  }

  function render() {
    for (const b of tabs.children) b.classList.toggle("on", b.dataset.tab === S.tab);
    body.textContent = "";
    if (S.tab === "listen") renderListen();
    else if (S.tab === "auto") renderAuto();
    else if (S.tab === "taste") renderTaste();
    else renderAbout();
  }

  render();
  return { toggle, listen, get state() { return S; } };
}
