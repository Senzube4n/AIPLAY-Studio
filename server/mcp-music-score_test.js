/**
 * The score surface refuses a score that would engrave wrongly.
 *
 * ── THE BUG THIS FILE EXISTS FOR ───────────────────────────────────────────
 *
 * On the night YuE2 first rendered here, an edit changed M:2/4 to M:4/4 and
 * left the content at 2/4. The result parsed to the eye, rendered for 399.6 s,
 * and produced 167.0 s of perfectly ordinary-sounding music — over notation in
 * which all 152 content bars hold half of what their header claims. That file
 * is the fixture below, byte for byte, and its sha256 is asserted against the
 * render receipt so this test cannot quietly start checking something else.
 *
 * So the tests here are not "does the parser parse". They are:
 *   • score_check catches the header/content beat mismatch on the REAL score,
 *   • and says WHICH SIDE is wrong, because 152 identical failures are one
 *     wrong character and one failure is a wrong bar, and a fail-fast parser
 *     reports those two the same way,
 *   • score_edit REFUSES that score and posts NOTHING — proved by a stub
 *     transport that records every call, so "nothing was written and no GPU
 *     was touched" is a measurement rather than a sentence in a description,
 *   • the refusal wording actually says what to do,
 *   • and the four non-negotiable facts are present on the tools they apply
 *     to, because an agent reads descriptions instead of code.
 *
 * ── AND THE CENSUS, the guard mcp-vfx_test.js and mcp-daw_test.js both run ──
 *
 * Every parameter a tool ADVERTISES must be named in its run(). A schema that
 * grows a property whose run() never forwards it validates, returns 200 and
 * silently does nothing — worse than a refusal, because additionalProperties:
 * false tells a client to trust the schema.
 *
 * ── NO GPU, NO WEIGHTS, NO SERVER ──────────────────────────────────────────
 *
 * Nothing here loads a model, starts a python, opens a socket or touches the
 * card: the transport is a stub and the whole ABC engine is pure text work.
 * There is an assertion at the bottom that keeps it that way.
 *
 *   node server/mcp-music-score_test.js
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreTools, checkScore, compareScores, applyMechanical, lyricRefusal,
  audioReferenceRefusal, MEASURED, LOCAL_TIER_OPS, ROUTE_ACTIONS,
  NO_AUDIO_REFERENCE, NO_BRACKETS, NOT_ENFORCED, FREE_VS_PAID,
} from "./mcp-music-score.js";

let pass = 0;
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ══════════════════════════════════════════════════════ THE REAL SCORE */

/**
 * yue_out/run_fixed/score.abc, verbatim — the score that actually rendered,
 * defect included. Inlined rather than read from the run directory so this
 * test is hermetic, and pinned by the sha256 the receipt recorded so an inline
 * copy cannot drift away from the artifact it claims to be.
 */
const AS_SHIPPED = [
  "X:1",
  "T:",
  "M:4/4",
  "L:1/16",
  "Q:1/4=90",
  "V: Vocal clef=treble name=\"Vocal Melody\" snm=\"Vocal\"",
  "V: Ins clef=treble name=\"Ins Melody\" snm=\"Inst.\"",
  "K:Dm",
  "% intro",
  "V: Vocal",
  "\"Dm\"z8|\"Dm\"z8|\"Dm\"z8|\"Dm\"z8|",
  "V: Ins",
  "Z|z4d2e2|f2g2a4-|a8-|",
  "V: Vocal",
  "\"Dm\"z8|\"Dm\"z8|\"Dm\"z8|\"Dm\"z8|",
  "V: Ins",
  "a4c'4|a2g2f2e2|Z|d2e2f2g2|",
  "V: Vocal",
  "\"Dm\"z8|\"Dm\"z8|\"Dm\"z8|\"Dm\"z8|",
  "V: Ins",
  "a4d2e2|f2g2a4|d'4c'4|a4g4|",
  "V: Vocal",
  "\"Dm\"z8|\"Dm\"z8|\"Dm\"z8|\"Dm\"z4A2c2|",
  "V: Ins",
  "f2e2d2c2|A4z4|Z2|",
  "% verse",
  "V: Vocal",
  "\"Dm\"d3cdcdc|\"Dm\"d3AA2Ac|\"Bb\"c2BAG2z2|\"Bb\"z4AAcc-|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"cA3AAcc-|\"C\"c2zAA2Ac|\"Dm\"cAAA2GAA-|\"Dm\"Az3dddf|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"Dm\"efefe2dd-|\"Dm\"d2z2ddfe-|\"Bb\"efee2fdd-|\"Bb\"d2zdd2fe-|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"efee2fee-|\"C\"e2zdddfe-|\"Dm\"e2d2d2z2|\"Dm\"cdd2z4|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"Dm\"z8|\"Dm\"z8|\"Bb\"z8|\"Bb\"z8|",
  "V: Ins",
  "d4e4|f4a4|d4e4|f4a4|",
  "V: Vocal",
  "\"C\"z8|\"C\"z8|\"Dm\"z8|\"Dm\"z6dd|",
  "V: Ins",
  "g8|c'4a4|d8-|d6z2|",
  "% pre-chorus",
  "V: Vocal",
  "\"Dm\"a2d2d2d2|\"Dm\"a2d2dda2|\"Bb\"d2d2dda2|\"Bb\"d2z2cddd|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"e4z4|\"C\"z4cddd|\"Dm\"d4z4|\"Dm\"z2aaagfe|",
  "V: Ins",
  "Z4|",
  "% chorus",
  "V: Vocal",
  "\"Dm\"d4z4|\"Dm\"z2aaagfe|\"Bb\"d4z4|\"Bb\"z2aaagfe|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"e4z4|\"C\"z2eeeded|\"Dm\"d4z4|\"Dm\"z2aaagfe|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"Dm\"d2aaaggg|\"Dm\"gff2f2ag-|\"Bb\"g2ag3ag-|\"Bb\"g2z3cde-|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"e3z4z|\"C\"zcccf2ee|\"Dm\"d4z4|\"Dm\"z8|",
  "V: Ins",
  "Z4|",
  "% verse",
  "V: Vocal",
  "\"Dm\"dcdcd2dc|\"Dm\"d2z2AAcc-|\"Bb\"cBBAA2GA-|\"Bb\"Az3AAcc-|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"cAAA2Acc-|\"C\"cz4cdd-|\"Dm\"dz3cdz2|\"Dm\"zddd2ddd|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"Dm\"efefeddd-|\"Dm\"d3z4d|\"Bb\"efefeddd-|\"Bb\"d3zdddd|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"efefeddd|\"C\"efee2ddd-|\"Dm\"d2d2z4|\"Dm\"z6zd|",
  "V: Ins",
  "Z4|",
  "% pre-chorus",
  "V: Vocal",
  "\"Bb\"d2ddd2da-|\"Bb\"ad2d3da-|\"C\"agg2z4|\"C\"z4zdda-|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"Dm\"a2d6-|\"Dm\"d8-|\"Dm\"d8-|\"Dm\"d2aaagfe|",
  "V: Ins",
  "Z4|",
  "% chorus",
  "V: Vocal",
  "\"Dm\"d2z6|\"Dm\"z2aaagfe|\"Bb\"d2z6|\"Bb\"z2aaagfe|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"e2z6|\"C\"z2eeeded|\"Dm\"d4z4|\"Dm\"z2aaagfe|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"Dm\"d2aaaggg|\"Dm\"gff2f2ag-|\"Bb\"g2ag3ag-|\"Bb\"g2z3cde-|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"e3z4z|\"C\"zcccf2ee|\"Dm\"d4z4|\"Dm\"z2aaagfe|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"Dm\"d2z6|\"Dm\"z8|\"Bb\"z8|\"Bb\"z2aaagf2|",
  "V: Ins",
  "Z4|",
  "V: Vocal",
  "\"C\"e2z6|\"C\"z8|\"Dm\"z8|\"Dm\"z8|",
  "V: Ins",
  "Z|z6d2|d8-|d8|",
  "% outro",
  "V: Vocal",
  "\"Dm\"z8|\"Dm\"z8|\"Bb\"z8|\"Bb\"z8|",
  "V: Ins",
  "d8-|d4e4|f8-|f4a4|",
  "V: Vocal",
  "\"C\"z8|\"C\"z8|\"Dm\"z8|\"Dm\"z8|",
  "V: Ins",
  "g8-|g4e4|d8-|d8|",
  "V: Vocal",
  "\"Dm\"z4z4|Z|",
  "V: Ins",
  "Z2|",
  "",
].join("\n");

/** The same bytes with the one character that makes them valid. */
const FIXED = AS_SHIPPED.replace("M:4/4", "M:2/4");

/** The style and lyrics that went with it (run_fixed/request.json). */
const STYLE = "Slow cyberpunk ballad, sad and patient and seductive, more space than event. "
  + "Female mezzo-soprano lead, smoky and low and conversational in the verses. "
  + "Warm analogue sub bass in slow whole notes. Bowed cello doubling the vocal line. "
  + "Half-time drums, huge and simple: deep kick on beat one, wide reverb-tail snare on beat three.";
const LYRICS = "Docking lights. A hundred years of rain.\nYour hull comes in cold from the dark.\n\n"
  + "I'm the rain you walk through\nI'm the light that will not hold";

/** Edit one line of the valid score, asserting first what was there. */
function withLine(index, expect, replacement) {
  const lines = FIXED.split("\n");
  if (lines[index] !== expect) {
    throw new Error(`fixture drift: line ${index} is ${JSON.stringify(lines[index])}, expected ${JSON.stringify(expect)}`);
  }
  lines[index] = replacement;
  return lines.join("\n");
}

/* ══════════════════════════════════════════════════ THE STUB TRANSPORT */

/**
 * An api() that records instead of connecting.
 *
 * `calls` is the evidence for every "nothing was written" claim below: a
 * refusal that still posted a write is a refusal that lies, and only the call
 * log can tell the difference.
 */
function makeApi() {
  const calls = [];
  /* THEIR ROW SHAPE, not a convenient one — server/score/routes.js:99
   * versionView. The fields this stub carries are the fields that function
   * really returns (id, key, parent, children, root, by, author, note +
   * noteVerbatim, status, audioSeconds, timing, artifacts, changed, and a
   * derived `score` block), plus `score.text`, which their read does NOT
   * return today and which an editor cannot work without. That one field is
   * the first of the three route asks in the design note, and it is modelled here
   * so the mapping this file tests is the mapping the real route will serve. */
  const versions = [
    {
      id: "v1", key: "rain/c02ff5c4", parent: null, children: ["v2"], root: "v1",
      label: "as rendered", at: "2026-09-11T02:45:00Z",
      by: "agent:mcp", author: null,
      note: "The first plan, saved as rendered.", noteVerbatim: true,
      identity: "c02ff5c4f7ac1ac2887c8761649a471ebf0e66dbf78de52e43f2f39670b93eba",
      status: "complete",
      audioSeconds: MEASURED.parent_score.rendered_seconds, sampleRate: MEASURED.sample_rate,
      truncated: { abc: false, semantic: false },
      timing: { e2e_seconds: MEASURED.e2e_seconds, abc: { seconds: 0, output_tokens: 0, external_prefix_tokens: 1512 } },
      artifacts: [{ name: "audio.flac", bytes: 33549285, sha256: "4008c9f0" }, { name: "score.abc", bytes: 2253, sha256: MEASURED.parent_score.sha256 }],
      verified: "hash", sheet: null, changed: null,
      style: STYLE, lyrics: LYRICS, cot: "full", seed: 424242,
      score: { text: AS_SHIPPED, bytes: 2253 },
    },
    {
      id: "v2", key: "rain/draft-2", parent: "v1", children: [], root: "v1",
      label: null, at: "2026-09-11T03:10:00Z",
      by: "agent:mcp", author: null,
      note: "Re-headered to M:2/4 so the bars and the header agree.", noteVerbatim: true,
      identity: null, status: null,
      audioSeconds: null, sampleRate: null, truncated: null, timing: null,
      artifacts: [], verified: null, sheet: null, changed: { abc: true },
      style: STYLE, lyrics: LYRICS, cot: "full", seed: null,
      score: { text: FIXED, bytes: Buffer.byteLength(FIXED, "utf8") },
    },
  ];
  const doc = { slug: "rain", id: "sc_rain", title: "Rain", author: null, current: "v2", runs: [] };
  /* The last body /api/generate was handed, so /api/status can answer with the
   * job that body describes — the render door answers with the CURRENT job and
   * the tool has to go and find its own. */
  let lastGenerate = null;
  const api = async (method, route, body) => {
    calls.push({ method, route, action: body?.action, body });
    /* ⚠ THE RENDER DOOR IS /api/generate. Modelled here because the previous
     * version of this stub answered `{ action: "render" }` on /api/score with
     * `{ ok: true, run: "run-1" }` — a route behaviour that has never existed.
     * The suite passed for the life of the tool while every real call answered
     * "Unknown action", which is the failure server/mcp-routes_test.js was
     * written for. A stub that invents a contract is worse than no stub. */
    if (route === "/api/generate") {
      lastGenerate = body || {};
      return {
        ok: true, engine: "yue2",
        rung: { id: "yue2-standard", label: "Standard" }, ceiling: null,
        job: { id: "job-1", title: lastGenerate.title ?? null, engine: "yue2" },
      };
    }
    if (route === "/api/status") {
      return {
        current: { id: "job-1", engine: "yue2", title: lastGenerate?.title ?? null,
                   seed: Number.isFinite(lastGenerate?.seed) ? lastGenerate.seed : 777 },
        queue: [],
      };
    }
    if (method === "GET") return { ok: true, scores: [{ slug: doc.slug, title: doc.title }] };
    const b = body || {};
    /* Their load() throws for every action when `slug` is missing. Modelled,
     * because a tool that forgets the slug must fail here and not silently
     * read somebody else's song. */
    const needsSlug = ["read", "draft", "note", "map", "invariants", "lineage", "sheet"];
    if (needsSlug.includes(b.action) && !b.slug) return { error: "Which score? Pass `slug`." };
    if (b.action === "list") return { ok: true, scores: [{ slug: doc.slug, title: doc.title, versions: versions.length }], capability: { pdf: true } };
    if (b.action === "read") {
      if (b.slug !== doc.slug) return { error: `No such score: ${b.slug}` };
      const wanted = b.version === undefined ? null : b.version;
      const rows = wanted
        ? versions.filter((v) => v.id === wanted)
        : versions;
      if (wanted && !rows.length) {
        return { error: `No version "${wanted}" in "${doc.slug}". It has: ${versions.map((v) => v.id).join(", ")}.` };
      }
      /* `version` omitted means the score's `current`, the way pick() does. */
      const out = wanted ? rows : (b.scores === false ? versions : versions.filter((v) => v.id === doc.current));
      return {
        ok: true, score: doc, capability: { pdf: true },
        roots: [...new Set(versions.map((v) => v.root))],
        versions: out.map((v) => (b.scores === false ? { ...v, score: { bytes: v.score.bytes } } : v)),
      };
    }
    if (b.action === "draft") {
      const v = {
        id: `v${versions.length + 1}`, parent: b.parent, at: "2026-09-11T04:00:00Z",
        by: "agent:mcp", note: b.note, noteVerbatim: true, status: null,
        artifacts: [], children: [], root: "v1",
        style: b.style, lyrics: b.lyrics, cot: b.cot,
        score: { text: b.abc, bytes: Buffer.byteLength(String(b.abc), "utf8") },
      };
      versions.push(v);
      return { ok: true, version: { id: v.id } };
    }
    /* THE REAL REFUSAL, word for word from server/score/routes.js:667. A stub
     * that answers a made-up error for a made-up action lets a tool posting a
     * phantom one look like a tool with a stub gap; this one refuses exactly as
     * the door refuses, so the suite fails the same way a caller would. */
    return {
      error: "Unknown action. Try: list, create, read, adopt, draft, note, author, current, "
        + "map, invariants, lineage, sheet, capability, delete, to_daw, export_midi.",
    };
  };
  return { api, calls, versions, doc, generated: () => lastGenerate };
}

const tools = scoreTools(makeApi().api);
const byName = new Map(tools.map((t) => [t.name, t]));
const T = (n) => {
  const t = byName.get(n);
  if (!t) throw new Error(`no tool ${n}`);
  return t;
};

/** Call a tool and return either its result or the refusal message. */
async function call(name, args, api) {
  const tool = api ? scoreTools(api).find((t) => t.name === name) : T(name);
  try { return { result: await tool.run(args || {}) }; }
  catch (err) { return { error: String(err.message || err) }; }
}

/* ═══════════════════════════════════════════════════════════ the tests */

async function main() {
  console.log("\n  -- the tool list is well formed --");

  ok("every tool has a name, a description, a schema and a run",
    tools.every((t) => t.name && t.description && t.inputSchema && typeof t.run === "function"));

  const names = tools.map((t) => t.name);
  ok("no duplicate tool names", new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(", "));

  ok("every tool is in the score_ family", names.every((n) => n.startsWith("score_")), names.join(", "));

  ok("the five named tools exist, plus the mechanical primitive",
    ["score_get", "score_check", "score_edit", "score_render", "score_compare", "score_mechanical"]
      .every((n) => byName.has(n)), names.join(", "));

  ok("every schema refuses undeclared properties",
    tools.every((t) => t.inputSchema.additionalProperties === false),
    tools.filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name).join(", "));

  ok("every required parameter is also declared",
    tools.every((t) => (t.inputSchema.required || []).every((r) => t.inputSchema.properties?.[r])),
    tools.filter((t) => (t.inputSchema.required || []).some((r) => !t.inputSchema.properties?.[r]))
      .map((t) => t.name).join(", "));

  console.log("\n  -- nothing is advertised and then dropped --");

  /* The vfx/daw census, tightened: score_compare's parameters are named `a`
   * and `b`, and a substring search for "a" passes against any source at all.
   * So the match is anchored to the argument object. */
  const dropped = [];
  for (const t of tools) {
    const src = String(t.run);
    for (const p of Object.keys(t.inputSchema.properties || {})) {
      const camel = p.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const re = new RegExp(`\\b(?:a|args)\\.(?:${p}|${camel})\\b`);
      if (!re.test(src)) dropped.push(`${t.name}.${p}`);
    }
  }
  ok("every declared parameter is read off the argument object in its run()", dropped.length === 0,
    dropped.length ? `${dropped.join(", ")}\n          Either forward it, or delete it from the schema.` : "");

  console.log("\n  -- THE ROUTE CONTRACT: only actions that exist, or are asked for by name --");

  /* server/score/ landed in parallel with this file. Its route dispatches
   * capability/list/create/read/adopt/note/author/current/map/invariants/
   * lineage/sheet/delete — and NOT the two an editor needs. That gap is a
   * VALUE here rather than a paragraph in a handoff, so it cannot drift: when
   * ROUTE_ACTIONS.required empties, this surface is fully wired. */
  const allowedActions = new Set([...ROUTE_ACTIONS.existing, ...ROUTE_ACTIONS.required]);
  const postedActions = new Map();
  for (const tool of tools) {
    for (const m of String(tool.run).matchAll(/action:\s*"([a-z_]+)"/g)) {
      if (!postedActions.has(m[1])) postedActions.set(m[1], []);
      postedActions.get(m[1]).push(tool.name);
    }
  }
  ok("no tool posts an action outside the declared set",
    [...postedActions.keys()].every((x) => allowedActions.has(x)),
    [...postedActions.keys()].filter((x) => !allowedActions.has(x)).join(", "));
  ok("the two actions server/score/routes.js does NOT dispatch are named, not assumed",
    ROUTE_ACTIONS.required.join(",") === "draft,render", ROUTE_ACTIONS.required.join(","));
  ok("...and each is actually posted by a tool, so neither ask is speculative",
    ROUTE_ACTIONS.required.every((x) => postedActions.has(x)),
    JSON.stringify([...postedActions.entries()]));
  ok("...while `read` and `list`, which already exist, carry everything else",
    postedActions.has("read") && postedActions.has("list"));
  ok("nothing posts `write` — the action this file invented before score/routes.js was read",
    !postedActions.has("write"));

  /* Their load() throws "Which score? Pass `slug`." for EVERY action, so a
   * tool that addresses a version must be able to name the score. A surface
   * without it cannot work at all, which is why this is a gate and not a note. */
  const reachesStore = ["score_get", "score_check", "score_edit", "score_mechanical",
                        "score_render", "score_compare"];
  ok("every tool that reaches the store takes the score slug",
    reachesStore.every((n) => T(n).inputSchema.properties.score),
    reachesStore.filter((n) => !T(n).inputSchema.properties.score).join(", "));
  ok("...and the four that cannot work without one REQUIRE it",
    ["score_edit", "score_mechanical", "score_render", "score_compare"]
      .every((n) => (T(n).inputSchema.required || []).includes("score")));

  console.log("\n  -- DESCRIPTIONS ARE THE INTERFACE: the four non-negotiables --");

  /* Each fact is a module constant rather than typed prose, so a tool cannot
   * paraphrase it into something weaker — the same reason mcp-videolab.js
   * interpolates H3_EXCLUDED from the catalogue. These assertions are what
   * make that binding real. */
  for (const [name, must] of [
    ["score_get", [NOT_ENFORCED]],
    ["score_check", [NOT_ENFORCED, FREE_VS_PAID]],
    ["score_edit", [NO_AUDIO_REFERENCE, NO_BRACKETS, NOT_ENFORCED, FREE_VS_PAID]],
    ["score_mechanical", [NOT_ENFORCED, FREE_VS_PAID]],
    ["score_render", [NO_AUDIO_REFERENCE, NO_BRACKETS, NOT_ENFORCED, FREE_VS_PAID]],
    ["score_compare", [NOT_ENFORCED]],
  ]) {
    for (const phrase of must) {
      const label = phrase.slice(0, 44).replace(/\s+/g, " ");
      ok(`${name} carries "${label}…"`, T(name).description.includes(phrase));
    }
  }

  ok("score_render carries ALL FOUR — it is the one that spends",
    [NO_AUDIO_REFERENCE, NO_BRACKETS, NOT_ENFORCED, FREE_VS_PAID]
      .every((p) => T("score_render").description.includes(p)));

  ok("...and states the MEASURED zero-token fact for a supplied score",
    /external_prefix_tokens: 1512/.test(T("score_render").description)
    && /output_tokens: 0/.test(T("score_render").description)
    && /ZERO ABC TOKENS/.test(T("score_render").description),
    T("score_render").description.slice(0, 200));

  ok("...and says a render cannot be sliced, so every edit is a whole re-render",
    /cannot render a slice/i.test(T("score_render").description));

  ok("every tool description says what the tool CANNOT do",
    tools.every((t) => /\bCANNOT\b/.test(t.description)),
    tools.filter((t) => !/\bCANNOT\b/.test(t.description)).map((t) => t.name).join(", "));

  console.log("\n  -- the fixture IS the score that rendered --");

  const shipped = checkScore(AS_SHIPPED);
  ok(`sha256 matches the render receipt (${MEASURED.parent_score.sha256.slice(0, 12)}…)`,
    shipped.sha256 === MEASURED.parent_score.sha256, shipped.sha256);
  ok(`and its byte count (${MEASURED.parent_score.bytes})`,
    shipped.bytes === MEASURED.parent_score.bytes, String(shipped.bytes));

  console.log("\n  -- score_check catches the header/content beat mismatch --");

  ok("the score that rendered does NOT validate", shipped.ok === false);
  ok("...the failure is bar_beats", shipped.problems.some((p) => p.code === "bar_beats"),
    JSON.stringify([...new Set(shipped.problems.map((p) => p.code))]));
  ok("...on every one of the 152 content bars", shipped.problem_count >= 152, String(shipped.problem_count));
  ok("...and the first one names both numbers: holds 2, claims 4",
    /holds 2 quarter note\(s\); M:4\/4 claims 4/.test(shipped.problems.find((p) => p.code === "bar_beats").says),
    shipped.problems.find((p) => p.code === "bar_beats").says);

  ok("the bar list is CAPPED with a summary row rather than returning 153 entries",
    shipped.problems.length < 20 && shipped.problems.some((p) => p.code === "bar_beats_summary"),
    `${shipped.problems.length} returned of ${shipped.problem_count}`);

  ok("IT SAYS WHICH SIDE IS WRONG: the header",
    /THE HEADER IS THE SIDE THAT IS WRONG/.test(shipped.diagnosis), shipped.diagnosis);
  ok("...and names the one-character fix, M:2/4",
    /M:2\/4/.test(shipped.diagnosis));
  ok("...having PROVED it by re-reading the same bytes under that meter",
    /PROVED, not guessed/.test(shipped.diagnosis) && /ZERO problems/.test(shipped.diagnosis));
  ok("...and excludes the 92 full-measure Z rests from the evidence, because a Z cannot disagree with a header",
    /92 bars are full-measure Z rests/.test(shipped.diagnosis)
    && shipped.facts.full_measure_rest_bars === 92,
    String(shipped.facts.full_measure_rest_bars));

  /* The number that settles it. Counting the Z bars as evidence gives "152 of
   * 244 wrong", which reads as scattered typos and sends you re-barring 152
   * bars instead of fixing one character. */
  ok("...so the verdict is not the one a naive count gives (152 of 244)",
    !/152 of 244/.test(shipped.diagnosis));

  ok("both readings of the same bytes are reported, not just one",
    shipped.facts.quarters_if_header_obeyed === 488 && shipped.facts.quarters_as_written === 246,
    `${shipped.facts.quarters_as_written} written / ${shipped.facts.quarters_if_header_obeyed} claimed`);

  console.log("\n  -- the re-headered score validates, and its facts match the vendor's own parser --");

  const fixed = checkScore(FIXED);
  ok("M:2/4 validates with zero problems", fixed.ok === true && fixed.problem_count === 0,
    JSON.stringify(fixed.problems.slice(0, 2)));
  /* Cross-checked against skills/yue2-music/scripts/abc_tools.py inspect on
   * these same bytes: duration_quarters 244, nominal 162.667, 122 measures,
   * 333 and 50 sounding notes, 121 chord symbols. A port that disagrees with
   * the vendor's parser is a port that will bless a score the model rejects. */
  ok("...122 bars per voice, as abc_tools.py reports", fixed.facts.bars_per_voice === 122, String(fixed.facts.bars_per_voice));
  ok("...244 quarter notes", fixed.facts.quarters_as_written === 244, String(fixed.facts.quarters_as_written));
  ok("...162.67 s nominal at Q:1/4=90", fixed.facts.nominal_seconds === 162.67, String(fixed.facts.nominal_seconds));
  ok("...333 Vocal and 50 Ins sounding notes after merging ties",
    fixed.facts.sounding_notes.Vocal === 333 && fixed.facts.sounding_notes.Ins === 50,
    JSON.stringify(fixed.facts.sounding_notes));
  ok("...121 chord symbols", fixed.facts.chord_symbols === 121, String(fixed.facts.chord_symbols));
  ok("...and the eight sections in order",
    fixed.facts.sections.map((s) => s.name).join(",") === "intro,verse,pre-chorus,chorus,verse,pre-chorus,chorus,outro",
    fixed.facts.sections.map((s) => s.name).join(","));

  /* The estimate reproduces the one render this rig has done to within 1.2%,
   * which is the only claim it makes. */
  ok(`the render estimate lands near the MEASURED ${MEASURED.e2e_seconds} s`,
    Math.abs(fixed.render_estimate_seconds - MEASURED.e2e_seconds) / MEASURED.e2e_seconds < 0.05,
    `${fixed.render_estimate_seconds} s estimated vs ${MEASURED.e2e_seconds} s measured`);

  console.log("\n  -- and the constructed breakages, one invariant each --");

  const cases = [
    ["one short bar is diagnosed as a WRONG BAR, not a wrong header", "bar_beats",
      withLine(27, '"Dm"d3cdcdc|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-|',
        '"Dm"d3cdcd|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-|'),
      /THE BARS ARE THE SIDE THAT IS WRONG/],
    ["a tidied V: declaration is refused", "voice_declaration",
      withLine(6, 'V: Ins clef=treble name="Ins Melody" snm="Inst."', 'V: Ins clef=treble name="Instrument"'), null],
    ["a non-native chord quality is refused", "chord",
      withLine(27, '"Dm"d3cdcdc|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-|',
        '"Dmaj9"d3cdcdc|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-|'), null],
    ["a chord symbol in the Ins voice is refused", "chord",
      withLine(20, "a4d2e2|f2g2a4|d'4c'4|a4g4|", "\"Dm\"a4d2e2|f2g2a4|d'4c'4|a4g4|"), null],
    ["a key that is not a key is refused", "key",
      withLine(7, "K:Dm", "K:Dorian"), null],
    ["a tie that changes pitch is refused", "tie",
      withLine(20, "a4d2e2|f2g2a4|d'4c'4|a4g4|", "a4-d2e2|f2g2a4|d'4c'4|a4g4|"), null],
    ["a score ending on an unresolved tie is refused", "tie",
      withLine(139, "Z2|", "d8-|d8-|"), null],
    ["a tuplet is refused rather than given guessed timing", "token",
      withLine(27, '"Dm"d3cdcdc|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-|',
        '(3ddd"Dm"d3cd|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-|'), null],
    ["a music line not ending in a barline is refused", "group_shape",
      withLine(27, '"Dm"d3cdcdc|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-|',
        '"Dm"d3cdcdc|"Dm"d3AA2Ac|"Bb"c2BAG2z2|"Bb"z4AAcc-'), null],
    ["an L: that is not a power of two is refused at the header", "header_shape",
      withLine(3, "L:1/16", "L:1/24"), null],
  ];
  for (const [label, code, text, diagnosisRe] of cases) {
    const r = checkScore(text);
    ok(label, r.ok === false && r.problems.some((p) => p.code === code),
      `ok=${r.ok} codes=${JSON.stringify([...new Set(r.problems.map((p) => p.code))])}`);
    if (diagnosisRe) ok(`  ...and the diagnosis says so`, diagnosisRe.test(r.diagnosis || ""), r.diagnosis || "(none)");
  }

  ok("the L: refusal says to PRESERVE the exported value rather than pick one",
    /PRESERVE the exported L: value/.test(checkScore(withLine(3, "L:1/16", "L:1/24")).problems[0].fix || ""));

  ok("the check declares its own scope — a refusal may mean 'outside this dialect'",
    /outside this bounded dialect/.test(fixed.scope) && /NO\b.*claim about the generated audio/i.test(fixed.scope),
    fixed.scope);

  console.log("\n  -- score_edit REFUSES a failed invariant, and writes nothing --");

  {
    const { api, calls } = makeApi();
    const r = await call("score_edit", {
      score: "rain", abc: AS_SHIPPED,
      note: "Moving the header to 4/4 because the chorus felt like common time.",
    }, api);
    ok("the edit that shipped tonight is refused", !!r.error, JSON.stringify(r.result || "").slice(0, 200));
    ok("...and NOTHING was posted: no version written, no render started",
      calls.length === 0, JSON.stringify(calls.map((c) => c.action)));
    ok("...the refusal begins by refusing", /^Refusing to write this version/.test(r.error || ""), r.error);
    ok("...it says nothing was stored and no render was started",
      /nothing was stored and no render was started/.test(r.error || ""));
    ok("...it lists the failing invariant by code and place",
      /\[bar_beats\] group 1 \(% intro\), Vocal/.test(r.error || ""), r.error);
    ok("...it carries the which-side-is-wrong diagnosis",
      /THE HEADER IS THE SIDE THAT IS WRONG/.test(r.error || ""));
    ok(`...and it prices the alternative: ${MEASURED.e2e_seconds} s MEASURED against a free check`,
      new RegExp(`A render costs ${MEASURED.e2e_seconds} s MEASURED; this check cost under a millisecond`)
        .test(r.error || ""), r.error);
    ok("...and tells the agent the check is free, so iterate",
      /score_check as often as you like, it is free/.test(r.error || ""));
  }

  {
    const { api, calls } = makeApi();
    const r = await call("score_edit", { score: "rain", abc: FIXED, note: "No change at all." }, api);
    ok("an edit identical to its parent is refused", !!r.error && /byte-identical to v2/.test(r.error), r.error);
    ok("...and it points at the tool that DOES re-roll a render", /score_render with `seed`/.test(r.error || ""));
    ok("...having read the parent but written nothing",
      !calls.some((c) => c.action === "draft"), JSON.stringify(calls.map((c) => c.action)));
  }

  {
    const { api, calls } = makeApi();
    const r = await call("score_edit", { score: "rain", abc: FIXED, note: "" }, api);
    ok("an edit with no note is refused — a version nobody can read back is a fork",
      !!r.error && /`note` is required/.test(r.error), r.error);
    ok("...and posted nothing", calls.length === 0);
  }

  {
    const { api, calls } = makeApi();
    const good = withLine(4, "Q:1/4=90", "Q:1/4=84");
    const r = await call("score_edit", { score: "rain", abc: good, note: "Slower, for the ballad." }, api);
    ok("a VALID edit is written", !!r.result?.version, JSON.stringify(r.error || "").slice(0, 200));
    ok("...with the parent pointer and the note carried verbatim",
      calls.some((c) => c.action === "draft" && c.body.parent === "v2"
        && c.body.note === "Slower, for the ballad."),
      JSON.stringify(calls.find((c) => c.action === "draft")?.body?.note));
    ok("...and the write records the check that let it through",
      calls.find((c) => c.action === "draft")?.body?.check?.ok === true);
    ok("...and it renders NOTHING", !calls.some((c) => c.action === "render"));
    ok("...returning the computed diff, not the author's account of it",
      r.result.changed?.header_changes?.some((h) => h.field === "bpm" && h.a === 90 && h.b === 84),
      JSON.stringify(r.result.changed?.header_changes));
    ok("...and saying that a render is the separate, paid act",
      /spends the GPU/.test(r.result.note || ""), r.result.note);
  }

  console.log("\n  -- the two content refusals --");

  ok("section tags in lyrics are YuE2's own format and are accepted", lyricRefusal("[Verse]\nDocking lights") === null);
  ok("...and blank-line stanzas are accepted too", lyricRefusal(LYRICS) === null);

  {
    const { api } = makeApi();
    const r = await call("score_edit", { score: "rain", abc: FIXED, note: "new words", lyrics: "[Verse] something" }, api);
    ok("score_edit does not refuse tagged lyrics", !/bracketed label/.test(r.error || ""), r.error);
  }

  for (const key of ["reference_audio", "audio", "ref_audios", "singer", "voice_clone", "phonemes", "negative_prompt", "continue_from"]) {
    ok(`an audio reference asked for as \`${key}\` is refused`, !!audioReferenceRefusal({ [key]: "x.wav" }));
  }
  ok("...the refusal names the field the agent used",
    /reference_audio/.test(audioReferenceRefusal({ reference_audio: "a.wav" })));
  ok("...and says where a voice description DOES go",
    /describe it in the style prompt in words/.test(audioReferenceRefusal({ singer: "x" })));
  ok("...and redirects a continuation to the engine that has one",
    /music_input_prepare on the other engine/.test(audioReferenceRefusal({ continue_from: "x" })));
  ok("an ordinary argument set is not mistaken for one", audioReferenceRefusal({ score: "rain", version: "v1", seed: 1 }) === null);

  {
    const { api, calls } = makeApi();
    const r = await call("score_render", { score: "rain", version: "v2", reference_audio: "demo.wav" }, api);
    ok("score_render refuses an audio reference", !!r.error && /no such conditioning exists/.test(r.error), r.error);
    ok("...without even reading the version", calls.length === 0);
  }

  console.log("\n  -- score_render will not spend on a score that failed its check --");

  {
    const { api, calls } = makeApi();
    const r = await call("score_render", { score: "rain", version: "v1" }, api);
    ok("rendering the as-shipped score is refused", !!r.error && /^Refusing to render v1/.test(r.error), r.error);
    ok("...nothing was sent to the render door", !calls.some((c) => c.route === "/api/generate"),
      JSON.stringify(calls.map((c) => c.route)));
    ok("...the refusal says the generator will NOT repair it",
      /bypasses the planner rather than being fixed by it/.test(r.error || ""));
    ok("...and prices the refusal it just saved",
      new RegExp(`costs ${MEASURED.e2e_seconds} s MEASURED`).test(r.error || ""));
    ok("...and names the tool that fixes a meter", /score_mechanical for a meter/.test(r.error || ""));
  }

  {
    const { api, calls } = makeApi();
    const r = await call("score_render", { score: "rain", version: "v2", seed: 424242, title: "Rain, re-barred" }, api);
    ok("a valid version renders", !!r.result?.job_id, JSON.stringify(r.error || ""));

    /* ── THE DOOR, asserted by name. ────────────────────────────────────────
     * This is the pin that was missing for the life of the tool: it posted
     * `{ action: "render" }` to /api/score, a route that dispatches sixteen
     * actions and has never had that one, and the old stub answered it anyway.
     * The render door is /api/generate, and a score reaches it as `abc` with
     * `scoreSlug`/`scoreVersion` so the finished run is adopted back as a child
     * of the version it came from (server/index.js:948-968). */
    const gen = calls.find((c) => c.route === "/api/generate");
    ok("...through the RENDER door, /api/generate", !!gen,
      `routes posted: ${JSON.stringify(calls.map((c) => c.route))}`);
    ok("...and NOT to /api/score, which has no render action",
      !calls.some((c) => c.route === "/api/score" && c.action === "render"));
    ok("...naming YuE2, the only engine a score conditions", gen?.body?.engine === "yue2", gen?.body?.engine);
    ok("...carrying the version's own notation, style and words",
      gen?.body?.abc === FIXED && gen?.body?.caption === STYLE && gen?.body?.lyrics === LYRICS,
      JSON.stringify({ abc: gen?.body?.abc?.slice(0, 20), caption: gen?.body?.caption }));
    ok("...with the score and version, which is what parents the finished render",
      gen?.body?.scoreSlug === "rain" && gen?.body?.scoreVersion === "v2",
      JSON.stringify({ slug: gen?.body?.scoreSlug, version: gen?.body?.scoreVersion }));
    ok("...leaving abcOpen ABSENT, so the planner sits out rather than continuing what we sent",
      gen !== undefined && !("abcOpen" in gen.body));
    ok("...and fitting the run to the score's own nominal length",
      Number.isFinite(gen?.body?.maxDuration) && gen.body.maxDuration > 0, String(gen?.body?.maxDuration));

    ok("...returning a job id immediately and naming the poller",
      /Poll the job with wait_for_song, or score_get with score "rain"/.test(r.result.note || ""), r.result.note);
    ok("...and saying where the finished render will LAND: a new version parented on this one",
      /arrives as a NEW version whose parent is v2/.test(r.result.note || ""), r.result.note);
    ok("...reporting the MEASURED zero cost of a supplied score",
      /^ZERO\./.test(r.result.cost.abc_planning)
      && /output_tokens: 0/.test(r.result.cost.abc_planning)
      && /external_prefix_tokens: 1512/.test(r.result.cost.abc_planning),
      r.result.cost.abc_planning);
    ok("...saying a supplied score REPLACES the planning pass rather than adding to it",
      /replaces the planning pass rather than adding to it/.test(r.result.cost.abc_planning));
    ok("...with an estimate labelled ESTIMATED and its basis given",
      /^ESTIMATED:/.test(r.result.cost.estimate_basis) && Number.isFinite(r.result.cost.estimate_seconds),
      r.result.cost.estimate_basis);
    ok("...and the adherence warning travels with the job, not just the docs",
      r.result.adherence_warning === NOT_ENFORCED);
    ok("...the seed and title reached the route",
      gen?.body?.seed === 424242 && gen?.body?.title === "Rain, re-barred",
      JSON.stringify(gen?.body));
  }

  {
    /* A valid score with no words. The score fixes the notes and the tempo;
     * NOTHING else can fix the sound, because there is no audio conditioning
     * of any kind — so an empty style prompt is a render with no instructions
     * about what it should sound like, and that is worth 399.6 s to nobody. */
    const posted = [];
    const noStyle = { ...makeApi().versions[1], style: "  " };
    const stub = async (method, route, b) => {
      posted.push(route);
      return b?.action === "read"
        ? { ok: true, score: { slug: "rain" }, versions: [noStyle] }
        : { error: "the stub should not have been asked" };
    };
    const r = await call("score_render", { score: "rain", version: "v2" }, stub);
    ok("a version with no style prompt is refused — the score fixes notes, not sound",
      !!r.error && /has no style prompt/.test(r.error), r.error);
    ok("...saying there is no other input that could", /there is no other input that can/.test(r.error || ""));
    ok("...and nothing reached the render door", !posted.includes("/api/generate"), JSON.stringify(posted));
  }

  console.log("\n  -- score_get reports that the version you inherited is itself broken --");

  {
    const { api } = makeApi();
    const r = await call("score_get", { score: "rain", version: "v1" }, api);
    ok("v1 comes back with its check attached", r.result?.check?.ok === false);
    ok("...carrying the diagnosis", /THE HEADER IS THE SIDE THAT IS WRONG/.test(r.result.check.diagnosis));
    ok("...the derived facts an agent needs to edit it",
      r.result.header.meter === "4/4" && r.result.header.key === "Dm" && r.result.header.bpm === 90
      && r.result.facts.sections.length === 8,
      JSON.stringify(r.result.header));
    ok("...the ABC verbatim, byte for byte", r.result.abc === AS_SHIPPED);
    ok("...the author's note labelled as the author's claim",
      r.result.note_as_written_by_its_author === "The first plan, saved as rendered.");
    /* THE POINT OF THE WHOLE FILE, in one assertion: this version failed its
     * check AND produced 167.039 s of finished audio. A store that could not
     * hold both facts at once would have to drop one of them, and the one it
     * would drop is the defect. */
    ok("...and the receipt that proves a broken score still makes audio",
      r.result.rendered.audio_seconds === MEASURED.parent_score.rendered_seconds
      && r.result.rendered.timing.abc.external_prefix_tokens === 1512,
      JSON.stringify(r.result.rendered?.audio_seconds));
    ok("...and the score/version pair it is addressed by, because a version id alone is not an address",
      r.result.score === "rain" && r.result.version === "v1");
  }

  {
    /* Three depths, because the store is a folder per song and a version id
     * on its own addresses nothing (their load(): "Which score? Pass `slug`"). */
    const { api, calls } = makeApi();
    const none = await call("score_get", {}, api);
    ok("score_get with NO arguments lists the scores, not the versions of a guessed one",
      Array.isArray(none.result?.scores) && none.result.scores[0].slug === "rain"
      && calls.some((c) => c.action === "list"),
      JSON.stringify(none.result));

    const tree = await call("score_get", { score: "rain" }, api);
    ok("...with a slug it lists that score's versions and its current one",
      tree.result?.current === "v2" && tree.result.versions.length === 2
      && tree.result.versions[0].version === "v1",
      JSON.stringify(tree.result?.versions?.map((v) => v.version)));
    ok("...saying how many distinct SONGS the folder holds, which a version count does not",
      Array.isArray(tree.result.distinct_roots) && tree.result.distinct_roots.length === 1,
      JSON.stringify(tree.result.distinct_roots));

    const missing = await call("score_get", { score: "rain", version: "nope" }, api);
    ok("...and a version that is not there comes back with the list of ones that are",
      !!missing.error && /It has: v1, v2/.test(missing.error), missing.error);
  }

  {
    /* The slug is not optional anywhere, because their load() refuses without
     * it for every action — a tool that forgot it would read whatever score
     * happened to be first. */
    const { api } = makeApi();
    const r = await call("score_check", { score: "" }, api);
    ok("a tool asked for a stored score with no slug refuses here, not at the route",
      !!r.error && /pass `abc`|Pass `score`/.test(r.error), r.error);
  }

  console.log("\n  -- the mechanical primitive re-bars, and proves it did not move the music --");

  {
    const merged = applyMechanical("meter", { abc: FIXED, meter: "4/4" });
    const c = checkScore(merged.abc);
    ok("2/4 into 4/4 validates", c.ok === true, JSON.stringify(c.problems.slice(0, 2)));
    ok("...halving the bar count, 122 into 61", c.facts.bars_per_voice === 61, String(c.facts.bars_per_voice));
    const d = compareScores(FIXED, merged.abc);
    ok("...with every sounding note and chord in the same place, COMPUTED not asserted",
      d.voices.Vocal.notes_identical && d.voices.Ins.notes_identical
      && d.voices.Vocal.chords_identical && d.voices.Ins.chords_identical,
      JSON.stringify(d.voices.Vocal.first_differing_note));
    ok("...and the same nominal length, because nothing moved",
      c.facts.nominal_seconds === checkScore(FIXED).facts.nominal_seconds);
    ok("...saying out loud that it VERIFIED rather than believed",
      /VERIFIED by comparing the two note timelines, not asserted/.test(merged.consequence), merged.consequence);

    const back = applyMechanical("meter", { abc: merged.abc, meter: "2/4" });
    const d2 = compareScores(FIXED, back.abc);
    ok("4/4 back into 2/4 restores the grid and the music",
      checkScore(back.abc).facts.bars_per_voice === 122
      && d2.voices.Vocal.notes_identical && d2.voices.Ins.notes_identical
      && d2.facts.quarters.a === d2.facts.quarters.b,
      JSON.stringify(d2.facts));
  }

  {
    let err = null;
    try { applyMechanical("meter", { abc: FIXED, meter: "6/8" }); } catch (e) { err = e.message; }
    ok("2/4 into 6/8 is refused — where the beats go is a musical decision",
      !!err && /not an integer re-barring/.test(err), err);
    ok("...and it says who should make that decision instead",
      /belongs to the frontier tier|or to a person/.test(err || ""));
  }

  {
    let err = null;
    try { applyMechanical("meter", { abc: AS_SHIPPED, meter: "4/4" }); } catch (e) { err = e.message; }
    ok("a mechanical op refuses to transform a score that does not already validate",
      !!err && /the SOURCE score does not validate/.test(err), err);
    ok("...because arithmetic on a mistake is a worse mistake",
      /would be arithmetic on a mistake/.test(err || ""));
  }

  {
    const t = applyMechanical("tempo", { abc: FIXED, bpm: 72 });
    ok("a tempo change moves the clock and not one note",
      checkScore(t.abc).facts.quarters_as_written === 244
      && checkScore(t.abc).facts.nominal_seconds === 203.33,
      JSON.stringify(checkScore(t.abc).facts.nominal_seconds));
    ok("...and reports what that costs at the MEASURED rate",
      /render estimate moves 395 s → 493 s/.test(t.consequence), t.consequence);
    ok("...and reminds you the style prompt names a tempo in words too",
      /Change the words too/.test(t.also));
  }

  {
    const d = applyMechanical("drop_instrument", { abc: FIXED, style: STYLE, instrument: "cello" });
    ok("dropping an instrument removes the clause that names it",
      !/cello/i.test(d.style) && d.removed_verbatim.includes("Bowed cello doubling the vocal line."),
      JSON.stringify(d.removed_verbatim));
    ok("...leaving the rest of the prompt intact", /sub bass/.test(d.style) && /mezzo-soprano/.test(d.style));
    ok("...and saying it removed a REQUEST, not a sound", /removed a REQUEST, not a sound/.test(d.also));

    /* A prompt that lists several instruments in one sentence must lose only
     * the item that names this one — removing the whole sentence would quietly
     * take the kick and the snare with the drums. */
    const one = applyMechanical("drop_instrument", { abc: FIXED, style: STYLE, instrument: "Half-time drums" });
    ok("a comma list loses only its own item", one.removed_verbatim.length === 1
      && one.removed_verbatim[0] === "Half-time drums" && /deep kick on beat one/.test(one.style),
      JSON.stringify(one.removed_verbatim));

    let err = null;
    try { applyMechanical("drop_instrument", { abc: FIXED, style: STYLE, instrument: "theremin" }); } catch (e) { err = e.message; }
    ok("an instrument that is not in the prompt is refused, not reported as done",
      !!err && /does not appear in the style prompt/.test(err), err);
    ok("...and says why that matters: you would be told it worked",
      /you would be told it worked/.test(err || ""));
  }

  {
    const s = applyMechanical("sections", { abc: FIXED, order: [1, 2, 4, 4, 8] });
    const c = checkScore(s.abc);
    ok("sections can be reordered, repeated and dropped",
      c.ok === true && c.facts.sections.map((x) => x.name).join(",") === "intro,verse,chorus,chorus,outro",
      c.facts.sections.map((x) => x.name).join(","));
    ok("...and the new length is computed", c.facts.bars_per_voice === 82, String(c.facts.bars_per_voice));
    ok("...with the warning that the LYRICS did not move",
      /THE LYRICS DID NOT MOVE/.test(s.also), s.also);

    let err = null;
    try { applyMechanical("sections", { abc: FIXED, order: [9] }); } catch (e) { err = e.message; }
    ok("a section that does not exist is refused, with the real list in the sentence",
      !!err && /1 intro, 2 verse/.test(err), err);
  }

  {
    let err = null;
    try { applyMechanical("reharmonise", { abc: FIXED }); } catch (e) { err = e.message; }
    ok("reharmonising is NOT a mechanical op", !!err && /is not a mechanical op/.test(err), err);
    ok("...and the refusal sends it to score_edit where the check can prove it",
      /is a full score_edit/.test(err || ""));
    ok("the four ops are the ones the local tier is given",
      LOCAL_TIER_OPS.join(",") === "tempo,meter,drop_instrument,sections", LOCAL_TIER_OPS.join(","));
    ok("...and score_mechanical's enum is exactly those four",
      JSON.stringify(T("score_mechanical").inputSchema.properties.op.enum) === JSON.stringify(LOCAL_TIER_OPS),
      JSON.stringify(T("score_mechanical").inputSchema.properties.op.enum));
  }

  {
    const { api, calls } = makeApi();
    const r = await call("score_mechanical", { score: "rain", op: "tempo", bpm: 72, note: "Wanted it slower." }, api);
    ok("score_mechanical writes a version through the same door as score_edit",
      !!r.result?.version && calls.some((c) => c.action === "draft"), JSON.stringify(r.error || ""));
    ok("...recording the op and its computed change in the stored note",
      /\[mechanical:tempo — Q:1\/4=90 → Q:1\/4=72\]/.test(calls.find((c) => c.action === "draft").body.note),
      calls.find((c) => c.action === "draft").body.note);
    ok("...and rendering nothing", !calls.some((c) => c.action === "render"));
  }

  {
    /* The parent's defect belongs to the parent. drop_instrument never touches
     * the ABC, so without this guard an invalid parent surfaces as "the
     * drop_instrument transform produced a score that fails its own check" —
     * a message that sends somebody debugging the wrong function. */
    const { api, calls } = makeApi();
    const r = await call("score_mechanical",
      { score: "rain", op: "drop_instrument", instrument: "cello", version: "v1", note: "Thinner." }, api);
    ok("a mechanical edit on the BROKEN parent refuses and blames the PARENT, not the transform",
      !!r.error && /version v1's own score fails/.test(r.error) && !/transform produced/.test(r.error), r.error);
    ok("...saying no mechanical transform can remove an inherited defect",
      /no mechanical transform can remove them/.test(r.error || ""));
    ok("...and offering the repair as the one-line change it is",
      /one-line change here/.test(r.error || ""));
    ok("...having written nothing", !calls.some((c) => c.action === "draft"),
      JSON.stringify(calls.map((c) => c.action)));
  }

  {
    /* A mechanical edit must not be the quiet way a sung "[verse]" reaches a
     * render: the lyrics it carries forward get the same guard as supplied ones. */
    const posted = [];
    const legacy = {
      id: "vX", parent: null, style: STYLE,
      lyrics: "[Verse] Docking lights, a hundred years of rain", cot: "full",
      artifacts: [], score: { text: FIXED },
    };
    const stub = async (method, route, b) => {
      posted.push(b?.action);
      return b?.action === "read"
        ? { ok: true, score: { slug: "rain" }, versions: [legacy] }
        : { ok: true, version: { id: "vY" } };
    };
    const r = await call("score_mechanical", { score: "rain", op: "tempo", bpm: 80, note: "Slower." }, stub);
    ok("a mechanical edit carries a parent's tagged lyrics forward",
      !/bracketed label/.test(r.error || ""), r.error);
    ok("...and writes the new version", posted.includes("draft"), JSON.stringify(posted));
  }

  console.log("\n  -- score_compare computes the difference; it does not repeat the claim --");

  {
    const { api } = makeApi();
    const r = await call("score_compare", { score: "rain", a: "v1", b: "v2" }, api);
    ok("the two shas are reported", r.result.score_diff.sha256.a === MEASURED.parent_score.sha256);
    ok("...the header change is found by diffing, not by reading the note",
      r.result.score_diff.header_changes.some((h) => h.field === "meter" && h.a === "4/4" && h.b === "2/4"),
      JSON.stringify(r.result.score_diff.header_changes));
    ok("...the notes are reported identical, because they are",
      r.result.score_diff.voices.Vocal.notes_identical === true);
    ok("...validity is reported per side, so 'it changed' and 'it is now correct' stay separate",
      r.result.score_diff.valid.a === false && r.result.score_diff.valid.b === true);
    ok("...a real line diff is computed, one line changed",
      r.result.score_diff.text_diff.removed === 1 && r.result.score_diff.text_diff.added === 1
      && r.result.score_diff.text_diff.hunks.some((h) => h.text === "M:4/4"),
      JSON.stringify(r.result.score_diff.text_diff).slice(0, 200));
    ok("...each side's note comes back labelled as its author's claim",
      r.result.a.note_as_written_by_its_author === "The first plan, saved as rendered."
      && "note_as_written_by_its_author" in r.result.b);
    ok("...the lineage is computed too", r.result.b_descends_from_a === true);
    ok("...and it says what listening still has to settle",
      r.result.adherence_warning === NOT_ENFORCED);
    ok("...noting that only one side has audio, so this is notation-only",
      /score_render first/.test(r.result.listen), r.result.listen);
  }

  {
    /* An edit note that claims the wrong thing must not change the computed
     * answer — the whole reason the diff is measured off the bytes. */
    const lie = compareScores(FIXED, applyMechanical("tempo", { abc: FIXED, bpm: 72 }).abc);
    ok("a tempo-only edit shows up as a header change with identical notes",
      lie.header_changes.length === 1 && lie.header_changes[0].field === "bpm"
      && lie.voices.Vocal.notes_identical && lie.voices.Ins.notes_identical,
      JSON.stringify(lie.header_changes));
    ok("identical bytes compare as identical", compareScores(FIXED, FIXED).identical === true);
    /* One note changed, a5 to b5, at the same onset. The expected pitch is 82
     * and not 83 because K:Dm carries one flat and an unmarked B in D minor is
     * a B-flat — so this assertion is also the key-signature check: a parser
     * that ignored the key would put the note a semitone high and every
     * reharmonisation judgement made against it would be off by that. */
    ok("...and a first differing note is located exactly, with the key signature applied",
      (() => {
        const edited = withLine(20, "a4d2e2|f2g2a4|d'4c'4|a4g4|", "b4d2e2|f2g2a4|d'4c'4|a4g4|");
        const d = compareScores(FIXED, edited);
        const f = d.voices.Ins.first_differing_note;
        return !d.voices.Ins.notes_identical && f && f.index === 15
          && f.a.midi === 81 && f.b.midi === 82
          && f.a.at_quarter === 16 && f.b.at_quarter === 16;
      })());
  }

  console.log("\n  -- no GPU, no weights, no second implementation --");

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(HERE, "mcp-music-score.js"), "utf8");
  const imports = [...src.matchAll(/^import\s+.*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  ok("the module imports nothing but node:crypto — no engine, no weights, no python",
    imports.length === 1 && imports[0] === "node:crypto", JSON.stringify(imports));
  ok("...and spawns nothing",
    !/child_process|spawn\(|execSync|torch|cuda/i.test(src));
  ok("the ABC engine is exported so the route and the local chat tier share ONE implementation",
    typeof checkScore === "function" && typeof applyMechanical === "function"
    && typeof lyricRefusal === "function");
  ok("every MEASURED number the descriptions quote comes from the one exported receipt",
    MEASURED.e2e_seconds === 399.6 && MEASURED.audio_seconds === 167.0
    && MEASURED.abc_external_prefix_tokens === 1512 && MEASURED.abc_output_tokens === 0
    && MEASURED.abc_seconds === 0 && MEASURED.realtime_factor === 2.39);

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\n  the test itself threw:", err);
  process.exit(1);
});
