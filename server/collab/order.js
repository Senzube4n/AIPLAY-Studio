/**
 * THE ORDER, AND WHAT COMES BACK — the four words one Studio may say to another
 * about work, and the shape of the answer.
 *
 * This is the half of Collab that puts a friend's card to work. The other half
 * moves a project; this one asks somebody to render one scene of it and takes
 * the take home. The owner asked for it in one sentence: "rather then solo
 * generating the video he could share the video task to all of his friends".
 *
 * ⚠ THE ORDER CARRIES NO GRAPH, AND THAT IS THE WHOLE SECURITY MODEL. A render
 * graph on the wire reaches the engine's own node classes, and the engine
 * validates SHAPE and not intent: `graphProblems()` in server/engine/record.js
 * checks that a graph is API-format, that `inputs` exists and that links point
 * somewhere. There is no class allowlist, nothing is path-aware, and nothing
 * could usefully be — a list built from local history refuses the bring-your-own
 * graphs server/customWorkflows.js exists for, and widens to fit whatever last
 * got through. So the vocabulary has no words for any of it. A fully
 * compromised, fully trusted peer's best outcome is "renders a scene you
 * already had, into a take you must pick by hand, filed under their name".
 *
 * ⚠ THE FOURTH KEY IS `engineMode`, NOT `mode`, AND THE DIFFERENCE ALREADY COST
 * THIS REPO A WRONG ANSWER. Beside a `segmentId`, `mode` means the segment's own
 * generate/skip (`seg.mode`), which is what packet.js carries under that name.
 * The design document froze the vocabulary as `{segmentId, seed, steps, mode}`
 * with `mode: "fast"`, which is a third meaning again. Two meanings of one word
 * sitting beside each other in one packet is how a reader picks the wrong one.
 *
 * ⚠ AND `steps` AND `engineMode` ARE NOT ARGUMENTS OF `mv_generate_clip`. They
 * are the PROJECT's brief (`brief.videoSteps`, `brief.videoEngine`), which on an
 * ordinary project is a setting for forty-four scenes at once. They can ride in
 * an order because the receiver builds a project that is ONE SCENE LONG for the
 * errand — see errand.js — so the brief and the order say the same thing by
 * construction. Do not add them as item arguments; the plan item stays the
 * canonical `{slug, segment}` plus a seed.
 *
 * The return's shape check is the order's own fields read backwards, so both
 * live here: two files would drift, and a drift between what was ordered and
 * what is accepted is the one gap this module exists to close.
 */

import { createHash, randomBytes } from "node:crypto";
import { assertSafe } from "../safety/refusal.js";

/* The one rule for "this step count overruns the speed-up file that loaded",
 * shared with the Plan card's floor note and the lender's accept check
 * (lending.js speedUpCheck), so the three cannot disagree about a render. */
import { trapBand } from "../mv/plancost.js";
import { MV_SIZES, MV_ASPECTS, MV_SIZE_DEFAULT, renderSizeOf } from "../mv/sizes.js";

export const ORDER_V = 1;

/** ⚠ EXACTLY FOUR WORDS. See the header for why the fourth is `engineMode`. */
export const ORDER_KEYS = Object.freeze(["segmentId", "seed", "steps", "engineMode"]);

/** What `brief.videoEngine` admits — server/mv/routes.js's own enum. */
export const ENGINE_MODES = Object.freeze(["h3", "ltx", "hybrid"]);

/* The bounds are the ones the app already enforces on itself, read rather than
 * invented: steps is the bounded integer `brief.videoSteps` takes, and a seed is
 * whatever `rollSeed()` can produce — `Math.floor(Math.random() * 4294967296)`
 * in server/mv/generate.js. An order may not ask for a number this machine
 * would not have chosen for itself. */
export const STEPS_MIN = 2;
export const STEPS_MAX = 40;
export const SEED_MAX = 4294967295;

/** Encoder slack on a returned take's frame count, around the count the
 *  renderer's own grid gives (lending.js expectForOrder), never around a
 *  length rounded by hand. */
export const FRAME_SLACK = 4;

/** The longest an order may stand. A sealed file is forever otherwise. */
export const MAX_HOURS = 24 * 14;

/** ⚠ AND A CAP ON HOW MANY PICTURES ONE ORDER MAY CARRY. The byte cap alone
 *  does not bound the COUNT: a hundred thousand one-byte rows passed it, and
 *  each one is a hash, a magic-byte read and a file written while the server is
 *  blocked. H3's own named-reference input takes nine. */
export const FILES_CAP = 12;

/* Caps. A reference sheet is a picture, and a picture that is eight megabytes
 * is already generous; the order cap is what a scene with the nine-picture
 * reference limit could legitimately weigh. */
export const REF_BYTES_CAP = 8 * 1024 * 1024;
export const ORDER_BYTES_CAP = 24 * 1024 * 1024;
export const RETURN_BYTES_CAP = 64 * 1024 * 1024;

/** Magic bytes for the three picture formats a sheet may be in. A sheet is a
 *  picture; anything else arriving under that name is not a mislabelled file,
 *  it is a file that wants to be opened by something other than a decoder. */
const PICTURE_MAGIC = [
  { ext: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { ext: "webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF….WEBP, checked below
];

const FP_RE = /^[0-9a-f]{32}$/;
const ORDER_ID_RE = /^o_[0-9a-f]{12}$/;
/** What may sit inside `peer:<fp>:` — provenance.js's own four classes. */
const INNER_ACTOR_RE = /^(user|system|agent:[a-z0-9_.:-]{1,40}|script:[a-z0-9_.-]{1,40})$/i;
const SEG_RE = /^[A-Za-z0-9_]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function refuse(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** True only for a picture this machine would be willing to decode. */
function looksLikePicture(buf) {
  for (const m of PICTURE_MAGIC) {
    if (buf.length < m.bytes.length) continue;
    if (!m.bytes.every((b, i) => buf[i] === b)) continue;
    /* RIFF is also a WAV and an AVI; the WEBP tag is four bytes further in. */
    if (m.ext === "webp" && buf.subarray(8, 12).toString("ascii") !== "WEBP") continue;
    return m.ext;
  }
  return null;
}

/** The longest anything a person will read may be. A prompt is shown whole on a
 *  consent card; everything else is a label. */
export const PROMPT_CAP = 8000;
const LABEL_CAP = 200;

/** The sizes this app can render, in both shapes, read off server/mv/sizes.js
 *  (it was six typed pairs, which would have refused a friend's order at a card
 *  tier's 960x544). A packet asking for anything else cannot be reproduced here,
 *  and is refused rather than rendered at another size. */
const SIZES = Object.freeze(MV_ASPECTS.flatMap((aspect) => MV_SIZES.map((sz) =>
  renderSizeOf({ qualityMode: sz.id, aspectRatio: aspect }))));

/**
 * A shot packet, checked as far as this module needs it — which is further than
 * "is it the right shape".
 *
 * ⚠ THE NUMBERS IN THE PACKET WRITE THE CONSENT CARD, so they are somebody
 * else's numbers describing work this machine will do. `seconds` was unchecked:
 * a packet claiming 0.001 seconds made the card read "0.001s" for a render that
 * takes as long as any other, and one claiming a million pushed the rest of the
 * sentence off anything a person would read. A card built from unvalidated
 * numbers is a forged card, and the card is the whole consent.
 */
function isShotPacket(shot) {
  return !!shot && typeof shot === "object" && shot.kind === "shot" && Number(shot.v) === 1
    && typeof shot.segmentId === "string" && typeof shot.prompt === "string";
}

/** The wordless flags a shot's pictures carry (packet.js puts `safety` on
 *  each reference and guide row). Junk is ignored by the check, and a flag
 *  can only ever add a half. */
export const shotFlags = (shot) => [...(Array.isArray(shot?.refs) ? shot.refs : []), ...(Array.isArray(shot?.guides) ? shot.guides : [])]
  .map((r) => r?.safety).filter((f) => f && typeof f === "object");

function checkShot(shot, { context = [] } = {}) {
  const secs = Number(shot.seconds);
  /* A floor as well as a ceiling: 0.001 passed a "greater than zero" test and
   * made the consent card read "0.001s" for a render that costs exactly as much
   * as any other. Half a second is below anything this app makes. */
  if (!Number.isFinite(secs) || secs < 0.5 || secs > 120) {
    throw refuse("bad-shot", `That scene claims to be ${JSON.stringify(shot.seconds)} seconds long. A scene is between half a second and two minutes, and its length is half of what a person agrees to when they agree to render it.`);
  }
  if (!SIZES.some(([w, h]) => w === Number(shot.width) && h === Number(shot.height))) {
    throw refuse("size-unreproducible", `That scene asks for ${shot.width}x${shot.height}, which is not a size this Studio can make — it renders at ${SIZES.map(([w, h]) => `${w}x${h}`).join(", ")}.`);
  }
  if (String(shot.prompt).length > PROMPT_CAP) {
    throw refuse("bad-shot", `That scene's prompt is ${String(shot.prompt).length} characters. A prompt has to be readable by the person deciding whether to render it, and this one is longer than anything a person reads.`);
  }
  /* ⚠ THE MINORS RULE, ON BOTH SIDES OF A LOAN. This one function runs when
   * an order is SEALED (makeOrder, on the sender) and when it is ACCEPTED
   * (readOrder, on the lender), so a scene that pairs a child or teenager with
   * sexual content can neither be sent nor be taken on. The prompt is the
   * frozen text the lender would render verbatim; the negative is not intent.
   * The prompt names its cast only by NAME, so what each picture was made as
   * travels beside it as two booleans (shotFlags) and is read on both sides;
   * the sender also adds the cast's own words (`context`), which never leave
   * its machine. Throws a 422 with the one sentence (server/safety/refusal.js). */
  assertSafe({ door: "collab.order", via: "collab", texts: [String(shot.prompt)], context, flags: shotFlags(shot) });
  for (const k of ["segmentId", "engine", "engineMode", "mode", "promptSource", "guideMode", "negative", "songUnder"]) {
    if (shot[k] !== undefined && shot[k] !== null && String(shot[k]).length > LABEL_CAP) {
      throw refuse("bad-shot", `That scene's ${k} is far longer than a label should be.`);
    }
  }
  return shot;
}

/** Every file a shot packet names, as `file` → the row that named it. */
function shotFiles(shot) {
  const out = new Map();
  for (const r of [...(shot.refs || []), ...(shot.guides || [])]) {
    if (r && typeof r.file === "string" && r.file) out.set(r.file, r);
  }
  return out;
}

/**
 * Build an order: four words, one shot packet, and the pictures it names.
 *
 * ⚠ THE PICTURES TRAVEL AS BYTES AND THAT IS NOT A WIDENING OF THE VOCABULARY.
 * Nothing in this repo moves a picture between machines: `hashAsset` measures
 * and hashes, and every packet carries `{name, sha256, bytes, file}` where
 * `bytes` is a COUNT. So an order that was only a pointer — the design's
 * `{slug, docSha256, segmentId}` — would point at nothing on the far side. The
 * four words still name no graph, no tool, no prompt, no model and no path;
 * they ride beside a packet whose contents packet.js already decides are safe to
 * send, and beside bytes that are content-addressed and renamed by the receiver.
 *
 * `files[].file` is a JOIN KEY into the shot packet, never a path. The receiver
 * derives every name it writes from the bytes it holds.
 *
 * (A `refs[]` row carries `{name, sha256, bytes, file}` and a `guides[]` row
 * carries no `name` — it is a frame rather than a character — so the join is on
 * `file`, which both have, and nothing here reads `name` off a guide.)
 */
export function makeOrder({ shot, files = [], order, returnTo, expiresInHours = 48, now = 0, id = null, safetyContext = [] } = {}) {
  if (!isShotPacket(shot)) {
    throw refuse("bad-arguments", "An order carries one shot packet, and what was passed is not one. Build it with packet.js shotPacket() — that function is where the decision about what may leave this machine lives, and an order must not make that decision a second time.");
  }
  checkShot(shot, { context: safetyContext });
  if (!returnTo || typeof returnTo !== "object" || !FP_RE.test(String(returnTo.fp || ""))) {
    throw refuse("bad-arguments", "An order must say where the finished take goes back to: returnTo.fp is this machine's own 32-character fingerprint.");
  }
  const o = order && typeof order === "object" ? order : null;
  if (!o) throw refuse("order-keys", `An order's four words are ${ORDER_KEYS.join(", ")}, and none were given.`);

  /* ⚠ BOTH DIRECTIONS. A missing key is an under-specified render and an extra
   * key is a word nobody agreed on — and the extra is the dangerous half,
   * because the day somebody adds a fifth the receiver must not quietly honour
   * it. */
  const given = Object.keys(o);
  const extra = given.filter((k) => !ORDER_KEYS.includes(k));
  const missing = ORDER_KEYS.filter((k) => !given.includes(k));
  if (extra.length || missing.length) {
    throw refuse("order-keys",
      `An order says exactly ${ORDER_KEYS.join(", ")} and nothing else.`
      + (missing.length ? ` Missing: ${missing.join(", ")}.` : "")
      + (extra.length ? ` Not part of the vocabulary: ${extra.join(", ")}. A word both machines have not agreed on is a word the receiver would have to guess at.` : ""));
  }
  if (!SEG_RE.test(String(o.segmentId || ""))) {
    throw refuse("bad-arguments", "segmentId must be a scene id like s1_24 — letters, digits and underscores.");
  }
  if (o.segmentId !== shot.segmentId) {
    throw refuse("bad-arguments", `The order asks for ${o.segmentId} and the shot packet is ${shot.segmentId}. They must be the same scene, or the lender renders one thing and is asked about another.`);
  }
  if (!Number.isInteger(o.steps) || o.steps < STEPS_MIN || o.steps > STEPS_MAX) {
    throw refuse("bad-steps", `steps must be a whole number from ${STEPS_MIN} to ${STEPS_MAX} — the same bound this Studio puts on its own renders. It is refused rather than clamped, because an order quietly rewritten is an order the lender did not agree to.`);
  }
  if (!ENGINE_MODES.includes(String(o.engineMode))) {
    throw refuse("bad-engine-mode", `engineMode must be one of ${ENGINE_MODES.join(", ")}.`);
  }
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > SEED_MAX) {
    throw refuse("bad-seed", `seed must be a whole number from 0 to ${SEED_MAX}, which is the range this Studio's own roll produces. A seed is what makes a lend reproducible; without one the take cannot be checked against anything.`);
  }

  const named = shotFiles(shot);
  if ((Array.isArray(files) ? files.length : 0) > FILES_CAP) {
    throw refuse("order-too-big", `This order carries ${files.length} pictures and a scene takes at most ${FILES_CAP}. The byte limit alone does not bound the count — a hundred thousand one-byte rows pass it, and each one is a hash and a file written while the machine is blocked.`);
  }
  const rows = [];
  let total = 0;
  const seen = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    const name = String(f?.file || "");
    if (!named.has(name)) {
      throw refuse("file-not-in-shot", `${JSON.stringify(name)} is not a picture this shot asks for. An extra file is an extra byte nobody reviewed, and the shot packet is the review.`);
    }
    if (seen.has(name)) throw refuse("file-not-in-shot", `${name} was attached twice.`);
    seen.add(name);
    const buf = Buffer.from(String(f.b64 || ""), "base64");
    if (!buf.length) throw refuse("file-hash", `${name} carries no bytes.`);
    if (buf.length > REF_BYTES_CAP) {
      throw refuse("file-too-large", `${name} is ${Math.round(buf.length / 1048576)} MB and the limit for one picture is ${REF_BYTES_CAP / 1048576} MB.`);
    }
    total += buf.length;
    if (total > ORDER_BYTES_CAP) {
      throw refuse("order-too-big", `This order's pictures come to more than ${ORDER_BYTES_CAP / 1048576} MB together. Send fewer scenes at a time.`);
    }
    const digest = sha256(buf);
    if (digest !== named.get(name).sha256) {
      throw refuse("file-hash", `${name} does not hash to what the shot packet says it should. The bytes and the packet disagree, so one of them is not what it was when the packet was built.`);
    }
    const kind = looksLikePicture(buf);
    if (!kind) {
      throw refuse("file-type", `${name} is not a png, jpeg or webp. A reference sheet is a picture; a file that is something else under a picture's name is not a mislabelled file, it is a file that wants to be opened by something other than a decoder.`);
    }
    rows.push({ file: name, role: (shot.refs || []).some((r) => r.file === name) ? "ref" : "guide", sha256: digest, bytes: buf.length, b64: buf.toString("base64") });
  }
  for (const name of named.keys()) {
    if (!seen.has(name)) {
      throw refuse("file-missing", `The shot asks for ${name} and no bytes for it were attached. A lender cannot render a scene whose pictures did not travel, and a scene rendered without them is a stranger.`);
    }
  }

  const at = Number(now) || 0;
  if (!at) throw refuse("bad-arguments", "Pass `now` — the moment, so an order is reproducible in a test.");
  /* ⚠ AN ID THE ORDER BOOK CANNOT STORE DISARMS THE DOUBLE-SPEND GUARD. The
   * book keys on `o_` and twelve hex; an id outside that shape makes every
   * `landOrderRow` refuse with `bad-arguments`, so the same bundle can be
   * accepted again and again and the book never learns. Checked where the id
   * enters rather than where it is written down. */
  if (id !== null && !ORDER_ID_RE.test(String(id))) {
    throw refuse("bad-arguments", `${JSON.stringify(String(id))} is not an order id. An id is "o_" and twelve hexadecimal characters, which is the only shape the order book can remember — and an order it cannot remember is one this machine cannot tell it has already rendered.`);
  }
  const hours = Math.max(1, Math.min(MAX_HOURS, Number(expiresInHours) || 48));
  return {
    v: ORDER_V,
    kind: "order",
    id: id || `o_${randomBytes(6).toString("hex")}`,
    at,
    /* ⚠ AN ORDER EXPIRES. A sealed file is forever otherwise: a bundle found in
     * a folder eighteen months later would still be a live instruction to spend
     * somebody's card, and the person who sent it has long stopped expecting a
     * take. Capped at a fortnight. */
    expires: at + hours * 3600_000,
    returnTo: { fp: String(returnTo.fp).toLowerCase(), nickname: String(returnTo.nickname || "").slice(0, 40) },
    order: { segmentId: o.segmentId, seed: o.seed, steps: o.steps, engineMode: o.engineMode },
    shot,
    files: rows,
    note: "One scene. Nothing here names a graph, a tool, a model, or a file on your disk.",
  };
}

/**
 * Read an order somebody sent, and refuse it before anything is written.
 *
 * ⚠ THE PATH DISPATCHES ON `kind` AND REFUSES AN UNRECOGNISED ONE. It was once
 * true that the door only DISPLAYED `packet.kind`; the accept branch in this
 * same change is the first that runs work on it, which is why this refusal is
 * the first line of the function rather than a note about a future one.
 */
export function readOrder(payload, { now = 0, myFp = null } = {}) {
  const p = payload && typeof payload === "object" ? payload : null;
  if (!p || p.kind !== "order" || Number(p.v) !== ORDER_V) {
    throw refuse("not-an-order", `This is not a version ${ORDER_V} order. If your friend's Studio is newer than yours, ask them which version it sealed.`);
  }
  if (myFp && String(p.returnTo?.fp || "").toLowerCase() === String(myFp).toLowerCase()) {
    /* ⚠ THE REFLECTOR. Nothing else stops a bundle whose return address is the
     * LENDER's own machine: accept one and this Studio renders a stranger's
     * scene and posts it back to itself, which turns a lender into a relay for
     * somebody else's render budget and puts their pictures on our disk. */
    throw refuse("order-to-myself", "This order says to return the finished take to this very machine. An order is a request to spend your card on somebody else's work and send it back to THEM; one addressed here is either a mistake or a way of using you as a relay. Nothing was accepted.");
  }
  /* Re-run the maker's own checks over what arrived, which is the point of the
   * two halves living in one file: there is one list, not a sender's list and a
   * receiver's list that drift. */
  const rebuilt = makeOrder({
    shot: p.shot, files: p.files, order: p.order, returnTo: p.returnTo,
    now: Number(p.at) || 1, id: p.id,
  });
  /* ⚠ ONE EXPIRY, COMPUTED ONCE, USED FOR BOTH THE REFUSAL AND THE ANSWER.
   * The first version guarded with `if (when && Number(p.expires) && …)`, so a
   * payload that simply DELETED the field short-circuited the whole check — and
   * then returned the wire value verbatim, so an order could also claim to
   * expire in the year 2500. Measured at the door: the same bundle was refused
   * with its field intact and accepted with it deleted, and the accepting reply
   * described it as "Expired." in the same breath. The fortnight cap is applied
   * here as well as at the maker, because only one of those two runs on a
   * payload somebody else built. */
  const when = Number(now) || 0;
  const expires = Math.min(Number(p.expires) || rebuilt.expires, (Number(p.at) || rebuilt.at) + MAX_HOURS * 3600_000);
  if (when && when > expires) {
    throw refuse("order-expired", `This order expired ${Math.round((when - expires) / 3600_000)} hours ago. Ask your friend to send it again if they still want it rendered — an old order is a live instruction to spend your card that nobody is waiting on.`);
  }
  return { ...rebuilt, id: String(p.id || rebuilt.id), at: Number(p.at) || rebuilt.at, expires };
}

/**
 * The plan item an order becomes.
 *
 * ⚠ TWO ARGUMENTS AND A SEED, because that is `mv_generate_clip`'s real
 * vocabulary. `steps` and `engineMode` are NOT arguments of it; they are the
 * errand project's brief. An item carrying an argument the tool does not take is
 * an argument silently dropped.
 */
export function orderPlanItem(orderDoc, slug, segment) {
  /* ⚠ THE SEGMENT IS THE ERRAND'S, NOT THE ORDER'S, AND THEY ARE NEVER THE SAME.
   * An order names a scene in the OWNER's project — `s1_24` — and the errand
   * built from it has exactly one scene, called `s1_0`. Naming the owner's id
   * here proposes an item for a scene the project does not contain, and every
   * order for anything but a first scene fails at render time. It is a required
   * argument rather than a default so that a caller cannot forget it. */
  const seg = String(segment || "");
  if (!seg) throw refuse("bad-arguments", "orderPlanItem needs the segment id of the scene IN THE PROJECT THE ITEM WILL RUN AGAINST, which for an errand is its only scene and is never the order's own id.");
  return {
    tool: "mv_generate_clip",
    args: { slug: String(slug), segment: seg, seed: orderDoc.order.seed },
  };
}

/**
 * The brief the errand project must carry so that the render this machine
 * performs is the render that was ordered.
 *
 * ⚠ THE SIZE IS INVERTED OUT OF THE PACKET, NOT COPIED FROM IT. `renderSize`
 * (server/mv/generate.js, and a second identical copy in packet.js) reads
 * `brief.qualityMode` and `brief.aspectRatio` — it does not read a width and a
 * height. So a packet asking for 1920x1088 is honoured by setting
 * `qualityMode: "high"`, and a size that is not one of the pairs those two
 * dials produce cannot be reproduced at all and is refused rather than rendered
 * at a different size than the Accept card promised. The pairs are read off
 * server/mv/sizes.js, the list renderSize itself reads, so an order for a card
 * tier (960x544, 832x480) inverts as surely as the three older sizes did.
 */
export function briefFor(orderDoc) {
  const { width, height } = orderDoc.shot;
  const TABLE = MV_ASPECTS.flatMap((aspect) => MV_SIZES.map((sz) => {
    const [w, h] = renderSizeOf({ qualityMode: sz.id, aspectRatio: aspect });
    return [w, h, sz.id === MV_SIZE_DEFAULT ? null : sz.id, aspect];
  }));
  const hit = TABLE.find((r) => r[0] === width && r[1] === height);
  if (!hit) {
    throw refuse("size-unreproducible", `This order asks for ${width}x${height}, and this Studio's renders are sized by two dials rather than by a number: the sizes it can make are ${TABLE.map((r) => `${r[0]}x${r[1]}`).join(", ")}. Rendering a different size than the order says would be a take that does not fit the scene it was asked for.`);
  }
  const brief = {
    videoSteps: orderDoc.order.steps,
    videoEngine: orderDoc.order.engineMode,
    aspectRatio: hit[3],
    /* The cast pictures travel with the order, so references are on; the
     * storyboard-as-reference is off because no storyboard travelled. */
    castRefs: true,
    boardRef: false,
  };
  if (hit[2]) brief.qualityMode = hit[2];
  if (orderDoc.shot.baseScale !== null && orderDoc.shot.baseScale !== undefined) {
    brief.baseScale = orderDoc.shot.baseScale;
  }
  return brief;
}

/**
 * One sentence for the card a person reads before they say yes.
 *
 * ⚠ IT SAYS WHAT WILL BE RENDERED, NOT ONLY HOW BIG. The first version named
 * the scene, the size, the engine, the steps, the seed and the picture count —
 * the SHAPE of the work and nothing about its CONTENT. A person approving that
 * has agreed to spend an hour of their card; they have not agreed to what comes
 * out of it, and what comes out of it is a file on their disk. The prompt is the
 * thing being agreed to.
 */
export function describeOrder(orderDoc, now = 0) {
  const o = orderDoc?.order || {};
  const s = orderDoc?.shot || {};
  const pics = (orderDoc?.files || []).length;
  const left = Number(orderDoc?.expires) && now
    ? Math.round((Number(orderDoc.expires) - now) / 3600_000)
    : null;
  const prompt = String(s.prompt || "");
  /* ⚠ LIP-SYNC DOES NOT TRAVEL, AND THE SENTENCE BOTH PEOPLE READ SAYS SO. The
   * song never leaves the owner's machine (packet.js), so a scene the owner
   * renders with the song under it — a singing board, or "Song under the clip:
   * always" — comes back rendered without it. It is lent anyway, because a
   * silent take beats no take for somebody with no card; it is said here, at
   * preview, on the lender's card and in the returned take's notes. */
  const lipSync = s.songUnder === "lipsync" || s.songUnder === "always";
  return `One scene (${o.segmentId}), ${s.seconds ?? "?"}s at ${s.width}x${s.height} on ${o.engineMode} at ${o.steps} steps, seed ${o.seed}, with ${pics} picture${pics === 1 ? "" : "s"}.`
    + (left !== null ? ` ${left > 0 ? `Expires in ${left} hours.` : "Expired."}` : "")
    + (lipSync ? ` ⚠ Lip-sync does not travel: the owner renders this scene with the song under it (${s.songUnder === "lipsync" ? "a singing board" : "“Song under the clip: always”"}), the song stays on the owner's machine, and this take is rendered without it — mouths will not follow the vocal.` : "")
    + (prompt ? ` It will render: "${prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt}"` : " It carries no prompt at all, which is itself a reason not to run it.");
}

/* ───────────────────────────────────────────────── what comes back */

export const RETURN_V = 1;

/**
 * Build the return: the finished take, what the machine that made it was, and
 * what its own catalogue says about the rights on it.
 *
 * ⚠ THE LENDER'S MODEL AND RIGHTS TRAVEL WITH THE PIXELS. The owner's Studio
 * must not look them up: the weights that made this clip are on the LENDER's
 * disk under the LENDER's licence, and a receiver that stamps its own catalogue
 * answer is writing a licence claim about a file it did not make.
 */
export function makeReturn({ orderId, segmentId, result, probe, record, now = 0 } = {}) {
  const buf = Buffer.isBuffer(result?.bytes) ? result.bytes : null;
  if (!buf) throw refuse("bad-arguments", "Pass the finished clip as result.bytes, a Buffer.");
  if (buf.length > RETURN_BYTES_CAP) {
    throw refuse("return-too-big", `That clip is ${Math.round(buf.length / 1048576)} MB and the limit is ${RETURN_BYTES_CAP / 1048576} MB.`);
  }
  if (!record?.model) throw refuse("record-no-model", "A return must say which model made it. Without that the owner cannot tell what licence the pixels arrived under.");
  if (!record.outputRights || typeof record.outputRights !== "object" || !record.outputRights.class) {
    /* ⚠ `null` IS NOT "NO ANSWER", IT IS A SUPPRESSED STAMP. provenance.js
     * `stampRights` returns early on `data.outputRights !== undefined`, and null
     * satisfies that — so a return carrying null would be adopted into a ledger
     * line that says nothing about rights, quietly, forever. */
    throw refuse("record-no-rights", "A return must carry the lender's own answer about output rights. A missing one is not a blank: it would be written into the owner's ledger as a line that says nothing, and the ledger is the only place that question is ever answered.");
  }
  const at = Number(now) || 0;
  if (!at) throw refuse("bad-arguments", "Pass `now`.");
  return {
    v: RETURN_V,
    kind: "return",
    orderId: String(orderId || ""),
    segmentId: String(segmentId || ""),
    at,
    result: { sha256: sha256(buf), bytes: buf.length, ext: String(result.ext || ".mp4"), b64: buf.toString("base64") },
    probe: probe || null,
    record: {
      model: String(record.model), modelVersion: record.modelVersion ?? null,
      outputRights: record.outputRights,
      engine: record.engine ?? null, steps: record.steps ?? null, seed: record.seed ?? null,
      ms: record.ms ?? null,
      /* The step count the speed-up file this render loaded was made for, or
       * null where none loads. A number and never a file name: the owner is
       * told the two counts disagree, not what is on the lender's disk. */
      turboSteps: Number.isInteger(record.turboSteps) ? record.turboSteps : null,
      /* The lender's OWN actor string, unqualified. The owner prefixes it with
       * `peer:<their fp>:` on adoption — see credit.js's fifth actor class. */
      actor: String(record.actor || "system"),
    },
    note: "Rendered here. The model and its licence are this machine's stamp, not yours.",
  };
}

/** Read a return, as far as its own shape goes. What it is checked AGAINST is
 *  `checkReturn`, because that needs the order it answers. */
export function readReturn(payload) {
  const p = payload && typeof payload === "object" ? payload : null;
  if (!p || p.kind !== "return" || Number(p.v) !== RETURN_V) {
    throw refuse("not-a-return", `This is not a version ${RETURN_V} return.`);
  }
  const buf = Buffer.from(String(p.result?.b64 || ""), "base64");
  if (!buf.length) throw refuse("result-hash", "The return carries no clip.");
  if (buf.length > RETURN_BYTES_CAP) throw refuse("return-too-big", `That clip is over the ${RETURN_BYTES_CAP / 1048576} MB limit.`);
  if (sha256(buf) !== String(p.result.sha256)) {
    throw refuse("result-hash", "The clip in this return does not hash to what the return says it should. Nothing was written. Ask your friend to send it again.");
  }
  if (!p.record?.model) throw refuse("record-no-model", "This return does not say which model made it.");
  /* ⚠ AND IT IS BOUNDED. The rights object is written into the owner's ledger
   * and printed on their screen, and it was neither capped nor depth-limited: a
   * twenty-megabyte string, or an object nested deeply enough to blow the stack
   * in `JSON.stringify`, rode home on a one-byte clip. */
  const rights = p.record.outputRights;
  if (rights && typeof rights === "object") {
    let text = null;
    try { text = JSON.stringify(rights); } catch { text = null; }
    if (text === null || text.length > 4000) {
      throw refuse("record-no-rights", "This return's rights answer is either too large to store or too deeply nested to read. A rights row is a class and a sentence, not a document.");
    }
  }
  /* ⚠ `{}` IS NOT AN ANSWER EITHER, and it is worse than none: an empty object
   * satisfies `!== undefined`, so `stampRights` keeps it, and the project's
   * rights line becomes a shape with nothing in it — which reads on a screen as
   * "answered" rather than as "unknown". */
  if (!p.record.outputRights || typeof p.record.outputRights !== "object" || !p.record.outputRights.class) {
    throw refuse("record-no-rights", "This return carries no usable answer about output rights — a rights row needs at least a `class`. A blank or an empty one would be written into your ledger as a line that looks answered and says nothing.");
  }
  /* ⚠ AN ACTOR NOBODY CAN PARSE ERASES THE FINGERPRINT. The owner builds
   * `peer:<their fp>:<this string>`, and `normalizeActor` flattens the whole
   * thing to `system` when the inner half is not one of the four it knows — so
   * a lender writing `record.actor: "!"` would have their work filed as the
   * OWNER's machine rather than as theirs. It is normalised here, where the
   * return is read, and the fallback keeps the fingerprint. */
  if (!INNER_ACTOR_RE.test(String(p.record.actor || ""))) {
    p.record.actor = "system";
  }
  /* A number the owner's notes quote, so it is bounded like one. */
  const turbo = p.record.turboSteps;
  p.record.turboSteps = Number.isInteger(turbo) && turbo >= 1 && turbo <= STEPS_MAX ? turbo : null;
  return { doc: p, bytes: buf };
}

/**
 * Is this return the answer to that order?
 *
 * `ourProbe` is what THIS machine measured about the file, so the lender's own
 * probe can be compared against it. That check is cheap and it is the one that
 * catches a record somebody edited: a doctored `record` is easy, a doctored
 * record that also survives the receiver's own ffprobe is not.
 */
export function checkReturn(returnDoc, orderRow, ourProbe = null) {
  /* ⚠ NOTES ARE NOT CHECKS. They ride on the verdict either way and change
   * nothing about it: what the borrower should know about how this take was
   * made, said in this machine's words from numbers the return carries. */
  const notes = returnNotes(returnDoc, orderRow);
  const bad = (reason, why) => ({ ok: false, reason, why, notes });
  if (!orderRow) return bad("return-unknown-order", `This return answers order ${returnDoc.orderId}, which is not one this machine sent. Nothing was adopted.`);
  if (String(orderRow.to?.fp || "").toLowerCase() !== String(returnDoc.from || orderRow.to?.fp || "").toLowerCase() && returnDoc.from) {
    return bad("return-not-my-order", `Order ${returnDoc.orderId} went to ${orderRow.to?.nickname || orderRow.to?.fp} and this return came from somebody else.`);
  }
  if (returnDoc.segmentId !== orderRow.order?.segmentId) {
    return bad("return-scene-not-in-order", `This return is for scene ${returnDoc.segmentId} and the order asked for ${orderRow.order?.segmentId}.`);
  }
  /* ⚠ A MISSING NUMBER IS NOT A PASS. Both checks used to skip when the field
   * was absent, so a return that simply omitted `seed` and `steps` was accepted
   * — and the success sentence then told the owner it had been checked "at the
   * seed and the steps it named". The whole reason an order names a seed is
   * that the take can be checked against it. */
  const r = returnDoc.record || {};
  if (!Number.isFinite(Number(r.seed))) {
    return bad("record-seed", "This return does not say what seed it was rendered at, so there is nothing to check it against. The order named one precisely so that the take could be.");
  }
  if (Number(r.seed) !== Number(orderRow.order?.seed)) {
    return bad("record-seed", `The order asked for seed ${orderRow.order?.seed} and this was rendered at ${r.seed}. A different seed is a different clip.`);
  }
  if (!Number.isFinite(Number(r.steps))) {
    return bad("record-steps", "This return does not say how many steps it was rendered at.");
  }
  if (Number(r.steps) !== Number(orderRow.order?.steps)) {
    return bad("record-steps", `The order asked for ${orderRow.order?.steps} steps and this was rendered at ${r.steps}.`);
  }
  const want = orderRow.expect || null;
  const probe = ourProbe || returnDoc.probe || null;
  if (want && probe) {
    if (Number(probe.width) !== Number(want.width) || Number(probe.height) !== Number(want.height)) {
      return bad("result-not-the-shot", `This clip is ${probe.width}x${probe.height} and the scene is ${want.width}x${want.height}.`);
    }
    if (Number(probe.videoStreams) !== 1) {
      return bad("result-not-the-shot", `This file has ${probe.videoStreams} video streams and a clip has one.`);
    }
    if (Number(probe.audioStreams) > 0) {
      return bad("result-not-the-shot", "This clip has an audio track on it. A scene comes back silent; the song is added here, and a track that arrived from somewhere else is a track nobody chose.");
    }
    /* A frame count is allowed a little slack — encoders round — but not much,
     * because the length is what makes it fit the scene.
     *
     * ⚠ AROUND THE RENDERER'S OWN COUNT, NOT A HAND-ROUNDED ONE. The centre
     * used to be round(seconds * 24), and H3 rounds a clip UP to its 17k+5
     * grid — a 6 s scene renders 158 frames — so a correct H3 take was refused
     * by 14 frames. The row now carries the engine's own count
     * (lending.js expectForOrder), and `framesAny` lists the centres a row
     * written before that may have meant (lending.js framesAccepted). */
    const centres = (Array.isArray(want.framesAny) && want.framesAny.length ? want.framesAny : [want.frames])
      .map(Number).filter(Number.isFinite);
    if (centres.length && Number.isFinite(probe.frames)
        && !centres.some((c) => Math.abs(probe.frames - c) <= FRAME_SLACK)) {
      const grid = want.engine === "h3" ? ", which H3 renders in steps of 17 frames"
        : want.engine === "ltx" ? ", which LTX renders in steps of 8 frames" : "";
      return bad("result-not-the-shot", `This clip is ${probe.frames} frames and the scene wants about ${centres.join(" or ")}`
        + `${Number.isFinite(Number(want.seconds)) ? ` (${Number(want.seconds).toFixed(2)} s on ${want.engine || "its engine"}${grid})` : ""}.`);
    }
  }
  if (ourProbe && returnDoc.probe) {
    for (const k of ["width", "height", "videoStreams"]) {
      if (Number(ourProbe[k]) !== Number(returnDoc.probe[k])) {
        return bad("return-probe-disagrees", `Your friend's Studio measured this clip's ${k} as ${returnDoc.probe[k]} and this machine measures ${ourProbe[k]}. The record and the file disagree, so one of them was edited.`);
      }
    }
  }
  return { ok: true, reason: null, why: "This is the clip that order asked for, at the seed and the steps it named, and it measures the way the scene needs.", notes };
}

/**
 * What the borrower should know about how a returned take was made. Sentences
 * composed HERE from numbers — the return carries no prose that reaches this
 * screen.
 */
export function returnNotes(returnDoc, orderRow) {
  const notes = [];
  const r = returnDoc?.record || {};
  /* ⚠ NOT `Number(r.turboSteps)`: that turns "no speed-up file" (null) into 0,
   * and every take rendered without one read as "made for 0 steps".
   *
   * ⚠ ONE RULE ON BOTH MACHINES: plancost's `trapBand`, given the step count
   * of the file that really loaded on the lender's PC. The lender's accept
   * card asked the same function (lending.js speedUpCheck), so a take is
   * noted here exactly when the lender was warned there. */
  const steps = Number(r.steps), turbo = r.turboSteps;
  if (Number.isInteger(turbo) && turbo > 0 && trapBand(steps, { loaded: turbo })) {
    notes.push(`Rendered at ${steps} steps on your friend's PC with a speed-up file made for ${turbo} steps, and ${steps} steps overruns it, so it may look burned or over-sharpened. To match the file their PC has, order ${turbo} steps next time: Collab → Send → “Pin the exact numbers” → Steps.`);
  }
  if (orderRow?.songUnder === "lipsync" || orderRow?.songUnder === "always") {
    notes.push("Rendered without the song under it: the song stays on your machine, so on a lent scene the mouths do not follow the vocal. Render this scene here if the lip-sync matters.");
  }
  return notes;
}
