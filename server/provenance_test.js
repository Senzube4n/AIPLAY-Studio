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
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
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

/* ── done ──────────────────────────────────────────────────────────────── */
rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);
