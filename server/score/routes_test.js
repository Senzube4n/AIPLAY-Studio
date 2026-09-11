/**
 * THE SCORE ROUTES — the guard suite. A real http server on an ephemeral port,
 * the real handler, real requests. No GPU. Edge is launched only if Edge is on
 * this machine, and the suite says so when it is not.
 *
 * What each section is guarding:
 *
 *  · 🔴 `by` COMES FROM THE REQUEST AND NEVER FROM THE BODY. Driven over the
 *    wire in all four shapes, including the masquerade: a header that claims
 *    "user" lands as "system" (server/provenance.js:192-199), and a `by` in the
 *    JSON body is ignored. This is the property that stops an agent writing a
 *    human's name into a credit line, and it is checked as a property of the
 *    SOURCE as well, because a second read of `b.by` would pass the behavioural
 *    tests until somebody added one.
 *
 *  · 🔴 A RENDER IS MATCHED BY THE ID THE ROUTE RETURNED. `adopt` hands back an
 *    id and nothing here scans a folder. DIRECTING.md:1220-1243 measured the
 *    alternative: "sixteen shots completed in four seconds and a whole film
 *    stamped that had never been rendered, and it looked like success".
 *
 *  · 🔴 THE SHEET PAGE IS SERVED FROM DISK, NOT REBUILT. Edge prints from an
 *    http:// URL and not from file:// (TESTED — file:// produced no PDF, no
 *    error, exit 0), so this server is the origin. The bytes it serves must be
 *    the bytes on disk, or the PDF is a print of a page that no longer exists.
 *
 *  · THE WHOLE PREFIX, AND `handled`. An unrecognised path under /api/score
 *    returns false so the app's own 404 still answers — the bargain vfx, daw and
 *    welcome all make.
 *
 * Runs standalone (`node server/score/routes_test.js`). Writes only into a temp
 * directory, which it removes.
 */
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The output dir MUST be decided before config.js is first imported, and static
 * imports hoist — so every import below is dynamic. mv/plan_test.js:40-43. */
const OUT = path.join(os.tmpdir(), `score-routes-test-${process.pid}-${Date.now().toString(36)}`);
process.env.AIPLAY_OUTPUT = OUT;
process.env.AIPLAY_APPDATA = path.join(OUT, "appdata");
mkdirSync(OUT, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "fixtures");
/** The dispatch as text, for the checks that pin a property of the source. */
const SRC = readFileSync(path.join(HERE, "routes.js"), "utf8");

const REAL_ABC = readFileSync(path.join(FIX, "yue2_score.abc"), "utf8");
const REAL_RECEIPT = JSON.parse(readFileSync(path.join(FIX, "yue2_result.json"), "utf8"));

const { config } = await import("../config.js");
const prov = await import("../provenance.js");
const { createScoreRoutes } = await import("./routes.js");
const { sheetDir, versionDir, scoreDir } = await import("./store.js");
const { edgePath, abcjsPath } = await import("./sheet.js");

let pass = 0;
const failures = [];
function ok(what, cond, detail = "") {
  if (cond) { pass += 1; console.log(`  ok    ${what}`); return true; }
  failures.push(what);
  console.log(`  FAIL  ${what}${detail ? `\n          ${detail}` : ""}`);
  return false;
}
const eq = (what, a, b) => ok(`${what} = ${JSON.stringify(b)}`, a === b, `got ${JSON.stringify(a)}`);

/* ── the server: index.js's own two helpers, verbatim ─────────────────────── */

/** server/index.js:1307-1311. */
function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}
/** server/index.js:1313-1317. */
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const routes = createScoreRoutes({ json, readBody, config, provenance: prov });

/** Mounted exactly the way index.js hangs the score door. */
let fellThrough = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/api/score" || p.startsWith("/api/score/")) {
      if (await routes(req, res, url)) return;
    }
  } catch (err) {
    return json(res, 500, { error: `THREW: ${err.message}` });
  }
  fellThrough += 1;
  json(res, 404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const post = async (body, actor = null) => {
  const r = await fetch(`${BASE}/api/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(actor === null ? {} : { "x-aiplay-actor": actor }) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = (p) => fetch(BASE + p);

/* ── a self-consistent vendor run folder ─────────────────────────────────── */

let runSeq = 0;
/**
 * The identity defaults to a hash of the SCORE, so two runs with different
 * content get different identities the way the vendor's own hash over
 * request+config+weights would. Pass it explicitly to model a repeat.
 */
function makeRun({ abc = REAL_ABC, identity = null } = {}) {
  identity ??= createHash("sha256").update(abc).digest("hex");
  const dir = path.join(OUT, `run-${runSeq += 1}`);
  mkdirSync(dir, { recursive: true });
  const contents = {
    "score.abc": Buffer.from(abc, "utf8"),
    "audio.flac": Buffer.from(`fLaC-${runSeq}`, "utf8"),
    "request.json": Buffer.from('{"style":"test"}', "utf8"),
  };
  const artifacts = {};
  for (const [name, buf] of Object.entries(contents)) {
    writeFileSync(path.join(dir, name), buf);
    artifacts[name] = { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  }
  writeFileSync(path.join(dir, "result.json"), JSON.stringify({
    status: "complete", identity, sample_rate: 48000,
    audio_seconds: REAL_RECEIPT.audio_seconds,
    truncated: { abc: false, semantic: false },
    weights: REAL_RECEIPT.weights, timing: REAL_RECEIPT.timing, artifacts,
  }));
  return dir;
}

/* ════════════════════════════════════════════════════════════════════════
 * 1 · DISPATCH. The whole prefix, and `handled`.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n1 · dispatch\n");
{
  const list = await get("/api/score");
  eq("GET /api/score answers", list.status, 200);
  const listed = await list.json();
  ok("...with the same list the `list` action returns", Array.isArray(listed.scores));
  ok("...and what this machine can engrave", typeof listed.capability?.pdf === "boolean");

  const before = fellThrough;
  const unknown = await get("/api/score/nothing/here");
  eq("an unrecognised path under the prefix falls through to the app's 404", unknown.status, 404);
  eq("...by answering `handled: false` rather than writing its own 404", fellThrough, before + 1);

  const bad = await post({ action: "fly" });
  eq("an unknown action is a 400", bad.status, 400);
  /* ⚠ WAS /list, create, read, adopt, note, author/ — a restatement of the
   * list's ORDER, which broke the moment `draft` was inserted between adopt and
   * note even though the message was entirely correct. docs/ENGINE_TRAPS.md has
   * a section on precisely this: a document that restates a list drifts from
   * it, and a test is a document. The two assertions below already check both
   * directions of set equality against the switch, derived from the source
   * rather than typed, so this one's only remaining job is "the refusal names
   * actions at all". Stated that way, a correct change cannot break it. */
  ok("...listing the ones that exist", /Try: (?:[a-z_]+, ){5,}/.test(bad.body.error),
    bad.body.error);

  /* THE VOCABULARY CANNOT DRIFT: every action the error advertises is a real
   * case in the switch, and every case is advertised. */
  const advertised = bad.body.error.replace(/^Unknown action\. Try: /, "").replace(/\.$/, "")
    .split(",").map((s) => s.trim());
  const implemented = [...SRC.matchAll(/^\s+case "([a-z_]+)":/gm)].map((m) => m[1]);
  ok("every advertised action is implemented",
    advertised.every((a) => implemented.includes(a)),
    advertised.filter((a) => !implemented.includes(a)).join(", "));
  ok("...and every implemented action is advertised",
    implemented.every((a) => advertised.includes(a)),
    implemented.filter((a) => !advertised.includes(a)).join(", "));

  const noSlug = await post({ action: "read" });
  eq("an action that needs a slug says which field is missing", noSlug.status, 400);
  ok("...by name", /Pass `slug`/.test(noSlug.body.error), noSlug.body.error);

  const noSuch = await post({ action: "read", slug: "not-a-song" });
  ok("...and a missing score names the slug", /No such score: not-a-song/.test(noSuch.body.error));

  const malformed = await fetch(`${BASE}/api/score`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  });
  eq("an unreadable body is a 400, not a 500", malformed.status, 400);
  ok("...saying so", /Unreadable body/.test((await malformed.json()).error));
}

/* ════════════════════════════════════════════════════════════════════════
 * 2 · `by` FROM THE REQUEST, `author` FROM THE BODY.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n2 · the actor, and the credit\n");
let slug, v1, v2;
{
  const created = await post({ action: "create", title: "Ninety Storeys", author: "Ada" });
  eq("create answers 201", created.status, 201);
  slug = created.body.slug;
  eq("...with the slug", slug, "ninety-storeys");
  eq("...and the credit from the body", created.body.score.author, "Ada");

  /* No header: a browser request, and the actor is the human at it. */
  const a1 = await post({ action: "adopt", slug, dir: makeRun(), note: "keeper" });
  eq("adopt answers 201", a1.status, 201);
  v1 = a1.body.version;
  eq("no actor header means the human", a1.body.by, "user");

  /* An agent names itself. */
  const a2 = await post({
    action: "adopt", slug, dir: makeRun({ abc: REAL_ABC.replace("Q:1/4=90", "Q:1/4=96") }),
    parent: v1, note: "faster", label: "96bpm",
  }, "agent:overnight");
  v2 = a2.body.version;
  eq("an agent header is recorded as the agent", a2.body.by, "agent:overnight");

  /* 🔴 THE MASQUERADE GUARD. provenance.js:165-174 exists to make fabricating
   * human action impossible, and the route inherits it for free by asking that
   * module rather than reading the header itself. */
  /* Each of these is a genuinely different render — a different tempo, so a
   * different identity — rather than a dedupe:"allow" repeat, so the duplicate
   * check in section 3 has exactly one version to name. */
  const tempo = (n) => makeRun({ abc: REAL_ABC.replace("Q:1/4=90", `Q:1/4=${n}`) });
  const a3 = await post({ action: "adopt", slug, dir: tempo(100) }, "user");
  eq("a header CLAIMING to be the user is recorded as the system", a3.body.by, "system");
  const a4 = await post({ action: "adopt", slug, dir: tempo(101) }, "script:overnight");
  eq("a script names itself and stays a script", a4.body.by, "script:overnight");
  const a5 = await post({ action: "adopt", slug, dir: tempo(102) }, "nonsense!!");
  eq("an unrecognised actor is the system, never the user", a5.body.by, "system");

  /* 🔴 A `by` IN THE BODY IS IGNORED. Both over the wire and in the source. */
  const spoof = await post({ action: "adopt", slug, dir: tempo(103), by: "user" }, "agent:overnight");
  eq("a `by` in the JSON body does not become the actor", spoof.body.by, "agent:overnight");
  ok("...and the dispatch never reads one",
    !/\bb\.by\b/.test(SRC), "routes.js reads b.by somewhere");
  ok("...because `by` has exactly one source in this file",
    (SRC.match(/const by = actorOf\(req\)/g) || []).length === 1);
  ok("...which is the provenance module's reader",
    /provenance\.actorFrom\(req\)/.test(SRC) || /prov(enance)?\s*\?\s*provenance\.actorFrom/.test(SRC));

  /* The credit, which IS the body's. */
  const cr = await post({ action: "author", slug, version: v1, author: "user" }, "agent:overnight");
  eq("setting the credit to the literal string \"user\" is allowed", cr.body.author, "user");
  const rd = await post({ action: "read", slug, version: v1, scores: false });
  eq("...and does not touch `by`", rd.body.versions[0].by, "user");
  ok("...and the answer says which field is which",
    /`by` is the actor.*not settable from the body/s.test(cr.body.note), cr.body.note);
  await post({ action: "author", slug, version: v1, author: "Ada" });
}

/* ════════════════════════════════════════════════════════════════════════
 * 3 · ADOPT: the id is the handle; the folder is never diffed.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n3 · adopt\n");
{
  const dup = await post({ action: "adopt", slug, dir: makeRun() });
  eq("adopting the same identity again is refused", dup.status, 400);
  ok("...naming the version that already answers to it",
    new RegExp(`Version ${v1} of "${slug}" already answers`).test(dup.body.error), dup.body.error);

  const noDir = await post({ action: "adopt", slug });
  ok("adopt without a directory says what it needs and why",
    /needs `dir`/.test(noDir.body.error) && /matched by the\s+id this call returns/s.test(noDir.body.error),
    noDir.body.error);
  ok("...and explicitly disclaims scanning for folders",
    /Nothing here scans for new folders/.test(noDir.body.error), noDir.body.error);

  /* 🔴 A PROPERTY OF THE SOURCE. A second matching path would pass every
   * behavioural test in this file. DIRECTING.md:1220-1243. */
  ok("the dispatch never lists a directory to find a render",
    !/readdir/.test(SRC), "routes.js calls readdir");

  /* A folder that disagrees with its own receipt. */
  const partial = path.join(OUT, "partial");
  mkdirSync(partial, { recursive: true });
  writeFileSync(path.join(partial, "score.abc"), REAL_ABC);
  writeFileSync(path.join(partial, "result.json"), JSON.stringify(REAL_RECEIPT));
  const refused = await post({ action: "adopt", slug, dir: partial });
  eq("a folder that does not match its receipt is refused", refused.status, 400);
  ok("...by name", /missing: .*audio\.flac/.test(refused.body.error), refused.body.error);

  /* The adopt response carries what a caller needs and nothing derivable. */
  const fresh = await post({ action: "read", slug, version: v2 });
  const row = fresh.body.versions[0];
  eq("the version carries the parent pointer", row.parent, v1);
  eq("...and its children resolve the other way", row.children.length, 0);
  eq("...and its root", row.root, v1);
  ok("...and the change map is computed from hashes", row.changed.basis.startsWith("sha256"));
  eq("...detecting the changed score", row.changed.scoreChanged, true);
  eq("...and the unchanged weights", row.changed.weightsSame, true);
  ok("the score itself is read on the way out", row.score.bars === 122, JSON.stringify(row.score?.bars));
  eq("...with the meter disagreement first among the invariants",
    row.score.invariants[0].id, "meter_header_vs_content");
  eq("...and the section map already scaled to the render's own audio",
    row.score.map.audioSeconds, REAL_RECEIPT.audio_seconds);

  ok("`read` can skip the score text for a cheap list", (await post({
    action: "read", slug, scores: false,
  })).body.versions.every((r) => r.score === undefined));

  /* HOW MANY SONGS ARE IN HERE, really. */
  const all = await post({ action: "read", slug });
  ok("the read reports the roots, not just the version count",
    Array.isArray(all.body.roots) && all.body.roots.length >= 1, JSON.stringify(all.body.roots));
}

/* ════════════════════════════════════════════════════════════════════════
 * 4 · THE NOTE, VERBATIM, OVER THE WIRE.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n4 · the note\n");
{
  const verbatim = "  keeper — the SECOND chorus is the one.\n\n\tthe outro drags:\ttry 6 bars.  ";
  const r = await post({ action: "note", slug, version: v1, note: verbatim });
  eq("the note survives a JSON round trip byte for byte", r.body.note, verbatim);
  eq("...and the route says it was recorded", r.body.note_recorded, true);
  eq("...and that it is verbatim", r.body.verbatim, true);
  eq("...and who wrote it", r.body.by, "user");
  eq("...and what the cap is, so a caller need not guess", r.body.cap, 4000);
  eq("...and that it did not bite", r.body.truncated, false);

  const long = await post({ action: "note", slug, version: v1, note: "y".repeat(5000) });
  eq("a note over the cap is cut and says so", long.body.truncated, true);
  eq("...to exactly the cap", long.body.note.length, 4000);

  /* The append refusal, which is a repair: slicing the concatenation used to
   * discard the NEW text and report success. */
  const cannot = await post({ action: "note", slug, version: v1, note: "and boxy", append: true });
  eq("appending to a full note is refused rather than silently dropped", cannot.status, 400);
  ok("...saying which half would have been lost",
    /discard the new text rather than the old/.test(cannot.body.error), cannot.body.error);

  await post({ action: "note", slug, version: v1, note: verbatim });
  const onVersion = await post({ action: "read", slug, version: v1, scores: false });
  eq("the note is on the version, beside `by` and `author`", onVersion.body.versions[0].note, verbatim);
  ok("...and the read says it is verbatim there too", onVersion.body.versions[0].noteVerbatim === true);

  const gone = await post({ action: "note", slug, version: "nope", note: "x" });
  ok("a note on a version that is not there lists the ones that are",
    new RegExp(`It has: .*${v1}`).test(gone.body.error), gone.body.error);
}

/* ════════════════════════════════════════════════════════════════════════
 * 5 · MAP, INVARIANTS, LINEAGE — all derived on read.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n5 · the derived views\n");
{
  const m = await post({ action: "map", slug, version: v1 });
  eq("the map declares its basis", m.body.map.basis, "content");
  eq("...and its granularity", m.body.map.granularity, "section");
  eq("...and where the audio duration came from", m.body.audioSecondsFrom, "the render's own receipt");
  eq("...with 8 sections", m.body.map.sections.length, 8);
  ok("...and the caveat attached to the numbers",
    /section granularity/i.test(m.body.map.caveat), m.body.map.caveat);
  ok("...and keys that carry the song and the version",
    m.body.map.sections[0].key.startsWith(`${slug}/${v1}/`), m.body.map.sections[0].key);

  const override = await post({ action: "map", slug, version: v1, audioSeconds: 200 });
  eq("a caller may supply a measured duration", override.body.map.audioSeconds, 200);
  eq("...and the route says the number is theirs", override.body.audioSecondsFrom, "the caller");
  ok("...and the scale moves with it",
    override.body.map.scale !== m.body.map.scale, String(override.body.map.scale));

  const inv = await post({ action: "invariants", slug, version: v1 });
  eq("the invariant report names the first row", inv.body.first, "meter_header_vs_content");
  eq("...and the worst severity", inv.body.worst, "blocking");
  ok("...with the measured numbers on the row itself",
    inv.body.invariants[0].measured.header === 4 && inv.body.invariants[0].measured.content === 2,
    JSON.stringify(inv.body.invariants[0].measured));

  const lin = await post({ action: "lineage", slug, version: v2 });
  eq("the lineage is oldest first", lin.body.lineage[0].id, v1);
  eq("...two long", lin.body.lineage.length, 2);
  ok("...with the change map on the second step", lin.body.lineage[1].changed !== null);
  ok("...and the basis stated rather than implied",
    /nothing here is declared/.test(lin.body.basis), lin.body.basis);

  /* NOTHING DERIVABLE IS STORED. The document on disk is grepped. */
  const raw = readFileSync(path.join(scoreDir(slug), "score.json"), "utf8");
  ok("the persisted document holds no change map", !/"changed"\s*:/.test(raw));
  ok("...no section map", !/"cutPoints"\s*:/.test(raw) && !/"sections"\s*:/.test(raw));
  ok("...and no invariant report", !/"invariants"\s*:/.test(raw));

  const cur = await post({ action: "current", slug, version: v1 });
  eq("current can be pointed at an older take", cur.body.current, v1);
}

/* ════════════════════════════════════════════════════════════════════════
 * 6 · THE FILE ROUTES.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n6 · serving files\n");
{
  const abc = await get(`/api/score/file/${slug}/${v1}/score.abc`);
  eq("an artifact is served", abc.status, 200);
  eq("...as text", abc.headers.get("content-type"), "text/plain; charset=utf-8");
  ok(`...byte for byte (${REAL_ABC.length} characters)`, (await abc.text()) === REAL_ABC);

  const flac = await get(`/api/score/file/${slug}/${v1}/audio.flac`);
  eq("audio gets an audio type", flac.headers.get("content-type"), "audio/flac");

  const missing = await get(`/api/score/file/${slug}/${v1}/nope.npy`);
  eq("a missing artifact is a 404", missing.status, 404);
  ok("...naming the file", /No such file: nope\.npy/.test((await missing.json()).error));

  for (const bad of [
    `/api/score/file/${slug}/${v1}/..%2F..%2Fscore.json`,
    `/api/score/file/..%2F..%2Fetc/${v1}/score.abc`,
    "/api/score/file/only-two/parts",
  ]) {
    const r = await get(bad);
    ok(`a traversing artifact path is refused: ${bad}`, r.status === 400 || r.status === 404, String(r.status));
  }

  const sheetMissing = await get(`/api/score/sheet/${slug}/${v1}.pdf`);
  eq("a sheet that was never engraved is a 404, not an empty PDF", sheetMissing.status, 404);
  const sheetBad = await get(`/api/score/sheet/${slug}/notaleaf`);
  eq("a sheet path with no extension is a 400", sheetBad.status, 400);

  const lib = await get("/api/score/vendor/abcjs.js");
  if (abcjsPath()) {
    eq("the vendored library is served", lib.status, 200);
    eq("...as javascript", lib.headers.get("content-type"), "text/javascript; charset=utf-8");
    eq("...immutably, because it is a pinned third-party bundle",
      lib.headers.get("cache-control"), "public, max-age=604800, immutable");
    /* The length is read off the file rather than pinned: MEASURED, this
     * checkout holds 6.4.4 at 483,417 bytes while 6.7.0 at 511,903 is the copy
     * exercised end to end tonight, and a pinned number would fail on whichever
     * machine has the other one. */
    eq("...at the size of the file on disk",
      Number(lib.headers.get("content-length")), statSync(abcjsPath()).size);
  } else {
    eq("with no vendored library the route 404s", lib.status, 404);
    const body = await lib.json();
    ok("...and says it is never fetched from a CDN", /never fetched from a CDN/.test(body.note), body.note);
    ok("...and points at the vendoring step", /vendoring note/.test(body.note), body.note);
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * 7 · THE SHEET, THROUGH THE ROUTES THAT MAKE THE PDF POSSIBLE.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n7 · the sheet\n");
{
  const r = await post({ action: "sheet", slug, version: v1, origin: BASE });
  eq("the sheet action answers 200", r.status, 200);
  eq("...with the HTML url", r.body.html, `/api/score/sheet/${slug}/${v1}.html`);
  ok("...and the subtitle derived from the score",
    /90 BPM/.test(r.body.sheet.subtitle) && /2 beats\/bar \(header says M:4\/4\)/.test(r.body.sheet.subtitle),
    r.body.sheet.subtitle);

  /* 🔴 SERVED FROM DISK, NOT REBUILT. If the GET rebuilt the page it could
   * differ from the one the PDF was printed from, and the two artifacts of one
   * version would disagree. */
  const served = await get(r.body.html);
  eq("the page is served", served.status, 200);
  const onWire = Buffer.from(await served.arrayBuffer());
  const onDisk = readFileSync(path.join(sheetDir(slug, v1), "sheet.html"));
  ok("...byte for byte as engrave() wrote it", onWire.equals(onDisk),
    `${onWire.length} on the wire, ${onDisk.length} on disk`);
  const text = onDisk.toString("utf8");
  ok("...pinning black ink on white paper", /#paper\s*\{[^}]*color:#000/.test(text));
  /* The library tag exists only when there is a library. Either way the page
   * names no external host — the offline promise holds in both states, and the
   * no-library page says what is missing instead of fetching one. */
  ok("...naming no external host, whichever state this machine is in", !/https?:\/\//.test(text));
  ok(abcjsPath()
    ? "...loading the library from this origin and no other"
    : "...and with no library, saying so on the page rather than reaching for a CDN",
    abcjsPath()
      ? /<script src="\/api\/score\/vendor\/abcjs\.js">/.test(text)
      : /window\.__noAbcjs = true/.test(text) && /only the notation is missing/.test(text));
  ok("...carrying the human's note", /keeper — the SECOND chorus/.test(text));
  ok("...and the blocking invariant", /class="inv"/.test(text));

  /* The sheet is OURS and lives outside the vendor's folder. */
  ok("nothing of ours was written into the version folder",
    !existsSync(path.join(versionDir(slug, v1), "sheet.html")));

  /* THE ORIGIN. Default is this server's own port, which is the only http
   * origin this repo has. */
  ok("the default origin is this app's own UI port",
    /http:\/\/127\.0\.0\.1:\$\{cfg\.uiPort\}/.test(SRC));

  if (abcjsPath() && edgePath()) {
    eq("the page engraved before anything was printed", r.body.sheet.engraveCheck.engraved, true);
    eq("a PDF was produced", r.body.sheet.pdf, "sheet.pdf");
    eq("...and nothing was skipped", r.body.pdfSkipped, null);
    eq("...with a url beside the HTML one", r.body.pdf, `/api/score/sheet/${slug}/${v1}.pdf`);
    const pdf = await get(r.body.pdf);
    eq("...which serves it", pdf.status, 200);
    eq("...as a PDF", pdf.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    eq("...starting with a PDF header", bytes.subarray(0, 5).toString(), "%PDF-");
    ok("...at a size comparable to the measured 352,047 for this score",
      bytes.length > 200_000 && bytes.length < 600_000, String(bytes.length));
    console.log(`        (Edge printed ${bytes.length} bytes from ${BASE})`);
  } else {
    console.log(`        SKIPPED the PDF half — ${!abcjsPath() ? "abcjs is not vendored" : "no Edge on this machine"}.`);
    ok("...and the reason is reported rather than the render failing",
      typeof r.body.pdfSkipped === "string" && r.body.pdf === null, JSON.stringify(r.body.pdfSkipped));
    ok("...with the capability saying the same thing",
      r.body.capability.pdf === false, JSON.stringify(r.body.capability));
  }

  /* A sheet is attached to the version, so the picker can count it. */
  const after = await post({ action: "read", slug, version: v1, scores: false });
  ok("the sheet is recorded on the version", after.body.versions[0].sheet?.html === "sheet.html");
}

/* ════════════════════════════════════════════════════════════════════════
 * 8 · DELETE, and the mount instructions the integrator follows.
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n8 · delete, and the seam\n");
{
  await post({ action: "create", title: "Throwaway" });
  await post({ action: "adopt", slug: "throwaway", dir: makeRun() });
  const del = await post({ action: "delete", slug: "throwaway" });
  eq("delete answers with what it removed", del.body.deleted, "throwaway");
  eq("...and how many versions went with it", del.body.versions, 1);
  ok("...and the folder is gone", !existsSync(scoreDir("throwaway")));

  /* The seam is three lines in a file this agent may not touch, so the header
   * carries them and sheet.js's note carries the reasoning. If they drift apart the
   * integrator applies the wrong one. */
  ok("the header states the import line", /import \{ createScoreRoutes \} from "\.\/score\/routes\.js";/.test(SRC));
  /* The header draws a box, so the line is wrapped across two of its rows —
   * matched on the pieces rather than as one string. */
  ok("...the construction line", /const scoreRoutes = createScoreRoutes\(\{/.test(SRC)
    && /json, readBody, config, provenance: prov \}\);/.test(SRC));
  ok("...and the mount line", /p === "\/api\/score" \|\| p\.startsWith\("\/api\/score\/"\)/.test(SRC));
  ok("...and points at the handoff file for the applied diff",
    /vendoring note at the top of server\/score\/sheet\.js/.test(SRC));

  eq("nothing threw over the whole suite", failures.filter((f) => /THREW/.test(f)).length, 0);
}

/* ── done ────────────────────────────────────────────────────────────────── */
server.close();
if (!process.env.KEEP_SCORE_TEST) rmSync(OUT, { recursive: true, force: true });
else console.log(`\n  kept ${OUT}`);
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) { for (const f of failures) console.log(`  · ${f}`); process.exit(1); }
