/**
 * MV UI — the parity gate the music-video workflow never had.
 *
 * The DAW has server/daw/ui_test.js and the MV fork had nothing, which is why
 * eight one-directional gaps sat in this subsystem unnoticed: every one of them
 * is a real action, with a real MCP tool, that no human control reaches. The
 * owner's standing constraint is that anything an agent can do a human can do
 * too, and a constraint nobody executes is a preference.
 *
 * THE CENSUS RUNS THE HARD DIRECTION. daw/ui_test.js proves every action the
 * PAGE posts is one the server dispatches — that catches a gesture inventing a
 * write path, which is the rarer bug. This file proves the reverse: every
 * action the SERVER dispatches is reachable by a human. That is the direction
 * that produced almost every finding in the 08-27 audit.
 *
 * EXEMPTIONS ARE NAMED, AND GO STALE LOUDLY. An action may be listed in NO_UI
 * with a reason. Two things then hold: the name must be a real action (so a
 * rename cannot hide behind a dead entry), and the action must still be
 * unreachable (so closing a gap FORCES the exemption to be deleted). Without
 * that second check an exemption list becomes the place gaps go to be
 * forgotten — which is exactly the note daw/ui_test.js prints and does not act
 * on.
 *
 * Runs standalone (`node server/mv/ui_test.js`) and in the pre-commit hook.
 * Reads web/ and server/mv/ and touches nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = readFileSync(path.join(HERE, "routes.js"), "utf8");
const UI = readFileSync(path.join(HERE, "..", "..", "web", "mv.js"), "utf8");
const MCP = readFileSync(path.join(HERE, "..", "mcp-mv.js"), "utf8");
/* The props/map gates below reach into four more files. Read once, here, so a
 * renamed path fails at the top rather than in the middle of a run. */
const BOARD = readFileSync(path.join(HERE, "..", "..", "web", "mvboard.js"), "utf8");
const CSS = readFileSync(path.join(HERE, "..", "..", "web", "styles.css"), "utf8");
const STORE = readFileSync(path.join(HERE, "store.js"), "utf8");
const GEN = readFileSync(path.join(HERE, "generate.js"), "utf8");
const BIBLE = readFileSync(path.join(HERE, "bible.js"), "utf8");

/* The dispatch is a switch on b.action, nested inside the route handler, so the
 * cases are indented well past column 0. Anchoring on that indent avoids
 * catching a `case` from some unrelated shallower switch. */
const serverActions = [...new Set(
  [...ROUTES.matchAll(/^\s{6,}case "([a-z0-9_]+)":/gm)].map((m) => m[1]),
)].sort();

/* What a human can reach. Both spellings the page uses: the api() helper takes
 * an object literal, and a couple of call sites build one indirectly. */
const uiActions = new Set(
  [...UI.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]),
);

/* A regex that matches nothing passes everything — so prove the extraction
 * found a plausible surface before trusting anything it says. */
ok(`the census sees the MV dispatch at all (${serverActions.length} actions)`,
  serverActions.length >= 25, serverActions.join(", "));
ok(`...and the page's own posts (${uiActions.size} actions)`, uiActions.size >= 20);
ok("...and every action a human posts is one the server really dispatches",
  [...uiActions].every((a) => serverActions.includes(a)),
  [...uiActions].filter((a) => !serverActions.includes(a)).join(", "));

/**
 * Actions with no human control, each with the reason it is acceptable TODAY.
 * Every entry here is a to-do with a name on it, not a decision.
 */
const NO_UI = {
  bible_spec:
    "the authoring CONTRACT, not an edit: it returns the shape an LLM must produce, so it "
    + "has no human equivalent. A human editing the bible calls set_bible or set_board, and "
    + "both of those are now reachable — this is the only member of that family left here.",
  read_timeline:
    "OPEN GAP. A read, so it loses no work, but a human cannot see what the timeline became.",
  regen_stale:
    "OPEN GAP. The UI paints 'stale' badges whose tooltip says to regenerate and offers no button.",
  regen_by_clip_id:
    "The id-addressed form of regen_clip, and the ONLY door a Studio timeline item can use — "
    + "it knows its mvClipId and nothing else. A human reaches the same capability by scene, "
    + "through the shot inspector's Render button, which posts regen_clip; a second control "
    + "addressing the same render by a different handle would be a duplicate, not a capability. "
    + "It carries the same knobs (prompt, seed, loop) so it is not the weaker door.",
  import_song:
    "AGENT-ONLY, and no longer an orphan: mv_import_song copies audio in from anywhere on disk, "
    + "makes it a library track and attaches it in one move. The page has no control because the "
    + "browser cannot hand a server a path — a human's import is a file picker, which is a "
    + "different feature and belongs beside the library's own. The capability a person has today "
    + "is Attach, over songs the library already holds.",
};

const unreachable = serverActions.filter((a) => !uiActions.has(a));
const undeclared = unreachable.filter((a) => !(a in NO_UI));

ok(`every action the server dispatches is reachable by a human (${serverActions.length} actions)`,
  undeclared.length === 0,
  undeclared.length
    ? `NO HUMAN CONTROL and no exemption: ${undeclared.join(", ")}\n          `
      + "Add the control, or add a named entry to NO_UI saying why an agent may keep it to itself."
    : "");

ok("every exemption names an action that really exists",
  Object.keys(NO_UI).every((a) => serverActions.includes(a)),
  Object.keys(NO_UI).filter((a) => !serverActions.includes(a)).join(", "));

ok("...and no exemption is stale — a gap that was closed must be taken off the list",
  Object.keys(NO_UI).every((a) => !uiActions.has(a)),
  Object.keys(NO_UI).filter((a) => uiActions.has(a)).join(", ")
    + " — now reachable; delete the NO_UI entry so the next gap cannot hide behind it");

/* The other direction, cheaply: an action nothing can reach at all is dead
 * weight that reads as a feature. */
const mcpActions = new Set([...MCP.matchAll(/action:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]));

/**
 * ── THE THIRD DIRECTION: AN ACTION NO AGENT CAN REACH ──────────────────────
 *
 * Everything above this line runs the census one way — an action the SERVER
 * dispatches must be reachable by a human — plus the orphan check for the ones
 * NOBODY can reach. Neither of those sees the mirror gap: a route with a human
 * control and no MCP tool. The owner's constraint is symmetric and was written
 * down as such ("whatever a human can do here an agent must be able to do"),
 * and half of it was being enforced.
 *
 * It was not hypothetical, and the list is now EMPTY. It held four:
 * `update_asset` (the rename-and-re-describe control on every cast card, so an
 * agent that declared "TheMetrnome" with a typo could not fix the row it had
 * just made — mv_update_asset, and the name it changes is a binding key, so
 * that tool cascades or refuses), `analyze` and `delete` (mv_analyze,
 * mv_delete — the delete tool takes the confirmation argument this entry asked
 * for), and `import_song`, which was reachable by nobody at all (mv_import_song).
 * Each was found by running this census, and each entry left with its gap.
 *
 * Same discipline as NO_UI: the name must be a real action, and the moment a
 * tool reaches one the entry must go, so the list can shrink and never quietly
 * grow. An empty list is the point of the exercise, not the end of it — the
 * next route added without a tool lands here with a name on it.
 */
const NO_MCP = {};

const agentUnreachable = serverActions.filter((a) => !mcpActions.has(a));
const undeclaredAgent = agentUnreachable.filter((a) => !(a in NO_MCP));
ok(`every action the server dispatches is reachable by an AGENT (${serverActions.length} actions)`,
  undeclaredAgent.length === 0,
  undeclaredAgent.length
    ? `NO MCP TOOL and no exemption: ${undeclaredAgent.join(", ")}\n          `
      + "Add the tool, or add a named entry to NO_MCP saying why a human may keep it to themselves."
    : "");
ok("every NO_MCP exemption names an action that really exists",
  Object.keys(NO_MCP).every((a) => serverActions.includes(a)),
  Object.keys(NO_MCP).filter((a) => !serverActions.includes(a)).join(", "));
ok("...and none is stale — a tool that closed one must take the entry with it",
  Object.keys(NO_MCP).every((a) => !mcpActions.has(a)),
  Object.keys(NO_MCP).filter((a) => mcpActions.has(a)).join(", ")
    + " — now reachable by an agent; delete the NO_MCP entry");
/**
 * Reachable by NOBODY. Found by this gate on its first run, and worse than a
 * one-directional gap: a route that is dispatched, maintained and covered by
 * nothing reads as a feature to whoever greps for it next. Same discipline as
 * NO_UI — the name must be real, and the moment anything reaches one the entry
 * must go, so this list can shrink and never quietly grow.
 */
/* EMPTY, and it held exactly one: `import_song` — complete, maintained, and
 * called by neither surface for as long as it had existed. Exposed rather than
 * deleted (mv_import_song), because bringing audio in from outside the library
 * is a real capability and the reason it was never wired was that nobody had
 * noticed it was there. It stays in NO_UI: the agent can reach it, a person
 * still cannot. */
const ORPHANS = {};

const orphans = serverActions.filter((a) => !uiActions.has(a) && !mcpActions.has(a));
const newOrphans = orphans.filter((a) => !(a in ORPHANS));
ok("no NEW MV action is reachable by neither a human nor an agent",
  newOrphans.length === 0, newOrphans.join(", "));
ok("every named orphan really exists",
  Object.keys(ORPHANS).every((a) => serverActions.includes(a)),
  Object.keys(ORPHANS).filter((a) => !serverActions.includes(a)).join(", "));
ok("...and none has quietly been connected since",
  Object.keys(ORPHANS).every((a) => !uiActions.has(a) && !mcpActions.has(a)),
  Object.keys(ORPHANS).filter((a) => uiActions.has(a) || mcpActions.has(a)).join(", "));

/* B-ROLL, pinned. Generate refuses mode:"broll" by design, so import_clip is
 * the ONLY way a b-roll scene ever receives footage — and it had an MCP tool
 * and no human control, which made choosing B-roll a dead end that
 * build_timeline then dropped silently. */
ok("a b-roll scene has a footage control",
  /data-broll=/.test(UI) && /action: "import_clip"/.test(UI));
ok("...which offers the clips LIBRARY, not a path — import_clip takes a name",
  /\/api\/clips/.test(UI) && /segmentId: btn\.dataset\.broll/.test(UI));
ok("...and offers only video, the same rule the server enforces",
  /mp4\|webm\|mov\|mkv\|m4v/.test(UI));

/* THE BIBLE, BY HAND. This card rendered the bible read-only and printed a
 * paragraph telling you to go ask an agent to write it — for the document this
 * fork's own copy calls "what steers the clips". */
ok("the story and style are editable fields, not printed prose",
  /id="wfLogline"/.test(UI) && /id="wfSynopsis"/.test(UI) && /id="wfStyle"/.test(UI));
ok("...saved through set_bible", /action: "set_bible"/.test(UI));
ok("...as a PARTIAL bible, so saving the story cannot disturb the cast or a board",
  UI.includes('story: { logline: $("wfLogline").value.trim()'),
  "commitBible applies each section only `if` present — send only what was edited");
ok("...and the prose no longer tells the reader to go ask an agent",
  !/Just ask it to/.test(UI));

ok("every board has an editor", /data-editboard=/.test(UI) && /function openBoardEditor/.test(UI));
ok("...that saves one scene through set_board", /action: "set_board", slug: wf\.slug, segmentId/.test(UI));
ok("...sending a COMPLETE board, because upsertBoard replaces rather than merges",
  /shots, characterRefs, backgroundRefs, propRefs, refProminence/.test(UI));
ok("...reads the shot fields back before any repaint",
  /function readShots\(\)/.test(UI) && (UI.match(/readShots\(\);/g) || []).length >= 3,
  "typing in a shot then pressing + shot would otherwise discard what was typed");
ok("...offers reference names as a CHOICE rather than free text",
  /data-ref="/.test(UI) && /CSS\.escape/.test(UI),
  "both set_bible and set_board reject an undeclared name; not being able to break the rule beats a rejection after the fact");
ok("...and names the field that actually writes the clip",
  /this is the field that writes the clip/.test(UI));
ok("the editor is styled", readFileSync(path.join(HERE, "..", "..", "web", "styles.css"), "utf8").includes(".boardedit"));

/* BLOCKING A SHOT. Two controls with two different costs, and the parity risk
 * is specific: the words half needs no Blender, so gating BOTH controls on an
 * install would hide the useful half behind the optional one — which is the
 * shape of every "feature nobody can find" in this app's history. */
ok("a board can block its camera", /id="bePzMove"/.test(UI) && /action: "previz_plan"/.test(UI));
ok("...and render a previz for a human to watch", /action: "previz_shot"/.test(UI));
ok("...with the WORDS control live whether or not Blender is installed",
  /id="bePzPlan">Words/.test(UI) && !/id="bePzPlan"[^>]*disabled/.test(UI),
  "the sentences are the half that reaches the model and they need no Blender");
ok("...and only the RENDER control gated, with the reason in reach",
  /id="bePzBlock"\$\{pz\.installed \? "" : " disabled"\}/.test(UI) && /pz\.why/.test(UI),
  "a disabled button and a sentence beats a render that fails a minute later");
ok("...offering moves the SERVER knows, not a list typed into the page",
  /fetch\("\/api\/mv\/previz"\)/.test(UI) && /pz\.moves/.test(UI));
ok("...showing the four sentences apart, the way they get used",
  /line\("camera"/.test(UI) && /line\("placement"/.test(UI));
ok("...saying out loud that the previz is not for the model",
  /human-review|do not send it anywhere/i.test(UI));
ok("...and reporting the reference frame's verdict rather than just showing it",
  /REFUSED/.test(UI) && /ref\.safe/.test(UI));
ok("...and the previz card is styled",
  readFileSync(path.join(HERE, "..", "..", "web", "styles.css"), "utf8").includes(".pzplan"));

/* ── THE BLOCKOUT, AND THE STAGING THAT MAKES IT WORTH RENDERING ──────────
 *
 * The parameter census above proves `blockout` and `spec` are sendable from
 * both hands. These say the control is the RIGHT one, which the census cannot
 * see, and each guards a specific way this card could mislead: a previz and a
 * blockout are the same grey boxes with OPPOSITE standings, and the card is
 * where somebody decides which one they are making. */
ok("a board can render a BLOCKOUT as well as a previz it watches",
  /id="bePzBlockout"/.test(UI) && /blockout: true/.test(UI),
  "the blockout is the artefact the control card below can actually steer with");
ok("...and the card says which of the two is for the model, from the SERVER's words",
  /pz\.blockout\?\.use/.test(UI) && /pz\.blockout\?\.frames/.test(UI)
  && /pz\.blockout\?\.why/.test(UI),
  "the frame floor and the use are the toolkit's numbers across a licence "
  + "boundary; a copy typed into the page drifts in silence");
ok("...and a fresh blockout DISARMS the expensive button below it",
  /ctlVerdict = null;[\s\S]{0,200}beCtlGo"\)\.disabled = true/.test(UI),
  "the card arms on a verdict about a particular source, and a re-render "
  + "replaces the file that verdict was about");

ok("the staging editor exists, and its rows come from the BOARD's own cast",
  /data-specfig=/.test(UI) && /data-specprop=/.test(UI)
  && /board\.characterRefs/.test(UI) && /board\.propRefs/.test(UI),
  "the names in the spec have to be the names in the references and in the "
  + "words, or the figure the camera follows is not the character the prompt "
  + "is about — which is what pzSubject() already exists to prevent");
ok("...and an untouched editor sends NO spec, rather than an empty one",
  /if \(!figures\.length && !props\.length\) return undefined;/.test(UI),
  "`{figures: []}` REMOVES the set's own figures, which is a real request and "
  + "not what somebody who touched nothing meant");
ok("...and the prop kinds are the server's list, not two words typed into the page",
  /pz\.spec\?\.propKinds/.test(UI) && !/"cylinder"/.test(UI),
  "previz/spec.py owns the vocabulary and refuses an unknown kind; a copy "
  + "here would offer a form field that always fails");
ok("...and the set is NOT a second field — it is the scene select already on screen",
  !/set: \$\("bePzScene"\)/.test(UI),
  "two places to name the set is two places that can disagree, and the server "
  + "refuses that disagreement rather than picking a winner");
ok("...and the staging editor is styled",
  (() => {
    const css = readFileSync(path.join(HERE, "..", "..", "web", "styles.css"), "utf8");
    return css.includes(".pzspec") && css.includes(".specrow") && css.includes(".pzblockout");
  })(),
  "the blockout gets a marked edge because it is the one clip on this card "
  + "whose standing is the opposite of the one beside it");

/* ── STRUCTURAL CONTROL, THE PREVIZ CARD'S OPPOSITE ────────────────────────
 *
 * The parity census above already proves `control_render` is reachable from
 * both hands and that every parameter it reads can be sent from both. These say
 * the control is the RIGHT one, which the census cannot see — and every one of
 * them guards a specific way this card could mislead somebody into spending
 * half an hour of GPU on a clip that was never going to work. */
const CTL = readFileSync(path.join(HERE, "control.js"), "utf8");

ok("a board can steer a render with a real clip, not just block one",
  /id="beCtlClip"/.test(UI) && /action: "control_render"/.test(UI));
ok("...and the source is chosen from the clips LIBRARY, by name",
  /loadLibraryVideos/.test(UI) && /fetch\("\/api\/clips"\)/.test(UI)
  && /mp4\|webm\|mov\|mkv\|m4v/.test(UI),
  "a browser cannot hand a server a path, and the route takes a library name");

/* ── THE SECOND DOOR ──────────────────────────────────────────────────────
 * A blockout is a legal control clip and it does NOT live in the clips
 * library — that shelf is shared with Studio and import_clip, and a grey-box
 * clip on it is one mis-click from the finished film. So the card gets a
 * source picker, and the picker is built from the payload for the same reason
 * the mode select is: a list typed into a page is a list that goes stale. */
ok("...or from THIS SHOT'S BLOCKOUT, offered as a source of its own",
  /id="beCtlSource"/.test(UI) && /ctl\.sources/.test(UI)
  && /=== "blockout"/.test(UI),
  "the blockout is project-owned and resolved by the server from the shot's "
  + "own record — the same shape this route already uses for a reference sheet");
ok("...and the clip picker goes dead when the blockout is chosen",
  /\$\("beCtlClip"\)\.disabled = \$\("beCtlSource"\)\.value === "blockout"/.test(UI),
  "a live picker beside a source that ignores it is a control that does nothing");
ok("...and switching the source clears the verdict, like switching the clip does",
  /\$\("beCtlSource"\)\.onchange = \(\) => \{/.test(UI)
  && /const ctlKey = \(\)/.test(UI),
  "a verdict about a library clip must not leave the expensive button armed "
  + "for a blockout nobody measured");
ok("...and the result names which door the frames came through, and what staged them",
  /r\.blockout/.test(UI) && /specSha256/.test(UI),
  "a control render is reproducible from its seed; it is only EXPLICABLE from "
  + "what the control clip was, and for a blockout that is a spec hash rather "
  + "than a filename somebody may overwrite");

/* THE ONE THAT MATTERS MOST. All three numbers fail silently, and this project
 * has already binned a minute of render to a 96-frame clip. The card measures
 * the clip for free and refuses to arm the expensive button until it passes. */
ok("...the validation runs BEFORE any render, as its own free control",
  /id="beCtlCheck"/.test(UI) && /mode: "check"/.test(UI)
  && /if \(mode === "check"\) return out;/.test(CTL),
  "checking a clip must cost nothing, or nobody checks");
ok("...and the refusal is SHOWN, verbatim, not thrown into an alert",
  /esc\(r\.why\)/.test(UI) && /ctlbad/.test(UI) && /<pre>/.test(UI),
  "the refusal names WHICH number is wrong and what it must be, one per line — reflowing it or replacing it with \"failed\" is how somebody re-renders twice");
ok("...and the expensive button is disabled until that verdict says yes",
  /id="beCtlGo" disabled/.test(UI) && /ctlVerdict/.test(UI)
  && /\$\("beCtlGo"\)\.disabled = !\(same && ctlVerdict\.ok\)/.test(UI),
  "half an hour of one GPU is the longest thing this app does");
ok("...and a re-picked clip clears the verdict rather than carrying it over",
  /\$\("beCtlClip"\)\.onchange = \(\) => \{ ctlVerdict = null/.test(UI),
  "an armed button for a clip nobody checked is worse than no check at all");

/* NO LITERAL IN THE PAGE. The three numbers, the ladder, the cost and both
 * licence answers are measurements; a page holding its own copy would go stale
 * silently, which is the exact failure the previz catalogue fetch exists for. */
ok("...reading the contract from the SERVER, not from numbers typed into the page",
  /fetch\("\/api\/mv\/control"\)/.test(UI) && /ctl\.spec\.minFrames/.test(UI)
  && /ctl\.spec\.width/.test(UI) && /ctl\.spec\.fps/.test(UI)
  && !/1280x704/.test(UI) && !/\b121 frames\b/.test(UI),
  "the toolkit owns those numbers across a licence boundary; a copy here drifts in silence");
ok("...showing the strength ladder as MEASURED arms, with the default marked",
  /ctl\.ladder\.map/.test(UI) && /the default/.test(UI) && /r\.reads/.test(UI),
  "0.25 does nothing and 2.00 reconstructs — a bare number field would imply otherwise");
ok("...and the cost, before the click, because it is the longest call in the app",
  /ctl\.cost\.vaceMinutes/.test(UI) && /(?:appConfirm|confirm)\(/.test(UI) && /costMinutes/.test(UI));

/* TWO LICENCE ANSWERS. WAN's is settled and the DWPose estimator's is not, and
 * the whole hazard is one card letting the settled half speak for both. */
ok("...and it gives the licence TWICE — WAN settled, the pose estimator not",
  /ctl\.licence\.vace\.class/.test(UI) && /ctl\.licence\.pose\.class/.test(UI)
  && /pose<\/b> and <b>extract/.test(UI),
  "one settled claim must not stand for the whole control path");
ok("...and the pose gate's CAVEATS travel with its numbers",
  /ctl\.poseGate\.caveats/.test(UI) && /framesScored/.test(UI),
  "33.7 px without \"43 of 121 frames were unscored\" is how somebody schedules a dance on this");

/* AND THE RECORD. A render this expensive is worth nothing if it cannot be
 * repeated, and the seed is the only handle on that. */
ok("...the operating point comes back on screen: strength, masks and the SEED",
  /op\.strength/.test(UI) && /op\.masks/.test(UI) && /op\.seed/.test(UI)
  && /off<\/b> the measured point/.test(UI),
  "a seed nobody was told is the same thing as no seed");
ok("...and the runId, so the row on screen joins the ledger",
  /out\.runId/.test(UI) && /\/api\/clip\//.test(UI));
ok("the control card is styled, and its two verdicts differ by more than colour",
  (() => {
    const css = readFileSync(path.join(HERE, "..", "..", "web", "styles.css"), "utf8");
    return css.includes(".ctlplan") && css.includes(".ctlok") && css.includes(".ctlbad")
      && /\.ctlok\{border-left/.test(css) && /\.ctlbad\{border-left/.test(css);
  })(),
  "this card exists to stop GPU being spent, so its refusal must be readable without colour");

/* THE ONE DOOR, from this side of it. server/engine/ui_test.js owns the census;
 * this asserts the thing that census cannot: that the MV control path really
 * calls dispatch, with the CALLER's actor rather than an invented one. */
ok("every control render goes through the engine door",
  /engine\.run\(\{/.test(CTL) && /via: "mv\.control"/.test(CTL)
  && /via: "mv\.control\.pose"/.test(CTL),
  "dispatch() writes the graph, the seed and every reference's SHA-256 to the ledger before the GPU spends a millisecond");
ok("...carrying the caller's own actor, never one this route invented",
  /actor,$/m.test(ROUTES.slice(ROUTES.indexOf('case "control_render"'))),
  "provenance.actorFrom(req) is a browser or an agent; a made-up actor is a more convincing lie than no record");
ok("...and adopts the output, so it lands in the library with its record",
  /adopt: true/.test(CTL));

/* ── THE PARITY CENSUS COUNTS PARAMETER NAMES, NOT REACHABLE VALUES ────────
 *
 * ⚠ THIS BLOCK EXISTS BECAUSE THE CENSUS PASSED WHILE THE GAP WAS OPEN, and
 * it is the one hole in it worth writing a second check for.
 *
 * `mode` is one parameter. The census asks whether both surfaces can send a
 * parameter called `mode`, and both could — so it was green. What it cannot
 * see is that the page had FOUR modes and mv_control_render's enum had TWO,
 * with `async run` folding everything that was not "pose" into "camera". The
 * free `check` — the whole answer to "do not spend half an hour on a clip you
 * never measured" — was a human-only button, and the caller most likely to
 * burn the GPU on an unmeasured clip is the agent. mv_control_catalogue even
 * RETURNS `check` in its mode list, so the map advertised a door that was not
 * there.
 *
 * A mode is a capability, not a value. So every mode this route accepts has to
 * be reachable from both hands, and an enum that omits one has to say so out
 * loud rather than silently rendering the most expensive alternative. */
{
  const modes = [...CTL.matchAll(/\{ mode: "(\w+)", renders: (\d+)/g)].map((m) => m[1]);
  ok(`the census read the mode table out of control.js (${modes.length})`,
    modes.length === 7 && modes.includes("check") && modes.includes("camera")
    && modes.includes("pose") && modes.includes("extract")
    && modes.includes("depth") && modes.includes("extract_depth") && modes.includes("conform"),
    `parsed: ${modes.join(", ")} — a check whose subject it failed to find passes vacuously`);

  /* The page's select is built from the payload and filters exactly one mode
   * out; that one has its own button. Parsed rather than restated, so widening
   * the filter starts failing here instead of quietly hiding a mode. */
  const filtered = [...UI.matchAll(/ctl\.modes\.filter\(\(m\) => m\.mode !== "(\w+)"\)/g)].map((m) => m[1]);
  const uiHard = new Set([...UI.matchAll(/mode: "(\w+)"/g)].map((m) => m[1]));
  const mcpHard = new Set([...MCP.matchAll(/mode: "(\w+)"/g)].map((m) => m[1]));
  const mcpEnum = new Set([...MCP.matchAll(/enum: \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1])));

  const humanCannot = modes.filter((m) => !uiHard.has(m) && filtered.includes(m));
  ok("every control mode is reachable by a HUMAN",
    humanCannot.length === 0,
    `${humanCannot.join(", ")} — filtered out of the data-driven select and given no control of its own`);

  const agentCannot = modes.filter((m) => !mcpHard.has(m) && !mcpEnum.has(m));
  ok("...and every one of them by an AGENT",
    agentCannot.length === 0,
    `${agentCannot.join(", ")} — no MCP tool pins it and no enum offers it. A mode the `
    + "catalogue advertises and no tool can ask for is a documented door that is not there.");

  /* AND THE COERCION, which is what made the gap silent rather than loud. A
   * ternary that maps every unlisted mode onto the expensive one turns a typo
   * into thirty-two minutes; the route already refuses an unknown mode naming
   * all four, so passing it through is both shorter and correct. */
  ok("...and no tool silently rewrites an unrecognised mode into a render",
    !/mode: a\.mode === "\w+" \? "\w+" : "\w+"/.test(MCP),
    "`a.mode === \"pose\" ? \"pose\" : \"camera\"` was wrong by a factor of two thousand: "
    + "it answered `check` with a 32-minute render. Pass the mode; the route judges it.");

  /* The free one, named, because it is the mode the other three exist to
   * protect and the only one whose absence costs money rather than features. */
  ok("...and the FREE check has a tool of its own, priced free",
    /name: "mv_control_check"/.test(MCP) && /mode: "check"/.test(MCP)
    && readFileSync(path.join(HERE, "plancost.js"), "utf8").includes('"mv_control_check"'),
    "an agent that has to pay for finding out stops finding out");
}

/* ── A BLENDER SHEET, BOTH DIRECTIONS ──────────────────────────────────────
 * blender_asset writes into the same row generate_asset writes into, so a
 * one-directional gap here would not look like a missing feature — it would
 * look like a prop that some people can hold with geometry and others cannot.
 * The census above already proves the action is reachable; these say the
 * control is the RIGHT one, which the census cannot see. */
ok("every asset row offers a Blender render, props included",
  /* `kind`, not `target`: the page's transition shim is gone — every asset
   * route reads `kind` now, so the hook carries the word the body will carry
   * and nothing translates at the call site. */
  /data-blender="\$\{esc\(kind\)\}\|\$\{esc\(r\.id\)\}"/.test(UI) && /action: "blender_asset"/.test(UI),
  "props were declared and painted nowhere before this button existed");
ok("...choosing the geometry from the SERVER's catalogue, not a list typed into the page",
  /fetch\("\/api\/mv\/blender"\)/.test(UI) && /cat\.builtins/.test(UI),
  "the vocabulary lives in another repository; a copy here goes stale silently");
ok("...offering the model-file path too, named by the formats the server accepts",
  /cat\.assetFormats/.test(UI) && /body\.asset = p/.test(UI));
ok("...saying so plainly when Blender is absent, rather than failing at render time",
  /cat\.installed/.test(UI) && /cat\.why/.test(UI));
ok("...and telling the human when the reference gate THREW A PANEL AWAY",
  /r\?\.refused\?\.length/.test(UI) && /were refused as references/.test(UI),
  "a silent drop is the failure the gate was built to stop, one layer down");

/* ── PROPS ARE CAST, AS A CHECKLIST ────────────────────────────────────────
 * The rule this fork repeats most and enforced least. renderAssets() is
 * kind-generic, so these are cheap to state and they pin the thing that
 * actually went wrong: the section EXISTED and was missing the one affordance
 * that would have let anybody use it. */
const MCPSRC = MCP;                       // named, so the intent below reads
ok("props are painted with the same builder as characters and backgrounds",
  /renderAssets\("characters"\) \+ renderAssets\("props"\)/.test(UI)
    && /const SINGULAR = \{ characters: "character", backgrounds: "background", props: "prop" \}/.test(UI),
  "a third pattern for props is how props got forgotten the first time");
ok("...and a row can be DECLARED with no picture, by a human",
  /data-addasset="/.test(UI) && /action: "add_asset"/.test(UI),
  "until this existed a row could only be born from an LLM writing the whole bible "
  + "or from a picture you already had — so noticing a missing prop mid-project left "
  + "nothing to press, and \"props are cast\" was a rule with no door");
ok("...and by an agent, through a tool that TEACHES the rule rather than naming a field",
  /name: "mv_add_asset"/.test(MCPSRC) && /USE IT FOR PROPS/.test(MCPSRC)
    && /different car in every shot/.test(MCPSRC));
ok("...declaring is refused rather than duplicated when the name is taken",
  ROUTES.includes("Names bind references across the whole"),
  "names are the binding key: two rows with one name means every lookup silently takes the first");
ok("...and every card says WHICH SCENES USE IT",
  /function assetUsage\(/.test(UI) && /Referenced by no board/.test(UI),
  "\"declared and unused\" and \"used everywhere with no sheet\" looked identical on this page, "
  + "and the second is the failure DIRECTING.md is mostly about");
ok("...loudest for the silent case: referenced, and carrying no sheet",
  /Used in \$\{esc\(list\)\} — with no sheet/.test(UI) && /\.usage\.bad/.test(CSS));
ok("a prop with no sheet HOLDS the cast stage, exactly as a character with none does",
  STORE.includes("if ((doc.props || []).length && need(doc.props)) return \"characters\";"),
  "the gate checked characters and backgrounds and walked straight past props");
ok("...and the stage is labelled for what it actually gates",
  /\["characters", "Characters & props"\]/.test(UI),
  "a rail that stops on \"Characters\" while every character is finished reads as broken");
ok("the project list counts props like every other asset array",
  /props: \(doc\.props \|\| \[\]\)\.length/.test(STORE));

/* ── THE RELATIONSHIP MAP ──────────────────────────────────────────────────
 * ONE BUILDER. There were two — crimeBoard() for agents, mvBoardModel() for the
 * page — and they disagreed about props and staleness, so the map a person saw
 * and the map an agent read told different stories about the same project. That
 * is worse than no map: one that omits the failure reads as confirmation. */
ok("the page paints the SERVER's map rather than building a second one",
  /action: "crime_board"/.test(UI) && /export function mvBoardModel\(board, assetUrl\)/.test(BOARD),
  "two graph builders over one document is how props stayed invisible on this screen");
ok("...and the server's map draws props as a lane of their own",
  GEN.includes('{ key: "prop", label: "props"'),
  "the lane the whole continuity problem lives in was not on the board at all");
ok("...resolving references through the RENDERER's own resolution, not a copy of the rule",
  /resolveShot\(doc, seg\.id\)/.test(GEN) && /plan\?\.refsMissing/.test(GEN),
  "an edge drawn from a second reading of the ref lists would drift from what the GPU is handed");
ok("...and it carries the lint's three findings, not a prettier subset",
  /"undeclared"/.test(GEN) && /"noSheet"/.test(GEN) && /"neverUsed"/.test(GEN),
  "a ref with no sheet, a declared prop nobody references, a board naming something that "
  + "does not exist — the map has to answer for all three or the lint stays the real tool");
ok("...including the object nobody declared, from the SAME scan the lint uses",
  /undeclaredRecurring/.test(GEN) && /export function undeclaredRecurring/.test(BIBLE),
  "two copies of that word list would disagree the first time anybody added a noun, and the "
  + "map would then be quietly kinder than the lint");
ok("a break is visible WITHOUT being read — colour, badge and dash, not colour alone",
  /BREAK_COLOR/.test(BOARD) && /stroke-dasharray/.test(BOARD) && /class="bwarn"/.test(BOARD)
    && /\.bnode\.bbad/.test(CSS),
  "colour alone is not a signal a colour-blind reader can act on, and this screen exists "
  + "entirely to catch something before GPU is spent on it");
ok("...the count is stated even when it is zero",
  /No continuity breaks\./.test(BOARD),
  "an empty space is indistinguishable from a check that never ran");
ok("...and clicking a finding lights the nodes the SERVER said it was about",
  /data-break="/.test(BOARD) && /b\.nodes \|\| \[\]/.test(BOARD),
  "re-deriving that on the page is how the highlight starts disagreeing with the sentence beside it");
ok("...a missing thing gets a node, not just a sentence",
  /ghost/.test(GEN) && /\.bnode\.bghost/.test(CSS),
  "a car in eight scenes with no row of its own has to take up space in the prop lane");

/* ── DATES ──────────────────────────────────────────────────────────────── */
ok("the project picker says when, not just what order it happened to be in",
  /<option value="\$\{esc\(p\.slug\)\}"/.test(UI)
    && /esc\(ago\(p\.updatedAt\)\)\} ago[\s\S]{0,20}<\/option>/.test(UI),
  "the list arrives sorted by recency and showed no dates, so the order was the only clue");
ok("...and a card separates TOUCHED from actually RENDERED",
  /renderedAt/.test(UI) && /export function lastRenderAt/.test(STORE),
  "updatedAt moves when you rename a prop, so on its own it cannot answer "
  + "\"did a night of rendering actually happen here\"");
ok("...derived from the takes rather than stored, so it cannot drift",
  STORE.includes("scan(doc.characters); scan(doc.backgrounds); scan(doc.props);"));
ok("...and a document with no such timestamp prints a dash, never NaN",
  /if \(!Number\.isFinite\(Number\(t\)\) \|\| !t\) return "—";/.test(UI));

/* ── THE HOLE IN EVERY GATE ABOVE: PARAMETERS ──────────────────────────────
 *
 * Everything up to this line matches ACTION NAMES. That is blind to the defect
 * that actually shipped here at scale — a route reading a parameter that no
 * surface can send. 153 of them, once. An action-name census gives such a route
 * a clean bill of health, because the action IS reachable; it is the knob that
 * is not, and a knob nothing can turn is a feature that only exists in the
 * source.
 *
 * So: for the Blender and previz routes, every `b.<name>` the dispatch reads
 * must be reachable — from an MCP tool argument, or from the page — or be named
 * below with a reason. Same discipline as NO_UI: the name must be real, and an
 * exemption that gets closed must be deleted.
 *
 * SCOPED ON PURPOSE, and this is a limitation, not an oversight: it covers the
 * three actions this feature added. The other thirty-odd dispatch cases are
 * still gated by name only. Widening it is the obvious next job and it will
 * find things — do not read the count below as the whole route table.
 */
/* ⚠ WIDENED, and the note above about scope is now one item less true: the
 * shot family joins the previz and Blender routes, because it is the family
 * where a parameter nobody can send is most expensive. A re-render route that
 * reads `prompt` and `seed` from a body no surface fills is exactly the
 * "feature that only exists in the source" this census was written to find —
 * and this feature IS those two knobs. The remaining thirty-odd cases are
 * still gated by name only. */
/* ⚠ WIDENED AGAIN, by the props/map strand's own two-directional run: the
 * newest write on this surface, `add_asset`, was censused by NAME only and
 * turned out to read two parameters no human control sends. That is the exact
 * defect this section exists for, on a route that is four days old — the census
 * has to arrive with a feature, not a release behind it. `pick_take` joins it
 * because switching between a Blender take and a generated one is how the prop
 * work is USED, and a knob missing from one side of that would look like a
 * sheet that some people can swap and others cannot. */
/* ⚠ WIDENED A THIRD TIME, onto the two asset writes that had just been fixed.
 * `generate_asset` is here because its own STILL_OPEN entry asked for it in so
 * many words — the entry existed because adding it while `refs` was declared
 * and dropped would have failed the AGENT direction, and that is exactly the
 * failure that has now been paid off rather than argued away. `update_asset`
 * joins it because it is the newest write on this surface and it grew four
 * parameters in one change (name, prompt, role, cascade), which is the shape
 * that has produced every declared-and-dropped knob this section was built to
 * find. */
/* ⚠ WIDENED TO THE WHOLE ROUTE TABLE, which is what every note above promised
 * and none of them did. Ten of forty-two was the scope, and the paragraph that
 * set it said in so many words "widening it is the obvious next job and it will
 * find things". It did: seven parameters that no surface can send, one of them
 * (`segment.leadInSec`) reachable by nobody at all, plus five FALSE gaps the
 * old extraction invented and one whole case it could not read.
 *
 * Four extraction holes had to be closed first, and each of them is the same
 * disease this file keeps naming — a check that reads less than it claims:
 *
 *   1. THE LAST CASE. `routeCase` sliced up to the next `case`, and `ab_mix` is
 *      the last one in the switch, so it extracted as the empty string: nought
 *      parameters, every check green. A regex that matches nothing passes
 *      everything, and that is precisely how the last route in a file becomes
 *      the least-tested one.
 *   2. FALL-THROUGH. `generate_clip` is a bare label above `regen_clip` — one
 *      body, two names — and `import_song` runs its own body and then falls
 *      into `attach_song`. Read alone, generate_clip appeared to read NOTHING.
 *   3. `b[k]` OVER A LIST. `segment` reads its four cut knobs through a loop,
 *      so a `b.<name>` scan saw one parameter where the route reads five — and
 *      the BACKWARDS check then accused mv_segment of sending three arguments
 *      nothing reads, which is the opposite of the truth.
 *   4. THE FIRST TOOL ONLY. `mcpSends` stopped at the first `action: "..."` it
 *      found. Five tools post `ab_sfx`, three post `create`/`ab_*`; the census
 *      saw one of each and called the rest missing.
 *
 * And one more, on the agent side: three tools ASSEMBLE the body they post —
 * `mv_set_brief` builds `brief` out of eleven documented arguments, `ab_plan`
 * builds `settings`, `mv_regen_stale` computes `dryRun` — so a scan for `a.`
 * beside the key reported all three as knobs no agent can turn. A census that
 * over-reports is the same disease as one that under-reports; it just costs
 * somebody an afternoon instead of a render.
 */
const PARAM_ACTIONS = serverActions;

/** Every dispatch case, sliced at the next `case` OR at the `default:` that
 *  closes the switch — see hole 1 above. */
const CASE_BODY = new Map();
const CASE_ORDER = [];
for (const m of ROUTES.matchAll(
  /^\s{6,}case "([a-z0-9_]+)":([\s\S]*?)(?=^\s{6,}(?:case "|default:))/gm)) {
  CASE_BODY.set(m[1], m[0]); CASE_ORDER.push(m[1]);
}

/**
 * The two cases that do not own their whole body, DECLARED rather than guessed
 * — and the guess is checked below, so a third one added later fails here
 * instead of quietly reading as a route with no parameters.
 *
 * `generate_clip` is a BARE LABEL: it has no body of its own at all, so its
 * parameters AND its callers are regen_clip's. `import_song` has a body, runs
 * it, and then falls into attach_song, so it reads both — but its callers are
 * its own.
 */
const SHARED_BODY = { generate_clip: "regen_clip" };
const FALLS_INTO = { import_song: "attach_song" };

const detectedFallThrough = CASE_ORDER.filter((a) => {
  const body = CASE_BODY.get(a) || "";
  return !body.includes("{") || /no-fallthrough/.test(body);
});
ok(`the census knows which cases share a body (${detectedFallThrough.join(", ")})`,
  detectedFallThrough.length === 2
    && detectedFallThrough.every((a) => a in SHARED_BODY || a in FALLS_INTO),
  `declared: ${[...Object.keys(SHARED_BODY), ...Object.keys(FALLS_INTO)].join(", ")}\n          `
  + "a case that falls into the next one reads ITS parameters too; undeclared, it "
  + "censuses as a route that reads nothing and passes every check below");

/**
 * Every parameter a case reads: `b.<name>`, plus `b[k]` walked over a literal
 * list (hole 3), minus the ones the route ASSIGNS TO ITSELF. That last
 * subtraction is one name — `import_song` sets `b.file` before falling through
 * — and without it the census demands a `file` argument for an action whose
 * whole job is to compute one.
 */
function routeParams(a) {
  let body = (SHARED_BODY[a] ? CASE_BODY.get(SHARED_BODY[a]) : CASE_BODY.get(a)) || "";
  if (FALLS_INTO[a]) body += CASE_BODY.get(FALLS_INTO[a]) || "";
  const set = new Set([...body.matchAll(/\bb\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
  for (const m of body.matchAll(/\bb\[(\w+)\]/g)) {
    const loop = body.match(new RegExp(`for \\(const ${m[1]} of \\[([^\\]]*)\\]`));
    if (loop) for (const s of loop[1].matchAll(/"(\w+)"/g)) set.add(s[1]);
  }
  set.delete("action");
  for (const m of body.matchAll(/\bb\.(\w+)\s*=[^=]/g)) set.delete(m[1]);
  return [...set].sort();
}
const routeCase = (a) => (SHARED_BODY[a] ? CASE_BODY.get(SHARED_BODY[a]) : CASE_BODY.get(a)) || "";

/** Every object literal in `src` that carries `action: "<a>"`, brace-matched
 *  rather than windowed — the old 900-character window both truncated long
 *  bodies and swallowed whatever object happened to sit after a short one. */
function bodiesFor(src, a) {
  const out = [];
  for (let at = src.indexOf(`action: "${a}"`); at >= 0; at = src.indexOf(`action: "${a}"`, at + 1)) {
    const s = src.lastIndexOf("{", at);
    if (s < 0) continue;
    let d = 0, e = s;
    for (; e < src.length; e++) {
      if (src[e] === "{") d++;
      else if (src[e] === "}" && --d === 0) break;
    }
    out.push({ at, body: src.slice(s, Math.min(e + 1, s + 3000)) });
  }
  return out;
}

/** The mv({...}) body an MCP tool posts, and which of its keys carry an
 *  ARGUMENT. Unioned over EVERY tool that posts the action (hole 4). A key
 *  hard-coded in the tool is not a knob anyone can reach — those are collected
 *  separately by mcpPins. */
function mcpSends(a) {
  const out = new Set();
  const names = SHARED_BODY[a] ? [a, SHARED_BODY[a]] : [a];
  for (const n of names) for (const { at, body } of bodiesFor(MCP, n)) {
    const rs = MCP.lastIndexOf("async run(a)", at);
    const run = rs < 0 ? body : MCP.slice(rs, at + 1200);
    for (const m of body.matchAll(/([A-Za-z_]\w*):\s*[^,}]*?\ba\.\w+/g)) out.add(m[1]);
    /* A key whose value is a LOCAL the tool assembled out of its own arguments
     * — `brief`, `settings`, `dryRun: dry`. Three tools do this and all three
     * read as dead knobs without it. */
    for (const m of body.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*(?:[,}]|:\s*([A-Za-z_]\w*)\s*[,}])/g)) {
      const val = m[2] || m[1];
      if (new RegExp(`\\b(?:const\\s+)?${val}(?:\\.\\w+)?\\s*=\\s*[^;\\n]*\\ba\\.`).test(run)) out.add(m[1]);
    }
  }
  out.delete("action");
  return out;
}

/** Keys an MCP tool HARD-CODES, and the distinct values it hard-codes them to.
 *  Two or more values across the tool list is not a missing knob: it is an
 *  enum spelled as tools, which is the same argument HUMAN_DEFAULTS already
 *  makes for previz's two buttons. One value is a pin, and needs a reason. */
function mcpPins(a) {
  const map = new Map();
  const names = SHARED_BODY[a] ? [a, SHARED_BODY[a]] : [a];
  for (const n of names) for (const { body } of bodiesFor(MCP, n)) {
    for (const m of body.matchAll(/([A-Za-z_]\w*):\s*("(?:[^"\\]|\\.)*"|-?\d+|true|false|null)\s*[,}]/g)) {
      if (m[1] === "action") continue;
      if (!map.has(m[1])) map.set(m[1], new Set());
      map.get(m[1]).add(m[2]);
    }
  }
  return map;
}

/** What the PAGE puts in the body, unioned over every call site. */
function uiSends(a) {
  const out = new Set();
  const names = SHARED_BODY[a] ? [a, SHARED_BODY[a]] : [a];
  for (const n of names) for (const { at, body: raw } of bodiesFor(UI, n)) {
    let body = raw;
    /* `...pzArgs()` — resolve it, or the two previz controls read as sending
     * nothing but a slug and the gate passes for the wrong reason. */
    for (const [, helper] of body.matchAll(/\.\.\.(\w+)\(\)/g)) {
      const h = UI.match(new RegExp(`const ${helper} = \\(\\) => \\(\\{[\\s\\S]*?\\}\\)`));
      if (h) body += h[0];
    }
    /* Assignments after the literal: the page builds blender's body in pieces.
     *
     * ⚠ ONLY WHEN THE LITERAL IS ASSIGNED TO A NAMED VARIABLE, and only for
     * THAT name. This used to scan a flat 1600 characters for `body.<key> =`,
     * and the four post helpers in web/mv.js sit within twenty lines of each
     * other — so postRegenClip's `body.seed = Number(raw)` was being read as a
     * key of postGenerateAsset, postAddAsset AND postUpdateAsset. The census
     * then reported `generate_asset.seed` as a knob a human can turn, over a
     * helper whose signature does not even accept one. That is the exact
     * failure this census exists to catch, committed by the census itself, and
     * it is the reason the parity run's only remaining differences were three
     * ROLLED seeds. */
    const owner = UI.slice(Math.max(0, at - 200), at).match(/(?:const|let|var)\s+(\w+)\s*=\s*\{[^{]*$/);
    if (owner) {
      for (const [, key] of UI.slice(at, at + 1200).matchAll(new RegExp(`\\b${owner[1]}\\.(\\w+)\\s*=[^=]`, "g"))) {
        body += `, ${key}: x`;
      }
    }
    for (const m of body.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*(?=[:,}])/g)) out.add(m[1]);
  }
  out.delete("action");
  /* THE ROUTE'S OWN TRANSITION SHIM, READ OUT OF THE ROUTE. routes.js maps
   * `target` onto `kind` for every action in ASSET_ACTIONS, so a page posting
   * the older spelling really does reach the parameter the dispatch reads —
   * and a census that called that unreachable would be reporting a gap the
   * running code does not have. Parsed rather than restated: the day the shim
   * is deleted this translation disappears with it and the check correctly
   * starts demanding `kind` from the page. */
  if (SHIM_ON && SHIMMED.has(a) && out.has("target")) out.add("kind");
  return out;
}

const SHIM_ON = /if \(ASSET_ACTIONS\.has\(action\) && b\.kind === undefined\s*&&\s*typeof b\.target === "string"\) b\.kind = b\.target;/.test(ROUTES);
const SHIMMED = new Set([...(ROUTES.match(/const ASSET_ACTIONS = new Set\(\[([\s\S]*?)\]\)/)?.[1] || "")
  .matchAll(/"(\w+)"/g)].map((m) => m[1]));
ok(`the census reads the route's target->kind shim rather than guessing it (${[...SHIMMED].length} actions)`,
  SHIM_ON && SHIMMED.size >= 3 && [...SHIMMED].every((a) => serverActions.includes(a)),
  `on:${SHIM_ON} actions:${[...SHIMMED].join(", ")}`);

/**
 * Parameters no HUMAN control sends, with the reason that is acceptable today.
 * Not a free pass: each name must still be read by that route, and must still
 * be unreachable, so closing one forces the entry out.
 *
 * ⚠ Actions already exempted BY NAME in NO_UI are skipped here rather than
 * listed twice. `read_timeline`, `regen_stale`, `regen_by_clip_id`,
 * `import_song` and `bible_spec` have no human control AT ALL, and their
 * reasons are written where the gap is — restating them per parameter would be
 * fifteen entries saying one thing, and fifteen entries is where a list stops
 * being read. The skip is printed at the bottom of the run so it cannot become
 * invisible.
 */
const HUMAN_DEFAULTS = {
  "control_render.negative":
    "the negative prompt defaults to the exact one arm W1 ran with, and changing it makes "
    + "the gate's numbers — CMA 0.924, SSIM_block 0.524 — statements about a different "
    + "graph. The card shows the measured operating point and offers the two knobs that "
    + "were laddered (strength) or that must be recorded (seed); a negative field beside "
    + "them would read as equally safe to turn and is not. An agent that has read "
    + "mv_control_render's description knows what it costs and can send one.",
  "blender_asset.angles":
    "the sheet renders the reference-photograph three (three_quarter, front, side). A human "
    + "gets the convention; choosing angles is a knob, not a capability.",
  "blender_asset.res": "1024 square. Same reason.",
  "blender_asset.samples": "64. Same reason.",
  "blender_asset.aspect": "square, which is the only shape these sheets have been looked at in.",
  "blender_asset.lens": "85 mm portrait compression, which is what a reference wants.",
  "blender_asset.transparent":
    "OPEN GAP, and the one on this list that is not merely a knob: alpha instead of the "
    + "neutral card changes what the sheet IS. An agent can ask for it and a human cannot.",
  "previz_plan.side": "\"the left\" — which side a follow keeps. A knob on the sentence.",
  "previz_plan.pronoun": "\"they\". The page has no cast gender to read one from yet.",
  "previz_plan.angle": "folded into the framing sentence; the page offers framing itself.",
  "previz_plan.shotAction": "the shot's own action line, which the board editor owns and sends with set_board.",
  "previz_plan.lensFeel": "prose colour on the lens sentence.",
  "previz_plan.lighting": "prose colour on the lens sentence.",
  "previz_plan.degrees": "how far an orbit arcs. Default 90.",
  "previz_plan.base": "the move under a robo_arm or speed_ramp. Default: the sentence says \"its path\".",
  "previz_shot.frames": "144, six seconds at 24fps — long enough to judge a move.",
  "previz_shot.render": "the page's two buttons ARE this flag: Words posts previz_plan, Block posts previz_shot.",
  "previz_shot.reference":
    "OPEN GAP. The reference frame at the blocked camera's own angle is agent-only; the page "
    + "renders the clip and the words and never asks for the still.",
  "previz_shot.u": "0.5 — where in the move the reference viewpoint is taken. Meaningless without `reference`.",
  "previz_shot.lens": "85 mm on the previz clip.",
  "previz_shot.lensFeel": "prose colour; see previz_plan.",
  "previz_shot.lighting": "prose colour; see previz_plan.",
  "previz_shot.shotAction": "as previz_plan.shotAction — the board editor owns that line.",
  "previz_shot.angle": "as previz_plan.angle.",
  "previz_shot.pronoun": "as previz_plan.pronoun.",

  /* ── found by widening the census onto the other thirty-two ─────────────
   * Each of these is a real one-directional gap. None was known before this
   * run, and none is a decision anybody made — they are what a route grows
   * when only the tool that drives it is kept in step. */
  "import_clip.pick":
    "defaults true: an imported clip becomes the take that plays. `pick:false` files it as a take "
    + "without adopting it, which is an agent's bulk-import move — a person importing one clip "
    + "into one scene means to see it.",
  "import_clip.seconds":
    "the media length, and the route already reads it off the library when anything recorded one. "
    + "A human typing a duration over a measured one is a way to be wrong, not a capability.",
  "ab_bed.seed":
    "the music bed's seed. The page's bed buttons post a mood and let the seed roll; re-rolling "
    + "is what the button is for.",
  "ab_sfx.cues":
    "the `set` mode's payload — an edited cue list. The page runs scan / judge / render / clear "
    + "and has no cue editor, so there is nothing yet for a human to send.",
  "ab_sfx.only": "restricts a render to named cue ids. A knob on the sweep the page runs whole.",
  "ab_sfx.seed": "the sfx render seed, as ab_bed.seed.",
};

/**
 * The mirror list: parameters NO MCP TOOL sends. New here, and it exists for
 * the same reason NO_MCP does — the owner's constraint is symmetric, and until
 * this file grew this map only one half of the PARAMETER census had it.
 *
 * A parameter hard-coded to two or more different values across the tool list
 * is NOT listed here: five ab_sfx tools pin five modes, and that is an enum
 * spelled as tools rather than a knob nobody can turn. One pinned value is a
 * pin, and gets an entry.
 */
const AGENT_DEFAULTS = {
  "create.kind":
    "PINNED, and the two pins between them cover the enum: mv_create_audiobook hard-codes "
    + "\"audiobook\" and mv_create_project omits the key, which the route reads as \"mv\". There "
    + "are exactly two kinds, so an argument would add a spelling, not a capability.",
};

/* A regex that finds nothing passes everything. Prove the extraction works
 * before believing a word it says. */
ok(`the parameter census can read every dispatch body (${PARAM_ACTIONS.length} actions, `
   + `${PARAM_ACTIONS.reduce((n, a) => n + routeParams(a).length, 0)} parameters)`,
  /* ⚠ PER-ROUTE MINIMUM 1, NOT 2. It was 2, which was true of every route in
   * the old ten-action scope and false the moment the census covered all of
   * them: `analyze`, `lint`, `delete`, `crime_board` and `build_timeline` take
   * a slug and nothing else. Failing them for that would push the next author
   * to pad a route rather than fix a regex. What this check is for is proving
   * the extraction matched anything at all — and it is the check that caught
   * `ab_mix` reading as zero. */
  PARAM_ACTIONS.every((a) => routeParams(a).length >= 1),
  PARAM_ACTIONS.filter((a) => !routeParams(a).length).map((a) => `${a} -> NOTHING`).join("\n          "));
ok("...and an MCP tool body for every one of them",
  PARAM_ACTIONS.every((a) => mcpSends(a).size >= 1),
  PARAM_ACTIONS.filter((a) => !mcpSends(a).size).join(", "));
ok("...and a page body wherever a human control exists",
  [...uiActions].every((a) => uiSends(a).size >= 1),
  [...uiActions].filter((a) => !uiSends(a).size).join(", "));

let fullyCovered = 0;
const humanSkipped = [];
for (const a of PARAM_ACTIONS) {
  const params = routeParams(a);
  const mcp = mcpSends(a), ui = uiSends(a), pins = mcpPins(a);
  const enumByTool = (p) => (pins.get(p)?.size ?? 0) >= 2;

  const deadToAgent = params.filter((p) => !mcp.has(p) && !enumByTool(p));
  const undeclaredAgent = deadToAgent.filter((p) => !(`${a}.${p}` in AGENT_DEFAULTS));
  ok(`every ${a} parameter is reachable by an AGENT (${params.length} read)`,
    undeclaredAgent.length === 0,
    undeclaredAgent.length
      ? `the route reads these and no MCP tool sends them: ${undeclaredAgent.join(", ")}\n          `
        + "Add them to the tool's inputSchema and its mv() body, or name them in AGENT_DEFAULTS."
      : "");

  /* NO_UI actions are exempted by NAME, one layer up, with the reason written
   * there. Censusing their parameters too would restate one decision fifteen
   * times. */
  let undeclaredHuman = [];
  if (a in NO_UI) humanSkipped.push(a);
  else {
    undeclaredHuman = params.filter((p) => !ui.has(p) && !(`${a}.${p}` in HUMAN_DEFAULTS));
    ok(`...and by a HUMAN, or is a named default (${params.length} read)`,
      undeclaredHuman.length === 0,
      undeclaredHuman.length
        ? `no human control sends these and nothing says why: ${undeclaredHuman.map((p) => `${a}.${p}`).join(", ")}`
        : "");
  }

  /* ⚠ AND THE SAME CENSUS BACKWARDS. Every check above asks whether a
   * parameter the ROUTE reads can be sent; this asks whether a parameter the
   * TOOL sends is read. A tool that advertises `angles` in its inputSchema,
   * puts it in the body, and posts it at a route that never looks at it is
   * worse than a missing knob: the schema is a promise, an agent spends a
   * render believing it, and the result is indistinguishable from the default.
   * Nothing would fail; the argument would simply have no effect.
   *
   * Scoped to the MCP body deliberately. mcpSends() reads mv({...}) literals
   * and is exact; uiSends() also picks up the page's transition shim (`target`
   * beside `kind`), so the same check against the page would report gaps that
   * are not there — and a census that over-reads is the same disease as one
   * that under-reads. */
  const ignored = [...mcp].filter((p) => !params.includes(p));
  ok(`...and every ${a} argument an MCP tool sends is one the route READS (${mcp.size} sent)`,
    ignored.length === 0,
    ignored.length
      ? `the tool posts these and the dispatch never looks at them: ${ignored.join(", ")}\n          `
        + "Read them, or take them out of the inputSchema — a documented argument that does "
        + "nothing is a promise the tool cannot keep."
      : "");

  if (!deadToAgent.length && !(a in NO_UI) && !params.some((p) => !ui.has(p))) fullyCovered++;
}

/* ── THE THIRD LEG: THE inputSchema ITSELF ─────────────────────────────────
 *
 * Everything above reads the mv({...}) body a tool posts. The SCHEMA is the
 * promise an agent actually reads, and a property documented there that the
 * tool's own run() never touches is the same lie one layer earlier — the agent
 * supplies it, the tool drops it, and the render comes back exactly as if the
 * argument had never been named. Nothing else in this tree looks at the schema
 * at all: the two directions above both start from the mv() body, which is
 * downstream of the promise.
 *
 * ⚠ mcp-mv.js is CRLF and routes.js is LF, which is why every pattern here
 * carries `\r?`. The first draft of this block silently found ZERO tools and
 * passed — the failure mode this whole file keeps naming, one file later.
 */
const TOOLS = MCP.split(/\r?\n {4}\{\r?\n {6}name: /).slice(1)
  .map((s) => ({ name: s.slice(1, s.indexOf('"', 1)), block: s }));
/* Strings first, THEN comments — a comment terminator inside a string literal
 * would otherwise close a comment early, which is the mirror of the bug below.
 * (This very sentence cannot spell that terminator, for the same reason.)
 * Both have to go before any brace is counted: the second draft
 * of this block reported `mv_blender_sheet.parameters` as a dead promise, and
 * "parameters" was a word in a COMMENT ("Dead parameters: the class of defect
 * that once shipped 153 of itself"). A census that reads prose as structure
 * invents findings, which costs more trust than it saves. */
const bare = (s) => s
  .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, "``")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
function schemaProps(block) {
  const b = bare(block);
  const i = b.indexOf("properties:");
  if (i < 0) return [];
  const s = b.indexOf("{", i);
  let d = 0, e = s;
  for (; e < b.length; e++) { if (b[e] === "{") d++; else if (b[e] === "}" && --d === 0) break; }
  const keys = [];
  let depth = 0;
  for (const m of b.slice(s + 1, e).matchAll(/\{|\}|\[|\]|(\w+)\s*:/g)) {
    if (m[0] === "{" || m[0] === "[") depth++;
    else if (m[0] === "}" || m[0] === "]") depth--;
    else if (depth === 0 && m[1]) keys.push(m[1]);
  }
  return keys;
}
const documented = TOOLS.reduce((n, t) => n + schemaProps(t.block).length, 0);
ok(`the schema census can see the tool list at all (${TOOLS.length} tools, ${documented} documented arguments)`,
  TOOLS.length >= 40 && documented >= 100,
  "a split that finds nothing passes every check below it");
const brokenPromise = [];
for (const { name, block } of TOOLS) {
  const at = block.search(/\brun\(/);
  if (at < 0) continue;
  const run = block.slice(at);
  for (const k of schemaProps(block)) {
    if (!new RegExp(`\\ba\\.${k}\\b`).test(run)) brokenPromise.push(`${name}.${k}`);
  }
}
ok(`every documented MCP argument is one its own tool USES (${documented} arguments)`,
  brokenPromise.length === 0,
  `declared in inputSchema and never read by run(): ${brokenPromise.join(", ")}\n          `
  + "The schema is what an agent reads. An argument it names and the tool drops "
  + "produces a render indistinguishable from the default, and nothing errors.");

const declaredParams = Object.keys(HUMAN_DEFAULTS);
ok("every named human default is a parameter the route really reads",
  declaredParams.every((k) => {
    const [a, p] = k.split(".");
    return PARAM_ACTIONS.includes(a) && routeParams(a).includes(p);
  }),
  declaredParams.filter((k) => {
    const [a, p] = k.split(".");
    return !PARAM_ACTIONS.includes(a) || !routeParams(a).includes(p);
  }).join(", "));
ok("...and none is stale — a knob the page grew must come off the list",
  declaredParams.every((k) => { const [a, p] = k.split("."); return !uiSends(a).has(p); }),
  declaredParams.filter((k) => { const [a, p] = k.split("."); return uiSends(a).has(p); }).join(", ")
    + " — now reachable; delete the entry");

const declaredAgent = Object.keys(AGENT_DEFAULTS);
ok("every named agent default is a parameter the route really reads",
  declaredAgent.every((k) => {
    const [a, p] = k.split(".");
    return PARAM_ACTIONS.includes(a) && routeParams(a).includes(p);
  }),
  declaredAgent.filter((k) => {
    const [a, p] = k.split(".");
    return !PARAM_ACTIONS.includes(a) || !routeParams(a).includes(p);
  }).join(", "));
ok("...and none is stale — a knob a tool grew must come off the list",
  declaredAgent.every((k) => { const [a, p] = k.split("."); return !mcpSends(a).has(p); }),
  declaredAgent.filter((k) => { const [a, p] = k.split("."); return mcpSends(a).has(p); }).join(", ")
    + " — now reachable by an agent; delete the entry");

/* ⚠ THE FIVE THAT ARE REACHABLE BY NOBODY, pinned as a set rather than left to
 * be re-derived. These are the parameter-level equivalent of ORPHANS above and
 * they are worse than a one-directional gap: a route that reads a field, has a
 * paragraph of comment about it, and is handed it by nothing at all reads as a
 * feature to whoever greps for it next. Two of the five are harmless aliases
 * (`index` beside a segment id); three are knobs that only exist in the source,
 * and one of those — render_video.beatZoom — carries eleven lines of comment
 * about a confidence gate no caller has ever been able to open. Shrink this
 * list; it must never grow without a name arriving with it, and each name's
 * reason is in HUMAN_DEFAULTS and AGENT_DEFAULTS above. */
/* ⚠ AND IT IS EMPTY. All five went, and they went the two ways this contract
 * allows. Three were CONNECTED: `segment.leadInSec` (the segmenter has honoured
 * it since it was written and neither surface could send it), `import_asset.role`
 * (which the route also wrote unvalidated, unlike its two siblings) and
 * `render_video.beatZoom` (eleven lines of route comment about a confidence gate
 * nobody could open). Two were DELETED: the `index` aliases beside a segment id
 * on import_clip and update_segment, whose one capability — resolving a scene by
 * its position — the id parameter now carries on its own.
 *
 * An empty list is the only honest resting state for this one. It must never
 * grow without a name arriving with it, and the name's reason belongs in
 * HUMAN_DEFAULTS or AGENT_DEFAULTS above. */
const DEAD_BOTH_WAYS = [];
const deadNow = [];
for (const a of PARAM_ACTIONS) {
  if (a in NO_UI) continue;
  const mcp = mcpSends(a), ui = uiSends(a), pins = mcpPins(a);
  for (const p of routeParams(a)) {
    if (!mcp.has(p) && !ui.has(p) && (pins.get(p)?.size ?? 0) < 2) deadNow.push(`${a}.${p}`);
  }
}
ok(`no NEW MV parameter is reachable by neither a human nor an agent (${deadNow.length})`,
  deadNow.every((k) => DEAD_BOTH_WAYS.includes(k)), deadNow.filter((k) => !DEAD_BOTH_WAYS.includes(k)).join(", "));
ok("...and none of the named ones has quietly been connected since",
  DEAD_BOTH_WAYS.every((k) => deadNow.includes(k)),
  DEAD_BOTH_WAYS.filter((k) => !deadNow.includes(k)).join(", ")
    + " — now reachable; delete the entry from DEAD_BOTH_WAYS");

/* ── THE PLAN OBJECT, AND THE ONE LEVEL DEEPER THE CENSUS CANNOT SEE ───────
 *
 * The seven plan actions join everything above with NO CODE AT ALL: line 432
 * censuses `serverActions`, so a route added to the dispatch is censused the
 * moment it lands. The spec proposed re-listing them in a literal array; that
 * array had already been replaced by the whole table, and re-introducing it
 * would have made the plan the one feature whose scope was typed by hand.
 * WHAT IS ASSERTED HERE INSTEAD is the thing a new surface can actually get
 * wrong: that it shipped with an EXEMPTION. A gate that grows a list every time
 * a feature lands is a gate that measures nothing, so the plan is pinned to an
 * empty one in all six directions, and the pin fails the day somebody adds a
 * name to buy themselves a green run.
 */
const PLAN_ACTIONS = ["plan_propose", "plan_read", "plan_item", "plan_decide",
                      "plan_policy", "plan_run", "plan_discard"];
const isPlan = (k) => k.startsWith("plan_");

ok(`the census picked the plan up on its own (${PLAN_ACTIONS.length} actions, `
   + `${PLAN_ACTIONS.reduce((n, a) => n + routeParams(a).length, 0)} parameters)`,
  PLAN_ACTIONS.every((a) => serverActions.includes(a))
    && serverActions.filter(isPlan).length === PLAN_ACTIONS.length,
  `dispatched: ${serverActions.filter(isPlan).join(", ")}\n          `
  + "PARAM_ACTIONS is `serverActions`, so this needed no edit — if a plan action "
  + "is missing here it is missing from the dispatch, not from the census.");

ok("...and not one of the seven ships an exemption, in either direction",
  ![...Object.keys(NO_UI), ...Object.keys(NO_MCP), ...Object.keys(ORPHANS)].some(isPlan),
  [...Object.keys(NO_UI), ...Object.keys(NO_MCP), ...Object.keys(ORPHANS)].filter(isPlan).join(", ")
  + " — a surface built AFTER the 153-parameter finding does not get to add the 154th");

ok("...nor a single named default on any of their 32 parameters",
  ![...Object.keys(HUMAN_DEFAULTS), ...Object.keys(AGENT_DEFAULTS), ...DEAD_BOTH_WAYS].some(isPlan),
  [...Object.keys(HUMAN_DEFAULTS), ...Object.keys(AGENT_DEFAULTS), ...DEAD_BOTH_WAYS]
    .filter(isPlan).join(", "));

ok("...so every plan parameter really is sendable from BOTH the page and a tool",
  PLAN_ACTIONS.every((a) => {
    const ui = uiSends(a), mcp = mcpSends(a);
    return routeParams(a).every((p) => ui.has(p) && mcp.has(p));
  }),
  PLAN_ACTIONS.flatMap((a) => routeParams(a)
    .filter((p) => !uiSends(a).has(p) || !mcpSends(a).has(p))
    .map((p) => `${a}.${p} (page:${uiSends(a).has(p)} tool:${mcpSends(a).has(p)})`)).join(", "));

/**
 * ── THE COMPENSATING GATE: INSIDE `args` ──────────────────────────────────
 *
 * The census reads route parameters (`b.*`). An item's `args` is a JSON blob
 * the dispatch hands straight to a tool, so the census cannot see inside it —
 * and a knob in there that only an agent can turn is the 153-parameter defect
 * one level deeper, on a surface whose whole purpose is that a person reads
 * what is about to be spent before it is spent.
 *
 * So the schemas are read out of mcp-mv.js AT TEST TIME (`schemaProps`, the
 * same extractor the promise census above uses) and matched against the page's
 * `data-planarg="<tool>.<key>"` literals BOTH WAYS:
 *
 *   forwards  — a documented argument with no control is agent-only.
 *   backwards — a control naming an argument no schema documents is a field
 *               that posts into nothing, which is the same lie pointing the
 *               other way. This direction is what fails when a property is
 *               taken OUT of a tool: the page keeps offering it.
 *
 * Adding a knob to any of the five therefore fails this gate until the editor
 * grows a field for it, which is the point.
 */
const REQUIRED_EDITABLE = ["mv_generate_clip", "mv_regen_clip", "mv_generate_asset",
                           "mv_blender_sheet", "mv_previz_shot"];
/* Derived from the page's own literals, not typed twice: whatever the editor
 * CLAIMS to type a control for is what gets censused. A sixth tool added to the
 * editor is censused the day it lands, with no edit here. */
const planArgs = new Map();
for (const m of UI.matchAll(/data-planarg="([A-Za-z_]\w*)\.([A-Za-z_]\w*)"/g)) {
  if (!planArgs.has(m[1])) planArgs.set(m[1], new Set());
  planArgs.get(m[1]).add(m[2]);
}
const schemaOf = (name) => {
  const t = TOOLS.find((x) => x.name === name);
  return t ? schemaProps(t.block) : null;
};

ok(`the plan's item editor claims typed controls for ${planArgs.size} tools, `
   + `${[...planArgs.values()].reduce((n, s) => n + s.size, 0)} arguments`,
  REQUIRED_EDITABLE.every((t) => planArgs.has(t)),
  REQUIRED_EDITABLE.filter((t) => !planArgs.has(t)).join(", ")
  + " — the five the spec names are the five expensive ones; a person editing a plan "
  + "must be able to reach every argument of each");

for (const tool of [...planArgs.keys()].sort()) {
  const props = schemaOf(tool);
  const have = planArgs.get(tool);
  ok(`...${tool}: a control for every one of its documented arguments (${props ? props.length : "?"})`,
    !!props && props.length > 0 && props.every((k) => have.has(k)),
    !props ? `${tool} is not a tool in mcp-mv.js at all`
      : `documented and NOT editable by a person: ${props.filter((k) => !have.has(k)).join(", ")}\n          `
        + "An argument an agent can put in a plan item and a human cannot see or change "
        + "makes the approval a signature on a document with a hidden clause.");
  ok(`...and every ${tool} control names an argument the schema really documents (${have.size})`,
    !!props && [...have].every((k) => props.includes(k)),
    !props ? "" : `offered by the page and documented nowhere: ${[...have].filter((k) => !props.includes(k)).join(", ")}\n          `
      + "The editor posts it into `args` and the tool drops it — a field that looks like a knob "
      + "and changes nothing, which is the promise census's defect pointing the other way.");
}

ok("...and any OTHER tool falls back to a raw JSON args editor",
  /data-planraw/.test(UI) && /const known = !!PLAN_FIELDS\[it\.tool\]/.test(UI)
    && /planArgControls\(/.test(UI),
  "no argument may be reachable by an agent and not by a person — a plan can name any "
  + "plannable tool, so the tools without a typed editor need a door that is not typed");
ok("...reachable for the five as well, so a typed control can never become a ceiling",
  /data-planraw" \?|planRawToggle|id="planRaw"/.test(UI) || /raw\b[\s\S]{0,80}JSON/i.test(UI));

/* ── SURFACE ASSERTIONS: what a person can SEE before they press Run ───────
 * The census proves a body can be posted. None of it proves the card says what
 * the money is about to buy — and the object exists for exactly that. */
ok("the card prints each item's TOOL NAME, in mono — one door made visible",
  /data-planitem="\$\{esc\(it\.id\)\}"/.test(UI) && /<code class="plantool">\$\{esc\(it\.tool\)\}<\/code>/.test(UI),
  "an item is a real tool call; a card that paraphrased it would be a second execution path "
  + "in everything but code");
ok("...its own estimate, and the word `unpriced` where the model has no answer",
  /class="planest"/.test(UI) && /unpriced/.test(UI),
  "ABSENT is reported as absent — a total that quietly swallowed an unpriced item would be "
  + "the one number a person reads at bedtime, and wrong");
ok("...the total, the finishing time, and the unpriced COUNT beside it",
  /t\.headline/.test(UI) && /finishes ~\$\{esc\(planClock\(t\.etaAt\)\)\}/.test(UI)
    && /t\.unpriced/.test(UI));
ok("...and the estimates are the SERVER's, derived on read, never stored on the item",
  /\/api\/mv\/plan\//.test(UI) && !/COST_ROWS|measuredMinutesPerClip|minutes\s*=\s*[\d.]+\s*\*/.test(UI),
  "a second cost model on the page is how the card and the renderer start disagreeing about "
  + "the same night");

ok("a reference with no sheet is painted where the mistake is, not after it",
  /shotmiss/.test(UI) && /warnhint/.test(UI) && /data-planack="\$\{esc\(it\.id\)\}"/.test(UI));
ok("...and its approve control is DISABLED until that box is ticked",
  /data-planapprove="\$\{esc\(it\.id\)\}"[\s\S]{0,140}\(acks\.length && !ticked\) \? " disabled"/.test(UI),
  "refusing after the fact is worse than not being able to make the mistake — the server "
  + "refuses too, and a person should never meet that refusal");
ok("...and the acknowledgement travels with the decision", /acknowledge/.test(UI));

ok("the failure policy is a CONTROL, not a constant", /id="planPolicy"/.test(UI));
ok("...and the delegate brief is a field beside it", /id="planBrief"/.test(UI));
ok("...with auto-approve disabled until that brief has words in it",
  /id="planAuto"[\s\S]{0,300}?\$\{brief\.trim\(\) \? "" : " disabled"\}/.test(UI),
  "the server refuses a threshold with no brief; the same rule made visible, the shape the "
  + "previz Words/Block gating already uses");

ok("the quality line is on the object being approved, by its own id",
  /id="planQuality"/.test(UI) && /q\.line/.test(UI));
ok("...and DIRECTING §4's traps are painted under it, each with its cite",
  /QUALITY_TRAPS/.test(UI) && /x\.cite \|\| ""/.test(UI) && /x\.level === "error"/.test(UI));
ok("...including the LTX sentence, readable in the PAGE and not only on the server",
  UI.includes("references are dropped entirely on LTX — every character sheet you built is not used."),
  "the trap that costs the most and looks like nothing: every sheet built, and none carried");

ok("the spend meter is painted whether or not the gate is on",
  /unattended spend since the last approval/.test(UI) && /id="planSpendBudget"/.test(UI),
  "it ships OFF with the number visible — a week of real figures beats a guessed threshold");

ok("the card is styled", CSS.includes(".planscard"));
ok("...and the three plan states the existing idiom had no colour for",
  /"proposed"/.test(CSS) && /"edited"/.test(CSS) && /"running"/.test(CSS),
  "approved/done/failed/skipped were already coloured; proposed, edited and running were not");

/* ── THE SAME SEQUENCE, RUN TWICE ─────────────────────────────────────────
 *
 * Declare a prop, render its sheet, attach it to two boards, open a shot, edit
 * its prompt, re-render that shot alone, keep both takes, read the map. Once
 * through `node server/mcp.js` over stdio, once through the bodies web/mv.js
 * posts. The two documents came out IDENTICAL after normalising the slug, the
 * clock-stamped row ids, the timestamps and the content-hashed sheet names —
 * with exactly one field different, which is pinned below.
 *
 * These are the static halves of that run: the facts a diff of two project.json
 * files proved once and that nothing else would notice going wrong. */
const CRIME = GEN.slice(GEN.indexOf("export function crimeBoard"));
const SHOT = readFileSync(path.join(HERE, "shot.js"), "utf8");

ok("both surfaces attach a prop through ONE resolver, so the two documents cannot disagree",
  /export function applyShotEdit/.test(SHOT)
    && routeCase("set_shot").includes("applyShotEdit(d, b.segmentId")
    && /action: "set_shot"/.test(UI) && /action: "set_shot"/.test(MCP),
  "the page's Save-references button and mv_set_shot post the same action at the same function; "
  + "a second sorting rule on either side would put the same prop in a different list");
ok("...and the reference ORDER is the board's prominence, not the order it was ticked",
  /\.sort\(\(a, b\) => \(board\.refProminence\?\.\[b\.name\] \?\? 0\) - \(board\.refProminence\?\.\[a\.name\] \?\? 0\)\)/.test(SHOT),
  "the <Picture N> legend numbers the list this sort produces — two surfaces that saved the same "
  + "ticks with different prominence would write two different prompts, and this run reproduced "
  + "exactly that before the page's prefill was mirrored");
ok("...and the prominence box is PREFILLED from the record, so a save cannot flatten the rest",
  /sh\.refs\.find\(\(y\) => y\.name === x\.name\)\?\.prominence/.test(UI)
    && /sh\.refsMissing\.find\(\(y\) => y\.name === x\.name\)\?\.prominence \?\? 0\.5/.test(UI),
  "shSaveRefs posts EVERY ticked name's prominence, not just the one that changed; a box that "
  + "defaulted to 0.5 would silently demote every other reference on the board");
ok("a take records which of the three prompts made it, so an old take is not captioned with a new one",
  SHOT.includes('? "argument" : "edited"') && /promptSource: plan\.promptSource/.test(GEN));

/* ⚠ THE ENTRY THAT CAME OFF STILL_OPEN, RE-STATED AS A CHECK. The gap was
 * "same seed, one sentence different" — the one combination only an agent
 * could ask for, because the page's two render controls each gave up half of
 * it. Three facts hold it closed, and all three have to, or the combination
 * quietly stops being reachable again: ONE post helper (so the two buttons
 * cannot drift apart), a hold-seed control, and a source radio that can name
 * the ADOPTED text rather than the box. */
ok("there is ONE Render, and it can hold the seed while using the prompt that was ADOPTED",
  /const postRegenClip = \(\{ segmentId, clipId, prompt, promptSource, loop, seed \}\)/.test(UI)
    && /id="shHold"/.test(UI) && /name="shSrc" value="edited"/.test(UI)
    && /promptSource: src/.test(UI)
    /* EXACTLY ONE call site, not two. The clips table's own Regen is gone: its
     * button now opens this control and scrolls to it, so there is no second
     * body to drift. A count of two would mean the split had come back. */
    && (UI.match(/postRegenClip\(/g) || []).length === 1
    && /data-shotrender="/.test(UI) && /focus === "render"/.test(UI),
  "the clips table's second Regen used to post no prompt and no seed, so it always rolled a "
  + "fresh one; the inspector's always posted the box, so the take recorded \"argument\" one "
  + "second after Save prompt");
ok("...and the route reads that label rather than inferring it from the strings",
  /promptSource/.test(routeCase("regen_clip")) && /prompt_source/.test(MCP),
  "an agent and a human choosing the same three prompts must land the same word on the take");

/* ⚠ THE SECOND ENTRY THAT CAME OFF STILL_OPEN, AND THE ONE THAT COST MOST.
 * "board.staleRefs is write-only" was true for the life of the field: four
 * writers set it, none cleared it, so the map printed "Drawn before its
 * references changed" over a board that had been redrawn and adopted and whose
 * clip had re-rendered on the new picture. Reproduced on a scratch copy of
 * felt-hammers: the clip really opened on board_a2a745a98ef8.png and the badge
 * still said otherwise. An instruction a person can follow perfectly and still
 * be told they have not teaches people to ignore the badge, which is the one
 * thing this map cannot afford.
 *
 * FOUR facts hold it closed and all four have to, or the flag becomes one-way
 * again: the rule is in ONE place, both directions exist, every setter goes
 * through the one that stamps the time, and every place a board ADOPTS a
 * picture goes through the one that clears. */
ok("board.staleRefs is answerable: one rule, both directions, stated once",
  /export function markBoardRefsChanged/.test(SHOT)
    && /export function refreshBoardStale/.test(SHOT)
    && /board\.staleRefs = false/.test(SHOT)
    /* No writer anywhere else. A second `staleRefs =` outside shot.js is the
     * split this check exists to prevent. */
    && !/staleRefs\s*=/.test(GEN + BIBLE),
  "the rule lives in shot.js beside markStale, and nothing else assigns the field");
ok("...and every setter stamps WHEN the references moved, so a redraw can be newer than them",
  (BIBLE.match(/markBoardRefsChanged\(/g) || []).length === 2
    && /markBoardRefsChanged\(board\)/.test(SHOT)
    && /markBoardRefsChanged\(b\)/.test(GEN),
  "commitBible and upsertBoard, applyShotEdit's ref branch, and pickTake's cast cascade");
ok("...and every place a board ADOPTS a picture answers it",
  /if \(target === "board"\) refreshBoardStale\(row\);/.test(GEN)
    && /if \(target === "board"\) refreshBoardStale\(row2\);/.test(GEN)
    && /refreshBoardStale\(row2\);/.test(GEN)
    && /refreshBoardStale\(doc2\.boards/.test(GEN),
  "pick_take's board branch, generate_asset's first-take auto-select, "
  + "generate_board_frames' opening beat, and the clip re-render that reads the map");

/**
 * ── ASYMMETRIES THAT ARE REAL, TOLERATED, AND MUST NOT BE FORGOTTEN ────────
 *
 * The two-directional run above produced ONE document difference and three
 * things the relationship map cannot see. None of them is fixed here — the map
 * and the render path belong to work in flight — so each is written down as a
 * predicate that is TRUE WHILE THE GAP EXISTS. Close one and its check fails,
 * which forces the entry out of this file. That is the same contract NO_UI and
 * ORPHANS run under, and it is the only way an honest limit stays honest: a
 * paragraph in a report is read once, this is read on every commit.
 */
const STILL_OPEN = [
  /* EMPTY OF THE OLD ONE, and it left the way the contract says one must — by
   * FAILING. "A human cannot hold the seed AND use the prompt they ADOPTED, in
   * one action" was true of two render controls that each gave up half of it:
   * the inspector's held the seed and always posted the box's text (so the take
   * recorded promptSource "argument" one second after Save prompt), and the
   * clips table's posted the adopted text and always rolled a fresh seed.
   * Measured then: inspector seed 424242 / "argument"; table seed 2906449677 /
   * "edited". There is now ONE Render — postRegenClip — with a hold-seed
   * checkbox prefilled from the playing take and a built / saved-edit / this-box
   * radio, and the route reads `promptSource`. Pinned below by an assertion
   * rather than by this paragraph, because a paragraph is read once.
   *
   * GONE for the same reason, both closed by an earlier strand:
   * every commit rather than a paragraph that reads once:
   *
   * "renaming a cast row moves the BINDING KEY and repoints nothing" — the
   * rename is a graph edit now. store.js walks every site one name occupies
   * (board reference lists, prominence keys, take.refs, board and shot and
   * hand-written prompt text) and update_asset either moves all of them in one
   * transaction on `cascade:true` or REFUSES, listing the scenes. Re-measured
   * on the same sequence that produced the old finding: felt-hammers, a prop
   * attached to two boards, renamed with cascade — 4 references repointed and
   * the map still read the same 7 breaks it read before, against 1→4 breaks and
   * 2 errors for the old field assignment. The lead, whose name is also in the
   * prose and in the take history, moved 18 sites across 5 scenes with the
   * synopsis REPORTED and deliberately left alone.
   *
   * "generate_asset.refs is STILL declared-and-dropped" — the argument exists on
   * both surfaces now, and generate_asset has joined PARAM_ACTIONS above, which
   * is what that entry asked for. Measured through the real route with the art
   * runner stubbed: refs:true staged 2 reference images into the board render,
   * refs:false staged 0.
   */
];
for (const [label, stillOpen, why] of STILL_OPEN) {
  ok(`known gap, still open: ${label}`, stillOpen(),
    `this gap reads as CLOSED, which is good news — delete the entry from STILL_OPEN.\n          ${why}`);
}

/* DEVELOPMENT TEXT OFF THE NEWCOMER PATH (UI_PLAN B4). Publish and Complete
 * opened a card naming a planning file that is not in this repository; they are
 * off the rail until they are built (server/mv/cardfit_test.js pins the rail).
 * Comments are not rendered, so they are stripped before the check. */
ok("no rendered stage text names MV_FORK_PLAN",
  !/MV_FORK_PLAN/.test(UI.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")));

console.log(`\n  ${pass} passed, ${failures.length} failed`);
console.log(`        (no human control, by name: ${Object.keys(NO_UI).join(", ")})\n`);
console.log(`        (reachable by nobody: ${Object.keys(ORPHANS).join(", ")})\n`);
console.log(`        (no AGENT tool, by name: ${Object.keys(NO_MCP).join(", ")})\n`);
console.log(`        (known gaps, still open: ${STILL_OPEN.length})\n`);
/* ── WHAT THE PARAMETER CENSUS ACTUALLY COVERED ───────────────────────────
 * Printed rather than asserted, because these are a MEASUREMENT of the route
 * table and not a promise about it: an action that grows a knob tomorrow
 * should move this number down and fail a check above, not fail here twice. */
const censusedParams = PARAM_ACTIONS.reduce((n, a) => n + routeParams(a).length, 0);
console.log(`        PARAMETER CENSUS: ${PARAM_ACTIONS.length} of ${serverActions.length} dispatched actions, `
  + `${censusedParams} parameters, ${documented} documented MCP arguments.`);
console.log(`        ${fullyCovered} actions FULLY COVERED — every parameter reachable from both surfaces, `
  + "no exemption used.");
console.log(`        ${Object.keys(HUMAN_DEFAULTS).length} named human defaults, `
  + `${Object.keys(AGENT_DEFAULTS).length} named agent defaults, `
  + `${DEAD_BOTH_WAYS.length} reachable by nobody.`);
console.log(`        human direction skipped (exempt by NAME in NO_UI): ${humanSkipped.join(", ")}\n`);
process.exit(failures.length ? 1 : 0);
