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
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

import { identity, privateKeys, fingerprint, words, keyCard, readKeyCard, WORDLIST } from "./identity.js";
import { sealTo, openSealed } from "./seal.js";
import * as roster from "./roster.js";
import { shotPacket, projectBundle, describePacket } from "./packet.js";

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
  eq("a role is allowed once the words have been read aloud",
    (await roster.setRole({ appData, fp: peer.fp, role: "collaborator" })).role, "collaborator");
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
  await rm(assets, { recursive: true, force: true });
}

console.log("\n§6  the doors: a route, six tools, and three refusals that are the feature");
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
  eq("eight tools, and none of them verifies, lends or renders",
    ["collab_me", "collab_roster", "collab_resources", "collab_credit",
     "collab_add_peer", "collab_set_role", "collab_pack", "collab_open"]
      .filter((n) => new RegExp(`name: "${n}"`).test(mcp)).length, 8);
  ok("...and the absences are written down as decisions, not left as gaps",
    /An agent may not verify a friend/.test(mcp) && /An agent may not lend the card/.test(mcp)
    && /An agent may not render what arrives/.test(mcp));
  ok("the assistant may read who we are and who we know, and may not do the rest",
    /collab_me: null/.test(router) && /collab_roster: null/.test(router)
    && /collab_resources: null/.test(router)
    && /collab_add_peer: "/.test(router) && /collab_set_role: "/.test(router)
    && /collab_pack: "/.test(router) && /collab_open: "/.test(router));
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

  ok("...and the keys are made when it is opened, not at boot",
    /if \(name === "collab"\) paintCollab\(\);/.test(app));
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

  const [idM, sealM, rosterM, packetM, resourcesM, creditM] = [
    await import("./identity.js"), await import("./seal.js"),
    await import("./roster.js"), await import("./packet.js"),
    await import("./resources.js"), await import("./credit.js"),
  ];
  const home = await mkdtemp(path.join(tmpdir(), "aiplay-door-"));
  const out = await mkdtemp(path.join(tmpdir(), "aiplay-door-out-"));
  const projectAssets = await mkdtemp(path.join(tmpdir(), "aiplay-door-assets-"));
  await writeFile(path.join(projectAssets, "char_x.png"), Buffer.from([9, 9, 9, 9]));
  const DOC = {
    slug: "demo", title: "A Demo", styleBible: "a dim red room",
    song: { file: "song.flac" }, lyricLines: [{ t: 0, text: "a secret line" }],
    segments: [{ id: "s1_0", index: 0, startSec: 0, endSec: 4, durationSec: 4 }],
    boards: [{ segmentId: "s1_0", boardPrompt: "She turns away.", shots: [{ action: "Close." }], characterRefs: ["Hex"] }],
    characters: [{ id: "c1", name: "Hex", imageFile: "char_x.png" }],
    clips: [],
  };

  const names = ["p", "req", "res", "json", "readBody", "config", "path", "mkdir", "writeFile", "readFile",
    "collabIdentity", "collabPrivateKeys", "keyCard", "readKeyCard", "collabWords",
    "sealTo", "openSealed", "collabRoster", "shotPacket", "projectBundle", "describePacket",
    "readMvProject", "mvAssetsDir", "models", "gpuStatus", "ramStatus",
    "resourceCard", "readResourceCard", "describeResources", "ageOf",
    "prov", "creditRollup", "creditLines", "stat"];
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
  const callWith = (b, { chainOk = true, corrupt = 0 } = {}, headers = { origin: "http://127.0.0.1:4173" }) => {
    let answered = null;
    const json = (_res, status, payload) => { answered = { status, body: payload }; return answered; };
    return run(
      "/api/collab", { method: "POST", headers }, {}, json, async () => b,
      { paths: { appData: home }, outputDir: out, uiPort: 4173 },
      path, mkdir, writeFile, readFile,
      idM.identity, idM.privateKeys, idM.keyCard, idM.readKeyCard, idM.words,
      sealM.sealTo, sealM.openSealed, rosterM,
      packetM.shotPacket, packetM.projectBundle, packetM.describePacket,
      async (slug) => (slug === "demo" ? DOC : null), () => projectAssets,
      /* A model manager narrow enough that it cannot hide a mistake: two rows,
       * one ready and one not, which is all the redaction has to chew on. */
      { status: async () => [{ id: "flux2-klein", ready: true, makes: "image" }, { id: "h3", ready: false, makes: "video" }] },
      () => ({ name: "A Card", totalMb: 16376, vendor: "nvidia" }), () => ({ totalMb: 32768 }),
      resourcesM.resourceCard, resourcesM.readResourceCard, resourcesM.describeResources, resourcesM.ageOf,
      /* A ledger with one of every hand in it, including the fifth class that
       * nothing writes yet, so the reader is exercised before the writer
       * exists rather than after somebody notices it never was. */
      { verify: async () => ({ ok: chainOk, brokenAt: chainOk ? null : 100 }), read: async () => ({ corrupt, events: LEDGER }) },
      creditM.creditRollup, creditM.creditLines,
      async () => ({ isFile: () => true }),
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
    [mine.status, mine.body.resources.ready, mine.body.resources.makes], [200, ["flux2-klein"], ["image"]]);
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

  const broken = await callWith({ action: "credit", slug: "demo" }, { chainOk: false, corrupt: 2 });
  ok("a ledger whose chain is broken is reported before anything is credited",
    /not intact/.test(broken.body.lines[0]) && /line 100/.test(broken.body.lines[0])
    && broken.body.chain.ok === false && broken.body.corrupt === 2,
    JSON.stringify(broken.body.lines[0] || "").slice(0, 200));

  for (const d of [home, out, projectAssets, friendHome, theirs]) await rm(d, { recursive: true, force: true });
}

await rm(appData, { recursive: true, force: true });
await rm(appData2, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(failures.length ? 1 : 0);
