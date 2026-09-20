/**
 * The provenance ledger's guard suite — runs on every commit, no server, no
 * python, no GPU.
 *
 * What it pins, and why each pin exists:
 *
 *   · append/read/verify — the hash chain actually chains, a tampered line is
 *     actually caught, and an unknown event type in a file round-trips
 *     unharmed (the SPEC's forward-compatibility rule).
 *   · ACTOR HONESTY (D1.0) — the invariant everything else stands on: an
 *     MCP-shaped request stamps agent:*, a headerless request is the user,
 *     and NOTHING — not a spoofed header, not a malformed value, not a
 *     config — records as "user" without being the browser. One demonstrated
 *     fabrication would poison every honest dossier this tool ever produced.
 *   · the origin fold (D1.3) — only a USER's edit promotes ai-generated to
 *     ai-assisted-human-edited; agent edits never do.
 *   · Tier 1 is unstrippable via any exposed option — source pins on
 *     tag_audio.py (marker before/outside the tier2 gate, no tier1 key) and
 *     imgexport.py (the metadata option grew "none" but the marker is not
 *     gated on it; the strip default writes provenance XMP).
 *   · the seams exist — index.js and vfx/routes.js actually call the ledger
 *     where the SPEC says events happen, and the MCP surface declares
 *     provenance_read honestly.
 *   · NO MODULE FABRICATES A HUMAN — a source sweep over server/ for a
 *     hardcoded `actor: "user"` or a parameter defaulting to it. The runtime
 *     guards catch a FORGED actor; only this catches a module that never asks
 *     who is calling and writes a person down itself. Both shapes shipped
 *     (Reactive's renders, the Ear's four event builders) before it existed.
 *   · OUTPUT RIGHTS (D6) — every catalogue entry answers "may I sell what this
 *     made", no verdict ships without the publisher's own sentence attached,
 *     every engine name the app can write resolves to a capability, and a
 *     `generate` event carries the answer that was true WHEN IT WAS WRITTEN.
 *     The one class allowed to ship without a quote is `unknown`, because
 *     "nobody has read it" is the honest answer for a gated licence and a
 *     confident guess in either direction costs somebody real money.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  append, read, verify, head, foldOrigin, markerFor, normalizeActor, actorFrom,
  DIGITAL_SOURCE_TYPE, EVENT_TYPES, GENESIS, sha256hex,
} from "./provenance.js";
import { TOOLS } from "./mcp.js";
import {
  CATALOG, OUTPUT_RIGHTS_CLASSES, MODEL_TO_CAPABILITY, outputRightsFor, rightsStampFor,
} from "./models.js";
import { config } from "./config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "prov-test-"));
const scope = { dir: tmp };
const ledgerFile = path.join(tmp, "provenance.jsonl");

/* ── the chain ─────────────────────────────────────────────────────────── */
console.log("\n  -- append, read, verify --");

await append(scope, { actor: "user", type: "author_text", asset: "song.flac", data: { field: "lyrics", chars: 42 } });
await append(scope, { actor: "user", type: "generate", asset: "song.flac", data: { model: "MiniMax-Music3", seed: 7 } });
await append(scope, { actor: "agent:claude", type: "edit", asset: "song.flac", data: { op: "trim" } });

let r = await read(scope, { asset: "song.flac" });
ok("three events round-trip", r.events.length === 3);
ok("events carry v/id/t/prev", r.events.every((e) => e.v === 1 && e.id && e.t && e.prev));
ok("the first event's prev is the genesis marker", r.events[0].prev === GENESIS);

let v = await verify(scope);
ok("the untouched chain verifies", v.ok === true && v.count === 3, JSON.stringify(v));
ok("head() agrees with verify()", (await head(scope)) === v.head);

// Parallel appends must serialise, not interleave.
await Promise.all([
  append(scope, { actor: "user", type: "edit", asset: "song.flac", data: { op: "a" } }),
  append(scope, { actor: "user", type: "edit", asset: "song.flac", data: { op: "b" } }),
  append(scope, { actor: "user", type: "edit", asset: "song.flac", data: { op: "c" } }),
]);
v = await verify(scope);
ok("concurrent appends keep the chain intact", v.ok === true && v.count === 6, JSON.stringify(v));

// Tamper with a middle line: the chain must name the break.
{
  const lines = readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean);
  const evil = JSON.parse(lines[1]);
  evil.actor = "user";                       // the classic fabrication
  evil.data = { model: "human hands" };
  const tampered = [...lines];
  tampered[1] = JSON.stringify(evil);
  const evilFile = path.join(tmp, "tampered");
  writeFileSync(path.join(evilFile), "");     // scope dirs hold provenance.jsonl
  const evilScope = { dir: path.join(tmp, "evil") };
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.join(tmp, "evil"), { recursive: true });
  writeFileSync(path.join(tmp, "evil", "provenance.jsonl"), tampered.join("\n") + "\n");
  const tv = await verify(evilScope);
  ok("a rewritten line breaks the chain at the next event", tv.ok === false && tv.brokenAt === 2, JSON.stringify(tv));
}

// Unknown types: refused on WRITE (a typo is a bug), unharmed on READ
// (a future build's events must survive an old build's tools).
{
  let threw = false;
  try { await append(scope, { actor: "user", type: "future_thing", asset: "x" }); } catch { threw = true; }
  ok("an unknown type on write throws", threw);
  threw = false;
  try { await append(scope, { actor: "user", type: "edit" }); } catch { threw = true; }
  ok("a missing asset on write throws", threw);

  // Hand-build a chained file containing a type this build has never heard of.
  const futureDir = path.join(tmp, "future");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(futureDir, { recursive: true });
  const l1 = JSON.stringify({ v: 1, id: "01", t: "2026-08-26T00:00:00Z", actor: "user", type: "generate", asset: "a", data: {}, prev: GENESIS });
  const l2 = JSON.stringify({ v: 2, id: "02", t: "2026-08-26T00:00:01Z", actor: "user", type: "quantum_take", asset: "a", data: { q: 1 }, prev: `sha256:${sha256hex(l1)}` });
  writeFileSync(path.join(futureDir, "provenance.jsonl"), l1 + "\n" + l2 + "\n");
  const fr = await read({ dir: futureDir }, { asset: "a" });
  const fv = await verify({ dir: futureDir });
  ok("an unknown type round-trips unharmed and still chains",
    fr.events.length === 2 && fr.events[1].type === "quantum_take" && fr.events[1].data.q === 1 && fv.ok);
}

/* ── actor honesty (D1.0/D1.4) ─────────────────────────────────────────── */
console.log("\n  -- actor honesty: nothing fabricates a human --");

ok("no header → user (the browser is the only headerless caller)",
  actorFrom({ headers: {} }) === "user");
ok("agent header → that agent", actorFrom({ headers: { "x-aiplay-actor": "agent:claude" } }) === "agent:claude");
ok("agent header is normalised, never dropped",
  actorFrom({ headers: { "x-aiplay-actor": "agent:Claude" } }) === "agent:claude");
ok("a header CLAIMING to be the user records as system — the browser never sets the header",
  actorFrom({ headers: { "x-aiplay-actor": "user" } }) === "system");
ok("a malformed header records as system, never user",
  actorFrom({ headers: { "x-aiplay-actor": "totally-a-human" } }) === "system");
ok("normalizeActor: garbage → system", normalizeActor("root") === "system" && normalizeActor(null) === "system");
ok("normalizeActor: user and system pass through",
  normalizeActor("user") === "user" && normalizeActor("system") === "system");

// The MCP fixture: build the header EXACTLY the way mcp.js builds it, and
// pin in its source that no code path there can produce anything else.
{
  const mcpSrc = readFileSync(path.join(HERE, "mcp.js"), "utf8");
  ok("mcp.js sends x-aiplay-actor on every api() call", mcpSrc.includes('"x-aiplay-actor": ACTOR'));
  ok("mcp.js forces the agent: prefix in code — no env can shed it",
    /const ACTOR = "agent:" \+/.test(mcpSrc));
  const name = ("anything the env might say").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 32) || "mcp";
  const mcpHeader = "agent:" + name;
  const stamped = actorFrom({ headers: { "x-aiplay-actor": mcpHeader } });
  ok("an MCP-driven request stamps agent:*, whatever the env said",
    stamped.startsWith("agent:") && stamped !== "user");
  // And an event written with it lands as that agent.
  const e = await append(scope, { actor: stamped, type: "edit", asset: "song.flac", data: { op: "mcp-fixture" } });
  ok("the MCP fixture's event carries the agent actor", e.actor.startsWith("agent:"));
}

/* ── script:<name>, THE FOURTH CLASS ───────────────────────────────────────
 *
 * A harness — gate_run, vace_run, the fifteen probe scripts — is not a person
 * and is not a model deciding anything. Before the engine door existed it was
 * also not RECORDED: on the night of 2026-09-01, 245 renders were posted
 * straight at ComfyUI by three scripts and none of them appears in this ledger.
 *
 * What this class buys is a NAME on a line that would otherwise have said only
 * "system". What it must NOT buy is standing. Every check below is therefore
 * one of two shapes: "the name survives" or "the name changes nothing", and the
 * second shape is the load-bearing one — a fourth actor class that could shift
 * an origin class would be a labelling claim nobody measured. */
console.log("\n  -- script:<name>: a harness is named, and gains nothing by it --");
{
  ok("normalizeActor keeps a harness name", normalizeActor("script:gate_run") === "script:gate_run");
  ok("...lowercased, like an agent", normalizeActor("script:Gate_Run") === "script:gate_run");
  ok("...and dots and dashes are legal, because basenames have them",
    normalizeActor("script:h3_quality-sweep.v2") === "script:h3_quality-sweep.v2");
  ok("a bare `script:` is not a name → system", normalizeActor("script:") === "system");
  ok("a colon inside the name is refused — a basename has no colons",
    normalizeActor("script:a:b") === "system");
  ok("an over-long name is refused rather than truncated into a different script",
    normalizeActor("script:" + "x".repeat(41)) === "system");
  ok("the header form works the same way",
    actorFrom({ headers: { "x-aiplay-actor": "script:gate_run" } }) === "script:gate_run"
    && actorFrom({ headers: { "x-aiplay-actor": "script:" } }) === "system");
  ok("a harness still cannot claim to be the user",
    actorFrom({ headers: { "x-aiplay-actor": "user" } }) === "system"
    && normalizeActor("script:user") === "script:user"
    && normalizeActor("script:user") !== "user");

  // It reaches the file, and it round-trips.
  const e = await append(scope, { actor: "script:gate_run", type: "delegate", asset: "engine/testrun", data: { via: "api" } });
  ok("a harness event lands with its own name in the ledger", e.actor === "script:gate_run");
  const back = await read(scope, { asset: "engine/testrun" });
  ok("...and reads back unchanged", back.events[0]?.actor === "script:gate_run");
  ok("...and the chain is still intact after it", (await verify(scope)).ok === true);

  /* ⚠ THE PIN THAT MATTERS. The same stream folds to the same class with the
   * harness named and with it flattened to "system" — because `actorGroup`
   * maps script:* to system, which is exactly what the header used to be
   * coerced to before this class existed. If a future edit gives script:* its
   * own group, or its own branch in foldOrigin, this fails. */
  // Local, because the shared `E` below is declared after this block.
  const Ev = (actor, type, data = {}) => ({ actor, type, asset: "x", data, t: "2026-09-03T00:00:00Z" });
  const asScript = [Ev("user", "generate", { model: "ltx" }), Ev("script:gate_run", "edit"), Ev("script:gate_run", "generate", { model: "ltx" })];
  const asSystem = [Ev("user", "generate", { model: "ltx" }), Ev("system", "edit"), Ev("system", "generate", { model: "ltx" })];
  const a = foldOrigin(asScript), b = foldOrigin(asSystem);
  ok("a script's events fold EXACTLY as the same events folded before the class existed",
    a.class === b.class && a.model === b.model && a.editsBy.system === b.editsBy.system
    && a.editsBy.user === b.editsBy.user && a.editsBy.agent === b.editsBy.agent,
    `${a.class}/${JSON.stringify(a.editsBy)} vs ${b.class}/${JSON.stringify(b.editsBy)}`);
  ok("a script's EDIT never promotes ai-generated to ai-assisted-human-edited",
    foldOrigin([Ev("user", "generate", { model: "ltx" }), Ev("script:gate_run", "edit")]).class === "ai-generated");
  ok("a script's author_text claims nothing, exactly as an agent's does not",
    foldOrigin([Ev("script:gate_run", "author_text")]).class === null);
  ok("a script counts as a system edit, not an agent one",
    foldOrigin([Ev("script:gate_run", "edit", { origin: "unrecorded" })]).editsBy.system === 1);
}

/* ── the origin fold (D1.3) ────────────────────────────────────────────── */
console.log("\n  -- origin classes: most specific TRUE class, never the most flattering --");

const E = (actor, type, data = {}) => ({ actor, type, asset: "x", data, t: "2026-08-26T00:00:00Z" });
ok("generate → ai-generated with the model named",
  (() => { const o = foldOrigin([E("user", "generate", { model: "m3" })]); return o.class === "ai-generated" && o.model === "m3"; })());
ok("an AGENT edit does not promote ai-generated",
  foldOrigin([E("user", "generate", { model: "m3" }), E("agent:claude", "edit")]).class === "ai-generated");
ok("a SYSTEM edit does not promote either",
  foldOrigin([E("user", "generate", { model: "m3" }), E("system", "edit")]).class === "ai-generated");
ok("a USER edit promotes to ai-assisted-human-edited",
  foldOrigin([E("user", "generate", { model: "m3" }), E("user", "edit")]).class === "ai-assisted-human-edited");
ok("author_text by a user, alone → human-authored",
  foldOrigin([E("user", "author_text")]).class === "human-authored");
ok("author_text by an agent claims nothing",
  foldOrigin([E("agent:claude", "author_text")]).class === null);
ok("record → human-recorded, and a later generate does not overwrite a capture",
  foldOrigin([E("user", "record"), E("system", "generate", { model: "m3" })]).class === "human-recorded");
ok("licence_attach → third-party-licensed with the attribution kept",
  (() => { const o = foldOrigin([E("user", "import"), E("user", "licence_attach", { spdx: "CC-BY-4.0", attributionText: "T" })]);
    return o.class === "third-party-licensed" && o.attributions[0].spdx === "CC-BY-4.0" && o.attributions[0].text === "T"; })());
ok("edit counts are split by actor group, honestly",
  (() => { const o = foldOrigin([E("user", "generate", {}), E("user", "edit"), E("agent:x", "edit"), E("system", "edit")]);
    return o.editsBy.user === 1 && o.editsBy.agent === 1 && o.editsBy.system === 1; })());

/* ── plan_step: PROCESS EVIDENCE, NOT AUTHORSHIP ───────────────────────────
 *
 * The plan object (server/mv/plan.js) records that an APPROVED item was
 * EXECUTED at a time, producing an asset. No existing type could say that
 * without claiming something untrue: `generate`/`regen`/`edit` claim authorship
 * of the artefact, and `choice`/`judge` claim a decision that was not made by
 * the runner — it was made earlier, by whoever approved the item, and each
 * plan_step names that event in `approvedBy`.
 *
 * ⚠ THE PIN THAT MATTERS IS THAT IT CHANGES NOTHING. A render that ran under a
 * plan is neither more nor less AI-generated than the same render run by hand,
 * so the fold must return the identical class with and without these events. If
 * a future change gives plan_step a branch in foldOrigin, this fails — which is
 * the point: promoting or demoting an origin class on the strength of HOW a
 * render was scheduled would be a labelling claim nobody measured. */
ok("plan_step is a legal event type", EVENT_TYPES.has("plan_step"));
{
  const without = [E("user", "generate", { model: "h3" }), E("user", "edit")];
  const with_ = [
    E("user", "generate", { model: "h3" }),
    E("agent:plan", "plan_step", { planId: "p_1", itemId: "i1", ok: true, approvedBy: "ev1" }),
    E("user", "edit"),
    E("agent:plan", "plan_step", { planId: "p_1", itemId: "i2", ok: false }),
  ];
  const a = foldOrigin(without), b = foldOrigin(with_);
  ok("...and folds to the IDENTICAL origin class, with and without it",
    a.class === b.class && a.model === b.model, `${a.class} vs ${b.class}`);
  ok("...promoting nothing: an agent's execution is not a human's edit",
    b.editsBy.user === a.editsBy.user && b.editsBy.agent === a.editsBy.agent);
  ok("...but it IS counted, so the ledger can still say the run happened",
    b.counts.plan_step === 2);
  ok("...and the runner's own actor is an agent, never the human who pressed Run",
    with_.filter((e) => e.type === "plan_step").every((e) => e.actor.startsWith("agent:")));
}

/* ── markers and the vocabulary ────────────────────────────────────────── */
console.log("\n  -- the IPTC mapping --");

ok("all five origin classes map to a DigitalSourceType strategy",
  ["human-recorded", "human-authored", "ai-generated", "ai-assisted-human-edited", "third-party-licensed"]
    .every((c) => c in DIGITAL_SOURCE_TYPE));
ok("ai-generated → trainedAlgorithmicMedia",
  DIGITAL_SOURCE_TYPE["ai-generated"].endsWith("/trainedAlgorithmicMedia"));
ok("ai-assisted-human-edited → compositeWithTrainedAlgorithmicMedia",
  DIGITAL_SOURCE_TYPE["ai-assisted-human-edited"].endsWith("/compositeWithTrainedAlgorithmicMedia"));
ok("human classes → digitalCreation / digitalCapture",
  DIGITAL_SOURCE_TYPE["human-authored"].endsWith("/digitalCreation")
  && DIGITAL_SOURCE_TYPE["human-recorded"].endsWith("/digitalCapture"));
{
  const tagSrc = readFileSync(path.join(HERE, "tag_audio.py"), "utf8");
  // Checked on the live mapping's VALUES (comments may name them as warnings).
  ok("the RETIRED terms are never written (minorHumanEdits, digitalArt)",
    !Object.values(DIGITAL_SOURCE_TYPE).some((u) => /minorHumanEdits|digitalArt/.test(u || ""))
    && !/minorHumanEdits|digitalArt/.test(tagSrc));
  const m = markerFor("ai-generated", { model: "MiniMax-Music3", media: "audio" });
  ok("markerFor carries URI + disclosure + generator + tool",
    m.digitalSourceType.includes("trainedAlgorithmicMedia") && /MiniMax-Music3/.test(m.disclosure)
    && m.generator === "MiniMax-Music3" && /AIPLAY Studio/.test(m.tool));
  ok("an unknown class falls back to the honest composite, not to a claim",
    markerFor("nonsense").digitalSourceType.endsWith("/composite"));
}

/* ── Tier 1 is pinned: source guards on the two writers ────────────────── */
console.log("\n  -- Tier 1 unstrippable via any exposed option --");

{
  const tag = readFileSync(path.join(HERE, "tag_audio.py"), "utf8");
  ok("tag_audio writes DIGITALSOURCETYPE + AI_DISCLOSURE", tag.includes("DIGITALSOURCETYPE") && tag.includes("AI_DISCLOSURE"));
  const markerAt = tag.indexOf("dst_key");
  const tier2At = tag.indexOf('raw.get("tier2")');
  ok("the marker block sits OUTSIDE and BEFORE the tier2 gate",
    markerAt > 0 && tier2At > 0 && markerAt < tier2At);
  ok("no tier1 key exists to read", !tag.includes('raw.get("tier1")'));
  ok("the tier2 gate governs the record only (the STYLE_PROMPT write is inside it)",
    tag.indexOf('"STYLE_PROMPT": str(') > tier2At);
}
{
  const ix = readFileSync(path.join(HERE, "imgexport.py"), "utf8");
  ok("imgexport's metadata option is the three-valued pick with strip as default",
    /pick\(\["strip", "preserve", "none"\], "strip"/.test(ix));
  ok("the record — and only the record — is gated on metadata 'none'",
    ix.includes('provenance.get("record") if meta.get("metadata") != "none"'));
  ok("the marker is taken ungated",
    ix.includes('marker = provenance.get("marker") or None'));
  ok("export() and target_size() both apply provenance",
    (ix.match(/apply_provenance\(/g) || []).length >= 4);
}
{
  const cfg = readFileSync(path.join(HERE, "config.js"), "utf8");
  ok("config exposes exactly two provenance prefs (display + record), no marker key",
    (cfg.match(/\["provenance", /g) || []).length === 2
    && cfg.includes('["provenance", "showBadges"') && cfg.includes('["provenance", "embedRecord"'));
}

/* ── the seams exist ───────────────────────────────────────────────────── */
console.log("\n  -- the capture seams are wired --");

{
  const ix = readFileSync(path.join(HERE, "index.js"), "utf8");
  const seams = (ix.match(/provNote\(/g) || []).length;
  ok(`index.js calls the ledger at its seams (${seams} provNote sites, need ≥ 10)`, seams >= 10);
  ok("the generate routes stamp the actor at the API boundary",
    (ix.match(/actor: prov\.actorFrom\(req\)/g) || []).length >= 4);
  ok("/api/provenance and its settings route exist",
    ix.includes('p === "/api/provenance"') && ix.includes('p === "/api/provenance/settings"'));
  ok("the image export job carries the provenance payload", ix.includes("provenance: provPayload"));
  ok("the opus export writes the sidecar", ix.includes("writeSidecar"));
}
{
  const vr = readFileSync(path.join(HERE, "vfx", "routes.js"), "utf8");
  ok("the vfx render-done branch logs to the comp's own ledger", vr.includes("renders/${outName"));
  ok("audio_notes transcriptions land as ai-generated analysis", vr.includes("notes/${srcName}"));
  ok("vfx actor comes from the request headers, never the body", vr.includes("prov.actorFrom(req)"));
}

/* -- the ledger's own bookkeeping ---------------------------------------- */
console.log("\n  -- a ledger deleted and recreated at the same path starts a NEW chain --");

{
  /* Deleting a project deletes its ledger; a project recreated under the same
   * slug lands on the same path. The writer caches the chain head per FILE, so
   * without invalidation the first event of the new ledger inherits the old
   * head and verify() reports a broken chain for a file nobody touched.
   * Found live 2026-08-26 by the Ear's loop demo (which recreates its demo
   * project at a fixed slug); this is the pin. */
  const dir = mkdtempSync(path.join(os.tmpdir(), "prov-recreate-"));
  const sc = { dir };
  const file = path.join(dir, "provenance.jsonl");
  await append(sc, { actor: "user", type: "author_text", asset: "a", data: {} });
  await append(sc, { actor: "user", type: "author_text", asset: "a", data: {} });
  ok("the first ledger verifies", (await verify(sc)).ok === true);
  rmSync(file, { force: true });                       // the project was deleted
  const ev = await append(sc, { actor: "user", type: "author_text", asset: "a", data: {} });
  ok("the recreated ledger's first event starts from genesis, not the dead head",
     ev.prev === GENESIS, String(ev.prev));
  const v = await verify(sc);
  ok("...so the recreated ledger verifies clean", v.ok === true, JSON.stringify(v));
  ok("...and holds exactly the new event", v.count === 1, String(v.count));
  rmSync(dir, { recursive: true, force: true });
}

/* ── the MCP surface ───────────────────────────────────────────────────── */
console.log("\n  -- provenance_read and the tool descriptions --");

{
  const t = TOOLS.find((x) => x.name === "provenance_read");
  ok("provenance_read exists", !!t);
  ok("provenance_read: additionalProperties false", t?.inputSchema?.additionalProperties === false);
  const src = String(t?.run || "");
  const dropped = Object.keys(t?.inputSchema?.properties || {}).filter((p) => !src.includes(p));
  ok("provenance_read: every declared parameter is named in run()", dropped.length === 0, dropped.join(", "));
  const shouldMention = ["make_song", "image_adjust", "image_document", "image_export",
    "image_cutout", "image_upscale", "make_image", "make_clip", "restyle_clip", "studio_bounce"];
  const silent = shouldMention.filter((n) => {
    const tool = TOOLS.find((x) => x.name === n);
    return !tool || !/provenance/i.test(tool.description);
  });
  ok("every logging tool says so in one sentence", silent.length === 0, silent.join(", "));
}

/* ── output rights: the catalogue guard ────────────────────────────────── */
console.log("\n  -- output rights: every model answers 'may I sell this' --");

{
  /* THE POINT OF THIS SECTION. A capability added next year must not be able to
   * skip the rights question in silence — silence reads as permission to the
   * one person it costs money. Every entry answers, and the only answer allowed
   * to ship without the publisher's own sentence attached is `unknown`, which
   * is an admission rather than a verdict. */
  const CLASSES = Object.keys(OUTPUT_RIGHTS_CLASSES);
  ok("exactly four classes, no fifth", CLASSES.length === 4 && CLASSES.includes("unrestricted")
    && CLASSES.includes("yours-with-conditions") && CLASSES.includes("not-for-sale")
    && CLASSES.includes("unknown"), CLASSES.join(", "));

  const missing = CATALOG.filter((c) => !c.outputRights).map((c) => c.id);
  ok("every capability declares outputRights", missing.length === 0, missing.join(", "));

  const badClass = CATALOG.filter((c) => !CLASSES.includes(c.outputRights?.class)).map((c) => c.id);
  ok("every class is one of the four", badClass.length === 0, badClass.join(", "));

  // The guard the brief asks for, stated the way it will be read in five years.
  const unquoted = CATALOG.filter((c) => c.outputRights?.class !== "unknown"
    && !String(c.outputRights?.quote || "").trim()).map((c) => c.id);
  ok("a verdict without a verbatim quote is not a verdict", unquoted.length === 0, unquoted.join(", "));

  const unclaused = CATALOG.filter((c) => c.outputRights?.class !== "unknown"
    && !String(c.outputRights?.clause || "").trim()).map((c) => c.id);
  ok("every quote says which clause it came from", unclaused.length === 0, unclaused.join(", "));

  const unlinked = CATALOG.filter((c) => !String(c.outputRights?.url || "").trim()).map((c) => c.id);
  ok("every entry links to the text — including the unknowns", unlinked.length === 0, unlinked.join(", "));

  const badSellable = CATALOG.filter((c) => {
    const r = c.outputRights || {};
    return r.class === "unknown" ? r.sellable !== null : typeof r.sellable !== "boolean";
  }).map((c) => c.id);
  ok("sellable is null for unknown and a boolean everywhere else", badSellable.length === 0, badSellable.join(", "));

  const condless = CATALOG.filter((c) => c.outputRights?.class === "yours-with-conditions"
    && !(c.outputRights.conditions || []).length).map((c) => c.id);
  ok("'with conditions' actually names its conditions", condless.length === 0, condless.join(", "));

  const explained = CATALOG.filter((c) => c.outputRights?.class === "unknown"
    && !String(c.outputRights?.note || "").trim()).map((c) => c.id);
  ok("an unknown says WHY it is unknown", explained.length === 0, explained.join(", "));

  /* Ideogram is pinned by name because it is the one the app used to get wrong:
   * it asserted a restriction nobody had read. If someone ever reads that
   * agreement, this test SHOULD fail — and they should replace it with a quote. */
  const ideo = CATALOG.find((c) => c.id === "imageIdeogram");
  ok("Ideogram 4 ships as unknown, not as an unverified claim",
     ideo?.outputRights?.class === "unknown", String(ideo?.outputRights?.class));
  ok("...and its licence field no longer states the outputs are restricted",
     !/no commercial use of the model or its outputs/i.test(String(ideo?.licence)));

  /* Territory and rights are separate axes and must not contradict: H3's
   * outputs clause is bounded by the same Applicable Territory as its weights,
   * so a region-locked entry must say so among its conditions. */
  for (const c of CATALOG.filter((x) => x.region)) {
    const conds = (c.outputRights?.conditions || []).join(" ");
    ok(`${c.id}: the rights conditions repeat the territory limit`,
       /Applicable Territory/i.test(conds) || /territor/i.test(conds), conds.slice(0, 80));
    ok(`${c.id}: region.excluded matches the licence's four Excluded Territories`,
       (c.region.excluded || []).length === 4
       && c.region.excluded.some((x) => /United States/i.test(x)),
       (c.region.excluded || []).join(", "));
  }
}

/* ── output rights: the bridge from an engine name ─────────────────────── */
console.log("\n  -- every engine the app can write is mapped --");

{
  /* WIRE IT OR IT DOES NOT EXIST. `data.model` is an ENGINE name; the rights
   * live on a CAPABILITY. An engine added to config.js without a line in
   * MODEL_TO_CAPABILITY would stamp every render `unknown` and look fine. So
   * the mapping is diffed against the engine lists config.js actually accepts,
   * rather than against a second hand-written list. */
  const capIds = new Set(CATALOG.map((c) => c.id));
  const dangling = Object.entries(MODEL_TO_CAPABILITY).filter(([, id]) => !capIds.has(id));
  ok("every mapped capability exists in the catalogue", dangling.length === 0, JSON.stringify(dangling));

  const cfgSrc = readFileSync(path.join(HERE, "config.js"), "utf8");
  const artList = /\["art",\s*"engine",\s*\(v\)\s*=>\s*\[([^\]]*)\]/.exec(cfgSrc);
  ok("config.js still declares its art-engine whitelist where this test reads it", !!artList);
  const artEngines = (artList?.[1] || "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const videoEngines = Object.keys(config.video?.engines || {});
  ok("both engine lists were found", artEngines.length > 0 && videoEngines.length > 0,
     `${artEngines.join("/")} | ${videoEngines.join("/")}`);

  // "checkpoint" is deliberately NOT in the map — a user's own file has its own
  // answer, and that answer is honestly "Studio cannot know".
  const unmapped = [...artEngines, ...videoEngines, "MiniMax-Music3"]
    .filter((e) => e !== "checkpoint" && !MODEL_TO_CAPABILITY[e.toLowerCase()]);
  ok("every art/video/music engine resolves to a capability", unmapped.length === 0, unmapped.join(", "));

  ok("a user's own checkpoint resolves to unknown, with a reason",
     outputRightsFor("checkpoint").class === "unknown"
     && /supplied/i.test(outputRightsFor("checkpoint").note || ""));
  ok("an unrecognised engine resolves to unknown rather than to nothing",
     outputRightsFor("some-model-from-2027").class === "unknown");
  ok("the stamp carries class, capability and the source url",
     JSON.stringify(rightsStampFor("flux2")) === JSON.stringify({
       class: "unrestricted", capability: "coverArt",
       url: CATALOG.find((c) => c.id === "coverArt").outputRights.url,
     }), JSON.stringify(rightsStampFor("flux2")));
  ok("the stamp does NOT carry the verbatim text (it would bloat every event)",
     !("quote" in rightsStampFor("ltx")));
}

/* ── output rights: stamped at generation time ─────────────────────────── */
console.log("\n  -- the ledger stamps rights when the file is made --");

{
  const dir = mkdtempSync(path.join(os.tmpdir(), "prov-rights-"));
  const sc = { dir };
  const g = await append(sc, { actor: "user", type: "generate", asset: "images/a.png", data: { model: "flux2", seed: 3 } });
  ok("a generate event is stamped with the model's rights class",
     g.data.outputRights?.class === "unrestricted", JSON.stringify(g.data.outputRights));
  ok("...and with where the quote came from", !!g.data.outputRights?.url);

  const u = await append(sc, { actor: "user", type: "generate", asset: "images/b.png", data: { model: "ideogram4" } });
  ok("an unread licence stamps as unknown", u.data.outputRights?.class === "unknown");

  const c = await append(sc, { actor: "user", type: "generate", asset: "images/c.png", data: { model: "checkpoint" } });
  ok("a user's own checkpoint stamps as unknown", c.data.outputRights?.class === "unknown");

  const e = await append(sc, { actor: "user", type: "edit", asset: "images/a.png", data: { op: "crop" } });
  ok("only generate events are stamped", e.data.outputRights === undefined);

  const n = await append(sc, { actor: "system", type: "generate", asset: "x.wav", data: { op: "analysis" } });
  ok("a generate with no model is left alone", n.data.outputRights === undefined);

  /* A replayed/imported event must keep the answer it was made with — that is
   * the whole reason the class is stamped rather than looked up. */
  const keep = { class: "not-for-sale", capability: null, url: "https://example.invalid/licence" };
  const k = await append(sc, { actor: "user", type: "generate", asset: "images/d.png",
                               data: { model: "flux2", outputRights: keep } });
  ok("a caller-supplied stamp is preserved, never overwritten with today's answer",
     k.data.outputRights.class === "not-for-sale", JSON.stringify(k.data.outputRights));

  const fa = foldOrigin((await read(sc, { asset: "images/a.png" })).events);
  ok("the fold carries the rights forward with the model", fa.outputRights?.class === "unrestricted");
  ok("...alongside the model that earned it", fa.model === "flux2");

  // Pre-stamp history: nothing is back-dated onto it.
  const old = foldOrigin([{ type: "generate", actor: "user", asset: "old.png", t: "2026-01-01T00:00:00Z",
                            data: { model: "flux2" } }]);
  ok("a generation recorded before this field existed folds to null, not to a guess",
     old.outputRights === null);

  rmSync(dir, { recursive: true, force: true });
}

/* ── output rights: the two surfaces exist ─────────────────────────────── */
console.log("\n  -- the chip and the export line are actually wired --");

{
  /* Source pins, in the idiom of the Tier-1 marker pins above: the UI is not
   * executable here, so the check is that the seams NAME the thing. A rights
   * system nobody can see is a comment. */
  const app = readFileSync(path.join(HERE, "..", "web", "app.js"), "utf8");
  ok("the image editor's origin row renders a chip", /openImageEditor[\s\S]{0,4000}?rightsChipFor/.test(app));
  ok("the export dialog states it too", /iedExportDlg[\s\S]{0,3000}?iedXRights/.test(app));
  ok("the Thanks table has a rights column", /loadThanks[\s\S]{0,2000}?rightsChipHtml/.test(app));
  ok("the About page lists it live", /loadAboutRights[\s\S]{0,1500}?rightsChipHtml/.test(app));
  /* Both About loaders, not just the rights one. The pin used to match the bare
   * `) loadAboutRights()` and broke the moment a SECOND loader was wired beside
   * it — which is the pin working, not failing: it exists so the About view
   * cannot quietly stop calling what fills it. Assert each name is reached from
   * the same branch rather than pinning one exact spelling of the call site. */
  // `.` does not cross a newline in JS, so this is the rest of that ONE line.
  const aboutBranch = app.match(/name === "about"\).*/);
  ok("...and something actually calls loadAboutRights",
     !!aboutBranch && /loadAboutRights\(\)/.test(aboutBranch[0]), aboutBranch && aboutBranch[0]);
  ok("...and the objective-to-execution report too",
     !!aboutBranch && /loadAboutReport\(\)/.test(aboutBranch[0]), aboutBranch && aboutBranch[0]);
  const unworded = Object.keys(OUTPUT_RIGHTS_CLASSES).filter((c) => !app.includes(`"${c}"`));
  ok("the UI has words for all four classes", unworded.length === 0, unworded.join(", "));
  ok("the export is never gated on the answer",
     /never blocks an export/i.test(app) && !/disabled[\s\S]{0,40}outputRights/i.test(app));

  const about = readFileSync(path.join(HERE, "..", "web", "index.html"), "utf8");
  ok("the About page says non-commercial is about the model", /non-commercial/i.test(about)
     && /aboutRights/.test(about));
}

/* ── D1.0 AT THE SOURCE: nothing may hardcode a person ─────────────────── */
console.log("\n  -- no module fabricates a human by literal or by default --");

{
  /* WHY A SOURCE SWEEP AND NOT A BEHAVIOURAL PIN. The runtime guards above
   * prove that a FORGED actor is coerced to `system`. They cannot see the other
   * road in: a module that never asks who is calling and simply writes `user`
   * itself. Both shapes have shipped here —
   *
   *   · `/api/reactive/run` passed no actor at all, and paintClip/motionClip
   *     defaulted to `user`, so every Reactive render recorded a human edit.
   *     On an `edit` event that is not merely a wrong credit line: foldOrigin
   *     promotes ai-generated to ai-assisted-human-edited, which is the one
   *     promotion this module exists to prevent.
   *   · the Ear's four event builders defaulted to `user`, so their own
   *     "enforced HERE, not trusted at the call site" guards were reachable
   *     only by a caller honest enough to name itself. `approve` had no actor
   *     parameter at all — it stamped a person with no way to say otherwise.
   *
   * The honest stamp always comes from the door (`prov.actorFrom(req)`), and an
   * unattributable caller is `system`. So: no `actor: "user"` literal and no
   * `actor = "user"` default anywhere under server/, outside the test fixtures
   * that legitimately CONSTRUCT a human event to assert something about it.
   *
   * If a genuine exception ever exists, add it to ALLOWED with the reason —
   * deliberately, in a diff someone reviews, which is the entire point. */
  const ALLOWED = new Set([]);
  /* Three shapes, because the bug has arrived as all three: the bare literal
   * (`actor: "user"`), the parameter default (`actor = "user"`), and the
   * FALLBACK — `actor ? actor : "user"`, `actor || "user"`, `actor ?? "user"`.
   * The third is the sneakiest: it reads as "keep whoever asked", and the half
   * nobody looks at is what it does when NOBODY asked. batch.js:224 was found
   * by this sweep and by nothing else. The fallback arm is matched only on a
   * line that mentions an actor, so an unrelated `|| "user"` elsewhere is not
   * dragged in. */
  const FABRICATES = (line) =>
    /actor\s*[:=]\s*"user"/.test(line)
    || (/actor/i.test(line) && /(\?|\|\||\?\?)\s*"user"/.test(line));

  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|mjs)$/.test(e.name) && !/_test\.(js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };

  const offenders = [];
  for (const file of walk(HERE)) {
    const rel = path.relative(HERE, file).replace(/\\/g, "/");
    if (ALLOWED.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      if (FABRICATES(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  ok("no module under server/ hardcodes or defaults to the `user` actor",
     offenders.length === 0, offenders.join("\n          "));

  /* The two doors the bug was found on, pinned by name so a future edit that
   * drops the stamp is caught here rather than in a dossier months later. */
  const ear = readFileSync(path.join(HERE, "daw", "ear.js"), "utf8");
  ok("the Ear's builders default to `system`",
     (ear.match(/actor\s*=\s*"system"/g) || []).length >= 3, ear.match(/actor\s*=\s*"system"/g)?.length);
  ok("...and `approve` takes an actor at all, rather than assuming one",
     /export function approveEvent\([\s\S]{0,300}?actor\s*=\s*"system"/.test(ear));
  ok("...and every Ear route that writes one reads it from the door",
     (ear.match(/const actor = actorOf\(req\)/g) || []).length >= 6,
     (ear.match(/const actor = actorOf\(req\)/g) || []).length);

  const idx = readFileSync(path.join(HERE, "index.js"), "utf8");
  ok("the Reactive door still stamps from the request",
     /reactive[\s\S]{0,4000}?const who = prov\.actorFrom\(req\)/.test(idx));
}

/* ── done ──────────────────────────────────────────────────────────────── */
rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
