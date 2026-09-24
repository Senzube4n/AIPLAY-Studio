/**
 * WHAT COMES BACK SITS IN A ROOM BY ITSELF UNTIL SOMEBODY LOOKS AT IT.
 *
 * A friend's machine renders a scene and posts the take home. That file is a
 * video somebody else's computer made, arriving with a record that the same
 * computer wrote — so the record cannot be the thing that clears it, and the
 * file cannot go straight into the library. It lands in quarantine, is measured
 * HERE against what was ordered, and stays there until a person presses Adopt.
 *
 * ⚠ THE MEASUREMENT IS OURS AND THE RECORD IS THEIRS, AND BOTH ARE KEPT. The
 * return carries the lender's own probe; this machine runs its own and compares
 * the two. A doctored record is easy to write and hard to make survive somebody
 * else's ffprobe, so the disagreement is the cheap check that catches it. When
 * they differ the take is refused and the refusal says which number moved.
 *
 * ⚠ ADOPTING WRITES THE LENDER'S MODEL AND THE LENDER'S RIGHTS, VERBATIM. The
 * weights that made those pixels are on their disk under their licence, and a
 * receiver that looked the answer up in its own catalogue would be writing a
 * licence claim about a file it did not make. provenance.js supports this in its
 * own words — `stampRights` returns early when a caller supplies `outputRights`
 * — and order.js refuses a return that carries none, because `null` satisfies
 * that early return too and would be written as a line that says nothing.
 *
 * ⚠ AND THE TAKE IS NOT PICKED. It is filed beside the owner's own takes and
 * the scene keeps whatever it was already using. A clip from another machine
 * becoming the scene's chosen take without anybody looking at it is the one
 * outcome this whole path exists to prevent.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { probeClip } from "../clipjoin.js";
import { checkReturn, readReturn } from "./order.js";
import { withFrameGrid } from "./lending.js";

const FP_OK = /^[0-9a-f]{8,32}$/;
/* ⚠ EVERY FUNCTION HERE PUTS THE FINGERPRINT INTO A PATH, and only one of them
 * used to check it. `from: "../../.."` walked straight out of the quarantine
 * folder in `adoptReturn` and `dropReturn` — and `dropReturn` DELETES. One
 * guard, called by all three, and a hex string cannot hold a separator. */
function safeFp(fp) {
  const s = String(fp ?? "").toLowerCase();
  if (!FP_OK.test(s)) {
    throw refuse("bad-arguments", `${JSON.stringify(String(fp))} is not a fingerprint. It is the name of a folder on this disk, so it is checked rather than trusted.`);
  }
  return s;
}

function refuse(reason, message, status = 400) {
  const err = new Error(message);
  err.reason = reason;
  err.status = status;
  return err;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* ⚠ The directory handed in IS <output>/collab — see the note in
 * orderbook.js. Appending "collab" again is how these files went to
 * <output>/collab/collab/quarantine. */
export const quarantineDir = (collabDir, fp) => path.join(collabDir, "quarantine", safeFp(fp).slice(0, 8));

/** The only name this writes. Content-addressed and prefixed, so it carries
 *  nothing from the wire and the library can tell at a glance where it came
 *  from. */
export const quarantineName = (fp, digest, ext) => `peer_${String(fp).slice(0, 8)}_${String(digest).slice(0, 12)}${ext}`;

/**
 * Land a return: write the clip into quarantine, measure it here, check it
 * against the order it claims to answer, and write the row beside it.
 *
 * Nothing outside the quarantine folder is touched. A return that fails every
 * check is still written down, because the reason is the only thing that tells
 * the friend what to fix, and a refusal that leaves no trace is silence.
 */
/* `probe` is injected and defaults to the real one: it is the single
 * measurement that decides whether a take is accepted, and a decision that
 * cannot be substituted cannot be tested either. */
export async function landReturn({ outDir, payload, fromFp, orderRow, now = 0, probe = probeClip } = {}) {
  safeFp(fromFp);
  /* Shape and hash first: this is the only part that needs no order and no
   * disk, so a malformed return costs nothing. */
  const { doc, bytes } = readReturn(payload);
  const dir = quarantineDir(outDir, fromFp);
  await mkdir(dir, { recursive: true });

  /* ⚠ A CLIP IS A CLIP. The first filter admitted any two-to-four letters, so a
   * peer could choose `.bat`, `.exe`, `.ps1`, `.cmd`, `.lnk`, `.js`, `.html` or
   * `.svg` — nothing here would run it, but a file called `peer_x.bat` sitting
   * in somebody's folder is a thing they might double-click, and an `.html` or
   * `.svg` opened from disk runs script with local-file privileges. Four
   * extensions, and anything else becomes `.mp4`, which is honest: it is the
   * bytes we were told were a clip. */
  const VIDEO_EXT = [".mp4", ".webm", ".mov", ".mkv"];
  const asked = String(doc.result.ext || "").toLowerCase();
  const ext = VIDEO_EXT.includes(asked) ? asked : ".mp4";
  const name = quarantineName(fromFp, doc.result.sha256, ext);
  const file = path.join(dir, name);
  /* The clip is written before its row on purpose: a clip with no row is listed
   * as unreadable and can be thrown away, while a row with no clip is a promise
   * about a file that is not there. Neither is good; this is the recoverable
   * one. */
  await writeFile(file, bytes);

  /* OUR OWN MEASUREMENT. `probeClip` counts frames by decoding rather than
   * believing the container header, which is what a re-wrapped file lies
   * about. */
  const measured = await probe(file);
  const ourProbe = measured.error ? null : {
    frames: measured.frames, fps: measured.fps, width: measured.width, height: measured.height,
    seconds: measured.seconds, videoStreams: measured.videoStreams, audioStreams: measured.audioStreams,
  };

  /* The order row is read through `withFrameGrid`, so the frame check centres
   * on the renderer's own count — and a row written before rows named their
   * engine accepts either engine's grid rather than refusing a correct take. */
  const verdict = measured.error
    ? { ok: false, reason: "probe-failed", why: `${measured.error} Without a measurement of our own there is nothing to check their record against, so this take was not accepted.` }
    : checkReturn({ ...doc, from: fromFp }, withFrameGrid(orderRow), ourProbe);

  const row = {
    v: 1,
    orderId: doc.orderId,
    segmentId: doc.segmentId,
    from: String(fromFp),
    at: Number(now) || 0,
    file: name,
    bytes: bytes.length,
    sha256: doc.result.sha256,
    theirProbe: doc.probe || null,
    ourProbe,
    record: doc.record,
    ok: verdict.ok,
    reason: verdict.reason,
    why: verdict.why,
    /* What the borrower should know about how it was made — this machine's own
     * sentences (order.js returnNotes), never text from the return. */
    notes: Array.isArray(verdict.notes) ? verdict.notes : [],
    /* ⚠ `adopted` IS THE ONLY THING THAT MOVES A FILE OUT OF THIS FOLDER, and a
     * landing never sets it. */
    adopted: false,
  };
  /* ⚠ A LANDING MAY NOT OVERWRITE A ROW THAT SAYS `adopted`. The name is the
   * clip's own hash, so re-sending one sealed file lands on the same path — and
   * rewriting the sidecar reset the flag, which is the whole of `already-adopted`.
   * Replaying a return would have filed a second copy of one render. */
  const rowFile = `${file}.json`;
  const had = await readFile(rowFile, "utf8").then((t) => JSON.parse(t)).catch(() => null);
  if (had?.adopted) {
    return { ...had, note: "This exact take is already in your film — it was adopted on " + new Date(had.adoptedAt || 0).toLocaleString() + ". Nothing was changed." };
  }
  await writeFile(rowFile, JSON.stringify(row, null, 2), "utf8");
  return row;
}

/** Everything sitting in quarantine, newest first. */
export async function listQuarantine({ outDir } = {}) {
  const root = path.join(outDir, "quarantine");
  let dirs = [];
  try {
    dirs = await readdir(root);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw refuse("quarantine-unreadable", `The quarantine folder could not be listed: ${err.message}.`, 500);
  }
  const rows = [];
  for (const d of dirs) {
    let names = [];
    try { names = await readdir(path.join(root, d)); } catch { continue; }
    for (const f of names.filter((x) => x.endsWith(".json"))) {
      try {
        rows.push(JSON.parse(await readFile(path.join(root, d, f), "utf8")));
      } catch (err) {
        /* ⚠ A ROW WE CANNOT READ IS REPORTED AS ITSELF, never skipped. A silent
         * gap in this list is a take somebody is waiting on, and an ENOENT here
         * means the sidecar vanished between the listing and the read — which is
         * still a fact about a file that is on disk. */
        rows.push({ v: 0, from: d, file: f.replace(/\.json$/, ""), ok: false, reason: "row-unreadable", adopted: false, why: `This take's record could not be read (${err.code || err.message}). The clip is still there; move the record aside to see it again.` });
      }
    }
  }
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * Adopt: copy the clip into the library under this machine's own name, file it
 * as a take nobody has picked, and hand back the ledger event the caller must
 * append.
 *
 * ⚠ THE EVENT IS RETURNED RATHER THAN WRITTEN. One place in this app appends to
 * a project's ledger and it is the door; a module that wrote its own would be a
 * second writer on a hash chain, which is how a chain gets two heads.
 */
export async function adoptReturn(opts = {}) {
  /* ⚠ READ-THEN-WRITE ON `adopted`, SERIALISED. Two presses a moment apart both
   * read `adopted: false` and both filed a take — one render, two copies in the
   * film. The same one-chain discipline orderbook.js uses, for the same
   * reason. */
  return enqueue(() => adoptOnce(opts));
}

let adoptTail = Promise.resolve();
function enqueue(fn) {
  const next = adoptTail.then(fn, fn);
  adoptTail = next.then(() => {}, () => {});
  return next;
}

async function adoptOnce({ outDir, clipDir, fromFp, file, force = false, now = 0 } = {}) {
  const dir = quarantineDir(outDir, fromFp);
  const src = path.join(dir, path.basename(String(file || "")));
  const rowFile = `${src}.json`;
  let row;
  try {
    row = JSON.parse(await readFile(rowFile, "utf8"));
  } catch {
    throw refuse("no-such-return", `There is no take called ${file} in quarantine from that friend.`, 404);
  }
  if (row.adopted) {
    throw refuse("already-adopted", `That take was already adopted on ${new Date(row.adoptedAt || 0).toLocaleString()}. It is in the library; adopting again would file a second copy of one render.`, 409);
  }
  if (!row.ok && !force) {
    /* ⚠ A REFUSED TAKE CAN BE ADOPTED ONLY BY SAYING SO OUT LOUD. The checks
     * are about a file somebody else made, and a person who has watched it and
     * wants it anyway is entitled to it — but not by accident, and the ledger
     * records that the checks did not pass. */
    throw refuse("return-refused", `This take did not pass its checks: ${row.why} Adopt it anyway only if you have watched it and you want it; the ledger will say the checks did not pass.`);
  }

  const bytes = await readFile(src).catch(() => null);
  if (!bytes) throw refuse("no-such-return", `${row.file} is not on disk any more.`, 404);
  if (sha256(bytes) !== row.sha256) {
    throw refuse("result-hash", "The file in quarantine is not the one that was checked — its bytes changed after it landed. Nothing was adopted.");
  }

  await mkdir(clipDir, { recursive: true });
  const name = path.basename(src);
  const dest = path.join(clipDir, name);
  if (!(await stat(dest).catch(() => null))) await copyFile(src, dest);

  const take = {
    clip: name,
    seed: row.record?.seed ?? null,
    at: Number(now) || 0,
    ms: row.record?.ms ?? null,
    /* Who and what, on the take itself, so a person scrubbing takes can see
     * which one came from somebody else without opening a ledger. */
    peer: { fp: row.from, orderId: row.orderId },
    engine: row.record?.engine ?? null,
    steps: row.record?.steps ?? null,
  };

  /* ⚠ THE ACTOR IS THE FIFTH CLASS, BUILT HERE. `peer:<their fp>:<their own
   * actor>` — theirs, under their fingerprint, with their own hand named inside
   * it. credit.js already reads this shape; this is the writer it was waiting
   * for. */
  const event = {
    type: "generate",
    actor: `peer:${String(row.from).toLowerCase()}:${String(row.record?.actor || "system").toLowerCase()}`,
    data: {
      model: row.record?.model ?? null,
      modelVersion: row.record?.modelVersion ?? null,
      /* Verbatim. See the header: this is their licence, not ours to look up. */
      outputRights: row.record?.outputRights,
      note: row.ok
        ? `Rendered on a friend's machine for order ${row.orderId} and adopted here.`
        : `Rendered on a friend's machine for order ${row.orderId} and adopted DESPITE failing its checks (${row.reason}).`,
      checksPassed: !!row.ok,
    },
  };

  const next = { ...row, adopted: true, adoptedAt: Number(now) || 0, adoptedAs: name, adoptedDespite: row.ok ? null : row.reason };
  await writeFile(rowFile, JSON.stringify(next, null, 2), "utf8");
  return { take, event, file: dest, row: next };
}

/** Video types by extension, for the four extensions `landReturn` writes. */
const WATCH_TYPES = Object.freeze({ ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska" });

/**
 * A quarantined take, found for WATCHING and nothing else — so a person can see
 * a take before they keep it, including one that failed its checks.
 *
 * ⚠ THE NAME IS CHECKED AGAINST THE ONE SHAPE THIS MODULE WRITES, not filtered.
 * `quarantineName` makes `peer_<fp8>_<sha12><ext>` and nothing else, so anything
 * else — a sidecar, a path, another friend's folder — is refused rather than
 * served. The fingerprint goes through `safeFp`, like every other path here.
 */
export async function quarantineTake({ outDir, fromFp, file } = {}) {
  const fp8 = safeFp(fromFp).slice(0, 8);
  const name = String(file ?? "");
  const m = /^peer_([0-9a-f]{8})_[0-9a-f]{12}(\.(?:mp4|webm|mov|mkv))$/.exec(name);
  if (!m || m[1] !== fp8) {
    throw refuse("bad-arguments", `${JSON.stringify(name)} is not a returned take from that friend. Only a take this Studio wrote into quarantine can be watched.`);
  }
  const full = path.join(quarantineDir(outDir, fromFp), name);
  const info = await stat(full).catch(() => null);
  if (!info || !info.isFile()) throw refuse("no-such-return", `There is no take called ${name} in quarantine from that friend.`, 404);
  return { file: full, size: info.size, type: WATCH_TYPES[m[2]] };
}

/** Throw a take away. The row goes with it; there is nothing to keep. */
export async function dropReturn({ outDir, fromFp, file } = {}) {
  const dir = quarantineDir(outDir, fromFp);
  const src = path.join(dir, path.basename(String(file || "")));
  await rm(src, { force: true });
  await rm(`${src}.json`, { force: true });
  return { dropped: path.basename(src) };
}
