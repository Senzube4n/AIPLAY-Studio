/**
 * THE SCORE, ENGRAVED — ABC to a lead sheet (HTML, then PDF).
 *
 * Chain, all of it things this machine already has:
 *   abcjs (MIT)              engraves two-voice ABC with chord symbols. The
 *                            version is READ OFF THE FILE (abcjsInfo()), never
 *                            declared: MEASURED, this checkout holds 6.4.4 and
 *                            the copy exercised end to end tonight was 6.7.0.
 *   Edge --headless=new      prints the page; ships with Windows
 *
 * Adapted from the engraving prototype, which established every fact below by
 * running. The four that decided the shape of this file:
 *
 * 🔴 1. EDGE PRINTS FROM http:// AND NOT FROM file://. TESTED tonight: the
 *    prototype pointed --print-to-pdf at a file:// URL and NO PDF WAS PRODUCED
 *    — no error, no output, exit 0. From an http:// origin the same page and
 *    the same flags produced rain_leadsheet.pdf, 368,532 bytes for 122 bars
 *    (MEASURED). So renderSheet() requires an `origin`, and the app's own UI
 *    server is it: server/score/routes.js serves the page at
 *    /api/score/sheet/<slug>/<id>.html and the library at
 *    /api/score/vendor/abcjs.js, both from the one origin, so the page has no
 *    cross-origin anything to be blocked on.
 *
 * 🔴 2. abcjs DRAWS WITH currentColor. A page whose text colour is a dark
 *    theme's near-white engraves near-white notes on white paper. It is
 *    legible in neither theme and it looks like a render failure rather than a
 *    contrast bug, which is the worst way for it to fail — a human deletes the
 *    render instead of fixing the CSS. #paper therefore pins color:#000 on
 *    #fff unconditionally and is NOT theme-aware. Paper is white.
 *
 * 🔴 3. EDGE IS DETECTED, NEVER ASSUMED. MEASURED: it is under "Program Files"
 *    on this box and "Program Files (x86)" on others, and a stripped Windows
 *    image may not have it at all. NO EDGE MEANS NO PDF, NOT A FAILED RENDER —
 *    the HTML is the artifact and it is complete on its own. Same graceful
 *    degradation the rest of this repo gives an optional interpreter.
 *
 * 🔴 4. abcjs IS VENDORED, NOT CDN'd. INSTALL.md promises an offline install,
 *    so a CDN script tag is not acceptable here even as a fallback — a machine
 *    with no network would engrave a blank page and the PDF would be a
 *    plausible-looking empty sheet. NO VENDORED abcjs MEANS NO PDF ATTEMPT AT
 *    ALL (`pdfSkipped: "no-abcjs"`), for exactly that reason: a PDF of an
 *    un-engraved page is the failure that looks like success.
 *    A copy is already vendored at web/vendor/abcjs/ in this checkout, put
 *    there by another hand the same night; abcjsPath() looks there FIRST for
 *    that reason, because a second copy at a second path is how two versions of
 *    one library end up in one build. The vendoring note above has the
 *    details. This file only reports the file's absence; it cannot install it.
 *
 * ⚠ THE SUBTITLE IS DERIVED, NEVER RETYPED. Tempo from Q:, meter from M:, key
 * from K:, voice count from the V: declarations, sections from the % comments —
 * all of it through server/score/abc.js, which is also what the section map and
 * the invariants read. A subtitle that restated a tempo the file states is a
 * subtitle that goes stale the first time the score is re-rolled, and the two
 * would then disagree on the same screen.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { writeFile, mkdir, stat, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
/* THE ESTABLISHED TREE-KILL, not a fifth copy of taskkill. server/mesh/
 * runner.js:570-582. The trap it exists for was measured on python, but Edge is
 * the same shape of process — a browser process that spawns renderer children —
 * and a plain kill on the parent leaves them running. That contaminated every
 * timing measurement in this project by 3.3x-10.8x once already, and presented
 * as a slow render rather than a stuck one. */
import { killMeshProcessTree } from "../mesh/runner.js";
import { readScoreText, invariants, worstSeverity, nominalSeconds, secondsPerBar } from "./abc.js";
import { sheetDir, safeSeg } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

/* ── the two optional things, both detected ───────────────────────────────── */

/**
 * WHERE abcjs LIVES WHEN IT IS HERE.
 *
 * The file wanted is the single-file UMD build `abcjs-basic-min.js` — the
 * engraver without the synth or the editor, which is why it is half a megabyte
 * rather than the 5.7 MB the npm package unpacks to.
 *
 * FOUR PLACES, and the order is not arbitrary:
 *   AIPLAY_ABCJS         the override. The tests need it: they must be able to
 *                        drive both the present and the absent branch on one
 *                        machine, whatever this checkout happens to hold.
 *   web/vendor/abcjs/    ⚠ WHERE IT ALREADY IS. Another hand vendored a copy
 *                        here the same night this file was written, and it is
 *                        first because a second copy at a second path is how two
 *                        versions of one library end up in one build. MEASURED
 *                        on this checkout: 483,417 bytes, v6.4.4.
 *   vendor/abcjs/        where the repo keeps code it did not write.
 *   node_modules/        if a future `npm i abcjs` happens instead.
 */
export const abcjsPath = () => {
  const candidates = [
    process.env.AIPLAY_ABCJS || null,
    path.join(ROOT, "web", "vendor", "abcjs", "abcjs-basic-min.js"),
    path.join(ROOT, "vendor", "abcjs", "abcjs-basic-min.js"),
    path.join(ROOT, "node_modules", "abcjs", "dist", "abcjs-basic-min.js"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
};

/**
 * The version this project has actually TESTED, which is not the same claim as
 * the version on disk.
 *
 * MEASURED tonight, end to end — two-voice ABC with chord symbols engraved and
 * printed: 6.7.0, 511,903 bytes. The copy vendored in this checkout is 6.4.4,
 * 483,417 bytes. Both engrave this dialect; nothing here has compared them, and
 * pretending otherwise by hardcoding one number would be a claim nobody
 * measured. So the number REPORTED is read off whichever file is present, and
 * this constant is only the one that was exercised.
 */
export const ABCJS_TESTED_VERSION = "6.7.0";

/**
 * The version of the bundle on disk, read out of its own banner.
 *
 * abcjs writes `/*! abcjs_basic v6.7.0 Copyright ... *​/` as the first line of
 * the minified file, so this is the library's own answer rather than ours. Null
 * when the banner is not there — which is worth reporting, because a bundle
 * with no banner is not a bundle this code has any reason to trust.
 */
export function abcjsInfo() {
  const file = abcjsPath();
  if (!file) return null;
  let head = "", bytes = null;
  try {
    bytes = statSync(file).size;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(200);
    const read = readSync(fd, buf, 0, 200, 0);
    closeSync(fd);
    head = buf.subarray(0, read).toString("utf8");
  } catch { /* reported as an absent version below, not thrown */ }
  const version = (/abcjs_basic\s+v(\d+\.\d+\.\d+)/.exec(head) || [, null])[1];
  return {
    path: file,
    bytes,
    version,
    tested: ABCJS_TESTED_VERSION,
    /* Said out loud rather than ignored. Not a failure — just a difference
     * between what is installed and what was exercised. */
    untested: version !== null && version !== ABCJS_TESTED_VERSION,
  };
}

/**
 * WHERE EDGE LIVES, ASKED RATHER THAN ASSUMED.
 *
 * The env vars first, because "Program Files" is not a constant: it is under
 * ProgramFiles on this box and ProgramFiles(x86) on others, and a machine with
 * a relocated Program Files has neither at the literal C: path. The literals
 * stay last for a service context where the env is stripped, and LOCALAPPDATA
 * is there because Edge can be installed per-user.
 *
 * AIPLAY_EDGE overrides everything, for the same reason AIPLAY_ABCJS does.
 */
export function edgePath() {
  if (process.env.AIPLAY_EDGE) return existsSync(process.env.AIPLAY_EDGE) ? process.env.AIPLAY_EDGE : null;
  const rel = path.join("Microsoft", "Edge", "Application", "msedge.exe");
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean);
  const found = roots.map((r) => path.join(r, rel)).find((p) => existsSync(p));
  if (found) return found;
  /* Not Windows. Untested on this rig — the repo is Windows-first — so it is
   * offered rather than claimed, and absence is still not a failure. */
  if (process.platform !== "win32") {
    const unix = [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/usr/bin/microsoft-edge",
      "/opt/microsoft/msedge/msedge",
    ];
    return unix.find((p) => existsSync(p)) || null;
  }
  return null;
}

/** What the engraver can do here, and in which words. One place, both surfaces. */
export function sheetCapability() {
  const abcjs = abcjsInfo();
  const edge = edgePath();
  /* TWO SENTENCES AT MOST, and the second one is independent of the first.
   * ⚠ The version warning used to live inside the "HTML and PDF" branch, which
   * meant a machine with no Edge was told nothing about an untested engraver —
   * and the engraver is what draws the HTML, which is the half that still
   * works. sheet_test.js caught it. What can be done and what it is done WITH
   * are separate facts, so they are separate sentences. */
  const can = abcjs && edge
    ? "HTML and PDF."
    : !abcjs
      ? "HTML only — abcjs is not vendored, so the page would engrave nothing and a PDF of it "
        + "would be a blank sheet that looks like a finished one. See the vendoring note at the top of server/score/sheet.js."
      : "HTML only — no Edge on this machine, so nothing here can print the page. The HTML is "
        + "complete; print it from a browser.";
  const which = abcjs?.untested
    ? ` The abcjs on disk is ${abcjs.version}; ${ABCJS_TESTED_VERSION} is the version this project `
      + "measured end to end. Both engrave this dialect; nothing here has compared them."
    : "";
  return {
    html: true,
    abcjs,
    edge: edge || null,
    pdf: !!(abcjs && edge),
    note: can + which,
  };
}

/* ── the derived subtitle ─────────────────────────────────────────────────── */

/**
 * The one line under the title, computed from the score.
 *
 * Every part of it comes out of abc.js, which means the tempo on the sheet and
 * the tempo the section map divides by are the same number by construction. The
 * meter is printed as the CONTENT spells it with the header's claim beside it
 * when they differ — a sheet that prints "4/4" over bars of two beats is the
 * original defect wearing a serif font.
 */
export function sheetSubtitle(score) {
  const h = score.headers;
  const parts = [];
  if (h.bpm) parts.push(`${h.bpm} BPM`);
  if (score.contentQuartersPerBar && h.headerQuartersPerBar
      && score.contentQuartersPerBar !== h.headerQuartersPerBar) {
    parts.push(`${score.contentQuartersPerBar} beats/bar (header says M:${h.meter})`);
  } else if (h.meter) {
    parts.push(h.meter);
  }
  if (h.key) parts.push(h.key);
  const voices = h.declaredVoices.length || Object.keys(score.barsPerVoice).length;
  if (voices) parts.push(`${voices} ${voices === 1 ? "voice" : "voices"}`);
  if (score.bars) parts.push(`${score.bars} bars`);
  if (score.sections.length) {
    parts.push(score.sections.map((s) => (s.ordinal > 1 ? `${s.name} ${s.ordinal}` : s.name)).join(" / "));
  }
  return parts.join(" \u00b7 ");
}

/** HTML-escape. Titles come from a human and notes come from a human. */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * A JS string literal that is safe INSIDE a <script> element.
 *
 * 🔴 JSON.stringify IS NOT ENOUGH HERE, and sheet_test.js found it. An HTML
 * parser ends a script element at the first `</script>` in its text, string
 * literal or not — so a score containing that sequence closed the tag early,
 * dumped the rest of the score into the document as markup and left the page
 * with no engraver call at all. The score text comes from a model, so this is
 * reachable input and not a theoretical one. The engraving prototype has the
 * same defect.
 *
 * Escaping `</` rather than only `</script`, because the same trick works on
 * `</ScRiPt` and on `</style`. U+2028 and U+2029 need no handling: they have
 * been legal inside a JS string literal since ES2019 and this page only ever
 * runs in an evergreen Edge.
 */
const jsString = (v) => JSON.stringify(String(v ?? "")).replace(/<\//g, "<\\/");

/**
 * The engraving page.
 *
 * `scriptSrc` is a URL on the SAME ORIGIN as the page, served by
 * server/score/routes.js. Not a file:// path and not a CDN: the first does not
 * print (fact 1 in the banner) and the second breaks the offline promise
 * (fact 4).
 *
 * The page reports its own outcome in two machine-readable places — a
 * `data-engraved` attribute on <html> and `window.__sheet`. That attribute is
 * not decoration: verifyEngraved() below reads it back out of the real served
 * page with `--dump-dom` before any PDF is printed, because a size check
 * cannot do the job (MEASURED: a page that engraved NOTHING still prints to
 * 33,230 bytes).
 */
export function buildPage(abc, {
  title = "Lead sheet", subtitle = "", scriptSrc = null, note = null,
  staffwidth = 700, invariantLines = [],
} = {}) {
  const script = scriptSrc
    ? `<script src="${esc(scriptSrc)}"></script>`
    /* NO CDN FALLBACK, deliberately. See fact 4. An absent library must make
     * the page say so in words, not fetch one from the internet. */
    : `<script>window.__noAbcjs = true;</script>`;
  return `<meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { background:#fff; color:#111; font:13px/1.5 system-ui,sans-serif; margin:0; padding:18px; }
  h1 { font:600 19px/1.2 Georgia,serif; margin:0 0 3px; }
  .sub { color:#555; margin:0 0 4px; font-size:12px; }
  .note { color:#222; margin:8px 0 14px; font-size:12px; white-space:pre-wrap;
          border-left:3px solid #ddd; padding:2px 0 2px 9px; }
  .inv { color:#8a5200; margin:0 0 12px; font-size:11px; }
  .inv b { color:#b3261e; }
  /* ⚠ abcjs draws with currentColor. Pin it, or a themed page engraves
   * near-white notes on white paper and reads as a render failure. Paper is
   * white; this block is NOT theme-aware and must not become so. */
  #paper { background:#fff; color:#000; }
  #paper svg { max-width:100%; }
  #err { color:#b3261e; font:12px ui-monospace,monospace; white-space:pre-wrap; }
  @media print { .inv { color:#555; } }
</style>
<h1>${esc(title)}</h1>
<p class="sub">${esc(subtitle)}</p>
${invariantLines.length ? `<p class="inv">${invariantLines.map((l) => `<b>${esc(l.severity)}</b> ${esc(l.what)}`).join("<br>")}</p>` : ""}
${note ? `<p class="note">${esc(note)}</p>` : ""}
<div id="paper"></div>
<div id="err"></div>
${script}
<script>
  var ABC = ${jsString(abc)};
  (function () {
    function done(ok, why) {
      window.__sheet = { engraved: ok, why: why || null };
      /* READ BACK BY verifyEngraved() over --dump-dom. An attribute rather than
       * only a JS global because --dump-dom serialises the DOM and not the
       * window, so a global alone would be invisible to the one caller that
       * needs the answer. */
      document.documentElement.setAttribute("data-engraved", ok ? "yes" : "no");
      if (why) document.documentElement.setAttribute("data-engrave-why", String(why).slice(0, 200));
    }
    if (window.__noAbcjs || typeof ABCJS === "undefined") {
      document.getElementById("err").textContent =
        "abcjs is not available to this page, so nothing was engraved. The score text is intact; "
        + "only the notation is missing.";
      return done(false, "no-abcjs");
    }
    try {
      ABCJS.renderAbc("paper", ABC, { staffwidth: ${Number(staffwidth) || 700}, add_classes: true, paddingtop: 0 });
      var svg = document.querySelector("#paper svg");
      if (!svg) throw new Error("abcjs returned without drawing a staff");
      done(true, null);
    } catch (e) {
      document.getElementById("err").textContent = "ENGRAVING FAILED: " + e.message;
      done(false, e.message);
    }
  })();
</script>`;
}

/* ── printing ─────────────────────────────────────────────────────────────── */

/**
 * 🔴 A SIZE FLOOR CANNOT TELL AN ENGRAVED SHEET FROM A BLANK ONE, and this
 * number is here to say so rather than to be relied on.
 *
 * MEASURED tonight, same Edge, same flags, same 122-bar page, one served with
 * the vendored abcjs and one without:
 *      engraved    352,047 bytes   (the prototype's earlier run: 368,532)
 *      NOT engraved 33,230 bytes   — a titled page with no staff on it
 * A floor placed anywhere below 33,230 passes the blank sheet; a floor placed
 * above it would reject a genuinely short score. So the size check is only what
 * it can honestly be — a guard against a truncated or zero-length write — and
 * the real question is answered by verifyEngraved() before anything is printed.
 * That is exactly the trap DIRECTING.md:1220-1252 keeps describing: the blank
 * sheet is a failure that looks like success, and every log line says 200.
 */
export const PDF_FLOOR_BYTES = 1024;

/**
 * How long Edge is given. `--virtual-time-budget` makes the browser's own clock
 * run fast so the page's script finishes before the print is taken; the wall
 * timeout is the outer guard for an Edge that never exits at all.
 * MEASURED: --dump-dom returns in 1.9-2.2 s and the print in about the same, so
 * 60 s is roughly 25x headroom.
 */
export const VIRTUAL_TIME_BUDGET_MS = 8000;
export const EDGE_TIMEOUT_MS = 60_000;

/**
 * Flags every Edge launch here shares.
 *
 * ⚠ --user-data-dir IS NOT OPTIONAL. Edge refuses to start headless against a
 * profile another Edge already holds, and the human's own browser is very
 * likely open — which turns a working print into an exit code nobody can
 * explain. A throwaway profile per launch, removed after.
 * ⚠ --disable-gpu because nothing here needs one and another agent may be
 * rendering on it.
 */
const edgeBase = (profile) => [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`,
  `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
];

const throwawayProfile = () =>
  path.join(os.tmpdir(), `aiplay-sheet-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

/**
 * ⚠ THE CALLER MUST NOT BLOCK THE EVENT LOOP WHILE THIS RUNS, which is why it
 * is `spawn` and not `spawnSync`.
 *
 * MEASURED, and it cost twenty minutes tonight: a spawnSync launch of Edge
 * against this app's own http server hung until the 180 s timeout and produced
 * no PDF, twice, looking exactly like the file:// failure. Edge was fine — the
 * Node process was blocked inside spawnSync and could not answer the request
 * for the page it had just been told to print. A synchronous child and a server
 * in the same process are mutually exclusive, and this route is both.
 */
function runEdge(edge, args, { timeoutMs = EDGE_TIMEOUT_MS, capture = false } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(edge, args, {
        windowsHide: true,
        stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
      });
    } catch (err) {
      return resolve({ ok: false, why: `edge-spawn: ${err.message}`, out: "" });
    }
    let out = "";
    if (capture) proc.stdout.on("data", (d) => { out += d; });
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ out, ...v }); } };
    const timer = setTimeout(() => {
      /* TREE-KILL. Edge is a parent that spawns renderers; a plain kill leaves
       * them, and an orphaned renderer holding the output file is why the next
       * print appears to succeed against a stale PDF. server/mesh/runner.js:570. */
      killMeshProcessTree(proc).then((stopped) => finish({
        ok: false,
        why: `edge-timeout after ${Math.round(timeoutMs / 1000)}s`
          + (stopped ? " (process tree stopped)" : " (process-tree termination NOT confirmed)"),
      }));
    }, timeoutMs);
    proc.once("error", (err) => finish({ ok: false, why: `edge-spawn: ${err.message}` }));
    proc.once("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, why: `edge-exit ${code}` }));
  });
}

/**
 * DID THE SERVED PAGE ACTUALLY ENGRAVE? Asked of the page, not of a file size.
 *
 * `--dump-dom` prints the DOM after the page's script has run, so the
 * `data-engraved` attribute buildPage() sets comes back as text. This is the
 * only way available here to distinguish the sheet from the blank: MEASURED,
 * the two pages differ by 878,925 bytes of DOM (883,787 engraved against 4,862
 * not) and by 319,000 bytes of PDF, but both print with exit 0 and both look
 * like a finished document until somebody opens them.
 *
 * MEASURED cost: 2.2 s engraved, 1.9 s not — against a 399.6 s render.
 */
export async function verifyEngraved(edge, url, { timeoutMs = EDGE_TIMEOUT_MS } = {}) {
  const profile = throwawayProfile();
  const run = await runEdge(edge, [...edgeBase(profile), "--dump-dom", url],
    { timeoutMs, capture: true });
  await rm(profile, { recursive: true, force: true });
  if (!run.ok) return { engraved: false, why: run.why, domBytes: run.out.length };
  const m = /data-engraved="(yes|no)"/.exec(run.out);
  const why = (/data-engrave-why="([^"]*)"/.exec(run.out) || [, null])[1];
  if (!m) {
    return {
      engraved: false, domBytes: run.out.length,
      /* The page always sets the attribute, both branches, so its absence means
       * the script did not run at all — a JS error before the try, or a page
       * that is not the page we wrote. */
      why: "the served page did not report an engraving outcome at all, so its script never ran",
    };
  }
  return { engraved: m[1] === "yes", why: m[1] === "yes" ? null : (why || "the page reported it engraved nothing"), domBytes: run.out.length };
}

/**
 * Engrave one version's score.
 *
 * Writes `sheet.html` (always) and `sheet.pdf` (when both optional pieces are
 * present and Edge produces one) into <outputDir>/score/<slug>/sheets/<id>/ —
 * OURS, deliberately not inside the version folder, so "every file in
 * versions/<id>/ is hashed by result.json or named in `unreceipted`" stays a
 * property server/score/store_test.js can check.
 *
 * `origin` must be an http:// origin that serves this app's routes. Without it
 * the HTML is still written and the PDF is skipped with a reason, because a
 * file:// print produces nothing at all (fact 1 in the banner) and a silent
 * nothing is the worst of the available answers.
 */
export async function engrave({
  slug, versionId, abc, title = null, author = null, note = null,
  audioSeconds = null, origin = null, staffwidth = 700, keepHtml = true,
} = {}) {
  const s = safeSeg(slug), v = safeSeg(versionId);
  if (!s || !v) throw new Error("engrave needs a slug and a version id.");
  if (!abc) throw new Error("engrave needs the score text.");

  const score = readScoreText(abc);
  const rows = invariants(score, { audioSeconds });
  const worst = worstSeverity(rows);
  const subtitle = sheetSubtitle(score);

  /* THE SHEET CARRIES ITS OWN DISAGREEMENTS. Only the ones that are not `note`:
   * a printed sheet whose meter is not the meter its header claims must say so
   * on the page, because the page is the thing that leaves the building and a
   * JSON field is not. */
  const invariantLines = rows
    .filter((r) => !r.ok && !r.standing && r.severity !== "note")
    .map((r) => ({ severity: r.severity, what: r.what }));

  const dir = sheetDir(s, v);
  await mkdir(dir, { recursive: true });

  const lib = abcjsPath();
  const scriptSrc = lib ? "/api/score/vendor/abcjs.js" : null;
  const html = buildPage(abc, {
    title: title || s, subtitle, scriptSrc, note, staffwidth, invariantLines,
  });
  const htmlPath = path.join(dir, "sheet.html");
  await writeFile(htmlPath, html, "utf8");

  const out = {
    html: "sheet.html",
    htmlBytes: Buffer.byteLength(html, "utf8"),
    pdf: null,
    pdfBytes: null,
    pdfSkipped: null,
    subtitle,
    worst,
    /* WHAT THE SHEET WAS DERIVED FROM, quoted back, so no line on the paper is
     * traceable to a reading nobody can see — welcome/routes.js's habit. */
    derived: {
      bpm: score.headers.bpm,
      meterHeader: score.headers.meter,
      quartersPerBarContent: score.contentQuartersPerBar,
      quartersPerBarHeader: score.headers.headerQuartersPerBar,
      key: score.headers.key,
      voices: score.headers.declaredVoices.map((d) => d.id),
      bars: score.bars,
      sections: score.sections.map((x) => (x.ordinal > 1 ? `${x.name} ${x.ordinal}` : x.name)),
      secondsPerBar: secondsPerBar(score),
      nominalSeconds: nominalSeconds(score),
    },
    author: author || null,
    at: Date.now(),
  };

  /* ── the PDF, or an honest reason there is none ──────────────────────────── */
  if (!lib) { out.pdfSkipped = "no-abcjs"; return out; }
  const edge = edgePath();
  if (!edge) { out.pdfSkipped = "no-edge"; return out; }
  if (!origin) { out.pdfSkipped = "no-http-origin"; return out; }

  const pdfPath = path.join(dir, "sheet.pdf");
  await rm(pdfPath, { force: true });          // never leave a stale PDF to be mistaken for this one
  const url = `${String(origin).replace(/\/+$/, "")}/api/score/sheet/${encodeURIComponent(s)}/${encodeURIComponent(v)}.html`;

  /* ASK THE PAGE BEFORE PRINTING IT. The one check that separates a lead sheet
   * from a titled blank; see verifyEngraved()'s measurements. It is done first
   * because a PDF that exists is a PDF somebody files. */
  const check = await verifyEngraved(edge, url);
  out.engraveCheck = { engraved: check.engraved, domBytes: check.domBytes, why: check.why };
  if (!check.engraved) {
    out.pdfSkipped = `page-did-not-engrave: ${check.why}`;
    return out;
  }

  const profile = throwawayProfile();
  const run = await runEdge(edge, [
    ...edgeBase(profile),
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    url,
  ]);
  await rm(profile, { recursive: true, force: true });

  let size = null;
  try { size = (await stat(pdfPath)).size; } catch { size = null; }

  if (size === null) {
    /* The prototype's exact measured failure, when it was pointed at file://:
     * no PDF, no error, exit 0. Named rather than thrown, because the HTML
     * beside it is complete and re-running will not help. */
    out.pdfSkipped = run.ok ? "edge-produced-no-file" : run.why;
    return out;
  }
  if (size < PDF_FLOOR_BYTES) {
    await rm(pdfPath, { force: true });
    out.pdfSkipped = `pdf-truncated (${size} bytes, floor ${PDF_FLOOR_BYTES}) — deleted rather than filed`;
    return out;
  }
  out.pdf = "sheet.pdf";
  out.pdfBytes = size;
  if (!keepHtml) await rm(htmlPath, { force: true });
  return out;
}
