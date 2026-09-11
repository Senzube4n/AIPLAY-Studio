/**
 * THE SCORE PANEL — the editable lead sheet, in the page.
 *
 * YuE2 plans an ABC score before it generates any audio, and a supplied score
 * is honoured verbatim for ZERO generated tokens. That is the whole reason this
 * panel exists: an edit is free and only the render is paid for, so the loop is
 * read → change two characters → render again, rather than rewrite the prompt
 * and hope. A prompt is a wish; a score is an instruction.
 *
 * ⚠ WHAT IT DOES NOT CLAIM. A supplied score constrains the NOTES and not the
 * LENGTH. MEASURED across three trimmed scores: two renders matched their
 * notation to 0.4% and 2.5%, and one notating 86.25 s came back 165.2 s — the
 * model doubled it. So the panel reports the notated duration as what the score
 * ASKS FOR, never as what the render will be, and `scorePanelNote` says so in
 * the page rather than leaving a reader to assume a contract that does not
 * exist.
 *
 * ⚠ EVERY ELEMENT ID IS READ OUT OF web/index.html, NOT INVENTED HERE. Three
 * controls on this page were once hidden by ids that resolved to undefined, so
 * the hide silently matched nothing and reported success; one of them,
 * `scoreOpen`, named a panel that had never been built. Anything this file
 * reaches for exists in the markup — and `el()` returns null loudly rather than
 * throwing, so a missing id degrades to a dead button instead of a dead page.
 *
 * ⚠ IT TALKS TO /api/score AND NOTHING ELSE. The whole score subsystem sat
 * unreachable for a day — 2451 lines, 1287 passing assertions, and no dispatch
 * in index.js — so this module deliberately exercises the HTTP door rather than
 * importing anything from the server. If the door closes again, this panel
 * stops working visibly instead of a test going on passing.
 */

const el = (id) => document.getElementById(id);

/** One POST to the action-dispatched door, with its refusal text preserved. */
async function score(body) {
  const r = await fetch("/api/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  /* The server's refusals are written to be read by a person — they name the
   * field, the slug, or the versions that exist. Paraphrasing one here would
   * throw away the only part of the error that helps. */
  if (!r.ok || j.error) throw new Error(j.error || `/api/score answered ${r.status}`);
  return j;
}

const state = { scores: [], slug: null, version: null, loaded: "", capability: null };

function say(msg, kind = "") {
  const s = el("scoreStatus");
  if (!s) return;
  s.textContent = msg || "";
  s.className = `hint${kind ? " " + kind : ""}`;
}

/** The derived facts, from the score the server read — never recomputed here.
 *
 * ⚠ EVERY FIELD NAME BELOW WAS READ OFF A REAL /api/score RESPONSE. The first
 * draft of this function guessed four of them and got four wrong: `headers`
 * carries `bpm` and not `tempo`, `sections` is a COUNT and not an array,
 * `versions` is an array in `read` and a count in `list`, and the version rows
 * live in `j.versions` rather than a `j.version`. Every one would have rendered
 * "undefined" or silently nothing into a panel that looked finished. */
function paintFacts(detail) {
  const f = el("scoreFacts");
  if (!f) return;
  const sc = detail?.score;
  if (!sc || sc.unavailable) {
    f.textContent = sc?.unavailable ? `The score could not be read: ${sc.unavailable}` : "";
    return;
  }
  const h = sc.headers || {};
  const bits = [];
  if (h.bpm) bits.push(`${h.bpm} BPM`);
  if (h.meter) bits.push(h.meter);
  if (h.key) bits.push(h.key);
  if (sc.voices?.length) bits.push(`${sc.voices.length} voices`);
  if (Number.isFinite(sc.bars)) bits.push(`${sc.bars} bars`);
  if (Number.isFinite(sc.sections) && sc.sections > 0) bits.push(`${sc.sections} sections`);
  /* ASKS FOR, not "is". See the banner: the render is not bound to this. */
  if (Number.isFinite(sc.map?.nominalSeconds)) {
    bits.push(`asks for ${Math.round(sc.map.nominalSeconds)} s`);
  }
  if (detail?.audioSeconds) bits.push(`rendered ${detail.audioSeconds.toFixed(1)} s`);

  /* ⚠ `standing` INVARIANTS ARE NOT PROBLEMS WITH THIS SCORE. Every healthy
   * YuE2 render fails `trailing_silence_unaccounted` — it is a permanent note
   * about the model (0.84-1.82 s of silence after the last note), severity
   * "note", true of every render measured. Showing it would put a ⚠ on every
   * score in the library, and a warning that is always on is a warning nobody
   * reads. Only blocking and warn survive, and only if they are not standing.
   *
   * What DOES belong here carries the MEASUREMENT rather than a verdict:
   * "8/4 against content of 4" says what the wrong thing believes, where
   * "meter mismatch" only says something is wrong. */
  const bad = (sc.invariants || []).filter((i) =>
    !i.ok && !i.standing && (i.severity === "blocking" || i.severity === "warn"));
  f.textContent = bits.join(" · ");
  if (bad.length) {
    f.textContent += ` — ⚠ ${bad.map((i) => {
      const m = i.measured;
      const said = m && typeof m === "object" ? JSON.stringify(m) : (m ?? i.what);
      return `${i.id}: ${said}`;
    }).join("; ")}`;
  }
}

function paintSheetLinks(detail) {
  const sheet = detail?.sheet;
  const html = el("scoreSheetLink"), pdf = el("scorePdfLink");
  const base = `/api/score/sheet/${encodeURIComponent(state.slug)}/${encodeURIComponent(state.version)}`;
  if (html) {
    html.hidden = !sheet?.html;
    html.href = sheet?.html ? `${base}.html` : "#";
  }
  if (pdf) {
    /* pdfSkipped is not a failure: the engraver says in words when Edge is
     * absent, and a machine with no Edge still gets the HTML. */
    pdf.hidden = !sheet?.pdf;
    pdf.href = sheet?.pdf ? `${base}.pdf` : "#";
  }
}

async function loadVersion() {
  if (!state.slug) return;
  /* `read` answers { ok, score, versions[], roots, capability } — `score` is the
   * DOCUMENT (slug, title, current, runs) and the notation lives on each row of
   * `versions`. Not a `j.version`, which is what the first draft looked for. */
  const j = await score({ action: "read", slug: state.slug });
  const rows = Array.isArray(j.versions) ? j.versions : [];
  const wanted = j.score?.current;
  const v = rows.find((r) => r.id === wanted) || rows[0] || null;
  state.version = v?.id || null;

  const ta = el("scoreAbc");
  if (ta) {
    /* Fetched over the artifact door rather than from the JSON: that route
     * serves score.abc byte for byte off disk, so what lands in the textarea is
     * what is stored and an edit is a diff against the real thing. */
    if (state.version) {
      const r = await fetch(`/api/score/file/${encodeURIComponent(state.slug)}`
        + `/${encodeURIComponent(state.version)}/score.abc`);
      ta.value = r.ok ? await r.text() : "";
      if (!r.ok) say(`the stored score could not be read (${r.status})`, "warn");
    } else {
      ta.value = "";
    }
    state.loaded = ta.value;
  }
  paintFacts(v);
  paintSheetLinks(v);
  if (state.version) {
    const many = rows.length > 1 ? ` of ${rows.length}` : "";
    say(`version ${state.version}${many}${v?.drafted ? " — a draft, no audio yet" : ""}`);
  } else {
    say("This score has no versions yet. Render with YuE2 and adopt the run folder.");
  }
}

async function refresh() {
  try {
    say("loading…");
    const j = await score({ action: "list" });
    state.scores = j.scores || [];
    state.capability = j.capability || null;
    const pick = el("scorePick");
    if (pick) {
      /* ⚠ `versions` IS A COUNT HERE AND AN ARRAY IN `read`. The list route
       * answers { versions: 1, sheets: 1, pdfs: 1, ... } — numbers — so
       * `(s.versions || []).length` rendered 0 for every score in the first
       * draft of this. Two shapes, one field name, and only one of them has a
       * `.length` worth having. */
      pick.innerHTML = state.scores.length
        ? state.scores.map((s) => {
          const n = Number.isFinite(s.versions) ? s.versions : 0;
          const secs = Number.isFinite(s.currentAudioSeconds)
            ? ` · ${Math.round(s.currentAudioSeconds)}s` : "";
          return `<option value="${s.slug}">${s.title || s.slug}`
            + ` (${n} version${n === 1 ? "" : "s"}${secs})</option>`;
        }).join("")
        : '<option value="">no scores yet</option>';
      if (state.slug && state.scores.some((s) => s.slug === state.slug)) pick.value = state.slug;
      else state.slug = state.scores[0]?.slug || null;
      if (state.slug) pick.value = state.slug;
    }
    if (state.slug) await loadVersion();
    else { say("No scores yet. Render with YuE2 and adopt the run folder."); }
  } catch (e) {
    say(e.message, "warn");
  }
}

/** What this machine can engrave, in the server's own words. */
function paintCapability() {
  const n = el("scorePanelNote");
  if (!n) return;
  const c = state.capability;
  const bits = ["An edit costs nothing — a supplied score is honoured verbatim for zero generated tokens. "
    + "The notated length is what the score ASKS FOR: the model is not bound to it."];
  if (c && c.pdf === false) {
    /* Said rather than hidden. A missing Edge is not a broken feature and the
     * HTML sheet still engraves; a greyed button with no explanation is worse
     * than a sentence. */
    bits.push("PDF is unavailable on this machine (no Edge found) — the HTML sheet still engraves.");
  }
  n.textContent = bits.join(" ");
}

export function mountScorePanel() {
  const panel = el("scorePanel");
  if (!panel) return;                       // markup absent: nothing to mount

  el("scoreReload")?.addEventListener("click", () => { refresh(); });
  el("scorePick")?.addEventListener("change", async () => {
    state.slug = el("scorePick").value || null;
    try { await loadVersion(); } catch (e) { say(e.message, "warn"); }
  });

  el("scoreSave")?.addEventListener("click", async () => {
    const ta = el("scoreAbc");
    if (!ta || !state.slug) return;
    if (ta.value === state.loaded) {
      /* The server refuses identical notation by hash and names the version
       * that holds it. Saying so here saves a round trip and is the same
       * sentence the server would send. */
      say("Nothing changed — an edit that changes nothing is not a new version.", "warn");
      return;
    }
    try {
      say("saving…");
      const j = await score({
        action: "draft", slug: state.slug, abc: ta.value,
        parent: state.version || undefined,
        note: "edited in the Studio",
      });
      state.version = j.version;
      state.loaded = ta.value;
      /* `current` deliberately does not move to a draft — there is nothing to
       * hear — and the server says so in `currentNote`. Repeat it rather than
       * letting the player look broken. */
      say(`saved as ${j.version}${j.currentNote ? " · " + j.currentNote : ""}`);
      await refresh();
    } catch (e) { say(e.message, "warn"); }
  });

  el("scoreEngrave")?.addEventListener("click", async () => {
    if (!state.slug) return;
    try {
      say("engraving…");
      const j = await score({
        action: "sheet", slug: state.slug,
        version: state.version || undefined,
        format: "pdf",
      });
      const s = j.sheet || {};
      say(`engraved${s.pdfBytes ? ` — PDF ${(s.pdfBytes / 1024).toFixed(0)} KB` : ""}`
        + `${s.subtitle ? " · " + s.subtitle : ""}`
        /* The engraver checks its own output: abcjs draws with currentColor, so
         * a themed page can engrave white on white and produce a blank sheet
         * that no exit code complains about. */
        + `${s.engraveCheck && s.engraveCheck.engraved === false
          ? " ⚠ the engraver drew nothing: " + (s.engraveCheck.why || "unknown") : ""}`);
      await loadVersion();
    } catch (e) { say(e.message, "warn"); }
  });

  /* Opened lazily: the list is one GET but there is no reason to spend it on
   * every page load when the panel starts closed. */
  panel.addEventListener("toggle", () => {
    if (panel.open && !state.scores.length) refresh();
  });
  /* ⚠ AND ONCE AT MOUNT IF IT IS ALREADY OPEN, because `toggle` only fires on a
   * CHANGE. A panel that arrives open — a browser restoring the <details>
   * state, or markup shipped with the attribute — would never populate: empty
   * picker, placeholder text, and two buttons that look broken.
   *
   * Found by screenshotting it, not by testing it. My verification set
   * `panel.open = true` from script, which DOES fire toggle, so the probe
   * exercised a path the real case does not take and reported success. The
   * screenshot loaded the page with the attribute already present and showed an
   * empty panel. */
  if (panel.open && !state.scores.length) refresh();
  paintCapability();
}

/** Called by musicEnginePaint() when the engine changes. */
export function scorePanelCapability(capability) {
  state.capability = capability || state.capability;
  paintCapability();
}
