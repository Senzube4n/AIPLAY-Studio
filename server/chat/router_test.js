/**
 * THE ROUTER — that reaching 241 tools did not quietly widen what the chat may
 * do without asking.
 *
 * The feature is small and the risk is not. Before this file the chat could
 * touch eight hand-written tools whose costs were typed out beside them; now it
 * can reach most of the MCP surface, and NOT ONE of those 241 tools declares
 * whether it spends. Everything below exists to hold three lines:
 *
 *   a tool nobody listed is not reachable,
 *   a tool that costs something asks first,
 *   and a tool that DESTROYS something is never put in front of a person who
 *   did not ask for anything to be destroyed.
 *
 * §2 is the one to read if you only read one. It pins the measurement that
 * decided the whole design — that deriving "does this spend?" from the tool's
 * own source is wrong in the dangerous direction — by running that derivation
 * here and asserting it still gets `avatar_import` wrong. The day that
 * assertion fails is the day the cheap derivation became possible, and the
 * table could be reconsidered.
 *
 * Runs standalone (`node server/chat/router_test.js`) and in the pre-commit
 * hook. No server, no card, no model.
 */
import {
  ROUTABLE, WITHHELD, COST_TEXT, COST_TEXT_BY_TOOL, index, chooseTools, routedRegistry,
  adaptTool, callableShape, scoreTool, toolTokens, words, wantsRemoval, ROUTE_LIMIT, CHAT_WITHHELD_ARGS,
} from "./router.js";
import { TOOLS as MCP_TOOLS } from "../mcp.js";
import { createChatTools } from "./tools.js";
import { systemPrompt, describeTool, gateLabel } from "./loop.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
const head = (s) => console.log(`\n${s}`);

const core = createChatTools();
const CORE_NAMES = core.all.map((t) => t.name);
const mcpByName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
const routedNames = new Set(index().map((e) => e.tool.name));

/* ─────────────────────────────────────────────────────────────── §1 */
head("§1  the table is a boundary, and absence is refusal");

{
  const ghosts = Object.keys(ROUTABLE).filter((n) => !mcpByName.has(n));
  ok("every name in ROUTABLE is a tool that exists", ghosts.length === 0,
    `these are in the table and not in the surface: ${ghosts.join(", ")}`);

  const ghostsW = Object.keys(WITHHELD).filter((n) => !mcpByName.has(n));
  ok("every name in WITHHELD is a tool that exists", ghostsW.length === 0,
    `withheld but not real: ${ghostsW.join(", ")}`);

  const both = Object.keys(ROUTABLE).filter((n) => n in WITHHELD);
  ok("no tool is both routable and withheld", both.length === 0, both.join(", "));

  /* The property that matters most: a tool nobody has thought about is not
   * reachable. This is asserted over the WHOLE surface rather than a sample,
   * because the failure it guards is a tool added later by someone else. */
  const unlisted = MCP_TOOLS.filter((t) => !(t.name in ROUTABLE)).map((t) => t.name);
  const leaked = unlisted.filter((n) => routedNames.has(n));
  ok(`a tool in neither list is unreachable (${unlisted.length} unlisted, none reachable)`,
    leaked.length === 0, `these leaked in: ${leaked.join(", ")}`);

  /* And the same property through the front door, over many messages, because
   * the index being clean does not prove chooseTools is. */
  const probes = [
    "run a graph on the engine", "stop the engine", "what port is the engine on",
    "start an overnight run", "record from my microphone", "narrate my audiobook",
    "adopt the unrecorded files", "hash the models", "set the video engine to wan",
  ];
  const escaped = new Set();
  for (const p of probes) for (const t of chooseTools(p, { limit: 20 })) {
    if (!(t.name in ROUTABLE)) escaped.add(t.name);
  }
  ok("nine probes aimed straight at the withheld tools reach none of them",
    escaped.size === 0, [...escaped].join(", "));

  /* Every withheld tool carries a REASON, because a bare list rots into a list
   * nobody dares change. */
  const reasonless = Object.entries(WITHHELD).filter(([, why]) => !why || why.length < 20);
  ok("every withheld tool says why in a sentence", reasonless.length === 0,
    reasonless.map(([n]) => n).join(", "));

  /* ── EVERY TOOL GETS A DECISION, and this is the lane that makes the next
   * person take it.
   *
   * Silence is already safe — a tool in neither list is unreachable — so this
   * assertion is not protecting the chat. It is protecting the FEATURE from
   * quietly decaying: 241 tools today, and someone adds the 242nd next week
   * with no idea this file exists. Unlisted, it simply never appears, and the
   * chat gets worse by one tool a month with nothing anywhere reporting it.
   *
   * So the gate asks for one line. Routable, and does it spend? Or withheld,
   * and why? Either answer takes ten seconds and both are recorded. The
   * failure message says exactly that, because a red lane whose fix is
   * obvious to its author and cryptic to everyone else is a lane that gets
   * commented out. */
  const undecided = MCP_TOOLS.filter((t) => !(t.name in ROUTABLE) && !(t.name in WITHHELD))
    .map((t) => t.name);
  ok(`all ${MCP_TOOLS.length} tools have a routing decision on record`, undecided.length === 0,
    undecided.length
      ? `${undecided.length} tool(s) added since the table was last read:\n          `
        + undecided.join("\n          ")
        + "\n\n          Each needs ONE line in server/chat/router.js. Either:"
        + "\n            ROUTABLE[name] = null | \"gpu\" | \"destroys\"   — the chat may reach it"
        + "\n            WITHHELD[name] = \"why not\"                    — it may not"
        + "\n          Unlisted already means unreachable, so nothing is broken right now."
        + "\n          This lane is here so the chat does not quietly stop keeping up."
      : "");
}

/* ─────────────────────────────────────────────────────────────── §2 */
head("§2  the gate is DECLARED, because deriving it is wrong in the dangerous direction");

{
  const plan = index().find(({ tool }) => tool.name === "music_plan");
  ok("music_plan is reachable as read-only planning, without a generation gate",
    !!plan && plan.tool.spends === false && !plan.tool.gate && ROUTABLE.music_plan === null);
  for (const name of ["vfx_audio_preview", "vfx_render_job", "yue2_gguf_setup"]) {
    ok(`${name} is explicitly withheld rather than generically auto-approved`,
      typeof WITHHELD[name] === "string" && !(name in ROUTABLE) && !routedNames.has(name));
    ok(`${name} remains available independently through MCP`, mcpByName.has(name));
  }
  ok("CPU preview withholding states the missing CPU confirmation gate",
    WITHHELD.vfx_audio_preview.includes("CPU") && WITHHELD.vfx_audio_preview.includes("confirmation"));
  ok("render control withholding distinguishes cancellation from expensive retry",
    WITHHELD.vfx_render_job.includes("cancels") && WITHHELD.vfx_render_job.includes("retries"));
  ok("GGUF setup withholding preserves explicit download and licence approval",
    WITHHELD.yue2_gguf_setup.includes("download approval") && WITHHELD.yue2_gguf_setup.includes("licence"));

  const bad = index().filter(({ tool }) => tool.spends !== !!tool.gate);
  ok("`spends` is exactly `has a gate`, for every reachable tool", bad.length === 0,
    bad.map((e) => e.tool.name).join(", "));

  const gated = index().filter(({ tool }) => tool.gate);
  ok("every gated tool carries the cost sentence its card will show",
    gated.every(({ tool }) => typeof tool.cost === "string" && tool.cost.length > 10));
  ok("...and it is the sentence for its own kind of gate (or the tool's own, where the gate's would be false)",
    gated.every(({ tool }) => tool.cost === (COST_TEXT_BY_TOOL[tool.name] || COST_TEXT[tool.gate])));
  ok("...and a tool's own sentence is only for a tool that is gated",
    Object.keys(COST_TEXT_BY_TOOL).every((n) => ROUTABLE[n]));

  /* Tools whose names say plainly that they render. If one of these is ever
   * marked free, the chat spends a shared card without asking. */
  const MUST_ASK = [
    "make_clip", "restyle_clip", "daw_render", "daw_bounce", "daw_render_stems",
    "vfx_render", "vfx_preview_frame", "vfx_prewarm", "mv_generate_clip",
    "mv_generate_asset", "mv_regen_clip", "mv_control_render", "mv_render_video",
    "mv_mesh_from_image", "mv_mesh_rig", "image_upscale", "image_cutout",
    "studio_bounce", "daw_preview_note", "daw_voice_lab",
  ];
  for (const name of MUST_ASK) {
    const hit = index().find((e) => e.tool.name === name);
    ok(`${name} asks before it spends`, !!hit && hit.tool.gate === "gpu",
      hit ? `gate is ${hit.tool.gate}` : "not reachable at all");
  }

  /* \u26a0 THEY STILL ASK. THEY JUST DO NOT HOLD THE CARD.
   *
   * image_vectorize lived in MUST_ASK above, asserting gate === "gpu", and the
   * assertion was half right: it was true that the tool asks and false about
   * what it costs. Measured by which routes reach runImageGraph, exactly two
   * image tools touch the card \u2014 cutout and upscale, both still above. The
   * rest are numpy and cv2, and COST_TEXT.gpu was telling people a vectorise
   * "holds the card while it runs".
   *
   * The question is what the gate is FOR, so the row keeps its pin and changes
   * list; loosening it to "has some gate" would have thrown away the half that
   * was right. */
  const MUST_ASK_WRITES = ["image_vectorize", "image_adjust", "image_batch",
    "image_export", "bake_selection", "apply_lut", "image_to_svg",
    "image_new_page", "audio_trim_song"];
  for (const name of MUST_ASK_WRITES) {
    const hit = index().find((e) => e.tool.name === name);
    ok(`${name} asks before it writes a file`, !!hit && hit.tool.gate === "writes",
      hit ? `gate is ${hit.tool.gate}` : "not reachable at all");
    ok(`...and does not claim the graphics card`,
      !!hit && !/holds the card/.test(hit.tool.cost || ""),
      hit ? String(hit.tool.cost) : "");
  }

  /* The two that DO hold it must not have been swept along with them. */
  for (const name of ["image_cutout", "image_upscale"]) {
    const hit = index().find((e) => e.tool.name === name);
    ok(`${name} really does hold the card, and still says so`,
      !!hit && hit.tool.gate === "gpu" && /holds the card/.test(hit.tool.cost || ""),
      hit ? `${hit.tool.gate} / ${hit.tool.cost}` : "not reachable");
  }

  const MUST_ASK_DESTROY = [
    "mv_delete", "daw_delete_project", "daw_remove_track", "daw_remove_clip",
    "vfx_delete_comp", "vfx_remove_layer", "image_trash", "delete_persona",
    "daw_profile_delete", "daw_delete_note",
  ];
  for (const name of MUST_ASK_DESTROY) {
    const hit = index().find((e) => e.tool.name === name);
    ok(`${name} asks before it removes`, !!hit && hit.tool.gate === "destroys",
      hit ? `gate is ${hit.tool.gate}` : "not reachable at all");
  }

  /* ⚠ THE MEASUREMENT THE TABLE EXISTS FOR, pinned so it cannot rot into
   * folklore. Reading each tool's own source for a mutating call is the
   * obvious way to avoid typing 182 lines by hand. It does not work, and it
   * fails by calling real writers free. */
  const MUT = /\bapi\(\s*["'`](POST|PUT|PATCH|DELETE)/i;
  const derivedFree = (t) => !MUT.test(String(t.run))
    && !/\b(dispatch|writeFile|rm\(|unlink|mkdir|rename)\b/.test(String(t.run));

  const importer = mcpByName.get("avatar_import");
  ok("source inspection still calls avatar_import free, and it is not",
    !!importer && derivedFree(importer),
    "if this fails the derivation may have become sound — revisit the hand table");

  const disagreements = MCP_TOOLS.filter((t) => t.name in ROUTABLE)
    .filter((t) => derivedFree(t) !== !ROUTABLE[t.name]);
  ok(`the cheap derivation disagrees with the table on ${disagreements.length} reachable tools`,
    disagreements.length > 10,
    "a small number would mean the derivation is nearly right and worth reconsidering");
}

/* ─────────────────────────────────────────────────────────────── §3 */
head("§3  the shape rule: a 4B emits flat JSON, so nested arguments are not offered");

{
  ok("callableShape accepts an all-scalar required set",
    callableShape({ properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a", "b"] }));
  ok("...refuses a required object",
    !callableShape({ properties: { a: { type: "object" } }, required: ["a"] }));
  ok("...refuses a required array",
    !callableShape({ properties: { a: { type: "array" } }, required: ["a"] }));
  ok("...refuses a required property the schema never declares",
    !callableShape({ properties: {}, required: ["ghost"] }));
  ok("...allows a nested OPTIONAL argument, which is simply never sent",
    callableShape({ properties: { a: { type: "string" }, b: { type: "object" } }, required: ["a"] }));

  const SCALARS = new Set(["string", "number", "boolean"]);
  const offenders = [];
  for (const { tool } of index()) {
    for (const [k, spec] of Object.entries(tool.args || {})) {
      if (!SCALARS.has(spec.type)) offenders.push(`${tool.name}.${k}:${spec.type}`);
    }
  }
  ok("not one reachable tool offers a non-scalar argument", offenders.length === 0,
    offenders.slice(0, 6).join(", "));

  /* The tools that needed nested input are dropped rather than described
   * badly: describing them produces a confident malformed call and a wasted
   * model turn on a shared card. */
  const dropped = Object.keys(ROUTABLE).filter((n) => !routedNames.has(n));
  ok(`${dropped.length} listed tools are dropped for needing nested arguments`,
    dropped.length > 0 && dropped.every((n) => !callableShape(mcpByName.get(n)?.inputSchema)),
    dropped.join(", "));
  ok("...and mv_set_bible is one of them, since a bible is an object",
    dropped.includes("mv_set_bible"));
}

/* ─────────────────────────────────────────────────────────────── §4 */
head("§4  a destructive tool is never volunteered");

{
  ok("wantsRemoval reads an explicit removal word", wantsRemoval(["delete", "project"]));
  ok("...and is not fooled by an ordinary request", !wantsRemoval(["make", "image", "dragon"]));

  const INNOCENT = [
    "what songs do i have?",
    "make me an image of a dragon",
    "add a drum track and put some notes on it",
    "how loud is my master, will it pass spotify?",
    "show me my projects",
    "render the comp",
    "what can you do?",
  ];
  for (const m of INNOCENT) {
    const offered = chooseTools(m, { limit: 12 }).filter((t) => t.gate === "destroys");
    ok(`"${m}" is offered nothing that removes anything`, offered.length === 0,
      offered.map((t) => t.name).join(", "));
  }

  /* ⚠ MEASURED, 2026-09-07, on the first working build: "what songs do i
   * have?" offered daw_remove_track, and "upscale that picture and remove its
   * background" put image_trash FIRST — above image_upscale — because "remove"
   * folds to "delete" and `trash` is a name token. Both are pinned here. */
  const songs = chooseTools("what songs do i have?", { limit: 12 }).map((t) => t.name);
  ok("the measured case: daw_remove_track is not offered to a question about songs",
    !songs.includes("daw_remove_track"), songs.join(", "));

  const upscale = chooseTools("upscale that picture and remove its background", { limit: 6 })
    .map((t) => t.name);
  ok("the measured case: image_upscale now outranks image_trash",
    upscale.indexOf("image_upscale") >= 0
    && (upscale.indexOf("image_trash") < 0 || upscale.indexOf("image_upscale") < upscale.indexOf("image_trash")),
    upscale.join(", "));

  /* Discovery is not lost. Asking to delete finds the deletes, first. */
  const del = chooseTools("delete the project called test", { limit: 6 }).map((t) => t.name);
  ok("asking to delete a project reaches the project deletes",
    del.includes("daw_delete_project") || del.includes("mv_delete"), del.join(", "));
  ok("...and one of them leads", ["daw_delete_project", "mv_delete"].includes(del[0]), del.join(", "));
}

/* ─────────────────────────────────────────────────────────────── §5 */
head("§5  the pin, without which a confirmed spend calls undefined");

{
  /* "yes" matches no tool by its own words. If the pending tool is not pinned
   * into the registry, callTool does deps.tools.get(name) → null and then
   * null.run(args). This is the bug the pin exists for. */
  const bare = chooseTools("yes", { limit: 6 }).map((t) => t.name);
  ok('"yes" on its own routes to nothing at all', bare.length === 0, bare.join(", "));

  const pinned = chooseTools("yes", { limit: 6, pinned: ["make_clip"] }).map((t) => t.name);
  ok("...but the pending tool is carried through", pinned.includes("make_clip"), pinned.join(", "));

  const reg = routedRegistry(core, "yes", { pinned: ["mv_generate_clip"] });
  ok("...and the registry can resolve it by name, which is what callTool does",
    !!reg.get("mv_generate_clip") && typeof reg.get("mv_generate_clip").run === "function");
  ok("...and it still knows the tool spends", reg.spending.includes("mv_generate_clip"));

  ok("a pin that is not routable is ignored rather than throwing",
    Array.isArray(chooseTools("yes", { pinned: ["engine_stop"] })));
  ok("...and a pin that is not a tool at all is ignored too",
    chooseTools("yes", { pinned: ["no_such_tool_anywhere"] }).length === 0);
}

/* ─────────────────────────────────────────────────────────────── §6 */
head("§6  the eight written tools are never displaced");

{
  const MESSAGES = [
    "make me an image of a dragon", "delete everything", "render my comp",
    "add a drum track", "hey", "what can you do?", "turn my sheet into a mesh and rig it",
  ];
  for (const m of MESSAGES) {
    const reg = routedRegistry(core, m);
    const missing = CORE_NAMES.filter((n) => !reg.names.includes(n));
    ok(`"${m}" keeps all eight written tools`, missing.length === 0, missing.join(", "));
  }

  const reg = routedRegistry(core, "make me an image of a dragon");
  ok("a routed tool never shadows a written one of the same name",
    new Set(reg.names).size === reg.names.length, reg.names.join(", "));
  ok("...and the written make_image is the one that answers",
    reg.get("make_image") === core.get("make_image"));
  ok("the routed list is reported separately from the written ones",
    Array.isArray(reg.routed) && reg.routed.every((n) => !CORE_NAMES.includes(n)));
  ok(`at most ${ROUTE_LIMIT} tools are added to a turn`, reg.routed.length <= ROUTE_LIMIT,
    String(reg.routed.length));
}

/* ─────────────────────────────────────────────────────────────── §7 */
head("§7  the prompt still fits the model it is for");

{
  const CEILING = 32768;          // Qwen3-4B's context, the whole reason for routing
  const CHARS_PER_TOKEN = 3.6;    // measured on this prompt's own text

  const HEAVY = [
    "block a camera move around the stage and render the clip",
    "turn my character sheet into a 3d mesh and rig it",
    "add a drum track and put some notes on it and render and bounce it",
    "add a glow effect to the top layer of my comp and render a preview frame",
    "delete the project and remove the track and trash the image",
  ];
  let worst = 0;
  for (const m of HEAVY) {
    worst = Math.max(worst, systemPrompt(routedRegistry(core, m)).length);
  }
  const tokens = Math.round(worst / CHARS_PER_TOKEN);
  ok(`the heaviest routed prompt is ${worst} chars, about ${tokens} tokens`, tokens < CEILING / 3,
    `a third of the ceiling is the working limit; the conversation needs the rest`);

  /* One MCP description runs to 9,966 characters — a third of the whole
   * context for a single tool. The cap is what keeps a routed turn bounded. */
  const longest = index().reduce((a, e) => Math.max(a, e.tool.description.length), 0);
  ok(`no routed description exceeds the cap (longest is ${longest})`, longest <= 1200);
  const rawLongest = MCP_TOOLS.filter((t) => routedNames.has(t.name))
    .reduce((a, t) => Math.max(a, String(t.description).length), 0);
  ok(`...and it is a real cut, since the longest original is ${rawLongest}`, rawLongest > 1200);

  /* Trimming must not sever a sentence mid-word: the model reads this. */
  const trimmed = index().filter(({ tool }) =>
    String(mcpByName.get(tool.name).description).length > 1200);
  ok("every trimmed description ends on a sentence or a line, not mid-word",
    trimmed.every(({ tool }) => /[.\n)\]]$/.test(tool.description.trim())),
    trimmed.slice(0, 3).map((e) => `${e.tool.name}: …${e.tool.description.slice(-40)}`).join(" | "));
}

/* ─────────────────────────────────────────────────────────────── §8 */
head("§8  what the model is told about the gate");

{
  const gpu = index().find((e) => e.tool.gate === "gpu").tool;
  const destroys = index().find((e) => e.tool.gate === "destroys").tool;
  const free = index().find((e) => !e.tool.gate).tool;

  ok("a GPU tool is labelled as spending", gateLabel(gpu) === "   [SPENDS GPU TIME]");
  ok("a destructive tool is NOT called GPU time, because that is not what it costs",
    gateLabel(destroys) === "   [REMOVES WORK — ASKS YOU FIRST]");
  ok("a free tool carries no label at all", gateLabel(free) === "");

  /* The third kind, and the reason it exists: a tool that writes a file must
   * not be announced to the model as GPU time. */
  const writes = index().find((e) => e.tool.gate === "writes").tool;
  ok("a file-writing tool is labelled as writing, not as spending the card",
    gateLabel(writes) === "   [WRITES A FILE \u2014 ASKS YOU FIRST]", gateLabel(writes));
  ok("...and it still asks, because a file stays behind", writes.spends === true);

  /* The eight written tools have no `gate` and must read exactly as before. */
  const written = core.all.find((t) => t.spends);
  ok("a written tool's label is unchanged by any of this",
    gateLabel(written) === "   [SPENDS GPU TIME]");

  const text = describeTool(destroys);
  ok("...and the label reaches the prompt the model actually reads",
    text.includes("[REMOVES WORK — ASKS YOU FIRST]"));
  ok("...on the same line as the tool name", text.split("\n")[0].includes(destroys.name));
}

/* ─────────────────────────────────────────────────────────────── §9 */
head("§9  the scorer, and that routing costs no model call");

{
  ok("a name hit outweighs a summary hit",
    scoreTool(["image"], { name: new Set(["image"]), summary: new Set() })
    > scoreTool(["image"], { name: new Set(), summary: new Set(["image"]) }));
  ok("stop words carry no signal", words("the a an of to for").length === 0);
  ok("plurals fold onto the singular", toolTokens({ name: "list_songs", description: "Every song." }).name.has("song"));

  /* The whole point of a lexical scorer: it is cheap. A second inference to
   * choose tools would double the latency of every turn on a shared card. */
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) chooseTools("render the comp and bounce the mix");
  const ms = (Date.now() - t0) / 200;
  ok(`choosing from ${index().length} tools costs ${ms.toFixed(2)} ms and no model call`, ms < 20,
    "if this is slow the index is being rebuilt per call");

  ok("an empty message routes nothing", chooseTools("").length === 0);
  ok("a message of pure punctuation routes nothing", chooseTools("!!! ??? ...").length === 0);
  ok("a very long message does not throw", chooseTools("render ".repeat(500)).length <= ROUTE_LIMIT);
}

/* ─────────────────────────────────────────────────────────────── §10 */
head("§10  the overrides the chat may not send");

{
  /* Accepting a friend's order and keeping a returned take are ordinary writes
   * the chat may make after its confirm card. Their `anyway` is not: it walks
   * past a busy card, the minutes a day a person gave that friend, or a take
   * that failed its checks — and the confirm card cannot say which. */
  const argsFor = (name) => (name === "collab_accept" ? { file: "x.aiplay", seen: true } : { from: "ab", file: "x.mp4" });
  for (const name of ["collab_accept", "collab_adopt"]) {
    const tool = MCP_TOOLS.find((t) => t.name === name);
    ok(`${name} is routable, and its override is on the withheld list`,
      !!tool && ROUTABLE[name] === "writes" && "anyway" in (CHAT_WITHHELD_ARGS[name] || {}));
    const calls = [];
    const adapted = adaptTool({ ...tool, run: async (a) => { calls.push(a); return { ok: true }; } }, ROUTABLE[name]);
    ok(`...${name} is never shown \`anyway\``, !("anyway" in adapted.args) && "file" in adapted.args);
    let refused = null;
    try { await adapted.run({ ...argsFor(name), anyway: true }); } catch (e) { refused = e.message; }
    ok("...and a call that sends it anyway is refused by name, never silently stripped",
      /^anyway is not available in this chat/.test(refused || "") && calls.length === 0, refused);
    await adapted.run(argsFor(name));
    ok("...while the ordinary call goes through, with no override in it",
      calls.length === 1 && !("anyway" in calls[0]), JSON.stringify(calls));
  }
  /* ⚠ AND THE WAY ROUND IT (release critic, 2026-09-24): with collab_accept
   * routable, raising a friend's minutes a day and then accepting walked past
   * the same check the withheld `anyway` guards. The allowance, the role and
   * the trust grant are a person's decisions on the Collab screen. */
  for (const name of ["collab_set_lend_minutes", "collab_set_role", "collab_verify"]) {
    ok(`${name} is withheld from the in-app chat, with a reason, and never routed`,
      !(name in ROUTABLE) && typeof WITHHELD[name] === "string" && WITHHELD[name].length > 40
      && !index().some((e) => e.tool.name === name), WITHHELD[name]);
  }
  ok("...and the minutes setter's reason names the accept it would get around",
    /collab_accept/.test(WITHHELD.collab_set_lend_minutes) && /anyway/.test(WITHHELD.collab_set_lend_minutes));
  /* video_settings SAVES what it sets (sparse attention on Fast among it). */
  ok("video_settings asks first, and its card says the change is saved, not a new file",
    ROUTABLE.video_settings === "writes" && /SAVED/.test(COST_TEXT_BY_TOOL.video_settings)
    && !/NEW FILE/.test(COST_TEXT_BY_TOOL.video_settings));
  /* A plain read asks too (the router gates the tool, not the call), so the
   * card says reading changes nothing, in plain words, and the chat's tool
   * list does not call it a file (release critic). */
  const vs = adaptTool({ ...MCP_TOOLS.find((t) => t.name === "video_settings"), run: async () => ({}) }, ROUTABLE.video_settings);
  ok("...its card says a read changes nothing, with no engine jargon, and its tag says it saves a setting, not a file",
    /reading your video settings changes nothing/.test(vs.cost) && !/sparse attention|Fast/.test(vs.cost)
    && gateLabel(vs) === "   [SAVES A SETTING \u2014 ASKS YOU FIRST]", `${vs.cost} | ${gateLabel(vs)}`);
  ok("every tool named on that list is a real tool with that argument",
    Object.entries(CHAT_WITHHELD_ARGS).every(([name, a]) => {
      const props = MCP_TOOLS.find((t) => t.name === name)?.inputSchema?.properties || {};
      return Object.keys(a).every((k) => k in props);
    }));
}

/* ─────────────────────────────────────────────────────────────── §11 */
head("§11  the score tools, the stem splitter and the Stop button are within reach");

{
  /* ⚠ MEASURED 2026-09-24 (a user's question led to it): hum_to_score and
   * song_to_score were in ROUTABLE, but their required `source` is an object,
   * so the shape rule dropped them and "turn my hum into a score" was offered
   * score_* tools instead. daw_edit_notes was dropped the same way. */
  for (const name of ["hum_to_score", "song_to_score", "daw_edit_notes"]) {
    ok(`${name} is in the index`, routedNames.has(name));
  }
  const hum = chooseTools("turn my hum into a score").map((t) => t.name);
  ok("\"turn my hum into a score\" reaches hum_to_score first", hum[0] === "hum_to_score", hum.join(", "));
  const humTool = index().find((e) => e.tool.name === "hum_to_score")?.tool;
  ok("...offering the flat library_file a 4B sends best, and source as a JSON string",
    humTool?.args?.library_file?.type === "string" && humTool?.args?.source?.type === "string"
    && /^JSON object/.test(humTool?.args?.source?.note || ""), JSON.stringify(humTool?.args));
  const calls = [];
  const adapted = adaptTool({ ...mcpByName.get("hum_to_score"), run: async (a) => { calls.push(a); return { ok: true }; } }, ROUTABLE.hum_to_score);
  await adapted.run({ source: JSON.stringify({ library_file: "aiplay_00001.flac" }) });
  ok("...and a JSON source is decoded before the MCP tool runs",
    calls[0]?.source?.library_file === "aiplay_00001.flac", JSON.stringify(calls));

  ok("separate_stems is reachable and asks first (it holds the card)",
    routedNames.has("separate_stems") && ROUTABLE.separate_stems === "gpu");
  const split = chooseTools("separate the stems of my last song").map((t) => t.name);
  ok("...and \"separate the stems\" finds it", split.includes("separate_stems"), split.join(", "));
  ok("stop_generation is reachable and asks first (it ends the person's own render)",
    routedNames.has("stop_generation") && ROUTABLE.stop_generation === "writes");
  const stopCard = index().find(({ tool }) => tool.name === "stop_generation")?.tool?.cost || "";
  ok("...and its card does not say Stop writes a new file", /ends the render/.test(stopCard) && !/NEW FILE/.test(stopCard), stopCard);
  ok("stems_python is withheld: it names a program Studio runs",
    typeof WITHHELD.stems_python === "string" && /program/.test(WITHHELD.stems_python) && !("stems_python" in ROUTABLE));
  ok("setup_feature stays withheld, so a refusal's setup id waits for the person",
    typeof WITHHELD.setup_feature === "string" && !routedNames.has("setup_feature"));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
