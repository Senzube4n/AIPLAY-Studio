import * as recipeM from "./video-recipe.js";
/**
 * COLLAB, phase one: an identity, a roster, a sealed courier and two units.
 *
 * What this lane is really for is the SECURITY PROPERTIES, because they are the
 * ones nobody notices when they break. An adversarial review of the first draft
 * of these four files found, among other things, a fingerprint that did not
 * commit to the two keys it was made from — the reviewer built a forged key
 * card carrying a victim's exact fingerprint and twelve words, which would have
 * landed in the roster as that victim. Nearly every line below is here because
 * something once did not hold, and the comment above it says which.
 *
 * It runs on the CPU, writes only into a throwaway directory, and needs no
 * engine, no card and no network.
 */
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

import { identity, privateKeys, fingerprint, words, keyCard, readKeyCard, WORDLIST } from "./identity.js";
import { sealTo, openSealed } from "./seal.js";
import * as roster from "./roster.js";
import { shotPacket, projectBundle, describePacket } from "./packet.js";
import { createPreviewStore, assertPreviewFresh } from "./preview.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** The reason a call refused, or null if it did not refuse at all. Reasons are
 *  what routes branch on, so this lane pins the reason and not the wording. */
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e?.reason ?? `(no reason: ${e?.message || e})`; }
}

const appData = await mkdtemp(path.join(tmpdir(), "aiplay-collab-"));
const appData2 = await mkdtemp(path.join(tmpdir(), "aiplay-collab-"));

console.log("\n§1  the word list, which is an index and not a vocabulary");
{
  eq("it is exactly 256 long, one word per byte", WORDLIST.length, 256);
  eq("...every entry distinct", new Set(WORDLIST).size, 256);
  eq("...no two share their first three letters, because that is how a word is read out",
    new Set(WORDLIST.map((w) => w.slice(0, 3))).size, 256);
  ok("...all short enough to say over a telephone", WORDLIST.every((w) => w.length >= 3 && w.length <= 7));
  ok("...and lower case with no punctuation", WORDLIST.every((w) => /^[a-z]+$/.test(w)));
}

console.log("\n§2  the identity: made on first use, never at import");
{
  const me = await identity({ appData });
  eq("the fingerprint is 128 bits as 32 hex characters", [me.fp.length, /^[0-9a-f]+$/.test(me.fp)], [32, true]);
  eq("...and asking twice is the same identity", (await identity({ appData })).fp, me.fp);
  ok("...the public keys come back, the private ones do not",
    !!me.signPublic && !!me.sealPublic && !("signPrivate" in me) && !("sealPrivate" in me));
  const priv = await privateKeys({ appData });
  ok("...the private keys have their own door", !!priv.signPrivate && !!priv.sealPrivate);
  eq("twelve words, all from the list", [words(me.fp).length, words(me.fp).every((w) => WORDLIST.includes(w))], [12, true]);
  ok("a different fingerprint reads as different words", words(me.fp).join(" ") !== words("f".repeat(32)).join(" "));

  /* ⚠ THE FORGERY THE FIRST DRAFT ALLOWED, and the line that closes it. The
   * fingerprint hashes the two keys concatenated with no length prefix, so the
   * boundary between them is only covered if each half is pinned to one length:
   * move the split and the digest is unchanged. A reviewer re-cut one real
   * 44+44 card at twenty-four different points and got the victim's exact
   * fingerprint every time, then built a key card from the 45/43 cut that
   * `readKeyCard` resolved to the victim. Both keys must be EXACTLY 44 bytes,
   * and this line is what stops that check being tidied away as redundant. */
  const raw = Buffer.concat([Buffer.from(me.signPublic, "base64"), Buffer.from(me.sealPublic, "base64")]);
  eq("the same 88 bytes cut anywhere but 44/44 are refused, not hashed",
    [...Array(25).keys()].map((i) => i + 32).filter((cut) => {
      try { return fingerprint(raw.subarray(0, cut).toString("base64"), raw.subarray(cut).toString("base64")) === me.fp; }
      catch { return false; }
    }), [44]);
  eq("...and a key of the right length under the wrong algorithm header too",
    await refusal(() => fingerprint(me.sealPublic, me.signPublic)), "bad-key");

  const card = keyCard({ ...me, nickname: "mika" });
  const back = readKeyCard(card);
  eq("a key card round-trips",
    [back.fp, back.nickname, back.signPublic === me.signPublic, back.sealPublic === me.sealPublic],
    [me.fp, "mika", true, true]);
  eq("...and what comes back is the card it came from", keyCard(back), card);
  eq("a card claiming a fingerprint its keys do not make is refused",
    await refusal(() => readKeyCard(card.replace(me.fp, "0".repeat(32)))), "fingerprint-mismatch");
  /* A card is split on ":", so everything after the last colon rides along in
   * field five: the outer trim does not stop a two-line paste, and the nickname
   * is what gets rendered on a screen. */
  eq("a card with a second line pasted onto it is refused, not silently renamed",
    await refusal(() => readKeyCard(`${card}\nsent from my phone`)), "bad-nickname");
  ok("a legitimate nickname still survives the trip",
    readKeyCard(keyCard({ ...me, nickname: "  Ada Lovelace  " })).nickname === "Ada Lovelace");
}

console.log("\n§3  the courier: bound to the recipient, signed, opened in the right order");
{
  const a = await identity({ appData }), b = await identity({ appData: appData2 });
  const aPriv = await privateKeys({ appData }), bPriv = await privateKeys({ appData: appData2 });
  const payload = Buffer.from(JSON.stringify({ kind: "shot", prompt: "a dark room" }), "utf8");
  const seal = (over = {}) => sealTo({
    payload, toSealPublicB64: b.sealPublic, toSignPublicB64: b.signPublic,
    toFp: b.fp, fromFp: a.fp, signPrivate: aPriv.signPrivate, ...over,
  });
  const blob = seal();
  ok("it is a container, not a blob: the first line names the format", blob.subarray(0, 11).toString() === "AIPLAYSEAL1");
  const opened = openSealed({ blob, me: b.fp, sealPrivate: bPriv.sealPrivate, senderSignPublicB64: a.signPublic });
  eq("the payload comes back exactly", opened.payload.toString("utf8"), payload.toString("utf8"));

  /* ⚠ THE SUBSTITUTION THE FIRST DRAFT SEALED ANYWAY. `toFp` and
   * `toSealPublicB64` were two unrelated arguments, so a roster row carrying a
   * friend's fingerprint beside an attacker's sealing key produced a bundle
   * that NAMED the friend and OPENED for the attacker — and the twelve words
   * read aloud were words for the fingerprint, which was the honest half. */
  eq("keys that do not hash to the fingerprint they are being sealed to are refused",
    await refusal(() => seal({ toSealPublicB64: a.sealPublic })), "bad-recipient");
  eq("...and the recipient's signing key is required, because the hash covers both",
    await refusal(() => seal({ toSignPublicB64: undefined })), "bad-recipient");

  eq("somebody else cannot open it, even holding it",
    await refusal(() => openSealed({ blob, me: a.fp, sealPrivate: aPriv.sealPrivate, senderSignPublicB64: a.signPublic })), "not-for-me");
  /* The recipient is inside what is signed, so a captured bundle cannot be
   * re-addressed to a third party by editing the envelope. */
  const readdressed = Buffer.from(blob); readdressed.write(a.fp, blob.indexOf(b.fp), "ascii");
  eq("...and re-addressing it breaks the signature rather than the decryption",
    await refusal(() => openSealed({ blob: readdressed, me: a.fp, sealPrivate: aPriv.sealPrivate, senderSignPublicB64: a.signPublic })), "bad-signature");
  eq("a bundle signed by somebody else is refused",
    await refusal(() => openSealed({ blob, me: b.fp, sealPrivate: bPriv.sealPrivate, senderSignPublicB64: b.signPublic })), "bad-signature");
  eq("something that is not a bundle at all is refused by name",
    await refusal(() => openSealed({ blob: Buffer.from("hello"), me: b.fp, sealPrivate: bPriv.sealPrivate, senderSignPublicB64: a.signPublic })), "not-sealed");

  /* ⚠ THE LOOKUP FORM EXISTS SO THAT THERE IS ONE PARSER. With only the string
   * form a caller must find the envelope itself to know whose key to check
   * against — which means decoding a binary blob as text and splitting it on
   * linefeeds, a read that corrupts any ciphertext holding one. The route did
   * exactly that until this lane existed. */
  let sawFrom = null;
  const viaLookup = openSealed({
    blob, me: b.fp, sealPrivate: bPriv.sealPrivate,
    senderSignPublicB64: (envelope) => { sawFrom = envelope.from; return a.signPublic; },
  });
  eq("the lookup is handed the envelope and the payload still comes back",
    [sawFrom, viaLookup.payload.toString("utf8")], [a.fp, payload.toString("utf8")]);
  /* A stranger's bundle is the sender being unknown, not the call being built
   * wrong: `from` is chosen by whoever sealed it, so an attacker decides
   * whether this fires and it must not share a reason with a programming fault. */
  eq("a lookup that holds no key for the sender refuses unknown-sender",
    await refusal(() => openSealed({ blob, me: b.fp, sealPrivate: bPriv.sealPrivate, senderSignPublicB64: () => null })), "unknown-sender");
  eq("...and a refusal the caller built keeps its own reason",
    await refusal(() => openSealed({
      blob, me: b.fp, sealPrivate: bPriv.sealPrivate,
      senderSignPublicB64: () => { const e = new Error("not on the roster"); e.reason = "not-a-friend"; throw e; },
    })), "not-a-friend");
  ok("the signature is checked BEFORE the decryption, and the file says why",
    /WHY THE SIGNATURE IS CHECKED BEFORE THE DECRYPTION/.test(src("./seal.js")));
}

console.log("\n§4  the roster: adding is not trusting");
{
  const other = await identity({ appData: appData2 });
  const card = readKeyCard(keyCard({ ...other, nickname: "bucky" }));
  const peer = await roster.addPeer({ appData, card });
  eq("a real key card is accepted", [peer.fp, peer.nickname], [other.fp, "bucky"]);
  eq("...unverified, with no role and no minutes", [peer.verified, peer.role, peer.lendMinutesPerDay], [false, "none", 0]);
  eq("...and the row's own keys are the ones its fingerprint hashes to",
    [peer.sign === card.signPublic, peer.seal === card.sealPublic], [true, true]);
  /* A hand-built object is a door this module deliberately leaves open, so the
   * fingerprint is recomputed from the row's keys rather than believed. */
  eq("a fingerprint beside keys that do not hash to it is refused",
    await refusal(() => roster.addPeer({ appData, card: { ...card, fp: "0".repeat(32) } })), "bad-card");
  eq("...and a key of the right character count but the wrong byte length too",
    await refusal(() => roster.addPeer({
      appData,
      card: { ...card, signPublic: `${card.signPublic.slice(0, 58)}AA` },
    })), "bad-card");
  eq("the same peer twice is refused rather than merged, because merging spends a phone call",
    await refusal(() => roster.addPeer({ appData, card })), "already-a-peer");

  eq("a role on an unverified peer is refused",
    await refusal(() => roster.setRole({ appData, fp: peer.fp, role: "collaborator" })), "not-verified");
  /* ⚠ THE FLAG THAT GATES EVERYTHING FAILED OPEN. The old test was
   * `verified !== false`, so the STRING "false" — which is how a boolean
   * arrives through a JSON body or a query string — meant verify. */
  eq("...and the flag is checked, not coerced: the string \"no\" is not a yes",
    await refusal(() => roster.markVerified({ appData, fp: peer.fp, verified: "no" })), "bad-verified");
  await roster.markVerified({ appData, fp: peer.fp, verified: true });
  const asCollaborator = await roster.setRole({ appData, fp: peer.fp, role: "collaborator" });
  eq("a role is allowed once the words have been read aloud", asCollaborator.role, "collaborator");
  /* Accept reads the minutes of BOTH lending roles, so both start with them. */
  eq("...and a collaborator starts with the same minutes a lending friend does, not 0",
    asCollaborator.lendMinutesPerDay, 60);
  eq("...and moving between the two lending roles keeps the number that is there",
    (await roster.setLendMinutes({ appData, fp: peer.fp, minutesPerDay: 0 }),
     (await roster.setRole({ appData, fp: peer.fp, role: "lender" })).lendMinutesPerDay), 0);
  await roster.setRole({ appData, fp: peer.fp, role: "collaborator" });
  ok("an unknown role is refused", (await refusal(() => roster.setRole({ appData, fp: peer.fp, role: "owner" }))) !== null);
  eq("an unknown fingerprint is refused by name",
    await refusal(() => roster.setRole({ appData, fp: "0".repeat(32), role: "lender" })), "no-such-peer");
  eq("minutes are a number somebody typed", (await roster.setLendMinutes({ appData, fp: peer.fp, minutesPerDay: 45 })).lendMinutesPerDay, 45);
  ok("...bounded to a day", (await refusal(() => roster.setLendMinutes({ appData, fp: peer.fp, minutesPerDay: 5000 }))) !== null);
  /* Un-verifying is what you do when the phone call went wrong, and it must
   * take the role with it: a verified-only role on a row nobody re-verified is
   * a permission nobody re-granted. */
  const dropped = await roster.markVerified({ appData, fp: peer.fp, verified: false });
  eq("un-verifying takes the role and the minutes with it", [dropped.role, dropped.lendMinutesPerDay], ["none", 0]);
  ok("no private key is ever written to the roster",
    !/signPrivate|sealPrivate|PRIVATE KEY/.test(await readFile(path.join(appData, "collab", "roster.json"), "utf8")));

  /* ⚠ A ROSTER THAT CANNOT BE READ MUST NOT BE OVERWRITTEN. The first draft
   * turned any read failure into an empty list and then wrote that emptiness
   * back over the file — one transient error and every friend was gone, along
   * with every phone call they cost. */
  const file = path.join(appData, "collab", "roster.json");
  const good = await readFile(file, "utf8");
  await writeFile(file, "{ this is not json");
  eq("a roster it cannot parse is refused", await refusal(() => roster.addPeer({ appData, card })), "roster-unreadable");
  eq("...and not replaced", await readFile(file, "utf8"), "{ this is not json");
  await writeFile(file, good);
  eq("...while a roster that is genuinely absent is simply empty",
    (await roster.roster({ appData: await mkdtemp(path.join(tmpdir(), "aiplay-collab-")) })).peers, []);
}

console.log("\n§5  the two units: a lender gets a scene, a collaborator gets the project");
{
  const doc = {
    slug: "demo", title: "A Demo", styleBible: "a dim red room, crisp",
    song: { file: "song.flac" }, lyricLines: [{ t: 0, text: "a secret line" }],
    plans: [{ id: "p1", items: [] }],
    segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 4, durationSec: 4 }],
    boards: [{ segmentId: "s1_0", boardPrompt: "She turns away.", grade: "warm candle light",
               shots: [{ action: "Close on her face." }], characterRefs: ["Hex"] }],
    characters: [{ id: "c1", name: "Hex", imageFile: "char_x.png" }],
    clips: [],
  };
  const assets = await mkdtemp(path.join(tmpdir(), "aiplay-assets-"));
  await writeFile(path.join(assets, "char_x.png"), Buffer.from([1, 2, 3, 4]));

  const shot = await shotPacket({ doc, segmentId: "s1_0", assetsDir: assets });
  eq("a shot packet names itself and its scene", [shot.kind, shot.segmentId], ["shot", "s1_0"]);
  ok("...it carries a finished prompt", typeof shot.prompt === "string" && shot.prompt.length > 10);
  const text = JSON.stringify(shot);
  ok("...and NOT the script, the song, the plan, the other scenes or the title",
    !text.includes("a secret line") && !text.includes("song.flac")
    && !/"plans"/.test(text) && !text.includes("A Demo"),
    text.slice(0, 300));
  ok("...the bible is not a field of its own", !("styleBible" in shot));
  ok("...the pictures it needs come with a hash each",
    Array.isArray(shot.refs) && shot.refs.length === 1 && /^[0-9a-f]{64}$/.test(shot.refs[0].sha256));
  eq("a scene that does not exist is refused by name",
    await refusal(() => shotPacket({ doc, segmentId: "s9_9", assetsDir: assets })), "no-such-segment");

  /* ⚠ A LENDER MUST NOT BE SENT A STRANGER TO RENDER. The guard read the kind
   * off the cast rows, so deleting the row a board still names made the board's
   * character invisible to it and the packet built with no pictures at all. */
  eq("a board naming a character whose row has gone is refused, not packed blind",
    await refusal(() => shotPacket({ doc: { ...doc, characters: [] }, segmentId: "s1_0", assetsDir: assets })), "no-refs");

  const whole = await projectBundle({ doc, assetsDir: assets });
  eq("a project bundle is the document", [whole.kind, whole.doc.title], ["project", "A Demo"]);
  ok("...with a manifest of its assets", Array.isArray(whole.assets) && whole.assets.length >= 1);
  ok("both describe themselves in one sentence for the person receiving them",
    typeof describePacket(shot) === "string" && describePacket(shot).length > 20
    && typeof describePacket(whole) === "string");
  ok("a shot describes review metadata, not a render order or attached pictures",
    /Scene metadata for review/.test(describePacket(shot))
    && /no picture bytes are included/.test(describePacket(shot))
    && /not a render request/.test(describePacket(shot))
    && !/One shot to render/.test(describePacket(shot)));
  ok("a project describes a document and manifest without promising asset bytes",
    /Project document and asset manifest/.test(describePacket(whole))
    && /no asset file bytes travel/.test(describePacket(whole))
    && /on the sender's disk/.test(describePacket(whole)));
  await rm(assets, { recursive: true, force: true });
}

console.log("\n§6  the doors: shared API checks and explicit MCP intents");
{
  const index = src("../index.js"), mcp = src("../mcp-collab.js"), router = src("../chat/router.js");
  const html = src("../../web/index.html"), app = src("../../web/app.js");
  ok("one door, and it opens no socket", /if \(p === "\/api\/collab" && req\.method === "POST"\) \{/.test(index));
  /* ⚠ THE DOOR THAT WRITES THE ROSTER MUST NOT BE THE FIFTY-SIXTH UNGATED ONE.
   * A page the user merely visits can POST here; it cannot read the answer, but
   * add-verify-promote-pack needs no answer to be useful. */
  ok("...and it asks who is knocking, which almost no other door here does",
    /reason: "not-same-origin"/.test(index) && /sec-fetch-site/.test(index)
    && /x-aiplay-actor/.test(index.slice(index.indexOf(String.raw`p === "/api/collab"`))));
  ok("the role decides what leaves, checked at the door rather than trusted",
    /if \(kind === "project" && peer\.role !== "collaborator"\)/.test(index));
  ok("...and nothing is sent to somebody whose words were never read aloud",
    /if \(!peer\.verified\) \{/.test(index) && /reason: "not-verified"/.test(index));
  /* Both of the recipient's keys, so the seal refuses a row whose fingerprint
   * and sealing key came from two different places. */
  ok("a bundle is sealed against both of their keys, not just the sealing one",
    /toSealPublicB64: peer\.seal, toSignPublicB64: peer\.sign,/.test(index));
  ok("the sender's key is looked up BY the envelope, inside the one parser",
    /senderSignPublicB64: \(envelope\) => \{/.test(index) && !/String\(blob\)\.split/.test(index));
  ok("a bundle from a stranger is refused rather than attributed", /reason = "unknown-sender"/.test(index));
  ok("opening describes and stops", /Nothing has been rendered/.test(index));
  ok("MCP exposes explicit peer, inbox, order and adoption operations",
    ["collab_me", "collab_roster", "collab_resources", "collab_credit", "collab_free", "collab_orders",
     "collab_add_peer", "collab_set_role", "collab_preview", "collab_pack", "collab_open",
     "collab_verify", "collab_set_lend_minutes", "collab_accept", "collab_adopt", "collab_receive", "collab_send_back"]
      .every((n) => mcp.includes(`name: "${n}"`)));
  ok("verification has no implicit grant and requires the user's word check",
    /required: \["fp", "verified"\]/.test(mcp) && /a.words_matched !== true/.test(mcp)
    && /verified: a.verified/.test(mcp));
  ok("accept and adopt forward explicit review/override intents",
    /seen: a.seen === true/.test(mcp) && /anyway: a.anyway === true/.test(mcp));
  ok("chat reads freely but asks before local sharing, and never grants trust or lends",
    /collab_me: null/.test(router) && /collab_roster: null/.test(router)
    && /collab_open: null/.test(router)
    && /collab_accept: "writes"/.test(router) && /collab_pack: "writes"/.test(router)
    /* The trust grant, the role and the minutes a day are a person's, on the
     * Collab screen: withheld from the in-app chat, kept for MCP clients. */
    && ["collab_verify", "collab_set_role", "collab_set_lend_minutes"].every((n) =>
      !new RegExp(`^\\s*${n}: (null|"writes"|"gpu"|"destroys"),`, "m").test(router)
      && new RegExp(`^\\s*${n}: "[^"]{40,}`, "m").test(router)));
  /* ── THE TABBED REBUILD, AND THE TWO HOLES IT NEARLY OPENED ─────────────
   *
   * The page was eight sections on one flat scroll, about a thousand words
   * before you had done anything, with three separate boxes asking a person to
   * type a file path for a folder the server can already list. It is three tabs
   * now. Two properties of the OLD page were accidental safety, and both had to
   * be put back deliberately.
   */
  ok("three tabs, three panes — the page does three jobs and now says so",
    /id="cbTabIn"/.test(html) && /id="cbTabSend"/.test(html) && /id="cbTabFriends"/.test(html)
    && /id="cbPaneIn"/.test(html) && /id="cbPaneSend"/.test(html) && /id="cbPaneFriends"/.test(html));

  /* ⚠ #cbSay SITS OUTSIDE ALL THREE PANES. Five handlers write their result
   * into one element, which was safe only while everything was visible at once.
   * `send_back`'s refusal — "That errand has not rendered yet. Approve its plan
   * — Workflow → the Plan card" — is the most important recovery sentence in the
   * feature, and a pane would hide it on the tab you are not looking at. */
  ok("the status line is outside every pane, so no message can land on a hidden tab",
    html.indexOf('id="cbSay"') > 0
    && html.indexOf('id="cbSay"') < html.indexOf('id="cbPaneIn"')
    && html.indexOf('id="cbSay"') > html.indexOf('id="cbTabs"'));

  /* ⚠ THE CONSENT BINDING. The door refuses an accept without `seen: true` and
   * is stateless on purpose — but it binds a PATH, not the bytes a person was
   * shown. One field plus a clickable list means you can read row A's prompt
   * and pictures, click row B, and press yes on B. The door cannot tell. So the
   * page stamps the file it SHOWED and the yes-press refuses anything else. */
  eq("the accept field is visible and readonly, never hidden — you can see what you are agreeing to",
    [/id="cbFile" class="sel2" readonly/.test(html), /id="cbFile"[^>]*type="hidden"/.test(html)],
    [true, false]);
  ok("...and the yes-press is ARMED: it refuses a file other than the one whose prompt was read",
    /card\.dataset\.armed = file/.test(app)
    && /card\.dataset\.armed !== file/.test(app)
    && /That is not the file whose prompt you just read/.test(app));
  ok("...and a row click, a tab change or a repaint disarms it",
    /function disarmCollab\(\)/.test(app)
    && /delete card\.dataset\.armed/.test(app)
    && /setCbTab[\s\S]{0,400}disarmCollab\(\)/.test(app));

  /* ⚠ THE TWO PINNED SENTENCES MUST SIT INSIDE THE WRAPPER HOLDING THE BUTTON
   * THEY DESCRIBE. A design that moved the adopt warning into a card hidden at
   * the moment Adopt is pressed keeps the grep below green and takes the
   * warning off the screen, which is worse than not having pinned it. */
  ok("\"plan that is proposed\" is inside the same block as the accept button",
    /id="cbOrderFace"[\s\S]*?plan that is <b>proposed<\/b>[\s\S]*?<\/div>/.test(html));
  ok("\"nobody has picked\" is inside the same block as the keep/throw-away buttons",
    /id="cbTakesWrap"[\s\S]*?nobody has picked<\/b>[\s\S]*?<\/div>/.test(html));

  /* ⚠ THE `inbox` DOOR SHIPPED AND NOTHING CALLED IT. Three boxes asked for "a
   * path, or a name in the inbox" for a folder scanInbox lists, classifying
   * each file from its first eleven bytes. */
  ok("the page reads the inbox rather than asking a person to type a path",
    /action: "inbox"/.test(app) && /function paintInbox\(\)/.test(app));
  ok("...and a folder it could not READ is never painted as a folder that is EMPTY",
    /if \(r\.error\)[\s\S]{0,200}cbListError\("Inbox", r\)/.test(app));
  ok("...and a browser can hand over the file itself, because it never hands over a path",
    /id="cbPickFile"/.test(html) && /api\/collab-drop/.test(app));
  ok("...and a quoted path from Explorer's Copy-as-path is stripped before it is sent",
    /replace\(\/\^"\(\.\*\)"\$\/, "\$1"\)/.test(app));

  /* ⚠ WITHOUT A NAME, EVERY ROW ON A FRIEND'S MACHINE READS `7f3a91c2`. The
   * door has always accepted one; the page never sent it, and roster.js has no
   * rename, so the label is chosen here or nowhere. */
  ok("there is somewhere to put your own name, and it reaches the key card",
    /id="cbNickname"/.test(html) && /action: "me", nickname/.test(app));

  /* The orderer's half of the loop: pack an order and the page used to forget. */
  ok("what you asked friends to do is on the screen, not only what they asked of you",
    /action: "orders", side: "out"/.test(app) && /id="cbOutbox"/.test(html));

  /* One screen in this app is premised on a human physically moving a file, and
   * it was the only screen that never called the door that shows you one. */
  ok("a packed file can be found: the reveal door is finally called from Collab",
    /api\/reveal/.test(app) && /id="cbReveal"/.test(html));

  ok("the numbers are folded away, not deleted — the house rule is a control, a number and a tool",
    /<details class="adv" id="cbNumbers"/.test(html)
    && /id="cbSeed"/.test(html) && /id="cbSteps"/.test(html) && /id="cbEngineMode"/.test(html));

  /* The sentence that answers the first question anybody has about a feature
   * called Collab: is my work being uploaded somewhere? */
  ok("...and the page says handoff is manual and delivery is unknown",
    /Handoff is manual/.test(html) && /remote availability and delivery are unknown/.test(html));

  ok("the screen exists, with the words to read aloud on it",
    /<div id="collab" hidden>/.test(html) && /id="cbWords"/.test(html) && /id="cbCard"/.test(html));
  /* ⚠ A CHARACTER CLASS WRITTEN WITH LITERAL CONTROL BYTES makes git call the
   * file BINARY: no diff, no blame, no review of the one line in this module
   * that decides what a friend's text is allowed to be. It happened to
   * resources.js and shipped that way, and twelve other files in this repo have
   * the same habit. These six are held to escapes. */
  ok("no module here carries a control byte in its source",
    ["identity.js", "seal.js", "roster.js", "packet.js", "resources.js", "credit.js"]
      .every((f) => {
        const b = fs.readFileSync(new URL(`./${f}`, import.meta.url));
        return !b.some((c) => c < 9 || (c > 13 && c < 32) || c === 127);
      }));

  /* The lending loop has a screen, and the three presses that cost something
   * are three separate presses. */
  ok("the lending panels exist: free, errands, and what came back",
    /id="cbFree"/.test(html) && /id="cbErrands"/.test(html) && /id="cbTakes"/.test(html)
    && /id="cbAcceptBtn"/.test(html) && /id="cbReceiveBtn"/.test(html));
  ok("...an order's four words are on the page as four controls",
    /id="cbSegment"/.test(html) && /id="cbSeed"/.test(html) && /id="cbSteps"/.test(html) && /id="cbEngineMode"/.test(html)
    && /<option value="order">/.test(html));
  ok("...and the page says what accepting and adopting actually do",
    /plan that is <b>proposed<\/b>/.test(html) && /nobody has picked<\/b>/.test(html));

  ok("...and the keys are made when it is opened, not at boot",
    // Scene context is passed only when Collab opens; no identity is minted at boot.
    /if \(name === "collab"\) paintCollab\(false, collabScene, options\?\.videoRecipe\);/.test(app));
}

console.log("\n\u00a76b  the errand: a friend's order becomes a project that renders what was asked");
{
  const orderM = await import("./order.js");
  const errandM = await import("./errand.js");
  const gen = await import("../mv/generate.js");
  /* \u26a0 THE SIZE IS INVERTED OUT OF TWO DIALS, NEVER COPIED. `renderSize` reads
   * `brief.qualityMode` and `brief.aspectRatio` and never a width, so an errand
   * whose brief does not invert correctly renders a different size than the
   * Accept card promised \u2014 a take that does not fit the scene it answers. */
  const SIZES = [[864, 480], [1344, 768], [1920, 1088], [480, 864], [768, 1344], [1088, 1920]];
  const wrong = SIZES.filter(([w, h]) => {
    const shot = { v: 1, kind: "shot", segmentId: "s1_0", prompt: "x", width: w, height: h, seconds: 5, refs: [], guides: [], baseScale: null };
    const ord = orderM.makeOrder({ shot, files: [], order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, returnTo: { fp: "a".repeat(32) }, now: Date.now() });
    const got = gen.renderSize(errandM.errandDoc({ orderDoc: ord, from: { fp: "a".repeat(32) }, staged: [], now: 1 }));
    return got[0] !== w || got[1] !== h;
  });
  eq("every size an order can name is the size the errand renders", wrong, []);
  eq("...and a size those two dials cannot make is refused, not rendered smaller",
    await refusal(() => orderM.briefFor({ shot: { width: 1000, height: 1000 }, order: { steps: 8, engineMode: "h3" } })),
    "size-unreproducible");
  /* The whole reason the prompt is composed on the SENDING side: `clipPrompt`
   * prepends the bible unconditionally, so a scene recomputed here would render
   * under THIS machine's look. */
  const shot2 = { v: 1, kind: "shot", segmentId: "s1_0", prompt: "a frozen sentence", width: 1344, height: 768, seconds: 5, refs: [], guides: [], baseScale: null };
  const ord2 = orderM.makeOrder({ shot: shot2, files: [], order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, returnTo: { fp: "a".repeat(32) }, now: Date.now() });
  const errand = errandM.errandDoc({ orderDoc: ord2, from: { fp: "a".repeat(32) }, staged: [], now: 1 });
  errand.slug = "errand-pin";
  const shotMod = await import("../mv/shot.js");
  const resolved = shotMod.resolveShot(errand, "s1_0", {});
  eq("the friend's prompt is what renders, and this machine's bible cannot reach it",
    [resolved.promptSource, resolved.prompt, errand.styleBible, errand.song],
    ["edited", "a frozen sentence", "", null]);
  eq("...and a peer's plans are never this machine's plans", errand.plans, []);

  /* ⚠ AN ORDER EXPIRES, AND THE FIELD THAT SAYS SO IS NOT THE SENDER'S TO
   * DELETE. The first version guarded with `if (when && Number(p.expires) && …)`
   * so a payload that simply omitted the field skipped the check entirely, and
   * then returned the wire value, so an order could also claim the year 2500.
   * The door refused and accepted the same bundle in one breath. */
  {
    const OLD = Date.parse("2023-01-01T00:00:00Z");
    const stale = orderM.makeOrder({ shot: shot2, files: [], order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, returnTo: { fp: "a".repeat(32) }, now: OLD });
    const bypasses = [["intact", stale]];
    const gone = { ...stale }; delete gone.expires;
    bypasses.push(["deleted", gone], ["zero", { ...stale, expires: 0 }], ["null", { ...stale, expires: null }],
      ["empty", { ...stale, expires: "" }], ["year 2500", { ...stale, expires: 16725225600000 }]);
    const survived = [];
    for (const [name, doc] of bypasses) {
      try { orderM.readOrder(doc, { now: Date.now(), myFp: "b".repeat(32) }); survived.push(name); } catch { /* refused */ }
    }
    eq("a stale order is refused however its expiry field is mangled", survived, []);
    /* ...and the fortnight a sender may legitimately ask for still stands. */
    const long = orderM.makeOrder({ shot: shot2, files: [], order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, returnTo: { fp: "a".repeat(32) }, now: Date.now(), expiresInHours: 336 });
    ok("...and a fourteen-day order still stands ten days later",
      !!orderM.readOrder(long, { now: Date.now() + 10 * 24 * 3600_000, myFp: "b".repeat(32) }));
  }
  /* ⚠ AN ID THE BOOK CANNOT STORE DISARMS THE DOUBLE-SPEND GUARD FOREVER. */
  eq("an order id outside the book's own shape is refused where it enters",
    await refusal(() => orderM.makeOrder({ shot: shot2, files: [], order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, returnTo: { fp: "a".repeat(32) }, now: Date.now(), id: "../../../evil" })),
    "bad-arguments");
  /* ⚠ THE BYTE CAP DOES NOT BOUND THE COUNT: a hundred thousand one-byte rows
   * pass it, and each is a hash and a file written while the machine blocks. */
  eq("an order carrying more pictures than a scene can take is refused",
    await refusal(() => orderM.makeOrder({ shot: shot2, files: Array.from({ length: 100000 }, () => ({ file: "x", b64: "AA" })), order: { segmentId: "s1_0", seed: 1, steps: 8, engineMode: "h3" }, returnTo: { fp: "a".repeat(32) }, now: Date.now() })),
    "order-too-big");
  /* ⚠ THE PLAN ITEM NAMES THE ERRAND'S OWN SCENE. An order names a scene in
   * SOMEBODY ELSE's project; naming it here proposed an item for a scene this
   * project does not contain, so every order but a first scene failed to
   * render. */
  eq("the plan item names the scene the errand actually has",
    [orderM.orderPlanItem(ord2, "errand-x", errandM.ERRAND_SEGMENT).args.segment,
     errand.segments[0].id,
     await refusal(() => orderM.orderPlanItem(ord2, "errand-x"))],
    [errandM.ERRAND_SEGMENT, errandM.ERRAND_SEGMENT, "bad-arguments"]);
  /* ⚠ A MISSING NUMBER IS NOT A PASS. Both checks skipped when the field was
   * absent, and the success sentence then said it had been checked. */
  {
    const row = { id: "o_" + "ab".repeat(6), to: { fp: "c".repeat(32) }, order: { segmentId: "s1_0", seed: 5, steps: 8 }, expect: null };
    const base = { kind: "return", v: 1, orderId: row.id, segmentId: "s1_0", probe: null };
    eq("a return that does not say its seed or its steps is refused, not passed",
      [orderM.checkReturn({ ...base, record: { model: "h3", outputRights: { class: "x" } } }, row).reason,
       orderM.checkReturn({ ...base, record: { model: "h3", outputRights: { class: "x" }, seed: 5 } }, row).reason],
      ["record-seed", "record-steps"]);
  }
  /* ⚠ AN EMPTY RIGHTS OBJECT IS WORSE THAN NONE: it satisfies `!== undefined`,
   * so the stamp is suppressed and the ledger line reads answered. */
  eq("a return whose rights are an empty shape is refused",
    await refusal(() => orderM.makeReturn({ orderId: "o_" + "ab".repeat(6), segmentId: "s1_0", result: { bytes: Buffer.from("x") }, record: { model: "h3", outputRights: {} }, now: 1 })),
    "record-no-rights");
  /* ⚠ AND AN ACTOR NOBODY CAN PARSE WOULD ERASE THE FINGERPRINT: the owner
   * builds `peer:<fp>:<this>`, and normalizeActor flattens the whole string to
   * `system` when the inner half is unknown — filing a friend's render as this
   * machine's own work. */
  {
    const clip = Buffer.from("x");
    const hostile = orderM.makeReturn({ orderId: "o_" + "ab".repeat(6), segmentId: "s1_0", result: { bytes: clip }, record: { model: "h3", outputRights: { class: "x" }, actor: "!!!" }, now: 1 });
    eq("an unparseable actor is normalised on the way in, so the fingerprint survives",
      orderM.readReturn(hostile).doc.record.actor, "system");
  }
  /* ⚠ EVERY FUNCTION IN quarantine.js PUTS THE FINGERPRINT INTO A PATH, and one
   * of them DELETES. */
  {
    const quarM2 = await import("./quarantine.js");
    eq("a fingerprint that is a path is refused by all three, not just the one",
      [await refusal(() => quarM2.adoptReturn({ outDir: "/tmp/x", clipDir: "/tmp/y", fromFp: "../../..", file: "a" })),
       await refusal(() => quarM2.dropReturn({ outDir: "/tmp/x", fromFp: "../../..", file: "a" })),
       await refusal(() => quarM2.landReturn({ outDir: "/tmp/x", payload: {}, fromFp: "../../.." }))],
      ["bad-arguments", "bad-arguments", "bad-arguments"]);
  }
  /* ⚠ THE ENGINE'S OWN COUNT SEES WORK THIS APP NEVER DISPATCHED. */
  {
    const freeM2 = await import("./free.js");
    eq("a render this app did not start still reads as busy",
      freeM2.machineBusy({ art: { paused: false, current: null, queued: 0 }, jobs: { current: null, queue: [] }, plansRunning: [], engine: { ready: true, queue: { running: 1, pending: 0 }, running: [] } }).reason,
      "engine-busy");
  }
}

console.log("\n§7  the door itself, evaluated — because every pin above this one is a regular expression");
{
  /* ⚠ THE ONE BUG THIS DOOR HAD WAS AN UNDEFINED NAME, and no amount of
   * regular expressions over the source was ever going to see it: `pack` called
   * `safeName`, which lives in mcp.js and has never existed in index.js, so
   * every send threw a ReferenceError into the route's own catch and came back
   * as a 500 whose message named a variable. Slicing the route's text out and
   * evaluating it with ONLY the names it is entitled to turns that into a
   * failure here. Everything injected below is either the real module or a
   * stand-in narrow enough that it cannot hide a mistake. */
  const index = src("../index.js");
  const start = index.indexOf('if (p === "/api/collab" && req.method === "POST") {');
  const endMark = "\n    }\n";
  const tail = index.indexOf("        return json(res, status, { error: e?.message || String(e)", start);
  ok("the route can be found in one piece", start > 0 && tail > start);
  const body = index.slice(start, index.indexOf(endMark, tail) + endMark.length);

  const compatM = await import("./compat.js");
  const lendingM = await import("./lending.js");
  /* ⚠ THE SPEED-UP CHECK READS THIS MACHINE'S DISK, so the door is handed one
   * that answers the same on every machine: a PC with only the 4-step files,
   * which is what the Models screen installs. The pins read what the door DOES
   * with the answer; lending_test.js pins the answer itself. */
  const realCfg = (await import("../config.js")).config;
  const h3Real = realCfg.video.engines.h3;
  const F4 = Object.keys(h3Real.turboShiftByLora).find((n) => /fl2v.*4step/.test(n));
  const R4 = Object.keys(h3Real.turboShiftByLora).find((n) => /ref2v.*4step/.test(n));
  /* Every turbo slot resolved to a 4-step file, which is what pick() does on a
   * PC whose loras folder holds only what the Models screen fetched. */
  const FOUR_STEP_ONLY = {
    cfg: { ...realCfg, modelsDir: "/nowhere", modelsAlso: [],
      video: { ...realCfg.video, engines: { ...realCfg.video.engines,
        h3: { ...h3Real, turboLora: F4, turboLora4: F4, turboLora3: F4, refTurboLora: R4, refTurboLora4: R4 } } } },
    onDisk: (n) => /4step/.test(String(n)),
  };
  const lendingDoor = { ...lendingM,
    speedUpForOrder: (o) => lendingM.speedUpForOrder(o, FOUR_STEP_ONLY),
    speedUpCheck: (a) => lendingM.speedUpCheck(a, FOUR_STEP_ONLY) };
  const [idM, sealM, rosterM, packetM, resourcesM, creditM, orderM, freeM, bookM, errandM, quarM, inboxM] = [
    await import("./identity.js"), await import("./seal.js"),
    await import("./roster.js"), await import("./packet.js"),
    await import("./resources.js"), await import("./credit.js"),
    await import("./order.js"), await import("./free.js"), await import("./orderbook.js"),
    await import("./errand.js"), await import("./quarantine.js"), await import("./inbox.js"),
  ];
  /* What the machine is doing, so a pin can move it. */
  const machineState = {
    art: { paused: false, current: null, queued: 0 },
    jobs: { current: null, queue: [] },
    plans: [],
    engine: { ready: true, queue: { running: 0, pending: 0 }, running: [] },
    /* What this machine's ffprobe says about a returned take. */
    probe: { frames: 141, fps: 24, width: 1344, height: 768, seconds: 5.875, videoStreams: 1, audioStreams: 0 },
  };
  /* ⚠ THE PROJECTS THE DOOR WRITES, KEPT. The stand-in used to hand every
   * update a throwaway document with one clip row for a scene the order never
   * named, so "filed onto a scene" could not be asserted at all — which is how a
   * take for a never-rendered scene landed nowhere and said so wrongly. */
  const projectStore = {};
  const clipLibrary = await mkdtemp(path.join(tmpdir(), "aiplay-door-clips-"));

  await writeFile(path.join(clipLibrary, "errand-take.mp4"), Buffer.from("a rendered scene"));
  const appended = [];
  const proposed = [];
  const home = await mkdtemp(path.join(tmpdir(), "aiplay-door-"));
  const out = await mkdtemp(path.join(tmpdir(), "aiplay-door-out-"));
  const projectAssets = await mkdtemp(path.join(tmpdir(), "aiplay-door-assets-"));
  /* ⚠ A REAL PNG SIGNATURE, because order.js checks magic bytes: a reference
   * sheet is a picture, and a file that is something else under a picture's
   * name is not a mislabelled file. Four arbitrary bytes were a fixture that
   * could never have travelled. */
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 7)]);
  await writeFile(path.join(projectAssets, "char_x.png"), PNG);
  /* The credit branch refuses a project with no ledger on disk — "nobody has
   * touched it" and "there is no such project" must not read the same — so the
   * fixture has one. It is never parsed: `prov` is injected. */
  await writeFile(path.join(path.dirname(projectAssets), "provenance.jsonl"), "");
  const DOC = {
    slug: "demo", title: "A Demo", styleBible: "a dim red room",
    song: { file: "song.flac" }, lyricLines: [{ t: 0, text: "a secret line" }],
    segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 4, durationSec: 4 }],
    boards: [{ segmentId: "s1_0", boardPrompt: "She turns away.", shots: [{ action: "Close." }], characterRefs: ["Hex"] }],
    characters: [{ id: "c1", name: "Hex", imageFile: "char_x.png" }],
    clips: [],
  };

  const names = ["p", "req", "res", "json", "readBody", "config", "path", "mkdir", "writeFile", "readFile",
    "collabPreviews", "assertPreviewFresh",
    "collabIdentity", "collabPrivateKeys", "keyCard", "readKeyCard", "collabWords",
    "sealTo", "openSealed", "collabRoster", "shotPacket", "projectBundle", "describePacket",
    /* The compatibility half: what decides whether a packet may be read
       (`speaks`, from its own protocol number) and the caption saying which
       build sealed it (`collabStamp` / `describeStamp`). */
    "speaks", "collabStamp", "describeStamp",
    "readMvProject", "mvAssetsDir", "models", "gpuStatus", "ramStatus",
    "resourceCard", "readResourceCard", "describeResources", "ageOf",
    "prov", "creditRollup", "creditLines", "stat",
    /* the lending loop: every name the nine new actions reach for. A name
     * missing from this list is a ReferenceError HERE rather than a 500 on
     * a Tuesday, which is the whole point of evaluating the route's own
     * text with only what it is entitled to. */
    "makeOrder", "readOrder", "orderPlanItem", "describeOrder", "makeReturn",
    "machineBusy", "readWorkload", "book", "errandDoc", "errandTitle", "stageOrderFiles",
    "adoptReturn", "dropReturn", "landReturn", "listQuarantine", "scanInbox",
    "createMvProject", "updateMvProject", "plansRunningNow",
    /* ⚠ NOT `models` AGAIN. It is injected further up, and a duplicate
     * parameter name is legal here — the LAST one wins, silently, which is how
     * the resource-card pin started reading a different catalogue than the one
     * it was written against. */
    /* ⚠ `engineDoor`, WHICH IS WHAT index.js CALLS IT. This list said `engine`
     * and the route said `engine.status()`, so the two agreed with each other
     * and disagreed with the file: every accept read the card through a
     * ReferenceError and answered `engine-unreachable`, refusing every order
     * that will ever be sent. A fake named after what the code SHOULD say is
     * how a harness goes blind. */
    "art", "jobs", "engineDoor", "probeClip", "CLIP_DIR", "fetch", "ERRAND_SEGMENT",
    "MAX_BUNDLE_BYTES", "pictureKind", "MIME_FOR", "makeVideoRecipe", "readVideoRecipe", "describeVideoRecipe", "videoRecipeMcpArgs",
    /* Lending for a person with no strong card: the frame grid, the speed-up
     * check, the minutes a day and filing onto a never-rendered scene. */
    "collabLending",
    /* The minors rule (server/safety): the real checks, the real flag reader,
     * and index.js's own mvRowWords, sliced out of the file below. */
    "assertSafe", "safetyRefusal", "bodyOfError", "shotFlags", "mvRowWords",
    /* The Friends row's own words for the lending role (cloud-switch.js), which
     * the "no role" refusal names. */
    "LENDER_ROLE_LABEL"];
  const refusalM = await import("../safety/refusal.js");
  const { LENDER_ROLE_LABEL } = await import("../cloud-switch.js");
  const rowWordsAt = index.indexOf("function mvRowWords(");
  const mvRowWords = new Function(`${index.slice(rowWordsAt, index.indexOf("\n}\n", rowWordsAt) + 2)} return mvRowWords;`)();
  /* eslint-disable-next-line no-new-func */
  const run = new Function(...names, `return (async () => { ${body} return { status: 0, body: { error: "the route did not answer" } }; })();`);

  const LEDGER = [
    { actor: "user", type: "edit", t: 1, asset: "a" },
    { actor: "agent:claude", type: "generate", t: 2, asset: "b" },
    { actor: "agent:claude", type: "generate", t: 3, asset: "c" },
    { actor: "script:gate_run", type: "export", t: 4, asset: "c" },
    { actor: `peer:${"ab".repeat(16)}:agent:kit`, type: "generate", t: 5, asset: "d" },
    { actor: `peer:${"ab".repeat(16)}:user`, type: "edit", t: 6, asset: "d" },
  ];
  let previewClock = Date.now();
  const previewStore = createPreviewStore({ now: () => previewClock });
  const callWith = (b, { chainOk = true, corrupt = 0 } = {}, headers = { origin: "http://127.0.0.1:4173" }) => {
    let answered = null;
    const json = (_res, status, payload) => { answered = { status, body: payload }; return answered; };
    return run(
      "/api/collab", { method: "POST", headers }, {}, json, async () => b,
      { paths: { appData: home }, outputDir: out, uiPort: 4173 },
      path, mkdir, writeFile, readFile,
      previewStore, assertPreviewFresh,
      idM.identity, idM.privateKeys, idM.keyCard, idM.readKeyCard, idM.words,
      sealM.sealTo, sealM.openSealed, rosterM,
      packetM.shotPacket, packetM.projectBundle, packetM.describePacket,
      compatM.speaks, compatM.stamp, compatM.describeStamp,
      /* "demo" is the owner's project; "errand-1" is what the accept branch
       * created, standing in as ALREADY RENDERED so `send_back` has a take to
       * seal. Its clip name is a real file in the fake clip library below. */
      async (slug) => (slug === "demo" ? DOC
        /* The same scene with a board that sings: lip-sync does not travel. */
        : slug === "demo-sing" ? { ...DOC, slug, boards: [{ ...DOC.boards[0], lipSync: true }] }
        : slug === "errand-1" ? {
          slug, brief: { videoEngine: "h3", videoSteps: 8 },
          clips: [{ segmentId: "s1_0", takes: [{ clip: "errand-take.mp4", seed: 7, ms: 100, engine: "h3" }] }],
        } : null),
      () => projectAssets,
      /* A model manager narrow enough that it cannot hide a mistake: two rows,
       * one ready and one not, which is all the redaction has to chew on. */
      { status: async () => [
        { id: "flux2-klein", ready: true, makes: "image" },
        { id: "h3", ready: false, makes: "video" },
        /* The row `send_back` reads to answer "what licence are these pixels
         * under" — with rights, because a return carrying none is refused. */
        { id: "videoH3Turbo3", ready: true, outputRights: { class: "yours-with-conditions" } },
      ] },
      () => ({ name: "A Card", totalMb: 16376, vendor: "nvidia" }), () => ({ totalMb: 32768 }),
      resourcesM.resourceCard, resourcesM.readResourceCard, resourcesM.describeResources, resourcesM.ageOf,
      /* A ledger with one of every hand in it, including the fifth class that
       * nothing writes yet, so the reader is exercised before the writer
       * exists rather than after somebody notices it never was. */
      { verify: async () => ({ ok: chainOk, brokenAt: chainOk ? null : 100 }),
        read: async () => ({ corrupt, events: LEDGER }),
        /* Records rather than writes: the pin below reads what the door tried
         * to put on the chain, which is the assertion that matters. */
        append: async (scope, evt) => { appended.push({ scope, evt }); return evt; } },
      creditM.creditRollup, creditM.creditLines,
      /* ⚠ A REAL `stat`. The door now refuses a bundle by SIZE before it reads
       * it, so a stand-in that answers no size answers zero and every bundle
       * reads as empty. Stand-ins that are narrower than the thing they stand
       * for are how a harness passes a door that would refuse. */
      (f) => stat(f),
      orderM.makeOrder, orderM.readOrder, orderM.orderPlanItem, orderM.describeOrder, orderM.makeReturn,
      freeM.machineBusy, freeM.readWorkload, bookM, errandM.errandDoc, errandM.errandTitle, errandM.stageOrderFiles,
      quarM.adoptReturn, quarM.dropReturn, quarM.landReturn, quarM.listQuarantine, inboxM.scanInbox,
      /* Narrow stand-ins: enough to walk the branch, too little to hide a
       * mistake. `fetch` is a PARAMETER here, which shadows the global — the
       * route's loopback call must not leave this process. */
      async () => ({ slug: "errand-1" }),
      async (slug, fn) => {
        /* The owner's project starts as the demo document with NO clip rows —
         * a borrower who has rendered nothing — and every write is kept. */
        const d = projectStore[slug] ?? (slug === "demo" ? structuredClone(DOC)
          : { slug, id: "x", createdAt: 0, clips: [{ segmentId: "s1_24", takes: [] }] });
        projectStore[slug] = await fn(d);
        return projectStore[slug];
      },
      () => machineState.plans,
      { status: () => ({ art: machineState.art }) },
      machineState.jobs,
      { status: async () => machineState.engine },
      async () => ({ ...machineState.probe }),
      clipLibrary,
      async (url, init) => { proposed.push(JSON.parse(init.body)); return { json: async () => ({ ok: true, planId: "p_fake123" }) }; },
      errandM.ERRAND_SEGMENT,
      sealM.MAX_BUNDLE_BYTES, errandM.pictureKind, errandM.MIME_FOR,
      recipeM.makeVideoRecipe, recipeM.readVideoRecipe, recipeM.describeVideoRecipe, recipeM.videoRecipeMcpArgs,
      lendingDoor,
      refusalM.assertSafe, refusalM.safetyRefusal, refusalM.bodyOfError, orderM.shotFlags, mvRowWords,
      LENDER_ROLE_LABEL,
    ).then((r) => r ?? answered);
  };
  const call = (b, headers = { origin: "http://127.0.0.1:4173" }) => callWith(b, {}, headers);

  /* ⚠ THE GATE, FIRST, because it is the one this door has that the others do
   * not, and a feature nobody exercises is a comment. */
  const stranger = await call({ action: "me" }, { origin: "https://evil.example" });
  eq("a POST from another page is refused before anything is read",
    [stranger.status, stranger.body.reason], [403, "not-same-origin"]);
  const noHeaders = await call({ action: "me" }, {});
  eq("...and so is a caller that names neither itself nor an origin",
    [noHeaders.status, noHeaders.body.reason], [403, "not-same-origin"]);
  const viaTool = await call({ action: "me" }, { "x-aiplay-actor": "agent:test" });
  eq("...while a caller that names itself is let through", viaTool.status, 200);

  const me = await call({ action: "me" });
  eq("the door answers this Studio's identity, its words and its card",
    [me.status, me.body.fp?.length, me.body.words?.length, String(me.body.card).startsWith("AIPLAY1:")],
    [200, 32, 12, true]);

  const friendHome = await mkdtemp(path.join(tmpdir(), "aiplay-friend-"));
  const friend = await idM.identity({ appData: friendHome });
  const friendCard = idM.keyCard({ ...friend, nickname: "bucky" });
  const added = await call({ action: "add_peer", card: friendCard });
  eq("a key card is added, unverified and with no role", [added.status, added.body.peer.verified, added.body.peer.role], [200, false, "none"]);

  const early = await call({ action: "pack", slug: "demo", to: friend.fp, kind: "shot", segmentId: "s1_0" });
  eq("nothing is sent to somebody whose words were never read aloud", [early.status, early.body.reason], [400, "not-verified"]);
  await call({ action: "verify_peer", fp: friend.fp, verified: true });
  const noRole = await call({ action: "pack", slug: "demo", to: friend.fp, kind: "shot", segmentId: "s1_0" });
  eq("...nor to a verified friend who is nothing to you yet", [noRole.status, noRole.body.reason], [400, "role"]);

  await call({ action: "set_role", fp: friend.fp, role: "lender" });
  /* ⚠ THE ROLE IS THE WHOLE POINT: a lender may have a scene and may not have
   * the project, and it is this door that decides it. */
  const asksAll = await call({ action: "pack", slug: "demo", to: friend.fp, kind: "project" });
  eq("a lender asking for the project is refused", [asksAll.status, asksAll.body.reason], [400, "role"]);

  const packed = await call({ action: "pack", slug: "demo", to: friend.fp, kind: "shot", segmentId: "s1_0" });
  eq("a lender is sent the scene", [packed.status, packed.body.kind, packed.body.bytes > 0], [200, "shot", true]);
  ok("...and it is written where the door says it is", !!packed.body.file && (await readFile(packed.body.file)).length === packed.body.bytes);

  const traversal = await call({ action: "pack", slug: "../../etc", to: friend.fp, kind: "shot", segmentId: "s1_0" });
  eq("a project name that is a path is refused by name", [traversal.status, traversal.body.reason], [400, "bad-slug"]);

  /* The friend's side: they open what we sent. Their Studio knows us because we
   * gave them our card, which is the only way a signature can be checked. */
  const theirs = await mkdtemp(path.join(tmpdir(), "aiplay-theirs-"));
  await roster.addPeer({ appData: theirs, card: idM.readKeyCard(me.body.card) });
  const theirKeys = await idM.privateKeys({ appData: friendHome });
  const opened = sealM.openSealed({
    blob: await readFile(packed.body.file), me: friend.fp, sealPrivate: theirKeys.sealPrivate,
    senderSignPublicB64: (env) => (env.from === me.body.fp ? me.body.signPublic : null),
  });
  const inside = JSON.parse(opened.payload.toString("utf8"));
  eq("what arrives is the scene and not the film",
    [inside.kind, inside.segmentId, JSON.stringify(inside).includes("a secret line")],
    ["shot", "s1_0", false]);

  const video = {engine:"ltx",prompt:"A dancer in moonlight",width:1280,height:704,seconds:17.5,steps:32,guidance:2.3,keepAudio:false,seed:123};
  const videoPreview = await call({action:"preview",kind:"video-recipe",to:friend.fp,video});
  eq("standalone video previews without a movie project", videoPreview.status, 200);
  const videoPacked = await call({action:"pack",previewId:videoPreview.body.previewId});
  eq("reviewed video recipe seals for the friend",videoPacked.status,200);
  const videoInside = JSON.parse(sealM.openSealed({blob:await readFile(videoPacked.body.file),me:friend.fp,sealPrivate:theirKeys.sealPrivate,senderSignPublicB64:()=>me.body.signPublic}).payload.toString("utf8"));
  eq("signed video recipe preserves all settings",recipeM.readVideoRecipe(videoInside),video);
  const incomingRecipe = path.join(out,"incoming-video.aiplay");
  await writeFile(incomingRecipe,sealM.sealTo({payload:Buffer.from(JSON.stringify(videoInside)),toSealPublicB64:me.body.sealPublic,toSignPublicB64:me.body.signPublic,toFp:me.body.fp,fromFp:friend.fp,signPrivate:theirKeys.signPrivate}));
  const beforeRecipeProposals=proposed.length;
  const receivedRecipe=await call({action:"open",file:incomingRecipe});
  eq("receiver opens validated video settings",[receivedRecipe.status,receivedRecipe.body.videoRecipe],[200,video]);
  eq("receiver gets exact MCP render arguments",receivedRecipe.body.makeClipArgs,recipeM.videoRecipeMcpArgs(videoInside));
  eq("opening a recipe never proposes rendering",proposed.length,beforeRecipeProposals);

  const fromNobody = await call({ action: "open", file: packed.body.file });
  eq("a bundle addressed elsewhere is refused here, and says whose it is",
    [fromNobody.status, ["not-for-me", "unknown-sender"].includes(fromNobody.body.reason)], [400, true]);
  const missing = await call({ action: "open", file: path.join(out, "nothing.aiplay") });
  eq("a bundle that is not there is refused by name", [missing.status, missing.body.reason], [404, "no-such-file"]);
  const nonsense = await call({ action: "sudo" });
  eq("an action nobody wrote is refused by name", [nonsense.status, nonsense.body.reason], [400, "action"]);


  /* ⚠ WHAT A RESOURCE CARD MUST NEVER CARRY. The useful version of this feature
   * and the invasive version differ by about four fields, so the redaction is
   * pinned as a property of the DOOR's answer rather than trusted to the module
   * that builds it. */
  const mine = await call({ action: "resources", note: "evenings only" });
  eq("the door says what this Studio can do, from ready rows only",
    [mine.status, mine.body.resources.ready, mine.body.resources.makes],
    /* `h3` is not ready and is absent; `videoH3Turbo3` is, and its kind comes
     * from the id's leading word because the catalogue marks `makes` on only
     * eight of its forty-two rows. */
    [200, ["flux2-klein", "videoH3Turbo3"], ["image", "video"]]);
  eq("...the card and the memory come with it", [mine.body.resources.gpu.name, mine.body.resources.ramMb], ["A Card", 32768]);
  eq("...and the owner's own sentence, not one inferred from their files", mine.body.resources.note, "evenings only");
  ok("no path, no user, no host, no library, nothing that was MADE here",
    !/[A-Za-z]:\\|\/Users\/|AppData|\.safetensors|\.png|\.flac|hex-appeal|a secret line/.test(JSON.stringify(mine.body.resources)),
    JSON.stringify(mine.body.resources));

  /* Saying what your machine can do is how two people DECIDE to lend to each
   * other, so it is the one thing a peer with no role may have. */
  const other = await idM.identity({ appData: await mkdtemp(path.join(tmpdir(), "aiplay-third-")) });
  await call({ action: "add_peer", card: idM.keyCard({ ...other, nickname: "kit" }) });
  const toStranger = await call({ action: "pack", to: other.fp, kind: "resources" });
  eq("...and it is still refused to somebody whose words were never read aloud",
    [toStranger.status, toStranger.body.reason], [400, "not-verified"]);
  await call({ action: "verify_peer", fp: other.fp, verified: true });
  const roleless = await call({ action: "pack", to: other.fp, kind: "resources" });
  eq("a verified friend with no role may have the resource card and nothing else",
    [roleless.status, roleless.body.kind], [200, "resources"]);
  const stillNo = await call({ action: "pack", slug: "demo", to: other.fp, kind: "shot", segmentId: "s1_0" });
  eq("...the scene still is not theirs", [stillNo.status, stillNo.body.reason], [400, "role"]);

  /* A card a friend sent is FILED by a person pressing a button. `open` reads
   * and changes nothing, and that stays true with a third kind in the post. */
  const filed = await call({ action: "set_resources", fp: other.fp, resources: { kind: "resources", v: 1, at: 5, ready: ["h3"], makes: ["video"], gpu: null, ramMb: 0, note: "" } });
  eq("what a friend said they could do is remembered on their row",
    [filed.status, filed.body.peer.resources.ready, filed.body.peer.resourcesAt], [200, ["h3"], 5]);
  const notACard = await call({ action: "set_resources", fp: other.fp, resources: { hello: true } });
  eq("...and something that is not a resource card is refused", [notACard.status, notACard.body.reason], [400, "bad-resources"]);
  /* ⚠ AND IT NEVER RETURNS AN EMPTY STRING. The age used to vanish for anything
   * unreadable — including a time in the FUTURE, which the sender chooses — so
   * the one field that stops a card being read as a live status line could be
   * removed by the person sending it. */
  eq("a card always prints its own age, because it looks exactly like a live reading",
    [resourcesM.ageOf(1000, 1000 + 3 * 3600_000), resourcesM.ageOf(1000, 1000 + 90 * 60_000),
     resourcesM.ageOf(1000, 1000 + 36 * 3600_000), resourcesM.ageOf(0, 5) === "",
     /future/.test(resourcesM.ageOf(9e12, 1000))],
    ["3 hours ago", "90 minutes ago", "1 day ago", false, true]);
  eq("and the read of one card against a job answers 'probably not' with a reason",
    resourcesM.couldTake({ kind: "resources", ready: ["flux2-klein"], gpu: { vramMb: 8192 } }, { capability: "h3" }).likely, false);


  /* ⚠ A CREDIT LIST FOLDED OUT OF A DOCUMENT WOULD BE WORTHLESS, because a
   * document is edited by whoever opens it. These pins hold the two properties
   * that make this one worth reading: it comes from the LEDGER, and a friend's
   * work stays a friend's — theirs, under their fingerprint, with their own
   * hand named inside it rather than flattened into ours. */
  const credit = await call({ action: "credit", slug: "demo" });
  eq("the credit list is folded from the ledger's own events",
    [credit.status, credit.body.events], [200, 6]);
  eq("...and every hand is counted as the kind it is",
    credit.body.byKind, { user: 1, agent: 2, script: 1, peer: 2, system: 0, unrecorded: 0 });
  /* ⚠ AN ACTOR NOTHING RECOGNISES IS `unrecorded`, NEVER `system` — `system`
   * prints as "this machine", which hands a stranger's work to the local owner:
   * a friend's fingerprint one character short used to read as theirs. */
  eq("...and an actor nothing recognises is not quietly awarded to this machine",
    creditM.creditRollup([{ actor: "collab:remote:user", type: "edit" },
                          { actor: `peer:${"ab".repeat(16)}:peer:${"cd".repeat(16)}:user`, type: "edit" }])
      .people.map((r) => r.kind),
    ["unrecorded", "unrecorded"]);
  ok("a friend's work is THEIRS, under their fingerprint, with their own hand named",
    credit.body.lines.some((l) => /'s agent kit — 1 recorded act: 1 render/.test(l))
    && credit.body.lines.some((l) => /'s own hand — 1 recorded act: 1 edit/.test(l)),
    JSON.stringify(credit.body.lines));
  /* A caller must not have to re-parse the actor string this module parses. */
  eq("...and the row says which hand on their machine, not only whose machine",
    credit.body.people.filter((r) => r.kind === "peer").map((r) => `${r.innerKind}:${r.innerName}`).sort(),
    ["agent:kit", "user:you"]);
  /* ⚠ THE HEADLINE NUMBER MUST BE WHAT WAS COUNTED. It used to be what was
   * handed in, so four unreadable ledger lines reported five acts and folded
   * two — and the page printed the five. */
  eq("what could not be read is reported rather than counted",
    (() => { const r = creditM.creditRollup([null, 42, [{}], { actor: "user", type: "edit" }]);
             return [r.events, r.skipped, r.people.reduce((n, p) => n + p.events, 0)]; })(),
    [1, 3, 1]);
  ok("...and none of it is counted as this machine's",
    !credit.body.lines.some((l) => /^you —.*render/.test(l)));
  /* The caveat travels with the numbers rather than living in a manual. */
  ok("the list says out loud that it counts acts and not merit",
    /counts of recorded acts/i.test(credit.body.note) && /nudged ten times/.test(credit.body.note));
  eq("a project name that is a path is refused here too",
    [(await call({ action: "credit", slug: "../../etc" })).body.reason], ["bad-slug"]);
  eq("eight tools now, and the two new ones only READ",
    [/name: "collab_resources"/.test(src("../mcp-collab.js")), /name: "collab_credit"/.test(src("../mcp-collab.js")),
     /collab_resources: null/.test(src("../chat/router.js")), /collab_credit: null/.test(src("../chat/router.js"))],
    [true, true, true, true]);


  /* ⚠ A CARD A FRIEND SENT IS READ, NEVER STORED AS SENT. Every field in one was
   * chosen by somebody else's machine: a 5 000-character note became a
   * 5 314-character sentence on this screen, a 50 kB object with a file path in
   * it went into peers.json whole, and a `gpu.name` that was a NUMBER threw out
   * of the page's own formatter and stopped the friend list painting. */
  const hostile = await call({ action: "set_resources", fp: other.fp, resources: {
    kind: "resources", v: 1, at: 7, gpu: { name: 12345 }, ramMb: "x", ready: "h3",
    makes: ["__proto__", "picture"], note: "Z".repeat(5000), stolen: "C:/Users/chesy/taxes.pdf",
  } });
  const stored = hostile.body.peer.resources;
  eq("a hostile card is bounded, whitelisted, and keeps nothing it was not asked for",
    [hostile.status, stored.note.length, stored.ready, stored.makes,
     Object.hasOwn(stored, "stolen"), typeof stored.gpu.name],
    [200, 280, [], ["picture"], false, "string"]);
  eq("...and a card from a version this Studio cannot read is refused, not guessed at",
    [(await call({ action: "set_resources", fp: other.fp, resources: { kind: "resources", v: 99 } })).body.reason],
    ["bad-resources"]);

  /* ⚠ AND A LEDGER THAT IS NOT INTACT SAYS SO ON THE FIRST LINE. A hash chain
   * over a local file proves only that no line was altered in place, so its
   * whole value is that tampering cannot be silent — returning the list without
   * the verdict spends it. */
  /* The roster is where a friend's card is read, so the age sentence is written
   * there — once, by the door, and never a second time on the page. */
  const listed = await call({ action: "roster" });
  const withCard = (listed.body.peers || []).find((x) => x.resources);
  ok("the roster hands the age down with the row rather than leaving the page to do the sum",
    !!withCard && typeof withCard.resourcesSaid === "string" && withCard.resourcesSaid.length > 3,
    JSON.stringify(withCard || null).slice(0, 200));

  /* ── THE LENDING LOOP ────────────────────────────────────────────────
   * ⚠ EVERY ONE OF THE NINE IS WALKED BELOW — free, orders, inbox,
   * quarantine, accept, send_back, receive, adopt and drop — not
   * pattern-matched. Nine actions went in green because a name is not
   * resolved until its line runs, and the FIRST pass of these pins walked
   * only seven of the nine, which is how `send_back` kept a 404 nobody
   * saw. */
  const freeNow = await call({ action: "free" });
  eq("the door answers whether this machine is free", [freeNow.status, freeNow.body.busy], [200, false]);
  machineState.engine = { ready: true, queue: { running: 1, pending: 0 }, running: [{ via: "reactive.motion", label: "a dance scene", elapsedSec: 240 }] };
  const busyNow = await call({ action: "free" });
  /* ⚠ THE READING THE DESIGN GOT WRONG. Every one of this app's own queues is
   * empty here and the card is fully committed. */
  eq("...and it sees work that never entered this app's own queues",
    [busyNow.body.busy, busyNow.body.reason, machineState.art.current, machineState.art.queued],
    [true, "engine-busy", null, 0]);

  const inbox = await call({ action: "inbox" });
  eq("the inbox is a folder and reading it opens nothing", [inbox.status, Array.isArray(inbox.body.items)], [200, true]);
  const q0 = await call({ action: "quarantine" });
  eq("quarantine starts empty", [q0.status, q0.body.takes.length], [200, 0]);
  const o0 = await call({ action: "orders" });
  eq("so does the order book", [o0.status, o0.body.orders.length], [200, 0]);

  /* An order, built here the way the door builds one, sealed by the friend's
   * machine to ours, and then accepted. */
  const theirKeys2 = await idM.privateKeys({ appData: friendHome });
  const shotForOrder = await packetM.shotPacket({ doc: DOC, segmentId: "s1_0", assetsDir: projectAssets });
  const orderFiles = [];
  for (const r of [...(shotForOrder.refs || []), ...(shotForOrder.guides || [])]) {
    orderFiles.push({ file: r.file, b64: (await readFile(path.join(projectAssets, r.file))).toString("base64") });
  }
  const orderDoc = orderM.makeOrder({
    shot: shotForOrder, files: orderFiles,
    order: { segmentId: "s1_0", seed: 7, steps: 8, engineMode: "h3" },
    /* ⚠ A REAL MOMENT. An order expires, and one stamped at the epoch's first
     * second is two thousand weeks stale before the door reads it — which is
     * exactly what the first run of this pin reported, correctly. */
    returnTo: { fp: friend.fp, nickname: "bucky" }, now: Date.now(),
  });
  const sealedOrder = sealM.sealTo({
    payload: Buffer.from(JSON.stringify(orderDoc), "utf8"),
    toSealPublicB64: me.body.sealPublic, toSignPublicB64: me.body.signPublic,
    toFp: me.body.fp, fromFp: friend.fp, signPrivate: theirKeys2.signPrivate,
  });
  const orderPath = path.join(out, "in", "order.aiplay");
  await mkdir(path.dirname(orderPath), { recursive: true });
  await writeFile(orderPath, sealedOrder);

  /* ⚠ THE PROMPT IS THE THING BEING AGREED TO, AND IT COMES BEFORE EVERY OTHER
   * CHECK. An order's card used to say "One scene, 5s at 1344x768, 8 steps" —
   * the SHAPE of the work and nothing about its CONTENT — so a friend could
   * have somebody's own machine draw anything at all and keep it on their disk,
   * approved by a person who had seen a resolution. The refusal carries the
   * prompt, which is what makes it a reading rather than a formality. */
  const unread = await call({ action: "accept", file: orderPath });
  eq("an order is not accepted until the prompt has been put in front of somebody",
    [unread.status, unread.body.reason, unread.body.prompt], [409, "not-seen", shotForOrder.prompt]);
  /* ⚠ AND THE PICTURES, WHICH DRIVE THE OUTPUT AS MUCH AS THE WORDS DO. The
   * card used to say "1 picture" — an integer — while those bytes became the
   * render's reference conditioning, which the model sees whether or not the
   * prompt mentions it. */
  eq("...along with the pictures themselves, not a count of them",
    [Array.isArray(unread.body.pictures), unread.body.pictures.length,
     /^data:image\/png;base64,/.test(unread.body.pictures[0]?.dataUrl || ""),
     unread.body.pictures[0]?.sha256?.length],
    [true, 1, true, 64]);
  /* The media type is read from the BYTES. A type taken from the wire is how a
   * picture becomes an SVG, and an SVG in an <img> is markup. */
  ok("...with a media type this machine read for itself",
    /pictureKind\(buf\)/.test(src("../index.js")) && /MIME_FOR\[kind\]/.test(src("../index.js")));
  ok("...and the sentence a person reads says what will be RENDERED, not only how big",
    /It will render:/.test(unread.body.describes || ""), unread.body.describes);
  /* ⚠ PIN 9 — WHAT A YES WOULD LOAD, BEFORE THE YES. An 8-step order on a PC
   * holding only the 4-step speed-up files (what the Models screen installs)
   * runs a 4-step file at 8 steps. The card says so, naming the file. */
  ok("the card names the speed-up file this PC lacks for the order's step count",
    /8 steps/.test(unread.body.speedUp || "") && /turbo_8step[^ ]*\.safetensors/.test(unread.body.speedUp || ""),
    unread.body.speedUp);
  /* ⚠ AND IT OFFERS ONLY WHAT THIS BUILD CAN DO. The Models screen fetches no
   * 8-step file, so "add it before you approve" was advice a newcomer could not
   * follow. The card says the count overruns the file that loads, that the
   * Models screen does not offer the matching one, and the two real choices. */
  ok("...says the order overruns the 4-step file, that the Models screen does not offer the 8-step one, and what can be done",
    /8 steps overruns it/.test(unread.body.speedUp || "") && /Models screen does not offer it/.test(unread.body.speedUp || "")
    && /render it as it is/.test(unread.body.speedUp || "") && /ask them to order 4 steps/.test(unread.body.speedUp || "")
    && !/add it before you approve/.test(unread.body.speedUp || ""),
    unread.body.speedUp);
  ok("...and says what the friend's minutes a day would be spent on, before anybody agrees",
    /minutes of your card a day/.test(unread.body.minutes || ""), unread.body.minutes);

  /* ⚠ BUSY FIRST. Accepting while the card is committed means a friend waits on
   * a take that is queued behind a render nobody told them about. */
  const whileBusy = await call({ action: "accept", file: orderPath, seen: true });
  eq("an order is refused while the card is busy", [whileBusy.status, whileBusy.body.reason], [409, "engine-busy"]);
  /* ⚠ PIN 7 — A BUSY LENDER CAN SAY YES FROM THE SCREEN. The refusal used to
   * end "Send it again with anyway:true", a parameter with no button. */
  ok("...and the refusal offers the screen's “Accept anyway”, listing what it walks past",
    whileBusy.body.overridable === true && /Accept anyway/.test(whileBusy.body.error)
    && !/Send it again with anyway:true/.test(whileBusy.body.error)
    && (whileBusy.body.overrides || []).map((o) => o.reason).join() === "engine-busy",
    JSON.stringify(whileBusy.body));
  /* ⚠ AND IT POINTS AT A BUTTON THAT IS ON THE SCREEN. "Accept anyway" lives
   * only in the question "Yes — take the job" asks, so the sentence says to
   * press that; "waits its turn" is said only when something is running. */
  ok("...naming the press that asks the question, and the wait behind what is running",
    /press “Yes — take the job” again and answer “Accept anyway”/.test(whileBusy.body.error)
    && /waits its turn/.test(whileBusy.body.error), whileBusy.body.error);
  /* ⚠ PIN 8 — THE MINUTES ARE READ. Zero minutes a day refuses; busy AND zero
   * minutes lists BOTH, so the one confirmation names everything a yes spends. */
  await call({ action: "set_lend_minutes", fp: friend.fp, minutesPerDay: 0 });
  const busyAndZero = await call({ action: "accept", file: orderPath, seen: true });
  eq("busy and out of minutes are listed together in one refusal",
    [busyAndZero.status, (busyAndZero.body.overrides || []).map((o) => o.reason), busyAndZero.body.overridable],
    [409, ["engine-busy", "budget-zero"], true]);
  machineState.engine = { ready: true, queue: { running: 0, pending: 0 }, running: [] };
  const zeroMinutes = await call({ action: "accept", file: orderPath, seen: true });
  eq("a friend given 0 minutes of this card is refused, and it can be walked past",
    [zeroMinutes.status, zeroMinutes.body.reason, zeroMinutes.body.overridable, /0 minutes of your card/.test(zeroMinutes.body.error)],
    [409, "budget-zero", true, true]);
  ok("...and a refusal for minutes alone does not say the scene waits behind a busy card",
    !/waits its turn/.test(zeroMinutes.body.error) && /Yes — take the job/.test(zeroMinutes.body.error), zeroMinutes.body.error);
  /* ...and `anyway` walks past the minutes, on a second order so the first can
   * still be accepted the ordinary way below. */
  {
    const second = orderM.makeOrder({ shot: shotForOrder, files: orderFiles,
      order: { segmentId: "s1_0", seed: 8, steps: 8, engineMode: "h3" },
      returnTo: { fp: friend.fp, nickname: "bucky" }, now: Date.now() });
    const secondPath = path.join(out, "in", "order-second.aiplay");
    await writeFile(secondPath, sealM.sealTo({ payload: Buffer.from(JSON.stringify(second), "utf8"),
      toSealPublicB64: me.body.sealPublic, toSignPublicB64: me.body.signPublic,
      toFp: me.body.fp, fromFp: friend.fp, signPrivate: theirKeys2.signPrivate }));
    const past = await call({ action: "accept", file: secondPath, seen: true, anyway: true });
    eq("“Accept anyway” takes the scene past the friend's minutes", [past.status, past.body.ok], [200, true]);
  }
  await call({ action: "set_lend_minutes", fp: friend.fp, minutesPerDay: 60 });

  const accepted = await call({ action: "accept", file: orderPath, seen: true });
  eq("an order becomes a project with a PROPOSED plan and nothing runs",
    [accepted.status, accepted.body.slug, accepted.body.plan], [200, "errand-1", "p_fake123"]);
  ok("...and the door says so in the words a person needs",
    /nothing has rendered/i.test(accepted.body.note) && /approve/i.test(accepted.body.note),
    accepted.body.note);
  /* ⚠ PIN 6 — THERE IS NO "PLAN SCREEN". The plan is the Plan card inside
   * Workflow, on the project this accept made, and the sentence names both. */
  ok("...and it names the real place: the rail's screen, the project's own title, the Plan card",
    new RegExp(`${lendingM.WORKFLOW_SCREEN} → “Order o_[0-9a-f]{8} from bucky” → the Plan card`).test(accepted.body.note)
    && !/plan screen/i.test(accepted.body.note) && accepted.body.title === "Order " + orderDoc.id.slice(0, 10) + " from bucky",
    accepted.body.note);
  ok("...and repeats the speed-up warning after the yes, where it cannot be scrolled past",
    /⚠ .*8 steps/.test(accepted.body.note) && accepted.body.speedUp === unread.body.speedUp, accepted.body.note);
  /* Case-insensitive: "the plan screen answered without a plan id" survived a
   * case-sensitive version of this pin. */
  ok("no sentence in the door sends anybody to a plan screen that does not exist, in any case",
    !/plan screen/i.test(src("../index.js").slice(src("../index.js").indexOf('if (p === "/api/collab" && req.method === "POST")'))));
  ok("...and no sentence the door writes names the screen by hand: it asks lending.js",
    !/Workflow →/.test(src("../index.js").slice(src("../index.js").indexOf('if (p === "/api/collab" && req.method === "POST")'))));
  /* The number behind "Minutes of my card per day", on the Friends row and in
   * collab_roster, without a refused accept being the only place it appears. */
  {
    const rows = (await call({ action: "roster" })).body.peers || [];
    const theirs = rows.find((x) => x.fp === friend.fp);
    ok("the roster says what a lending friend has used of this card today, in accept's own sentence",
      typeof theirs?.usedToday?.said === "string" && Number.isFinite(theirs.usedToday.measuredMinutes)
      && Number.isFinite(theirs.usedToday.pending), JSON.stringify(theirs?.usedToday));
    ok("...and says nothing of the kind for a friend who lends nothing",
      rows.filter((x) => x.role !== "lender" && x.role !== "collaborator").every((x) => x.usedToday === undefined));
  }
  /* ⚠ THE DOUBLE SPEND. The same bundle opened twice must not render twice. */
  eq("the same order accepted twice is refused rather than rendered again",
    [(await call({ action: "accept", file: orderPath, seen: true })).body.reason], ["already-landed"]);

  /* The owner's half: packing an order through the same door, with the same
   * verification and the same one sealer. */
  const packedOrder = await call({ action: "pack", slug: "demo", to: friend.fp, kind: "order", segmentId: "s1_0", seed: 11, steps: 8, engineMode: "h3" });
  eq("an order is packed for a lender, sealed, and written into the book",
    [packedOrder.status, packedOrder.body.kind, /^o_[0-9a-f]{12}$/.test(packedOrder.body.order || "")],
    [200, "order", true]);
  ok("...and the sentence a person reads says the scene, the size and the seed",
    /s1_0/.test(packedOrder.body.describes) && /seed 11/.test(packedOrder.body.describes), packedOrder.body.describes);
  eq("...the book has it, on the side this machine sent from",
    [(await call({ action: "orders" })).body.orders.length,
     (await call({ action: "orders" })).body.orders[0].state],
    [1, "sent"]);

  /* A take coming home. */
  const clipBytes = Buffer.from("not really a video, but the hash is the hash");
  const ret = orderM.makeReturn({
    orderId: orderDoc.id, segmentId: "s1_0",
    result: { bytes: clipBytes, ext: ".mp4" },
    probe: { frames: 141, fps: 24, width: 1344, height: 768, videoStreams: 1, audioStreams: 0 },
    record: { model: "h3", outputRights: { class: "yours-with-conditions" }, engine: "h3", steps: 8, seed: 7, ms: 1, actor: "agent:plan" },
    now: 2000,
  });
  const sealedReturn = sealM.sealTo({
    payload: Buffer.from(JSON.stringify(ret), "utf8"),
    toSealPublicB64: me.body.sealPublic, toSignPublicB64: me.body.signPublic,
    toFp: me.body.fp, fromFp: friend.fp, signPrivate: theirKeys2.signPrivate,
  });
  const retPath = path.join(out, "in", "return.aiplay");
  await writeFile(retPath, sealedReturn);
  /* The owner has to have sent the order for a return to answer it. */
  /* ⚠ THE DOOR'S OWN COLLAB DIRECTORY, not the output root. The route computes
   * `path.join(config.outputDir, "collab")`; a pin that writes beside it instead
   * of into it proves nothing. */
  const collabOut = path.join(out, "collab");
  await bookM.rememberOrder({ outDir: collabOut, row: {
    id: orderDoc.id, at: orderDoc.at, to: { fp: friend.fp, nickname: "bucky" },
    order: orderDoc.order, expect: { width: 1344, height: 768, frames: 141 }, slug: "demo",
  } });
  const received = await call({ action: "receive", file: retPath });
  eq("a take comes home into quarantine and not into the film",
    [received.status, received.body.ok, received.body.take.adopted], [200, true, false]);
  ok("...and the door says where it is and what is still needed",
    /quarantine/i.test(received.body.note) && /separate press/i.test(received.body.note), received.body.note);

  const adopted = await call({ action: "adopt", from: friend.fp, file: received.body.take.file });
  eq("adopting files a take under the friend's own name",
    [adopted.status, adopted.body.take?.peer?.fp ?? adopted.body.error ?? adopted.body.reason], [200, friend.fp]);
  /* ⚠ THE FIFTH ACTOR CLASS, WRITTEN. credit.js has read this shape since the
   * day it was built; this is the writer it was waiting for. */
  eq("...with the fifth actor class on the ledger event",
    adopted.body.event?.actor, `peer:${friend.fp}:agent:plan`);
  eq("...and the lender's own rights, verbatim, never looked up here",
    adopted.body.event?.data?.outputRights, { class: "yours-with-conditions" });
  /* ⚠ AND IT REALLY REACHED THE CHAIN. The event being returned is not the
   * event being written; quarantine.js builds it and the DOOR appends it, so
   * one writer holds the chain. */
  eq("...and the door is what put it on the chain, once",
    [appended.length, appended[0]?.evt?.actor, appended[0]?.evt?.asset],
    [1, `peer:${friend.fp}:agent:plan`, "mv/demo"]);
  ok("...as a take NOBODY HAS PICKED", !("pick" in adopted.body.take) && !("picked" in adopted.body.take));
  /* ⚠ PIN 1 — A BORROWER WITH NO CARD HAS RENDERED NOTHING, so every scene is a
   * scene with no clip row. The take used to land nowhere and the door said the
   * scene no longer existed. It is filed onto the scene now, still unpicked. */
  {
    const row = (projectStore.demo?.clips || []).find((c) => c.segmentId === "s1_0");
    eq("a take for a scene never rendered here is filed onto that scene, not lost",
      [adopted.body.filed, adopted.body.created, !!row, row?.takes?.length, row?.takes?.[0]?.peer?.fp, row?.clipIndex],
      [true, true, true, 1, friend.fp, 0]);
    eq("...and it is still nobody's pick: nothing plays on that scene until a person chooses",
      [row?.clipFile, row?.status], [undefined, undefined]);
    ok("...and the sentence says where to choose it, not that the scene is gone",
      /Inspect…/.test(adopted.body.note) && !/any more/.test(adopted.body.note), adopted.body.note);
  }
  eq("adopting the same take twice is refused",
    [(await call({ action: "adopt", from: friend.fp, file: received.body.take.file })).body.reason], ["already-adopted"]);

  /* ── A BORROWER'S RETURNS, walked through the door ─────────────────────
   * A friend's take for an order THIS door packed (so the row is the one the
   * build writes, not a hand-made fixture), measured here at `frames`. */
  const returnFor = async (orderId, { frames, seed = 11, steps = 8, turboSteps = null } = {}) => {
    machineState.probe = { frames, fps: 24, width: 1344, height: 768, seconds: frames / 24, videoStreams: 1, audioStreams: 0 };
    const r = orderM.makeReturn({ orderId, segmentId: "s1_0",
      result: { bytes: Buffer.from(`a take for ${orderId}, ${frames} frames, ${turboSteps}, ${Math.random()}`), ext: ".mp4" },
      probe: { ...machineState.probe },
      record: { model: "h3", outputRights: { class: "yours-with-conditions" }, engine: "h3", steps, seed, ms: 1, actor: "agent:plan", turboSteps },
      now: Date.now() });
    const file = path.join(out, "in", `return-${orderId}-${frames}-${turboSteps}.aiplay`);
    await writeFile(file, sealM.sealTo({ payload: Buffer.from(JSON.stringify(r), "utf8"),
      toSealPublicB64: me.body.sealPublic, toSignPublicB64: me.body.signPublic,
      toFp: me.body.fp, fromFp: friend.fp, signPrivate: theirKeys2.signPrivate }));
    return call({ action: "receive", file });
  };
  {
    /* ⚠ PIN 2 — THE FRAME COUNT IS THE RENDERER'S. The scene is 4 s; H3 rounds
     * a clip UP to n mod 17 == 5, so it renders 107 frames, and the old check
     * (round(4 × 24) = 96, ± 4) refused every correct take. */
    const sentRow = await bookM.findOrder({ outDir: collabOut, id: packedOrder.body.order, side: "out" });
    eq("the order book records the frame count the renderer will actually make",
      [sentRow.expect.engine, sentRow.expect.frames, sentRow.expect.slotFrames], ["h3", 107, 96]);
    const onGrid = await returnFor(packedOrder.body.order, { frames: 107 });
    eq("...so a correct H3 take, rounded up to its 17k+5 grid, is accepted",
      [onGrid.status, onGrid.body.ok], [200, true]);
    const handRounded = await returnFor(packedOrder.body.order, { frames: 96 });
    eq("...while a take of round(seconds × 24) frames is not what H3 makes, and the refusal says why",
      [handRounded.status, handRounded.body.reason, /steps of 17 frames/.test(handRounded.body.note)],
      [400, "result-not-the-shot", true]);

    /* ⚠ PIN 3 — "KEEP ANYWAY". A take that failed its checks stayed stuck:
     * the page's Keep sent no override, and only the tool had one. */
    const refusedFile = handRounded.body.take.file;
    eq("a take that failed its checks is not kept by an ordinary press",
      [(await call({ action: "adopt", from: friend.fp, file: refusedFile })).body.reason], ["return-refused"]);
    const keptAnyway = await call({ action: "adopt", from: friend.fp, file: refusedFile, anyway: true });
    eq("...and “Keep anyway” keeps it, filed onto its scene, with the ledger saying the checks did not pass",
      [keptAnyway.status, keptAnyway.body.event?.data?.checksPassed, keptAnyway.body.filed, keptAnyway.body.created],
      [200, false, true, false]);

    /* ⚠ PIN 9, THE BORROWER'S HALF — a take rendered on a 4-step file at 8
     * steps comes home saying so, in this machine's words. */
    const burned = await returnFor(packedOrder.body.order, { frames: 107, turboSteps: 4 });
    ok("a take rendered with a 4-step speed-up file at 8 steps comes home with a note saying so",
      burned.body.ok === true && (burned.body.take.notes || []).some((n) => /made for 4 steps/.test(n))
      && /made for 4 steps/.test(burned.body.note), JSON.stringify(burned.body).slice(0, 500));
    ok("...and a matched one carries no such note",
      !(onGrid.body.take.notes || []).length, JSON.stringify(onGrid.body.take.notes));

    /* ⚠ PIN 4 — LIP-SYNC DOES NOT TRAVEL, AND IT IS SAID. A singing board is
     * lent (a silent take beats none for somebody with no card) and every
     * sentence about it says the mouths will not follow the vocal. */
    const sing = await call({ action: "pack", slug: "demo-sing", to: friend.fp, kind: "order", segmentId: "s1_0", seed: 12, steps: 8, engineMode: "h3" });
    ok("a singing scene is lent, and the sentence both people read says lip-sync does not travel",
      sing.status === 200 && /Lip-sync does not travel/.test(sing.body.describes || ""), sing.body.describes || sing.body.error);
    const singRow = await bookM.findOrder({ outDir: collabOut, id: sing.body.order, side: "out" });
    eq("...the order book remembers why, as a word and not the song's name", singRow?.songUnder, "lipsync");
    const silent = await returnFor(sing.body.order, { frames: 107, seed: 12 });
    ok("...and the take that comes back says it was rendered without the song",
      (silent.body.take?.notes || []).some((n) => /without the song/.test(n)), JSON.stringify(silent.body).slice(0, 400));
  }

  /* ⚠ THE TAKE GOES BACK TO WHOEVER SIGNED THE ORDER. Without this a verified
   * friend could name a third party, and this machine would spend an hour of
   * its card and post the result to somebody it never agreed to send to. */
  {
    const elsewhere = orderM.makeOrder({
      shot: shotForOrder, files: orderFiles,
      order: { segmentId: "s1_0", seed: 7, steps: 8, engineMode: "h3" },
      returnTo: { fp: "f".repeat(32), nickname: "a stranger" }, now: Date.now(),
    });
    const sealedElsewhere = sealM.sealTo({
      payload: Buffer.from(JSON.stringify(elsewhere), "utf8"),
      toSealPublicB64: me.body.sealPublic, toSignPublicB64: me.body.signPublic,
      toFp: me.body.fp, fromFp: friend.fp, signPrivate: theirKeys2.signPrivate,
    });
    const p3 = path.join(out, "in", "elsewhere.aiplay");
    await writeFile(p3, sealedElsewhere);
    eq("an order whose take would go to a third party is refused",
      [(await call({ action: "accept", file: p3, seen: true })).body.reason], ["return-address"]);
  }
  /* ⚠ A VERIFIED FRIEND WITH NO ROLE may not spend the card, and the refusal
   * names the role to give in the Friends row's own words. The route reads
   * LENDER_ROLE_LABEL; this reaches that line, so a name the harness does not
   * hand over is a ReferenceError here, not in front of somebody. */
  {
    await call({ action: "set_role", fp: friend.fp, role: "none" });
    const noRoleAccept = await call({ action: "accept", file: orderPath, seen: true });
    await call({ action: "set_role", fp: friend.fp, role: "lender" });
    eq("an order from a verified friend with no role is refused by role, naming the role to give",
      [noRoleAccept.status, noRoleAccept.body.reason, (noRoleAccept.body.error || "").includes(`“${LENDER_ROLE_LABEL}”`)],
      [400, "role", true]);
  }
  /* ⚠ A PAUSED QUEUE ACCEPTS WORK THAT NEVER STARTS, so `anyway` may not
   * override it — a friend waiting on a take that is not coming is worse than a
   * refusal. */
  machineState.art = { paused: true, current: null, queued: 0 };
  const paused = await call({ action: "accept", file: orderPath, anyway: true, seen: true });
  eq("`anyway` overrides a busy card and never a paused queue",
    [paused.status, paused.body.reason, paused.body.overridable], [409, "art-paused", false]);
  machineState.art = { paused: false, current: null, queued: 0 };

  /* ⚠ THE ACCEPT CARD. An order opened as "an unreadable packet" and the four
   * words a person is agreeing to were only visible after they agreed. */
  const looked = await call({ action: "open", file: orderPath });
  ok("opening an order shows the four words before anybody agrees to them",
    /s1_0/.test(looked.body.describes || "") && /seed 7/.test(looked.body.describes || "")
    && /8 steps/.test(looked.body.describes || ""), looked.body.describes);

  /* ⚠ AND `send_back` AND `drop` ARE WALKED, because a branch nobody calls is a
   * branch nobody tested — which is how nine actions went in green. */
  const sent = await call({ action: "send_back", id: orderDoc.id });
  eq("the lender can seal the finished take home", [sent.status, /\.aiplay$/.test(sent.body.name || "")], [200, true]);
  {
    /* PIN 9, THE LENDER'S HALF OF THE WIRE: the step count the loaded speed-up
     * file was made for rides home as a NUMBER — never a file name. */
    const home2 = JSON.parse(sealM.openSealed({ blob: await readFile(sent.body.file), me: friend.fp,
      sealPrivate: theirKeys.sealPrivate, senderSignPublicB64: () => me.body.signPublic }).payload.toString("utf8"));
    ok("the return says which step count this PC's speed-up file was made for, as a number",
      Number.isInteger(home2.record.turboSteps) && !/safetensors/.test(JSON.stringify(home2.record)), JSON.stringify(home2.record));
  }
  const dropped = await call({ action: "drop", from: friend.fp, file: received.body.take.file });
  eq("and a take can be thrown away", [dropped.status, dropped.body.dropped], [200, received.body.take.file]);

  /* ⚠ A SEALED BUNDLE HAD NO SIZE, ANYWHERE. Measured by an attacker: 300 MB of
   * dense small objects expands past four gigabytes inside `JSON.parse` and V8
   * ABORTS the process — and a heap abort is not throwable, so every try/catch
   * around that parse is decoration. The app dies, from one file, sent by
   * anybody whose card is on the roster. The refusal is by `stat`, before a
   * byte is read. */
  {
    const fat = path.join(out, "in", "fat.aiplay");
    await writeFile(fat, Buffer.alloc(1024));
    /* A file over the cap is refused on its size alone — proved by asking the
     * door about a file whose CONTENT could never open. */
    const capped = sealM.MAX_BUNDLE_BYTES;
    ok("the door knows how big a bundle may be, and it is not unlimited",
      Number.isInteger(capped) && capped > 0 && capped <= 256 * 1024 * 1024, String(capped));
    eq("...and a bundle that is not a bundle is still refused rather than parsed",
      [(await call({ action: "open", file: fat })).body.reason], ["not-sealed"]);
    ok("...the module refuses an oversized blob without decrypting it",
      /too-big/.test(src("./seal.js")) && /MAX_BUNDLE_BYTES/.test(src("./seal.js")));
    ok("...and the door refuses by stat, before the bytes are in memory",
      /const info = await stat\(file\)/.test(src("../index.js"))
      && /reason: "too-big", status: 413/.test(src("../index.js")));
  }
  /* ⚠ AND A TAKE IS ONLY EVER THE ANSWER TO AN ORDER YOU SENT. `receive` writes
   * a peer's bytes to this disk; it used to do that for anybody whose card had
   * merely been added, unverified, with no role. */
  ok("receiving a take demands the same verification and role that sending the order did",
    /if \(!sender\.verified\) \{[\s\S]{0,400}nothing of theirs is written to this disk/.test(src("../index.js"))
    && /reason: "return-unknown-order"/.test(src("../index.js")));

  /* Exercise the frozen path through the actual route and decrypt its output.
   * Preview must have no courier/orderbook effects and its rolled seed must
   * survive sealing, rather than being rolled a second time. */
  const beforeFiles = fs.readdirSync(out, { recursive: true }).sort();
  const beforeOrders = (await call({ action: "orders" })).body.orders.length;
  const preview = await call({ action: "preview", slug: "demo", to: friend.fp, kind: "order", segmentId: "s1_0", steps: 8, engineMode: "h3" });
  eq("preview resolves a complete order without a supplied seed",
    [preview.status, Number.isInteger(preview.body.packet?.order?.seed), preview.body.kind], [200, true, "order"]);
  eq("preview writes neither a courier file nor an outgoing order",
    [fs.readdirSync(out, { recursive: true }).sort(), (await call({ action: "orders" })).body.orders.length], [beforeFiles, beforeOrders]);
  eq("the manifest distinguishes picture bytes included in an order",
    [preview.body.manifest?.map((row) => [row.file, row.bytes, row.included]), preview.body.includedBytes], [[['char_x.png', PNG.length, true]], PNG.length]);
  ok("the preview shows metadata, never picture base64", !JSON.stringify(preview.body).includes('"b64"'));
  const frozenPacked = await call({ action: "pack", previewId: preview.body.previewId });
  eq("a reviewed order can be packed using only its snapshot id", [frozenPacked.status, frozenPacked.body.order], [200, preview.body.packet.id]);
  const frozenInside = JSON.parse(sealM.openSealed({
    blob: await readFile(frozenPacked.body.file), me: friend.fp, sealPrivate: theirKeys.sealPrivate,
    senderSignPublicB64: () => me.body.signPublic,
  }).payload.toString("utf8"));
  eq("decryption recovers exactly the reviewed packet and original picture bytes", frozenInside,
    { ...preview.body.packet, files: preview.body.packet.files.map((row) => ({ ...row, b64: PNG.toString("base64") })) });
  eq("frozen packing records the same resolved seed", (await bookM.findOrder({ outDir: path.join(out, "collab"), id: frozenInside.id })).order.seed, preview.body.packet.order.seed);
  eq("packing consumes a preview only once", (await call({ action: "pack", previewId: preview.body.previewId })).body.reason, "preview-expired");

  const previewShot = () => call({ action: "preview", slug: "demo", to: friend.fp, kind: "shot", segmentId: "s1_0" });
  const shotPreview = await previewShot();
  eq("a scene handoff lists the same picture as metadata only", shotPreview.body.manifest?.map((row) => row.included), [false]);
  eq("new parameters cannot change a reviewed packet", (await call({ action: "pack", previewId: shotPreview.body.previewId, to: other.fp })).body.reason, "preview-changed");
  DOC.title = "Changed after review";
  eq("a project edit invalidates its outgoing preview", (await call({ action: "pack", previewId: shotPreview.body.previewId })).body.reason, "preview-stale");
  DOC.title = "A Demo";
  const changedAsset = await previewShot();
  await writeFile(path.join(projectAssets, "char_x.png"), Buffer.concat([PNG, Buffer.from([1])]));
  eq("an asset edit invalidates its outgoing preview", (await call({ action: "pack", previewId: changedAsset.body.previewId })).body.reason, "preview-stale");
  await writeFile(path.join(projectAssets, "char_x.png"), PNG);
  const changedRole = await previewShot();
  await call({ action: "set_role", fp: friend.fp, role: "none" });
  eq("a preview never bypasses the recipient's current role", (await call({ action: "pack", previewId: changedRole.body.previewId })).body.reason, "role");
  await call({ action: "set_role", fp: friend.fp, role: "lender" });
  const expiredPreview = await previewShot();
  previewClock += 15 * 60_000 + 1;
  eq("an expired snapshot must be reviewed again", (await call({ action: "pack", previewId: expiredPreview.body.previewId })).body.reason, "preview-expired");
  const rolelessPreview = await call({ action: "preview", to: other.fp, kind: "resources", note: "Only evenings" });
  eq("a verified friend with no role can preview a resource card", [rolelessPreview.status, rolelessPreview.body.packet?.note, rolelessPreview.body.manifest], [200, "Only evenings", []]);
  eq("and can receive that exact card", (await call({ action: "pack", previewId: rolelessPreview.body.previewId })).status, 200);

  /* ⚠ A COLLABORATOR'S FIRST SCENE IS NOT A BUDGET REFUSAL. Accept admits both
   * lending roles and reads their minutes; a friend made a collaborator from
   * "nothing yet" used to land at 0 and have every scene refused until
   * "Accept anyway". Both roles now start with the promotion allowance. */
  {
    await call({ action: "set_role", fp: friend.fp, role: "none" });
    const promoted = await call({ action: "set_role", fp: friend.fp, role: "collaborator" });
    const row = ((await call({ action: "roster" })).body.peers || []).find((x) => x.fp === friend.fp);
    eq("a friend made a collaborator starts with minutes of this card, as a lending friend does",
      [promoted.status, row?.role, row?.lendMinutesPerDay > 0], [200, "collaborator", true]);
    const third = orderM.makeOrder({ shot: shotForOrder, files: orderFiles,
      order: { segmentId: "s1_0", seed: 9, steps: 8, engineMode: "h3" },
      returnTo: { fp: friend.fp, nickname: "bucky" }, now: Date.now() });
    const thirdPath = path.join(out, "in", "order-third.aiplay");
    await writeFile(thirdPath, sealM.sealTo({ payload: Buffer.from(JSON.stringify(third), "utf8"),
      toSealPublicB64: me.body.sealPublic, toSignPublicB64: me.body.signPublic,
      toFp: me.body.fp, fromFp: friend.fp, signPrivate: theirKeys2.signPrivate }));
    const first = await call({ action: "accept", file: thirdPath, seen: true });
    eq("...so the collaborator's first scene is accepted without “Accept anyway”",
      [first.status, first.body.ok, first.body.reason], [200, true, undefined]);
    await call({ action: "set_role", fp: friend.fp, role: "lender" });
  }

  const broken = await callWith({ action: "credit", slug: "demo" }, { chainOk: false, corrupt: 2 });
  ok("a ledger whose chain is broken is reported before anything is credited",
    /not intact/.test(broken.body.lines[0]) && /line 100/.test(broken.body.lines[0])
    && broken.body.chain.ok === false && broken.body.corrupt === 2,
    JSON.stringify(broken.body.lines[0] || "").slice(0, 200));

  for (const d of [home, out, projectAssets, friendHome, theirs, clipLibrary]) await rm(d, { recursive: true, force: true });
}

await rm(appData, { recursive: true, force: true });
await rm(appData2, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
