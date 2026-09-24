/**
 * CHAT v1 — THE AGENT LOOP.
 *
 * "A chat panel as the first menu option, where you can just chat to it like
 *  with Claude, to make videos/music."
 *
 * ── WHAT IS ACTUALLY BEHIND IT ────────────────────────────────────────────
 *
 * qwen_3_4b.safetensors — already on this disk as FLUX.2's text encoder, 8.7 GB
 * — run through ComfyUI's TextGenerate node, which this app reaches ONLY
 * through server/engine/client.js. That is the whole model. There is no API key
 * in this path and nothing leaves the machine.
 *
 * Everything below is written around what a 4B can and cannot do, and both
 * halves were MEASURED on this rig rather than assumed:
 *
 *  - It answers FLAT JSON reliably. NESTED JSON it cannot do (server/mv/
 *    sfxcue.js, the sfx judge, which is the proven primitive this file copies).
 *    So the protocol is one object, one level of `args`, scalars only, and the
 *    parser ALSO accepts the fully-flat shape a small model drifts into.
 *  - Greedy, single shot. `sampling_mode: "off"` — the same setting the judge
 *    uses. A sampled 4B inventing a different tool name on a re-ask is a worse
 *    failure than a deterministic one that is wrong the same way twice, because
 *    the second can be tested.
 *  - `thinking` is available on the node (comfy_extras/nodes_textgen.py) and is
 *    OFF here. Thinking tokens count against `max_length` and this loop's whole
 *    output budget is one small JSON object; a model that spends 400 tokens
 *    reasoning and then runs out mid-brace has produced nothing at all.
 *  - `use_default_template` is left at its default TRUE, so Qwen's own chat
 *    template wraps the prompt. The judge in sfxcue.js does the same and its
 *    accuracy was measured that way.
 *
 * ── CONFIRM BEFORE SPEND ──────────────────────────────────────────────────
 *
 * This is the repo's plan-then-approve principle in miniature. A tool marked
 * `spends` is NEVER called in the turn it is proposed. The loop stops, returns
 * a proposal carrying the exact arguments and the cost sentence, and waits. The
 * NEXT user message either confirms it — and the loop runs the proposal it
 * already holds, with no second model call, so the model cannot quietly change
 * the arguments between the plan and the approval — or does not, and the
 * proposal is dropped.
 *
 * There is exactly one gate and it lives here, not in the page. A page-side
 * confirm button is a decoration; this is the thing that actually stops the
 * spend.
 *
 * ── THE BUSY CASE ─────────────────────────────────────────────────────────
 *
 * One 16 GB card is shared between this chat and every render in the app. A
 * chat turn silently queued behind a 32-minute VACE pass looks exactly like a
 * chat that has hung. So the door's own status is read BEFORE the model is
 * asked anything, and a busy engine ends the turn with a sentence saying so
 * rather than joining the queue.
 *
 * ── NOTHING IS ANNOUNCED THAT IS NOT DONE ─────────────────────────────────
 *
 * Measured on the owner's screen: asked for an image, the model said "Sure! Let
 * me create the brainrot image for you", called no tool, and the turn ended.
 * A person watching that has no way to tell it apart from a thing that is
 * working, and it will never finish.
 *
 * Three layers, cheapest first: the system prompt forbids the promise outright
 * (a model that never makes it needs no guard); a `say` that points at an
 * action IN A TURN WHERE NOTHING RAN buys ONE re-ask naming the tools and
 * demanding a call or an admission; and if it announces again the sentence is
 * delivered WITH the truth attached rather than alone. See announcesAction()
 * for which half of that is a rule and which half is a cue.
 */
import { engine as defaultEngine } from "../engine/client.js";
import { CHAT_ACTOR } from "./tools.js";
import { LYRIC_RULES } from "../lyric-style.js";

/** How many model calls one user message may cost. */
export const MAX_STEPS = 6;
/** The judge in sfxcue.js asks for 80; a tool call with a caption in it needs
 *  far more, and TextGenerate's own ceiling is 32768. */
export const MAX_LENGTH = 700;
/** Two of these are the whole budget for one user message going wrong. */
export const MAX_MALFORMED = 1;

/** Words that mean "yes, spend it". Deliberately a closed list: a 4B asked to
 *  classify consent is a second place for the gate to be wrong. */
const CONFIRM_RE =
  /^\s*(y|yes|yeah|yep|yup|ok|okay|sure|go|go ahead|do it|run it|make it|please do|confirm|confirmed|approved?)\b[\s.!,]*$/i;
/** ...and the ones that mean "no". Anything else is simply a new message. */
const DECLINE_RE = /^\s*(n|no|nope|cancel|stop|don'?t|nevermind|never mind|not now)\b[\s.!,]*$/i;

/* ── the prompt ──────────────────────────────────────────────────────────── */

/**
 * One tool, rendered for a 4B.
 *
 * The argument list is written as `name (type, required)` on its own line
 * rather than as a JSON Schema. A schema is a nested object, and putting one in
 * front of a model that cannot emit nested objects teaches it exactly the wrong
 * shape — the failure mode is the model echoing the schema back as its answer.
 */
/** What the tool's own headline says it will cost.
 *
 *  `spends` is really "this one asks the person first", and until the router
 *  arrived every tool that asked did so because it holds the graphics card. A
 *  routed tool can ask for the other reason: it removes work that exists. Both
 *  stop the turn on a confirm card, so both set `spends`, but labelling a
 *  delete as GPU TIME would put a false sentence in front of the model and,
 *  through the card, in front of the person. Tools with no `gate` — which is
 *  the eight written ones — read exactly as they did before. */
export const gateLabel = (t) => {
  if (t.gate === "destroys") return "   [REMOVES WORK — ASKS YOU FIRST]";
  /* Measured: two image tools hold the card. The rest write a file with numpy,
   * and telling the model they SPEND GPU TIME put a false sentence in front of
   * it and, through the confirm card, in front of the person. */
  if (t.gate === "writes") return `   [${t.gateWords || "WRITES A FILE"} — ASKS YOU FIRST]`;
  return t.spends ? "   [SPENDS GPU TIME]" : "";
};

export function describeTool(t) {
  const args = Object.entries(t.args || {}).map(([k, v]) =>
    `    ${k} (${v.type}${v.required ? ", REQUIRED" : ""})${v.note ? ` — ${v.note}` : ""}`);
  return [
    `TOOL ${t.name}${gateLabel(t)}`,
    ...String(t.description).split("\n").map((l) => `  ${l}`),
    args.length ? "  arguments:" : "  arguments: none",
    ...args,
  ].join("\n");
}

/** `tools` is either the registry createChatTools() returns or the bare array;
 *  taking both is what lets buildPrompt hand the registry straight through
 *  while a test can render one list on its own. */
export function systemPrompt(tools, intro = null, { autoSpend = false } = {}) {
  const list = Array.isArray(tools) ? tools : tools.all;
  return [
    /* `intro` replaces the opening for a narrower assistant — the Music
     * panel's Simple mode (server/chat/music-tools.js). */
    ...(intro ? intro : [
      "You are the assistant inside AIPLAY Studio, a music and video studio that runs entirely on this",
      "person's own computer. You help them make songs and music videos by calling the tools below.",
      "",
      ...LYRIC_RULES,
    ]),
    "",
    "HOW YOU REPLY. Every reply is ONE JSON object and nothing else. No explanation around it, no",
    "markdown, no code fence. There are exactly two shapes and no third:",
    "",
    '  {"tool": "<tool name>", "args": {"<name>": "<value>", ...}}',
    '  {"say": "<what you want to tell the person>"}',
    "",
    "Every value inside args is a plain string, whole number or true/false. Never put an object or a",
    "list inside args. Never invent a tool name that is not in the list. Never call two tools in one",
    "reply — call one, read the result, then decide again.",
    "",
    'Use {"say": ...} when you are answering, asking a question, or reporting what a tool told you.',
    "",
    "NEVER SAY YOU ARE ABOUT TO DO SOMETHING. You cannot do anything at all except by calling a tool,",
    'and a {"say": ...} reply ENDS THE TURN — the person reads your words and then nothing happens.',
    'So never write "let me…", "I\'ll…", "one moment" or "working on it". If the thing they asked for',
    "is one of the tools, CALL IT IN THIS REPLY. If it is not one of the tools, say plainly that you",
    "cannot do it and what you can do instead. Promising and then stopping is the worst answer you can",
    "give, because from where they are sitting it looks exactly like the thing is happening.",
    "",
    /* ⚠ MEASURED AGAINST THE REAL 4B, 2026-09-07, four requests for things no
     * tool covers. The paragraph above WORKS — not one answer said "let me" or
     * "I'll", which is what it was written to stop. What came back instead was
     * the same failure wearing different clothes, in all four:
     *
     *   "I can help you post your song to Instagram. First, I need to know the
     *    name of your song and the caption you want to use."
     *   "I cannot email the poem directly, but I can write a poem about your
     *    library and save it as a file. Would you like me to do that?"
     *   "I cannot translate lyrics directly. However, I can help you by calling
     *    the appropriate tools to achieve this."
     *
     * There is no Instagram tool, no file-writing tool and no translate tool.
     * The first two invite the person to go and fetch a caption, or to answer
     * "yes please", for a thing that is never going to happen — which costs
     * them more than a flat refusal, not less, because they now do work for it.
     * The third is the plainest lie the panel can tell: it names tools that do
     * not exist as the reason to be hopeful.
     *
     * announcesAction()'s eight cues match NONE of these three, and that is not
     * a hole to be plugged with a ninth regex: "I can help you create music and
     * videos using the tools available" is the SAME shape and is perfectly
     * true, so no pattern over the words can separate them. The thing that
     * separates them is whether the verb is in the tool list, which the model
     * knows and a regex does not. So the fix belongs here, where it is free and
     * where the paragraph above already proved this model does what this
     * section tells it. */
    "AND NEVER SAY YOU CAN DO A THING THAT IS NOT ONE OF THE TOOLS. Not \"I can help you…\", not",
    '"I am able to…", not "I can do that if you tell me…". Before you offer, find the tool that would',
    "do it. If there is no such tool, then you cannot do it — not now and not after they answer a",
    "question, so do not ask them one. Say the words \"I cannot\", say what would be needed, and name",
    "the things on the list you CAN do. Asking someone for details you will never use is worse than",
    "refusing, because they go away and fetch them.",
    "",
    "WHEN A TOOL RESULT COMES BACK, THAT TOOL HAS ALREADY ANSWERED. Your next reply must be",
    '{"say": "..."} putting the result into plain words. Never call the same tool twice while',
    "answering one question — the answer will be identical and the person is still waiting.",
    "",
    ...(autoSpend ? [
      "A tool marked [SPENDS GPU TIME] RUNS AS SOON AS YOU CALL IT. The person sees a warning that the",
      "graphics card is in use, with a Cancel button. When they have asked for the thing, call it; do not",
      "ask their permission and do not tell them to press a button yourself. (A tool that deletes",
      "something still asks them first.)",
    ] : [
      "A tool marked [SPENDS GPU TIME] will not run straight away. The person is asked to confirm first.",
      "Propose it normally when it is the right thing to do; do not ask their permission yourself.",
    ]),
    "",
    "THE TOOLS:",
    "",
    list.map(describeTool).join("\n\n"),
  ].join("\n");
}

/**
 * How much of one tool result goes in front of the model.
 *
 * ⚠ MEASURED, and it was 900. Live on 2026-09-05 the answer to "what's in my
 * library?" came back ending mid-word — "…8. Felt Hammers (128 seconds) - has
 * cover art and lyrics\n9. The Boa" — and the model was not truncating
 * anything. `list_library`'s ten rows are about 1100 characters of JSON, the
 * transcript cut them at 900, and the model faithfully reproduced its input up
 * to exactly where that cut fell. A silent truncation reads to a model as the
 * end of the data, so the fix is BOTH halves: a budget big enough for a normal
 * result, and a marker when it is exceeded so the model can say the list was
 * cut instead of implying the library ends there.
 */
export const RESULT_BUDGET = 2400;

/** The conversation so far, compact enough for a 4B's context. */
export function renderTranscript(turns, limit = 12) {
  const recent = turns.slice(-limit);
  return recent.map((t) => {
    if (t.role === "user") return `PERSON: ${t.text}`;
    if (t.role === "say") return `YOU: {"say": ${JSON.stringify(t.text)}}`;
    if (t.role === "tool_call") return `YOU: ${JSON.stringify({ tool: t.tool, args: t.args })}`;
    if (t.role === "tool_result") {
      const whole = JSON.stringify(t.result);
      const body = whole.length <= RESULT_BUDGET ? whole
        : `${whole.slice(0, RESULT_BUDGET)}  …[CUT — this result was ${whole.length} characters and `
          + `only the first ${RESULT_BUDGET} are shown. Say the list is longer rather than ending it here.]`;
      return `TOOL ${t.tool} RESULT: ${body}`;
    }
    if (t.role === "tool_error") return `TOOL ${t.tool} FAILED: ${String(t.error).slice(0, 300)}`;
    if (t.role === "note") return `NOTE: ${t.text}`;
    return "";
  }).filter(Boolean).join("\n");
}

export function buildPrompt(tools, turns, correction = null, { intro = null, context = null, autoSpend = false } = {}) {
  return [
    systemPrompt(tools, intro, { autoSpend }),
    "",
    "THE CONVERSATION SO FAR:",
    renderTranscript(turns),
    "",
    /* What the page looks like right now (Simple mode sends the Music form).
     * Not stored in the turns: it is re-read with every message. */
    ...(context ? ["WHAT IS ON THE SCREEN RIGHT NOW:", context, ""] : []),
    ...(correction ? [`THAT LAST REPLY WAS NOT USABLE: ${correction}`, ""] : []),
    "Reply now with ONE JSON object and nothing else.",
  ].join("\n");
}

/* ── reading the model back ──────────────────────────────────────────────── */

/**
 * The first balanced JSON object in a blob of text.
 *
 * sfxcue.js gets away with `/\{[^}]*\}/` because its judge answers a single
 * flat object with no braces inside. This protocol has `args` nested one level,
 * so that regex would stop at the inner `}` and hand back a broken string. This
 * counts braces and skips over string literals, which is the only way to be
 * right about `{"say": "use {curly} braces"}`.
 */
export function allJsonObjects(raw) {
  const s = String(raw ?? "");
  const out = [];
  let start = -1, depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) { out.push(s.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

export function firstJsonObject(raw) {
  return allJsonObjects(raw)[0] ?? null;
}

/** Everything that is not `tool` or `say` — the flattened-shape argument read. */
function flatten(obj) {
  const args = {};
  for (const [k, v] of Object.entries(obj)) if (k !== "tool" && k !== "say") args[k] = v;
  return args;
}

/** One call, identified by what it would DO — the name and the arguments. Two
 *  calls with the same key cannot produce two different answers. */
export const callKey = (name, args) => `${name}|${JSON.stringify(args ?? {})}`;

/**
 * Turn one model reply into a decision.
 *
 * Returns {kind: "say"|"tool"|"malformed", ...}. The two SHAPES it accepts are
 * deliberate rather than lenient:
 *
 *   {"tool": "x", "args": {...}}   the protocol
 *   {"tool": "x", "caption": "…"}  the same thing FLATTENED
 *
 * The second is what a 4B produces when it half-remembers the instruction, and
 * it is unambiguous — every key that is not `tool` or `say` is an argument. A
 * re-ask that would have recovered it anyway costs a whole extra model call on
 * a shared card, so it is read rather than refused. What is NOT accepted is a
 * tool name that does not exist: guessing which of six was meant is how a chat
 * spends money on the wrong thing.
 */
export function parseReply(raw, tools, { called = new Set() } = {}) {
  const objects = allJsonObjects(raw);
  if (!objects.length) return { kind: "malformed", why: "there was no JSON object in it at all", raw };

  /* ── TWO OBJECTS IN ONE REPLY, AND WHICH ONE IS THE ANSWER ───────────────
   *
   * MEASURED, live, 2026-09-05, run mto44nad44ca37: asked "what's in my
   * library?" the model called list_library, read the result, and then emitted
   * BOTH the call again AND its answer, on two lines:
   *
   *   {"tool":"list_library","args":{}}
   *   {"say": "Here are the songs already finished on this machine, …"}
   *
   * Taking the first object — which is what a first-object rule does — threw
   * the answer away and re-ran the tool, and the turn spent all six steps
   * doing that. The answer was sitting in the same reply the whole time.
   *
   * So: when a reply carries several objects and one of them is a `say`, the
   * `say` wins IF a tool call in the same reply is one this turn has already
   * run. The condition is the load-bearing half — without it a model that
   * writes "here is what I will do" before its first real call would have that
   * call skipped, which is the opposite failure. */
  let text = objects[0];
  if (objects.length > 1) {
    const parsed = objects.map((t) => { try { return JSON.parse(t); } catch { return null; } });
    const repeats = parsed.some((o) => o && typeof o.tool === "string"
      && called.has(callKey(o.tool, o.args ?? flatten(o))));
    const sayAt = parsed.findIndex((o) => o && typeof o.say === "string");
    if (repeats && sayAt >= 0) text = objects[sayAt];
  }

  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { kind: "malformed", why: `the JSON did not parse (${e.message})`, raw }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { kind: "malformed", why: "it was not a JSON object", raw };
  }

  if (typeof obj.say === "string" && !obj.tool) return { kind: "say", text: obj.say };

  if (typeof obj.tool === "string") {
    const tool = tools.get(obj.tool.trim());
    if (!tool) {
      return {
        kind: "malformed",
        why: `there is no tool called "${String(obj.tool).slice(0, 40)}". The tools are: ${tools.names.join(", ")}`,
        raw,
      };
    }
    /* THE FLATTENED SHAPE. Everything that is not `tool` or `say` is an
     * argument, which is exactly what the model meant. Measured live: the very
     * first real reply was `{"tool": "list_library"}` with no `args` key at
     * all, which this branch reads as the no-argument call it is. */
    const args = obj.args === undefined || obj.args === null ? flatten(obj) : obj.args;
    if (typeof args !== "object" || Array.isArray(args)) {
      return { kind: "malformed", why: "args must be a flat object of plain values", raw };
    }
    /* A nested value inside args is the measured failure. Refuse it by name
     * rather than passing an [object Object] down into a tool. */
    for (const [k, v] of Object.entries(args)) {
      if (v !== null && (typeof v === "object")) {
        return { kind: "malformed", why: `args.${k} was an object or a list — every argument must be a plain value`, raw };
      }
    }

    /* ── THE ARGUMENT NAMES, TRIMMED AND THEN CHECKED BY NAME ─────────────
     *
     * ⚠ MEASURED LIVE, 2026-09-05, run mto5ietw4b7b60. Asked for a song about
     * rain the model emitted, verbatim:
     *
     *   {"tool":"make_song","args":{"caption":"Global Metadata. …",
     *    " lyrics":"[Verse] Rain falls softly…"," instrumental":true}}
     *
     * Two of the three argument names carry a LEADING SPACE. `a.lyrics` and
     * `a.instrumental` inside tools.js are therefore undefined, and nothing
     * anywhere said so: the proposal shown to the person listed the lyrics and
     * the instrumental flag, they read correctly, and make_song would have
     * rendered a song with NO lyrics and WITH vocals — the opposite of what the
     * confirm box promised. The job it did create came back titled "Global
     * Metadata", because deriveTitle had no lyrics to work from and fell back
     * to the first words of the caption. That title is the fingerprint.
     *
     * A dropped argument in front of a confirm button is the worst failure in
     * this file: the person approves one thing and pays for another. So the
     * names are trimmed — which recovers this exact drift for free — and what
     * is STILL not an argument of this tool is refused BY NAME, because a
     * re-ask costs one model call and a silent drop costs a render.
     */
    const clean = {};
    for (const [k, v] of Object.entries(args)) clean[String(k).trim()] = v;
    const known = Object.keys(tool.args || {});
    const unknown = Object.keys(clean).filter((k) => !known.includes(k));
    if (unknown.length) {
      return {
        kind: "malformed",
        why: `${tool.name} has no argument called "${unknown[0].slice(0, 40)}". Its arguments are: `
          + `${known.join(", ")}. Use those names exactly, with no spaces around them.`,
        raw,
      };
    }
    const missing = known.filter((k) => tool.args[k].required
      && (clean[k] === undefined || clean[k] === null || String(clean[k]).trim() === ""));
    if (missing.length) {
      return {
        kind: "malformed",
        why: `${tool.name} needs ${missing.join(" and ")}, and that reply left `
          + `${missing.length > 1 ? "them" : "it"} out.`,
        raw,
      };
    }
    return { kind: "tool", tool, args: clean };
  }

  return { kind: "malformed", why: 'it had neither a "tool" key nor a "say" key', raw };
}

/* ── a reply that announces an action and takes none ─────────────────────── */

/**
 * ⚠ MEASURED, from the owner's own screen. They asked for an image. The model
 * replied "Sure! Let me create the brainrot image for you." It called NO TOOL —
 * there is no image tool in this list, so it could not have — and the turn ended
 * there, silently. The person was left watching a panel that was never going to
 * change. That is the worst failure this loop has, because it is indistinguish-
 * able from working: there is no error, no spinner that stops, nothing to
 * report. A person told plainly "I cannot do that" is better served in every
 * respect than a person told "one moment" by something that has already stopped.
 *
 * ── WHERE THE RULE IS AND WHERE THE GUESS IS ──────────────────────────────
 *
 * The RULE is structural and it lives in the caller: NO TOOL RAN IN THIS TURN.
 * That is a fact, not an opinion, and it is what makes the announcement a lie.
 * This function only answers the softer half — does the sentence point at an
 * action about to happen — and there is no test for that which is a rule. The
 * patterns below are CUES. They are English only, there are eight of them, and
 * they will miss a promise phrased some other way.
 *
 * WHICH WAY EACH HALF IS ALLOWED TO BE WRONG is the whole of the design:
 *
 *   a MISSED promise is delivered exactly as it is delivered today, so this
 *   guard can only improve on the current behaviour and never worsen it;
 *
 *   a FALSE POSITIVE appends a sentence that is TRUE ANYWAY — no tool ran in
 *   that turn — so the guard can add a clumsy sentence but cannot add a lie.
 *
 * So "unsure" resolves towards telling the person nothing started, which is the
 * direction that cannot hurt them.
 *
 * Two exclusions earn their place because both are common and neither is a
 * promise: "let me KNOW …" is a question, and "I will NOT / I'll NEVER …" is the
 * honest refusal this whole guard exists to encourage.
 */
export const ANNOUNCEMENT_CUES = [
  /\bi['’]ll(?!\s+(?:not|never)\b)/i,
  /\bi will(?!\s+(?:not|never)\b)/i,
  /\bi(?:['’]m| am) going to\b/i,
  /\blet me(?!\s+know\b)\b/i,
  /\b(?:one moment|hold on|just a (?:moment|second|sec))\b/i,
  /\bworking on (?:it|that|this)\b/i,
  /\b(?:creating|generating|starting|making|rendering|building) (?:it|that|this|the|your|a|an)\b/i,
  /\bstand by\b/i,
];

/** True when the words point at an action about to happen. A CUE, not a rule —
 *  see the block above for what is structural and what is a guess. */
export function announcesAction(text) {
  const s = String(text ?? "");
  return ANNOUNCEMENT_CUES.some((re) => re.test(s));
}

/**
 * What the person is told when the announcement stands anyway.
 *
 * Written to be readable by somebody who does not know what a tool is: the only
 * thing they need out of it is that the screen is not going to change on its
 * own. It is appended rather than substituted because the model's own sentence
 * may carry a real intention worth keeping — what it must not carry is silence
 * after it.
 */
export const NOTHING_STARTED =
  "Nothing has actually started, though. I did not run anything this turn, so no song, no video and "
  + "no file is being made and there is nothing to wait for. Ask me again if you want me to try, and "
  + "I will either run a tool or tell you plainly that I cannot.";

/** The one re-ask. Pointed on purpose: it names the tools, and it offers the
 *  admission as an equally good answer, because for a thing this chat genuinely
 *  cannot do — emailing a poem, posting to Instagram, translating lyrics, all
 *  of them measured against the real model — the admission is the only true
 *  answer there is. (The example here used to be "an image, on a list with no
 *  image tool". It was true when it was written and make_image made it false;
 *  an example that has quietly become wrong teaches the next reader the
 *  opposite of the lesson, so it is replaced rather than softened.) */
export const promiseCorrection = (tools) =>
  "That reply said you were ABOUT TO DO something and it called no tool, so nothing happened at all "
  + "and the person is now watching a screen that will never change. Do it or refuse it, in THIS "
  + `reply. The tools are: ${(Array.isArray(tools) ? tools : tools.names).join(", ")}. Either `
  + '{"tool": "<one of those>", "args": {...}} and it runs, or {"say": "..."} that says plainly you '
  + "are not doing it and why. Do not announce it a second time.";

/* ── the model ───────────────────────────────────────────────────────────── */

/**
 * ONE model call, through the engine door.
 *
 * The graph is sfxcue.js's askQwen verbatim in shape: CLIPLoader on
 * qwen_3_4b.safetensors as a flux2 text encoder, TextGenerate, PreviewAny. It
 * writes NO FILE, and it goes through the door anyway — there is nothing to
 * adopt and nothing to hash, and what the ledger carries instead is the
 * question, the model file that answered it, and how long the 8.7 GB model
 * took. A chat panel is going to run this hundreds of times.
 */
export function createQwenModel({ engine = defaultEngine, maxLength = MAX_LENGTH, resolve = null, cloud = null } = {}) {
  async function ask(prompt, { label = "chat turn" } = {}) {
    /* Which file answers is the user's choice (server/chat/models.js); with no
     * resolver this is the original qwen_3_4b.safetensors. */
    const m = (resolve && await resolve()) || { file: "qwen_3_4b.safetensors", loader: "CLIPLoader", type: "flux2" };
    /* A cloud model (server/llm/providers.js) answers over HTTPS and never
     * touches the card. */
    if (m.api && cloud) return cloud.complete(m.api, prompt);
    const graph = {
      1: { class_type: m.loader || "CLIPLoader", inputs: { clip_name: m.file, type: m.type || "flux2" } },
      2: {
        class_type: "TextGenerate",
        inputs: {
          clip: ["1", 0], prompt, max_length: maxLength,
          /* Greedy. See the header: a deterministic wrong answer is testable
           * and a sampled one is not. */
          sampling_mode: "off",
          /* Reasoning tokens come out of the same budget as the JSON. */
          thinking: false,
        },
      },
      3: { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
    };
    const done = await engine.run({
      graph, actor: CHAT_ACTOR, via: "chat", adopt: false,
      timeoutMs: 240_000, pollMs: 500, label,
    });
    if (done.status !== "completed") {
      const why = String(done.error || "");
      /* A file ComfyUI read with the wrong architecture fails deep in a matmul;
       * say which file, not the tensor shapes. */
      if (/shapes cannot be multiplied|size mismatch/i.test(why)) {
        throw new Error(`ComfyUI could not run "${m.file}" as a chat model (its weights do not match the model it was loaded as). Pick another model in the dropdown.`);
      }
      throw new Error(why || `the model did not answer (${done.status})`);
    }
    /* Read from the terminal history entry the door already holds. PreviewAny
     * reports under `text`, which is not a file kind and so never appears in
     * `outputs[]`; asking /history again here would open a window in which an
     * engine restart returns an empty string, which reads as a malformed reply
     * and costs a re-ask for nothing. */
    return done.entry?.outputs?.["3"]?.text?.[0] ?? "";
  }
  /** Does the next turn need the graphics card? A cloud model does not, so a
   *  render in progress is no reason to refuse a question. */
  ask.usesCard = async () => !(cloud && resolve && (await resolve())?.api);
  /** Which kind of model answers next: "cloud" or "local". */
  ask.kind = async () => (await ask.usesCard()) ? "local" : "cloud";
  return ask;
}

/* ── the card ────────────────────────────────────────────────────────────── */

/**
 * Is the graphics card free enough to ask a question?
 *
 * `queue.pending` counts jobs waiting in ComfyUI, `queue.running` the one on
 * the card. Either means a chat turn posted now sits behind it — and the app's
 * own long renders are 28 to 32 minutes. The door's status is the same row the
 * Engine panel and the base repo's harnesses read, so there is no second
 * opinion about what busy means.
 */
export async function engineBusy(engine) {
  let st;
  try { st = await engine.status(); }
  catch (e) { return { blocked: true, why: `The engine could not be reached (${e.message}).` }; }
  if (!st?.ready) return { blocked: true, why: "The engine is not up yet. Give it a moment and ask again." };
  const running = Number(st.queue?.running || 0);
  const pending = Number(st.queue?.pending || 0);
  if (running + pending > 0) {
    const mine = (st.running || []).filter((r) => r.via === "chat").length;
    if (running + pending <= mine) return { blocked: false };
    const busiest = (st.running || []).filter((r) => r.via !== "chat")
      .sort((a, b) => (b.runningSec ?? 0) - (a.runningSec ?? 0))[0];
    const been = busiest?.runningSec ? ` It has been going ${Math.round(busiest.runningSec / 60)} minutes.` : "";
    const what = busiest?.label ? ` (${busiest.label})` : "";
    return {
      blocked: true,
      why: `The graphics card is busy with a render${what}.${been} This machine has one card and the `
        + "chat model needs it too, so your message will run when the render frees it. Ask me again then.",
    };
  }
  return { blocked: false };
}

/* ── the loop ────────────────────────────────────────────────────────────── */

/** An empty session. `pending` is the confirm-before-spend gate's whole state. */
export function newSession(id) {
  return { id: id || `c${Date.now().toString(36)}`, startedAt: Date.now(), turns: [], pending: null };
}

/**
 * Run ONE user message to completion.
 *
 * `emit(event)` is called as things happen — the SSE route hands it straight to
 * the browser. The phases are `thinking`, `tool_call`, `tool_result`, `say`,
 * `proposal`, `busy`, `error` and `done`.
 *
 * `deps.model(prompt)` is the one seam: the real one is createQwenModel(), and
 * server/chat/loop_test.js passes a fake so the protocol, the spend gate, the
 * malformed path and the step cap are all tested with no GPU at all.
 */
export async function runTurn(deps, session, userText, emit = () => {}) {
  const { tools, engine = defaultEngine } = deps;
  const model = deps.model || createQwenModel({ engine });
  const text = String(userText ?? "").trim();
  if (!text) return { ok: false, error: "empty message" };

  /* ── the spend gate, before anything else ────────────────────────────────
   * A pending proposal is answered by THIS message and by nothing else. Yes
   * runs the arguments already agreed; no drops them; anything else drops them
   * too and is treated as a fresh message, because a person who changes the
   * subject has not approved a render. */
  const pending = session.pending;

  /* SAYING NO IS FREE. It costs no card and no model call, so it is answered
   * before the engine is even asked. A person trying to call a render off must
   * be able to; "the graphics card is busy" is the wrong answer to that. */
  if (pending && DECLINE_RE.test(text)) {
    session.pending = null;
    session.turns.push({ role: "user", text, at: Date.now() });
    const said = `Left it. ${pending.tool} was not run and nothing was `
      + `${pending.gate === "destroys" ? "removed"
        : pending.gate === "writes" ? "written" : "spent"}.`;
    session.turns.push({ role: "say", text: said, at: Date.now() });
    emit({ type: "say", text: said });
    emit({ type: "done", steps: 0 });
    return { ok: true, steps: 0 };
  }

  /* ── the card, ABOVE the confirm branch ──────────────────────────────────
   *
   * ⚠ MEASURED, 2026-09-05, adversarial re-check of this strand. This gate used
   * to sit BELOW the confirm branch, and the hole that left is exactly the one
   * it exists to close: a "yes" ran its spending tool AND then asked the model
   * a question, on a card already holding a 32-minute pass. The confirm turn is
   * the one turn that certainly spends, so it was the one turn the gate had to
   * cover, and it was the one turn it did not.
   *
   * THE PROPOSAL IS KEPT when this fires. A person who said yes and was told
   * the card is busy has not withdrawn anything — their yes still means yes
   * when the card frees, and dropping it would put a second model call on that
   * same contended card just to rebuild arguments this session already holds. */
  const needsCard = typeof model.usesCard === "function" ? await model.usesCard().catch(() => true) : true;
  const busy = needsCard ? await engineBusy(engine) : { blocked: false };
  if (busy.blocked) {
    session.turns.push({ role: "user", text, at: Date.now() });
    if (pending) {
      session.turns.push({ role: "note", text: `${pending.tool} is still waiting to be confirmed`, at: Date.now() });
    }
    emit({ type: "busy", text: busy.why, holding: pending ? pending.tool : null });
    emit({ type: "done", steps: 0, busy: true });
    return { ok: true, busy: true, steps: 0, held: pending || null };
  }

  /* ── the spend gate ──────────────────────────────────────────────────────
   * A pending proposal is answered by THIS message and by nothing else. Yes
   * runs the arguments already agreed; no dropped it above; anything else drops
   * it too and is treated as a fresh message, because a person who changes the
   * subject has not approved a render. */
  session.pending = null;
  if (pending) {
    if (CONFIRM_RE.test(text)) {
      session.turns.push({ role: "user", text, at: Date.now() });
      emit({ type: "confirmed", tool: pending.tool, args: pending.args });
      const ran = await callTool(deps, session, pending.tool, pending.args, emit);
      /* A tool that ENDS THE TURN (Simple mode's generate) answers for itself:
       * the render now holds the card the model would need to say so. */
      if (deps.tools.get(pending.tool)?.endsTurn) {
        const said = ran.ok ? String(ran.result?.say || `${pending.tool} ran.`) : `${pending.tool} failed: ${ran.error}`;
        session.turns.push({ role: "say", text: said, at: Date.now() });
        emit({ type: "say", text: said });
        emit({ type: "done", steps: 0 });
        return { ok: ran.ok, steps: 0 };
      }
      /* And keep going: the loop below now reasons about what the tool said.
       *
       * ⚠ THE CONFIRMED CALL IS SEEDED INTO `called`. MEASURED, 2026-09-05:
       * without it the fresh set inside think() did not know a spend had just
       * happened, so a 4B that echoed its own tool call — the failure this loop
       * already has a repeat guard for — came back as a SECOND proposal for the
       * identical arguments, and a second "yes" rendered the same song twice
       * off one intent. Seeded, the repeat guard catches it: one nudge, then
       * the turn ends honestly, and nothing is proposed a second time. */
      return await think(deps, session, model, emit, 1, new Set([callKey(pending.tool, pending.args)]));
    }
    session.turns.push({ role: "note", text: `the person did not confirm ${pending.tool}; it was not run`, at: Date.now() });
  }

  session.turns.push({ role: "user", text, at: Date.now() });
  return await think(deps, session, model, emit, 0);
}

/** One tool call, recorded either way. */
async function callTool(deps, session, name, args, emit) {
  const tool = deps.tools.get(name);
  emit({ type: "tool_call", tool: name, args, spends: !!tool?.spends });
  session.turns.push({ role: "tool_call", tool: name, args, at: Date.now() });
  try {
    const result = await tool.run(args);
    session.turns.push({ role: "tool_result", tool: name, result, at: Date.now() });
    emit({ type: "tool_result", tool: name, result });
    return { ok: true, result };
  } catch (e) {
    const error = e?.message || String(e);
    session.turns.push({ role: "tool_error", tool: name, error, at: Date.now() });
    emit({ type: "tool_result", tool: name, error });
    return { ok: false, error };
  }
}

/**
 * The step machine. Separated so a confirmation can re-enter it mid-turn.
 *
 * `seeded` is what has ALREADY been run before this machine started — which is
 * the confirmed spend on the confirm path, and nothing on a fresh message. It
 * is not a nicety: see runTurn's note, the double-spend it closes was measured.
 */
async function think(deps, session, model, emit, used, seeded = null) {
  const { tools } = deps;
  let malformed = 0;
  let correction = null;
  /* What has already been run THIS TURN, keyed by name and arguments. See the
   * repeat guard below — this is the state it needs and the reason parseReply
   * takes it too. */
  const called = new Set(seeded || []);
  let repeats = 0;
  /* One re-ask for an announced action that was never taken. See the say
   * branch — the cap is what keeps a false promise to ONE extra model call. */
  let promises = 0;

  for (let step = used; step < MAX_STEPS; step++) {
    /* The person pressed Stop (routes.js: the request closed). Nothing more
     * is asked of the model and nothing more is run. */
    if (deps.stopped?.()) {
      session.turns.push({ role: "note", text: "stopped by the person", at: Date.now() });
      emit({ type: "done", steps: step, stopped: true });
      return { ok: true, stopped: true, steps: step };
    }
    emit({ type: "thinking", step: step + 1, of: MAX_STEPS });
    let raw;
    try {
      const context = typeof deps.context === "function" ? deps.context() : deps.context;
      raw = await model(buildPrompt(tools, session.turns, correction, { intro: deps.intro, context, autoSpend: !!deps.autoSpend }), { label: `chat step ${step + 1}` });
    } catch (e) {
      const why = e?.message || String(e);
      emit({ type: "error", text: why });
      /* ⚠ WHAT ALREADY HAPPENED STILL HAPPENED. MEASURED LIVE, 2026-09-05:
       * a confirmed make_song created job cadfcb92, and the very next model
       * call — queued on the card behind that same song — was destroyed when
       * the app's Stop button cleared the engine queue (run mto5iphvf293e7,
       * status "vanished"). The turn then ended on `error` alone, which reads
       * as "the song did not start". It had started. A person told a spend
       * failed when it did not is the one wrong answer this loop must not give,
       * so the tools that DID run are named before the failure is reported. */
      const ran = [...called].map((k) => k.split("|")[0]);
      if (ran.length) {
        const said = `${ran.join(" and ")} already ran and answered — that part is done, and the `
          + "result is above. What failed was the step after it, putting that answer into words.";
        session.turns.push({ role: "say", text: said, at: Date.now() });
        emit({ type: "say", text: said, note: why });
      }
      emit({ type: "done", steps: step, error: why, ran });
      return { ok: false, error: why, steps: step, ran };
    }
    /* THE MODEL IS ONE NODE OUTPUT, NOT A TOKEN STREAM. TextGenerate returns
     * the whole string when the graph finishes, so `raw` arrives all at once
     * however it is displayed. */
    emit({ type: "raw", text: String(raw).slice(0, 4000), step: step + 1 });
    correction = null;

    const reply = parseReply(raw, tools, { called });

    if (reply.kind === "malformed") {
      /* ── THE SAME PROMISE, IN PROSE ──────────────────────────────────────
       * "Sure! Let me create the brainrot image for you." carries no JSON at
       * all, so it arrives HERE and not in the say branch below. It is the
       * same class and it gets the same treatment: the one re-ask it was
       * already going to get is made POINTED rather than merely syntactic, and
       * if it announces again the give-up sentence carries the truth. Without
       * this the person's answer is "I could not form a tool call", which is
       * jargon, and after a promise it reads as a tool that tried and failed
       * rather than as a thing that was never started. */
      const announced = called.size === 0 && announcesAction(reply.raw);
      if (malformed < MAX_MALFORMED) {
        malformed++;
        correction = announced ? `${reply.why}. ${promiseCorrection(tools)}` : reply.why;
        if (announced) emit({ type: "promise", text: String(reply.raw ?? "").slice(0, 400), step: step + 1 });
        else emit({ type: "reask", why: reply.why });
        continue;
      }
      const said = announced
        ? `I could not form a tool call.\n\n${NOTHING_STARTED}`
        : "I could not form a tool call.";
      session.turns.push({ role: "say", text: said, at: Date.now() });
      emit({ type: "say", text: said, note: reply.why });
      emit({ type: "done", steps: step + 1, malformed: true, unstarted: announced || undefined });
      return { ok: true, malformed: true, unstarted: announced || undefined, steps: step + 1 };
    }

    if (reply.kind === "say") {
      /* ── THE ANNOUNCED ACTION THAT NEVER HAPPENED ──────────────────────
       *
       * The measured failure is at the top of this file: "Sure! Let me create
       * the brainrot image for you." — no tool called, turn over, silence.
       *
       * `called.size === 0` IS THE RULE and it is doing the load-bearing work.
       * A turn in which something ran is not this failure whatever the words
       * say: the tool call, its result and the spend are all on the transcript
       * in front of the person. It also keeps the guard off two paths it has no
       * business on — the confirm path, which seeds `called` with the spend it
       * just made, and every ordinary answer that follows a tool result. The
       * cue check is the part that is a guess, and it runs second.
       *
       * TWO CHANCES, THEN HONESTY, and in that order on purpose:
       *
       *  1. ONE re-ask, naming the tools and demanding either a call or an
       *     admission. A model that then calls the tool has given the person
       *     the thing they asked for, which no wording after the fact can. This
       *     is the entire extra cost of a false promise: one model call.
       *  2. If it announces again, the announcement is DELIVERED WITH THE TRUTH
       *     ATTACHED rather than swallowed or replaced. Silence is what this
       *     strand exists to remove; replacing the model's sentence outright
       *     would throw away a real intention, and re-asking a third time would
       *     spend a shared card arguing with a 4B. */
      if (called.size === 0 && announcesAction(reply.text)) {
        if (promises < 1) {
          promises++;
          correction =
            "That reply said you were ABOUT TO DO something and it called no tool, so nothing "
            + "happened at all and the person is now watching a screen that will never change. "
            + `Do it or refuse it, in THIS reply. The tools are: ${tools.names.join(", ")}. `
            + 'Either {"tool": "<one of those>", "args": {...}} and it runs, or {"say": "..."} that '
            + "says plainly you are not doing it and why. Do not announce it a second time.";
          session.turns.push({ role: "note", text: "that reply announced an action but called no tool — asked again", at: Date.now() });
          emit({ type: "promise", text: reply.text, step: step + 1 });
          continue;
        }
        const said = `${String(reply.text).trim()}\n\n${NOTHING_STARTED}`;
        session.turns.push({ role: "say", text: said, at: Date.now() });
        emit({ type: "say", text: said, note: "the reply announced an action and called no tool" });
        emit({ type: "done", steps: step + 1, unstarted: true });
        return { ok: true, unstarted: true, steps: step + 1, said };
      }

      session.turns.push({ role: "say", text: reply.text, at: Date.now() });
      emit({ type: "say", text: reply.text });
      emit({ type: "done", steps: step + 1 });
      return { ok: true, steps: step + 1, said: reply.text };
    }

    /* ── THE REPEAT GUARD ────────────────────────────────────────────────
     *
     * MEASURED, live, 2026-09-05: after reading list_library's result the model
     * called list_library again, and again, and again, until the step cap fired
     * — six model calls, 26.8 s of card, and no answer. A second call with the
     * same arguments cannot produce a different result, so running it is pure
     * waste; what the model needs is to be told the tool has already answered.
     *
     * One nudge, then the turn ends honestly. Both halves matter: without the
     * nudge a small model has no way back onto the rails, and without the
     * ending it would nudge five more times on the same card. */
    if (deps.stopped?.()) {
      session.turns.push({ role: "note", text: `stopped by the person before ${reply.tool.name} ran`, at: Date.now() });
      emit({ type: "done", steps: step + 1, stopped: true });
      return { ok: true, stopped: true, steps: step + 1 };
    }
    const key = callKey(reply.tool.name, reply.args);
    if (called.has(key)) {
      if (repeats < 1) {
        repeats++;
        correction =
          `${reply.tool.name} has ALREADY answered this turn and its result is above. `
          + 'Do not call it again. Reply with {"say": "..."} putting that result into plain words.';
        session.turns.push({ role: "note", text: `${reply.tool.name} was already called — asked for words instead`, at: Date.now() });
        emit({ type: "repeat", tool: reply.tool.name });
        continue;
      }
      const said = `I called ${reply.tool.name} and got its answer, but I could not put it into words. The result is above.`;
      session.turns.push({ role: "say", text: said, at: Date.now() });
      emit({ type: "say", text: said, note: "the model kept repeating a call it had already made" });
      emit({ type: "done", steps: step + 1, repeated: true });
      return { ok: true, repeated: true, steps: step + 1 };
    }
    called.add(key);

    /* ── GO, WITH A WARNING (deps.autoSpend) ────────────────────────────────
     * The owner's call, 2026-09-19: the assistant does what it is asked, GPU
     * or not. A card-time tool runs at once; the page is told first (`gpu`)
     * so it can say the card is in use and offer Cancel, which is the app's
     * own Stop (/api/cancel). Only card time goes straight through: a tool
     * that DESTROYS work still waits for the person's word below. */
    const _kind = reply.tool.gate || "gpu";
    if (reply.tool.spends && deps.autoSpend && (_kind === "gpu" || _kind === "writes")) {
      const cost = reply.tool.cost || "GPU time";
      /* \u26a0 ONLY REAL CARD WORK GETS THE CARD. The `gpu` event renders a
       * warning with a Cancel button wired to /api/cancel \u2014 the app's Stop,
       * which cancels an ENGINE render. Showing that for a 70 ms numpy write is
       * worse than saying nothing: the button either does nothing or cancels
       * somebody else's render. A `writes` tool is already reported by
       * tool_call and tool_result, which is the right amount for a file. */
      if (_kind === "gpu") {
        emit({ type: "gpu", tool: reply.tool.name, cost, text: `Using the graphics card: ${reply.tool.name} (${cost}).` });
      }
      session.turns.push({ role: "note", at: Date.now(),
        text: _kind === "gpu"
          ? `ran ${reply.tool.name} straight away on the graphics card`
          : `ran ${reply.tool.name} straight away; it wrote a file` });
      const ran = await callTool(deps, session, reply.tool.name, reply.args, emit);
      /* A tool that ENDS THE TURN (Simple mode's generate) answers for itself:
       * the render now holds the card the model would need to say so. */
      if (tools.get(reply.tool.name)?.endsTurn) {
        const said = ran.ok ? String(ran.result?.say || `${reply.tool.name} ran.`) : `${reply.tool.name} failed: ${ran.error}`;
        session.turns.push({ role: "say", text: said, at: Date.now() });
        emit({ type: "say", text: said });
        emit({ type: "done", steps: step + 1 });
        return { ok: ran.ok, steps: step + 1 };
      }
      continue;
    }

    /* ── CONFIRM BEFORE SPEND ────────────────────────────────────────────
     * The turn ENDS here. Nothing is called, the exact arguments are held on
     * the session, and the next message decides. */
    if (reply.tool.spends) {
      /* `gate` rides along so the refusal sentence can be true. A routed tool
       * may be stopped here because it REMOVES something rather than because it
       * renders, and "nothing was spent" is the wrong reassurance to give
       * someone who just declined a delete. */
      session.pending = { tool: reply.tool.name, args: reply.args, gate: reply.tool.gate || "gpu" };
      session.turns.push({ role: "note", text: `proposed ${reply.tool.name}, waiting for the person to confirm`, at: Date.now() });
      emit({
        type: "proposal", tool: reply.tool.name, args: reply.args,
        cost: reply.tool.cost || "GPU time",
        text: `I would like to run ${reply.tool.name}. That costs ${reply.tool.cost || "GPU time"}. Say yes and I will.`,
      });
      emit({ type: "done", steps: step + 1, awaiting: "confirmation" });
      return { ok: true, steps: step + 1, proposal: session.pending };
    }

    await callTool(deps, session, reply.tool.name, reply.args, emit);
  }

  /* THE STEP CAP. Six model calls on a shared card is the budget for one
   * message; a loop that keeps calling tools without ever answering is the
   * failure this bounds, and saying so beats stopping silently. */
  const said = "I have gone six steps on this and not got to an answer — tell me what to do next.";
  session.turns.push({ role: "say", text: said, at: Date.now() });
  emit({ type: "say", text: said });
  emit({ type: "done", steps: MAX_STEPS, capped: true });
  return { ok: true, capped: true, steps: MAX_STEPS };
}

export default {
  runTurn, newSession, createQwenModel, parseReply, systemPrompt, buildPrompt, engineBusy,
  announcesAction, NOTHING_STARTED,
};
