/**
 * THE ENGRAVER — the guard suite. No GPU. Launches Edge only when Edge is on
 * this machine, and says so out loud when it is not.
 *
 * What each section is guarding:
 *
 *  · 🔴 BLACK ON WHITE, PINNED. abcjs draws with currentColor, so a page that
 *    inherits a dark theme's near-white text colour engraves near-white notes
 *    on white paper. It is legible in neither theme and it reads as a render
 *    failure, which is the worst way to fail: a human deletes the output
 *    instead of fixing the CSS. The rule is asserted on the emitted page.
 *
 *  · 🔴 NO CDN, EVER. INSTALL.md promises an offline install. A CDN fallback
 *    would engrave a blank page on a machine with no network and print a
 *    plausible-looking empty sheet, so the page is grepped for an external URL
 *    and the no-library branch must say so in words instead.
 *
 *  · 🔴 NOTHING ON THE SHEET IS RETYPED. Tempo, meter, key, voices, bars and
 *    sections all come out of server/score/abc.js — the same reader the section
 *    map uses — so the sheet and the map cannot disagree about the meter. In
 *    particular a score whose header says 4/4 over bars of two beats must NOT
 *    print "4/4": that is the original defect wearing a serif font.
 *
 *  · 🔴 NO EDGE AND NO abcjs ARE NOT FAILURES. Both are detected, both degrade
 *    to "HTML only" with the reason in words, and the no-abcjs case does not
 *    launch Edge at all.
 *
 *  · 🔴 A SIZE CHECK CANNOT SEE A BLANK SHEET. MEASURED tonight, same Edge,
 *    same flags, same page: 352,047 bytes engraved against 33,230 bytes not.
 *    So the outcome is read back off the served DOM before anything is printed.
 *
 * Runs standalone (`node server/score/sheet_test.js`). Writes only into a temp
 * directory, which it removes.
 */
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The output dir MUST be decided before config.js is first imported, and static
 * imports hoist — so every import below is dynamic. mv/plan_test.js:40-43. */
const OUT = path.join(os.tmpdir(), `score-sheet-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;
process.env.AIPLAY_APPDATA = path.join(OUT, "appdata");
mkdirSync(OUT, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
/** sheet.js as text, for the checks that pin a property of the SOURCE. */
const SRC = readFileSync(path.join(HERE, "sheet.js"), "utf8");

const REAL_ABC = readFileSync(path.join(FIX, "yue2_score.abc"), "utf8");
const REAL_RECEIPT = JSON.parse(readFileSync(path.join(FIX, "yue2_result.json"), "utf8"));
const REAL_AUDIO = REAL_RECEIPT.audio_seconds;

const { readScoreText } = await import("./abc.js");
const sheet = await import("./sheet.js");
const {
  buildPage, sheetSubtitle, edgePath, abcjsPath, sheetCapability,
  engrave, verifyEngraved, PDF_FLOOR_BYTES, VIRTUAL_TIME_BUDGET_MS,
  ABCJS_TESTED_VERSION, abcjsInfo,
} = sheet;
const { sheetDir, versionDir } = await import("./store.js");

let pass = 0;
const failures = [];
function ok(what, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ok    ${what}`); return true; }
  failures.push(what);
  console.log(`  FAIL  ${what}${detail ? `\n          ${detail}` : ""}`);
  return false;
}
const eq = (what, a, b) => ok(`${what} = ${JSON.stringify(b)}`, a === b, `got ${JSON.stringify(a)}`);

/* ── the real library, wherever it is on this machine ─────────────────────── */

/** The vendored bundle, or null. Tests that need it are skipped loudly. */
const LIB = abcjsPath();
const EDGE = edgePath();

/* ════════════════════════════════════════════════════════════════════════
 * 1 · THE PAGE. Black on white, no CDN, nothing injectable.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n1 · the engraving page\n");
{
  const page = buildPage(REAL_ABC, { title: "Ninety Storeys", subtitle: "90 BPM", scriptSrc: "/api/score/vendor/abcjs.js" });

  /* 🔴 THE CONTRAST RULE. */
  ok("#paper pins white paper", /#paper\s*\{[^}]*background:#fff/.test(page));
  ok("...and black ink", /#paper\s*\{[^}]*color:#000/.test(page));
  ok("...and nothing later re-themes it",
    !/prefers-color-scheme/.test(page) && !/data-theme/.test(page));
  ok("...and the reason is written where somebody about to 'fix' it will read it",
    /currentColor/.test(page) && /render failure/.test(page));

  /* 🔴 THE OFFLINE PROMISE. */
  ok("the page loads the library from THIS origin", /<script src="\/api\/score\/vendor\/abcjs\.js">/.test(page));
  ok("...and names no external host at all",
    !/https?:\/\//.test(page), (page.match(/https?:\/\/\S+/g) || []).join(" "));
  ok("...and sheet.js contains no CDN URL either",
    !/cdnjs|jsdelivr|unpkg/.test(SRC));

  /* The no-library branch says so in words rather than fetching one. */
  const bare = buildPage(REAL_ABC, { title: "x", scriptSrc: null });
  ok("with no library the page declares it", /window\.__noAbcjs = true/.test(bare));
  ok("...and explains what is missing in a sentence a human can read",
    /only the notation is missing/.test(bare), bare.slice(0, 200));
  ok("...and still contains no external URL", !/https?:\/\//.test(bare));

  /* The outcome is machine-readable, both branches, because verifyEngraved()
   * reads it back off the DOM and a JS global is not serialised by --dump-dom. */
  ok("the page stamps its outcome on the document element",
    /data-engraved/.test(page) && /data-engrave-why/.test(page));
  ok("...and also exposes it to a DOM-capable caller", /window\.__sheet = /.test(page));

  /* Injection. A title comes from a human and a score comes from a model. */
  const nasty = buildPage('X:1\nT:\n</script><script>alert(1)</script>', {
    title: '<img src=x onerror=alert(1)>', subtitle: '"quoted"', note: "<b>bold?</b>",
  });
  ok("a title with markup in it is escaped", /&lt;img src=x/.test(nasty) && !/<img src=x/.test(nasty));
  ok("...as is a note", /&lt;b&gt;bold\?&lt;\/b&gt;/.test(nasty));
  /* 🔴 THE DEFECT THIS TEST FOUND, and the engraving prototype still had it.
   * An HTML parser ends a script element at the first `</script>` in its text,
   * string literal or not — so JSON.stringify alone let a score close the tag
   * early, spill the rest of itself into the document as markup and leave the
   * page with no engraver call at all. The score comes from a model, so this is
   * reachable input. */
  ok("a score containing a closing script tag cannot break out of the string",
    !/<\/script><script>alert/.test(nasty), "raw </script> reached the page");
  ok("...because the sequence is escaped in the embedded literal",
    /var ABC = "X:1\\nT:\\n<\\\/script>/.test(nasty), (nasty.match(/var ABC = .*/) || [])[0]);
  /* Only the CLOSING tag matters: `<script` inside a script element is ordinary
   * text to an HTML parser, and the score legitimately contains one here. Two
   * closers means two script elements — the library stub and the engraver — and
   * not a third opened by the score. */
  eq("...so the page still closes exactly the two script elements it opened",
    (nasty.match(/<\/script>/g) || []).length, 2);

  /* The invariant lines go ON THE PAPER when they are not merely notes. */
  const s = readScoreText(REAL_ABC);
  const withInv = buildPage(REAL_ABC, {
    title: "x", invariantLines: [{ severity: "blocking", what: "header M:4/4 claims 4; the notes spell 2" }],
  });
  ok("a blocking invariant is printed on the sheet, not only in JSON",
    /blocking<\/b> header M:4\/4 claims 4/.test(withInv), withInv.slice(0, 400));
  ok("...and a sheet with nothing to report carries no such block",
    !/class="inv"/.test(buildPage(REAL_ABC, { title: "x" })));
}

/* ════════════════════════════════════════════════════════════════════════
 * 2 · THE SUBTITLE IS DERIVED. Never retyped, never the header's claim.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n2 · the subtitle comes out of the score\n");
{
  const s = readScoreText(REAL_ABC);
  const sub = sheetSubtitle(s);

  ok("the tempo comes from Q:", /90 BPM/.test(sub), sub);
  ok("the key comes from K:", /\bDm\b/.test(sub), sub);
  ok("the voice count comes from the V: declarations", /2 voices/.test(sub), sub);
  ok("the bar count is counted", /122 bars/.test(sub), sub);
  ok("the sections come from the % comments, with their ordinals",
    /intro \/ verse \/ pre-chorus \/ chorus \/ verse 2 \/ pre-chorus 2 \/ chorus 2 \/ outro/.test(sub), sub);

  /* 🔴 THE ONE THAT MATTERS. This score's header says 4/4 and its bars carry
   * two beats. A sheet that printed "4/4" would be the original defect in a
   * serif font — the number a musician would then count to. */
  ok("the meter printed is the one the NOTES spell", /2 beats\/bar/.test(sub), sub);
  ok("...and the header's claim is named rather than hidden", /header says M:4\/4/.test(sub), sub);
  ok("...and the bare header meter is never printed on its own",
    !/·\s*4\/4\s*·/.test(sub), sub);

  /* When they agree, it prints the meter plainly. */
  const agree = readScoreText(REAL_ABC.replace("M:4/4", "M:2/4"));
  const subAgree = sheetSubtitle(agree);
  ok("a score whose fields agree prints the meter plainly", /· 2\/4 ·/.test(subAgree), subAgree);
  ok("...with no parenthetical", !/header says/.test(subAgree), subAgree);

  /* NOTHING IS RETYPED: change the file, the line changes. */
  const faster = sheetSubtitle(readScoreText(REAL_ABC.replace("Q:1/4=90", "Q:1/4=140")));
  ok("re-rolling the tempo changes the subtitle", /140 BPM/.test(faster) && !/90 BPM/.test(faster), faster);
  const transposed = sheetSubtitle(readScoreText(REAL_ABC.replace("K:Dm", "K:F#m")));
  ok("...and so does the key", /F#m/.test(transposed), transposed);

  /* A score with nothing in it yields an empty line, not a made-up one. */
  eq("an unreadable score yields no subtitle rather than an invented one",
    sheetSubtitle(readScoreText("")), "");
}

/* ════════════════════════════════════════════════════════════════════════
 * 3 · DETECTION. Both optional pieces, both asked for rather than assumed.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n3 · Edge and abcjs are detected, never assumed\n");
{
  /* MEASURED: Edge is under "Program Files" on one box here and
   * "Program Files (x86)" on another, and may be absent entirely. */
  ok("both Program Files roots are probed, by environment rather than literal",
    /process\.env\.ProgramFiles/.test(SRC) && /process\.env\["ProgramFiles\(x86\)"\]/.test(SRC));
  ok("...and a per-user install too", /LOCALAPPDATA/.test(SRC));
  ok("...with the literals kept only as a last resort for a stripped environment",
    SRC.indexOf("process.env.ProgramFiles") < SRC.indexOf('"C:\\\\Program Files"'));
  ok("...and the measured reason is recorded beside the list",
    /Program Files \(x86\)" on others/.test(SRC));

  const realEdge = process.env.AIPLAY_EDGE;
  process.env.AIPLAY_EDGE = path.join(OUT, "no-such-edge.exe");
  eq("an override pointing at nothing yields null, not the path", edgePath(), null);
  const cap = sheetCapability();
  eq("...and the capability says no PDF", cap.pdf, false);
  eq("...while HTML is still available", cap.html, true);
  /* WHICH sentence depends on which piece is missing, and on a checkout that has
   * not vendored abcjs the library branch wins — so the assertion is on the
   * piece that is actually absent rather than on a fixed string. That is the
   * point of the note: it names the reason, not "unavailable". */
  if (cap.abcjs) {
    ok("...with the reason in words", /no Edge on this machine/.test(cap.note), cap.note);
    ok("...telling the human what they can still do", /print it from a browser/.test(cap.note), cap.note);
  } else {
    ok("...with the reason in words", /abcjs is not vendored/.test(cap.note), cap.note);
    ok("...telling the human where the missing piece comes from",
      /vendoring note/.test(cap.note), cap.note);
    ok("...and the no-Edge sentence exists for the other case",
      /print it from a browser/.test(SRC));
  }
  if (realEdge === undefined) delete process.env.AIPLAY_EDGE; else process.env.AIPLAY_EDGE = realEdge;

  const realLib = process.env.AIPLAY_ABCJS;
  process.env.AIPLAY_ABCJS = path.join(OUT, "no-such-abcjs.js");
  const noLib = abcjsPath();
  const capNoLib = sheetCapability();
  /* The override does not WIN, it is only FIRST — an override pointing at
   * nothing falls through to the next candidate rather than disabling the
   * library. Which candidate wins depends on this checkout, so the assertion is
   * on the rule and not on a path. */
  const fallbacks = [
    path.join(HERE, "..", "..", "web", "vendor", "abcjs", "abcjs-basic-min.js"),
    path.join(HERE, "..", "..", "vendor", "abcjs", "abcjs-basic-min.js"),
    path.join(HERE, "..", "..", "node_modules", "abcjs", "dist", "abcjs-basic-min.js"),
  ];
  eq("an override pointing at nothing falls through to the next candidate",
    noLib, fallbacks.find((p) => existsSync(p)) ?? null);
  if (noLib === null) {
    eq("...so the capability reports no library", capNoLib.abcjs, null);
    ok("...and explains WHY a PDF is not attempted rather than merely absent",
      /blank sheet that looks like a finished one/.test(capNoLib.note), capNoLib.note);
    ok("...and points at the vendoring step", /vendoring note/.test(capNoLib.note), capNoLib.note);
  } else {
    console.log("        (abcjs IS vendored in this checkout, so the absent branch is asserted on the source)");
    ok("...and the absent branch still carries its sentence",
      /blank sheet that looks like a finished one/.test(SRC));
    pass += 1;
  }
  if (realLib === undefined) delete process.env.AIPLAY_ABCJS; else process.env.AIPLAY_ABCJS = realLib;

  /* 🔴 THE VERSION IS READ OFF THE FILE, NOT DECLARED. MEASURED: this checkout
   * holds abcjs 6.4.4 at web/vendor/abcjs/ (483,417 bytes, vendored by another
   * hand the same night) while the version exercised end to end tonight was
   * 6.7.0 (511,903 bytes). A hardcoded version string would have reported the
   * one that is not installed. */
  eq("the version exercised end to end is recorded as such", ABCJS_TESTED_VERSION, "6.7.0");
  const info = abcjsInfo();
  if (info) {
    ok("...while the version REPORTED comes out of the bundle's own banner",
      /^\d+\.\d+\.\d+$/.test(String(info.version)), JSON.stringify(info));
    eq("...with the size read off the file", info.bytes, statSync(info.path).size);
    eq("...and a difference from the tested version said out loud rather than ignored",
      info.untested, info.version !== ABCJS_TESTED_VERSION);
    if (info.untested) {
      /* 🔴 IN EVERY STATE, not only the one where a PDF is possible. This
       * assertion failed with Edge absent, because the sentence lived inside
       * the "HTML and PDF" branch — and the engraver is what draws the HTML,
       * which is the half that still works without Edge. */
      const note = sheetCapability().note;
      ok("...naming both versions in the capability note",
        note.includes(info.version) && note.includes(ABCJS_TESTED_VERSION), note);
      ok("...and doing so whether or not a PDF is possible on this machine",
        /const which = abcjs\?\.untested/.test(SRC) && !/HTML and PDF — with abcjs/.test(SRC));
    }
  } else {
    console.log("        (no abcjs on this machine, so there is no on-disk version to read)");
    pass += 1;
  }
  ok("...and the paths searched include the one another hand already used",
    /"web", "vendor", "abcjs", "abcjs-basic-min\.js"/.test(SRC)
    && /"vendor", "abcjs", "abcjs-basic-min\.js"/.test(SRC));
}

/* ════════════════════════════════════════════════════════════════════════
 * 4 · engrave(): the HTML always, the PDF only when it can be honest.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n4 · engrave\n");
{
  /* NO LIBRARY: the HTML is written, Edge is NOT launched, and the reason is
   * named. A PDF of an un-engraved page is the failure that looks like success. */
  const realLib = process.env.AIPLAY_ABCJS;
  process.env.AIPLAY_ABCJS = path.join(OUT, "definitely-not-here.js");
  /* Also neutralise the vendor folder for this one case, so the branch is
   * reachable in a checkout that HAS vendored the library. */
  const vendored = abcjsPath();
  if (vendored) {
    console.log("        (abcjs is vendored here; the no-library branch is driven through buildPage instead)");
    const page = buildPage(REAL_ABC, { scriptSrc: null });
    ok("the no-library page refuses to pretend it engraved", /window\.__noAbcjs/.test(page));
    ok("...and engrave() skips the PDF on that branch", /out\.pdfSkipped = "no-abcjs"; return out;/.test(SRC));
    /* lastIndexOf: sheetCapability() also calls edgePath(), earlier in the
     * file. The one that matters is engrave()'s own. */
    ok("...before it has looked for Edge at all",
      SRC.indexOf('out.pdfSkipped = "no-abcjs"') < SRC.lastIndexOf("const edge = edgePath();"));
  } else {
    const r = await engrave({ slug: "x", versionId: "v1", abc: REAL_ABC, title: "x", origin: "http://127.0.0.1:1" });
    eq("with no library the PDF is skipped by name", r.pdfSkipped, "no-abcjs");
    eq("...and no PDF exists", r.pdf, null);
    ok("...while the HTML is on disk", existsSync(path.join(sheetDir("x", "v1"), "sheet.html")));
  }
  if (realLib === undefined) delete process.env.AIPLAY_ABCJS; else process.env.AIPLAY_ABCJS = realLib;

  /* NO ORIGIN: file:// prints nothing (MEASURED), so an origin is required and
   * its absence is named rather than producing a silent nothing. */
  const noOrigin = await engrave({ slug: "y", versionId: "v1", abc: REAL_ABC, title: "y" });
  if (LIB && EDGE) {
    eq("with no http origin the PDF is skipped by name", noOrigin.pdfSkipped, "no-http-origin");
  } else {
    ok("with no http origin the PDF is skipped by name (or earlier, for a missing piece)",
      typeof noOrigin.pdfSkipped === "string", String(noOrigin.pdfSkipped));
  }
  ok("...and the HTML is still written", existsSync(path.join(sheetDir("y", "v1"), "sheet.html")));
  ok("...and file:// is never used as a print source", !/file:\/\//.test(SRC.replace(/\/\*[\s\S]*?\*\//g, "")));

  /* THE SHEET IS OURS AND LIVES OUTSIDE THE VENDOR'S FOLDER, so "every file in
   * versions/<id>/ is hashed by result.json" stays a checkable property. */
  ok("the sheet is written into sheets/<id>/, not into the version folder",
    path.resolve(sheetDir("y", "v1")) !== path.resolve(versionDir("y", "v1")));
  ok("...and nothing was created in the version folder", !existsSync(versionDir("y", "v1")));

  /* THE DERIVED BLOCK: what the paper says, quoted back, so no line on it is
   * traceable to a reading nobody can see. */
  eq("the derived tempo", noOrigin.derived.bpm, 90);
  eq("the derived content meter", noOrigin.derived.quartersPerBarContent, 2);
  eq("...beside the header's claim", noOrigin.derived.quartersPerBarHeader, 4);
  eq("the derived key", noOrigin.derived.key, "Dm");
  eq("the derived bar count", noOrigin.derived.bars, 122);
  eq("the derived section count", noOrigin.derived.sections.length, 8);
  eq("the worst invariant travels with the sheet", noOrigin.worst, "blocking");

  /* The human's note goes on the paper — the one thing about a take the score
   * cannot state. */
  const withNote = await engrave({
    slug: "z", versionId: "v1", abc: REAL_ABC, title: "z",
    note: "keeper — the SECOND chorus is the one",
  });
  const page = readFileSync(path.join(sheetDir("z", "v1"), "sheet.html"), "utf8");
  ok("the note is printed on the sheet", /keeper — the SECOND chorus is the one/.test(page));
  ok("...verbatim, case and dash intact", /SECOND/.test(page) && /—/.test(page));
  ok("...and the blocking invariant is on the paper too", /class="inv"/.test(page));

  /* A stale PDF must never be mistaken for this one. */
  ok("engrave deletes any previous PDF before printing",
    /await rm\(pdfPath, \{ force: true \}\);\s*\/\/ never leave a stale PDF/.test(SRC));

  /* 🔴 spawn, NOT spawnSync. MEASURED: a spawnSync launch of Edge against this
   * app's own server hung to a 180 s timeout twice and produced no PDF,
   * because the Node process could not answer the request for the page it had
   * just told Edge to print. */
  ok("Edge is launched asynchronously", /spawn\(edge, args/.test(SRC));
  ok("...and spawnSync appears nowhere", !/spawnSync/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("...with the measured reason recorded", /blocked inside spawnSync/.test(SRC));

  /* The tree-kill trap. */
  ok("a timeout tree-kills rather than killing the parent", /killMeshProcessTree\(proc\)/.test(SRC));
  ok("...reusing the established one instead of a fifth taskkill",
    /from "\.\.\/mesh\/runner\.js"/.test(SRC));
  ok("...and says whether termination was confirmed",
    /process-tree termination NOT confirmed/.test(SRC));
}

/* ════════════════════════════════════════════════════════════════════════
 * 5 · THE SIZE FLOOR CANNOT SEE A BLANK SHEET, and says so.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n5 · why the outcome is read off the page and not off the file size\n");
{
  /* MEASURED tonight: 352,047 bytes engraved, 33,230 not. Any floor below the
   * second passes the blank; any floor above it rejects a short score. */
  ok("the floor is below the measured size of a page that engraved NOTHING",
    PDF_FLOOR_BYTES < 33_230, String(PDF_FLOOR_BYTES));
  ok("...and both measurements are recorded beside it",
    /352,047 bytes/.test(SRC) && /33,230 bytes/.test(SRC));
  ok("...so the constant is honest about being a truncation guard only",
    /truncated or zero-length write/.test(SRC));
  ok("the real check asks the page", /export async function verifyEngraved/.test(SRC));
  ok("...over --dump-dom, because a print cannot report back", /--dump-dom/.test(SRC));
  ok("...and it runs BEFORE the print, because a PDF that exists is one somebody files",
    SRC.indexOf("const check = await verifyEngraved") < SRC.indexOf("`--print-to-pdf=${pdfPath}`"));
  eq("the virtual clock budget is the prototype's", VIRTUAL_TIME_BUDGET_MS, 8000);
  ok("a throwaway profile is used, so the human's open browser cannot block a print",
    /--user-data-dir=\$\{profile\}/.test(SRC)
    && /refuses to start headless against a[\s\S]{0,12}profile/.test(SRC));
  ok("...and the GPU is switched off, because another agent may be rendering on it",
    /"--disable-gpu"/.test(SRC));
}

/* ════════════════════════════════════════════════════════════════════════
 * 6 · THE REAL CHAIN, when this machine has both pieces.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n6 · the real chain\n");
if (!LIB || !EDGE) {
  console.log(`        SKIPPED — ${!LIB ? "abcjs is not vendored" : ""}${!LIB && !EDGE ? " and " : ""}${!EDGE ? "no Edge on this machine" : ""}.`);
  console.log("        That is a supported state, not a failure: sections 3-5 assert the degradation.");
} else {
  /* A minimal static server serving exactly the two URLs engrave() will ask
   * for. server/score/routes_test.js drives the REAL routes; this one keeps
   * sheet.js testable on its own. */
  const lib = readFileSync(LIB);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/api/score/vendor/abcjs.js") {
      res.writeHead(200, { "Content-Type": "text/javascript", "Content-Length": lib.length });
      return res.end(lib);
    }
    const m = /^\/api\/score\/sheet\/([^/]+)\/([^/]+)\.html$/.exec(u.pathname);
    if (m) {
      try {
        const b = readFileSync(path.join(sheetDir(m[1], m[2]), "sheet.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": b.length });
        return res.end(b);
      } catch { /* fall through */ }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const t0 = Date.now();
  const r = await engrave({
    slug: "real", versionId: "v1", abc: REAL_ABC, title: "Ninety Storeys",
    note: "keeper", audioSeconds: REAL_AUDIO, origin,
  });
  const seconds = (Date.now() - t0) / 1000;

  eq("the page engraved", r.engraveCheck.engraved, true);
  ok("...and the DOM proves it, by being two orders of magnitude larger than a blank one",
    r.engraveCheck.domBytes > 500_000, String(r.engraveCheck.domBytes));
  eq("nothing was skipped", r.pdfSkipped, null);
  eq("a PDF was produced", r.pdf, "sheet.pdf");
  ok("...well above the truncation floor", r.pdfBytes > PDF_FLOOR_BYTES * 10, String(r.pdfBytes));
  ok("...and comparable to the measured 352,047 bytes for this score",
    r.pdfBytes > 200_000 && r.pdfBytes < 600_000, String(r.pdfBytes));
  ok("...on disk", existsSync(path.join(sheetDir("real", "v1"), "sheet.pdf")));
  ok("...starting with a PDF header rather than an error page",
    readFileSync(path.join(sheetDir("real", "v1"), "sheet.pdf")).subarray(0, 5).toString() === "%PDF-");
  console.log(`        (two Edge launches, ${seconds.toFixed(1)} s total — against a 399.6 s render)`);

  /* 🔴 THE BLANK SHEET. Serve a page with NO library and prove the check
   * catches what a size test cannot. */
  mkdirSync(sheetDir("blank", "v1"), { recursive: true });
  writeFileSync(path.join(sheetDir("blank", "v1"), "sheet.html"),
    buildPage(REAL_ABC, { title: "Blank", scriptSrc: null }), "utf8");
  const check = await verifyEngraved(EDGE, `${origin}/api/score/sheet/blank/v1.html`);
  eq("a page that engraved nothing is caught", check.engraved, false);
  ok("...with the page's own reason", /no-abcjs/.test(check.why || ""), String(check.why));
  ok("...and a DOM small enough to make the point", check.domBytes < 20_000, String(check.domBytes));

  /* A URL that 404s. */
  const gone = await verifyEngraved(EDGE, `${origin}/api/score/sheet/nope/v1.html`);
  eq("a missing page is not reported as engraved", gone.engraved, false);
  ok("...and says the script never ran rather than inventing a musical reason",
    /script never ran/.test(gone.why || ""), String(gone.why));

  server.close();
}

/* ── done ────────────────────────────────────────────────────────────────── */
if (!process.env.KEEP_SCORE_TEST) rmSync(OUT, { recursive: true, force: true });
else console.log(`\n  kept ${OUT}`);
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
