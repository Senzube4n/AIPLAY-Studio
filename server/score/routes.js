/**
 * THE SCORE — HTTP routes, mounted at /api/score.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Three lines in server/index.js, nothing else. The exact diff is in     │
 * │ the vendoring note in sheet.js; this is what it says:                  │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { createScoreRoutes } from "./score/routes.js";             │
 * │                                                                        │
 * │  2. beside the other runners:                                          │
 * │     const scoreRoutes = createScoreRoutes({                            │
 * │       json, readBody, config, provenance: prov });                     │
 * │                                                                        │
 * │  3. inside the request handler's `try`:                                │
 * │     if (p === "/api/score" || p.startsWith("/api/score/")) {           │
 * │       if (await scoreRoutes(req, res, url)) return; }                  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * One action-dispatched POST plus four GETs, which is the shape /api/mv,
 * /api/daw and /api/welcome already use — one insert into the route table
 * rather than fifteen. Anything unrecognised under the prefix returns false and
 * falls through to the app's own 404, the same bargain
 * server/welcome/routes.js:-1 makes.
 *
 * ⚠ WHY THIS SERVER HAS TO SERVE THE SHEET PAGE AT ALL. Edge prints from an
 * http:// URL and NOT from file:// — TESTED, and a file:// print produced no
 * PDF, no error and exit 0 (see server/score/sheet.js's banner, fact 1). So the
 * PDF step needs an http origin, and the app's own UI server is the only one
 * this repo has. GET /api/score/sheet/<slug>/<id>.html serves the page byte for
 * byte as engrave() wrote it — it does NOT rebuild it — so the PDF is a print
 * of exactly the artifact on disk and cannot be a print of a page that differs
 * from it. GET /api/score/vendor/abcjs.js serves the vendored library from the
 * SAME origin, so the page has no cross-origin fetch to be blocked on.
 *
 * ⚠ `by` COMES FROM THE REQUEST AND NEVER FROM THE BODY. Every write here
 * passes provenance.actorFrom(req) (server/provenance.js:192) into the store as
 * `by`. That function coerces a header claiming "user" to "system" precisely so
 * an agent cannot fabricate human action; a `by` readable out of the JSON body
 * would hand back that power by accident. `author` — the credit — is the body's
 * to set, and the two fields are separate in the store for that reason
 * (server/score/store.js's banner, addition 3).
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { config } from "../config.js";
import {
  listScores, createScore, readScoreDoc, deleteScore,
  adoptVersion, draftVersion, setNote, setAuthor, setCurrent, setSheet,
  findVersion, changesBetween, lineage, childrenOf, rootOf,
  readScoreAbc, versionDir, sheetDir, safeSeg, shortKey, NOTE_CAP,
} from "./store.js";
import { readScore, invariants, sectionMap, readScoreText, worstSeverity } from "./abc.js";
import { engrave, sheetCapability, abcjsPath } from "./sheet.js";

const MIME = {
  ".json": "application/json; charset=utf-8",
  ".abc": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".npy": "application/octet-stream",
};

/** Stream a file, or answer 404 in words. No path arithmetic beyond safeSeg. */
async function sendFile(json, res, file, { cache = "no-store", type = null } = {}) {
  try {
    const st = await stat(file);
    res.writeHead(200, {
      "Content-Type": type || MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": cache,
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    json(res, 404, { error: `No such file: ${path.basename(file)}` });
    return true;
  }
}

/**
 * ONE VERSION, WITH EVERYTHING DERIVED ON READ.
 *
 * Nothing in here is stored. The section map, the invariants, the change map
 * against the parent and the lineage are all computed from the score text and
 * the two receipts every time they are asked for — server/mv/store.js:169-181's
 * rule ("nothing derivable is stored ... a stamped number is a number that can
 * disagree with the renderer"), and the reason the store has no `changed` key.
 *
 * The score text is read off disk rather than cached. MEASURED: score.abc is
 * 2,253 bytes for a 122-bar song, so this is one small read per view and a
 * cache would be a second source of truth for 2 KB.
 */
async function versionView(doc, version, { withScore = true } = {}) {
  const parent = version.parent ? findVersion(doc, version.parent) : null;
  const row = {
    id: version.id,
    key: version.key,
    keyShort: shortKey(version.key),
    parent: version.parent,
    children: childrenOf(doc, version.id),
    root: rootOf(doc, version.id),
    label: version.label,
    at: version.at,
    /* TWO FIELDS, side by side, never merged. */
    by: version.by,
    author: version.author,
    /* VERBATIM, and said to be. */
    note: version.note,
    noteVerbatim: true,
    noteBy: version.noteBy ?? null,
    noteAt: version.noteAt ?? null,
    noteTruncated: !!version.noteTruncated,
    identity: version.identity,
    status: version.status,
    audioSeconds: version.audioSeconds,
    sampleRate: version.sampleRate,
    truncated: version.truncated,
    timing: version.timing,
    artifacts: Object.entries(version.artifacts || {})
      .map(([name, spec]) => ({ name, bytes: spec?.bytes ?? null, sha256: spec?.sha256 ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    unreceipted: version.unreceipted || [],
    verified: version.verified ?? null,
    sheet: version.sheet,
    /* COMPUTED FROM HASHES, not declared, and not stored. */
    changed: changesBetween(parent, version),
  };
  if (!withScore) return row;
  try {
    const abc = await readScoreAbc(doc.slug, version.id);
    const read = readScore(abc, {
      slug: doc.slug, versionId: version.id, audioSeconds: version.audioSeconds,
    });
    row.score = {
      bytes: Buffer.byteLength(abc, "utf8"),
      headers: read.headers,
      contentQuartersPerBar: read.contentQuartersPerBar,
      bars: read.bars,
      barsPerVoice: read.barsPerVoice,
      voices: read.voices,
      sections: read.sections,
      invariants: read.invariants,
      worst: read.worst,
      map: read.map,
    };
  } catch (err) {
    /* NOT fatal. A version whose score.abc cannot be read is still a render
     * with audio in it, and saying which file is missing is more use than
     * refusing the whole row. */
    row.score = { unavailable: err?.message || String(err) };
  }
  return row;
}

export function createScoreRoutes({ json, readBody, config: cfg = config, provenance = null }) {
  /* THE ACTOR. server/daw/ear.js:1915 and server/daw/routes.js:344, same line. */
  const actorOf = (req) => (provenance ? provenance.actorFrom(req) : "system");
  /* THE ORIGIN THE PDF STEP NEEDS. This server's own port, the way
   * server/mv/routes.js takes config for exactly one number and
   * server/welcome/routes.js:-1 builds its /api/models URL. */
  const origin = () => `http://127.0.0.1:${cfg.uiPort}`;

  return async function scoreRoutes(req, res, url) {
    const p = url.pathname;

    /* ── the vendored engraver, on this origin ──────────────────────────────
     * Served here rather than out of web/ because web/ belongs to another
     * hand and because the page that loads it is served from here too — one
     * origin, no cross-origin script, nothing for a print to be blocked on. */
    if (p === "/api/score/vendor/abcjs.js" && req.method === "GET") {
      const lib = abcjsPath();
      if (!lib) {
        json(res, 404, {
          error: "abcjs is not vendored on this machine.",
          note: "INSTALL.md promises an offline install, so this is never fetched from a CDN. "
            + "See the vendoring note at the top of server/score/sheet.js for the one-command step.",
          capability: sheetCapability(),
        });
        return true;
      }
      /* Immutable: the file is a pinned version of a third-party bundle and it
       * is requested once per print. */
      return sendFile(json, res, lib, { cache: "public, max-age=604800, immutable", type: "text/javascript; charset=utf-8" });
    }

    /* ── the sheet page and the PDF ─────────────────────────────────────────
     * /api/score/sheet/<slug>/<versionId>.html   THE URL EDGE PRINTS
     * /api/score/sheet/<slug>/<versionId>.pdf
     *
     * Served from disk exactly as engrave() wrote it. NOT rebuilt on GET: a
     * page rebuilt per request could differ from the one the PDF was taken
     * from, and then the two artifacts of one version would disagree. */
    if (p.startsWith("/api/score/sheet/") && req.method === "GET") {
      const rest = p.slice("/api/score/sheet/".length).split("/");
      const slug = safeSeg(decodeURIComponent(rest[0] || ""));
      const leaf = decodeURIComponent(rest[1] || "");
      const m = /^(.+)\.(html|pdf)$/.exec(leaf);
      if (!slug || !m || !safeSeg(m[1])) { json(res, 400, { error: "bad sheet path" }); return true; }
      const file = path.join(sheetDir(slug, safeSeg(m[1])), m[2] === "pdf" ? "sheet.pdf" : "sheet.html");
      return sendFile(json, res, file);
    }

    /* ── one artifact out of a version's vendor folder ─────────────────────── */
    if (p.startsWith("/api/score/file/") && req.method === "GET") {
      const rest = p.slice("/api/score/file/".length).split("/").map((x) => safeSeg(decodeURIComponent(x)));
      const [slug, version, name] = rest;
      if (!slug || !version || !name) { json(res, 400, { error: "bad artifact path" }); return true; }
      return sendFile(json, res, path.join(versionDir(slug, version), name), { cache: "public, max-age=3600" });
    }

    /* ── the list, in one GET ───────────────────────────────────────────────
     * No side effects, same bytes the `list` action returns. Convenience for
     * curl and for an agent that would rather not POST to read something —
     * welcome/routes.js:290-299's precedent. */
    if (p === "/api/score" && req.method === "GET") {
      json(res, 200, { ok: true, scores: await listScores(), capability: sheetCapability() });
      return true;
    }

    if (p === "/api/score" && req.method === "POST") {
      let body;
      try { body = await readBody(req); } catch (err) {
        json(res, 400, { error: `Unreadable body: ${err.message}` }); return true;
      }
      const b = body || {};
      const by = actorOf(req);
      const slug = b.slug ? safeSeg(b.slug) : null;

      /** The document, or a 404 that says which slug. */
      const load = async () => {
        if (!slug) throw new Error("Which score? Pass `slug`.");
        const doc = await readScoreDoc(slug);
        if (!doc) throw new Error(`No such score: ${slug}`);
        return doc;
      };
      /** The version named, the current one, or a refusal that lists the ids. */
      const pick = (doc) => {
        const id = b.version ? safeSeg(b.version) : doc.current;
        const v = id ? findVersion(doc, id) : null;
        if (!v) {
          throw new Error(
            id
              ? `No version "${id}" in "${doc.slug}". It has: ${doc.versions.map((x) => x.id).join(", ") || "none"}.`
              : `"${doc.slug}" has no versions yet. Adopt a finished render first (action "adopt").`,
          );
        }
        return v;
      };

      try {
        switch (b.action) {
          /* ── what this machine can engrave, in its own words ─────────────── */
          case "capability":
            json(res, 200, { ok: true, capability: sheetCapability(), noteCap: NOTE_CAP });
            return true;

          case "list":
            json(res, 200, { ok: true, scores: await listScores(), capability: sheetCapability() });
            return true;

          case "create": {
            if (!b.title) throw new Error("A score needs a title.");
            /* `author` is the body's to set; `by` is not. */
            const doc = await createScore(b.title, { author: b.author ?? null });
            json(res, 201, { ok: true, slug: doc.slug, score: doc });
            return true;
          }

          case "read": {
            const doc = await load();
            const wanted = b.version === undefined ? null : safeSeg(b.version);
            const rows = await Promise.all(
              (wanted ? [findVersion(doc, wanted)].filter(Boolean) : doc.versions)
                .map((v) => versionView(doc, v, { withScore: b.scores !== false })),
            );
            json(res, 200, {
              ok: true,
              score: {
                slug: doc.slug, id: doc.id, title: doc.title, author: doc.author,
                createdAt: doc.createdAt, updatedAt: doc.updatedAt,
                current: doc.current, runs: doc.runs.slice(0, 20),
              },
              versions: rows,
              /* HOW MANY SONGS ARE IN THIS FOLDER, really. A count of versions
               * says nothing about whether they are takes of one thing. */
              roots: [...new Set(doc.versions.map((v) => rootOf(doc, v.id)))],
              capability: sheetCapability(),
            });
            return true;
          }

          /* ── adopt a finished vendor run ──────────────────────────────────
           * `dir` is the operator's path to the run folder. It is read and
           * copied; every file is checked against result.json's own sha256 map
           * first, and a folder that disagrees with its receipt is refused by
           * name. THE ID IS RETURNED HERE and is the only way to ask about the
           * render afterwards — DIRECTING.md:1220-1243 measured what happens to
           * a loop that watches a folder instead. */
          case "adopt": {
            if (!b.dir) {
              throw new Error(
                "adopt needs `dir` — the vendor's finished run folder, the one holding "
                + "result.json. Nothing here scans for new folders: a render is matched by the "
                + "id this call returns.",
              );
            }
            const doc = await load();
            const r = await adoptVersion(doc.slug, {
              dir: String(b.dir),
              by,
              author: b.author,
              note: b.note ?? null,
              parent: b.parent ? safeSeg(b.parent) : null,
              dedupe: b.dedupe === "allow" ? "allow" : "refuse",
              verify: b.verify === "bytes" ? "bytes" : "hash",
              id: b.id ? safeSeg(b.id) : null,
              label: b.label ?? null,
            });
            const fresh = await readScoreDoc(doc.slug);
            json(res, 201, {
              ok: true,
              /* ⚠ WAIT FOR THIS ID. Not for a file, not for a folder listing. */
              version: r.id,
              key: r.key,
              note_recorded: !!r.version?.note,
              by: r.version?.by,
              author: r.version?.author,
              unreceipted: r.version?.unreceipted || [],
              unreceiptedNote: (r.version?.unreceipted || []).length
                ? "These files were in the run folder but are not hashed by result.json. They have "
                  + "been copied and named rather than dropped or refused — a convenience file beside "
                  + "a real render is not a reason to reject either of them."
                : null,
              detail: await versionView(fresh, findVersion(fresh, r.id)),
            });
            return true;
          }

          /* ── an EDITED score, with no render behind it yet ─────────────────
           *
           * ⚠ THE ACTION THAT WAS ALWAYS BEING CALLED AND NEVER EXISTED.
           * mcp-music-score.js has posted `action: "draft"` from `score_edit`
           * and `score_mechanical` since it shipped, with its own comment
           * explaining why it cannot use `adopt` (adopt verifies a vendor run
           * folder against result.json, which an un-rendered edit has not got).
           * This case was missing, so both tools answered "Unknown action" for
           * their whole existence — while 188 assertions passed, because the
           * suite checks what the tool would SEND, not what happens when it
           * arrives. Two more of the unreachable paths found on 2026-09-11.
           *
           * The check verdict comes from the caller because `checkScore()`
           * lives beside the parser in abc.js and every caller already runs it
           * to decide whether to write at all. The store does not recompute it;
           * it verifies that the hash the caller claims matches the bytes it
           * handed over, which is the part that can go wrong quietly. */
          case "draft": {
            const doc = await load();
            if (!b.abc || !String(b.abc).trim()) {
              throw new Error(
                "draft needs `abc` — the edited score. To start from the current one, read it with "
                + "action \"read\" first; this door does not guess what you meant to edit.",
              );
            }
            const r = await draftVersion(doc.slug, {
              abc: String(b.abc),
              by,
              author: b.author,
              note: b.note ?? null,
              parent: b.parent ? safeSeg(b.parent) : null,
              style: b.style ?? null,
              lyrics: b.lyrics ?? null,
              cot: b.cot ?? null,
              check: b.check ?? null,
              id: b.id ? safeSeg(b.id) : null,
              label: b.label ?? null,
              dedupe: b.dedupe === "allow" ? "allow" : "refuse",
            });
            const fresh = await readScoreDoc(doc.slug);
            json(res, 201, {
              ok: true,
              version: r.id,
              key: r.key,
              sha256: r.sha256,
              parent: r.version?.parent ?? null,
              note_recorded: !!r.version?.note,
              by: r.version?.by,
              author: r.version?.author,
              /* Said plainly, because the difference between this and an adopt
               * IS the action: there is no audio, and `current` has
               * deliberately not moved. */
              drafted: true,
              current: fresh.current,
              currentNote: fresh.current === r.id
                ? null
                : "`current` still points at the last version with audio. A draft has none, and a "
                  + "pointer at something nobody can hear would leave the player with nothing to "
                  + "play — the render made from this draft is what moves it.",
              detail: await versionView(fresh, findVersion(fresh, r.id)),
            });
            return true;
          }

          /* ── the human's note, VERBATIM ───────────────────────────────────
           * ear.js:1478-1482: "written in your words, recorded verbatim — it
           * ranks above any menu pick". Nothing here trims, collapses,
           * lowercases or summarises it. */
          case "note": {
            const doc = await load();
            const v = pick(doc);
            const out = await setNote(doc.slug, v.id, b.note ?? null, { by, append: !!b.append });
            json(res, 200, {
              ok: true, version: v.id, note_recorded: !!out.note,
              note: out.note, truncated: !!out.noteTruncated, cap: NOTE_CAP, by: out.noteBy,
              verbatim: true,
            });
            return true;
          }

          /* ── the credit. Cannot reach `by`. ──────────────────────────────── */
          case "author": {
            const doc = await load();
            const versionId = b.version ? safeSeg(b.version) : null;
            if (versionId && !findVersion(doc, versionId)) {
              throw new Error(`No version "${versionId}" in "${doc.slug}".`);
            }
            await setAuthor(doc.slug, b.author ?? null, { versionId, by });
            const fresh = await readScoreDoc(doc.slug);
            json(res, 200, {
              ok: true,
              author: versionId ? findVersion(fresh, versionId).author : fresh.author,
              scope: versionId ? `version ${versionId}` : "score",
              /* Said out loud, because the separation is the point. */
              by, note: "`by` is the actor that made this call and is not settable from the body; "
                + "`author` is the credit and is.",
            });
            return true;
          }

          case "current": {
            const doc = await load();
            const v = pick(doc);
            await setCurrent(doc.slug, v.id, { by });
            json(res, 200, { ok: true, current: v.id });
            return true;
          }

          /* ── the section map, scaled to the real audio ────────────────────
           * SECTION GRANULARITY, and the caveat travels with the numbers. */
          case "map": {
            const doc = await load();
            const v = pick(doc);
            const abc = await readScoreAbc(doc.slug, v.id);
            const score = readScoreText(abc);
            const audioSeconds = b.audioSeconds === undefined
              ? v.audioSeconds : Number(b.audioSeconds);
            json(res, 200, {
              ok: true, version: v.id,
              audioSecondsFrom: b.audioSeconds === undefined ? "the render's own receipt" : "the caller",
              map: sectionMap(score, { slug: doc.slug, versionId: v.id, audioSeconds }),
              invariants: invariants(score, { audioSeconds }),
            });
            return true;
          }

          case "invariants": {
            const doc = await load();
            const v = pick(doc);
            const abc = await readScoreAbc(doc.slug, v.id);
            const score = readScoreText(abc);
            const rows = invariants(score, { audioSeconds: v.audioSeconds });
            json(res, 200, {
              ok: true, version: v.id, worst: worstSeverity(rows), invariants: rows,
              /* The first row is the one that was wrong for a night. Named, so
               * a caller showing one row shows that one. */
              first: rows[0]?.id ?? null,
            });
            return true;
          }

          /* ── the parent chain, with the change map computed on each step ── */
          case "lineage": {
            const doc = await load();
            const v = pick(doc);
            json(res, 200, {
              ok: true, version: v.id, root: rootOf(doc, v.id),
              children: childrenOf(doc, v.id),
              lineage: lineage(doc, v.id),
              basis: "sha256 of every artifact in the two receipts; nothing here is declared",
            });
            return true;
          }

          /* ── engrave ─────────────────────────────────────────────────────── */
          case "sheet": {
            const doc = await load();
            const v = pick(doc);
            const abc = await readScoreAbc(doc.slug, v.id);
            const sheet = await engrave({
              slug: doc.slug, versionId: v.id, abc,
              title: b.title ? String(b.title).slice(0, 120) : doc.title,
              author: v.author ?? doc.author ?? null,
              /* The human's note goes ON THE PAPER. It is the one thing about
               * this take that the score cannot state. */
              note: b.withNote === false ? null : v.note,
              audioSeconds: v.audioSeconds,
              /* THE http ORIGIN. Without it there is no PDF — file:// prints
               * nothing (sheet.js banner, fact 1). */
              origin: b.origin ? String(b.origin) : origin(),
              staffwidth: Number(b.staffwidth) || 700,
            });
            await setSheet(doc.slug, v.id, sheet);
            json(res, 200, {
              ok: true, version: v.id, sheet,
              html: `/api/score/sheet/${encodeURIComponent(doc.slug)}/${encodeURIComponent(v.id)}.html`,
              pdf: sheet.pdf ? `/api/score/sheet/${encodeURIComponent(doc.slug)}/${encodeURIComponent(v.id)}.pdf` : null,
              /* ABSENCE IS NOT FAILURE, and the reason is in words. */
              pdfSkipped: sheet.pdfSkipped,
              capability: sheetCapability(),
            });
            return true;
          }

          case "delete": {
            const doc = await load();
            /* 🔴 REFUSE A `version`, RATHER THAN IGNORING IT. This action deletes
             * the WHOLE SCORE. Every other action here takes `version` and acts
             * on that one version, so `{action:"delete", slug, version}` reads
             * unmistakably as "delete that version" — and it used to silently
             * do something forty times larger.
             *
             * MEASURED, on me, 2026-09-11: I passed `version` to clean up a
             * test draft and destroyed the score, its adopted render and its
             * engraved sheet. Recoverable only because the source run folder
             * was untouched. Nothing in the response would have told me: it
             * answered `ok: true, deleted: <slug>`, which is true and is not
             * what I asked for.
             *
             * An ignored parameter is a silent reinterpretation of the request.
             * That is tolerable when the two readings differ in detail and
             * unacceptable when one of them is destructive — so this refuses
             * and names the action that does what the caller meant. */
            if (b.version !== undefined) {
              throw new Error(
                "`delete` removes the ENTIRE score and every version in it, so it does not take "
                + "`version` — and rather than ignore the field it refuses, because "
                + `{action:"delete", slug:"${doc.slug}", version:"${safeSeg(String(b.version))}"} reads as `
                + "\"delete that one version\" and would have deleted all "
                + `${doc.versions.length}. To remove one version there is no action: a version is `
                + "the record of a render that happened, and the lineage of anything descended from "
                + "it would be broken by its removal. To stop using one, point `current` elsewhere "
                + "with action \"current\". To delete the whole score, repeat this call without "
                + "`version`.",
              );
            }
            await deleteScore(doc.slug);
            json(res, 200, { ok: true, deleted: doc.slug, versions: doc.versions.length });
            return true;
          }

          default:
            json(res, 400, {
              error: "Unknown action. Try: list, create, read, adopt, draft, note, author, current, "
                + "map, invariants, lineage, sheet, capability, delete.",
            });
            return true;
        }
      } catch (err) {
        json(res, 400, { error: err?.message || String(err) });
        return true;
      }
    }

    /* Anything else under this prefix falls through to the app's own 404 — the
     * same bargain vfx, daw and welcome make, so an unknown path is still an
     * honest error rather than a silent 200. */
    return false;
  };
}
