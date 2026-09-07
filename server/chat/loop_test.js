/**
 * CHAT v1 — the loop, against a FAKE MODEL.
 *
 * Every assertion here runs with no GPU, no engine and no network. That is the
 * point: the four things this loop must get right are the four things that are
 * expensive or impossible to provoke against the real model on a shared card.
 *
 *   1. THE PROTOCOL PARSE. Both accepted shapes, the balanced-brace scan that
 *      sfxcue.js's `/\{[^}]*\}/` cannot do, and every refusal by name.
 *   2. CONFIRM BEFORE SPEND. A spending tool is NOT called in the turn it is
 *      proposed, IS called when the next message says yes, is NOT called when
 *      it says no, and is NOT called when the person changes the subject. This
 *      is the whole reason the loop has state between turns.
 *   3. MALFORMED JSON. One re-ask, then a plain sentence — never a third call,
 *      because a small model that has failed twice will fail a third time and
 *      each attempt is seconds on a card somebody else's render wants.
 *   4. THE STEP CAP. Six model calls per message, counted, and it ends by
 *      saying so.
 *
 * Runs standalone (`node server/chat/loop_test.js`) and in the pre-commit hook.
 */
import {
  runTurn, newSession, parseReply, firstJsonObject, allJsonObjects, systemPrompt, buildPrompt,
  engineBusy, describeTool, renderTranscript, MAX_STEPS, RESULT_BUDGET,
  announcesAction, NOTHING_STARTED,
} from "./loop.js";
import { createChatTools } from "./tools.js";
import { createChatRoutes } from "./routes.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/** The route's JSONL-row translator, reached without mounting anything. It is
 *  exported off the handler because that file is where the two turn shapes
 *  meet, and a translation with no test is how they drifted apart. */
const routeTurnsFromRows = createChatRoutes({ json: () => {}, readBody: async () => ({}) }).turnsFromRows;

/* ── the stand-ins ───────────────────────────────────────────────────────── */

/** Tools whose `run` records instead of doing. Same names, same `spends`. */
function fakeTools() {
  const calls = [];
  const tools = createChatTools({
    api: async () => { throw new Error("the api stub must not be reached in this test"); },
  });
  for (const t of tools.all) {
    t.run = async (a) => { calls.push({ tool: t.name, args: a }); return { stub: t.name, got: a }; };
  }
  tools.calls = calls;
  return tools;
}

/** A model that reads its answers off a list, and counts how often it is asked. */
function scriptedModel(answers) {
  const seen = [];
  const fn = async (prompt) => {
    seen.push(prompt);
    return answers.length ? answers.shift() : '{"say": "ran out of scripted answers"}';
  };
  fn.prompts = seen;
  return fn;
}

/** An engine that is always idle, so the busy gate never fires by accident. */
const idleEngine = { status: async () => ({ ready: true, queue: { running: 0, pending: 0 }, running: [] }) };

const drain = () => { const evs = []; return [evs, (e) => evs.push(e)]; };

/* ══ 1. the protocol ══════════════════════════════════════════════════════ */
console.log("\nTHE PROTOCOL");

const T = fakeTools();

ok("the eight tools are the eight", T.names.join(",") ===
  "make_song,song_status,list_library,make_image,list_images,mv_create_project,mv_previz_shot,mv_control_check",
  T.names.join(","));
ok("three of them spend, and they are the three named",
  T.spending.join(",") === "make_song,make_image,mv_previz_shot", T.spending.join(","));

ok("a balanced object is found past an inner brace",
  firstJsonObject('here you go: {"tool":"x","args":{"a":1}} thanks') === '{"tool":"x","args":{"a":1}}',
  String(firstJsonObject('here you go: {"tool":"x","args":{"a":1}} thanks')));
ok("...and a brace INSIDE A STRING does not end it — the exact case sfxcue.js's regex gets wrong",
  firstJsonObject('{"say": "use {curly} braces"}') === '{"say": "use {curly} braces"}',
  String(firstJsonObject('{"say": "use {curly} braces"}')));
ok("an escaped quote does not end the string either",
  firstJsonObject('{"say": "he said \\"hi\\" and left"}') === '{"say": "he said \\"hi\\" and left"}');
ok("no object at all reads as none", firstJsonObject("I think we should make a song") === null);

ok("the protocol shape parses as a tool call", (() => {
  const r = parseReply('{"tool":"list_library","args":{"limit":5}}', T);
  return r.kind === "tool" && r.tool.name === "list_library" && r.args.limit === 5;
})());
ok("THE FLATTENED SHAPE parses too — a 4B half-remembering the instruction is read, not refused", (() => {
  const r = parseReply('{"tool":"list_library","limit":3}', T);
  return r.kind === "tool" && r.tool.name === "list_library" && r.args.limit === 3;
})());
ok("a say parses as a say", (() => {
  const r = parseReply('{"say":"you have four songs"}', T);
  return r.kind === "say" && r.text === "you have four songs";
})());
ok("prose around the object is tolerated (the model is greedy, not obedient)", (() => {
  const r = parseReply('Sure! {"say":"ok"} — anything else?', T);
  return r.kind === "say";
})());

ok("an INVENTED TOOL NAME is refused and the real names are named", (() => {
  const r = parseReply('{"tool":"render_masterpiece","args":{}}', T);
  return r.kind === "malformed" && r.why.includes("make_song") && r.why.includes("render_masterpiece");
})(), "guessing which of eight was meant is how a chat spends money on the wrong thing");
ok("a NESTED value inside args is refused by name — the measured 4B failure", (() => {
  const r = parseReply('{"tool":"mv_previz_shot","args":{"slug":"x","spec":{"set":"corridor"}}}', T);
  return r.kind === "malformed" && r.why.includes("args.spec");
})());
ok("a list inside args is refused the same way",
  parseReply('{"tool":"list_library","args":{"limit":[1,2]}}', T).kind === "malformed");
ok("neither key is refused",
  parseReply('{"hello":"world"}', T).kind === "malformed");
ok("broken JSON is refused with the parser's own reason", (() => {
  const r = parseReply('{"tool":"list_library","args":{', T);
  return r.kind === "malformed" && /no JSON object|did not parse/.test(r.why);
})());
ok("JSON that is not an object at all is refused",
  parseReply('["make_song", "now"]', T).kind === "malformed");

/* The system prompt is what the 4B actually sees, and a tool whose paragraph
 * silently stopped being included is invisible rather than broken. */
const SYS = systemPrompt(T.all);
ok("the system prompt carries all eight tool names", T.names.every((n) => SYS.includes(`TOOL ${n}`)),
  T.names.filter((n) => !SYS.includes(`TOOL ${n}`)).join(", "));
/* Counted on the TOOL HEADER lines only. The marker also appears once in the
 * protocol paragraph that explains what it means, and counting that as a fourth
 * spending tool is how this check would quietly stop meaning anything. */
const marked = SYS.split("\n").filter((l) => l.startsWith("TOOL ") && l.includes("[SPENDS GPU TIME]"));
ok("...and marks exactly the three spending tools, on their own headers",
  marked.length === 3 && marked.every((l) => /make_song|make_image|mv_previz_shot/.test(l)), marked.join(" | "));
ok("...and states both reply shapes verbatim",
  SYS.includes('{"tool": "<tool name>", "args": {"<name>": "<value>", ...}}') && SYS.includes('{"say":'));
ok("...and forbids nesting in as many words", /Never put an object or a\s*list inside args/.test(SYS.replace(/\n/g, "\n")) || SYS.includes("Never put an object or a"));
ok("make_song's paragraph carries the THREE-PART caption rule",
  /Global Metadata/.test(SYS) && /Vocal Details/.test(SYS) && /Arrangement/.test(SYS));
ok("...and that output length tracks lyric length",
  /LENGTH OF THE OUTPUT TRACKS THE LENGTH OF THE LYRICS/.test(SYS));
ok("mv_control_check's paragraph carries all three numbers, because all three fail silently",
  /1280 by 704/.test(SYS) && /24 frames per second/.test(SYS) && /121 frames/.test(SYS));
ok("mv_previz_shot's paragraph says the grey boxes are NOT for a model",
  /Do not offer it as an input to a video\s+model/.test(SYS) || SYS.includes("Do not offer it as an input to a video"));
ok("describeTool lists an argument's type and whether it is required",
  describeTool(T.get("make_song")).includes("caption (string, REQUIRED)"));

/* ══ 2. confirm before spend ══════════════════════════════════════════════ */
console.log("\nCONFIRM BEFORE SPEND");

{
  const tools = fakeTools();
  const s = newSession("t_spend");
  const model = scriptedModel(['{"tool":"make_song","args":{"caption":"Global Metadata. 120 BPM."}}']);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "write me a song", emit);

  ok("a spending tool is NOT called in the turn it is proposed", tools.calls.length === 0,
    JSON.stringify(tools.calls));
  ok("...the turn ends with a proposal carrying the exact args", !!out.proposal
    && out.proposal.tool === "make_song"
    && out.proposal.args.caption === "Global Metadata. 120 BPM.");
  ok("...and the cost sentence goes with it", (() => {
    const p = evs.find((e) => e.type === "proposal");
    return p && /minutes of GPU/.test(p.cost);
  })());
  ok("...and the session is left holding it", s.pending?.tool === "make_song");

  /* The second turn confirms. NOTE the scripted model is EMPTY of a second
   * tool call: if the loop asked the model what to do rather than running the
   * arguments it already agreed, the args could change between the plan and
   * the approval. It must not. */
  const model2 = scriptedModel(['{"say":"your song is rendering"}']);
  const [evs2, emit2] = drain();
  await runTurn({ tools, engine: idleEngine, model: model2 }, s, "yes", emit2);

  ok("a following 'yes' runs it", tools.calls.length === 1 && tools.calls[0].tool === "make_song");
  ok("...with the arguments that were shown, not re-asked for",
    tools.calls[0].args.caption === "Global Metadata. 120 BPM.");
  ok("...and the proposal is cleared", s.pending === null);
  ok("...and the person is told what happened", evs2.some((e) => e.type === "say"));
}

{
  /* ── THE PICTURE, THROUGH THE SAME GATE ───────────────────────────────────
   *
   * make_image is the newest spending tool and the one a person will reach for
   * first, so the gate is asserted on it BY NAME rather than inferred from
   * make_song's turn above: a spending tool that skipped the confirm would pass
   * every check in this file and still be the one thing this gate exists to
   * stop. The cost sentence is read too — an empty one puts a confirm button in
   * front of a person with nothing beside it. */
  const tools = fakeTools();
  const s = newSession("t_image");
  const [evs, emit] = drain();
  const out = await runTurn(
    { tools, engine: idleEngine, model: scriptedModel(['{"tool":"make_image","args":{"prompt":"a lighthouse in fog"}}']) },
    s, "draw me a lighthouse", emit);
  ok("a picture is PROPOSED, not drawn — the card is not touched in the turn it is asked for",
    tools.calls.length === 0 && out.proposal?.tool === "make_image", JSON.stringify(tools.calls));
  ok("...and the proposal carries the prompt the person will read on the confirm card",
    out.proposal.args.prompt === "a lighthouse in fog");
  ok("...and a cost sentence that names what is being spent",
    /graphics card/.test(evs.find((e) => e.type === "proposal")?.cost || ""),
    evs.find((e) => e.type === "proposal")?.cost);
  await runTurn({ tools, engine: idleEngine, model: scriptedModel(['{"say":"here it is"}']) }, s, "yes", () => {});
  ok("...and a following 'yes' draws exactly the picture that was shown",
    tools.calls.length === 1 && tools.calls[0].tool === "make_image"
    && tools.calls[0].args.prompt === "a lighthouse in fog", JSON.stringify(tools.calls));
}

{
  const tools = fakeTools();
  const s = newSession("t_no");
  await runTurn({ tools, engine: idleEngine, model: scriptedModel(['{"tool":"make_song","args":{"caption":"c"}}']) },
    s, "song please", () => {});
  const [evs, emit] = drain();
  await runTurn({ tools, engine: idleEngine, model: scriptedModel([]) }, s, "no", emit);
  ok("'no' does not run it and says nothing was spent",
    tools.calls.length === 0 && evs.some((e) => e.type === "say" && /nothing was spent/.test(e.text)));
  ok("...and the proposal is gone", s.pending === null);
}

{
  /* A ROUTED tool can be stopped at the same gate for the OTHER reason: it
   * removes work rather than spending a card. Telling someone who just
   * declined a delete that "nothing was spent" answers a question they did not
   * ask and leaves the one they did — was it deleted? — unanswered. */
  const tools = fakeTools();
  const s = newSession("t_no_destroy");
  s.pending = { tool: "daw_profile_delete", args: { profile: "nonsense" }, gate: "destroys" };
  const [evs, emit] = drain();
  await runTurn({ tools, engine: idleEngine, model: scriptedModel([]) }, s, "no", emit);
  const said = evs.find((e) => e.type === "say")?.text || "";
  ok("declining a REMOVAL says nothing was removed, not that nothing was spent",
    /nothing was removed/.test(said) && !/spent/.test(said), said);
  ok("...and it ran nothing", tools.calls.length === 0);

  const t2 = fakeTools(); const s2 = newSession("t_no_spend");
  s2.pending = { tool: "make_song", args: {}, gate: "gpu" };
  const [e2, m2] = drain();
  await runTurn({ tools: t2, engine: idleEngine, model: scriptedModel([]) }, s2, "no", m2);
  ok("...and a spend still says spent, so the old sentence is not lost",
    /nothing was spent/.test(e2.find((e) => e.type === "say")?.text || ""));
}

{
  const tools = fakeTools();
  const s = newSession("t_subject");
  await runTurn({ tools, engine: idleEngine, model: scriptedModel(['{"tool":"mv_previz_shot","args":{"slug":"a","move":"push_in"}}']) },
    s, "block a shot", () => {});
  ok("the previz proposal is held", s.pending?.tool === "mv_previz_shot");
  await runTurn({ tools, engine: idleEngine, model: scriptedModel(['{"tool":"list_library","args":{}}', '{"say":"here they are"}']) },
    s, "actually what songs do I have", () => {});
  ok("CHANGING THE SUBJECT IS NOT CONSENT — the previz never ran",
    !tools.calls.some((c) => c.tool === "mv_previz_shot"), JSON.stringify(tools.calls));
  ok("...and the new request was served instead",
    tools.calls.some((c) => c.tool === "list_library"));
  ok("...and the dropped proposal is on the record rather than vanished",
    s.turns.some((t) => t.role === "note" && /did not confirm/.test(t.text)));
}

{
  /* A NON-spending tool must not be gated — that would make the gate noise, and
   * a gate that fires on everything is one nobody reads. */
  const tools = fakeTools();
  const s = newSession("t_free");
  await runTurn({ tools, engine: idleEngine, model: scriptedModel(['{"tool":"list_library","args":{"limit":3}}', '{"say":"three tracks"}']) },
    s, "what have I got", () => {});
  ok("a free tool runs straight away, with no confirmation",
    tools.calls.length === 1 && tools.calls[0].tool === "list_library" && s.pending === null);
}

/* ══ 3. malformed JSON ════════════════════════════════════════════════════ */
console.log("\nMALFORMED JSON");

{
  const tools = fakeTools();
  const s = newSession("t_bad");
  const model = scriptedModel(["I would love to help you write a song!", '{"say":"what genre?"}']);
  const [evs, emit] = drain();
  await runTurn({ tools, engine: idleEngine, model }, s, "hello", emit);
  ok("ONE re-ask, and the second answer is used", model.prompts.length === 2 && evs.some((e) => e.type === "reask"));
  ok("...and the re-ask carries the reason back to the model",
    /THAT LAST REPLY WAS NOT USABLE/.test(model.prompts[1]));
  ok("...and the good answer lands", evs.some((e) => e.type === "say" && e.text === "what genre?"));
}

{
  const tools = fakeTools();
  const s = newSession("t_bad2");
  const model = scriptedModel(["nope", "still nope", '{"say":"this must never be reached"}']);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "hello", emit);
  ok("TWICE malformed gives up rather than asking a third time", model.prompts.length === 2,
    `asked ${model.prompts.length} times`);
  ok("...with the plain sentence", out.malformed === true
    && evs.some((e) => e.type === "say" && e.text === "I could not form a tool call."));
  ok("...and the reason is attached for anyone who wants it, without being the answer",
    evs.some((e) => e.type === "say" && typeof e.note === "string" && e.note.length > 0));
}

/* ══ 4. the step cap ══════════════════════════════════════════════════════ */
console.log("\nTHE STEP CAP");

{
  const tools = fakeTools();
  const s = newSession("t_cap");
  /* A model that keeps calling a free tool with DIFFERENT arguments loops
   * forever without a cap — and different arguments are what the repeat guard
   * below deliberately does not catch, because a second call really could
   * answer differently. This is the case the cap is for. */
  const answers = Array.from({ length: 20 }, (_, i) => `{"tool":"list_library","args":{"limit":${i + 1}}}`);
  const model = scriptedModel(answers);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "go", emit);
  ok(`exactly ${MAX_STEPS} model calls, never more`, model.prompts.length === MAX_STEPS,
    `made ${model.prompts.length}`);
  ok("...the tool ran that many times and stopped", tools.calls.length === MAX_STEPS);
  ok("...and it ENDS BY SAYING SO rather than stopping silently",
    out.capped === true && evs.some((e) => e.type === "say" && /six steps/.test(e.text)));
  ok("...and a done event closes the stream either way",
    evs.filter((e) => e.type === "done").length === 1);
}

/* ══ 4b. the repeat guard — BOTH HALVES MEASURED LIVE ═════════════════════
 *
 * 2026-09-05, through the real door on 4173: asked "what's in my library?" the
 * real Qwen3-4B called list_library, read the result, and then called it again
 * every step until the cap fired — six model calls, 26.8 s of card, no answer.
 * Run mto44nad44ca37's raw output carried BOTH the repeated call and the real
 * answer, on two lines, and a first-object rule threw the answer away. */
console.log("\nTHE REPEAT GUARD");

{
  const tools = fakeTools();
  const s = newSession("t_repeat");
  const model = scriptedModel([
    '{"tool":"list_library","args":{}}',
    '{"tool":"list_library","args":{}}',
    '{"say":"you have 90 tracks"}',
  ]);
  const [evs, emit] = drain();
  await runTurn({ tools, engine: idleEngine, model }, s, "what is in my library", emit);
  ok("a repeated call with the SAME arguments is not run a second time — it cannot answer differently",
    tools.calls.length === 1, JSON.stringify(tools.calls));
  ok("...the model is told the tool has already answered", evs.some((e) => e.type === "repeat"));
  ok("...and the nudge names the tool and asks for words",
    /list_library has ALREADY answered/.test(model.prompts[2]) && /"say"/.test(model.prompts[2]));
  ok("...and the answer lands", evs.some((e) => e.type === "say" && /90 tracks/.test(e.text)));
}

{
  const tools = fakeTools();
  const s = newSession("t_repeat2");
  const model = scriptedModel([
    '{"tool":"list_library","args":{}}',
    '{"tool":"list_library","args":{}}',
    '{"tool":"list_library","args":{}}',
    '{"say":"never reached"}',
  ]);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "go", emit);
  ok("ONE nudge, then the turn ends honestly rather than nudging five more times on a shared card",
    out.repeated === true && model.prompts.length === 3, `${model.prompts.length} calls`);
  ok("...and it says what it has rather than pretending it failed",
    evs.some((e) => e.type === "say" && /could not put it into words/.test(e.text)));
}

{
  /* THE EXACT SHAPE run mto44nad44ca37 produced. */
  const tools = fakeTools();
  const s = newSession("t_two");
  const model = scriptedModel([
    '{"tool":"list_library","args":{}}',
    '{"tool":"list_library","args":{}}\r\n{"say": "Here are the songs already finished on this machine, newest first: PRISM (181 seconds)."}',
  ]);
  const [evs, emit] = drain();
  await runTurn({ tools, engine: idleEngine, model }, s, "what's in my library?", emit);
  ok("A REPLY CARRYING BOTH A REPEATED CALL AND THE ANSWER is read as the answer",
    evs.some((e) => e.type === "say" && /PRISM \(181 seconds\)/.test(e.text)),
    JSON.stringify(evs.map((e) => e.type)));
  ok("...in two model calls, not six", model.prompts.length === 2);
  ok("...and the tool still ran exactly once", tools.calls.length === 1);
}

{
  /* THE CONDITION IS LOAD-BEARING. A model that narrates before its FIRST call
   * must not have that call skipped, which is the opposite failure. */
  const tools = fakeTools();
  const s = newSession("t_two_first");
  const model = scriptedModel([
    '{"say":"let me look"}\n{"tool":"list_library","args":{}}',
    '{"say":"two tracks"}',
  ]);
  await runTurn({ tools, engine: idleEngine, model }, s, "go", () => {});
  ok("two objects with NO repeat among them take the first, so a first call is never skipped",
    tools.calls.length === 0, JSON.stringify(tools.calls));
}

ok("allJsonObjects finds every top-level object and no inner one", (() => {
  const got = allJsonObjects('{"a":{"b":1}}\n{"c":2}');
  return got.length === 2 && got[0] === '{"a":{"b":1}}' && got[1] === '{"c":2}';
})());
ok("...and a brace inside a top-level string does not split a reply", (() => {
  const got = allJsonObjects('{"say":"a } brace"}\n{"say":"two"}');
  return got.length === 2;
})());
ok("the FLATTENED no-args shape the real model emitted first parses as a call", (() => {
  const r = parseReply('{"tool": "list_library"}', T);
  return r.kind === "tool" && r.tool.name === "list_library" && Object.keys(r.args).length === 0;
})(), "run mto44e9q56bc24's actual first reply, verbatim");

/* ══ 5. the busy card ═════════════════════════════════════════════════════ */
console.log("\nTHE BUSY CARD");

{
  const busyEngine = {
    status: async () => ({
      ready: true, queue: { running: 1, pending: 0 },
      running: [{ runId: "r1", label: "vace pass", via: "mv.control", runningSec: 1500 }],
    }),
  };
  const tools = fakeTools();
  const s = newSession("t_busy");
  const model = scriptedModel(['{"say":"this must never be reached"}']);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: busyEngine, model }, s, "what is in my library", emit);
  ok("a busy card stops the turn BEFORE the model is asked anything", model.prompts.length === 0);
  ok("...and says the message will run when the render frees the card",
    out.busy === true && evs.some((e) => e.type === "busy" && /frees it/.test(e.text)));
  ok("...naming what is holding it and for how long",
    evs.some((e) => e.type === "busy" && /vace pass/.test(e.text) && /25 minutes/.test(e.text)));
  ok("...and the message is kept on the transcript rather than lost",
    s.turns.some((t) => t.role === "user" && t.text === "what is in my library"));
}

{
  /* Our OWN in-flight chat call must not read as somebody else's render, or a
   * two-step turn would refuse its own second step. */
  const selfBusy = {
    status: async () => ({
      ready: true, queue: { running: 1, pending: 0 },
      running: [{ runId: "r1", label: "chat step 1", via: "chat", runningSec: 2 }],
    }),
  };
  const b = await engineBusy(selfBusy);
  ok("this loop's own model call does not count as the card being busy", b.blocked === false, b.why);
}

{
  const down = { status: async () => { throw new Error("no engine"); } };
  const b = await engineBusy(down);
  ok("an unreachable engine blocks and says why", b.blocked === true && /could not be reached/.test(b.why));
  const notReady = { status: async () => ({ ready: false }) };
  ok("an engine that is not up yet blocks with a different sentence",
    (await engineBusy(notReady)).blocked === true);
}

/* ══ 6. the prompt the model actually gets ════════════════════════════════ */
console.log("\nTHE PROMPT");

{
  const s = newSession("t_prompt");
  s.turns.push({ role: "user", text: "hi" });
  s.turns.push({ role: "tool_call", tool: "list_library", args: { limit: 2 } });
  s.turns.push({ role: "tool_result", tool: "list_library", result: { count: 2 } });
  const p = buildPrompt(T, s.turns, null);
  ok("the transcript is rendered into the prompt", /PERSON: hi/.test(p) && /TOOL list_library RESULT/.test(p));
  ok("...and it ends by asking for one object", /Reply now with ONE JSON object and nothing else\.$/.test(p.trim()));
  const big = { role: "tool_result", tool: "x", result: { blob: "z".repeat(9000) } };
  const p2 = buildPrompt(T, [big], null);
  ok("a huge tool result is truncated rather than blowing the 4B's context", p2.length < 20000,
    `${p2.length} chars`);
  /* THE MEASURED BUG, in a test. A silent cut reads to a model as the end of
   * the data — live, it ended its answer mid-word at exactly the character the
   * old 900-char cut fell on. */
  ok("...and the truncation SAYS SO, so the model cannot read a cut as the end of the data",
    /\[CUT — this result was 9\d+ characters/.test(p2) && /Say the list is longer/.test(p2));
  const ten = { role: "tool_result", tool: "list_library", result: { count: 10, total: 90,
    tracks: Array.from({ length: 10 }, (_, i) => ({ file: `aiplay_000${i}.flac`, title: `Track ${i}`, seconds: 180, has_cover: true, has_lyrics: false })) } };
  ok("...and a NORMAL ten-track library fits inside the budget whole, which the old 900 did not",
    !/\[CUT/.test(buildPrompt(T, [ten], null)),
    `${JSON.stringify(ten.result).length} chars of result vs a ${RESULT_BUDGET} budget`);
}

/* ══ 7. THE THREE HOLES THE ADVERSARIAL PASS FOUND ════════════════════════
 *
 * All three were live-reachable on 2026-09-05 and all three are fixed. They are
 * pinned here because every one of them is SILENT: nothing throws, nothing
 * logs, and the only symptom is a bill or an answer that makes no sense.
 */
console.log("\nTHE THREE HOLES");

/** An engine holding a long render, the shape the door's status really has. */
const busyEngine = {
  status: async () => ({
    ready: true, queue: { running: 1, pending: 0 },
    running: [{ via: "api", label: "vace pass s03", runningSec: 1320, state: "running" }],
  }),
};

/* ── HOLE 1: the busy gate did not cover the CONFIRM turn ────────────────── */
{
  const s = newSession("t_busyconfirm");
  const T7 = fakeTools();
  const model = scriptedModel(['{"tool": "make_song", "args": {"caption": "rain", "lyrics": "[Verse]"}}']);
  const [e1, on1] = drain();
  await runTurn({ tools: T7, engine: idleEngine, model }, s, "make me a song about rain", on1);
  ok("a spend is proposed while the card is free", e1.some((e) => e.type === "proposal") && !!s.pending);

  const [e2, on2] = drain();
  const r = await runTurn({ tools: T7, engine: busyEngine, model }, s, "yes", on2);
  ok("saying YES while the card is busy spends NOTHING", T7.calls.length === 0,
    `ran ${JSON.stringify(T7.calls)}`);
  ok("...and asks the model nothing, so the turn is not queued behind the render",
    model.prompts.length === 1, `${model.prompts.length} model calls`);
  ok("...and says so rather than hanging", e2.some((e) => e.type === "busy"));
  ok("...and KEEPS the proposal, because a yes that was refused is still a yes",
    !!s.pending && s.pending.tool === "make_song" && r.held?.tool === "make_song");
  ok("...and the busy event names what it is holding",
    e2.find((e) => e.type === "busy")?.holding === "make_song");

  const [e3, on3] = drain();
  await runTurn({ tools: T7, engine: idleEngine, model: scriptedModel(['{"say": "started"}']) }, s, "yes", on3);
  ok("...and once the card is free the held proposal runs its ORIGINAL arguments",
    T7.calls.length === 1 && T7.calls[0].tool === "make_song" && T7.calls[0].args.caption === "rain",
    JSON.stringify(T7.calls));
  ok("...having emitted the confirmation rather than a second proposal",
    e3.some((e) => e.type === "confirmed") && !e3.some((e) => e.type === "proposal"));
}

/* ── HOLE 1b: saying NO is answered even while the card is busy ──────────── */
{
  const s = newSession("t_busydecline");
  const T7 = fakeTools();
  s.pending = { tool: "make_song", args: { caption: "x" } };
  const [evs, on] = drain();
  await runTurn({ tools: T7, engine: busyEngine, model: scriptedModel([]) }, s, "no", on);
  ok("saying NO is answered even on a busy card — stopping a spend costs no card at all",
    evs.some((e) => e.type === "say" && /was not run/.test(e.text)) && !evs.some((e) => e.type === "busy"));
  ok("...and the proposal is gone", s.pending === null);
}

/* ── HOLE 2: one yes could buy two songs ─────────────────────────────────── */
{
  const s = newSession("t_double");
  const T7 = fakeTools();
  const same = '{"tool": "make_song", "args": {"caption": "rain", "lyrics": "[Verse]"}}';
  /* A 4B echoing its own tool call is the failure this loop already guards
   * against mid-turn. Before the fix the confirm path re-entered think() with
   * an EMPTY `called` set, so the echo came back as a second proposal for the
   * identical arguments — and a second yes rendered the same song twice off
   * one intent, with both jobs in the ledger under agent:chat. */
  const model = scriptedModel([same, same, same, same]);
  await runTurn({ tools: T7, engine: idleEngine, model }, s, "song about rain", () => {});
  const [e2, on2] = drain();
  await runTurn({ tools: T7, engine: idleEngine, model }, s, "yes", on2);
  ok("a confirmed spend runs exactly ONCE", T7.calls.length === 1, `${T7.calls.length} calls`);
  ok("...and the model echoing it back is caught by the repeat guard, not re-proposed",
    e2.some((ev) => ev.type === "repeat" && ev.tool === "make_song")
    && !e2.some((ev) => ev.type === "proposal"));
  ok("...so nothing is left pending for a second yes to buy", s.pending === null);
}

/* ── HOLE 2b: a DIFFERENT spend after a confirm is still allowed ─────────── */
{
  const s = newSession("t_second");
  const T7 = fakeTools();
  const model = scriptedModel([
    '{"tool": "make_song", "args": {"caption": "rain"}}',
    '{"tool": "make_song", "args": {"caption": "snow"}}',
  ]);
  await runTurn({ tools: T7, engine: idleEngine, model }, s, "a rain song", () => {});
  const [e2, on2] = drain();
  await runTurn({ tools: T7, engine: idleEngine, model }, s, "yes", on2);
  ok("...but a spend with DIFFERENT arguments is still proposed rather than swallowed",
    e2.some((ev) => ev.type === "proposal") && s.pending?.args?.caption === "snow");
}

console.log("\nTHE RESUMED CONVERSATION");

/* ── HOLE 3: a resumed conversation reached the model as amnesia ─────────── */
{
  /* The exact rows server/chat/routes.js appends. Before the fix they went into
   * session.turns untranslated, and renderTranscript — which knows role "say",
   * "tool_call" and "tool_result", not role "event" — dropped every one of
   * them, leaving the model a column of PERSON lines and no answers at all.
   * The PAGE read the same rows correctly, so the picker looked like it worked
   * and only the model was left amnesiac. */
  const rows = [
    { role: "user", text: "what's in my library?", at: 1 },
    { role: "event", type: "thinking", step: 1, of: 6, at: 2 },
    { role: "event", type: "tool_call", tool: "list_library", args: {}, at: 3 },
    { role: "event", type: "tool_result", tool: "list_library", result: { count: 1 }, at: 4 },
    { role: "event", type: "say", text: "You have one track, Alpha.", at: 5 },
    { role: "event", type: "done", steps: 2, at: 6 },
  ];
  const bad = renderTranscript(rows);
  ok("the raw JSONL rows are NOT what the loop speaks — the bug, kept as evidence",
    bad === "PERSON: what's in my library?", JSON.stringify(bad));
  const good = renderTranscript(routeTurnsFromRows(rows));
  ok("translated, the resumed transcript carries the tool call", /YOU: \{"tool":"list_library"/.test(good), good);
  ok("...the tool result", /TOOL list_library RESULT: \{"count":1\}/.test(good), good);
  ok("...and the answer the person was actually given",
    /YOU: \{"say": "You have one track, Alpha\."\}/.test(good), good);
  ok("...while the progress rows are dropped rather than replayed as conversation",
    !/thinking/.test(good) && !/done/.test(good), good);
  const prop = routeTurnsFromRows([{ role: "event", type: "proposal", tool: "make_song", at: 1 }]);
  ok("...and a proposal comes back as a note that it was OFFERED, never as a spend that happened",
    prop.length === 1 && prop[0].role === "note" && /proposed make_song/.test(prop[0].text));
  const err = routeTurnsFromRows([{ role: "event", type: "tool_result", tool: "make_song", error: "no caption", at: 1 }]);
  ok("...and a tool that FAILED comes back as a failure, not as a result of undefined",
    err[0].role === "tool_error" && err[0].error === "no caption");
}

/* ══ 8. THE ARGUMENT NAMES ════════════════════════════════════════════════
 *
 * ⚠ MEASURED LIVE, 2026-09-05, run mto5ietw4b7b60, and it is the worst kind of
 * bug this file can have: the person approves one thing and pays for another.
 * Asked for a song about rain the real 4B emitted, verbatim —
 *
 *   {"tool":"make_song","args":{"caption":"Global Metadata. …",
 *    " lyrics":"[Verse] Rain falls softly…"," instrumental":true}}
 *
 * — two of the three names carrying a LEADING SPACE. The confirm box showed
 * the lyrics and the instrumental flag and they read correctly; tools.js reads
 * `a.lyrics` and `a.instrumental`, which were undefined; the song that started
 * had no lyrics and was not instrumental. Its title came back "Global
 * Metadata", because deriveTitle had no lyrics and fell back to the caption.
 */
console.log("\nTHE ARGUMENT NAMES");

{
  const T8 = fakeTools();
  const drifted = '{"tool":"make_song","args":{"caption":"Global Metadata. 70 bpm.",'
    + '" lyrics":"[Verse] Rain falls","  instrumental ":true}}';
  const r = parseReply(drifted, T8);
  ok("a name with a leading space is TRIMMED rather than silently dropped",
    r.kind === "tool" && r.args.lyrics === "[Verse] Rain falls", JSON.stringify(r.args ?? r.why));
  ok("...on every argument, not just the first",
    r.kind === "tool" && r.args.instrumental === true, JSON.stringify(r.args ?? r.why));
  ok("...and the drifted names are gone, so nothing downstream sees two spellings",
    r.kind === "tool" && !(" lyrics" in r.args) && !("  instrumental " in r.args));

  /* And a name that is not this tool's argument at all is refused BY NAME,
   * because one re-ask costs a model call and a silent drop costs a render. */
  const invented = '{"tool":"make_song","args":{"caption":"c","duration_seconds":20}}';
  const r2 = parseReply(invented, T8);
  ok("an argument this tool does not have is refused rather than dropped",
    r2.kind === "malformed", JSON.stringify(r2));
  ok("...naming the one it did not recognise", /duration_seconds/.test(r2.why || ""), r2.why);
  ok("...and listing the ones it could have used", /caption, lyrics, title, instrumental/.test(r2.why || ""), r2.why);

  const noCaption = '{"tool":"make_song","args":{"lyrics":"[Verse] rain"}}';
  const r3 = parseReply(noCaption, T8);
  ok("a REQUIRED argument left out is caught before the spend is proposed",
    r3.kind === "malformed" && /needs caption/.test(r3.why), JSON.stringify(r3));

  ok("...while a tool with no arguments at all still parses", parseReply('{"tool":"list_library"}', T8).kind === "tool");
  ok("...and an optional argument left out is fine",
    parseReply('{"tool":"list_library","args":{"limit":5}}', T8).kind === "tool");
}

/* A drifted spend must not reach the confirm box — one re-ask, and the corrected
 * reply is what gets proposed. */
{
  const s = newSession("t_drift");
  const T8 = fakeTools();
  const model = scriptedModel([
    '{"tool":"make_song","args":{"caption":"c"," lyrics":"[Verse] rain"}}',
    '{"tool":"make_song","args":{"caption":"c","lyrics":"[Verse] rain"}}',
  ]);
  const [evs, on] = drain();
  await runTurn({ tools: T8, engine: idleEngine, model }, s, "a rain song", on);
  ok("the proposal the person is shown carries the argument names the tool really reads",
    s.pending?.args?.lyrics === "[Verse] rain" && !(" lyrics" in (s.pending?.args || {})),
    JSON.stringify(s.pending));
  ok("...and nothing was run to find that out", T8.calls.length === 0);
}

/* ══ 9. A SPEND THAT RAN, REPORTED AS A FAILURE ═══════════════════════════
 *
 * ⚠ MEASURED LIVE, 2026-09-05. A confirmed make_song created job cadfcb92 and
 * the very next model call — queued on the card behind that same song — was
 * destroyed when the app's Stop button cleared the engine queue (engine run
 * mto5iphvf293e7 came back status "vanished"). The turn ended on `error`
 * alone, which reads as "the song did not start". It had started.
 */
console.log("\nA SPEND THAT RAN");

{
  const s = newSession("t_ranthenfailed");
  const T9 = fakeTools();
  let asked = 0;
  const model = async () => {
    asked++;
    if (asked === 1) return '{"tool":"make_song","args":{"caption":"c","lyrics":"[Verse] rain"}}';
    throw new Error("the prompt is in neither /history nor /queue after 14 s");
  };
  model.prompts = [];
  await runTurn({ tools: T9, engine: idleEngine, model }, s, "a rain song", () => {});
  const [evs, on] = drain();
  const r = await runTurn({ tools: T9, engine: idleEngine, model }, s, "yes", on);
  ok("the spend really did run", T9.calls.length === 1 && T9.calls[0].tool === "make_song");
  ok("...the failure of the step AFTER it is reported honestly",
    evs.some((e) => e.type === "error" && /neither \/history nor \/queue/.test(e.text)));
  ok("...but the turn says the spend HAPPENED, rather than leaving it reading as a total failure",
    evs.some((e) => e.type === "say" && /make_song already ran/.test(e.text)),
    JSON.stringify(evs.filter((e) => e.type === "say")));
  ok("...and names it in the result, so a caller knows what it is now on the hook for",
    Array.isArray(r.ran) && r.ran.includes("make_song"), JSON.stringify(r));
}

{
  /* ...and when NOTHING has run yet, there is nothing to claim. */
  const s = newSession("t_failedcold");
  const T9 = fakeTools();
  const model = async () => { throw new Error("the engine could not be reached"); };
  const [evs, on] = drain();
  await runTurn({ tools: T9, engine: idleEngine, model }, s, "hello", on);
  ok("a turn that failed before running anything claims nothing",
    !evs.some((e) => e.type === "say") && evs.some((e) => e.type === "error"),
    JSON.stringify(evs.map((e) => e.type)));
}

/* ══ 10. IT ANNOUNCED WORK IT NEVER DID ═══════════════════════════════════
 *
 * ⚠ MEASURED, on the owner's own screen. They asked for an image. The model
 * replied, verbatim:
 *
 *   Sure! Let me create the brainrot image for you.
 *
 * No tool was called — there is no image tool in this list, so none COULD be —
 * and the turn ended there. Nothing failed, nothing logged, nothing spun. The
 * person was left watching a panel that was never going to change, and from
 * where they sat it looked exactly like a thing that was working.
 *
 * What is pinned here is the CLASS, not the sentence: a reply that points at an
 * action, in a turn where no tool ran, must not be delivered as a finished turn
 * on its own. And the three things the guard must NOT do — cost more than one
 * extra model call, slow an ordinary answer, or mangle an honest refusal — are
 * measured rather than asserted, because a guard that quietly taxes every turn
 * is a worse bug than the one it fixes.
 */
console.log("\nIT ANNOUNCED WORK IT NEVER DID");

{
  /* THE MEASURED SENTENCE, inside the protocol's own shape, twice: the model
   * announces, is re-asked, and announces again. This is the FLOOR — no further
   * model call can save it, so the truth is attached to what it said. */
  const tools = fakeTools();
  const s = newSession("t_promise");
  const model = scriptedModel([
    '{"say":"Sure! Let me create the brainrot image for you."}',
    '{"say":"Sure! Let me create the brainrot image for you."}',
  ]);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "make me a brainrot image", emit);

  ok("a reply that promises and calls nothing does NOT end the turn silently",
    out.unstarted === true, JSON.stringify(out));
  ok("...the person is told, IN PLAIN WORDS, that nothing was started", (() => {
    const said = evs.find((e) => e.type === "say");
    return said && /Nothing has actually started/.test(said.text)
      && /no file is being made/.test(said.text) && /nothing to wait for/.test(said.text);
  })(), JSON.stringify(evs.find((e) => e.type === "say")?.text));
  ok("...in the SAME turn, before it closes", (() => {
    const types = evs.map((e) => e.type);
    return types.indexOf("say") >= 0 && types.indexOf("say") < types.lastIndexOf("done");
  })(), evs.map((e) => e.type).join(","));
  ok("...and what the model actually said is kept, not thrown away",
    /brainrot image/.test(evs.find((e) => e.type === "say")?.text || ""));
  ok("...and the transcript carries the honest version, so a resumed session cannot re-read the promise alone",
    s.turns.some((t) => t.role === "say" && /Nothing has actually started/.test(t.text)));
  ok("A FALSE PROMISE COSTS EXACTLY ONE EXTRA MODEL CALL — never two, on a shared card",
    model.prompts.length === 2, `${model.prompts.length} model calls`);
  ok("...and the re-ask names the tools and demands a call or an admission", (() => {
    const p = model.prompts[1];
    return /ABOUT TO DO something/.test(p) && /make_song/.test(p) && /mv_control_check/.test(p)
      && /says plainly you are not doing it/.test(p);
  })());
  ok("...and the re-ask is visible rather than a silent pause",
    evs.some((e) => e.type === "promise"));
  ok("...and nothing was run, which is the point", tools.calls.length === 0);
}

{
  /* THE SAME PROMISE IN PROSE — the shape the screen actually showed, with no
   * JSON in it anywhere. It lands in the MALFORMED path, not the say path, so
   * it is a second route to the same silence and it is pinned separately.
   * Before this, its whole answer was "I could not form a tool call" — jargon,
   * and after a promise it reads like a tool that tried and failed rather than
   * like a thing that was never started. */
  const tools = fakeTools();
  const s = newSession("t_promise_prose");
  const model = scriptedModel([
    "Sure! Let me create the brainrot image for you.",
    "Sure! Let me create the brainrot image for you.",
  ]);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "make me a brainrot image", emit);
  ok("a PROSE promise with no JSON in it is caught by the same rule",
    out.unstarted === true && evs.some((e) => e.type === "promise"), JSON.stringify(out));
  ok("...and the person is told nothing was started, not just that the parse failed",
    evs.some((e) => e.type === "say" && e.text.includes(NOTHING_STARTED)),
    JSON.stringify(evs.find((e) => e.type === "say")?.text));
  ok("...still for exactly one extra model call", model.prompts.length === 2,
    `${model.prompts.length} model calls`);
  ok("...and that one re-ask was the POINTED one, not the syntax one",
    /ABOUT TO DO something/.test(model.prompts[1]) && /make_image/.test(model.prompts[1]));
}

{
  /* ...while a reply that is merely UNPARSEABLE, promising nothing, keeps the
   * plain syntax re-ask it always had. The guard must not colonise the path it
   * shares. */
  const tools = fakeTools();
  const s = newSession("t_prose_nopromise");
  const model = scriptedModel(["nope", "still nope"]);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "hello", emit);
  ok("garbage that promised nothing gets the syntax re-ask, unchanged",
    evs.some((e) => e.type === "reask") && !evs.some((e) => e.type === "promise"));
  ok("...and its sentence is not padded with a truth it does not need",
    evs.some((e) => e.type === "say" && e.text === "I could not form a tool call."),
    JSON.stringify(evs.find((e) => e.type === "say")?.text));
}

{
  /* THE RECOVERY, which is the outcome worth having: the re-ask turns the
   * promise into the call it was promising. Nobody needs to be told anything
   * then, because the thing happened. */
  const tools = fakeTools();
  const s = newSession("t_promise_ok");
  const model = scriptedModel([
    "Let me look that up for you.",
    '{"tool":"list_library","args":{}}',
    '{"say":"You have three tracks."}',
  ]);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "what have I got", emit);
  ok("a promise that becomes a REAL TOOL CALL on the re-ask is served, not scolded",
    tools.calls.length === 1 && tools.calls[0].tool === "list_library", JSON.stringify(tools.calls));
  ok("...and the answer is the model's own, with nothing appended to it",
    out.said === "You have three tracks." && !/Nothing has actually started/.test(out.said || ""),
    JSON.stringify(out.said));
  ok("...and the person was never told nothing started, because something did",
    !evs.some((e) => e.type === "say" && /Nothing has actually started/.test(e.text)));
}

{
  /* NOT SLOWED, NOT MANGLED — measured on the two ordinary shapes. A greeting
   * is one model call and comes back byte-identical. */
  const tools = fakeTools();
  const s = newSession("t_hello");
  const model = scriptedModel(['{"say":"Hello. I can make songs and music videos on this machine — what would you like?"}']);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "hello", emit);
  ok("A PLAIN GREETING IS ONE MODEL CALL, exactly as before the guard",
    model.prompts.length === 1, `${model.prompts.length} model calls`);
  ok("...and passes through byte-identical",
    out.said === "Hello. I can make songs and music videos on this machine — what would you like?",
    JSON.stringify(out.said));
  ok("...with no promise event anywhere near it", !evs.some((e) => e.type === "promise"));
}

{
  /* ...and the real two-step answer, which is the shape most turns have. */
  const tools = fakeTools();
  const s = newSession("t_library_speed");
  const model = scriptedModel([
    '{"tool":"list_library","args":{}}',
    '{"say":"Here are the songs already finished on this machine, newest first: PRISM (181 seconds)."}',
  ]);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "what is in my library", emit);
  ok("'WHAT IS IN MY LIBRARY' IS STILL TWO MODEL CALLS — the guard taxes nothing",
    model.prompts.length === 2, `${model.prompts.length} model calls`);
  ok("...and the answer is untouched", /PRISM \(181 seconds\)\.$/.test(out.said || ""), JSON.stringify(out.said));
  ok("...and no honesty sentence was appended to a turn where a tool really ran",
    !/Nothing has actually started/.test(out.said || ""));
}

{
  /* THE HONEST REFUSAL. This is the answer the guard is trying to produce, so
   * it must not be the answer the guard mangles. */
  const tools = fakeTools();
  const s = newSession("t_cannot");
  const model = scriptedModel(['{"say":"I cannot make images on this machine. There is no image tool here — I can make songs and block camera moves."}']);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "make me an image", emit);
  ok("A REPLY THAT SAYS IT CANNOT is honest and passes through untouched",
    out.said === "I cannot make images on this machine. There is no image tool here — I can make songs and block camera moves.",
    JSON.stringify(out.said));
  ok("...in one model call, unslowed", model.prompts.length === 1, `${model.prompts.length} model calls`);
  ok("...and with no promise event", !evs.some((e) => e.type === "promise"));
}

{
  /* THE RULE IS `called.size === 0`, NOT THE WORDS. A promise made AFTER a tool
   * has run is not this failure — the call, its result and its cost are all on
   * the transcript in front of the person — and the confirm path seeds the set
   * with the spend it just made, so it is covered by the same one line. */
  const tools = fakeTools();
  const s = newSession("t_after_confirm");
  await runTurn({ tools, engine: idleEngine, model: scriptedModel(['{"tool":"make_song","args":{"caption":"c"}}']) },
    s, "a song", () => {});
  const model = scriptedModel(['{"say":"Your song is rendering now. I will tell you when it lands."}']);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "yes", emit);
  ok("a turn in which a spend REALLY RAN is not re-asked, whatever its words point at",
    model.prompts.length === 1 && !evs.some((e) => e.type === "promise"),
    `${model.prompts.length} model calls`);
  ok("...and its sentence is delivered as written",
    out.said === "Your song is rendering now. I will tell you when it lands.", JSON.stringify(out.said));
  ok("...having actually run the song", tools.calls.length === 1 && tools.calls[0].tool === "make_song");
}

{
  /* THE COST OF BEING WRONG, measured on the false positive above. A clarifying
   * question that happens to contain "and I will use it" buys ONE re-ask, and
   * the model's second answer is delivered as written. That is the ceiling on
   * what this guard can do to a conversation it misread. */
  const tools = fakeTools();
  const s = newSession("t_falsepos");
  const model = scriptedModel([
    '{"say":"You have three tracks. Let me know which of those you want and I will use it."}',
    '{"say":"You have three tracks — PRISM, Felt Hammers and The Boa. Which one?"}',
  ]);
  const [evs, emit] = drain();
  const out = await runTurn({ tools, engine: idleEngine, model }, s, "what have I got", emit);
  ok("a misread question costs ONE model call and no more",
    model.prompts.length === 2, `${model.prompts.length} model calls`);
  ok("...and the answer that follows is delivered exactly as written, with nothing appended",
    out.said === "You have three tracks — PRISM, Felt Hammers and The Boa. Which one?",
    JSON.stringify(out.said));
}

/* The cues themselves. They are CUES rather than a rule — see loop.js — so what
 * is worth pinning is the two exclusions, both of which are common English that
 * is NOT a promise, and the fallback direction. */
ok("the measured sentence is recognised", announcesAction("Sure! Let me create the brainrot image for you."));
ok("...and the other shapes of the same promise",
  ["I'll get that going.", "I will start it now.", "One moment.", "Working on it.",
    "I'm going to render that.", "Generating your song now.", "Stand by."].every(announcesAction));
ok('"LET ME KNOW …" IS A QUESTION, NOT A PROMISE — the exclusion earns its place',
  !announcesAction("Let me know which of those you want.")
  && !announcesAction("Let me know if that is the one."), "…and it is asked constantly");
/* THE KNOWN FALSE POSITIVE, written down rather than papered over. A cue list
 * is not a parser: "…and I will use it" is a CONDITIONAL future, not a promise
 * that something is already happening, and this catches it. It is kept because
 * the cost is bounded — one model call — and because the sentence the guard can
 * append is TRUE either way. That is the direction of error the design chose;
 * the opposite error leaves somebody watching a screen forever. */
ok("a CONDITIONAL future is caught too, which is the accepted direction of being wrong",
  announcesAction("Let me know which of those you want and I will use it."),
  "the guard may add a clumsy sentence; it can never add a lie, because no tool ran");
ok('"I WILL NOT …" is the honest refusal this guard exists to produce, so it is not caught by it',
  !announcesAction("I will not be able to do that here.") && !announcesAction("I'll never be able to make video on this."));
ok("an ordinary answer carries no cue at all",
  !announcesAction("You have three tracks: PRISM, Felt Hammers and The Boa.")
  && !announcesAction("Hello. What would you like to make?")
  && !announcesAction("That job finished nine seconds ago."));

/* The prompt is the layer BEFORE the guard: a model that never makes the
 * promise needs no catching, and it costs nothing per turn. */
ok("the system prompt forbids announcing an action in the same breath as not taking it",
  /NEVER SAY YOU ARE ABOUT TO DO SOMETHING/.test(SYS) && /let me…/.test(SYS)
  && /ENDS THE TURN/.test(SYS), "prevention is cheaper than any guard");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
