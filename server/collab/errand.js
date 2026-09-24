/**
 * AN ORDER BECOMES A PROJECT — one scene long, and nothing else in it.
 *
 * A friend's order asks for one shot. This turns it into a complete, ordinary
 * AIPLAY project document containing exactly that shot, so that the render runs
 * on the machinery this Studio already has and already trusts: the plan screen
 * approves it, the plan runner walks it one item at a time, `mv_generate_clip`
 * renders it, and the take lands in a project the owner of this machine can see
 * and delete. Nothing new touches the card.
 *
 * ⚠ WHY A PROJECT AND NOT A DIRECT RENDER. `steps` and `engineMode` are not
 * arguments of `mv_generate_clip`; they are the PROJECT's brief, which on an
 * ordinary project sets the value for every scene at once. On a project that is
 * one scene long the two are the same statement, so the order can carry them
 * without an item ever growing an argument the tool would silently drop.
 *
 * ⚠ THE FROZEN PROMPT SURVIVES BY `promptOverride`, AND THIS IS THE WHOLE
 * REASON THE PACKET COMPOSES THE PROMPT ON THE SENDING SIDE. `clipPrompt`
 * (server/mv/shot.js) prepends `doc.styleBible + "."` unconditionally, so a
 * scene recomputed here would be rendered under THIS machine's bible — the
 * lender's look pasted over the owner's film. `resolveShot` takes an override
 * ahead of the computed prompt and only computes the other one for reference,
 * so setting it is what makes the lender's bible unreachable by construction.
 * The bibles are also blanked below, which is belt and braces rather than the
 * mechanism.
 *
 * ⚠ EVERY PICTURE IS DECLARED AS A CHARACTER, ON PURPOSE. `<Picture N>` in the
 * frozen prompt means "the Nth file in refImages", and that array is filled from
 * the board's three lists in order — characters, then backgrounds, then props.
 * The owner's kinds do not travel, and nothing here reads them because the
 * prompt is already written. One bucket in the packet's own order is the only
 * arrangement that cannot silently renumber the pictures a sentence refers to.
 *
 * ⚠ NO NAME FROM THE WIRE IS EVER USED AS A NAME ON DISK. Every staged picture
 * is renamed `peer_<first twelve of its own sha256><ext>`. A hex digest cannot
 * contain a path separator, so traversal is impossible rather than filtered, and
 * two friends sending the same sheet write one file.
 *
 * This module writes pictures and returns a document. It does not create the
 * project: the door owns that call, so there is one place that decides a project
 * exists.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { briefFor } from "./order.js";
import { mergeFingerprints } from "../safety/minors.js";

/** ⚠ THE ERRAND'S ONLY SCENE, AND THE ONE NAME A PLAN ITEM MAY USE. An order
 *  names a scene in somebody else's project; the project built from it has this
 *  one. Exported so the door cannot invent a third spelling. */
export const ERRAND_SEGMENT = "s1_0";

const EXT_FOR = Object.freeze({ png: ".png", jpeg: ".jpg", webp: ".webp" });

/** ⚠ THE MEDIA TYPE COMES FROM THE BYTES, NEVER FROM THE SENDER. A type taken
 *  from the wire is how a picture becomes `image/svg+xml`, and an SVG in an
 *  `<img>` is markup the browser will parse. Three types, read by magic. */
export const MIME_FOR = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });

function refuse(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Magic bytes again, because this module must not trust the sender's word for
 *  what a file is even though order.js already checked it. Two checks over one
 *  decision is the right number when the decision is "write this to disk". */
export function pictureKind(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.subarray(1, 4).toString("ascii") === "PNG") return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

/** The only name this module will write. Content-addressed, so it carries no
 *  information from the wire at all. */
export function errandName(digest, ext) {
  return `peer_${String(digest).slice(0, 12)}${ext}`;
}

/** A title a person can recognise in their own project list. */
export function errandTitle(orderDoc, from) {
  const who = String(from?.nickname || from?.fp || "a friend").slice(0, 40);
  return `Order ${String(orderDoc?.id || "").slice(0, 10)} from ${who}`;
}

/**
 * Write the order's pictures into an assets folder, under names derived from
 * their own bytes. Returns one row per picture, in the packet's order.
 */
export async function stageOrderFiles({ orderDoc, assetsDir } = {}) {
  await mkdir(assetsDir, { recursive: true });
  const staged = [];
  for (const f of orderDoc.files || []) {
    const buf = Buffer.from(String(f.b64 || ""), "base64");
    const digest = sha256(buf);
    if (digest !== f.sha256) {
      throw refuse("file-hash", `${f.file} does not hash to what the order says. Nothing was written.`);
    }
    const kind = pictureKind(buf);
    if (!kind) {
      throw refuse("file-type", `${f.file} is not a png, jpeg or webp. Nothing was written.`);
    }
    const name = errandName(digest, EXT_FOR[kind]);
    try {
      await writeFile(path.join(assetsDir, name), buf);
    } catch (err) {
      throw refuse("staging-failed", `${name} could not be written into ${assetsDir}: ${err.message}. Nothing was accepted.`);
    }
    /* `file` is the packet's join key and `name` is what is on disk. The two are
     * kept apart deliberately: the first is a label from somebody else and the
     * second is ours. */
    staged.push({ file: f.file, name, role: f.role || "ref", sha256: digest, bytes: buf.length });
  }
  return staged;
}

/**
 * The document. Complete, ordinary, and one scene long.
 */
export function errandDoc({ orderDoc, from, staged, now = 0, expect = null } = {}) {
  const shot = orderDoc.shot;
  const seconds = Number(shot.seconds) || 5;
  const brief = briefFor(orderDoc);
  const title = errandTitle(orderDoc, from);

  const refNames = new Map();
  for (const s of staged) {
    const row = (shot.refs || []).find((r) => r.file === s.file);
    refNames.set(s.file, row?.name || s.name);
  }
  const refs = staged.filter((s) => s.role === "ref");
  const guides = staged.filter((s) => s.role === "guide");
  /* What each picture was made as, two booleans the sender's Studio put on its
   * row (packet.js). Kept on the rows here so this machine's own render door
   * judges the scene with them (mv/generate.js castFlags). */
  const flagOf = (file) => mergeFingerprints(
    [...(shot.refs || []), ...(shot.guides || [])].find((r) => r?.file === file)?.safety);

  const boardId = `bd_${randomUUID().slice(0, 8)}`;
  return {
    v: 1,
    kind: "mv",
    id: randomUUID().slice(0, 8),
    slug: null,                       // the door slugifies and dedupes
    title,
    createdAt: now,
    updatedAt: now,
    /* ⚠ NO SONG, EVER. The order carries none — the owner's track is their
     * unreleased record and packet.js refuses to send it — and a scene rendered
     * here with some other audio under it would come back as a clip the owner
     * did not ask for. A scene the owner renders song-conditioned (a singing
     * board, or "Song under the clip: always") is NOT refused at pack time: it
     * is lent and rendered silent, because a take without lip-sync is better
     * than none for somebody with no card. The loss is said out loud instead —
     * the packet's `songUnder`, the order's own sentence (order.js
     * describeOrder) at preview and on the lender's card, and the returned
     * take's notes (order.js returnNotes). */
    song: null,
    brief,
    /* ⚠ BLANK, AND NOT BECAUSE IT DOES NOT MATTER. `clipPrompt` prepends the
     * bible to every prompt it computes. The frozen prompt below means that
     * function is never consulted for this render, so these two are belt and
     * braces — but a future change that made the computed prompt reachable
     * would otherwise paste this machine's look over a friend's film. */
    styleBible: "",
    lookBible: "",
    story: null,
    lyricLines: [],
    beats: [],
    segments: [{
      id: "s1_0",
      index: 0,
      startSec: 0,
      endSec: seconds,
      durationSec: seconds,
      /* ⚠ NO LYRIC TEXT AND NO THESIS LINE. The packet carries none, and
       * inventing one would put words into a prompt that nobody wrote. */
      kind: "broll",
      lyricText: null,
      thesisLine: null,
      lineIndices: [],
      mode: "generate",
      note: `Ordered by ${String(from?.nickname || from?.fp || "a friend")}.`,
    }],
    boards: [{
      id: boardId,
      segmentId: "s1_0",
      segmentIndex: 0,
      clipIndex: 0,
      boardPrompt: "",
      grade: "",
      shots: [{ action: "" }],
      /* One bucket, packet order — see the header. */
      characterRefs: refs.map((s) => refNames.get(s.file)),
      backgroundRefs: [],
      propRefs: [],
      refProminence: {},
      /* ⚠ THE GUIDE FRAMES, ALL OF THEM, IN THE PACKET'S ORDER. The first
       * version put the first guide on `imageFile` and the rest on
       * `shotFrames`, which is the shape for a single opening frame — so a
       * two-keyframe scene (an opening AND a closing guide) rendered on the
       * lender's machine as a ONE-picture loop, silently, and came back looking
       * like a different shot. `shotFrames` is the list the renderer reads when
       * there is more than one; `imageFile` is the single-frame form. */
      ...(guides.length > 1
        ? { shotFrames: guides.map((g) => g.name), imageFile: guides[0].name }
        : { imageFile: guides[0]?.name ?? null }),
      safety: mergeFingerprints(...guides.map((g) => flagOf(g.file))),
      updatedAt: now,
    }],
    characters: refs.map((s, i) => ({
      id: `c_${i}_${String(s.sha256).slice(0, 6)}`,
      name: refNames.get(s.file),
      role: "lead",
      description: "",
      imageFile: s.name,
      safety: flagOf(s.file),
    })),
    backgrounds: [],
    props: [],
    clips: [{
      id: "c_s1_0",
      segmentId: "s1_0",
      clipIndex: 0,
      boardId,
      mode: "generate",
      takes: [],
      /* THE FROZEN PROMPT. See the header: this is the mechanism, not a hint. */
      promptOverride: String(shot.prompt || ""),
    }],
    /* ⚠ A PEER'S PLANS ARE NOT PLANS OF MINE. The plan this errand runs is
     * built here, from the order's four words, by code on this machine. */
    plans: [],
    runs: [],
    previz: null,
    timelineProject: null,
    totalDurationSec: seconds,
    /* The one field that says this project is somebody else's errand, so every
     * screen that lists projects can say so and the return can find its way
     * home when the render is done. */
    collab: {
      orderId: orderDoc.id,
      from: { fp: String(from?.fp || ""), nickname: String(from?.nickname || "").slice(0, 40) },
      /* The same fingerprint as `from` by construction — the accept branch
       * refuses an order whose return address is not the signer — and kept
       * because a future version may let a friend nominate a third party, at
       * which point the two really would differ and this field is where anybody
       * would look. */
      returnTo: orderDoc.returnTo,
      order: orderDoc.order,
      landedAt: now,
      /* What the finished clip should measure. The door passes the renderer's
       * own count (lending.js expectForOrder: H3's 17k+5 grid, LTX's 8k+1);
       * the fallback is the scene's plain length, for a caller that has none. */
      expect: expect || {
        width: shot.width, height: shot.height, seconds,
        frames: Math.round(seconds * 24),
      },
    },
  };
}
