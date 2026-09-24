/**
 * Video Workflow — the client.
 *
 * The whole music-video pipeline as one ordered rail. This page is deliberately
 * a VIEWER AND AN OVERRIDE, not the only way in: every action here is also an
 * MCP tool hitting the same `/api/mv` route, so an agent can drive the pipeline
 * unattended and you can open this tab mid-run to see exactly where it got to
 * and change your mind.
 *
 * The stage is DERIVED from the document, never stored — so undoing work walks
 * the rail backwards instead of stranding a label. The server decides it; this
 * file only draws it.
 */

import { mountBoard, mvBoardModel, abBoardModel } from "./mvboard.js";
import { appConfirm, appPrompt } from "./dialog.js";
import { runWords } from "./runwords.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Audiobook rail — same idea, different work. */
const AB_STAGES = [
  ["ingest", "Book in"],
  ["plan", "Chapters & plan"],
  ["voice", "Voice"],
  ["produce", "Narrate & mix"],
  ["complete", "Complete"],
];

/** Order and labels mirror the website's stage machine so the two read alike. */
const STAGES = [
  ["draft", "Draft"],
  ["upload_analyze", "Upload & analyze"],
  ["interview", "Creative interview"],
  ["master_gen", "Script & direction"],
  ["story_review", "Story review"],
  /* "& props" is not decoration. The stage GATE now holds here for a prop with
   * no sheet exactly as it does for a character with none (store.js stageOfDoc),
   * and a rail that stops on "Characters" while every character is finished is a
   * rail that looks broken. No new stage id: props share this one, the ported
   * stage machine's ids are persisted, and its own note forbids inserting. */
  ["characters", "Characters & props"],
  ["backgrounds", "Backgrounds"],
  ["storyboards", "Storyboards"],
  ["video", "Video clips"],
  ["rough_cut", "Rough cut"],
  ["finish", "Finish & export"],
  ["publish", "Publish"],
  ["complete", "Complete"],
];

/* NOT BUILT YET, SO NOT ON THE RAIL (UI_PLAN B4). Publish and Complete are the
 * website's last two stages and have no screen in this fork; the rail offered
 * them anyway and each opened a card about a planning file. They stay in
 * STAGES, because the ids are the stage machine's and a project's label still
 * reads "Complete" once it is exported; the rail just ends at Finish & export,
 * and a finished project opens there. */
const MV_UNBUILT = new Set(["publish", "complete"]);
const railStages = () => stagesFor().filter(([id]) => wf.doc?.kind === "audiobook" || !MV_UNBUILT.has(id));
/** The stage the rail marks, for a project whose stage has no screen yet. */
const railStage = () => (wf.doc?.kind !== "audiobook" && MV_UNBUILT.has(wf.stage)) ? "finish" : wf.stage;

const wf = { list: [], slug: null, doc: null, stage: "draft", coverage: [], view: null,
             library: [], lint: [] };

const fmt = (s) => {
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

async function api(body) {
  const r = await fetch("/api/mv", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d;
}

/* ⚠ THIS PAGE IS SERVED STATICALLY AND THE ROUTES ARE NOT.
 *
 * web/ is read off disk on every reload; server/ is loaded once at boot. So
 * between editing this file and restarting the app there is a window where the
 * NEW page is talking to the OLD dispatch — and the failure is not always a
 * refusal you can see. A route that has not learned a parameter yet accepts it,
 * ignores it, and answers 200, which looks exactly like success.
 *
 * So every control below that depends on a parameter the running server may not
 * have READS THE ANSWER BACK and says this sentence when the answer proves the
 * old build. Never a blank, never a silent half-write. */
const RESTART_REQUIRED = "The app is still running the build it booted with, which does not "
  + "know that argument yet. Restart the app and do this again.";

/**
 * A refusal, said so it can be acted on.
 *
 * ⚠ FOUND BY OPENING THE RUNNING APP, which is the only place this shows up.
 * The build on :4173 predates the whole shot family, so pressing Inspect put
 * "Unknown action: shot" on the screen and stopped — technically an error
 * message, and useless: it names a fault in the page rather than the one thing
 * that fixes it. "Unknown action" is an unambiguous signature, because a route
 * that exists never answers with it, so it can be turned into an instruction
 * without guessing. Every other refusal is passed through untouched: a
 * duplicate name is not a stale build, and telling somebody to restart over one
 * would train them to ignore the sentence that matters.
 */
const explain = (err) => {
  const msg = String(err?.message || err);
  return /^Unknown action\b/i.test(msg)
    ? `${msg}.\n\nThis page reloaded and the server did not: web/ is read off disk on every `
      + `reload, server/ only at boot. ${RESTART_REQUIRED}`
    : msg;
};

/* ─────────────────────────────────────────────────────── one door per action
 *
 * THE BODY IS ONE LITERAL ON PURPOSE, in one place, and every call site goes
 * through these. Two reasons. A person reading "what can a human send?" has
 * exactly one function to read per action rather than four call sites to
 * reconcile; and the parity gate's parameter census reads the literal passed to
 * the dispatch, so a body assembled behind a spread reports this page as
 * sending nothing but a slug. A knob the gate cannot see is a knob it will not
 * defend, and this subsystem has already shipped 153 of those.
 *
 * ⚠ THE `target` SHIM IS GONE, AND THIS IS WHAT IT COST.
 *
 * `target` was the singular the routes grew up reading ("character"); `kind` is
 * the plural the shared contract names ("characters"), and this page sent both
 * so it would be right against the server running now AND the one the contract
 * described. All six asset routes read `kind` now — add_asset, update_asset,
 * generate_asset, import_asset, blender_asset and pick_take all go through
 * assetKind() — so the second spelling is a second vocabulary and nothing else.
 * One word on the wire is what "one door" means. `SINGULAR` stays, because the
 * PROSE still needs it: a card says "Declare a character", not "a characters".
 *
 * ⚠ AND THE COST IS PAID HERE RATHER THAN BY WHOEVER OPENS A STALE TAB. A build
 * that predates the change reads `target` and DEFAULTS the row kind instead of
 * refusing. Probed against the app running on :4173 (2026-09-03): pick_take
 * with kind:"props" and a prop's own id answered "No such character", and
 * import_asset with kind:"props" would have filed the picture as a character
 * without a word. A silent wrong row is the one failure this page may not have,
 * so the three routes whose running build still reads the singular have their
 * answer READ BACK — see readBack() — and say the restart sentence when the row
 * did not land where it was addressed. That check is scaffolding: it can go
 * once no build anybody runs reads `target`. */
const SINGULAR = { characters: "character", backgrounds: "background", props: "prop" };
/** The page's kind words → the array each one lives in on the document.
 *  `board` and `clip` are pick_take's own vocabulary; assetKind takes both. */
const PLURAL = { characters: "characters", backgrounds: "backgrounds", props: "props",
                 board: "boards", boards: "boards", clip: "clips", clips: "clips" };

/**
 * A row write addressed by `kind`, with the server's answer read back.
 *
 * Two ways a build that still reads `target` shows up, and both end in the same
 * sentence rather than in a shrug:
 *   - it looked in the WRONG ARRAY and found nothing — "No such character: p3_…"
 *     for an id that is a prop's. Caught on the refusal.
 *   - it looked in the wrong array and WROTE THERE — import_asset, whose row is
 *     created rather than found. Caught by asking the returned project whether
 *     the row is where it was addressed.
 */
async function readBack(body, { kind, id }) {
  const arr = PLURAL[kind] || kind;
  let d;
  try {
    d = await api(body);
  } catch (err) {
    const m = String(err?.message || err);
    const wrong = /^No such (character|background|prop|board|clip)\b/i.exec(m);
    if (wrong && wrong[1].toLowerCase() !== (SINGULAR[kind] || kind)) {
      throw new Error(`${m}\n\nIt was addressed as a ${SINGULAR[kind] || kind} and the server `
        + `looked among ${wrong[1]}s. ${RESTART_REQUIRED}`);
    }
    throw err;
  }
  const found = id != null && (d.project?.[arr] || [])
    .some((r) => r.id === id || String(r.name).toLowerCase() === String(id).toLowerCase());
  if (d.project && id != null && !found) {
    throw new Error(`The write went through and the row is not in ${arr}.\n\nIt was addressed `
      + `as a ${SINGULAR[kind] || kind}; the server put it somewhere else, which means it read `
      + `the older spelling of that argument. ${RESTART_REQUIRED}`);
  }
  return d;
}

const postUpdateAsset = ({ kind, id, name, description, prompt, role, cascade }) =>
  api({ action: "update_asset", slug: wf.slug, kind, id,
        name, description, prompt, role, cascade });

const postAddAsset = ({ kind, name, description, prompt, role }) =>
  api({ action: "add_asset", slug: wf.slug, kind,
        name, description, prompt, role });

/* IMPORT, and it carries four fields rather than two. `description` is the text
 * every later prompt builder falls back to — an imported row without one
 * describes itself to the model as nothing — and `role` was reachable by
 * NOBODY: the route read it, no tool sent it, and no control offered it.
 *
 * Read back on the NAME, because this row is created rather than found: a build
 * that still reads `target` would file the picture under characters and answer
 * ok, which is the silent wrong row. */
const postImportAsset = ({ kind, path, name, description, role }) =>
  readBack({ action: "import_asset", slug: wf.slug, kind,
             path, name, description, role },
           { kind, id: name || null });

/* `refs` is the single-panel switch. It is forwarded by the route and read by
 * generateAsset, where it decides whether the cast sheets are attached to the
 * draw — see the board card for what it costs when they are.
 *
 * ⚠ `seed` IS THE HOLD, and its absence was the ONLY difference the two-surface
 * run could find. Drive one sequence through mv_generate_asset and the same one
 * through this page and the two project documents come out identical except for
 * three ROLLED seeds: an agent could redraw a row on the seed it already used
 * with one word of the description changed and read off what that word did; a
 * human's every redraw started somewhere new. That is not a knob, it is the
 * only way to ask a model a question — hold everything, move one thing.
 *
 * Written as a named body rather than as one literal because an EMPTY box has
 * to omit the key outright: 0 is a legitimate seed, so "not set" cannot travel
 * as a number, and `seed: null` is a value the row's generator would then take
 * seriously. Same shape, and for the same reason, as postRegenClip below. */
const postGenerateAsset = ({ kind, id, count, refs, seed }) => {
  const gen = { action: "generate_asset", slug: wf.slug, kind, id, count, refs };
  const held = String(seed ?? "").trim();
  if (held && Number.isFinite(Number(held))) gen.seed = Math.round(Number(held));
  return api(gen);
};

/* ONE RENDER. The inspector's Render and the clips table's Render are the same
 * control posting the same body — see openShotInspector. `promptSource` says
 * WHICH of the three prompts this render used, so a take's evidence records the
 * choice rather than leaving the reader to compare strings. */
const postRegenClip = ({ segmentId, clipId, prompt, promptSource, loop, seed }) => {
  const body = { action: "regen_clip", slug: wf.slug, segmentId, clipId,
                 prompt, promptSource, loop };
  /* An empty seed box means "roll a fresh one" — omitting the key is how that
   * is said, because a seed of 0 is a legitimate seed. */
  const raw = String(seed ?? "").trim();
  if (raw && Number.isFinite(Number(raw))) body.seed = Number(raw);
  return api(body);
};

/* ─────────────────────────────────────────────────────── loading */

export async function wfOpen() {
  /* The song picker needs the library, and the tab can be opened before the
   * app's own boot has fetched it — so this view fetches its own copy rather
   * than trusting a reference that may still be empty. One status call per
   * tab-open is nothing. */
  try {
    const st = await (await fetch("/api/status")).json();
    if (Array.isArray(st.library)) wf.library = st.library;
  } catch { /* keep whatever we had */ }
  await loadList();
  // Remember the last project across tab switches; picking up where you left
  // off is the whole point of a project.
  if (!wf.slug && wf.list.length) wf.slug = wf.list[0].slug;
  await loadProject();
}

async function loadList() {
  try {
    const d = await (await fetch("/api/mv/projects")).json();
    wf.list = d.projects || [];
  } catch { wf.list = []; }
  const sel = $("wfProject");
  /* videos and audiobooks are different work — the picker says so.
   *
   * AND IT SAYS WHEN. The list arrives sorted newest-touched first and then
   * showed no dates at all, so the order was the only clue and an unexplained
   * order is not information — with seventeen projects in the list, "which one
   * was I working on last night" was a question you answered by opening them.
   * One relative age per row, never an absolute timestamp: "3d" is the thing
   * being asked, and a full date makes a dropdown unreadable. */
  const group = (kind, label) => {
    const items = wf.list.filter((p) => (p.kind || "mv") === kind);
    return items.length ? `<optgroup label="${label}">${items.map((p) =>
      `<option value="${esc(p.slug)}">${esc(p.title)} · ${esc(stageLabel(kind, p.stage))}`
      + `${p.updatedAt ? ` · ${esc(ago(p.updatedAt))} ago` : ""}</option>`).join("")}</optgroup>` : "";
  };
  sel.innerHTML = (group("mv", "🎬 Music videos") + group("audiobook", "📖 Audiobooks"))
    || '<option value="">No projects yet</option>';
  if (wf.slug) sel.value = wf.slug;
  $("wfDelete").hidden = !wf.list.length;
}

async function loadProject() {
  if (!wf.slug) { wf.doc = null; paint(); return; }
  try {
    const d = await (await fetch(`/api/mv/project/${encodeURIComponent(wf.slug)}`)).json();
    if (d.error) throw new Error(d.error);
    wf.doc = d.project; wf.stage = d.stage; wf.coverage = d.coverage || [];
    /* What this PC gives the project (server/mv/routes.js cardFit): the sizes,
     * the default longest scene, the step labels, where hybrid sends a scene. */
    wf.cardFit = d.cardFit || null;
  } catch {
    wf.doc = null;
  }
  /* THE LINT COMES WITH THE PROJECT, because its findings belong on the cards
   * rather than on a screen you have to remember to open. It is free — pure
   * computation over a document the server already has — and a failure to fetch
   * it must never cost you the project view, so it degrades to no findings. */
  wf.lint = [];
  if (wf.doc && wf.doc.kind !== "audiobook") {
    try { wf.lint = (await api({ action: "lint", slug: wf.slug })).issues || []; }
    catch { /* the page is still correct without it */ }
  }
  /* THE PLAN COMES WITH THE PROJECT for the same reason the lint does: it
   * belongs on the card, not on a screen you have to remember to open, and a
   * run that is walking must be visible the moment you land on the tab. It is
   * one cheap POST, and a failure to read it costs the plan card a sentence
   * rather than costing you the project. */
  await loadPlan();
  paint();
}

const stagesFor = () => (wf.doc?.kind === "audiobook" ? AB_STAGES : STAGES);
const labelFor = (id) => (stagesFor().find((s) => s[0] === id) || [, id])[1];
const stageLabel = (kind, id) =>
  (((kind === "audiobook" ? AB_STAGES : STAGES).find((s) => s[0] === id)) || [, id])[1];
const ago = (t) => {
  /* ⚠ A MISSING TIMESTAMP MUST NOT PRINT "NaNd". Documents from before a field
   * existed have no value for it, and every caller of this now paints dates on
   * cards where an unreadable one is the whole cost of the feature. */
  if (!Number.isFinite(Number(t)) || !t) return "—";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/* ─────────────────────────────────────────────────────── painting */

function paintRail() {
  /* The website's pill stepper, with its best idea kept: the stage you are
   * LOOKING AT and the stage the project IS AT are two different states, so
   * you can browse back without losing your place. Filled = the project's
   * stage; outlined = what you're viewing; dimmed = not reached (still
   * clickable — the dimming says "not here yet", never "may not look"). */
  const RAIL = railStages();
  const stage = railStage();
  const at = RAIL.findIndex((s) => s[0] === stage);
  const view = wf.view || stage;
  $("wfRail").innerHTML = RAIL.map(([id, label], i) => {
    const cls = [
      i > at ? "todo" : "",
      id === stage ? "current" : "",
      id === view && id !== stage ? "viewing" : "",
    ].filter(Boolean).join(" ");
    return `<button class="${cls}" data-stage="${id}" title="${esc(label)}">
      <b>${i + 1}</b>${esc(label)}</button>`;
  }).join("");
}

function paint() {
  /* The poll holds a handle to a card that is about to be replaced. Clearing it
   * here and re-establishing it in wire() means the interval can never outlive
   * the node it repaints. */
  if (pl.poll) { clearInterval(pl.poll); pl.poll = null; }
  paintRail();
  const body = $("wfBody");
  if (!wf.doc) {
    $("wfRail").innerHTML = "";
    body.innerHTML = renderHome();
    wireHome();
    return;
  }
  const view = wf.view || wf.stage;
  body.innerHTML = `${renderHero()}
    <div class="wfdash">
      <div class="wfmain">${renderStage(view)}</div>
      <aside class="wfside">${renderRail(view)}</aside>
    </div>
    <div class="wfwide">${renderWide(view)}</div>`;
  wire(view);
}

/** No project open = the dashboard home: every project as a card, grouped. */
function renderHome() {
  const section = (kind, label, hint) => {
    const items = wf.list.filter((p) => (p.kind || "mv") === kind);
    return `<section class="homesec"><h3>${label}</h3>
      <div class="wgrid">${items.map((p) => `
        <button class="wcard projcard" data-openproj="${esc(p.slug)}">
          <span class="wname">${esc(p.title)}</span>
          <span class="wstatus">${esc(stageLabel(kind, p.stage))}</span>
          <span class="hint">${esc(p.book || p.song || "")}</span>
          ${/* THREE DATES, AND THEY ANSWER DIFFERENT QUESTIONS.
              * `updated` moves on every write — renaming a prop, ticking a box —
              * so on its own it says which project was last TOUCHED, which is
              * not what anybody wants to know. `rendered` is when a take last
              * landed, derived from the takes themselves, and it is the one that
              * says whether a night of GPU actually happened here. `started`
              * gives the pair a scale. A card has room for all three; the
              * dropdown does not, which is why it carries only the first. */""}
          <span class="projdates">
            <i title="when this project was created">started ${esc(ago(p.createdAt))} ago</i>
            <i title="any change at all, including edits that render nothing">touched ${esc(ago(p.updatedAt))} ago</i>
            <i title="when a take last landed — derived from the takes, so it cannot drift"
               class="${p.renderedAt ? "" : "dim"}">${p.renderedAt
                 ? `rendered ${esc(ago(p.renderedAt))} ago` : "never rendered"}</i>
          </span>
        </button>`).join("") || `<p class="hint">${hint}</p>`}</div></section>`;
  };
  return `<div class="homewrap">
    ${section("mv", "🎬 Music videos", "None yet — press New video…")}
    ${section("audiobook", "📖 Audiobooks", "None yet — press New audiobook…")}
  </div>`;
}
function wireHome() {
  for (const btn of document.querySelectorAll("[data-openproj]")) {
    btn.onclick = async () => { wf.slug = btn.dataset.openproj; wf.view = null; $("wfProject").value = wf.slug; await loadProject(); };
  }
}

/** The dashboard header: what this project IS, in numbers. */
function renderHero() {
  const d = wf.doc;
  const isAb = d.kind === "audiobook";
  let stats = [];
  if (isAb) {
    const ch = (d.book?.chapters || []).filter((c) => !c.skip);
    const inMix = new Set();
    for (const b of d.bundles) if (b.mixFile) for (const i of b.chapterIdxs || []) inMix.add(i);
    const mins = Math.round(d.bundles.reduce((a, b) => a + (b.mixSeconds || 0), 0) / 60);
    stats = [
      [ch.length ? `${[...inMix].filter((i) => ch.some((c) => c.idx === i)).length}/${ch.length}` : "—", "chapters done"],
      [d.bundles.length ? `${d.bundles.filter((b) => b.mixFile).length}/${d.bundles.length}` : "—", "files mixed"],
      [`${mins} min`, "produced"],
      [d.voice?.persona || "—", "narrator"],
      [(d.cast || []).filter((c) => c.voice).length || "0", "cast voices"],
      [d.beds.length || "0", "beds"],
    ];
  } else {
    const scenes = d.segments.filter((s2) => s2.mode === "generate");
    const done = d.clips.filter((c) => c.clipFile).length;
    const takes = d.clips.reduce((a, c) => a + (c.takes?.length || 0), 0)
      + d.characters.reduce((a, c) => a + (c.takes?.length || 0), 0);
    const dur = d.segments.length ? d.segments[d.segments.length - 1].endSec : null;
    stats = [
      [scenes.length ? `${done}/${scenes.length}` : "—", "scenes rendered"],
      [dur ? fmt(dur) : "—", "song"],
      [d.characters.length || "0", "characters"],
      [takes || "0", "takes kept"],
      [d.timelineProject ? "✓" : "—", "in Studio"],
    ];
  }
  return `<header class="wfhero">
    <div class="wfheroid"><h2>${esc(d.title)}</h2>
      <span class="kindchip">${isAb ? "📖 Audiobook" : "🎬 Music video"}</span></div>
    <div class="wfstats2">${stats.map(([v, l]) =>
      `<div class="wfstat"><b>${esc(String(v))}</b><span>${esc(l)}</span></div>`).join("")}</div>
  </header>`;
}

/* WHERE A RUN'S OUTPUT ACTUALLY LIVES.
 *
 * The activity feed said what happened and gave you no way to go and look at
 * it — a line reading "board scene 9: +1 takes" is a fact you then have to go
 * hunting for. Most runs land on a workflow STAGE; a few produce something that
 * lives on a top-level page instead, and those are the ones worth leaving the
 * Workflow tab for.
 *
 * generate_asset covers four different targets, so its destination is read off
 * the outcome text ("board scene 9", "character Kaelith") rather than guessed. */
const RUN_STAGE = {
  analyze: "upload_analyze", segment: "upload_analyze", import_song: "upload_analyze",
  attach_song: "upload_analyze", set_brief: "interview",
  mv_set_bible: "story_review", set_bible: "story_review", bible_spec: "story_review",
  set_board: "storyboards", lint: "story_review",
  generate_clip: "video", regen_clip: "video", regen_by_clip_id: "video",
  regen_stale: "video", import_clip: "video", clip_late: "video", clip_late_lost: "video",
  build_timeline: "rough_cut", read_timeline: "rough_cut",
};
/* Runs whose artefact is NOT in the workflow — going to the stage would show
 * you the button that made it, not the thing it made. */
const RUN_VIEW = { render_video: "video", studio_bounce: "studio" };

function runTarget(r) {
  const tool = String(r.tool || "");
  const out = String(r.outcome || "");
  if (RUN_VIEW[tool]) return { view: RUN_VIEW[tool], label: RUN_VIEW[tool] };
  if (tool === "generate_asset" || tool === "blender_asset" || tool === "pick_take"
      || tool === "import_asset" || tool === "update_asset") {
    const kind = out.split(/[\s:]/)[0].toLowerCase();
    const stage = kind.startsWith("board") ? "storyboards"
      : kind.startsWith("background") ? "backgrounds"
      : "characters";                       // characters and props share the cast stage
    return { stage, label: labelFor(stage) };
  }
  const stage = RUN_STAGE[tool];
  return stage ? { stage, label: labelFor(stage) } : null;
}

/** The right rail: always-on context — who speaks, what plays, what happened. */
function renderRail() {
  const d = wf.doc;
  const runs = (d.runs || []).slice(0, 8);
  const feed = `<div class="wfcard railcard"><h4>Activity</h4>
    ${/* ⚠ ITS OWN NODE, because the card's 3 s poll repaints the CARD and not
        * the page. Found by watching a run: the line said "starting…" and then
        * never moved, because the rail is only rebuilt by a full paint() and a
        * run does not cause one. paintPlanCard() refreshes this node too. */""}
    <div id="planRailLine">${planRailLine()}</div>
    ${runs.length ? `<ul class="feed">${runs.map((r) => {
      const t = runTarget(r);
      const go = !t ? ""
        : t.view ? `<a class="feedgo" href="#" data-go="${esc(t.view)}">open ${esc(t.label)} &rsaquo;</a>`
                 : `<a class="feedgo" href="#" data-feedstage="${esc(t.stage)}">${esc(t.label)} &rsaquo;</a>`;
      /* Plain words, with the tool name in the tooltip (web/runwords.js). */
      const w = runWords(r);
      return `<li>
        <span class="feedhead"><b title="${esc(w.title)}">${esc(w.text)}</b><i>${ago(r.at)}</i></span>
        <span class="feedout">${esc((r.outcome || "").slice(0, 90))}</span>
        ${go}</li>`;
    }).join("")}</ul>
    <a class="feedall" href="#" data-go="jobs">every job, with timings &rsaquo;</a>`
      : `<p class="hint">Nothing yet.</p>`}</div>`;

  if (d.kind === "audiobook") {
    const cast = (d.cast || []).filter((c) => c.voice);
    const voiceCard = `<div class="wfcard railcard"><h4>Voices</h4>
      <div class="wrow"><span>Narrator</span><b>${esc(d.voice?.persona || "not set")}</b></div>
      ${cast.map((c) => `<div class="wrow"><span>${esc(c.name)}</span><b>${esc(c.voice.persona)}</b></div>`).join("")}
      ${!cast.length ? `<p class="hint">No cast — the narrator reads everyone. Set voices on the Voice stage.</p>` : ""}
    </div>`;
    const bedsCard = `<div class="wfcard railcard"><h4>Ambient beds</h4>
      ${d.beds.map((x) => `<div class="railbed"><div class="wrow"><b>${esc(x.mood)}</b>
          <span class="hint">${d.bundles.filter((b) => b.bedId === x.id).length || "auto"} use(s)</span></div>
        <audio controls preload="none" src="/api/audio/${encodeURIComponent(x.file)}"></audio></div>`).join("")
        || `<p class="hint">None yet.</p>`}
      <div class="wrow"><span class="hint">new:</span><span>
        <button class="edtool sm" data-abbed="calm">calm</button>
        <button class="edtool sm" data-abbed="dark">dark</button>
        <button class="edtool sm" data-abbed="action">action</button>
        <button class="edtool sm" data-abbed="wonder">wonder</button></span></div>
    </div>`;
    return voiceCard + bedsCard + feed;
  }

  const castCard = `<div class="wfcard railcard"><h4>Cast</h4>
    <div class="railcast">${d.characters.map((c) => `
      <figure class="railchar" title="${esc(c.name)}">${c.imageFile
        ? `<img src="${assetSrc(c.imageFile)}" alt="">` : `<span class="bkind">C</span>`}
        <figcaption>${esc(c.name)}</figcaption></figure>`).join("")
      || `<p class="hint">No characters yet.</p>`}</div>
  </div>`;
  return castCard + feed;
}

/** Full-width sections under the dashboard: the inventory and the map. */
function renderWide(view) {
  const d = wf.doc;
  const board = `<div class="wfcard"><h3>Project board</h3><div id="wfMap"><p class="hint">Loading…</p></div></div>`;
  if (d.kind === "audiobook") {
    /* v1 IS MV-ONLY. An audiobook document carries `plans: []` and nothing
     * reads it: a plan lives in one project document and the audiobook half has
     * no expensive call worth approving item by item yet. Painting an empty
     * card here would advertise a capability that is not there. */
    const wantBoard = view === "produce" || view === "complete";
    return (wantBoard ? board : "") + (d.book ? renderChapterManager() : "");
  }
  const wantBoard = ["master_gen", "story_review", "video", "rough_cut", "finish", "complete"].includes(view);
  /* ⚠ ON EVERY STAGE, ABOVE THE BOARD — but as a CARD only when there is a plan
   * to read. A run you started on the Video stage must not vanish because you
   * clicked back to Characters: a plan is the one object on this page that is
   * about a NIGHT rather than about a screen, so the node is always here.
   *
   * What was wrong was painting the whole panel — heading, the paragraph
   * explaining what a plan is, the propose button — onto every stage of every
   * project whether or not one existed. §9 says the card belongs where a live
   * plan does. With none, this collapses to one line and one button: the door
   * stays open on every stage without a plan-shaped panel standing over a
   * project that has no plan. The id never moves, so paintPlanCard() promotes
   * the opener into the card in place the moment a plan appears — see
   * planCardClass(). */
  return `<div class="${planCardClass()}" id="planCard">${renderPlanInner()}</div>`
    + (wantBoard ? board : "");
}

function renderStage(view) {
  const d = wf.doc;
  if (d.kind === "audiobook") return renderAbStage(view);
  switch (view) {
    case "draft":
    case "upload_analyze": return renderSong();
    case "interview": return renderBrief();
    case "master_gen":
    case "story_review": return renderBible();
    /* Props share the cast stage — runTarget() has always said they do, and the
     * stage never painted them. See the props hint in renderAssets(). */
    case "characters": return renderAssets("characters") + renderAssets("props");
    case "backgrounds": return renderAssets("backgrounds");
    case "storyboards": return renderBoards();
    case "video": return renderClips();
    case "rough_cut":
    case "finish":
    /* Publish and Complete have no screen of their own yet (MV_UNBUILT): a
     * finished project opens on Finish & export, where its exports are. */
    case "publish":
    case "complete": return renderRoughCut();
    default:
      return `<div class="wfcard"><h3>${esc(labelFor(view))}</h3>
        <p class="hint">This stage has no screen yet. Everything before it works.</p></div>`;
  }
}

/* ─────────────────────────────── audiobook views ─────────────────────────── */

const VOICES = {
  kokoro: ["bm_george", "bm_fable", "bf_emma", "af_heart", "af_bella", "am_michael", "am_adam"],
  qwen3: ["Ryan", "Aiden", "design:custom"],
};

function renderAbStage(view) {
  const d = wf.doc;
  switch (view) {
    case "ingest": return `<div class="wfcard"><h3>Book in</h3>
      <p class="hint">Point at an .epub or .pdf on this machine. Chapters are read from
        the book's own structure; front matter is skipped automatically and every skip
        is visible and reversible in the chapter manager.</p>
      ${d.book ? `<div class="wfstats">
          <span><b>${esc(d.book.title)}</b> ${esc(d.book.author || "")}</span>
          <span><b>${d.book.chapters.filter((c) => !c.skip).length}</b> narratable chapters</span>
          <span><b>${d.book.chapters.reduce((a, c) => a + (c.skip ? 0 : c.words), 0).toLocaleString()}</b> words</span>
        </div>` : ""}
      <div class="framepick"><button class="edtool" id="abIngest">${d.book ? "Re-ingest…" : "Choose a book…"}</button></div>
    </div>`;

    case "plan": return `<div class="wfcard"><h3>Chapters &amp; plan</h3>
      <p class="hint">Whole chapters pack into MP3s of
        <input class="line sm num" id="abMin" type="number" value="${d.settings.targetMinMinutes}" style="width:44px">–<input
        class="line sm num" id="abMax" type="number" value="${d.settings.targetMaxMinutes}" style="width:44px"> minutes
        at ${d.settings.wpm} words a minute. A chapter is never split across files.</p>
      <div class="framepick"><button class="edtool" id="abPlan">${d.bundles.length ? "Re-plan" : "Plan the files"}</button></div>
      ${d.bundles.length ? `<table class="wftable"><thead><tr>
          <th>#</th><th>Contains</th><th>Words</th><th>≈ Minutes</th><th>Status</th></tr></thead><tbody>
        ${d.bundles.map((b) => `<tr><td>${b.idx + 1}</td><td class="wfthesis">${esc(b.title)}</td>
          <td>${b.words.toLocaleString()}</td><td>${b.estMinutes}</td><td>${esc(b.status || "planned")}</td></tr>`).join("")}
        </tbody></table>` : ""}
    </div>`;

    case "voice": {
      const v = d.voice || {};
      return `<div class="wfcard"><h3>Voice</h3>
      <p class="hint"><b>One voice narrates the whole book</b> — that is what keeps
        chapter forty sounding like chapter one, so it is chosen once and recorded on
        the project. Changing it later marks every narrated file stale rather than
        letting the book quietly drift.</p>
      <div class="params">
        <label for="abModel">engine</label>
        <span class="pv"><select id="abModel" class="sel2">
          <option value="kokoro"${v.model === "kokoro" ? " selected" : ""}>Kokoro — instant, 50+ personas</option>
          <option value="qwen3"${v.model === "qwen3" ? " selected" : ""}>Qwen3-TTS — richer, needs its models installed</option>
        </select></span>
        <label for="abPersona">voice</label>
        <span class="pv"><select id="abPersona" class="sel2">
          ${(VOICES[v.model || "kokoro"] || []).map((p) => `<option${v.persona === p ? " selected" : ""}>${p}</option>`).join("")}
        </select></span>
      </div>
      <div class="framepick"><button class="edtool" id="abSetVoice">Use this voice</button>
        <button class="edtool" id="abAudition" title="Every candidate reads the same line from THIS book — cast by ear">🎧 Audition voices</button></div>
      ${auditionOptions()}
      ${v.model ? `<p class="hint">Current: <b>${esc(v.model)} / ${esc(v.persona)}</b></p>` : ""}
      <div id="abAudStrip">${renderAuditionStrip()}</div>
    </div>${renderCastPanel()}`;
    }

    case "produce":
    case "complete": {
      // show bundles with work first, then the untouched tail (a 730-part book
      // must not bury its three narrated files under 727 planned ones)
      const active = d.bundles.filter((b) => b.narration?.length || b.mixFile || b.sfxSuggestions?.length);
      const rest = d.bundles.filter((b) => !active.includes(b)).slice(0, 12);
      const shown = [...active, ...rest];
      const bundleCards = shown.map((b) => {
        const cues = b.sfxSuggestions || [];
        const cueRows = cues.length ? `<ul class="cuelist">${cues.map((c) => `<li${c.real === false ? ' class="cuedead"' : ""}${c.why ? ` title="${esc(c.why)}"` : ""}>
            <span class="at">${Math.floor(c.at / 60)}:${String(Math.floor(c.at % 60)).padStart(2, "0")}</span>
            <b>${esc(c.label)}</b>${c.real === false ? " ✕" : (b.sfx || []).some((f) => f.label === c.label && Math.abs(f.at - c.at) < 1) ? " ✓" : ""}
            <span class="phrase">${esc(c.phrase || c.prompt)}</span></li>`).join("")}</ul>` : "";
        const voices = [...new Set((b.narration || []).map((n) => n.voice).filter(Boolean))];
        return `<div class="wcard bundlecard">
          <div class="wrow"><span class="wname">${b.idx + 1} · ${esc(b.title)}</span>
            <span class="wstatus" data-status="${esc(b.status || "planned")}">${esc(b.status || "planned")}</span></div>
          <div class="wrow"><span class="hint">${b.mixSeconds ? `${Math.round(b.mixSeconds / 60)} min mixed` : `≈ ${b.estMinutes} min`}
            ${voices.length ? ` · cast: ${voices.map(esc).join(", ")}` : ""}</span>
            <select class="sel2 sm" data-abusebed="${b.idx}" title="ambient bed">
              <option value="">bed: auto${b.suggestedMood ? ` (${esc(b.suggestedMood)})` : ""}</option>
              ${d.beds.map((x) => `<option value="${esc(x.id)}"${b.bedId === x.id ? " selected" : ""}>bed: ${esc(x.mood)}</option>`).join("")}
            </select></div>
          ${b.mixFile ? `<audio controls preload="none" src="/api/mv/abmix/${encodeURIComponent(d.slug)}/${b.idx}"></audio>` : ""}
          ${b.lrcFile ? `<span class="hint">📃 read-along .lrc beside the mp3</span>` : ""}
          ${cueRows}
          <div class="wrow">
            <span>
              <button class="edtool sm" data-abnarrate="${b.idx}">${b.narration?.length ? "↻ Narrate" : "Narrate"}</button>
              <button class="edtool sm" data-abmix="${b.idx}"${b.narration?.length ? "" : " disabled"}
                title="${b.narration?.length ? "Mix narration, bed and effects into the MP3" : "Narrate first"}">Mix mp3</button>
            </span>
            <span>
              <button class="edtool sm" data-absfxscan="${b.idx}"${b.narration?.length ? "" : " disabled"}
                title="${b.narration?.length ? "Scan the narration for sound-effect moments" : "Narrate first — cues are placed at the second a phrase is spoken"}">⚡ Find SFX</button>
              <button class="edtool sm" data-absfxjudge="${b.idx}"${cues.length ? "" : " disabled"}
                title="${cues.length ? "Grade the cues with the local model — figures of speech get struck out" : "Find cues first"}">⚖ Judge</button>
              <button class="edtool sm" data-absfxrender="${b.idx}"${cues.length ? "" : " disabled"}
                title="${cues.length ? "Render the cues with Stable Audio and attach them" : "Find (or set) cues first"}">Render SFX</button>
            </span>
          </div>
        </div>`;
      }).join("");

      return `<div class="wfcard"><h3>Narrate &amp; mix</h3>
      <p class="hint">Each file narrates (seconds — Kokoro runs ~30× realtime), then mixes
        with an ambient bed that <b>ducks under the voice</b> and loops without a seam.
        Beds are reusable across the whole book — same mood, same music, coherent album.
        <b>⚡ Find SFX</b> proposes effect cues from the narration itself; the list shows
        where each would land before any GPU is spent.</p>
      <div class="wgrid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${bundleCards}</div>
      ${d.bundles.length > shown.length ? `<p class="hint">${d.bundles.length - shown.length} untouched files not shown — narrate from the plan table or by MCP.</p>` : ""}
      <p class="hint">Finished MP3s land in <code>output/ab/${esc(d.slug)}/out/</code> —
        numbered, tagged, ${d.settings.targetMinMinutes}–${d.settings.targetMaxMinutes} minutes each, with a
        read-along .lrc beside each.</p>
    </div>`;
    }

    default: return `<div class="wfcard"><h3>${esc(labelFor(view))}</h3></div>`;
  }
}

/**
 * WHAT THEY READ, AND WHO READS IT — the two halves of an audition, and both
 * were agent-only.
 *
 * `text` is the one that matters. Judging a narrator on the server's stock
 * sentence about woodsmoke tells you what the voice sounds like reading a
 * sentence about woodsmoke; the whole point of an audition is the line from
 * THIS book that you are worried about — the one with the name you cannot
 * pronounce in it, or the dialogue that has to carry a scene. An agent could
 * ask for that and a person could not.
 *
 * `personas` is the smaller half: which voices are compared. Left alone, the
 * server compares its own seven, and that stays the default here — a ticked
 * list that started empty would silently audition nothing.
 *
 * ⚠ `data-audvoice`, NOT `data-audpick`: the results strip below already owns
 * `data-audpick` for its "Use as narrator" buttons, and one document holds
 * every tab's markup, so the same name would have put these checkboxes in that
 * loop and set the project's narrator by ticking a box.
 */
function auditionOptions() {
  const all = Object.entries(VOICES).flatMap(([model, list]) =>
    list.filter((p) => !p.startsWith("design:")).map((p) => ({ model, persona: p })));
  return `<details class="adv audopts">
    <summary>What they read, and who reads it — both were agent-only until now</summary>
    <label class="dfield"><span>audition line</span>
      <textarea class="wprompt" id="abAudText" rows="2" spellcheck="false"
        placeholder="left empty, the first real chapter's opening 220 characters are used"></textarea></label>
    <p class="hint dim">Every candidate reads exactly this, so the only thing that differs
      between the clips is the voice. Leave it empty and the server takes the opening of the
      first chapter you have not skipped — which is usually the right sentence, and is
      never the sentence you are actually worried about. The audio is cached on the text,
      so re-pressing with the same line costs nothing.</p>
    <div class="audvoices">${all.map(({ model, persona }) => `<label class="audvoice">
      <input type="checkbox" data-audvoice="${esc(model)}|${esc(persona)}">
      <span>${esc(persona)} <i class="dim">${esc(model)}</i></span></label>`).join("")}</div>
    <p class="hint dim">Tick none and the seven the server compares by default are used.
      Ticking is how you audition a shortlist twice on two different lines without waiting
      for the five you had already ruled out.</p>
  </details>`;
}

/** Audition results live in wf state (they are files on disk; the list is
 * cheap to rebuild by pressing the button again). */
function renderAuditionStrip() {
  const a = wf.audition;
  if (!a) return "";
  return `<p class="hint">Reading: <i>"${esc(a.sample.slice(0, 90))}…"</i></p>
    <div class="bedstrip">${a.voices.map((v) => `<div class="bedcard">
      <div class="wrow"><b>${esc(v.persona)}</b><span class="hint">${esc(v.model)}</span></div>
      <audio controls preload="none" src="/api/mv/asset/${encodeURIComponent(wf.slug)}/${encodeURIComponent(v.file)}"></audio>
      <button class="edtool sm" data-audpick="${esc(v.model)}|${esc(v.persona)}">Use as narrator</button>
    </div>`).join("")}</div>`;
}

/** Dialogue casting: named characters, their aliases, and who voices them. */
function renderCastPanel() {
  const d = wf.doc;
  const cast = d.cast || [];
  const personaOpts = (sel) => Object.entries(VOICES).flatMap(([m, list]) =>
    list.filter((p) => !p.startsWith("design:")).map((p) =>
      `<option value="${m}|${p}"${sel === `${m}|${p}` ? " selected" : ""}>${m} / ${p}</option>`)).join("");
  const rows = cast.map((c, i) => `<div class="castrow" data-castrow="${i}">
    <input value="${esc(c.name)}" placeholder="Character name" data-castname="${i}">
    <input value="${esc((c.aliases || []).join(", "))}" placeholder="aliases (the captain, …)" data-castalias="${i}">
    <select data-castvoice="${i}"><option value="">narrator reads them</option>
      ${personaOpts(c.voice ? `${c.voice.model}|${c.voice.persona}` : "")}</select>
    <button class="edtool sm" data-castdel="${i}" title="Remove">✕</button>
  </div>`).join("");
  return `<div class="wfcard"><h3>Dialogue casting <span class="hint">(optional)</span></h3>
    <p class="hint">Give named characters their own voices. A quoted line in a paragraph
      the book attributes to them — <i>"…," said Geralt</i> — is read in their persona;
      the prose and the "said X" tails stay with the narrator, and an unattributed
      back-and-forth alternates between the last two speakers. Aliases catch the book's
      other names for them ("the captain"). Applies on the next narrate.</p>
    ${rows || ""}
    <div class="framepick">
      <button class="edtool sm" id="abCastAdd">+ Add character</button>
      ${cast.length || rows ? `<button class="edtool sm" id="abCastSave">Save cast</button>` : ""}
    </div>
  </div>`;
}

/** The chapter manager: every chapter in the source, where it went, which
 * voice and bed its file used, and what remains — a 730-part webnovel has to
 * stay navigable, so it filters as you type and colors by state. */
function renderChapterManager() {
  const d = wf.doc;
  if (!d.book) return "";
  const bundleByCh = new Map();
  for (const b of d.bundles) for (const ci of b.chapterIdxs || []) bundleByCh.set(ci, b);
  const done = d.book.chapters.filter((c) => { const b = bundleByCh.get(c.idx); return b?.mixFile; }).length;
  const skipped = d.book.chapters.filter((c) => c.skip).length;

  const rows = d.book.chapters.map((c) => {
    const b = bundleByCh.get(c.idx);
    const status = c.skip ? "skipped" : b?.mixFile ? "mixed" : b?.narration?.length ? "narrated" : b ? "planned" : "unplanned";
    const bed = b?.bedId ? d.beds.find((x) => x.id === b.bedId)?.mood : null;
    const voices = b ? [...new Set((b.narration || []).map((n) => n.voice).filter(Boolean))] : [];
    return `<tr class="${c.skip ? "skip" : ""}" data-chtitle="${esc(c.title.toLowerCase())}">
      <td>${c.idx + 1}</td><td class="wfthesis">${esc(c.title)}</td>
      <td>${c.words.toLocaleString()}</td>
      <td><span class="wstatus" data-status="${status}">${status}</span>${b ? ` <span class="hint">file ${b.idx + 1}</span>` : ""}</td>
      <td class="hint">${bed ? `${esc(bed)} bed` : ""}${voices.length ? ` · ${voices.map(esc).join(", ")}` : ""}</td>
      <td><button class="edtool sm" data-abskip="${c.idx}">${c.skip ? "include" : "skip"}</button></td>
    </tr>`;
  }).join("");
  return `<div class="wfcard"><h3>Chapter manager</h3>
    <p class="hint"><b>${done}</b> of ${d.book.chapters.length} chapters are in finished
      MP3s${skipped ? `, ${skipped} skipped` : ""} — a half-finished book picks up exactly
      where it stopped, and each row shows which voice and bed its file used.</p>
    <input class="line chfilter" id="chFilter" placeholder="filter chapters…" autocomplete="off">
    <div class="chwrap"><table><thead><tr>
      <th>#</th><th>Chapter</th><th>Words</th><th>State</th><th>Used</th><th></th></tr></thead>
      <tbody id="chRows">${rows}</tbody></table></div>
  </div>`;
}

/* ---- the relationship map (crime board) ---- */

/* ⚠ THE MAP IS FETCHED NOW, not built here.
 *
 * It used to be composed from `wf.doc` by a second graph builder in mvboard.js,
 * in parallel with the server's crimeBoard() that answers mv_crime_board. Two
 * builders, one document, different answers: neither drew props, and only the
 * server's knew about staleness — so the picture a person looked at and the
 * picture an agent read disagreed about whether a project's continuity held.
 * One round trip is a cheap price for them being the same picture, and it
 * closes a parity gap on the way: `crime_board` was an action no human control
 * could reach, and this is that control.
 *
 * Audiobooks still build client-side. abBoard() returns a different shape and
 * folding it in is a separate job with none of the same stakes — a bundle
 * cannot be missing its face. */
async function loadCrimeBoard(host) {
  const d = wf.doc;
  if (!d) return;
  if (d.kind === "audiobook") {
    const model = abBoardModel(d);
    if (!model.nodes.length) {
      host.innerHTML = `<p class="hint">Nothing on the board yet — it fills in as the files exist.</p>`;
      return;
    }
    mountBoard(host, model);
    return;
  }
  let payload;
  try {
    payload = await api({ action: "crime_board", slug: wf.slug });
  } catch (err) {
    /* Say which half failed. "Nothing here yet" for a map that could not be
     * fetched is the same lie by omission the old builder told about props. */
    host.innerHTML = `<p class="hint warnhint">Could not load the map: ${esc(explain(err))}</p>`;
    return;
  }
  /* ⚠ THIS PAGE IS SERVED STATICALLY AND THE ROUTES ARE NOT.
   *
   * web/ is read off disk on every reload; server/ is loaded once at boot. So
   * between editing the map and restarting the app there is a window where the
   * NEW client is talking to the OLD crime_board, which answers a flat
   * {nodes, edges} with no lanes and no breaks. Painting that produces a
   * plausible-looking board with every node stacked in one row and no findings
   * at all — which is the single worst thing this screen can do, because its
   * whole job is to be believed when it says a project is clean.
   *
   * So the shape is checked and the mismatch is NAMED. One reload of the app
   * fixes it; a reader who does not know that would file a bug against the map. */
  if (!Array.isArray(payload.lanes) || !Array.isArray(payload.breaks)) {
    host.innerHTML = `<p class="hint warnhint">The map cannot be drawn: this page has been
      updated but the server is still running the previous build, which answers an older
      shape with no lanes and no continuity findings. <b>Restart the app</b> and it will
      paint. Nothing is wrong with the project.</p>`;
    return;
  }
  /* ⚠ THE MAP MUST NEVER DRAW AS WHOLE AN EDGE THE GPU WAS NOT HANDED.
   *
   * A cast → clip edge says "this sheet reached that render". On a clip that
   * rendered on an engine with no named-reference input it did not: the sheets
   * are resolved, listed, counted, and then not attached. The server is growing
   * a `sent` flag per edge; until every running build emits it, mvBoardModel
   * derives the same fact from the engine each clip node records — which is
   * what actually happened rather than what was configured. Either way a reader
   * is never shown a solid edge over an empty hand-over. */
  const model = mvBoardModel(payload, (f) => `/api/mv/asset/${encodeURIComponent(wf.slug)}/${encodeURIComponent(f)}`);
  if (!model.nodes.length) {
    host.innerHTML = `<p class="hint">Nothing on the board yet — it fills in as the cast, props, boards and clips exist.</p>`;
    return;
  }
  mountBoard(host, model);
}

/* ---- boards / clips / rough cut ---- */

/** Boards whose next draw sends NO reference sheets. Held here, by board id,
 *  because every draw repaints the page and a choice that lives only in the
 *  markup would be thrown away by the act of using it. Per session, not
 *  persisted: it is a choice about the next render, not a project setting. */
const singlePanel = new Set();
const SINGLE_TITLE = "Draws from the shot list and the style bible alone — no sheets attached (DIRECTING §2).";
const SHEETS_TITLE = "Attaches the referenced cast sheets. Measured 2026-08-28: handed a contact strip, the model draws the strip.";

function renderBoards() {
  const d = wf.doc;
  if (!d.boards.length) {
    return `<div class="wfcard"><h3>Storyboards</h3>
      <p class="hint warnhint">No boards yet — they arrive with the bible (Script &amp; direction).</p></div>`;
  }
  const cards = d.boards.map((b) => `<figure class="wfasset wide">
    ${b.imageFile ? `<img src="/api/mv/asset/${esc(wf.slug)}/${esc(b.imageFile)}" alt="">`
      : `<div class="wfnoimg">shot list only</div>`}
    <figcaption><b>board ${b.clipIndex + 1}</b> · ${(b.shots || []).length} shots
      ${b.staleRefs ? '<span class="warn">stale cast</span>' : ""}
      <button class="edtool sm" data-genboard="${esc(b.id)}"
        title="${singlePanel.has(b.id) ? SINGLE_TITLE : SHEETS_TITLE}">${b.takes?.length ? "↻ takes+" : "Draw it"}</button>
      ${/* THE SINGLE-PANEL SWITCH, on the one control whose route reads it.
          * Its state lives OUTSIDE the markup: drawing a board runs through
          * busy(), which reloads the project and repaints, so a switch that
          * only existed in the DOM would reset itself the moment you used it —
          * and the next board would silently go back to attaching sheets. */""}
      <label class="genopt"
        title="DIRECTING §2: a reference is a SINGLE PANEL. These sheets are contact strips, so attaching one makes the model redraw the strip instead of composing the shot. Ticked sends no sheets at all.">
        <input type="checkbox" data-singlepanel="${esc(b.id)}"${singlePanel.has(b.id) ? " checked" : ""}> single panel</label>
    </figcaption>
  </figure>`).join("");
  return `<div class="wfcard"><h3>Storyboards</h3>
    <p class="hint">The shot list is the payload — it writes the clip prompt. The picture
      is optional review material, composed FROM the character and background sheets so it
      carries their identity.</p>
    <p class="hint">⚠ <b>single panel</b> draws the board from the shot list and the style
      bible with <b>no sheets attached</b>. DIRECTING.md §2 asks for it: a reference is meant
      to be one panel, and these sheets are contact strips — handed a strip, the model
      reproduces the strip, three panels and all, instead of composing the shot the board
      describes. Measured 2026-08-28, and again across the boards that followed; the identical
      prompt with the sheets off produced the correct single frame with the look carried by
      the style bible alone. It is <b>off by default because that is what the server does</b>
      (generateAsset takes <code>refs = true</code>), not because it is the better answer —
      leave it off only when you want to see the strip effect for yourself.</p>
    <div class="wfassets">${cards}</div>
  </div>`;
}

function renderClips() {
  const d = wf.doc;
  const scenes = d.segments.filter((s) => s.mode === "generate");
  if (!scenes.length) return `<div class="wfcard"><h3>Video clips</h3><p class="hint">No scenes set to generate.</p></div>`;
  const rows = scenes.map((s) => {
    const clip = d.clips.find((c) => c.segmentId === s.id);
    const takes = clip?.takes?.length || 0;
    return `<tr>
      <td>${s.index + 1}</td>
      <td>${fmt(s.startSec)}–${fmt(s.endSec)}</td>
      <td class="wfthesis">${esc(s.thesisLine || (s.kind === "instrumental" ? "instrumental" : ""))}</td>
      <td>${clip?.clipFile ? `<a href="/api/clip/${encodeURIComponent(clip.clipFile)}" target="_blank">▶ ${esc(clip.engine || "")}</a>` : "—"}</td>
      <td>${takes ? `${takes} take${takes > 1 ? "s" : ""}` : ""}</td>
      <td>${d.boards.some((b2) => b2.segmentId === s.id)
        ? (clip?.status === "stale" ? '<span class="wstatus" data-status="stale" title="Rendered from an older board — regenerate">▦ stale</span>' : "▦")
        : '<span class="wstatus" data-status="skipped" title="No storyboard — falls back to a generic performance shot">no board</span>'}</td>
      ${/* ⚠ ONE RENDER, NOT TWO. This column used to carry its own Regen, and it
          * was a DIFFERENT render from the inspector's: it adopted whatever
          * prompt was stored and rolled a fresh seed, while the inspector held
          * the seed and sent the box. So "same seed, one sentence different" —
          * the only way to read what a prompt edit did — was a thing you could
          * do from one of the two buttons labelled Regen, and nothing said
          * which. There is now one control, and this opens it.
          *
          * A scene with nothing rendered keeps `generate_clip`: there is no
          * take to hold a seed from and no earlier prompt to compare against,
          * so the first render is a different act, not a weaker one. */""}
      <td>${clip?.clipFile
        ? `<button class="edtool sm" data-shotrender="${esc(s.id)}"
             title="Re-render this shot: hold the seed, choose which prompt, and see what changed. The same control the inspector uses — there is only one.">↻ Render…</button>`
        : `<button class="edtool sm" data-genclip="${esc(s.id)}">Generate</button>`}
        <button class="edtool sm" data-friendclip="${esc(s.id)}" title="Choose a friend and review this saved scene before preparing its render request. It carries the scene's reference pictures; the song stays here, so a lip-sync scene comes back without lip-sync. For one text-only clip outside a project, use Video → Ask friend.">Ask friend</button>
        <button class="edtool sm" data-shot="${esc(s.id)}"
          title="Open this one shot: the exact prompt it sends, which reference sheets actually resolved, and every take with the evidence for its own render">Inspect…</button>
        <button class="edtool sm" data-planadd="clip|${esc(s.id)}"
          title="Put this scene in a plan instead of rendering it now — nothing is spent until the plan is approved and started. One test render does not need a plan; a set of them does.">+ Plan</button></td>
    </tr>`;
  }).join("");
  const done = d.clips.filter((c) => c.clipFile).length;
  return `<div class="wfcard"><h3>Video clips</h3>
    <p class="hint">Render here or ask a friend.</p>
    <table class="wftable"><thead><tr><th>#</th><th>Time</th><th>Line</th><th>Clip</th><th>Takes</th><th>Board</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <details class="more"><summary>Shot details</summary><p class="hint"><b>Inspect</b> opens one shot on its own: the exact prompt that will be
      sent — editable, and what you edit is what renders — which reference sheets resolved
      and which names reached the render as nothing, and every take with the prompt and
      references that made it. Re-rendering from there keeps every earlier take.</p></details>
    <div id="wfShotEdit"></div>
    ${/* ⚠ WHERE A NIGHT IS DECIDED. One clip is a decision worth one clip's GPU
        * and its undo is not picking the take — press Generate and watch. A SET
        * of clips is a decision worth about ten hours, and until this existed it
        * was invisible until it had been spent. So: no plan for one render, a
        * plan the moment you are about to loop. */""}
    <div class="framepick planseed">
      <button class="edtool" type="button" data-planfrom="unrendered"
        title="Seeds a plan with one render per generate-mode scene that has no take. Nothing renders until you approve the items and press Run.">Plan the unrendered scenes</button>
      <button class="edtool" type="button" data-planfrom="stale"
        title="Seeds a plan from the same scan mv_regen_stale reports: every clip whose take predates its board or its cast.">Plan what's stale</button>
    </div>
    <details class="more"><summary>Plan details</summary><p class="hint">A <b>plan</b> is the list of renders somebody intends to make, with the engine,
      the size and the minutes per item, that you read and approve <b>before</b> the GPU is
      touched — and it shows, per scene, which references would reach the render as nothing.
      Use it when one intent spends more than one expensive call. A single test render does not
      need one: press Generate, or Inspect and render one shot.</p></details>
    ${done ? `<div class="framepick"><button class="edtool" id="wfToStudio">Move to Studio → (${done} scene${done > 1 ? "s" : ""}, chronological)</button></div>` : ""}
  </div>`;
}

/**
 * THE BEAT PULSE, and the gate it is subject to, said before it is pressed.
 *
 * `render_video.beatZoom` was reachable by NOBODY: eleven lines of route
 * comment about a confidence gate, and no caller on either side. That is worse
 * than a missing feature — a person greps the source, finds the pulse, and
 * cannot work out why nothing they do turns it on.
 *
 * ⚠ THE GATE IS REPORTED HERE, NOT DISCOVERED AFTERWARDS. The route silently
 * refuses to pulse when the beat grid's confidence is under 0.40, because
 * pulsing on a grid that is not really there reads as a fault in the encode
 * rather than as an edit. Discovering that from a video that came back without
 * the effect is the expensive way to learn it, so the confidence this project
 * actually measured is printed beside the control, and the select is disabled —
 * with the number in the sentence — when it is under the bar. The route still
 * checks; this only means nobody meets the refusal.
 */
const BEAT_BAR = 0.40;

function beatZoomControl() {
  const b = wf.doc.beats || {};
  const conf = Number(b.confidence) || 0;
  const bpm = Number(b.bpm) || 0;
  const usable = conf >= BEAT_BAR && bpm > 0;
  return `<label class="genopt" for="wfRenderZoom"
      title="Zoom the picture a little on each beat. The maximum is 8% — above that it stops reading as an edit.">
    pulse on the beat
    <select class="sel2 sm" id="wfRenderZoom"${usable ? "" : " disabled"}>
      <option value="0">off</option>
      <option value="0.02">gentle · 2%</option>
      <option value="0.04">clear · 4%</option>
      <option value="0.08">strong · 8% (the ceiling)</option>
    </select></label>`;
}

function beatZoomNote() {
  const b = wf.doc.beats || {};
  const conf = Number(b.confidence);
  const bpm = Number(b.bpm) || 0;
  const shown = Number.isFinite(conf) ? conf.toFixed(2) : "not measured";
  if (Number.isFinite(conf) && conf >= BEAT_BAR && bpm > 0) {
    return `<p class="hint dim">The pulse zooms the picture on the beat, off the bass envelope
      this song's own analysis measured — the tempo is never retyped, so the cut and the pulse
      cannot disagree about it. Beat confidence here is <b>${esc(shown)}</b>, above the
      <b>${BEAT_BAR}</b> bar, so it will apply.</p>`;
  }
  return `<p class="hint dim">The pulse is <b>off for this song</b>. Beat confidence is
    <b>${esc(shown)}</b>${bpm ? "" : " and no tempo was found"}, under the <b>${BEAT_BAR}</b> bar
    the route enforces — the same bar the "edit on the music" rule uses for snapping cuts.
    Pulsing on a grid this weak reads as a fault in the encode rather than as an edit, so the
    server would refuse it and this control says so instead of letting you find out from the
    finished file. Re-analyze after fixing the track's timing if you think the grid is better
    than this.</p>`;
}

function renderRoughCut() {
  const d = wf.doc;
  return `<div class="wfcard"><h3>Rough cut</h3>
    ${d.timelineProject
      ? `<p class="hint">This project's cut lives in Studio as
           <b>${esc(d.timelineProject)}</b> — open the Studio tab, load it, and edit like
           any project. Right-click any scene there for <b>Regenerate</b> (same shot,
           new seed) and <b>Takes</b> (cycle what you kept).</p>`
      : `<p class="hint">Not assembled yet — generate clips, then press Move to Studio on
           the Video clips stage.</p>`}
    <div class="framepick"><button class="edtool" id="wfToStudio">Rebuild the Studio timeline</button></div>
    <p class="hint">Rebuilding replaces the composed project with the scenes' CURRENT
      picks, chronologically; your Studio edits to a previous build are overwritten in
      that project, so save under another name first if you want to keep them.</p>
    ${d.timelineProject ? `
    <div class="framepick">
      <button class="edtool" id="wfRenderVideo">Render the finished video</button>
      <label class="hint" style="margin-left:10px">
        <input type="checkbox" id="wfRenderFade"> cross-dissolve the cuts
      </label>
      ${beatZoomControl()}
    </div>
    ${beatZoomNote()}
    <p class="hint" id="wfRenderNote">Composes the cut straight from the source clips —
      exactly the timeline's frame rate, and seconds of work rather than the video's own
      length. Studio's <b>Export video</b> still works and needs nothing installed, but it
      records the canvas in real time, so it takes as long as the song and cannot hold
      24 fps at this size. Needs ffmpeg.</p>` : ""}
  </div>`;
}

/* ---- stage 1: song ---- */

function renderSong() {
  const d = wf.doc;
  const opts = wf.library.map((t) =>
    `<option value="${esc(t.file)}"${d.song?.file === t.file ? " selected" : ""}>${esc(t.title || t.file)}</option>`).join("");
  const lines = d.lyricLines?.length || 0;
  return `<div class="wfcard">
    <h3>Upload &amp; analyze</h3>
    <p class="hint">Pick a finished track. Studio reads its timed lyrics and its beat
      grid — the lyrics decide where scenes begin and end, the beats let the cut snap
      to bars later.</p>
    <label class="flabel" for="wfSong">Song</label>
    <select id="wfSong" class="sel2"><option value="">Choose a track…</option>${opts}</select>
    <div class="wfstats">
      <span><b>${d.song ? esc(d.song.title) : "—"}</b> song</span>
      <span><b>${d.totalDurationSec ? fmt(d.totalDurationSec) : "—"}</b> length</span>
      <span><b>${lines || "—"}</b> lyric lines</span>
      <span><b>${d.beats?.bpm ? Math.round(d.beats.bpm) : "—"}</b> BPM</span>
    </div>
    ${d.song && !lines ? `<p class="hint warnhint">This track has no timed lyrics yet.
      Make them on the Music tab (the LRC step) and press Re-analyze — without them
      every scene is cut as instrumental.</p>` : ""}
    <div class="framepick">
      <button class="edtool" type="button" id="wfAnalyze"${d.song ? "" : " disabled"}>Re-analyze</button>
      <button class="edtool" type="button" id="wfSegment"${d.totalDurationSec ? "" : " disabled"}>Cut into scenes</button>
    </div>
    ${segmentDialog()}
    ${d.segments?.length ? renderSegments() : ""}
  </div>`;
}

/**
 * HOW THE CUT IS MADE — four numbers, and until now the button posted none.
 *
 * The cut is the shape of the whole video: how long a scene may run decides how
 * many clips there are, which decides what a night costs. `mv_segment` has
 * taken three of these since it was written and this page offered one button
 * with no arguments, so an agent chose the clip length and a person took 6.5
 * seconds and never knew there had been a choice. The fourth, `leadInSec`, was
 * reachable by nobody at all.
 *
 * EVERY BOX SHIPS EMPTY, and empty means "the default" — not zero. The route
 * only takes a number it can read as finite, so an untouched dialog posts a
 * body identical to yesterday's and cuts the song exactly as it always has.
 * The defaults are printed beside each field rather than prefilled for that
 * reason: a prefilled 15 would be indistinguishable from a chosen 15, and the
 * next person to change segmentation.js would find four numbers frozen into
 * this page's HTML.
 */
function segmentDialog() {
  /* The longest scene's default, where it comes from, and the ceiling are the
   * SERVER's (sizes.js sceneCutFor, through the project's cardFit), never a
   * number kept here. Without cardFit the box says the server decides. */
  const cut = wf.cardFit?.cut || null;
  const maxSec = Number(cut?.maxClipSec) || null;
  const ceiling = Number(cut?.hardCeilingSec) || null;
  const knob = (id, label, def, unit, why) => `
    <label class="segknob" for="${id}"><span>${esc(label)}</span>
      <span class="segin"><input class="line sm num" type="number" id="${id}" step="0.5" min="0"
        placeholder="${esc(def)}" spellcheck="false" autocomplete="off"><i>${esc(unit)}</i></span>
      <i class="planhint">${why}</i></label>`;
  return `<details class="adv segopts">
    <summary>How the cut is made — four numbers, and what each of them costs</summary>
    <div class="segknobs">
      ${knob("wfSegMax", "longest scene", maxSec ? String(maxSec) : "", "s",
        (maxSec
          ? `The longest one clip may run. Default ${maxSec} s, set by the brief's size and engine: `
            + `${esc(cut.why || "")} `
          : "The longest one clip may run. Studio's default could not be read; leave it empty to take it. ")
        + "It is taken when the song is cut: a size changed later keeps the cut it has until you cut again. "
        + "A line longer than this is split into back-to-back scenes, so nothing sung is left without a picture. "
        + (ceiling ? `${ceiling} s is the hard ceiling. ` : "")
        + "Lowering it makes more, shorter clips: more scenes to render, and a night that costs more.")}
      ${knob("wfSegMin", "shortest scene", "4", "s",
        "Below this a leftover is folded into its neighbour instead of becoming a scene of its "
        + "own, so long as the merge still fits under the ceiling. It exists to stop sub-second "
        + "slivers. Default 4.")}
      ${knob("wfSegLead", "lead-in", "0", "s",
        "How much audio before the first lyric line a scene is allowed to overlap backwards "
        + "into, so a vocal does not start on the cut. Default 0 — and until this box existed "
        + "nothing on either surface could send it, so 0 is the only value it has ever had.")}
      ${knob("wfSegGap", "instrumental gap", "6", "s",
        "How long a stretch with no words has to be before it becomes a scene of its own rather "
        + "than being absorbed by the line beside it. Default 6.")}
    </div>
    <p class="hint dim">Leave a box empty to take the default. <b>Cutting again writes a whole
      new set of scenes</b> — new ids, every mode back to Generate, every boundary you retimed
      by hand gone — and every board and clip built on the old cut is marked <b>stale</b> rather
      than deleted, so nothing is lost and nothing is silently repointed. Change these before
      the boards exist if you can.</p>
  </details>`;
}

function renderSegments() {
  const d = wf.doc;
  const rows = d.segments.map((s) => {
  /* What is actually ON this scene. A b-roll scene has no other way to say —
   * Generate refuses the mode by design, so without this the choice was a dead
   * end: the scene stayed empty and build_timeline dropped it silently. */
  const row = (d.clips || []).find((c) => c.segmentId === s.id);
  const cur = row?.clipFile || "";
  return `<tr data-seg="${esc(s.id)}">
    <td>${s.index + 1}</td>
    ${/* ⚠ THE BOUNDARIES ARE FIELDS, NOT A LABEL. update_segment has read
        * startSec and endSec since it was written and the only control this
        * page ever offered was the generate/broll/skip dropdown — so a person
        * could change how a scene was COVERED and not where it began or ended,
        * which is backwards: the times are the half a human can judge by
        * watching, and the mode is the half a plan can decide.
        *
        * Both boxes are sent on either change, because resnapSegment takes a
        * pair and reasons about the window as a whole. What it does with them
        * is under the table. */""}
    <td class="segtime">
      <input class="line sm num" type="number" step="0.1" min="0"
        data-segstart="${esc(s.id)}" value="${Number.isFinite(s.startSec) ? s.startSec : ""}"
        title="Where this scene starts, in seconds. Enter or click away to apply.">
      <span class="dim">–</span>
      <input class="line sm num" type="number" step="0.1" min="0"
        data-segend="${esc(s.id)}" value="${Number.isFinite(s.endSec) ? s.endSec : ""}"
        title="Where it ends. The pair is re-snapped by the server; see the note under the table.">
      ${/* `userAdjusted` is set by ANY update_segment write, a mode change
          * included, so the badge says "edited" and not "retimed" — it marks a
          * scene somebody touched since the cut, which is exactly what the flag
          * means and no more. */""}
      <br><span class="dim">${Number.isFinite(s.durationSec) ? `${s.durationSec.toFixed(1)}s` : "—"}${
        s.userAdjusted ? ' · <b class="segedited" title="Changed by hand since the cut — its mode, its boundaries, or both.">edited</b>' : ""}</span></td>
    <td>${s.kind === "lyrical" ? "🎤 lyrical" : "🎵 instrumental"}${s.hardCapped ? ' <span class="dim">hard cap</span>' : ""}</td>
    <td class="wfthesis">${esc(s.thesisLine || s.lyricText || "—")}</td>
    <td>
      <select class="sel2 sm" data-mode="${esc(s.id)}">
        <option value="generate"${s.mode === "generate" ? " selected" : ""}>Generate</option>
        <option value="broll"${s.mode === "broll" ? " selected" : ""}>B-roll</option>
        <option value="skip"${s.mode === "skip" ? " selected" : ""}>Skip</option>
      </select>
    </td>
    <td class="wffootage">${
      s.mode === "skip" ? '<span class="dim">—</span>'
      : s.mode === "broll"
        ? `${cur ? `<span class="dim">${esc(cur)}</span> ` : ""}<button class="edtool sm" type="button"
             data-broll="${esc(s.id)}">${cur ? "Change…" : "Choose…"}</button>`
        : cur ? `<span class="dim">${esc(cur)}</span>` : '<span class="dim">to render</span>'
    }</td>
  </tr>`;
  }).join("");
  const gen = d.segments.filter((s) => s.mode === "generate").length;
  return `<div class="wfseg">
    <h4>${d.segments.length} scenes · ${gen} to generate</h4>
    <div class="wfcov">${wf.coverage.map((c) =>
      `<i class="cov-${esc(c.kind)}" style="flex:${Math.max(0.4, c.endSec - c.startSec)}"
         title="${esc(c.kind)} ${fmt(c.startSec)}–${fmt(c.endSec)}"></i>`).join("")}</div>
    <table class="wftable"><thead><tr>
      <th>#</th><th>Time</th><th>Kind</th><th>Anchor line</th><th>Cover with</th><th>Footage</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Scenes never split a lyric line — that rule is the website's and it
      is ported exactly. Change how a scene is covered here; the choice follows through
      to the clip that renders it.</p>
    ${/* WHAT RETIMING IS SAFE, said where the boxes are rather than in a file
        * nobody opens. This is not reassurance: it is the list of things the
        * person does not have to check, which is what makes the two boxes
        * usable at all. */""}
    <p class="hint dim"><b>Typing a new start or end is safe</b> — the server re-snaps the
      pair rather than storing what you typed. It clamps both ends inside the song, swaps
      them if you put the end before the start, never lets the window exceed the
      <b>15-second hard ceiling</b> on one clip, then re-reads which
      lyric lines the new window covers: the scene's kind flips between lyrical and
      instrumental on its own, and a new anchor line is picked from what is actually
      inside it. A scene that has already rendered keeps its clip and is marked stale
      rather than being quietly re-cut under it.</p>
  </div>`;
}

/* ---- stage 2: the brief ---- */

/* ⚠ THE BRIEF'S SETTINGS, drawn from the server's cardFit (server/mv/routes.js)
 * and from no list kept in this file: the size list is sizes.js's, each size
 * says whether this card reaches it, the shapes are the two renderSize makes,
 * and the step labels are worded from the speed-up files on disk. Without
 * cardFit each control keeps only the brief's own value, and a line says the
 * PC's settings could not be read, rather than showing a guess. */
const NO_FIT = "Could not load this PC's settings (sizes, shapes, steps). Reload the page to see them.";

/* One size option's words, as it RENDERS in the chosen shape: 9:16 swaps the pair. */
function sizeOptionText(z, aspect) {
  const [w, h] = aspect === "9:16" ? [z.height, z.width] : [z.width, z.height];
  return `${z.label} · ${w}x${h}${z.experimental ? ", experimental" : ""}`
    + `${z.forCard ? " · Studio's pick for this card" : ""}${z.fits === false ? " · above this card" : ""}`;
}

function briefSize(b, fit) {
  const cur = b.qualityMode || "recommended";
  const sizes = fit?.sizes?.choices || [];
  const aspect = b.aspectRatio === "9:16" ? "9:16" : "16:9";
  const opts = sizes.length ? sizes.map((z) =>
    `<option value="${esc(z.id)}"${cur === z.id ? " selected" : ""}${z.line ? ` title="${esc(z.line)}"` : ""}>`
    + `${esc(sizeOptionText(z, aspect))}</option>`).join("")
    : `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  const chosen = sizes.find((z) => z.id === cur);
  /* Where a scene can land on LTX, what LTX makes of this size. */
  const mode = b.videoEngine || "hybrid";
  const ltxMatters = mode === "ltx" || (mode === "hybrid" && fit?.ltxReady);
  return `<div class="params">
      <label for="wfQuality">size</label>
      <span class="pv"><select id="wfQuality" class="sel2"
        title="The size every clip renders at. Stored as the brief's qualityMode; mv_set_brief quality sets it.">${opts}</select></span>
    </div>
    ${!fit ? `<p class="hint warnhint">${esc(NO_FIT)}</p>` : ""}
    ${fit?.sizes?.why ? `<p class="hint dim" title="${esc(chosen?.note || "")}">${esc(fit.sizes.why)}</p>` : ""}
    ${fit?.sizes?.ramWarning ? `<p class="hint warnhint">${esc(fit.sizes.ramWarning)}</p>` : ""}
    ${chosen?.line ? `<p class="hint warnhint">${esc(chosen.line)}</p>` : ""}
    ${ltxMatters && chosen?.ltxLine ? `<p class="hint dim">${esc(chosen.ltxLine)}</p>` : ""}
    ${fit?.cut?.note ? `<p class="hint warnhint">${esc(fit.cut.note)}</p>` : ""}`;
}

function renderBriefSettings() {
  const b = wf.doc.brief || {};
  const fit = wf.cardFit || null;
  const aspects = fit?.sizes?.aspects || [];
  const aspectNow = aspects.includes(b.aspectRatio) ? b.aspectRatio : (aspects[0] || b.aspectRatio || "");
  const aspectOpts = aspects.length
    ? aspects.map((a) => `<option${aspectNow === a ? " selected" : ""}>${esc(a)}</option>`).join("")
    : `<option selected>${esc(aspectNow)}</option>`;
  return `${briefSize(b, fit)}
    <div class="params">
      <label for="wfAspect">aspect</label>
      <span class="pv"><select id="wfAspect" class="sel2" title="The two shapes the renderer makes.">
        ${aspectOpts}
      </select></span>
    </div>
    ${fit?.aspectNote ? `<p class="hint warnhint">${esc(fit.aspectNote)}</p>` : ""}`;
}

function renderBrief() {
  const b = wf.doc.brief || {};
  const f = (id, label, val, ph) => `<label class="flabel" for="${id}">${label}</label>
    <input class="line" id="${id}" value="${esc(val || "")}" placeholder="${esc(ph)}">`;
  const fit = wf.cardFit || null;
  return `<div class="wfcard">
    <h3>Creative interview</h3>
    <p class="hint" title="An agent writes these through mv_set_brief.">What kind of video is
      this? Fill it in here, or ask an agent connected on the Agent page to talk it through
      with you and fill it in.</p>
    ${f("wfMedium", "Medium", b.medium, "anime, live action, claymation, 3D…")}
    ${f("wfTone", "Tone", b.tone, "melancholic, defiant, playful…")}
    ${f("wfNarrative", "Narrative approach", b.narrative, "one story, performance only, abstract…")}
    <label class="flabel" for="wfFree">Anything else</label>
    <textarea id="wfFree" rows="3" placeholder="Characters you have in mind, places, things to avoid…">${esc(b.freeText || "")}</textarea>
    <label class="flabel" for="wfDirection">Direction summary</label>
    <textarea id="wfDirection" rows="3" placeholder="Two or three sentences the director works from. The agent usually writes this.">${esc(b.directionSummary || "")}</textarea>
    ${renderBriefSettings()}
    <div class="params">
      <label for="wfEngine">engine</label>
      <span class="pv"><select id="wfEngine" class="sel2">
        ${[["hybrid", fit?.hybridLine || "hybrid — H3 where it matters"], ["ltx", "LTX — fast, everywhere"], ["h3", "H3 — best, ~10x cost"]]
          .map(([v, t]) => `<option value="${v}"${(b.videoEngine || "hybrid") === v ? " selected" : ""}>${esc(t)}</option>`).join("")}
      </select></span>
    </div>
    <div class="params">
      <label for="wfBase">base render</label>
      <span class="pv"><select id="wfBase" class="sel2">
        ${[["auto", "auto — half then upscale (fast)"], ["full", "full — sample at delivery size"]]
          .map(([v, t]) => `<option value="${v}"${(b.baseScale || "auto") === v ? " selected" : ""}>${t}</option>`).join("")}
      </select></span>
    </div>
    <div class="params">
      <label for="wfSteps">video steps</label>
      <span class="pv"><select id="wfSteps" class="sel2">
        ${/* The labels are the server's (clipsteps.js stepChoices): "default"
             names the count matched to the speed-up files on this PC, and "8"
             only calls itself the reference build to use when the 8-step
             reference file is here. A number under the loaded build's design
             point burns: 3 with references ran the 4-step build at three steps
             (Hex Appeal, 2026-09-19). */
          (wf.cardFit?.steps?.options
            || [{ value: String(b.videoSteps ?? ""), label: b.videoSteps == null ? "default" : String(b.videoSteps) }])
          .map((o) => `<option value="${esc(o.value)}"${String(b.videoSteps ?? "") === o.value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
      </select></span>
      ${/* ⚠ ITS OWN ID. It was "wfSong", the Upload & analyze song picker's id,
          so changing it posted attach_song with "always" as the file. */""}
      <span class="pv"><label class="hint">Song under the clip <select id="wfSongCond" class="sel2">
        ${/* The words only; the id and the values are kept. New projects start
            * on "always" (store.js blankProject, the REWIND A/B of 2026-09-24). */""}
        ${[["always", "always: every scene hears the song, so a singing mouth follows the words on H3 (Hex Appeal's setup; new projects start here). A close face that is not singing may open its mouth: keep “mouth closed” in its words"],
           ["auto", "auto: only boards marked as sung (lipSync; an agent sets it)"]]
          .map(([v, t]) => `<option value="${v}"${(b.songConditioning || "auto") === v ? " selected" : ""}>${t}</option>`).join("")}
      </select></label></span>
    </div>
    <div class="framepick"><button class="edtool" type="button" id="wfSaveBrief">Save brief</button></div>
  </div>`;
}

/* ---- stages 3-4: the bible ---- */

function renderBible() {
  const d = wf.doc;
  const has = !!d.styleBible;
  const boardRows = d.boards.map((b) => {
    const seg = d.segments.find((s2) => s2.id === b.segmentId) || {};
    const refs = [...(b.characterRefs || []), ...(b.backgroundRefs || []), ...(b.propRefs || [])]
      .map((n) => `${esc(n)} <i class="dim">${Math.round((b.refProminence?.[n] ?? 0.5) * 100) / 100}</i>`).join(", ");
    return `<tr><td>${(b.segmentIndex ?? 0) + 1}</td>
      <td>${fmt(seg.startSec)}–${fmt(seg.endSec)}</td>
      <td class="wfthesis">${esc(b.boardPrompt || "")}</td>
      <td>${(b.shots || []).length}</td>
      <td class="wfthesis">${refs || "—"}</td>
      <td>${b.imageFile ? (b.staleRefs ? '<span class="wstatus" data-status="stale">stale</span>' : "▦") : "—"}</td>
      <td><button class="edtool sm" type="button" data-editboard="${esc(b.segmentId)}">Edit…</button></td></tr>`;
  }).join("");
  return `<div class="wfcard">
    <h3>Script &amp; direction</h3>
    <p class="hint">The production bible: the story, the visual style, the reusable
      characters and backgrounds, and one storyboard per scene — <b>this is what steers
      the clips</b>. Once a bible exists, every part of it is editable here, and
      <b>a scene's shot <i>action</i> is what writes its clip</b>.</p>
    ${has ? "" : `<div class="hint" title="The agent reads the contract with mv_bible_spec and commits the bible with mv_set_bible.">
      <p><b>How to get one today:</b> this page has no form that writes a first bible yet, so the
      first script comes from an outside AI assistant:</p>
      <ol>
        <li>Open the <b>Agent</b> page and connect Claude Desktop, Claude Code or Cursor to Studio (it shows how, step by step).</li>
        <li>In that assistant, ask: <i>“Write the script for the music video ${esc(d.title || d.slug || "")}.”</i>
          It reads your scenes and the rules, and writes the whole bible in one go.</li>
        <li>Come back here: the story, the cast and one storyboard per scene appear on this card, and every part of it is editable.</li>
      </ol>
      <p>Studio's own Chat cannot do it, with a local or a cloud model, because its tool list leaves out
      tools that take a whole document. Without a script you can still press <b>Generate</b> on a scene
      under <b>Video clips</b>: it becomes a performance shot steered only by its lyric line.</p></div>`}
    ${has ? `
      <div class="params bibleform">
        <label for="wfLogline">logline</label>
        <span class="pv"><input class="line" id="wfLogline" value="${esc(d.story?.logline || "")}"
          placeholder="one sentence — what this video is"></span>
        <label for="wfSynopsis">synopsis</label>
        <span class="pv"><textarea class="wprompt" id="wfSynopsis"
          placeholder="the shape of the story">${esc(d.story?.synopsis || "")}</textarea></span>
        <label for="wfStyle">style</label>
        <span class="pv"><textarea class="wprompt" id="wfStyle"
          placeholder="the look every clip inherits">${esc(d.styleBible || "")}</textarea></span>
      </div>
      <div class="framepick"><button class="edtool" type="button" id="wfSaveStory">Save story &amp; style</button></div>
      ${d.boards.length ? `<table class="wftable"><thead><tr>
        <th>#</th><th>Time</th><th>Scene</th><th>Shots</th><th>References · prominence</th><th>Img</th><th></th></tr></thead>
        <tbody>${boardRows}</tbody></table>` : `<p class="hint warnhint">Bible has no boards yet.</p>`}`
      : `<p class="hint warnhint">No bible yet — clips rendered now fall back to a generic
        performance shot steered only by the lyric line.</p>`}
    <div id="wfBoardEdit"></div>
  </div>
  <div class="wfcard"><h3>Story review</h3>
    <p class="hint">The free pre-flight: everything that would waste GPU if rendered now.</p>
    <div id="wfLint"><p class="hint">Checking…</p></div>
  </div>`;
}

/* ---- the storyboard editor ----------------------------------------------
 *
 * One scene at a time, through set_board, which upserts a single board and
 * leaves the rest of the bible alone. upsertBoard REPLACES the board it is
 * given rather than merging, so this form always sends a complete one — a
 * partial send would silently drop the shots it did not mention.
 *
 * The reference names are offered as a CHOICE, never typed: both set_bible and
 * set_board reject a reference that is not a declared character or background,
 * and a rejection after the fact is a worse way to learn the rule than not
 * being able to break it. */
const SHOT_TYPES = ["wide", "medium", "close", "extreme close", "over-the-shoulder", "insert", "establishing"];

function boardShotRow(sh, i) {
  const f = (k, ph) => `<input class="line sm" data-shot="${i}|${k}" value="${esc(sh[k] || "")}" placeholder="${ph}">`;
  return `<div class="shotrow" data-shotrow="${i}">
    <select class="sel2 sm" data-shot="${i}|shotType">
      ${SHOT_TYPES.map((t) => `<option${(sh.shotType || "medium") === t ? " selected" : ""}>${t}</option>`).join("")}
    </select>
    ${f("angle", "angle")} ${f("cameraMove", "camera move")}
    ${f("lensFeel", "lens feel")} ${f("lighting", "lighting")}
    <textarea class="wprompt" data-shot="${i}|action"
      placeholder="what HAPPENS — this is the field that writes the clip">${esc(sh.action || "")}</textarea>
    <button class="edtool sm" type="button" data-shotdel="${i}">✕</button>
  </div>`;
}

/**
 * The camera vocabulary, fetched once per page.
 *
 * The MOVES come back whether or not Blender is installed, because the words
 * half needs none — so the plan control is always live and only the render
 * control is gated. Reaching the server at all can fail, and the fallback says
 * so rather than presenting an empty picker as "there are no moves".
 */
let previzCat = null;
/**
 * THE GRAY-BOX SETS, from the payload — never typed into this page.
 *
 * The board editor's set picker has always read `pz.scenes`; the PLAN item
 * editor's did not, it held its own seven names, and when the toolkit grew an
 * eighth set one picker on this page offered it and the other did not. Both now
 * read this. null means the payload has not landed yet, which the picker says
 * out loud rather than presenting an empty list as "there are no sets".
 */
let previzSets = null;
async function loadPrevizCat() {
  if (!previzCat) {
    try { previzCat = await (await fetch("/api/mv/previz")).json(); }
    catch { previzCat = { installed: false, why: ["could not reach the server"], moves: [], scenes: [] }; }
    previzSets = previzCat?.sets?.names || previzCat?.scenes || null;
    if (previzSets && !previzSets.length) previzSets = null;
  }
  return previzCat;
}

/**
 * THE CONTROL CATALOGUE, fetched once per page — and NOTHING about this path is
 * written into the page as a literal.
 *
 * The three numbers, the strength ladder, the ~32-minute cost and BOTH licence
 * answers arrive as payload from GET /api/mv/control, which is the same rule the
 * previz bar above holds and it exists for the same reason: a number typed into
 * a page goes stale silently. The ladder in particular was MEASURED — four arms
 * that really rendered — so a page printing its own copy would eventually be
 * describing renders nobody ever took.
 *
 * null means the server could not be reached, and the card is then simply not
 * offered. A control that appears and then withdraws when a payload lands is a
 * worse surface than one that was never there.
 */
let controlCat = null;
async function loadControlCat() {
  if (!controlCat) {
    try { controlCat = await (await fetch("/api/mv/control")).json(); }
    catch { controlCat = null; }
  }
  return controlCat;
}

/** The clips library, for the source picker. A control clip is a library NAME
 *  and never a path — a browser cannot hand a server one, which is the same
 *  reason the b-roll picker offers a list rather than a file field. */
async function loadLibraryVideos() {
  try {
    const r = await (await fetch("/api/clips")).json();
    return (r.clips || []).map((c) => c.name)
      .filter((x) => /\.(mp4|webm|mov|mkv|m4v)$/i.test(x));
  } catch { return []; }
}

async function openBoardEditor(segmentId) {
  const d = wf.doc;
  const seg = d.segments.find((s) => s.id === segmentId);
  const board = d.boards.find((b) => b.segmentId === segmentId) || { shots: [], characterRefs: [], backgroundRefs: [], propRefs: [], refProminence: {} };
  if (!seg) return;
  let shots = (board.shots || []).map((x) => ({ ...x }));
  const pz = await loadPrevizCat();
  /* Fetched with the move vocabulary, before the editor paints. `ctlRefs` are
   * this project's own rendered sheets: reference_image is an IMAGE input on
   * WanVaceToVideo, so a single panel goes there and a clip does not. */
  const ctl = await loadControlCat();
  const ctlClips = await loadLibraryVideos();
  const ctlRefs = [...(d.characters || []), ...(d.props || []), ...(d.backgrounds || [])]
    .map((x) => x.imageFile).filter(Boolean);
  /* The last verdict, so a repaint cannot silently re-arm the expensive button
   * for a clip that was refused. */
  let ctlVerdict = null;
  /* Both survive a repaint, so "add as shot" still has something to add after
   * the editor redraws itself — which it does on every + shot and every ✕. */
  let lastPlan = null, lastShot = null;

  const refRow = (x, kind) => {
    const list = kind === "c" ? board.characterRefs : kind === "p" ? board.propRefs : board.backgroundRefs;
    const on = (list || []).some((n) => n.toLowerCase() === x.name.toLowerCase());
    return `<label class="refpick"><input type="checkbox" data-ref="${kind}|${esc(x.name)}"${on ? " checked" : ""}>
      <span>${esc(x.name)}</span>
      <input class="line sm num" type="number" min="0" max="1" step="0.05" style="width:56px"
        data-prom="${esc(x.name)}" value="${board.refProminence?.[x.name] ?? 0.5}"></label>`;
  };

  const paintEditor = () => {
    $("wfBoardEdit").innerHTML = `<div class="wfcard boardedit">
      <h4>Scene ${(seg.index ?? 0) + 1} · ${fmt(seg.startSec)}–${fmt(seg.endSec)}</h4>
      <p class="hint">${esc(seg.thesisLine || seg.lyricText || "instrumental")}</p>
      <div class="params">
        <label for="bePrompt">scene</label>
        <span class="pv"><textarea class="wprompt" id="bePrompt"
          placeholder="what this scene is">${esc(board.boardPrompt || "")}</textarea></span>
        <label for="beGrade">grade</label>
        <span class="pv"><input class="line" id="beGrade" value="${esc(board.grade || "")}"
          placeholder="colour and mood"></span>
      </div>
      <p class="hint"><b>Cast &amp; places.</b> Only declared names can be referenced — add them
        on the Characters and Backgrounds stages first. The number is prominence: when a
        scene carries more references than the engine takes, the lowest are dropped first.</p>
      <div class="refpicks">
        ${d.characters.map((x) => refRow(x, "c")).join("")}
        ${d.backgrounds.map((x) => refRow(x, "g")).join("")}
        ${(d.props || []).map((x) => refRow(x, "p")).join("")}
        ${!d.characters.length && !d.backgrounds.length ? '<span class="dim">nothing declared yet</span>' : ""}
      </div>
      <p class="hint"><b>Shots.</b> The shot list is the payload.</p>
      <div id="beShots">${shots.map(boardShotRow).join("") || '<span class="dim">no shots yet</span>'}</div>

      <p class="hint"><b>Block the camera.</b> Name a move and <b>Words</b> writes it out —
        camera, framing, where in the frame the subject sits, and what the lens does. That is
        the half that reaches the model: the clip engine takes a prompt and reference pictures,
        never a camera path, so the sentence is the steering.
        <b>Block it</b> also renders a gray-box previz to watch before you spend render time on
        the real thing. The previz is for your eyes — it is never sent to the model, because a
        blocking clip handed to a video engine hands the gray boxes back.</p>
      <div class="framepick previzbar">
        <select class="sel2 sm" id="bePzMove" title="camera move">
          ${(pz.moves || []).filter((m) => !m.alias).map((m) =>
            `<option value="${esc(m.name)}">${esc(m.label)} — ${esc(m.gist)}</option>`).join("")}
        </select>
        <select class="sel2 sm" id="bePzFraming" title="framing">
          ${SHOT_TYPES.map((t) => `<option${t === "medium" ? " selected" : ""}>${t}</option>`).join("")}
        </select>
        <input class="line sm" id="bePzSubject" placeholder="subject" value="${esc(pzSubject())}">
        <select class="sel2 sm" id="bePzThird" title="which third of frame the subject holds">
          <option value="">centre</option><option value="left">left third</option><option value="right">right third</option>
        </select>
        <button class="edtool sm" type="button" id="bePzPlan">Words</button>
        <select class="sel2 sm" id="bePzScene" title="gray-box set to block in"${pz.installed ? "" : " disabled"}>
          ${(pz.scenes || []).map((s) => `<option${s === "corridor" ? " selected" : ""}>${esc(s)}</option>`).join("")}
        </select>
        <input class="line sm" id="bePzMoveArgs" placeholder="move args" style="width:150px"
          title="the move's own keyword arguments, KEY=VALUE space separated — aim_at=neck rise=6, degrees=75, framing=full. They steer the CLIP, not the words: an orbit with none sweeps the toolkit's default however wide you meant it. Legal keys are the move's own; the toolkit names them if you miss.">
        <button class="edtool sm" type="button" id="bePzBlock"${pz.installed ? "" : " disabled"}
          title="${pz.installed ? "Render a gray-box previz — about 25 seconds" : esc((pz.why || []).join(" "))}">Block it</button>
        <button class="edtool sm" type="button" id="bePzBlockout"${pz.installed ? "" : " disabled"}
          title="${pz.installed ? esc(pz.blockout?.why || "") : esc((pz.why || []).join(" "))}">Blockout</button>
      </div>
      <p class="hint dim"><b>Block it</b> renders the clip you watch. <b>Blockout</b> renders
        the same grey boxes at the control contract —
        ${esc(pz.blockout?.frames ?? 0)} frames, marked
        <b>${esc(pz.blockout?.use || "")}</b> — and files it against this shot so the control
        card below can steer with it. Two files, two sidecars: neither replaces the other.</p>
      <details class="pzspec">
        <summary>Staging — who stands where <i class="dim">(${esc(pz.spec?.units || "")})</i></summary>
        <p class="hint dim">Leave every row off and the set stages itself the way it always
          has. Tick one and it replaces the set's own — the seven sets stay presets, and the
          camera stays on the move above. ${esc(pz.spec?.walk || "")}</p>
        <div class="specrows">${specFigureRows()}${specPropRows()}</div>
      </details>
      ${pz.installed ? "" : `<p class="hint dim">No previz render: ${esc((pz.why || []).join(" "))}
        The words above need none of it.</p>`}
      <div id="bePzOut"></div>

      ${ctl ? `
      <p class="hint"><b>Or steer it with a real video.</b> The previz above is for your eyes
        only — a grey-box clip handed to a video model hands the grey boxes back. This is the
        opposite door: a real clip goes on WAN 2.1 VACE's <code>control_video</code> and the
        render <i>follows</i> it. Camera-motion agreement
        <b>${esc(ctl.operatingPoint.CMA.toFixed(3))}</b> against its own
        ${esc(ctl.operatingPoint.CMA_null_kind)} null of
        ${esc(ctl.operatingPoint.CMA_null)} and a pass floor of ${esc(ctl.operatingPoint.CMA_floor.toFixed(2))}, and still generating rather than
        reconstructing. Turning the control off is not that null and scores far worse:
        the strength-${esc(ctl.operatingPoint.CMA_zero_strength_arm)} arm at 0.00 scored
        ${esc(ctl.operatingPoint.CMA_zero_strength)}. About <b>${esc(Math.round(ctl.cost.vaceMinutes))} minutes</b> of GPU per render.</p>
      <p class="hint"><b>The clip contract, and all three of these fail silently.</b> A source clip
        must be exactly ${esc(ctl.spec.width)}x${esc(ctl.spec.height)}, exactly
        ${esc(ctl.spec.fps.toFixed(3))} fps and at least ${esc(ctl.spec.minFrames)} frames.
        Nothing warns you: a wrong size is centre-cropped, a short clip is padded with flat grey
        so the end of the shot conditions on nothing, and the frame rate is never read at all.
        <b>Check clip</b> measures it and spends nothing.</p>
      <div class="framepick ctlbar">
        <select class="sel2 sm" id="beCtlSource" title="where the steering frames come from">
          ${(ctl.sources || []).map((x) =>
            `<option value="${esc(x.source)}" title="${esc(x.what)}">${esc(x.where)}</option>`).join("")}
        </select>
        <select class="sel2 sm" id="beCtlClip" title="the clip that steers the render">
          <option value="">source clip…</option>
          ${ctlClips.map((c) => `<option>${esc(c)}</option>`).join("")}
        </select>
        <select class="sel2 sm" id="beCtlMode" title="what to do with it">
          ${ctl.modes.filter((m) => m.mode !== "check").map((m) =>
            `<option value="${esc(m.mode)}" title="${esc(m.what)}">${esc(m.mode)} — ~${esc(m.costMinutes)} min</option>`).join("")}
        </select>
        <input class="line sm" id="beCtlPrompt" placeholder="what to render" style="min-width:200px">
        <select class="sel2 sm" id="beCtlRef"
          title="a rendered sheet on reference_image. ⚠ No gate arm ever supplied one, so what it does to the camera score is unmeasured.">
          <option value="">no reference</option>
          ${ctlRefs.map((f) => `<option>${esc(f)}</option>`).join("")}
        </select>
        <input class="line sm num" id="beCtlStrength" type="number" step="0.05" min="0" max="2"
          style="width:70px" value="${esc(ctl.operatingPoint.strength)}"
          title="${esc(ctl.ladder.map((r) => r.strength.toFixed(2) + " " + r.reads).join(" | "))}">
        <select class="sel2 sm" id="beCtlDepthModel"
          title="which Depth Anything V2 reads the clip in the depth modes — Small is Apache-2.0 and the default; Large is CC-BY-NC-4.0, non-commercial">
          ${Object.values(ctl.licence?.depth?.models || {}).map((m) =>
            `<option value="${esc(m.key)}"${m.key === (ctl.licence?.depth?.default || "small") ? " selected" : ""} title="${esc(m.reads)}">depth: ${esc(m.key)} · ${esc(m.licence)}</option>`).join("")}
        </select>
        <input class="line sm num" id="beCtlStart" type="number" min="0" step="0.5" style="width:84px" placeholder="start s"
          title="conform only: the second of the source the 121-frame (5.04 s) window starts at — the render uses no more than that">
        <input class="line sm num" id="beCtlSeed" style="width:92px" placeholder="seed"
          title="leave it blank and one is minted, returned and recorded — this path exists to be reproducible">
        <button class="edtool sm" type="button" id="beCtlCheck">Check clip</button>
        <button class="edtool sm" type="button" id="beCtlGo" disabled
          title="check a source clip first — the three numbers fail silently">Steer it</button>
      </div>
      <p class="hint dim"><b>Strength, measured — every rung is an arm that really rendered:</b>
        ${ctl.ladder.map((r) => esc(r.strength.toFixed(2)) + " " + esc(r.reads)
          + (r.strength === ctl.operatingPoint.strength ? " <b>(the default)</b>" : "")).join(" · ")}</p>
      <p class="hint dim"><b>Licence — two answers, and one must never speak for the other.</b>
        WAN 2.1 VACE is <b>${esc(ctl.licence.vace.class)}</b>${ctl.licence.vace.verified
          ? ", verified against the licence text itself" : ", unverified"} — a clip rendered here is
        yours to sell. The DWPose estimator, which draws the skeletons in the
        <b>pose</b> and <b>extract</b> modes only, is <b>${esc(ctl.licence.pose.class)}</b>: its
        redistributor ships no readable licence at all, so that half is not settled.${ctl.licence?.depth ? ` The
        Depth Anything V2 estimator, which draws the depth in the <b>depth</b> and <b>extract_depth</b>
        modes, is <b>${esc(ctl.licence.depth.class)}</b> as Small — the default, Apache-2.0 by its
        authors' own statement — and <b>non-commercial</b> as Large (CC-BY-NC-4.0); the select above
        says which one a depth video came from, and the record keeps it. ⚠ No depth arm has been
        scored: the pose gate's number does not transfer.` : ""}</p>
      <div id="beCtlOut"></div>` : `
      <p class="hint dim">The control catalogue could not be read from the server, so the control
        card is not offered. Nothing about that path is guessed here.</p>`}

      <div class="framepick">
        <button class="edtool sm" type="button" id="beAdd">+ shot</button>
        <button class="edtool" type="button" id="beSave">Save scene</button>
        <button class="edtool sm" type="button" id="beCancel">Close</button>
      </div>
    </div>`;

    $("beAdd").onclick = () => { readShots(); shots.push({ shotType: "medium", action: "" }); paintEditor(); };
    for (const b of document.querySelectorAll("[data-shotdel]")) {
      b.onclick = () => { readShots(); shots.splice(Number(b.dataset.shotdel), 1); paintEditor(); };
    }

    /* ── the previz bar ──────────────────────────────────────────────────
     * Two buttons because there are two costs. Words are free and need no
     * Blender, so that control is never disabled; blocking spends a
     * subprocess and about 25 seconds, so it is the one that goes grey when
     * Blender is missing, with the reason in its tooltip rather than a
     * failure a minute later. */
    const pzArgs = () => ({
      move: $("bePzMove").value, framing: $("bePzFraming").value,
      subject: $("bePzSubject").value.trim() || undefined,
      third: $("bePzThird").value || undefined,
    });

    /* ── THE BLOCKING SPEC, READ OFF THE FIELDS ─────────────────────────
     *
     * Returns undefined when nothing is staged, and that is not the same as
     * an empty spec: `{figures: []}` REMOVES the set's own figures, which is
     * a real thing to ask for and not what somebody who touched nothing
     * meant. So an untouched editor sends no spec at all and the preset
     * stages itself, exactly as it did before this control existed.
     *
     * `set` is not read from a field — it is the scene select, which is the
     * one already on screen. Two places to name the set is two places that
     * can disagree, and the server refuses that disagreement rather than
     * picking a winner. */
    /* ── THE MOVE'S OWN KEYWORDS, OFF ONE FIELD ────────────────────────
     *
     * KEY=VALUE space separated, which is the toolkit's OWN syntax — it
     * publishes it as `move_arg_syntax` ("value parsed as JSON or kept as a
     * string"), and that rule is two lines long precisely so a caller on
     * this side of the boundary can reproduce it exactly. `aim_at=neck
     * rise=6` is what a director types; {"aim_at":"neck","rise":6} is what a
     * programmer types, and the server takes the object either way.
     *
     * Only the FIRST `=` splits, so a value may contain one. An empty field
     * sends NOTHING rather than {} — the same distinction readSpec() makes
     * below, and for the same reason: nobody who touched no control meant
     * to say anything about the camera's arguments. */
    const readMoveArgs = () => {
      const raw = ($("bePzMoveArgs")?.value || "").trim();
      if (!raw) return undefined;
      const out = {};
      for (const tok of raw.split(/\s+/)) {
        const i = tok.indexOf("=");
        if (i < 1) {
          throw new Error(`Move args are KEY=VALUE, space separated — "${tok}" is neither. `
            + "Example: aim_at=neck rise=6");
        }
        const k = tok.slice(0, i), v = tok.slice(i + 1);
        try { out[k] = JSON.parse(v); } catch { out[k] = v; }
      }
      return out;
    };

    const specNum = (id, dflt = 0) => {
      const v = Number(($(id)?.value ?? "").trim());
      return Number.isFinite(v) ? v : dflt;
    };
    const readSpec = () => {
      const figures = [], props = [];
      for (const cb of document.querySelectorAll("[data-specfig]")) {
        if (!cb.checked) continue;
        const i = cb.dataset.specfig;
        const row = { id: cb.dataset.specid,
                      at: [specNum(`bePzFX${i}`), specNum(`bePzFY${i}`), 0] };
        if ($(`bePzFW${i}`)?.checked) row.to = [specNum(`bePzFTX${i}`), specNum(`bePzFTY${i}`), 0];
        const h = specNum(`bePzFH${i}`, 0);
        if (h > 0) row.height = h;
        figures.push(row);
      }
      for (const cb of document.querySelectorAll("[data-specprop]")) {
        if (!cb.checked) continue;
        const i = cb.dataset.specprop;
        props.push({ id: cb.dataset.specid, kind: $(`bePzPK${i}`).value,
                     at: [specNum(`bePzPX${i}`), specNum(`bePzPY${i}`), 0],
                     size: [specNum(`bePzPW${i}`, 1), specNum(`bePzPD${i}`, 1),
                            specNum(`bePzPH${i}`, 1)] });
      }
      if (!figures.length && !props.length) return undefined;
      const out = {};
      if (figures.length) out.figures = figures;
      if (props.length) out.props = props;
      return out;
    };

    /* Not busy(): that one reloads the whole project and repaints the stage,
     * and half-typed shot fields in this editor would go with it. These two
     * write nothing a repaint needs to show — previz_plan writes nothing at
     * all — so they take the busy CLASS and leave the document alone. */
    const pzRun = async (body) => {
      const el = $("wfBody");
      el.classList.add("wfbusy");
      try { return await api(body); } finally { el.classList.remove("wfbusy"); }
    };

    $("bePzPlan").onclick = async () => {
      try {
        /* THE MOVE ARGS RIDE THE FREE CALL TOO. This button is the preview a
         * person reads BEFORE spending a render, and it used to preview the
         * DEFAULT move: the same `move args` field that steers the two buttons
         * below it was never sent here, so the words on screen said "arcs 90°"
         * while the clip that followed swept 75°. Same field, same reader. */
        const r = await pzRun({ action: "previz_plan", moveArgs: readMoveArgs(), ...pzArgs() });
        lastPlan = r.plan; lastShot = r.plan.board_shot;
        paintPz();
      } catch (err) { alert(err.message); }
    };

    $("bePzBlock").onclick = async () => {
      try {
        const r = await pzRun({
          action: "previz_shot", slug: wf.slug, segmentId, scene: $("bePzScene").value,
          spec: readSpec(), moveArgs: readMoveArgs(), ...pzArgs(),
        });
        lastPlan = r.plan; lastShot = r.plan.board_shot;
        paintPz(r);
      } catch (err) { alert(err.message); }
    };

    /* THE SAME CALL WITH ONE FLAG, because it is the same render. Splitting
     * the blockout into its own action would put a second name in the parity
     * census for one capability and let it drift behind the first; what
     * differs is the flag, the frame floor and the sidecar, and all three
     * live on the server where the contract does. */
    $("bePzBlockout").onclick = async () => {
      try {
        const r = await pzRun({
          action: "previz_shot", slug: wf.slug, segmentId, scene: $("bePzScene").value,
          blockout: true, spec: readSpec(), moveArgs: readMoveArgs(), ...pzArgs(),
        });
        lastPlan = r.plan; lastShot = r.plan.board_shot;
        paintPz(r);
        /* A fresh blockout is a new source for the card below, and the card
         * arms on a verdict about a PARTICULAR source. Clear it, or Steer it
         * would still be armed from the measurement of the file this one
         * just replaced. */
        ctlVerdict = null;
        if ($("beCtlGo")) $("beCtlGo").disabled = true;
      } catch (err) { alert(err.message); }
    };

    /* ── the control card ────────────────────────────────────────────────
     *
     * TWO BUTTONS, TWO COSTS — the same shape as the previz bar above, and here
     * the gap is two orders of magnitude. Check measures the clip with ffprobe
     * and spends nothing; Steer it spends about half an hour of one GPU. So the
     * expensive one stays DISABLED until the cheap one has said the clip is
     * legal, and the refusal is printed in the card rather than thrown into an
     * alert — because the refusal names which of the three numbers is wrong and
     * what it has to be. Somebody told "frame count is 96, must be at least 121"
     * fixes it once; somebody told "failed" re-renders twice. */
    if ($("beCtlCheck")) {
      /* The three fields both calls share. The `action` key is NOT in here: it
       * belongs at each call site, so a reader — and server/mv/ui_test.js's
       * parameter census, which finds a body by that literal — can see what each
       * button really posts. */
      /* TWO DOORS, AND THE BODY SAYS WHICH. `clip` is dropped entirely on the
       * blockout door rather than sent empty: the server refuses a `clip` it
       * has nowhere to put, which is the same rule it holds for a reference
       * on a mode that renders no image. */
      const ctlBody = () => ({
        slug: wf.slug, segmentId, source: $("beCtlSource").value,
        clip: $("beCtlSource").value === "blockout" ? undefined : $("beCtlClip").value,
      });
      const paintCtl = (html) => { $("beCtlOut").innerHTML = html; };
      /* THE VERDICT IS ABOUT ONE SOURCE, so the key is the whole door and not
       * just the clip name: switching to the blockout with a passing verdict
       * for a library clip would leave the expensive button armed for a file
       * nobody measured. */
      const ctlKey = () => `${$("beCtlSource").value}|${$("beCtlSource").value === "blockout"
        ? `blockout:${segmentId}` : $("beCtlClip").value}`;
      const armed = () => {
        const same = ctlVerdict && ctlVerdict.key === ctlKey();
        /* `conform` is the one mode that exists FOR a failing check: it takes
         * the refused clip and writes one that passes. So it arms on a chosen
         * library clip rather than on a green verdict, and never on a
         * blockout, which is at the contract already. */
        if ($("beCtlMode").value === "conform") {
          $("beCtlGo").disabled = $("beCtlSource").value === "blockout" || !$("beCtlClip").value;
          return;
        }
        $("beCtlGo").disabled = !(same && ctlVerdict.ok);
      };
      $("beCtlMode").onchange = () => armed();
      $("beCtlClip").onchange = () => { ctlVerdict = null; paintCtl(""); armed(); };
      $("beCtlSource").onchange = () => {
        ctlVerdict = null; paintCtl("");
        $("beCtlClip").disabled = $("beCtlSource").value === "blockout";
        armed();
      };
      $("beCtlClip").disabled = $("beCtlSource").value === "blockout";

      $("beCtlCheck").onclick = async () => {
        if ($("beCtlSource").value !== "blockout" && !$("beCtlClip").value) {
          alert("Choose a source clip first."); return;
        }
        try {
          const r = await pzRun({ action: "control_render", ...ctlBody(), mode: "check" });
          ctlVerdict = { key: ctlKey(), clip: r.clip, ok: r.ok };
          const v = r.validation || {};
          paintCtl(r.ok
            ? `<div class="ctlok"><b>${esc(r.clip)}</b> passes: ${esc(v.width)}x${esc(v.height)}, ${esc(Number(v.fps).toFixed(3))} fps, ${esc(v.frames)} frames. Nothing was rendered.</div>`
            : `<div class="ctlbad"><pre>${esc(r.why)}</pre><p class="hint dim">Measured, not rendered — this cost nothing.</p></div>`);
          armed();
        } catch (err) {
          ctlVerdict = null; armed();
          paintCtl(`<div class="ctlbad"><pre>${esc(err.message)}</pre></div>`);
        }
      };

      $("beCtlGo").onclick = async () => {
        const mode = $("beCtlMode").value;
        const row = (ctl.modes || []).find((m) => m.mode === mode);
        /* THE COST, SAID OUT LOUD, BEFORE THE CLICK COMMITS. Half an hour of the
         * one GPU is the longest thing this application does, and a confirm is
         * the cheapest possible guard against starting it by accident. */
        if (!(await appConfirm(`${mode} control render: about ${row ? row.costMinutes : "?"} minutes of GPU${row && row.renders > 1 ? " (two renders)" : ""}. Start it?`))) return;
        try {
          const r = await pzRun({
            action: "control_render", ...ctlBody(), mode,
            prompt: $("beCtlPrompt").value.trim() || undefined,
            reference: $("beCtlRef").value || undefined,
            strength: Number($("beCtlStrength").value),
            model: $("beCtlDepthModel")?.value || undefined,
            start: $("beCtlStart")?.value.trim() ? Number($("beCtlStart").value) : undefined,
            seed: $("beCtlSeed").value.trim() ? Number($("beCtlSeed").value) : undefined,
          });
          paintCtlResult(r);
        } catch (err) {
          paintCtl(`<div class="ctlbad"><pre>${esc(err.message)}</pre></div>`);
        }
      };
      armed();
    }

    /* What came back, INCLUDING the operating point. The seed and the strength
     * are the only handles on reproducing a render this expensive, so they are
     * shown rather than filed away — and when the strength is off the measured
     * point the card says so, because the gate's numbers are then about a
     * different graph. */
    function paintCtlResult(r) {
      /* A CONFORM WROTE A CLIP, NOT A RENDER: show it, its numbers before
       * and after, and the next step — pick it, Check it, steer. */
      if (r.conformed) {
        const c = r.conformed;
        $("beCtlOut").innerHTML = `<div class="ctlplan">
          <video src="/api/clip/${encodeURIComponent(c.file)}" controls loop muted playsinline></video>
          <p class="hint"><b>${esc(c.file)}</b> — conformed from ${esc(c.from.width)}x${esc(c.from.height)} at
            ${esc(Number(c.from.fps).toFixed(3))} fps (${esc(c.from.frames)} frames) to ${esc(c.width)}x${esc(c.height)} at
            ${esc(Number(c.fps).toFixed(3))} fps, ${esc(c.frames)} frames from ${esc(c.start || 0)} s in, in ${esc(c.seconds)} s; sound dropped. It is in
            the clip library: pick it as the source clip, <b>Check clip</b>, then steer.</p></div>`;
        return;
      }
      if (r.note && !r.render && !r.pose && !r.depth) { $("beCtlOut").innerHTML = `<p class="hint">${esc(r.note)}</p>`; return; }
      const out = r.render || r.pose || r.depth;
      const op = r.operatingPoint;
      if (!out) { $("beCtlOut").innerHTML = `<p class="hint dim">Nothing came back.</p>`; return; }
      /* WHICH DOOR, AND WHAT STAGED IT. A control render is reproducible from
       * its seed and its strength; it is only EXPLICABLE from what the
       * control clip was — and for a blockout that is a spec hash, not a
       * filename somebody may overwrite tomorrow. */
      const from = r.blockout
        ? `<p class="hint dim">Steered by this shot's blockout <b>${esc(r.clip)}</b>
            (${esc(r.blockout.move)} on ${esc(r.blockout.scene)}), staging
            <code>${esc((r.blockout.specSha256 || "the set's own").slice(0, 12))}</code>${
            r.blockout.candidates?.length > 1
              ? ` — the newest of ${esc(r.blockout.candidates.length)} on this shot` : ""}.</p>`
        : "";
      const pose = r.pose && r.render
        ? `<p class="hint dim">Skeleton: <b>${esc(r.pose.file)}</b>, ${esc(Math.round(r.pose.seconds || 0))} s — it is in the clip library and is itself a valid control clip.</p>` : "";
      const cav = (r.mode === "pose" || r.mode === "extract") && ctl && ctl.poseGate
        ? `<details class="ctlcav"><summary>What the pose gate does <b>not</b> cover — only ${esc(ctl.poseGate.framesScored)} of ${esc(ctl.poseGate.frames)} frames could be scored</summary><ul>${ctl.poseGate.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>` : "";
      $("beCtlOut").innerHTML = `<div class="ctlplan">
        <video src="/api/clip/${encodeURIComponent(out.file)}" controls loop muted playsinline></video>
        <p class="hint"><b>${esc(out.file)}</b> — ${esc(Math.round(out.seconds || 0))} s, run
          <code>${esc(out.runId)}</code>. It is in the clip library with its whole record.</p>
        ${from}
        ${pose}
        ${r.depth && r.render ? `<p class="hint dim">Depth video: <b>${esc(r.depth.file)}</b> (${esc(r.depth.model?.key || "")}, ${esc(r.depth.model?.licence || "")}), ${esc(Math.round(r.depth.seconds || 0))} s — in the clip library, itself a valid control clip. ⚠ Unscored path: watched, not measured.</p>` : ""}
        ${op ? `<p class="hint dim">strength ${esc(op.strength)} · masks ${esc(op.masks)} · seed <b>${esc(op.seed)}</b> · ${esc(op.width)}x${esc(op.height)} · ${esc(op.frames)} frames ${op.measured ? "— the measured operating point" : "— <b>off</b> the measured point, so the gate's numbers are about a different graph"}</p>` : ""}
        ${cav}
      </div>`;
    }

    if (lastPlan) paintPz();
    if ($("bePzAdd")) wirePzAdd();
    $("beCancel").onclick = () => { $("wfBoardEdit").innerHTML = ""; };
    $("beSave").onclick = async () => {
      readShots();
      const characterRefs = [], backgroundRefs = [], propRefs = [], refProminence = {};
      for (const cb of document.querySelectorAll("[data-ref]")) {
        if (!cb.checked) continue;
        const [kind, name] = cb.dataset.ref.split("|");
        (kind === "c" ? characterRefs : kind === "p" ? propRefs : backgroundRefs).push(name);
        const pv = document.querySelector(`[data-prom="${CSS.escape(name)}"]`);
        refProminence[name] = Number(pv?.value ?? 0.5);
      }
      try {
        await busy(() => api({
          action: "set_board", slug: wf.slug, segmentId,
          board: { boardPrompt: $("bePrompt").value.trim(), grade: $("beGrade").value.trim(),
                   shots, characterRefs, backgroundRefs, propRefs, refProminence },
        }));
      } catch (err) { alert(err.message); await loadProject(); }
    };
  };

  /**
   * Whose shot is this? The first declared reference on the board, so the
   * sentence names the same thing the reference pictures do — a plan that says
   * "the subject" while the clip carries a picture of Kaya has thrown away the
   * one word that ties the two together.
   */
  function pzSubject() {
    return (board.characterRefs || [])[0] || (board.propRefs || [])[0]
      || d.characters[0]?.name || (d.props || [])[0]?.name || "";
  }

  /* ── THE STAGING FIELDS, FED BY THE BOARD ───────────────────────────────
   *
   * A row per thing this scene already declares — its cast first, and the
   * project's declared cast when the board has named none yet. That is the
   * point of the control: the names in the spec are the names in the
   * references and in the words, so the figure the camera follows is the
   * character the prompt is about. Typing a fresh list here would let the
   * three drift apart, which is the failure pzSubject() already exists for.
   *
   * Every row starts OFF. A staging is a decision; a set that stages itself
   * is what these seven presets are for, and a control that silently began
   * overriding them would change what every existing previz renders.
   *
   * `id` is the name with anything that is not a letter, digit, _ or - turned
   * into _, because an id becomes a Blender object name on the far side. The
   * sanitised form is SHOWN, not hidden: a person who sees `Kaya_Vance` knows
   * what the spec will say, and the server refuses a bad one by name anyway.
   *
   * The defaults walk down the set two metres at a time on alternating sides
   * — a starting arrangement that is visible in the first render rather than
   * a pile at the origin. */
  const specId = (name) => String(name).replace(/[^\w-]+/g, "_").slice(0, 40) || "x";

  function specFigureRows() {
    const names = (board.characterRefs || []).length
      ? board.characterRefs : (d.characters || []).map((c) => c.name);
    if (!names.length) {
      return `<p class="hint dim">No cast declared on this scene yet, so there is nobody to
        stage. Tick a character above, or add one on the Characters stage.</p>`;
    }
    return names.map((n, i) => {
      const id = specId(n);
      return `<div class="specrow">
        <label class="specpick"><input type="checkbox" data-specfig="${i}" data-specid="${esc(id)}">
          <span>${esc(n)}</span> <code>${esc(id)}</code></label>
        <label>x <input class="line sm num" id="bePzFX${i}" type="number" step="0.1"
          value="${i % 2 ? 0.8 : -0.8}"></label>
        <label>y <input class="line sm num" id="bePzFY${i}" type="number" step="0.1"
          value="${2 + i * 2}"></label>
        <label>h <input class="line sm num" id="bePzFH${i}" type="number" step="0.01"
          value="${esc(pz.spec?.figureHeight ?? "")}"></label>
        <label class="specpick"><input type="checkbox" id="bePzFW${i}"> walks to</label>
        <label>x <input class="line sm num" id="bePzFTX${i}" type="number" step="0.1"
          value="${i % 2 ? 0.8 : -0.8}"></label>
        <label>y <input class="line sm num" id="bePzFTY${i}" type="number" step="0.1"
          value="${8 + i * 2}"></label>
      </div>`;
    }).join("");
  }

  function specPropRows() {
    const names = (board.propRefs || []).length
      ? board.propRefs : (d.props || []).map((p) => p.name);
    const kinds = pz.spec?.propKinds || [];
    if (!names.length || !kinds.length) return "";
    return names.map((n, i) => {
      const id = specId(n);
      return `<div class="specrow">
        <label class="specpick"><input type="checkbox" data-specprop="${i}" data-specid="${esc(id)}">
          <span>${esc(n)}</span> <code>${esc(id)}</code></label>
        <select class="sel2 sm" id="bePzPK${i}">${kinds.map((k) =>
          `<option>${esc(k)}</option>`).join("")}</select>
        <label>x <input class="line sm num" id="bePzPX${i}" type="number" step="0.1" value="1.2"></label>
        <label>y <input class="line sm num" id="bePzPY${i}" type="number" step="0.1"
          value="${4 + i * 2}"></label>
        <label>w <input class="line sm num" id="bePzPW${i}" type="number" step="0.1" value="0.9"></label>
        <label>d <input class="line sm num" id="bePzPD${i}" type="number" step="0.1" value="0.9"></label>
        <label>h <input class="line sm num" id="bePzPH${i}" type="number" step="0.1" value="0.9"></label>
      </div>`;
    }).join("");
  }

  /**
   * Paint the plan, and — when one was rendered — the previz beside it.
   *
   * The four sentences are shown SEPARATELY rather than as the joined
   * paragraph, because that is how they get used: a two-beat scene wants the
   * placement line for beat 2 without repeating the camera line.
   */
  function paintPz(shot) {
    const p = lastPlan;
    if (!p) return;
    const line = (k, v) => `<div class="pzline"><b>${k}</b> ${esc(v)}</div>`;
    const ref = shot?.reference;
    $("bePzOut").innerHTML = `<div class="pzplan">
      ${line("camera", p.camera)}${line("framing", p.framing_line)}
      ${line("placement", p.placement)}${line("lens", p.lens)}
      <p class="hint">${esc(p.note)}</p>
      ${p.board_move_exact ? "" : `<p class="hint dim">The board vocabulary has no word for
        ${esc(p.label)} — it will be saved as "${esc(p.board_move)}", which is a stand-in. The
        sentence in the action field is the part that carries the real move.</p>`}
      <p class="hint dim">${esc(p.caveat)}</p>
      <div class="framepick"><button class="edtool sm" type="button" id="bePzAdd">+ add as shot</button></div>
      ${shot?.previz ? `<div class="pzclip">
        <video src="${assetSrc(shot.previz.file)}" controls loop muted playsinline></video>
        <p class="hint dim">${esc(shot.previz.frames)} frames on the ${esc(shot.previz.scene)} set,
          marked <b>${esc(shot.previz.use)}</b>. Watch it; do not send it anywhere.</p>
      </div>` : ""}
      ${shot?.blockout ? `<div class="pzclip pzblockout">
        <video src="${assetSrc(shot.blockout.file)}" controls loop muted playsinline></video>
        <p class="hint">${esc(shot.blockout.frames)} frames on the ${esc(shot.blockout.scene)} set,
          marked <b>${esc(shot.blockout.use)}</b> — this one IS for the model. Pick
          <b>this shot's blockout</b> as the source below to steer with it.</p>
        <p class="hint dim">staging
          <code>${esc((shot.blockout.specSha256 || "the set's own").slice(0, 12))}</code>
          ${shot.blockout.figures?.length
            ? `· ${shot.blockout.figures.map((f) => `${esc(f.id)} on screen ${
                Math.round(f.onScreen * 100)}%`).join(" · ")}` : ""}
          ${Number.isFinite(shot.blockout.projectionCheck?.max_px_disagreement)
            ? `· the camera arithmetic in the sidecar agrees with Blender's own to ${
                esc(shot.blockout.projectionCheck.max_px_disagreement.toFixed(4))} px, worst
                point of the whole clip` : ""}</p>
      </div>` : ""}
      ${ref ? `<div class="pzref">
        <img src="${assetSrc(ref.file)}" alt="">
        <p class="hint">Reference frame at azimuth ${esc(ref.angle.azimuth ?? "?")}°,
          elevation ${esc(ref.angle.elevation ?? "?")}° —
          ${ref.safe ? "<b>passes</b> the reference gate."
                     : `<b>REFUSED</b>: ${esc(ref.why.join("; "))}`}
          ${ref.note ? esc(ref.note) : ""}</p>
      </div>` : ""}
    </div>`;
    wirePzAdd();
  }

  /** The plan's only side effect: one more row in the shot list. */
  function wirePzAdd() {
    const b = $("bePzAdd");
    if (!b) return;
    b.onclick = () => { readShots(); shots.push({ ...lastShot }); paintEditor(); };
  }

  /* Read the DOM back into `shots` before any repaint, or typing into a shot
   * and then pressing "+ shot" would discard what was typed. */
  function readShots() {
    for (const el of document.querySelectorAll("[data-shot]")) {
      const [i, k] = el.dataset.shot.split("|");
      if (shots[Number(i)]) shots[Number(i)][k] = el.value;
    }
  }

  paintEditor();
  $("wfBoardEdit").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---- stages 5-6: characters and backgrounds ---- */

/* ══════════════════════════════════════════════════════════════════════════
 * ONE SHOT: what was sent, why it came out like that, and how to redo it.
 *
 * THE FAILURE THIS IS FOR. DIRECTING.md's catalogue of wrecked renders is
 * almost entirely one sentence written many ways: the board looked correct and
 * the render got something else. A board names three people; two of them have
 * no rendered sheet; the clip carries one picture while its prompt names three;
 * nobody is told. Until now that fact existed for a few milliseconds inside
 * generateClip and was then discarded, so the only way to find out was to watch
 * the video and guess.
 *
 * So the first thing this panel shows is not the prompt — it is WHAT RESOLVED.
 * Every reference with the file it landed on, and, in red, every name that
 * reached the render as nothing.
 *
 * AND THE PROMPT IS THE REAL ONE. Not a summary, not the board's boardPrompt,
 * not a reconstruction: the exact string, from the same resolveShot() the
 * renderer itself calls. Editing it edits the render. That is the whole
 * difference between an inspector and a report.
 *
 * NOTHING HERE IS DESTRUCTIVE. Saving writes text and never renders; rendering
 * appends a take and never removes one; the take strip switches between them.
 * A re-render you dislike costs you the wait and nothing else.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The evidence for one take, or the honest admission that there is none. */
function takeEvidence(t) {
  if (!t) return "";
  if (!t.evidence) {
    /* ⚠ SAY "NOT RECORDED" RATHER THAN SHOWING THE ROW'S CURRENT PROMPT. The
     * clip row has always carried one `prompt` field that every render
     * overwrites, so an old take captioned with it would be labelled by text
     * that made a different video — worse than a blank, because it looks like
     * an answer. */
    return `<p class="hint dim">No record of what made this take — it was rendered before the
      prompt and the references were kept per take. Re-render to start the record.</p>`;
  }
  const gone = (t.refsMissing || []).map((r) => r.name);
  return `<div class="shotev">
    <div class="shotevline"><b>carried</b> ${t.refs.length
      ? t.refs.map((r) => `${esc(r.name)} <span class="dim">(${esc(r.file)})</span>`).join(", ")
      : '<span class="dim">no reference pictures</span>'}</div>
    ${gone.length ? `<div class="shotevline bad"><b>reached the render as nothing</b> ${esc(gone.join(", "))}</div>` : ""}
    <textarea class="wprompt" readonly>${esc(t.prompt)}</textarea>
  </div>`;
}

/** What each staleness flag MEANS, in the words of the thing that went stale.
 *  A badge reading "board-refs" is a code, and a code is something the reader
 *  has to already know to act on. */
const STALE_WHY = {
  board: "the board changed after this clip rendered",
  segments: "this scene's timing changed after this clip rendered",
  "board-refs": "the board's references changed after the board was drawn",
  prompt: "the prompt changed after this clip rendered",
};
/** Which of the three prompts won, said as a sentence rather than as a token. */
const SOURCE_WHY = {
  computed: "built by the builder",
  built: "built by the builder",
  edited: "hand-edited and saved on this scene",
  argument: "supplied for one render",
};

async function openShotInspector(segmentId, { focus = null } = {}) {
  const host = $("wfShotEdit");
  host.innerHTML = `<div class="wfcard shotedit"><p class="hint">Reading the shot…</p></div>`;
  let r;
  try { r = await api({ action: "shot", slug: wf.slug, segmentId }); }
  catch (err) {
    /* explain() answers in paragraphs when it has something to add, so this
     * renders them as paragraphs. A restart instruction run together with the
     * refusal on one line is an instruction people skim past. */
    host.innerHTML = `<div class="wfcard shotedit">${explain(err).split("\n\n")
      .map((para) => `<p class="hint bad">${esc(para)}</p>`).join("")}</div>`;
    return;
  }

  /* One record, replaced in place, so every handler below closes over the same
   * object rather than a snapshot that goes stale after the first save. */
  const sh = { ...r.shot };
  const replace = (next) => { for (const k of Object.keys(sh)) delete sh[k]; Object.assign(sh, next); };
  let openTake = null;   // whose evidence is expanded, by file

  const paint = () => {
    const d = sh.drift || {};
    /* THE DRIFT LINE IS THE "and see what that changed" HALF, and it sits at
     * the top because it is the only part that is about time. A reference
     * toggled or a prompt edited is invisible until something says the clip
     * that is playing no longer matches its own inputs. */
    const driftLine = !sh.current ? ""
      : d.unknown ? `<p class="hint dim">${esc(d.why)}</p>`
      : d.any ? `<p class="hint bad"><b>The take that is playing no longer matches this shot.</b>
          ${[d.promptChanged ? "the prompt has changed" : null,
             d.engineChanged ? `it rendered on ${esc(d.engineWas)}, this would render on ${esc(sh.engine)}` : null,
             d.refsAdded.length ? `added ${esc(d.refsAdded.join(", "))}` : null,
             d.refsRemoved.length ? `dropped ${esc(d.refsRemoved.join(", "))}` : null,
             d.refsRepointed.length ? esc(d.refsRepointed.map((x) => `${x.name} now points at a different sheet`).join(", ")) : null,
            ].filter(Boolean).join(" · ")}</p>`
      : `<p class="hint dim">The take that is playing matches this shot exactly.</p>`;

    const refRows = sh.refs.length
      ? sh.refs.map((x, i) => `<div class="shotref">
          <span class="shotpic">&lt;Picture ${i + 1}&gt;</span>
          <img src="${assetSrc(x.file)}" alt="">
          <span class="shotrefn">${esc(x.name)}</span>
          <span class="dim">${esc(x.kind || "?")} · ${esc(x.file)}</span></div>`).join("")
      : `<p class="hint dim">No reference pictures — this shot is text only, so the model
           invents its people and places fresh on every render.</p>`;

    /* ⚠ THE RED BLOCK IS THE POINT OF THE WHOLE PANEL. A declared name with no
     * rendered sheet is not an error and never has been — rendering before
     * every sheet exists is legitimate — but it is SILENT, and that silence is
     * how the same car arrived as a different car in eight scenes. */
    const missing = sh.refsMissing.length ? `<div class="shotmiss">
      <b>${sh.refsMissing.length} reference${sh.refsMissing.length === 1 ? "" : "s"} reach this render as NOTHING.</b>
      The prompt below may name ${sh.refsMissing.length === 1 ? "it" : "them"}, but no picture is sent,
      so the model invents ${sh.refsMissing.length === 1 ? "it" : "them"} from text every single time.
      ${sh.refsMissing.map((m) => `<div class="shotmissrow">${esc(m.name)} <span class="dim">— ${esc(m.why)}</span></div>`).join("")}
      <span class="dim">Render the sheet on the ${esc([...new Set(sh.refsMissing.map((m) => m.kind || "asset"))].join(" / "))}
      stage, or untick the name below so the shot stops claiming it.</span>
    </div>` : "";

    /* ⚠ A LIST OF REFERENCES IS A PROMISE, AND ON SOME ENGINES IT IS NOT KEPT.
     * The prompt introduces every resolved name as <Picture N>; the pictures
     * are only ATTACHED when the engine takes them. Showing the list without
     * this block would repeat, one level up, the exact lie the panel exists to
     * catch — so the heading changes too, from "handed" to "resolved". */
    const warned = (sh.warnings || []).map((w) => w.kind === "ltx-not-here"
      ? `<div class="shotmiss"><b>Renders on H3: LTX is not on this PC.</b> ${esc(w.why)}</div>`
      : `<div class="shotmiss">
      <b>The prompt names ${(w.names || []).length} picture${(w.names || []).length === 1 ? "" : "s"} this render will NOT be given.</b>
      ${esc(w.why)}</div>`).join("");

    /* ⚠ THE HONEST LIMIT, SAID ON THE SHOT AS WELL AS ON THE MAP.
     *
     * On a project whose engine takes no named references, everything above
     * this line is PLANNING: the sheets resolve, the map turns green, and the
     * video model is handed none of it. That half is bookkeeping and it has to
     * say so, in the panel, every time — because the alternative is a screen
     * full of correct-looking green over a render that got words alone. The
     * board image pinned as frame 0 is then the only carrier of identity, which
     * is why a board drawn before a prop existed loses that prop for good. */
    const ltxLine = sh.useRefs ? "" : `<div class="shotmiss">
      <b>Sheets do not reach the video model on this project.</b>
      It renders on <code>${esc(sh.engine)}</code>${sh.engineMode === "ltx"
        ? " because the project is set to ltx" : ""}, which has no named-reference input.
      Everything resolved below is the PLAN, not the hand-over.
      ${sh.opensOn
        ? `The picture pinned as frame 0 — <code>${esc(sh.opensOn)}</code> — is the only carrier
           of identity here, so whatever was in that image when it was drawn is what this shot
           inherits, and whatever was not is gone.`
        : `Nothing is pinned as frame 0 either, so identity is carried by the words alone and
           the model re-invents every face and object on each render.`}</div>`;

    /* Staleness, in words. `staleReasons` has been on the record for a while and
     * this panel never printed it — so "why does the table say stale" was a
     * question the inspector, of all screens, could not answer. */
    const staleLine = (sh.staleReasons || []).length ? `<p class="hint bad shotstale">
      <b>This clip is stale:</b> ${sh.staleReasons.map((k) => esc(STALE_WHY[k] || k)).join(" · ")}.
      Re-render below and the file will match the shot again.</p>` : "";

    const dropped = sh.dropped.length ? `<p class="hint bad">${sh.dropped.length}
      reference${sh.dropped.length === 1 ? " was" : "s were"} dropped at the ${sh.refCap}-picture
      limit: ${esc(sh.dropped.map((x) => x.name).join(", "))}. Raise their prominence to keep them.</p>` : "";

    const declRow = (x) => {
      const on = sh.refs.some((y) => y.name === x.name) || sh.refsMissing.some((y) => y.name === x.name);
      const prom = sh.refs.find((y) => y.name === x.name)?.prominence
        ?? sh.refsMissing.find((y) => y.name === x.name)?.prominence ?? 0.5;
      return `<label class="refpick${x.file ? "" : " nosheet"}"
          title="${x.file ? esc(x.file) : "No sheet rendered — ticking this name sends no picture"}">
        <input type="checkbox" data-sref="${esc(x.name)}"${on ? " checked" : ""}>
        <span>${esc(x.name)}${x.file ? "" : " ⚠"}</span>
        <input class="line sm num" type="number" min="0" max="1" step="0.05" style="width:56px"
          data-sprom="${esc(x.name)}" value="${prom ?? 0.5}"></label>`;
    };

    const takeStrip = sh.takes.length ? `<div class="shottakes">${sh.takes.map((t) => `
      <button class="shottake${t.current ? " sel" : ""}" data-stake="${esc(t.file)}"
        title="${t.current ? "Playing now. " : "Switch to this take. "}${t.seed != null ? `seed ${esc(t.seed)}` : "no seed recorded"}">
        <b>take ${t.n}</b>${t.current ? " ▸" : ""}
        <span class="dim">${esc(t.engine || "?")}${t.seed != null ? ` · seed ${esc(t.seed)}` : ""}${t.at ? ` · ${ago(t.at)}` : ""}${t.promptSource && t.promptSource !== "computed" ? " · hand-edited" : ""}</span>
      </button>`).join("")}</div>
      <div class="framepick"><button class="edtool sm" type="button" id="shWhy">
        ${openTake ? "Hide the evidence" : "Why did this take come out like that?"}</button></div>
      ${openTake ? takeEvidence(sh.takes.find((t) => t.file === openTake)) : ""}`
      : `<p class="hint dim">Nothing rendered yet.</p>`;

    host.innerHTML = `<div class="wfcard shotedit">
      <h4>Scene ${sh.scene} · ${fmt(sh.startSec)}–${fmt(sh.endSec)}${sh.blocked ? ` · ${esc(sh.blocked)}` : ""}</h4>
      <p class="hint">${esc(sh.line || "instrumental")}</p>
      ${driftLine}

      <div class="shotfacts">
        <span><b>engine</b> ${esc(sh.engine)} <span class="dim">(project set to ${esc(sh.engineMode)}${sh.useRefs ? "" : "; references not carried"})</span></span>
        <span><b>references</b> ${sh.refs.length} of ${sh.refCap}${sh.castRefs ? `, ${sh.castRefs} cast` : ", no cast"}</span>
        <span><b>guide</b> ${esc(sh.guideMode)}${sh.opensOn ? ` on ${esc(sh.opensOn)}` : ""}</span>
        <span><b>board</b> ${sh.boardId ? `${sh.boardShots} shot${sh.boardShots === 1 ? "" : "s"}` : "none"}</span>
        ${/* WHICH PROMPT WON, on the facts line rather than only in a paragraph
            * further down. It is the field that decides whether a change to the
            * board or the bible can reach this scene at all. */""}
        <span><b>prompt</b> ${esc(SOURCE_WHY[sh.promptSource] || sh.promptSource || "unknown")}</span>
        ${/* The server's words (shot.js songLine, clipsteps.js): is the song under
            * this clip, so a singing mouth follows it, and the step count
            * generate.js will send. */""}
        <span><b>song</b> ${esc(sh.songLine || "")}</span>
        <span><b>steps</b> ${esc(sh.steps ?? "?")}</span>
      </div>
      ${sh.stepsNote ? `<p class="hint">${esc(sh.stepsNote)}</p>` : ""}

      ${staleLine}${ltxLine}${missing}${dropped}${warned}
      <p class="hint"><b>${sh.refsSent ? "What the model is handed" : "What resolved"}</b>, in this
        order — the numbers are the <code>&lt;Picture N&gt;</code> tags the prompt names.</p>
      <div class="shotrefs${sh.refsSent ? "" : " notsent"}">${refRows}</div>

      <p class="hint"><b>Which names this shot carries.</b> Ticking a name with no sheet
        sends no picture, and the block above will say so every time.</p>
      <div class="refpicks">
        ${r.declared.map(declRow).join("") || '<span class="dim">nothing declared yet</span>'}
      </div>
      <div class="framepick">
        <button class="edtool sm" type="button" id="shSaveRefs">Save references</button>
      </div>

      <p class="hint"><b>The prompt, exactly as it will be sent.</b>
        ${sh.promptSource === "computed"
          ? "Built from the style bible, this scene's shot list and its grade. Edit it and the edit is what renders — the builder stops writing this scene until you revert."
          : "<b>Hand-edited.</b> The builder no longer writes this scene, so a change to the board or the style bible will not reach it until you revert."}
        Keep the <code>&lt;Picture N&gt;</code> sentences: a reference the prompt never names
        barely conditions the render at all, which is how one project rendered its single
        character as a different performer in every scene.</p>
      <textarea class="wprompt tall" id="shPrompt">${esc(sh.prompt)}</textarea>
      <div class="framepick">
        <button class="edtool sm" type="button" id="shSave">Save prompt</button>
        <button class="edtool sm" type="button" id="shRevert"${sh.promptOverride ? "" : " disabled"}
          title="${sh.promptOverride ? "Throw the hand-written prompt away and go back to the builder" : "This scene is already on the builder's prompt"}">Revert to built</button>
      </div>

      ${/* ⚠ THE ONE RENDER CONTROL. The clips table's Render opens this panel
          * rather than carrying a second copy, because the two used to disagree
          * — that one adopted the stored prompt and rolled a fresh seed, this
          * one held the seed and sent the box — and nothing on either button
          * said which you were pressing. */""}
      <div class="onerender" id="shRenderBox">
      <p class="hint"><b>Re-render this one shot.</b> Every earlier take is kept and the strip
        below switches between them. Holding the seed is what makes a prompt edit readable —
        same seed, one sentence different, and the difference IS the sentence.</p>
      <div class="framepick srcpick">
        <span class="dim">render from</span>
        <label title="What the builder computes from the style bible, this scene's shot list and its grade — ignoring any saved hand-edit, for this render only."><input
          type="radio" name="shSrc" value="built"> the built prompt</label>
        <label title="${sh.promptOverride ? "The hand-written prompt saved on this scene." : "Nothing is saved on this scene — the builder still writes it."}"><input
          type="radio" name="shSrc" value="edited"${sh.promptOverride ? "" : " disabled"}> the saved edit</label>
        <label title="Exactly what is in the box above, whether or not you pressed Save prompt."><input
          type="radio" name="shSrc" value="argument" checked> this box</label>
      </div>
      <div class="framepick">
        <label class="dim" title="${sh.current?.seed != null
          ? "Send the seed the playing take used, so a prompt edit is the only difference between the two files."
          : "No seed was recorded for the playing take, so there is nothing to hold — this render rolls a fresh one."}">
          <input type="checkbox" id="shHold"${sh.current?.seed != null ? " checked" : ""}${sh.current?.seed == null ? " disabled" : ""}> hold the seed</label>
        <input class="line sm num" id="shSeed" style="width:130px"
          placeholder="fresh roll" value="${sh.current?.seed ?? ""}">
        <label class="dim" title="Off renders unpinned: about 3x the motion, measured over 5 paired scenes, against identity drift in 1 of 3 on a smaller sample">
          <input type="checkbox" id="shLoop" checked> hold the opening frame</label>
        <button class="edtool" type="button" id="shRender">↻ Render this shot</button>
        <button class="edtool sm" type="button" id="shClose">Close</button>
      </div>
      <p class="hint dim">On <b>this box</b> it sends whatever is in the box above, saved or
        not — trying a wording is not the same as adopting it. The choice is recorded with the
        take, so a hand-edited render is never mistaken later for a followed board.</p>
      </div>

      <p class="hint"><b>Takes.</b> Click one to make it the take that plays.</p>
      ${takeStrip}
    </div>`;

    /* ── wiring ─────────────────────────────────────────────────────────── */
    $("shClose").onclick = () => { host.innerHTML = ""; };

    if ($("shWhy")) $("shWhy").onclick = () => {
      openTake = openTake ? null
        : (sh.takes.find((t) => t.current) || sh.takes[sh.takes.length - 1])?.file;
      paint();
    };
    for (const b of document.querySelectorAll("[data-stake]")) {
      b.onclick = async () => {
        /* Switching a take is a project write the whole page cares about — the
         * clips table's Clip column and the rough cut both follow clipFile — so
         * this one does go through busy(), and the inspector is reopened after
         * the repaint rather than left pointing at a record that has moved. */
        await busy(() => readBack({ action: "pick_take", slug: wf.slug, kind: "clip",
                                    id: sh.segmentId, file: b.dataset.stake },
                                  /* id is a SEGMENT id here and a clip row is
                                   * keyed by its own — the readback would not
                                   * find it, so it is not asked for. A build
                                   * that read `target` would look among
                                   * characters and refuse, which the catch
                                   * still turns into the restart sentence. */
                                  { kind: "clip", id: null }));
        openShotInspector(segmentId);
      };
    }

    /* set_shot WRITES AND NEVER RENDERS, so these do not go through busy():
     * that reloads the project and repaints the whole stage, which would throw
     * away a half-typed prompt. The route hands the updated record back, so the
     * panel repaints from the server's answer rather than from a guess. */
    /* ⚠ THE BODY IS WRITTEN OUT IN FULL, not spread from an argument. Two
     * reasons, and the second is the one that bites: `prompt: undefined` means
     * "leave the stored prompt alone" and `prompt: ""` means "revert it", so the
     * three keys have to be visible together to read correctly — and the parity
     * gate's parameter census reads the literal, so a body assembled behind a
     * spread would report this panel as sending nothing but a slug. A knob it
     * cannot see is a knob it will not defend. */
    const save = async ({ prompt, refs, prominence }) => {
      const el = $("wfBody");
      el.classList.add("wfbusy");
      try {
        const r2 = await api({ action: "set_shot", slug: wf.slug, segmentId,
                               prompt, refs, prominence });
        replace(r2.shot); paint();
      } catch (err) { alert(explain(err)); }
      finally { el.classList.remove("wfbusy"); }
    };

    $("shSave").onclick = () => save({ prompt: $("shPrompt").value });
    $("shRevert").onclick = () => save({ prompt: "" });
    $("shSaveRefs").onclick = () => {
      const refs = [], prominence = {};
      for (const cb of document.querySelectorAll("[data-sref]")) {
        if (!cb.checked) continue;
        refs.push(cb.dataset.sref);
        const pv = document.querySelector(`[data-sprom="${CSS.escape(cb.dataset.sref)}"]`);
        prominence[cb.dataset.sref] = Number(pv?.value ?? 0.5);
      }
      return save({ refs, prominence });
    };

    $("shRender").onclick = async () => {
      /* ⚠ ALL THREE SOURCES SEND A REAL PROMPT STRING, and that is deliberate
       * rather than lazy. `promptSource` tells the server which one a human
       * chose — a label worth recording on the take — but the render must be
       * correct whether or not the running build has learned to read it, and
       * this page reloads without a restart while the routes do not. The record
       * already carries all three texts, so the page can resolve the choice
       * itself and the argument becomes a statement of intent, not a request.
       *
       * The prompt in the box is sent whether or not it was saved. regen_clip
       * takes it for THIS render and stores nothing; Save prompt is the
       * separate, deliberate act of adopting it. */
      const src = document.querySelector('input[name="shSrc"]:checked')?.value || "argument";
      const body = { segmentId, clipId: sh.clipId, promptSource: src,
                     prompt: $("shPrompt").value,
                     loop: $("shLoop").checked,
                     seed: $("shHold").checked ? $("shSeed").value : "" };
      if (src === "built") body.prompt = sh.computedPrompt;
      if (src === "edited") body.prompt = sh.promptOverride || sh.computedPrompt;
      await busy(() => postRegenClip(body));
      openShotInspector(segmentId, { focus });
    };

    /* Opened FROM the clips table, the panel scrolls to the control that was
     * asked for. Opened from Inspect, it stays at the top, where the order is
     * the order of blame. */
    if (focus === "render") {
      $("shRenderBox")?.scrollIntoView({ behavior: "smooth", block: "center" });
      $("shRenderBox")?.classList.add("focused");
    }
  };

  paint();
}

const assetSrc = (f) => `/api/mv/asset/${encodeURIComponent(wf.slug)}/${encodeURIComponent(f)}`;
const takeOf = (t) => (typeof t === "string" ? { file: t, seed: null } : t);

/**
 * WHICH SCENES NAME THIS ROW, by name, off the boards already on the page.
 *
 * Split out of assetUsage because a RENAME needs the same answer before it
 * writes: the confirm has to list the scenes the cascade is about to repoint,
 * and a second walk of the same boards with a slightly different rule is how
 * two answers to one question get shipped. One rule, two readers.
 */
function refScenesIn(doc, kind, name) {
  const field = kind === "characters" ? "characterRefs"
    : kind === "props" ? "propRefs" : "backgroundRefs";
  const lc = String(name || "").toLowerCase();
  return (doc?.boards || [])
    .filter((b) => (b[field] || []).some((n) => String(n).toLowerCase() === lc))
    .map((b) => (b.segmentIndex ?? b.clipIndex ?? 0) + 1)
    .sort((a, b) => a - b);
}
const refScenes = (kind, name) => refScenesIn(wf.doc, kind, name);

/**
 * WHICH SCENES USE THIS ROW, and whether the render will actually get it.
 *
 * ⚠ THE AFFORDANCE THAT WAS MISSING FROM ALL THREE SECTIONS. A card said what a
 * thing looked like and never said where it was USED — so "declared but
 * referenced by nothing" and "referenced everywhere and has no sheet" looked
 * identical on the page, and the second is the failure DIRECTING.md spends most
 * of its length on. mv_lint has reported both for months; the cards did not.
 *
 * Derived from the boards on every paint, so it cannot go stale, and it is the
 * SAME question the relationship map answers — this is just the answer in the
 * one place where you are holding the thing it is about.
 */
function assetUsage(kind, row) {
  const scenes = refScenes(kind, row.name);

  if (!scenes.length) {
    if (!(wf.doc.boards || []).length) {
      return `<p class="usage dim">No boards yet — nothing references anything.</p>`;
    }
    return `<p class="usage warn">Referenced by no board.${kind === "props"
      ? " Tick it on the scenes it appears in, or it is not cast."
      : ""}</p>`;
  }
  const list = `scene${scenes.length === 1 ? "" : "s"} ${scenes.join(", ")}`;
  /* THE SILENT ONE. A row with references and no sheet is the case where the
   * board looks right, the render receives nothing for it, and nothing anywhere
   * says so. It is the loudest thing on the card because it is the most
   * expensive thing to discover after the GPU has been spent. */
  if (!row.imageFile) {
    return `<p class="usage bad"><b>Used in ${esc(list)} — with no sheet.</b>
      Those renders get nothing for it and re-invent it from the words each time.
      Render it before the clips.</p>`;
  }
  return `<p class="usage">Used in ${esc(list)}.</p>`;
}

function renderAssets(kind) {
  const rows = (wf.doc[kind] || []);
  const target = SINGULAR[kind];
  const cards = rows.map((r) => {
    const takes = (r.takes || []).map(takeOf);
    // the candidate strip hides itself at one take — single-take cards stay clean
    const strip = takes.length > 1 ? `<div class="cands">${takes.map((t) =>
      `<button class="cand${t.file === r.imageFile ? " sel" : ""}"
         title="seed ${esc(t.seed ?? "?")}" data-pick="${esc(kind)}|${esc(r.id)}|${esc(t.file)}">
         <img src="${assetSrc(t.file)}" alt=""></button>`).join("")}</div>` : "";
    /* THE SEEDS THIS ROW HAS ALREADY BEEN DRAWN ON, as things you can press.
     * The hold is useless without them: nobody types a seed they cannot read,
     * and a null seed is an IMPORTED take, which was never drawn and cannot be
     * redrawn — so it is printed as "imported" rather than offered. */
    /* ⚠ `Number.isFinite(s)`, NOT `Number.isFinite(Number(s))`. `Number(null)`
     * is 0 and 0 is finite, so the coercing form calls an IMPORTED take's null
     * seed the seed zero: it offered a chip reading "null" and swallowed the
     * line saying imports have no seed. Caught by RENDERING the card, not by
     * reading this line — which is the whole argument for the stub-DOM pass. */
    const seeds = [...new Set(takes.map((t) => t.seed).filter((s) => Number.isFinite(s)))];
    const seedRow = `<div class="seedhold">
      <label title="Redraw this row on a seed it has already used. Everything else about the picture stays where it was, so a changed word in the description is the only thing that moved — which is the only way to find out what that word does. Empty rolls a fresh seed, which is what this button has always done.">seed
        <input class="line sm num" type="number" step="1"
          data-genseed="${esc(kind)}|${esc(r.id)}" placeholder="rolls"
          spellcheck="false" autocomplete="off"></label>
      ${seeds.length ? `<span class="seedchips">${seeds.map((s) =>
        `<button class="seedchip" type="button" data-seedhold="${esc(kind)}|${esc(r.id)}|${esc(s)}"
           title="Hold this take's seed and redraw">${esc(s)}</button>`).join("")}</span>` : ""}
      ${takes.some((t) => !Number.isFinite(t.seed))
        ? `<span class="dim">imported takes have no seed</span>` : ""}
    </div>`;
    return `<div class="wcard">
      <div class="wthumb">${r.imageFile ? `<img src="${assetSrc(r.imageFile)}" alt="">`
        : `<span class="bkind">${target[0].toUpperCase()}</span>`}</div>
      <div class="wrow">
        ${/* ⚠ THE NAME IS AN INPUT, NOT A LABEL, and that is the whole rename
            * feature. The name is the BINDING KEY — every board reference, every
            * <Picture N> legend and every continuity line resolves through it —
            * so until now the only way to correct a name was to declare a second
            * row and re-tick every board by hand. Editing it here posts the
            * cascade; see the wiring for what the confirm promises.
            *
            * ⚠ `data-mvrename`, NOT `data-rename`. Found by opening the running
            * app: web/app.js keeps a DELEGATED click handler on `[data-rename]`
            * for renaming a library file, and every tab's markup lives in one
            * document here — so the plain name would have dropped this field
            * into another module's rename flow, and this page's own
            * document.querySelectorAll would have pulled that module's buttons
            * into its loop. Every other hook on this page is already
            * distinctive; this one was not. */""}
        <input class="wname wrename" data-mvrename="${esc(kind)}|${esc(r.id)}"
          value="${esc(r.name)}" spellcheck="false" autocomplete="off"
          title="Rename. Boards, prompt legends and continuity lines that name it are repointed in the same write.">
        <span class="wstatus" data-status="${esc(r.status || (r.imageFile ? "rendered" : "pending"))}">${esc(r.status || (r.imageFile ? "rendered" : "pending"))}</span></div>
      <textarea class="wprompt" data-desc="${esc(kind)}|${esc(r.id)}"
        placeholder="describe ${target === "character" ? "them" : "it"}…">${esc(r.description || "")}</textarea>
      ${assetUsage(kind, r)}
      <button class="edtool sm" data-genasset="${esc(kind)}|${esc(r.id)}"
        title="Render 4 variants in different seeds — pick the one you like">${takes.length ? "↻ More takes" : "✦ Generate"}</button>
      ${/* `kind`, the plural, since the shim went — the hook carries what the
          * body will carry, so nothing has to translate at the call site. */""}
      <button class="edtool sm" data-blender="${esc(kind)}|${esc(r.id)}"
        title="Render this sheet from a 3D model instead. Three angles, three takes — the same object every time, which a prompt cannot promise.">⬡ Blender</button>
      ${/* ⬔ MESH — the other direction from Blender. That one renders an object
          * somebody already modelled; this MAKES one out of the panel this row
          * already carries, which is exactly the case Blender has to refuse
          * ("useless for anything with a make and model"). The button is
          * offered whether or not there is a sheet yet, because the refusal
          * that comes back — "render a sheet first" — is the sentence that says
          * what to do, and a hidden control says nothing at all. */""}
      <button class="edtool sm" data-mesh="${esc(kind)}|${esc(r.id)}"
        title="Build a 3D mesh from this row's sheet. A mesh IS the same object on every render — the strongest form of the identity a sheet only approximates. It does not replace the sheet: the clip engine takes pictures.">⬔ Mesh</button>
      ${r.meshFile ? `<button class="edtool sm" data-meshrig="${esc(kind)}|${esc(r.id)}"
        title="Put a skeleton and skinning weights into the mesh this row already has. Refused on a blocky object — a rigger asked to rig a crate invents a skeleton for a crate and reports success.">⬗ Rig</button>` : ""}
      <button class="edtool sm" data-planadd="asset|${esc(kind)}|${esc(r.id)}"
        title="Put this sheet in a plan instead of drawing it now. Sheets are seconds, so one on its own rarely needs a plan — a dozen of them beside a night of clips does.">+ Plan</button>
      ${/* WHAT THIS ROW HOLDS BESIDE ITS PICTURE, said on the card. A mesh has
          * no thumbnail, so in a grid of pictures it is invisible — without
          * this line the most expensive artefact on the row is the one nothing
          * on screen mentions. `rigFile` is named separately from `meshFile`
          * because a rig that did not take leaves the first and not the second,
          * and that difference is the whole reason they are two fields. */""}
      ${r.meshFile ? `<p class="hint dim">Mesh: <b>${esc(r.meshFile)}</b>${
        r.rigFile ? ` · rigged (<b>${esc(r.rigFile)}</b>)` : " · not rigged"
      }. A mesh is not a clip reference — the sheet is what reaches the render.</p>` : ""}
      <div data-meshhost="${esc(kind)}|${esc(r.id)}"></div>
      ${seedRow}
      ${strip}
    </div>`;
  }).join("");
  const HEAD = { characters: "Characters", backgrounds: "Backgrounds", props: "Props" };
  const HINT = {
    characters: "The people the video reuses. A ticked character with a picture keeps its identity in H3 clips, because the clip engine takes it as a named reference. Kept best (Hex Appeal; REWIND A/B, 2026-09-24): 1–3 tight crops of one view each on a near-black card, one row per view (Name, Name body, Name side); Import brings in your own crop. The description is editable in place and saves when you click away.",
    backgrounds: "The places the video returns to. Descriptions save when you click away.",
    /* PROPS ARE CAST, and until now this page never said so — props could be
     * declared in the bible and ticked on a board, and there was no card, no
     * picture and no Generate button anywhere a person could reach. The object
     * that recurs in half the scenes was the one row with no way to pin it. */
    props: "Objects that recur — a car, a knife, a sign. They are cast exactly as people are: an object with no sheet is re-invented by the model on every render, which is how the same car arrives a different car each time. Blender is the stronger answer here, because a mesh is the same object by construction.",
  };
  /* THE UNDECLARED-OBJECT WARNING, ON THE PROPS SECTION ITSELF. The lint has
   * reported this for months on a screen nobody opens mid-flow. It belongs
   * where the fix is: one button away from the row that would close it. */
  const recurring = kind === "props" ? (wf.lint || []).filter((i) => i.where === "props") : [];

  /* ⚠ WHERE THE SINGLE-PANEL CHOICE ACTUALLY BITES, said here rather than
   * dressed up as a switch on these cards.
   *
   * DIRECTING.md §2 is explicit: a reference is a SINGLE PANEL, because handed
   * a whole contact strip the model draws a contact strip — measured, twice.
   * The switch that decides it is `refs` on generate_asset, and generateAsset
   * reads it under `target === "board"` and nowhere else: a sheet render takes
   * no references at all, so a "single panel" toggle on a character card would
   * be a control with no effect, which is the exact disease the parameter
   * census exists to catch. The toggle is on the BOARD cards, one stage on,
   * and this line says so instead of pretending. */
  const PANEL_NOTE = `<p class="hint">⚠ <b>These sheets are contact strips</b> — several panels
    in one picture. DIRECTING.md §2 says a reference is a SINGLE PANEL, because handed the
    whole strip the model reproduces the strip rather than composing the shot (measured
    2026-08-28, and again on the boards that followed). Nothing on this card changes that:
    the choice is made where a reference is USED, on the <b>single panel</b> switch beside
    each storyboard's Draw button. A sheet render takes no references itself, so a switch
    here would do nothing.</p>`;

  return `<div class="wfcard">
    <h3>${HEAD[kind]}</h3>
    <p class="hint">${HINT[kind]}</p>
    ${PANEL_NOTE}
    ${recurring.map((i) => `<p class="hint warnhint">${esc(i.msg)}</p>`).join("")}
    ${rows.length ? `<div class="wgrid">${cards}</div>`
      : `<p class="hint">None yet.</p>`}
    <div class="framepick">
      <button class="edtool" type="button" data-addasset="${kind}">+ Declare a ${esc(target)}</button>
      <button class="edtool" type="button" data-import="${kind}">Import a picture…</button>
      <button class="edtool" type="button" data-planfrom="nosheet"
        title="Seeds a plan with one sheet render per declared character, background or prop that has none — the rows that reach every clip as nothing until they exist.">Plan the missing sheets</button>
    </div>
    <div data-declhost="${kind}"></div>
    <div data-imphost="${kind}"></div>
    <p class="hint">⚠ <b>Declaring</b> writes the row — a name and a description — and the
      picture comes after, from <b>Generate</b> or <b>Blender</b>. That order matters: until
      this existed the only ways to create a ${esc(target)} were to have an agent write the
      whole bible or to already own a picture, so noticing a missing ${esc(target)} halfway
      through a project left you nothing to press.
      <b>Importing</b> is the other way round and is the fastest path when the art exists:
      point at something you already made on the Images tab.</p>
  </div>`;
}

/**
 * THE DECLARE FORM — a form, at last, and not three browser prompts.
 *
 * It replaced `prompt()` for one reason that is not taste: two of add_asset's
 * four fields could not be sent at all. The route has always read `prompt` (the
 * text the SHEET is rendered from, used INSTEAD of the description) and `role`
 * (lead | support), and the three modal prompts asked for a name and a
 * description, so an agent could declare a prop whose sheet is drawn from one
 * text and described to the model with another, and a person could not. Both
 * are behind a disclosure because both are genuinely advanced — a two-word row
 * is immediately renderable without them — and each carries the one line that
 * says when you would want it.
 */
function declareForm(kind) {
  const target = SINGULAR[kind];
  return `<div class="declare" data-declform="${esc(kind)}">
    <h4>Declare a ${esc(target)}</h4>
    <label class="dfield"><span>name</span>
      <input class="line" data-dname spellcheck="false" autocomplete="off"
        placeholder="${target === "prop" ? "the grey Volvo" : target === "background" ? "the motel forecourt" : "Vire"}"></label>
    <p class="hint dim">The name is the binding key: boards, prompt legends and the map all
      resolve through it, and it is the word the prompts will use. It has to be unique across
      characters, backgrounds and props — a duplicate is refused, naming the row that holds it.</p>

    <label class="dfield"><span>description</span>
      <textarea class="wprompt" data-ddesc rows="3"
        placeholder="${target === "prop"
          ? "make, era, colour, condition, distinguishing marks…"
          : `what the ${target} looks like, in enough detail to redraw it the same way twice…`}"></textarea></label>
    <p class="hint dim">What it looks like. This does two jobs unless you fill in the sheet
      prompt below: it is what the sheet is drawn from, and what the bible tells the model.</p>

    <details class="adv">
      <summary>Advanced — the sheet prompt${kind === "characters" ? " and the role" : ""}</summary>
      <label class="dfield"><span>sheet prompt</span>
        <textarea class="wprompt" data-dprompt rows="3"
          placeholder="left empty, the description draws it"></textarea></label>
      <p class="hint dim">The text the SHEET is rendered from, used <b>instead of</b> the
        description. Fill it in when the words that describe a thing to a reader are not the
        words that draw it: "a 1987 Volvo 240, oxidised paint, one grey door" draws;
        "the car he cannot let go of" does not.</p>
      ${kind === "characters" ? `<label class="dfield"><span>role</span>
        <select class="sel2 sm" data-drole>
          <option value="">— not set</option>
          <option value="lead">lead</option>
          <option value="support">support</option>
        </select></label>
      <p class="hint dim">Lead or support. It rides with the row for whoever plans the shots;
        nothing renders differently today, and until now only an agent could set it.</p>` : ""}
    </details>

    <div class="framepick">
      <button class="edtool" type="button" data-dsave>Declare</button>
      <button class="edtool sm" type="button" data-dcancel>Cancel</button>
    </div>
    <p class="hint dim">Declaring writes the row. The picture comes after, from
      <b>Generate</b> or <b>Blender</b> on the card that appears.</p>
  </div>`;
}

/**
 * THE IMPORT FORM — the same argument as declareForm, one route along.
 *
 * Import was two browser prompts, so it could send a path and a name and
 * nothing else. `import_asset` reads two more fields:
 *
 *   `description` — the text every later prompt builder falls back to. Without
 *   it an imported row describes itself to the model as NOTHING until somebody
 *   notices and types into the card afterwards, which is the difference between
 *   a picture the video knows what to do with and a picture it merely holds.
 *
 *   `role` — lead or support, and it was reachable by NOBODY: the route wrote
 *   whatever it was handed straight onto the row, unvalidated, while add_asset
 *   and update_asset both passed the same field through readRole(). One door,
 *   one reader; the select cannot express a third value, which is the point.
 *
 * A path and a name are still the only two that are required, and they are
 * still the two at the top with nothing in front of them.
 */
/**
 * THE MESH FORM — every knob the route reads, on the card that owns the row.
 *
 * A form rather than a confirm, and not because a confirm would be ugly: the
 * `mesh_asset` route reads five arguments and a parity gate in
 * server/mv/ui_test.js fails the build for any one of them a human cannot send.
 * That gate exists because this repository once shipped 153 route parameters
 * that no surface could reach — a feature that only exists in the source.
 *
 * The cost line is not decoration either. This is the one control on this page
 * that can be refused for a reason the person cannot see from here (the card is
 * full, and the engine is what is filling it), so the form says so before the
 * click rather than the alert saying it after.
 */
function meshForm(kind, id, cat) {
  const bad = cat && !cat.installed;
  return `<div class="declare" data-meshform="${esc(kind)}|${esc(id)}">
    <h4>Build a mesh from this sheet</h4>
    ${bad ? `<p class="hint warnhint">The 3D runtime is not ready on this machine:<br>
      ${(cat.why || []).map((w) => esc(w)).join("<br>")}</p>` : ""}
    <p class="hint dim">One panel in, a <b>GLB</b> out — the object itself rather than a picture
      of it. It does <b>not</b> replace the sheet: the clip engines take pictures, so the sheet
      stays the thing that reaches a render. What a mesh buys is that the object is the
      <i>same object</i> every time, which a description cannot promise.</p>

    <label class="dfield"><span>panel to build from</span>
      <input class="line" data-mimage spellcheck="false" autocomplete="off"
        placeholder="leave empty to use this row's selected take"></label>
    <p class="hint dim">A full path on THIS machine, and only when the selected take is not the
      clearest single panel of the object. A contact strip is <b>refused</b> before anything is
      spent — handed a grid, an image-to-3D model builds a mesh of the grid.</p>

    <label class="dfield"><span><input type="checkbox" data-mrig> rig it as well</span></label>
    ${cat && cat.installed && cat.canRig === false ? `<p class="hint warnhint">⚠ The rig cannot run on this machine, so ticking this refuses the whole pass <b>before</b> the mesh is built — leave it clear to get the mesh. The checkpoints are present; it is the runtime that is missing:<br>${(cat.rigRuntime?.missing || []).map((m) => esc(m.module + " — " + m.error)).join("<br>")}</p>` : ""}
    <p class="hint dim">Adds a skeleton and skinning weights in the same pass — glTF joints and
      inverse bind matrices, which is what makes a mesh posable. Refused on a blocky object: a
      rigger asked to rig a crate does not fail, it invents a skeleton for a crate and reports
      success. You can also rig later, from the ⬗ Rig button.</p>

    <div class="framepick">
      <label class="dfield"><span>seed</span>
        <input class="line sm num" type="number" step="1" data-mseed placeholder="42"></label>
      <label class="dfield"><span>steps</span>
        <input class="line sm num" type="number" step="1" data-msteps placeholder="50"></label>
    </div>
    <p class="hint dim">Seed is recorded on the run so the mesh can be rebuilt. Steps trade time
      against surface detail and nothing else.</p>

    <p class="hint">⚠ <b>It shares the one graphics card with the engine.</b> If there is not
      enough free memory this refuses <i>before</i> starting and says to unload the engine
      first — it will never evict a render that is already going.</p>

    <div class="framepick">
      <button class="edtool" type="button" data-msave>Build the mesh</button>
      <button class="edtool sm" type="button" data-mcancel>Cancel</button>
    </div>
  </div>`;
}

function importForm(kind) {
  const target = SINGULAR[kind];
  return `<div class="declare" data-impform="${esc(kind)}">
    <h4>Import a ${esc(target)}</h4>
    <label class="dfield"><span>path to the picture</span>
      <input class="line" data-ipath spellcheck="false" autocomplete="off"
        placeholder="C:\\...\\output\\images\\something.png"></label>
    <p class="hint dim">A full path on THIS machine — usually something the Images tab just
      made. There is no upload because the file is already here. A picture with several panels
      in it is <b>refused</b>, with the reason and the words "crop one panel out of it": handed
      a contact strip the model draws a contact strip.</p>

    <label class="dfield"><span>name</span>
      <input class="line" data-iname spellcheck="false" autocomplete="off"
        placeholder="${target === "prop" ? "the grey Volvo" : target === "background" ? "the motel forecourt" : "Vire"}"></label>
    <p class="hint dim">The binding key, exactly as when declaring: it is what boards, prompt
      legends and the map resolve through, and it has to be unique across characters,
      backgrounds and props. Left empty, the file's own name is used.</p>

    <label class="dfield"><span>description</span>
      <textarea class="wprompt" data-idesc rows="3"
        placeholder="what the picture shows, in the words the prompts should use…"></textarea></label>
    <p class="hint dim">⚠ Worth filling in now. This is the text every later prompt builder
      falls back to — an imported row with none describes itself to the model as nothing at all,
      and the picture alone only reaches the render on an engine that takes references.</p>

    ${kind === "characters" ? `<label class="dfield"><span>role</span>
      <select class="sel2 sm" data-irole>
        <option value="">— not set</option>
        <option value="lead">lead</option>
        <option value="support">support</option>
      </select></label>
    <p class="hint dim">Lead or support, and nothing else is accepted — the row is validated by
      the same reader Declare and the card's own edit use, so the three doors cannot disagree
      about what a role is. It rides with the row for whoever plans the shots; nothing renders
      differently today.</p>` : ""}

    <div class="framepick">
      <button class="edtool" type="button" data-isave>Import</button>
      <button class="edtool sm" type="button" data-icancel>Cancel</button>
    </div>
    <p class="hint dim">Importing copies the file into the project and marks the row approved,
      with a take whose seed is null — that null is what says "imported, never drawn".</p>
  </div>`;
}

/* ═══════════════════════════════════════════════════ THE PLAN — the card
 *
 * SET UP · GO THROUGH · APPROVE OR CHANGE · START. Those four verbs are the
 * whole object, and this is the half a person uses. Nothing here renders
 * anything: proposing spends nothing, approving spends nothing, and the GPU is
 * only reached by Run, and only for items marked approved.
 *
 * ⚠ THE QUALITY LINE AND THE WARNINGS ARE ON THE OBJECT BEING APPROVED, above
 * the buttons, before the decision. DIRECTING.md §4 has carried those traps for
 * months and every one of them was still found the expensive way — an engine
 * that silently drops every reference sheet, a step band that loads the 4-step
 * file and runs it at twelve, a size above H3's native that costs 11 minutes a
 * clip. A quality choice explained on another screen is a quality choice nobody
 * read.
 *
 * NOTHING ON THIS CARD IS STORED. Engine, size, minutes, warnings and the
 * finishing time are all DERIVED on read by the server's planView(), out of the
 * same functions the renderer itself calls — so the card cannot promise an
 * engine the render will not use. Change the brief and this card changes.
 */

/** Card-local state. Outside the markup for the same reason `singlePanel` is:
 *  every decision repaints, and a choice that lived in the DOM would be thrown
 *  away by the act of using it. */
const pl = {
  view: null,      // the server's planView(), or null when no plan is live
  index: [],       // every plan on the project, newest first
  err: null,       // the sentence to print INSTEAD of the card (never a blank)
  say: null,       // the last outcome line — what was changed, what was refused
  planId: null,    // which plan is being read; null = the live one
  open: null,      // the item whose editor is open, by id
  raw: false,      // ...and whether that editor is on the raw-JSON fallback
  propose: null,   // the propose form's seed, while it is open
  staged: [],      // items collected by "+ Plan" before any plan exists
  ack: new Set(),  // items whose acknowledgement box is ticked, by id
  running: false,  // the runner's own answer for this slug, beside plan.state
  slug: null,      // which project this card's state belongs to — see loadPlan
  addTool: "",     // the tool name typed into the "+ Add an item" form
  shownAt: 0,      // when this card was last painted — see postPlanDecide
  poll: null,      // the running-plan poll handle
};

/* ⚠ THE TRAPS, WORDED HERE AS WELL AS ON THE SERVER.
 *
 * The card prints the server's own sentence for every trap it is sent — one
 * wording, one place, no drift. This map is the fallback for a trap the server
 * NAMES and does not word, which is exactly what an older or newer build
 * produces, and it is the reason the LTX sentence is readable in this file
 * rather than only in server/mv/plan.js. A card that printed a bare kind
 * ("ltx-drops-references") would be a warning nobody can act on. */
/* The four states plan.js calls LIVE. A done or cancelled plan is HISTORY: the
 * card still shows it, because "the plan" is what a person means by the last
 * one, but it takes no decisions and it is not what a second propose is refused
 * against. Spelled once, here, rather than three times as an array literal. */
const LIVE_PLAN_STATES = new Set(["proposed", "approved", "running", "paused"]);

const QUALITY_TRAPS = {
  "ltx-drops-references":
    "references are dropped entirely on LTX — every character sheet you built is not used.",
  "hybrid-routes-on-cast":
    "hybrid sends any scene carrying a named character to H3 and everything else to LTX, so one "
    + "imported character can turn a twenty-minute render into an overnight one.",
  "step-band":
    "this step count runs the speed-up file that loads past the count it was made for, so the "
    + "estimate is a floor. Leave steps on default to run the matched count for the files on this PC.",
  "above-native":
    "above H3's native 1344x768 — untrained territory, and priced accordingly.",
  "h3-oom":
    "H3 at 1920x1088 measured OUT OF MEMORY on a 16 GB card; the two Bone Waffle films rendered "
    + "there at 4 steps.",
  "refs-off": "cast references are switched off for this project, so the sheets do not reach the "
    + "video model even on H3. The prompt still names them.",
};

/* ─────────────────────── one door per action, and the body is one literal
 *
 * Same rule as postRegenClip above and for the same two reasons: one function
 * to read per action, and the parity gate's parameter census reads the literal
 * passed to api() — a body assembled behind a spread reports this page as
 * sending nothing but a slug, and a knob the gate cannot see is a knob it will
 * not defend. */
const postPlanRead = ({ planId }) =>
  api({ action: "plan_read", slug: wf.slug, planId });

const postPlanPropose = ({ title, intent, from, items }) =>
  api({ action: "plan_propose", slug: wf.slug, title, intent, from, items });

const postPlanItem = ({ op, itemId, tool, args, why, at }) =>
  api({ action: "plan_item", slug: wf.slug, planId: pl.planId, op, itemId, tool, args, why, at });

/* ⚠ NO `decideMs`, AND THE OMISSION IS DELIBERATE. The Ear records how long a
 * card was on screen before the press, and the plan route's own comment says it
 * does not read one here — "a field neither surface fills is a knob nobody can
 * turn dressed up as evidence". This page CAN measure it (the card stamps every
 * paint), so if the dispatch ever grows `b.decideMs` this is the line that
 * fills it. Sending it today would be a key the route drops, which is the same
 * broken promise one direction earlier. */
const postPlanDecide = ({ items, status, acknowledge, reasoning, freeText }) =>
  api({ action: "plan_decide", slug: wf.slug, planId: pl.planId, items, status,
        acknowledge, reasoning, freeText });

const postPlanPolicy = ({ onFailure, autoApproveUnderMinutes, delegateBrief }) =>
  api({ action: "plan_policy", slug: wf.slug, planId: pl.planId,
        onFailure, autoApproveUnderMinutes, delegateBrief });

const postPlanRun = ({ op }) =>
  api({ action: "plan_run", slug: wf.slug, planId: pl.planId, op });

const postPlanDiscard = () =>
  api({ action: "plan_discard", slug: wf.slug, planId: pl.planId });

/* ─────────────────────── the argument editor's controls, per tool
 *
 * ⚠ ONE CONTROL PER inputSchema PROPERTY, and the attribute is SPELLED OUT
 * rather than composed. The parity gate reads `data-planarg="<tool>.<key>"` as
 * a literal out of this file and fails until every documented argument of every
 * tool a plan can edit has one — because the census can see a route's `b.*`
 * parameters and cannot see inside an item's `args`, which is the same
 * 153-unreachable-parameter defect one level deeper. A composed attribute would
 * pass a grep that reads structure and fail the one that reads promises.
 *
 * A tool that is NOT in this table falls back to a raw JSON editor over the
 * whole args object, so there is no argument an agent can send and a person
 * cannot. The toggle above the fields opens that editor for these five too,
 * which is the escape hatch for the day a schema grows a knob before this table
 * does. */
const PLAN_FIELDS = {
  mv_generate_clip: [
    { k: "slug", a: 'data-planarg="mv_generate_clip.slug"', t: "text", hint: "the project this item runs in" },
    { k: "segment", a: 'data-planarg="mv_generate_clip.segment"', t: "text", hint: "segment id, or the 0-based scene index" },
    { k: "seed", a: 'data-planarg="mv_generate_clip.seed"', t: "int", hint: "empty rolls a fresh one" },
  ],
  mv_regen_clip: [
    { k: "slug", a: 'data-planarg="mv_regen_clip.slug"', t: "text", hint: "the project this item runs in" },
    { k: "segment", a: 'data-planarg="mv_regen_clip.segment"', t: "text", hint: "segment id, or the 0-based scene index" },
    { k: "clip_id", a: 'data-planarg="mv_regen_clip.clip_id"', t: "text", hint: "instead of a segment — what a Studio timeline item knows about itself" },
    { k: "prompt", a: 'data-planarg="mv_regen_clip.prompt"', t: "textarea", hint: "render this take with this text, storing nothing on the project" },
    { k: "prompt_source", a: 'data-planarg="mv_regen_clip.prompt_source"', t: "select",
      o: ["built", "edited", "argument"], hint: "which of the three prompts this render uses" },
    { k: "seed", a: 'data-planarg="mv_regen_clip.seed"', t: "int", hint: "hold the seed so a prompt change is the only variable" },
    { k: "loop", a: 'data-planarg="mv_regen_clip.loop"', t: "bool", d: true, hint: "hold the opening frame — off is ~3x the motion, against identity drift" },
  ],
  mv_generate_asset: [
    { k: "slug", a: 'data-planarg="mv_generate_asset.slug"', t: "text", hint: "the project this item runs in" },
    { k: "kind", a: 'data-planarg="mv_generate_asset.kind"', t: "select",
      o: ["characters", "backgrounds", "props", "boards"], hint: "which list the row is in" },
    { k: "id", a: 'data-planarg="mv_generate_asset.id"', t: "text", hint: "the row's id or exact name" },
    { k: "count", a: 'data-planarg="mv_generate_asset.count"', t: "int", hint: "1-4 variants from one text encode. Default 4." },
    { k: "seed", a: 'data-planarg="mv_generate_asset.seed"', t: "int", hint: "hold it to redraw the same row with a changed description" },
    { k: "refs", a: 'data-planarg="mv_generate_asset.refs"', t: "bool", d: true,
      hint: "boards only: off is the SINGLE PANEL draw. A sheet render takes no references either way." },
  ],
  mv_blender_sheet: [
    { k: "slug", a: 'data-planarg="mv_blender_sheet.slug"', t: "text", hint: "the project this item runs in" },
    { k: "target", a: 'data-planarg="mv_blender_sheet.target"', t: "select",
      o: ["character", "background", "prop"], hint: "the row kind. Default prop — the rows this exists for." },
    { k: "id", a: 'data-planarg="mv_blender_sheet.id"', t: "text", hint: "the row's id or exact name; it must already be declared" },
    { k: "builtin", a: 'data-planarg="mv_blender_sheet.builtin"', t: "text", hint: '"<set>:<mesh>" from the Blender catalogue. Exactly one of builtin or asset.' },
    { k: "asset", a: 'data-planarg="mv_blender_sheet.asset"', t: "text", hint: "full path to a .blend/.obj/.glb/.gltf/.fbx/.stl" },
    { k: "angles", a: 'data-planarg="mv_blender_sheet.angles"', t: "list", hint: "one take per angle, comma separated. Default three_quarter, front, side." },
    { k: "res", a: 'data-planarg="mv_blender_sheet.res"', t: "int", hint: "square pixels per panel, 256-2048. Default 1024." },
    { k: "samples", a: 'data-planarg="mv_blender_sheet.samples"', t: "int", hint: "render samples, 8-256. Default 64." },
    { k: "transparent", a: 'data-planarg="mv_blender_sheet.transparent"', t: "bool", d: false,
      hint: "alpha instead of the neutral card. The card is what keeps environment out of a reference." },
    { k: "aspect", a: 'data-planarg="mv_blender_sheet.aspect"', t: "select",
      o: ["square", "16:9", "4:3", "3:2", "9:16"], hint: "panel shape. Default square." },
    { k: "lens", a: 'data-planarg="mv_blender_sheet.lens"', t: "num", hint: "focal length in mm, default 85 — portrait compression, which is what a reference wants" },
  ],
  mv_previz_shot: [
    { k: "slug", a: 'data-planarg="mv_previz_shot.slug"', t: "text", hint: "the project this item runs in" },
    { k: "move", a: 'data-planarg="mv_previz_shot.move"', t: "text", hint: "a move name from the previz catalogue" },
    { k: "segment", a: 'data-planarg="mv_previz_shot.segment"', t: "text", hint: "file the previz against a scene. Optional." },
    /* ⚠ `o` IS A FUNCTION HERE, and that is the whole point: the sets belong to
     * the Blender toolkit across the licence boundary, and the seven names that
     * used to sit on this line went stale the day an eighth was added. It reads
     * the same payload the board editor's set picker reads. */
    { k: "scene", a: 'data-planarg="mv_previz_shot.scene"', t: "select",
      o: () => previzSets, hint: "the gray-box set to block in, from the toolkit's own list. Default corridor." },
    { k: "frames", a: 'data-planarg="mv_previz_shot.frames"', t: "int", hint: "121-480, default 144 — six seconds at 24fps" },
    { k: "render", a: 'data-planarg="mv_previz_shot.render"', t: "bool", d: true, hint: "off returns only the words, spending nothing" },
    { k: "framing", a: 'data-planarg="mv_previz_shot.framing"', t: "select",
      o: ["wide", "medium", "close", "extreme close", "over-the-shoulder", "insert", "establishing"], hint: "the framing sentence" },
    { k: "subject", a: 'data-planarg="mv_previz_shot.subject"', t: "text", hint: "who or what the move is about" },
    { k: "third", a: 'data-planarg="mv_previz_shot.third"', t: "select", o: ["left", "right", "centre"], hint: "which third the subject sits in" },
    { k: "pronoun", a: 'data-planarg="mv_previz_shot.pronoun"', t: "select", o: ["they", "she", "he", "it"], hint: "how the words refer to the subject" },
    { k: "angle", a: 'data-planarg="mv_previz_shot.angle"', t: "text", hint: "a named angle, folded into the framing sentence" },
    { k: "action", a: 'data-planarg="mv_previz_shot.action"', t: "text", hint: "the shot's action line" },
    { k: "lens", a: 'data-planarg="mv_previz_shot.lens"', t: "num", hint: "focal length in mm for the PREVIZ render — changes the blocking clip, not the words" },
    { k: "lensFeel", a: 'data-planarg="mv_previz_shot.lensFeel"', t: "text", hint: "prose colour on the lens sentence" },
    { k: "lighting", a: 'data-planarg="mv_previz_shot.lighting"', t: "text", hint: "prose colour on the lens sentence" },
    { k: "reference", a: 'data-planarg="mv_previz_shot.reference"', t: "json",
      hint: 'the reference frame, as JSON: {"builtin":"dig:artifact"} or {"asset":"C:\\\\...\\\\thing.glb"}. Empty for none.' },
    { k: "u", a: 'data-planarg="mv_previz_shot.u"', t: "num", hint: "where in the move the reference viewpoint is taken, 0-1. Default 0.5." },
    { k: "blockout", a: 'data-planarg="mv_previz_shot.blockout"', t: "bool", d: false,
      hint: "render a CONTROL clip for VACE instead of a previz for a person — flat grey at the clip contract, its own file and its own sidecar" },
    { k: "move_args", a: 'data-planarg="mv_previz_shot.move_args"', t: "json",
      hint: "the move's own keyword arguments — {\"aim_at\":\"neck\",\"rise\":6}. They steer the "
        + "clip, not the words; the legal keys are the move's own and the toolkit names them "
        + "in its refusal." },
    { k: "spec", a: 'data-planarg="mv_previz_shot.spec"', t: "json",
      hint: '{"figures":[{"id":"kaya","at":[0,2,0],"to":[0,9,0]}],"props":[]} — who stands where, in metres, +Z up. `at` is where the thing stands.' },
  ],
};

/* ───────────────────────────────────────────────────── reading the plan */

async function loadPlan() {
  pl.err = null;
  /* ⚠ THE CARD'S STATE BELONGS TO ONE PROJECT. `planId` is the sharp one: read
   * an archived plan, switch projects, and the next read asks the new project
   * for a plan id it has never heard of — which the route correctly refuses,
   * so a perfectly healthy project would paint a refusal. Everything the person
   * was in the middle of goes with it: an open editor, a staged item, a ticked
   * acknowledgement. None of them mean anything in another document. */
  if (pl.slug !== wf.slug) {
    pl.slug = wf.slug;
    pl.planId = null; pl.open = null; pl.raw = false; pl.addTool = "";
    pl.propose = null; pl.staged = []; pl.say = null; pl.ack.clear();
  }
  if (!wf.doc || wf.doc.kind === "audiobook") { pl.view = null; pl.index = []; return; }
  try {
    const r = await postPlanRead({ planId: pl.planId });
    pl.view = r.plan || null;
    pl.index = r.plans || [];
    /* `running` is the RUNNER's answer — is there a walk in flight for this
     * slug right now — while `plan.state` is what the document says. They agree
     * except in the seconds around a restart, and the poll follows whichever is
     * true, because a card that stopped updating mid-run is indistinguishable
     * from a run that stopped. */
    pl.running = !!r.running;
  } catch (err) {
    /* ⚠ NEVER A BLANK. On the build that predates this feature the route
     * answers "Unknown action: plan_read", and explain() turns that into the
     * restart instruction — which is the only thing that fixes it, and which a
     * reader who does not know that web/ and server/ reload on different clocks
     * would otherwise file as a bug against the card. */
    pl.view = null; pl.index = [];
    pl.err = explain(err);
  }
}

/** Minutes, said the way a person reads a night. */
const planMins = (m) => {
  if (!Number.isFinite(Number(m))) return "—";
  const n = Number(m);
  if (n <= 0) return "free";
  if (n < 1) return "under a minute";
  const h = Math.floor(n / 60), r = Math.round(n % 60);
  return h ? `${h} h ${r} m` : `${Math.round(n)} m`;
};
const planClock = (t) => (Number.isFinite(Number(t))
  ? new Date(Number(t)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

/** What an item's estimate is BASED on, so a number can be argued with. */
function estimateTitle(est) {
  if (!est) {
    return "UNPRICED — there is no cost model for this tool, so it is reported as unpriced and "
      + "never folded into the total as a zero.";
  }
  const bits = [`basis: ${est.basis}`];
  if (est.measuredFrom) bits.push(est.measuredFrom);
  /* `per` is the UNIT — a take, an angle, a call — and the minutes are the
   * product, so the per-unit figure is derived rather than reprinted. Written
   * out because the first draft said "4 x take min", which is not a sentence. */
  if (est.count) {
    bits.push(`${est.count} ${est.per}${est.count === 1 ? "" : "s"} at `
      + `${Math.round((est.minutes / est.count) * 100) / 100} min each`);
  }
  if (est.clips) bits.push(`${est.clips} clips at ~${est.perClipMinutes} min`);
  if (est.upperMinutes && est.upperMinutes !== est.minutes) bits.push(`up to ${planMins(est.upperMinutes)}`);
  if (est.why) bits.push(est.why);
  if (est.cite) bits.push(`cite: ${est.cite}`);
  return bits.join(" · ");
}

/* ───────────────────────────────────────────────────────── the card */

function renderPlanInner() {
  pl.shownAt = Date.now();
  const say = pl.say ? `<p class="hint planoutcome">${esc(pl.say)}</p>` : "";
  if (pl.err) {
    /* ⚠ AND IT STILL ANSWERS A PRESS. Found by opening the running app: with
     * this branch on screen, "Plan the unrendered scenes" repainted the same
     * sentence and read as a button that does nothing — which is worse than a
     * refusal, because it teaches people the control is broken rather than the
     * build is old. `say` carries what they just pressed. */
    return `<h3>Plan</h3>${pl.err.split("\n\n").map((para) =>
      `<p class="hint bad">${esc(para)}</p>`).join("")}${say}`;
  }
  const v = pl.view;
  if (!v) return renderPlanEmpty() + say;

  const q = v.quality || {};
  const t = v.totals || {};
  const s = v.spend || {};
  const live = LIVE_PLAN_STATES.has(v.state);
  const running = v.state === "running";

  const traps = (q.traps || []).map((x) => {
    const msg = x.msg || QUALITY_TRAPS[x.kind] || x.kind;
    return x.level === "error"
      ? `<div class="shotmiss"><b>⚠ ${esc(msg)}</b> <span class="dim">${esc(x.cite || "")}</span></div>`
      : `<p class="hint warnhint">⚠ ${esc(msg)} <span class="dim">${esc(x.cite || "")}</span></p>`;
  }).join("");

  return `<h3>Plan · ${esc(v.title)} ${planChip(v.state)}</h3>
    ${/* `ago()` answers "now" under a minute, so "${ago()} ago" printed "now
        * ago" on every freshly proposed plan — which is the first thing anybody
        * sees. It gets its own word. */""}
    <p class="hint planby">proposed by <b>${esc(v.createdBy || "—")}</b> · ${
      ago(v.createdAt) === "now" ? "just now" : `${esc(ago(v.createdAt))} ago`}
      ${v.note ? `<br><span class="warnhint">${esc(v.note)}</span>` : ""}</p>
    <p class="planintent">"${esc(v.intent)}"</p>

    ${/* THE QUALITY LINE, on the object being approved. */""}
    <p class="planquality" id="planQuality"><b>${esc(q.line || "engine and size not readable")}</b></p>
    ${traps}

    ${/* ⚠ A FINISHED PLAN IS COUNTED IN WHAT HAPPENED, not in what is approved.
        * The headline is about the run ahead, so on a done plan it read "3 items
        * · 0 approved · nothing approved yet" one line under the runner's own
        * "2 of 3 done." — two true sentences that contradict each other. */""}
    <p class="plantotals"><b>${t.items}</b> item${t.items === 1 ? "" : "s"} ·
      ${live
        ? `<b>${t.approved}</b> approved · <b>${esc(t.headline || "—")}</b>`
        : `<b>${t.done || 0}</b> done`}
      ${live && t.etaAt ? ` · finishes ~${esc(planClock(t.etaAt))}` : ""}
      ${t.unpriced ? ` · <span class="warnhint">${t.unpriced} unpriced</span>` : ""}
      ${t.skipped ? ` · ${t.skipped} skipped` : ""}${t.failed ? ` · <span class="warnhint">${t.failed} failed</span>` : ""}
      ${t.measuredFrom ? `<br><span class="dim">measured from ${esc(t.measuredFrom)}</span>` : ""}
      ${t.spread ? `<br><span class="dim">${esc(t.spread)}</span>` : ""}</p>

    ${renderPlanSpend(s)}

    <div class="planrows">${(v.items || []).map(renderPlanRow).join("")
      || `<p class="hint">No items yet — add one below, or from a scene's <b>+ Plan</b> button.</p>`}</div>

    ${renderPlanFoot(v, t, live, running)}
    ${/* ⚠ THE DOOR STAYS OPEN AFTER A RUN. Found by finishing one: the card goes
        * on showing the finished plan (which is right — it is the record of what
        * just happened), and with the propose form living only in the empty
        * state there was then NO WAY on the page to start the next one. */""}
    ${live ? "" : `<div class="framepick">
      <button class="edtool" type="button" id="planProposeOpen">Propose another plan…</button>
    </div>
    <div id="planProposeHost">${pl.propose ? renderProposeForm() : ""}</div>`}
    ${say}`;
}

const planChip = (state) => `<span class="wstatus" data-status="${esc(state)}">${esc(state)}</span>`;

/** No plan open: the door, and the history. */
/**
 * IS THERE A PLAN TO PAINT A CARD FOR? §9's answer, in one place, used by the
 * first paint (renderWide) and by every repaint (paintPlanCard) so the two
 * cannot disagree about the same moment.
 *
 * "Live" is wider than `LIVE_PLAN_STATES` on purpose, and each of the four
 * additions is a state a person is standing in the middle of:
 *   - the propose form is open (they are writing one)
 *   - items are staged by "+ Plan" with no plan yet (they are collecting one)
 *   - `planId` is set (they are READING a finished or cancelled plan on purpose)
 *   - `err` is set (the card owes them a sentence, and a collapsed opener would
 *     swallow the one explanation of why the plan controls do nothing)
 */
function planIsLive() {
  return !!(pl.view && LIVE_PLAN_STATES.has(pl.view.state))
    || !!pl.propose || !!pl.staged.length || !!pl.planId || !!pl.err;
}
const planCardClass = () => (planIsLive() ? "wfcard planscard" : "planopener");

/**
 * NO PLAN — one line and one button, not a card.
 *
 * The long explanation of what a plan is belongs where somebody is about to
 * make one, so it moved into the branch that paints the propose form. Painted
 * unconditionally on every stage of every project it was a paragraph nobody
 * read twice standing over eleven screens that had nothing to do with it.
 */
function renderPlanEmpty() {
  const opener = `<div class="framepick">
      <button class="edtool sm" type="button" id="planProposeOpen">Propose a plan…</button>
      ${renderPastPlans()}
    </div>`;
  if (!pl.propose) {
    return `<span class="planopenline">No plan on this project. A <b>plan</b> is a list of
      renders you read and approve before any of them runs.</span>${opener}
      <div id="planProposeHost"></div>`;
  }
  return `<h3>Plan</h3>
    <p class="hint">A plan is a list of tool calls somebody intends to make — which scenes, on
      which engine, at which size, with which references — that you read, edit, approve item by
      item, and only then start. <b>Nothing renders when a plan is proposed, and nothing renders
      when it is approved.</b> The GPU is spent by Run, and only on the items marked approved.</p>
    ${opener}
    <div id="planProposeHost">${renderProposeForm()}</div>`;
}

function renderPastPlans() {
  if (!pl.index.length) return "";
  return `<label class="genopt" title="Read a plan that is finished or cancelled. It is history — the controls are refused on it.">past plans
    <select class="sel2 sm" id="planPast">
      <option value="">the live plan</option>
      ${pl.index.map((p) => `<option value="${esc(p.id)}"${pl.planId === p.id ? " selected" : ""}>${
        esc(p.title)} · ${esc(p.state)} · ${p.items} item${p.items === 1 ? "" : "s"}</option>`).join("")}
    </select></label>`;
}

/* THE METER IS ALWAYS PAINTED, EVEN WITH THE GATE OFF (§11). It ships off —
 * `brief.agentBudgetMinutes` is null — because a default that starts refusing
 * calls an agent used to be allowed to make is a regression no matter how good
 * the reason. What the owner gets instead is a week of real numbers before
 * choosing a threshold, which beats a guessed one. */
function renderPlanSpend(s) {
  const n = s?.unattendedMinutesSinceApproval;
  return `<p class="hint planspend">unattended spend since the last approval:
    <b>${n == null ? "not read" : `${n} min`}</b>
    ${s?.sinceAgo != null ? `<span class="dim">(${s.sinceAgo} min ago)</span>` : ""}
    ${s?.budgetMinutes == null
      ? "— no budget is set, so nothing is refused; the number is here to be watched"
      : `— budget ${s.budgetMinutes} min${s.over ? ", <b class=\"warnhint\">OVER</b>" : ""}`}
    <label class="genopt" title="An agent's spend since your last approval is measured against this. Empty is no gate at all, which is what ships. 30 minutes is roughly one H3 clip at 1080p: an agent may spend one expensive mistake unattended, never two.">budget
      <input class="line sm num" id="planSpendBudget" type="number" min="0" step="5" style="width:64px"
        value="${s?.budgetMinutes ?? ""}"> min
      <button class="edtool sm" type="button" id="planSaveBudget">Save</button></label></p>`;
}

/** One item. The tool NAME is printed, in mono — "one door" made visible rather
 *  than implied: what runs is the tool this row names, with the arguments this
 *  row carries, and there is no translation in between. */
function renderPlanRow(it) {
  const q = it.quality || null;
  const est = it.estimate;
  const acks = it.needsAcknowledgement || [];
  const ticked = pl.ack.has(it.id);
  const frozen = it.status === "running" || it.status === "done";

  const where = q?.scene != null ? `scene ${q.scene}`
    : (it.args?.id || it.args?.segment || it.args?.segmentId || "—");
  const shape = !q ? ""
    : q.error ? `<span class="warnhint">${esc(q.error)}</span>`
    : `${esc(q.engine)} ${q.width}x${q.height}${q.quantised
        ? ' <span class="planq" title="The engine floors the size to its own grid, so this is the'
          + ' size it will really render at — not the one the brief asks for.">⌗</span>' : ""}`
      + `${q.refsSent ? ` · ${(q.refs || []).length} ref${(q.refs || []).length === 1 ? "" : "s"}` : q.useRefs === false ? " · refs not carried" : ""}`;

  const warns = (it.warnings || []).map((w) => (w.level === "error"
    ? `<div class="shotmiss"><b>${esc(w.kind)}</b> ${esc(w.msg)}</div>`
    : `<p class="hint warnhint">⚠ ${esc(w.msg)}</p>`)).join("");

  /* ⚠ THE ACKNOWLEDGEMENT IS IN FRONT OF THE MISTAKE, not behind it. A scene
   * carrying a reference with no rendered sheet is about to spend up to
   * 28 minutes rendering a named prop the model is handed NOTHING for — the
   * failure DIRECTING.md is mostly about. Approve is disabled until the box is
   * ticked, because refusing after the fact is worse than not being able to
   * make the mistake. It is a speed bump with the reason attached, not a wall:
   * tick it and the approval goes through, carrying `acknowledge`. */
  const ackRow = acks.length ? `<label class="planack">
    <input type="checkbox" data-planack="${esc(it.id)}"${ticked ? " checked" : ""}>
    <span>I have read what this render will be given nothing for:
      ${acks.map((m) => esc(m)).join(" · ")}</span></label>` : "";

  return `<div class="planrow" data-planitem="${esc(it.id)}">
    <div class="planhead">
      <span class="planbtns">
        <button class="edtool sm" type="button" data-planapprove="${esc(it.id)}"
          ${frozen || (acks.length && !ticked) ? " disabled" : ""}
          title="${acks.length && !ticked
            ? "Tick the acknowledgement below first — this item renders a scene with a reference that reaches it as nothing."
            : "Approve this item. Approval is of THESE arguments; editing them drops it back to edited."}">✓</button>
        <button class="edtool sm" type="button" data-planskip="${esc(it.id)}"${frozen ? " disabled" : ""}
          title="Take it out of this run without deleting it.">⊘</button>
        <button class="edtool sm" type="button" data-planedit="${esc(it.id)}"${frozen ? " disabled" : ""}
          title="Change the arguments. An approved item drops back to edited and must be approved again.">✎</button>
        <button class="edtool sm" type="button" data-planremove="${esc(it.id)}"${frozen ? " disabled" : ""}
          title="Delete this item from the plan. Its id is retired and never reused.">✕</button>
      </span>
      <span class="planwhere">${esc(String(where))}</span>
      <code class="plantool">${esc(it.tool)}</code>
      <span class="planshape">${shape}</span>
      <span class="planest" title="${esc(estimateTitle(est))}">${est
        ? `~${esc(planMins(est.minutes))}${est.upperMinutes && est.upperMinutes !== est.minutes
            ? `–${esc(planMins(est.upperMinutes))}` : ""}`
        : '<span class="warnhint">unpriced</span>'}</span>
      <span class="wstatus" data-status="${esc(it.status)}">${esc(it.status)}</span>
    </div>
    ${it.why ? `<p class="planwhy">"${esc(it.why)}"</p>` : ""}
    ${it.error ? `<p class="hint bad">failed: ${esc(it.error)}</p>` : ""}
    ${it.result?.asset ? `<p class="hint dim">produced ${esc(it.result.asset)}</p>` : ""}
    ${warns}${ackRow}
    <div data-planedithost="${esc(it.id)}">${pl.open === it.id ? planItemEditor(it) : ""}</div>
  </div>`;
}

/** The decision row, the policy row, and Start. */
function renderPlanFoot(v, t, live, running) {
  const pol = v.policy || {};
  const brief = pol.delegateBrief || "";
  return `<div class="planfoot">
    <div class="framepick">
      <button class="edtool sm" type="button" id="planApproveAll"${live && !running ? "" : " disabled"}>Approve all</button>
      <button class="edtool sm" type="button" id="planSkipAll"${live && !running ? "" : " disabled"}>Skip all</button>
      <span class="dim">${t.proposed || 0} proposed · ${t.edited || 0} edited</span>
    </div>
    <details class="planwhy2"><summary>say why — recorded with the decision</summary>
      <label class="dfield"><span>reasoning</span>
        <input class="line" id="planReason" placeholder="what made this the right call"></label>
      <label class="dfield"><span>your own words</span>
        <textarea class="wprompt" id="planFree" rows="2"
          placeholder="direction, in your words — kept verbatim on the record"></textarea></label>
      <p class="hint dim">Both ride with the approval into the project's provenance ledger. The
        ledger never records a machine decision as a human one, and this is the half that is
        genuinely yours.</p>
    </details>

    <div class="framepick planpolicy">
      <label class="genopt">on failure
        <select class="sel2 sm" id="planPolicy">
          <option value="halt"${pol.onFailure === "continue" ? "" : " selected"}>halt</option>
          <option value="continue"${pol.onFailure === "continue" ? " selected" : ""}>continue</option>
        </select></label>
      <label class="genopt" title="A number here is a DELEGATION: the machine approves items under it on your behalf. It needs your brief.">auto-approve under
        <input class="line sm num" id="planAuto" type="number" min="0" step="1" style="width:56px"
          value="${pol.autoApproveUnderMinutes ?? ""}"${brief.trim() ? "" : " disabled"}> min</label>
      <button class="edtool sm" type="button" id="planSavePolicy">Save policy</button>
    </div>
    <label class="dfield"><span>delegate brief — your goals, in your own words</span>
      <textarea class="wprompt" id="planBrief" rows="2"
        placeholder="what you want out of this run, so a machine approval can be judged against it">${esc(brief)}</textarea></label>
    <p class="hint dim">⚠ <b>halt</b> stops the run on the first failure and <b>leaves the rest
      approved</b>, so pressing Run again carries on from there — approve-then-start holds on
      every resumption, not only the first. <b>continue</b> records the failure and steps over it.
      The auto-approve box stays disabled until the brief has text: a delegation needs the human's
      brief in their own words, because it is the direction-setting the record keeps as their
      contribution.</p>

    <div class="framepick planrun">
      <button class="edtool" type="button" id="planRun"${(t.approved || 0) && !running ? "" : " disabled"}
        title="Runs the approved items in order, one at a time, and returns straight away — this card follows along.">
        ${running ? "running…" : `Run ${t.approved || 0} approved item${(t.approved || 0) === 1 ? "" : "s"}`}</button>
      <button class="edtool sm" type="button" id="planPause"${running ? "" : " disabled"}
        title="Lets the render in flight finish, then stops. Killing a nearly-complete H3 clip throws away twenty minutes for nothing.">Pause</button>
      <button class="edtool sm" type="button" id="planResume"${v.state === "paused" ? "" : " disabled"}>Resume</button>
      <button class="edtool sm" type="button" id="planStop"${live ? "" : " disabled"}
        title="Stops now: cancels the plan, marks everything still approved as skipped, and cancels this project's clip on the graphics card. Pause is the one that lets a render finish.">Stop</button>
      <button class="edtool sm" type="button" id="planDiscard"${running ? " disabled" : ""}
        title="Throws the whole plan away. Refused while it is running.">Discard plan</button>
      ${renderPastPlans()}
    </div>

    <details class="planadd"><summary>+ Add an item</summary>
      <label class="dfield"><span>tool</span>
        <input class="line" id="planAddTool" list="planToolList" spellcheck="false"
          placeholder="mv_generate_clip" value="${esc(pl.addTool || "")}">
        <datalist id="planToolList">${Object.keys(PLAN_FIELDS).map((n) =>
          `<option value="${esc(n)}">`).join("")}</datalist></label>
      <p class="hint dim">The name of a tool you can already call. There is no second execution
        path: the runner resolves this name in the tool table and calls it with the arguments
        below. A name that does not exist is refused here, for free, rather than three hours in —
        and the refusal lists the legal names.</p>
      <div id="planAddArgsHost">${planArgControls(pl.addTool, { slug: wf.slug }, false)}</div>
      <label class="dfield"><span>why</span>
        <input class="line" id="planAddWhy" placeholder="one sentence — what this item is for"></label>
      <label class="dfield"><span>insert at</span>
        <input class="line sm num" id="planAddAt" type="number" min="0" style="width:64px"
          placeholder="end"></label>
      <p class="hint dim">The runner walks the list in order, so position is the running order.
        Empty appends.</p>
      <div class="framepick"><button class="edtool sm" type="button" id="planAddSave">Add to the plan</button></div>
    </details>
  </div>`;
}

/* ─────────────────────────────────── the item editor, and its arguments */

function planItemEditor(it) {
  const known = !!PLAN_FIELDS[it.tool];
  return `<div class="planeditbox">
    <p class="hint">Editing <code>${esc(it.tool)}</code>. Only what you change is sent: an empty
      box on an argument that had a value <b>deletes</b> it, which is how a tool goes back to its
      own default.</p>
    ${known ? `<label class="genopt"><input type="checkbox" id="planRawTog"${pl.raw ? " checked" : ""}>
        edit as raw JSON</label>`
      : `<p class="hint dim">No field editor for this tool yet, so its whole argument object is
         here as JSON — no argument is reachable by an agent and not by you.</p>`}
    <div id="planArgs">${planArgControls(it.tool, it.args || {}, pl.raw)}</div>
    <label class="dfield"><span>why</span>
      <input class="line" id="planEditWhy" value="${esc(it.why || "")}"></label>
    <div class="framepick">
      <button class="edtool sm" type="button" id="planEditSave">Save the edit</button>
      <button class="edtool sm" type="button" id="planEditCancel">Cancel</button>
    </div>
    <p class="hint dim">⚠ Saving drops an <b>approved</b> item back to <b>edited</b>, and it has to
      be approved again. That is deliberate: an approval is of a specific set of arguments, and
      carrying it across a change would make approving mean nothing. The estimate above moves with
      your edit, which is the whole point of the object.</p>
  </div>`;
}

/** Fields when the tool is known and the raw toggle is off; the whole args
 *  object as JSON otherwise. */
function planArgControls(tool, args, raw) {
  const fields = PLAN_FIELDS[tool];
  if (!fields || raw) return planRawEditor(args);
  /* The set list belongs to the server. Asking here costs one fetch per page
   * and the pickers fill themselves in when it answers. */
  if (fields.some((f) => typeof f.o === "function")) ensureLivePickers();
  return `<div class="planargs">${fields.map((f) => planField(f, args)).join("")}</div>`;
}

const planRawEditor = (args) => `<label class="dfield"><span>args — raw JSON</span>
  <textarea class="wprompt tall" data-planraw spellcheck="false">${
    esc(JSON.stringify(args || {}, null, 2))}</textarea></label>`;

function planField(f, args) {
  const v = args?.[f.k];
  const lab = `<span>${esc(f.k)}</span>`;
  const hint = f.hint ? `<i class="planhint">${esc(f.hint)}</i>` : "";
  if (f.t === "bool") {
    const on = v === undefined || v === null ? !!f.d : !!v;
    return `<label class="planarg"><span class="planargb"><input type="checkbox" ${f.a}${on ? " checked" : ""}>
      ${lab}</span>${hint}</label>`;
  }
  if (f.t === "select") {
    return `<label class="planarg">${lab}<select class="sel2 sm" ${f.a}>${
      planOptions(f, v)}</select>${hint}</label>`;
  }
  if (f.t === "textarea" || f.t === "json") {
    const text = f.t === "json"
      ? (v === undefined || v === null ? "" : JSON.stringify(v))
      : (v ?? "");
    return `<label class="planarg wide">${lab}
      <textarea class="wprompt" ${f.a} rows="2" spellcheck="false">${esc(text)}</textarea>${hint}</label>`;
  }
  const num = f.t === "int" || f.t === "num";
  const text = f.t === "list" ? (Array.isArray(v) ? v.join(", ") : (v ?? "")) : (v ?? "");
  return `<label class="planarg">${lab}<input class="line sm${num ? " num" : ""}"${
    num ? ' type="number"' : ""} ${f.a} spellcheck="false" value="${esc(text)}">${hint}</label>`;
}

/**
 * A select's options. `f.o` is either a fixed list or a FUNCTION returning one
 * that the server owns (the previz sets), which may not have arrived yet.
 *
 * Two rules that a fixed list never needed:
 *   - a live list that is not here yet says so, rather than showing an empty
 *     picker that reads as "there are none";
 *   - a value already saved in the item is ALWAYS offered even when it is not
 *     in the list, because silently dropping it from the picker would rewrite
 *     somebody's plan item the moment they pressed save.
 */
function planOptions(f, v) {
  const live = typeof f.o === "function";
  const list = live ? f.o() : f.o;
  const cur = String(v ?? "");
  if (live && !list) {
    return `<option value="">— not set</option>${
      cur ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ""}`;
  }
  const opts = [...(list || [])];
  if (cur && !opts.includes(cur)) opts.unshift(cur);
  return `<option value="">— not set</option>${opts.map((o) =>
    `<option value="${esc(o)}"${cur === o ? " selected" : ""}>${esc(o)}</option>`).join("")}`;
}

/**
 * Fill every live picker on the page once the payload lands, IN PLACE.
 *
 * In place rather than by repainting the editor: a repaint would throw away
 * whatever the person had typed into the other fields while the fetch was in
 * flight. Only the `<select>`s whose options are a function are touched, and
 * each keeps the value it had.
 */
function fillLivePickers() {
  for (const [tool, fields] of Object.entries(PLAN_FIELDS)) {
    for (const f of fields) {
      if (typeof f.o !== "function") continue;
      for (const el of document.querySelectorAll(`select[data-planarg="${tool}.${f.k}"]`)) {
        const cur = el.value;
        el.innerHTML = planOptions(f, cur);
        el.value = cur;
      }
    }
  }
}

/** Ask for the payload the live pickers need, once, and fill them when it lands. */
function ensureLivePickers() {
  if (previzSets) return;
  loadPrevizCat().then(() => { if (previzSets) fillLivePickers(); }).catch(() => {});
}

/** One control's value, or `undefined` for "this argument is not set". */
function planFieldValue(f, el) {
  if (!f) { const s = String(el.value ?? "").trim(); return s === "" ? undefined : s; }
  if (f.t === "bool") return !!el.checked;
  const s = String(el.value ?? "").trim();
  if (s === "") return undefined;
  if (f.t === "int") return Number.isFinite(Number(s)) ? Math.round(Number(s)) : s;
  if (f.t === "num") return Number.isFinite(Number(s)) ? Number(s) : s;
  if (f.t === "list") return s.split(",").map((x) => x.trim()).filter(Boolean);
  if (f.t === "json") {
    try { return JSON.parse(s); }
    catch (err) { throw new Error(`${f.k} is not valid JSON: ${err.message}`); }
  }
  return s;
}

/* WHAT CHANGED, and nothing else. `args` MERGES on the server, so sending the
 * whole object would silently keep a key the person just cleared — the merge
 * has no way to tell "unchanged" from "delete this". `null` is the delete, and
 * this is where it is written. */
function argDiff(before = {}, after = {}) {
  const out = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) out[k] = after[k];
  }
  for (const k of Object.keys(before || {})) {
    if (!(k in after)) out[k] = null;
  }
  return out;
}

/** Read one editor host into an args diff. Throws with a readable sentence. */
function readPlanArgs(hostId, tool, current) {
  const host = $(hostId);
  if (!host) return {};
  const raw = host.querySelector("[data-planraw]");
  if (raw) {
    let next;
    const text = String(raw.value ?? "").trim();
    try { next = text ? JSON.parse(text) : {}; }
    catch (err) { throw new Error(`The arguments are not valid JSON: ${err.message}`); }
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error("The arguments must be a JSON object — the tool's own named arguments.");
    }
    return argDiff(current, next);
  }
  const fields = PLAN_FIELDS[tool] || [];
  const next = {};
  for (const el of host.querySelectorAll("[data-planarg]")) {
    const key = String(el.dataset.planarg || "").split(".").slice(1).join(".");
    const f = fields.find((x) => x.k === key);
    if (f?.t === "bool") {
      const cur = current?.[key];
      /* A checkbox has no "not set", so a box left at the tool's own documented
       * default is not an edit. Without this, opening an editor and saving
       * would pin every default as an explicit argument. */
      if ((cur === undefined || cur === null) && !!el.checked === !!f.d) continue;
      next[key] = !!el.checked;
      continue;
    }
    const v = planFieldValue(f, el);
    if (v !== undefined) next[key] = v;
  }
  return argDiff(current, next);
}

/* ─────────────────────────────────────────────────── the propose form */

function renderProposeForm() {
  const seed = pl.propose?.from || "";
  return `<div class="declare planpropose">
    <h4>Propose a plan</h4>
    <label class="dfield"><span>title</span>
      <input class="line" id="planTitle" spellcheck="false"
        placeholder="Render the 14 unrendered scenes at H3 1920x1088"></label>
    <label class="dfield"><span>intent — why this run</span>
      <textarea class="wprompt" id="planIntent" rows="2"
        placeholder="your own sentence about why. It is the field nobody can write for you, and it is what the person approving actually reads."></textarea></label>
    <label class="dfield"><span>seed the items from</span>
      <select class="sel2 sm" id="planFrom">
        <option value=""${seed ? "" : " selected"}>nothing — start empty${
          pl.staged.length ? ` (${pl.staged.length} staged)` : ""}</option>
        <option value="unrendered"${seed === "unrendered" ? " selected" : ""}>every generate-mode scene with no take</option>
        <option value="stale"${seed === "stale" ? " selected" : ""}>every clip whose take predates its board or its cast</option>
        <option value="nosheet"${seed === "nosheet" ? " selected" : ""}>every declared row with no rendered sheet</option>
      </select></label>
    <p class="hint dim">Seeding reuses the project's own scanners — the same ones the stale sweep
      and the lint report read — so the list is what the project actually knows, not a guess.
      Seed it, then edit it: that is cheaper and more accurate than writing twenty items by hand.</p>
    ${pl.staged.length ? `<p class="hint">Staged from the page: ${pl.staged.map((i) =>
      `<code>${esc(i.tool)}</code>`).join(", ")}</p>` : ""}
    <div class="framepick">
      <button class="edtool" type="button" id="planProposeSave">Propose it</button>
      <button class="edtool sm" type="button" id="planProposeCancel">Cancel</button>
    </div>
    <p class="hint dim">Proposing spends nothing and decides nothing. Approving spends nothing.
      The GPU is reached by Run, and only for the items you marked approved.</p>
  </div>`;
}

/* ───────────────────────────────────────────────────── painting + poll */

function paintPlanCard() {
  const rail = $("planRailLine");
  if (rail) rail.innerHTML = planRailLine();
  const host = $("planCard");
  if (!host) return;
  /* The class travels with the content. A poll that finds a plan has to promote
   * the collapsed opener into the full card IN PLACE — repainting only the
   * inside would leave a card's worth of markup wearing an opener's styling,
   * which is how a state change becomes invisible. */
  host.className = planCardClass();
  host.innerHTML = renderPlanInner();
  wirePlan();
}

/** A plan write, then a re-read, then repaint THIS CARD — not the page. A full
 *  repaint would eat the focus of an open editor, which is where the person is
 *  standing when they make most of these calls. */
async function planBusy(fn) {
  const host = $("planCard");
  host?.classList.add("wfbusy");
  try { await fn(); await loadPlan(); }
  catch (err) { pl.say = null; alert(explain(err)); }
  finally {
    host?.classList.remove("wfbusy");
    paintPlanCard();
    planPolling();
  }
}

/* 3 s while it is running, and not one tick longer. The GET is the cheap read —
 * the whole project document is a much bigger answer and the card needs none of
 * it. */
function planPolling() {
  if (pl.poll) { clearInterval(pl.poll); pl.poll = null; }
  if (!wf.slug || (pl.view?.state !== "running" && !pl.running)) return;
  pl.poll = setInterval(pollPlan, 3000);
}

async function pollPlan() {
  /* An open editor is a person typing. Repainting the card under them would
   * throw the text away, and a run that is walking does not need the card to
   * move every three seconds to stay true. */
  if (pl.open || !$("planCard")) return;
  const was = pl.view?.state;
  try {
    const res = await fetch(`/api/mv/plan/${encodeURIComponent(wf.slug)}`);
    const r = await res.json();
    if (!res.ok || r.error) throw new Error(r.error || `HTTP ${res.status}`);
    pl.view = r.plan || null;
    pl.running = !!r.running;
    if (Array.isArray(r.plans)) pl.index = r.plans;
  } catch {
    /* The GET is the one part of this feature with no action name to explain
     * itself, so the sentence is said here rather than left as a silent stall:
     * a card that stops updating and says nothing is indistinguishable from a
     * run that has stopped. */
    pl.err = `The plan poll could not read /api/mv/plan/${wf.slug}. `
      + `${RESTART_REQUIRED} The run itself is unaffected — it is on the server, not on this page.`;
    if (pl.poll) { clearInterval(pl.poll); pl.poll = null; }
    paintPlanCard();
    return;
  }
  paintPlanCard();
  if (was === "running" && pl.view?.state !== "running") {
    if (pl.poll) { clearInterval(pl.poll); pl.poll = null; }
    /* Takes have landed: the clips table, the stage rail and the map are all
     * stale now, so this is the one moment the whole page is worth repainting. */
    await loadProject();
  }
}

/* ───────────────────────────────────────────────────────── the wiring */

function wirePlan() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };

  /* -- propose -- */
  on("planProposeOpen", "onclick", () => openPropose("", null));
  on("planProposeCancel", "onclick", () => { pl.propose = null; pl.staged = []; paintPlanCard(); });
  on("planProposeSave", "onclick", async () => {
    const title = $("planTitle").value.trim();
    const intent = $("planIntent").value.trim();
    if (!title) { $("planTitle").focus(); return; }
    if (!intent) { $("planIntent").focus(); return; }
    const from = $("planFrom").value || undefined;
    const items = pl.staged.length ? pl.staged.map((i) => ({ tool: i.tool, args: i.args, why: i.why })) : undefined;
    await planBusy(async () => {
      await postPlanPropose({ title, intent, from, items });
      pl.propose = null; pl.staged = [];
      pl.say = "Proposed. Nothing has rendered — read it, change what you want, approve the items "
        + "you mean, then press Run.";
    });
  });

  /* -- per item -- */
  for (const btn of document.querySelectorAll("[data-planapprove]")) {
    btn.onclick = () => decidePlan([btn.dataset.planapprove], "approved");
  }
  for (const btn of document.querySelectorAll("[data-planskip]")) {
    btn.onclick = () => decidePlan([btn.dataset.planskip], "skipped");
  }
  for (const cb of document.querySelectorAll("[data-planack]")) {
    cb.onchange = () => {
      const id = cb.dataset.planack;
      if (cb.checked) pl.ack.add(id); else pl.ack.delete(id);
      /* Only the one button moves. Repainting the card here would close an
       * editor and scroll the list under a person who ticked a box. */
      const ok = document.querySelector(`[data-planapprove="${CSS.escape(id)}"]`);
      if (ok) {
        ok.disabled = !cb.checked;
        ok.title = cb.checked
          ? "Approve this item. The acknowledgement rides with it and is recorded."
          : "Tick the acknowledgement first.";
      }
    };
  }
  for (const btn of document.querySelectorAll("[data-planedit]")) {
    btn.onclick = () => {
      pl.open = pl.open === btn.dataset.planedit ? null : btn.dataset.planedit;
      pl.raw = false;
      paintPlanCard();
    };
  }
  for (const btn of document.querySelectorAll("[data-planremove]")) {
    btn.onclick = async () => {
      const id = btn.dataset.planremove;
      if (!(await appConfirm(`Remove item ${id} from the plan? Its id is retired and never reused, so the `
        + "record of what ran cannot be confused later."))) return;
      return planBusy(async () => {
        const r = await postPlanItem({ op: "remove", itemId: id, tool: undefined,
                                       args: undefined, why: undefined, at: undefined });
        pl.say = (r.changed || []).join(" · ") || `${id} removed.`;
      });
    };
  }

  on("planRawTog", "onchange", (e) => { pl.raw = !!e.target.checked; paintPlanCard(); });
  on("planEditCancel", "onclick", () => { pl.open = null; paintPlanCard(); });
  on("planEditSave", "onclick", async () => {
    const it = (pl.view?.items || []).find((x) => x.id === pl.open);
    if (!it) return;
    let args;
    try { args = readPlanArgs("planArgs", it.tool, it.args || {}); }
    catch (err) { alert(err.message); return; }
    const why = $("planEditWhy").value.trim();
    if (!Object.keys(args).length && why === (it.why || "")) {
      pl.say = "Nothing changed, so nothing was sent.";
      paintPlanCard();
      return;
    }
    await planBusy(async () => {
      const r = await postPlanItem({ op: "edit", itemId: it.id, tool: undefined,
                                     args, why: why || undefined, at: undefined });
      pl.open = null;
      pl.say = (r.changed || []).join(" · ") || `${it.id} edited.`;
    });
  });

  /* -- add an item -- */
  on("planAddTool", "oninput", (e) => {
    const next = e.target.value.trim();
    const host = $("planAddArgsHost");
    /* ONLY WHEN THE CONTROLS WOULD ACTUALLY CHANGE. Re-rendering on every
     * keystroke throws away arguments somebody has already filled in — and the
     * two undefineds compare equal, which is exactly right: every unknown tool
     * gets the same raw JSON editor, so typing one unknown name over another
     * must not wipe the box. */
    const same = PLAN_FIELDS[next] === PLAN_FIELDS[pl.addTool];
    pl.addTool = next;
    if (host && !same) host.innerHTML = planArgControls(pl.addTool, { slug: wf.slug }, false);
  });
  on("planAddSave", "onclick", async () => {
    const tool = $("planAddTool").value.trim();
    if (!tool) { $("planAddTool").focus(); return; }
    let args;
    try { args = readPlanArgs("planAddArgsHost", tool, {}); }
    catch (err) { alert(err.message); return; }
    const rawAt = $("planAddAt").value.trim();
    await planBusy(async () => {
      const r = await postPlanItem({
        op: "add", itemId: undefined, tool, args, why: $("planAddWhy").value.trim() || undefined,
        at: rawAt === "" ? undefined : Number(rawAt),
      });
      pl.addTool = "";
      pl.say = (r.changed || []).join(" · ") || `${tool} added.`;
    });
  });

  /* -- decisions in bulk -- */
  on("planApproveAll", "onclick", () => {
    const b = bulkDecision("approved");
    return decidePlan(b.ids, "approved", b);
  });
  on("planSkipAll", "onclick", () => {
    const b = bulkDecision("skipped");
    return decidePlan(b.ids, "skipped", b);
  });

  /* -- policy -- */
  on("planBrief", "oninput", () => {
    /* THE SERVER'S RULE, MADE VISIBLE: a threshold without a brief is refused,
     * so the box that sets one stays shut until the brief has words in it. */
    const el = $("planAuto");
    if (el) el.disabled = !$("planBrief").value.trim();
  });
  on("planSavePolicy", "onclick", async () => {
    const raw = $("planAuto").value.trim();
    await planBusy(async () => {
      await postPlanPolicy({
        onFailure: $("planPolicy").value,
        autoApproveUnderMinutes: raw === "" ? null : Number(raw),
        delegateBrief: $("planBrief").value.trim() || null,
      });
      pl.say = "Policy saved.";
    });
  });

  /* -- the spend budget, which ships OFF -- */
  on("planSaveBudget", "onclick", async () => {
    const raw = $("planSpendBudget").value.trim();
    const want = raw === "" ? null : Number(raw);
    let r = null;
    await planBusy(async () => {
      r = await api({ action: "set_brief", slug: wf.slug,
                      brief: { agentBudgetMinutes: want } });
      pl.say = want == null ? "Budget cleared — the gate is off." : `Budget set to ${want} min.`;
    });
    /* ⚠ READ THE ANSWER BACK. set_brief writes only the keys in its `allowed`
     * list, so a server that has not learned this one answers 200 and stores
     * nothing — success and silent failure look identical from here.
     *
     * ⚠ AND READ IT OUT OF THE RIGHT FIELD. The first draft looked in
     * `r.project.brief`, which set_brief does not return — it answers
     * {ok, brief, stage} — so the check fired on a write that had WORKED and
     * told the person to restart an app that was fine. A read-back that cannot
     * see the answer is worse than no read-back: it produces a false alarm,
     * which is the one kind of alarm people learn to ignore. */
    const got = (r?.brief ?? r?.project?.brief)?.agentBudgetMinutes;
    if (r && (got ?? null) !== (want ?? null)) {
      alert(`The budget did not take: the project still reads ${got ?? "no budget"}.\n\n`
        + `${RESTART_REQUIRED}\n\nUntil then the meter is still counted and painted; only the `
        + "refusal is unavailable, which is what ships by default anyway.");
    }
  });

  /* -- run control -- */
  on("planRun", "onclick", () => runPlan("start"));
  on("planPause", "onclick", () => runPlan("pause"));
  on("planResume", "onclick", () => runPlan("resume"));
  on("planStop", "onclick", async () => {
    if (!(await appConfirm("Stop this plan now? Everything still approved is marked skipped, "
      + "and the clip it has on the graphics card is cancelled.\n\n"
      + "To let that clip finish first, press Pause instead."))) return;
    return runPlan("stop");
  });
  on("planDiscard", "onclick", async () => {
    if (!(await appConfirm("Throw this plan away? The items and their approvals go with it."))) return;
    return planBusy(async () => {
      const r = await postPlanDiscard();
      pl.planId = null; pl.open = null; pl.ack.clear();
      pl.say = r.discarded ? `Discarded "${r.title}" — ${r.items} item(s).` : "Discarded.";
    });
  });

  /* -- history -- */
  on("planPast", "onchange", (e) => {
    pl.planId = e.target.value || null;
    pl.open = null;
    return planBusy(async () => { pl.say = null; });
  });
}

/** Approve or skip, and SAY WHAT WAS REFUSED. A partial approval is the normal
 *  case — the server refuses each warned item on its own and approves the clean
 *  ones beside it, and a card that swallowed the refusal would leave a person
 *  believing they had approved twelve items when they approved nine. */
/**
 * WHAT A BULK DECISION MAY MOVE, and what it must leave alone.
 *
 * ⚠ FOUND BY PRESSING IT. "Approve all" used to post `items: "all"` with
 * `acknowledge: false`, so a person could tick the acknowledgement on a warned
 * row, press Approve all, and watch the server refuse the very item they had
 * just acknowledged. The tick was real and the button ignored it.
 *
 * So the bulk press sends the ids it is entitled to move: everything not
 * running or done, MINUS any warned item whose box is unticked — and
 * `acknowledge` then honestly means "every warned item in this list has been
 * read", because the unticked ones are not in it. The held ones are named in
 * the outcome line rather than silently dropped.
 */
function bulkDecision(status) {
  const items = pl.view?.items || [];
  const live = items.filter((i) => i.status !== "running" && i.status !== "done");
  if (status !== "approved") {
    return { ids: live.map((i) => i.id), acknowledge: false, held: [] };
  }
  const warned = (i) => (i.needsAcknowledgement || []).length > 0;
  const held = live.filter((i) => warned(i) && !pl.ack.has(i.id)).map((i) => i.id);
  const ids = live.filter((i) => !held.includes(i.id)).map((i) => i.id);
  return { ids, acknowledge: live.some((i) => warned(i) && pl.ack.has(i.id)), held };
}

async function decidePlan(items, status, opts = {}) {
  const one = Array.isArray(items) && items.length === 1 ? items[0] : null;
  const held = opts.held || [];
  if (Array.isArray(items) && !items.length) {
    pl.say = held.length
      ? `Nothing could be ${status}: ${held.join(", ")} carr${held.length === 1 ? "ies" : "y"} a warning `
        + "that is not acknowledged. Tick the box on the row."
      : `Nothing to ${status}.`;
    paintPlanCard();
    return;
  }
  let r = null;
  await planBusy(async () => {
    r = await postPlanDecide({
      items, status,
      acknowledge: opts.acknowledge ?? (one ? pl.ack.has(one) : false),
      reasoning: $("planReason")?.value.trim() || undefined,
      freeText: $("planFree")?.value.trim() || undefined,
    });
    const changed = (r.changed || []).length;
    const rejected = (r.rejected || []).length;
    pl.say = `${changed} item${changed === 1 ? "" : "s"} ${status}`
      + (held.length
        ? ` · ${held.join(", ")} left alone — the warning on that row is not acknowledged yet`
        : "")
      + (rejected
        ? ` · ${rejected} refused: ${r.rejected.map((x) => `${x.id} — ${x.why}`).join(" · ")}`
        : "");
  });
}

async function runPlan(op) {
  await planBusy(async () => {
    /* THE SERVER'S OWN SENTENCE WINS. It knows how many items were approved,
     * how many a stop skipped, and that a start returned before the GPU did —
     * and a page that paraphrased it would be a second wording of the same
     * fact, which is how two answers to one question get shipped. */
    const r = await postPlanRun({ op });
    pl.say = r.note || (op === "start"
      ? "Started. One item at a time, and this card follows along — you can close the tab, it is "
        + "running on the server."
      : op === "pause" ? "Pausing — the render in flight finishes first."
      : op === "resume" ? "Resumed." : "Stopped.");
  });
}

/**
 * ONE LINE IN THE ALWAYS-ON COLUMN while a plan is running.
 *
 * The rail is the only part of this page that survives every stage change, and
 * a four-hour run is exactly the thing you want to see from wherever you happen
 * to be standing. Item in flight, how long it has been on it, and the finishing
 * time — batch.js's "the one number that actually matters at bedtime".
 */
function planRailLine() {
  const v = pl.view;
  if (!v || v.state !== "running") return "";
  const it = (v.items || []).find((x) => x.status === "running");
  const t = v.totals || {};
  /* ⚠ THE TOOL NAME IS NOT IN THE STATUS CHIP. `.wstatus` is uppercased by the
   * stylesheet, which is right for a state word and wrong for an identifier —
   * the first run of this line printed MV_GENERATE_ASSET, which is not the name
   * of anything. The chip carries the state; the tool keeps its own case, in
   * mono, exactly as it is spelled on the card. */
  /* ⚠ OUT OF THE ITEMS THAT WILL ACTUALLY RUN, not out of the plan. A run over
   * 2 approved items of 3 read "0/3 done" and could never reach the end of its
   * own sentence — the skipped and unapproved ones are not work this run is
   * going to do. */
  const runnable = (t.done || 0) + (t.running || 0) + (t.approved || 0);
  const elapsed = it?.startedAt
    ? (ago(it.startedAt) === "now" ? "just started" : `${ago(it.startedAt)} so far`) : "";
  return `<div class="planrail">
    <div class="wrow"><b>plan</b>
      <span class="wstatus" data-status="running">running</span></div>
    <div class="wrow"><code class="plantool">${esc(it?.tool || "starting…")}</code>
      <span class="dim">${esc(elapsed)}</span></div>
    <p class="hint">${esc(it
      ? (it.quality?.scene != null ? `scene ${it.quality.scene} · ` : `${it.id} · `) : "")}${
      t.done || 0}/${runnable} done${
      t.etaAt ? ` · finishes ~${esc(planClock(t.etaAt))}` : ""}</p>
  </div>`;
}

/* ─────────────────────── the doors from the rest of the page */

/** Open the propose form, seeded, with an item staged if one came with it. */
function openPropose(from, item) {
  if (pl.err) {
    /* The card is on its refusal branch, so there is nothing to open — but the
     * press still gets an answer, because a control that repaints the same
     * sentence looks broken. */
    pl.say = "That control needs the plan routes, and the server running right now does not have "
      + "them — the sentence above is the whole of it. Nothing was sent.";
    paintPlanCard();
    $("planCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return undefined;
  }
  const open = pl.view && LIVE_PLAN_STATES.has(pl.view.state) ? pl.view : null;
  if (open) {
    /* THE OPEN PLAN WINS, and the sentence is said before the round trip rather
     * than after it. batch.js's bug was a second Start silently discarding the
     * first object; this refuses instead, and names the plan that is in the
     * way. An item pressed on a row is not thrown away for it — it goes into
     * the open plan, which is what the person meant. */
    pl.say = `A plan is already open on this project ("${open.title}", ${open.state}). `
      + "Approve it, run it, or discard it first."
      + (item ? " The item you pressed + Plan on was added to it instead." : "");
    if (item) {
      return planBusy(() => postPlanItem({ op: "add", itemId: undefined, tool: item.tool,
                                           args: item.args, why: item.why, at: undefined }));
    }
    paintPlanCard();
    $("planCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return undefined;
  }
  if (item) pl.staged.push(item);
  pl.propose = { from: from || "" };
  paintPlanCard();
  $("planCard")?.scrollIntoView({ behavior: "smooth", block: "center" });
  $("planTitle")?.focus();
  return undefined;
}

/** What a row's "+ Plan" button means, as a real tool call. */
function planItemFor(spec) {
  const [what, a, b] = String(spec).split("|");
  if (what === "clip") {
    const seg = (wf.doc.segments || []).find((s) => s.id === a);
    const clip = (wf.doc.clips || []).find((c) => c.segmentId === a);
    const scene = (seg?.index ?? 0) + 1;
    return clip?.clipFile
      ? { tool: "mv_regen_clip", args: { slug: wf.slug, segment: a },
          why: `scene ${scene} — re-render, every earlier take kept` }
      : { tool: "mv_generate_clip", args: { slug: wf.slug, segment: a },
          why: `scene ${scene} has no take yet` };
  }
  if (what === "asset") {
    const row = (wf.doc[a] || []).find((x) => x.id === b);
    return { tool: "mv_generate_asset", args: { slug: wf.slug, kind: a, id: b, count: 4 },
             why: row?.imageFile ? `more takes for ${row.name}` : `${row?.name || b} has no sheet` };
  }
  return null;
}

/* ─────────────────────────────────────────────────────── wiring */

function wire(view) {
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  /** A number box that has been typed in, or `undefined` — see the Segment
   *  wiring below for why the difference matters. */
  const segNum = (id) => {
    const raw = String($(id)?.value ?? "").trim();
    return raw && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  };

  on("wfSong", "onchange", async (e) => {
    /* Only the Upload & analyze picker is "wfSong"; the brief's "Song under
     * the clip" is wfSongCond and saves with the brief. */
    const file = e.target.value;
    if (!file) return;
    await busy(() => api({ action: "attach_song", slug: wf.slug, file }));
  });
  on("wfAnalyze", "onclick", () => busy(() => api({ action: "analyze", slug: wf.slug })));
  /* The size's own sentence follows the choice before it is saved. */
  on("wfQuality", "onchange", (e) => {
    const z = (wf.cardFit?.sizes?.choices || []).find((x) => x.id === e.target.value);
    e.target.title = z?.line || z?.note || "";
  });
  /* The size options name the size as it renders in the chosen shape. */
  on("wfAspect", "onchange", (e) => {
    const sel = $("wfQuality");
    const sizes = wf.cardFit?.sizes?.choices || [];
    if (!sel || !sizes.length) return;
    for (const o of sel.options) {
      const z = sizes.find((x) => x.id === o.value);
      if (z) o.textContent = sizeOptionText(z, e.target.value);
    }
  });
  /* ⚠ EMPTY IS NOT ZERO. `segNum` answers `undefined` for a box nobody typed
   * in, JSON.stringify drops an undefined value, and the route only takes a
   * number it reads as finite — so an untouched dialog posts the body this
   * button has always posted. Sending 0 instead would mean "no lead-in" AND
   * "no shortest scene" AND "no instrumental gap", which is not the default,
   * it is three deliberate choices nobody made. */
  on("wfSegment", "onclick", () => busy(() => api({
    action: "segment", slug: wf.slug,
    maxClipSec: segNum("wfSegMax"), minClipSec: segNum("wfSegMin"),
    leadInSec: segNum("wfSegLead"), instrumentalGapSec: segNum("wfSegGap"),
  })));
  on("wfSaveBrief", "onclick", () => busy(() => api({
    action: "set_brief", slug: wf.slug,
    brief: {
      medium: $("wfMedium").value.trim() || null,
      tone: $("wfTone").value.trim() || null,
      narrative: $("wfNarrative").value.trim() || null,
      freeText: $("wfFree").value.trim() || null,
      directionSummary: $("wfDirection").value.trim() || null,
      aspectRatio: $("wfAspect").value,
      videoEngine: $("wfEngine").value,
      baseScale: $("wfBase").value,
      /* The server has taken videoSteps since it was added, and the MCP tool
       * documented it the same day — but no control ever shipped, so the one
       * setting that decides whether a night of rendering costs hours or all
       * night was reachable only by an agent. Empty string means "unset", which
       * must travel as null rather than 0. */
      videoSteps: $("wfSteps").value ? Number($("wfSteps").value) : null,
      /* The size (sizes.js's list; "recommended" is full size). Sent from the
       * control on screen, so the size shown is the size saved. */
      qualityMode: $("wfQuality") ? $("wfQuality").value : undefined,
      /* The song frozen under a REFERENCE render — the renderer's switch was
       * reachable by nobody until 2026-09-19, and a singer's video shipped
       * without lipsync because of it. */
      songConditioning: $("wfSongCond") ? $("wfSongCond").value : "auto",
    },
  })));

  /* ⚠ DECLARE A ROW — the control whose absence WAS the props problem.
   *
   * Every other affordance on these cards has existed for a while: describe,
   * Generate, Blender, take strip, pick a take. What did not exist was the
   * first step. A row could only come into being from an LLM writing the whole
   * bible (mv_set_bible) or from a picture you already had (import_asset), so a
   * person who noticed the car in eight scenes had nowhere to write it down —
   * and DIRECTING.md's most-repeated rule, "props are cast", was a rule with no
   * door on this page. `add_asset` is the door and this is its handle.
   *
   * Two prompts and no dialog on purpose: the name is the only field that must
   * be right (it is the binding key every board reference resolves through) and
   * the description is editable in place on the card that appears a moment
   * later. A refused duplicate name arrives through busy()'s alert with the
   * server's own sentence, which names the row that already holds it. */
  for (const btn of document.querySelectorAll("[data-addasset]")) {
    btn.onclick = () => {
      const kind = btn.dataset.addasset;
      const host = document.querySelector(`[data-declhost="${kind}"]`);
      if (!host) return;
      if (host.firstChild) { host.innerHTML = ""; return; }   // the button is the toggle
      host.innerHTML = declareForm(kind);
      const q = (sel) => host.querySelector(sel);
      q("[data-dname]").focus();
      q("[data-dcancel]").onclick = () => { host.innerHTML = ""; };
      q("[data-dsave]").onclick = async () => {
        const name = q("[data-dname]").value.trim();
        if (!name) { q("[data-dname]").focus(); return; }
        /* A blank advanced field means "not set", which must travel as null and
         * not as "" — the route stores what it is given, and an empty string in
         * sheetPrompt would beat the description at render time and draw a
         * nothing. */
        await busy(() => postAddAsset({
          kind, name,
          description: q("[data-ddesc]").value.trim(),
          prompt: q("[data-dprompt]").value.trim() || null,
          role: q("[data-drole]")?.value || null,
        }));
      };
    };
  }

  /* Three of these on the cast stage now (characters, props, backgrounds), so
   * the single `id="wfImport"` it used to carry would have been three elements
   * sharing one id and only the first would ever have worked.
   *
   * A FORM, not two browser prompts, and for the same reason Declare stopped
   * being three: a prompt() chain can ask for a path and a name and nothing
   * else, so two of import_asset's fields were unreachable — the description
   * every later prompt falls back to, and a role that no surface could send at
   * all. Cancelling is a button rather than an empty prompt. */
  for (const btn of document.querySelectorAll("[data-import]")) {
    btn.onclick = () => {
      const kind = btn.dataset.import;
      const host = document.querySelector(`[data-imphost="${CSS.escape(kind)}"]`);
      if (!host) return;
      if (host.firstChild) { host.innerHTML = ""; return; }   // the button is the toggle
      host.innerHTML = importForm(kind);
      const q = (sel) => host.querySelector(sel);
      q("[data-ipath]").focus();
      q("[data-icancel]").onclick = () => { host.innerHTML = ""; };
      q("[data-isave]").onclick = async () => {
        const path = q("[data-ipath]").value.trim();
        if (!path) { q("[data-ipath]").focus(); return; }
        /* busy() alerts whatever this throws, which is what carries
         * import_asset's refusal — a proven contact sheet, with "crop one panel
         * out of it" in the message — to the person who chose the file. */
        await busy(() => postImportAsset({
          kind, path,
          /* Empty name means "use the file's own", which is the route's own
           * fallback — so it travels as an empty string, not as a null the
           * route would have to learn a second spelling for. */
          name: q("[data-iname]").value.trim(),
          description: q("[data-idesc]").value.trim(),
          role: q("[data-irole]")?.value || null,
        }));
      };
    };
  }

  /* ⬡ BLENDER — the same row, rendered from geometry instead of from a
   * sentence. It offers a LIST, not a text box, for the same reason the board
   * editor offers reference names as checkboxes: the vocabulary is small,
   * closed, and lives in another repository, so not being able to name a thing
   * that does not exist beats an error after the render. The catalogue is
   * fetched rather than held here — one copy, on the server. */
  for (const btn of document.querySelectorAll("[data-blender]")) {
    btn.onclick = async () => {
      const [kind, id] = btn.dataset.blender.split("|");
      let cat;
      try {
        cat = await (await fetch("/api/mv/blender")).json();
      } catch { alert("Could not ask the server about Blender."); return; }
      if (!cat.installed) {
        /* Not an error — an absence. Blender is optional and this says which
         * file is missing and which setting moves it. */
        alert(`Blender is not set up:\n\n${(cat.why || []).join("\n\n")}`);
        return;
      }
      const opts = Object.entries(cat.builtins || {})
        .flatMap(([set, meshes]) => meshes.map((m) => `${set}:${m}`));
      const sel = document.createElement("select");
      sel.className = "sel2 sm";
      sel.innerHTML = '<option value="">choose a 3D source…</option>'
        + `<optgroup label="built-in gray-box shapes">`
        + opts.map((x) => `<option value="b|${esc(x)}">${esc(x)}</option>`).join("")
        + `</optgroup><option value="f|">a model file on disk (${esc((cat.assetFormats || []).join(" "))})…</option>`;
      btn.replaceWith(sel);
      sel.focus();
      sel.onchange = async () => {
        if (!sel.value) { paint(); return; }
        const [how, value] = [sel.value[0], sel.value.slice(2)];
        let body = { action: "blender_asset", slug: wf.slug, kind, id };
        if (how === "b") body.builtin = value;
        else {
          const p = (await appPrompt("Full path to the .blend/.obj/.glb/.fbx/.stl to render:"));
          if (!p) { paint(); return; }
          body.asset = p;
        }
        /* busy() alerts a throw and does not return a value, so the answer is
         * caught in a closure — and it is worth catching. A panel the reference
         * gate threw away is SAID OUT LOUD: the gate exists so that somebody
         * finds out, and a silent drop would be the same failure it was built
         * to stop, one layer further down.
         *
         * readBack rather than api(): a build that still reads `target`
         * defaults this route's row kind to "prop", so a character rendered
         * from geometry would come back "No such prop" with no clue why. */
        let r = null;
        await busy(async () => { r = await readBack(body, { kind, id }); });
        if (r?.refused?.length) {
          alert(`${r.refused.length} panel(s) were refused as references:\n`
            + r.refused.map((x) => `${x.angle}: ${x.why.join("; ")}`).join("\n"));
        }
      };
    };
  }

  /* ⬔ MESH — the panel this row already has, turned into geometry.
   *
   * The catalogue is FETCHED before the form opens, exactly as the Blender
   * control fetches its own: with no venv and no weights the honest answer is
   * the sentence naming the missing file, not a run that dies in a subprocess a
   * minute later. Unlike Blender's control this still OPENS the form on a bad
   * status, with the reason across the top — because half of "not ready" here
   * is a download the Models screen offers, and a dialog you cannot open cannot
   * tell you that. */
  for (const btn of document.querySelectorAll("[data-mesh]")) {
    btn.onclick = async () => {
      const [kind, id] = btn.dataset.mesh.split("|");
      const host = document.querySelector(`[data-meshhost="${CSS.escape(kind + "|" + id)}"]`);
      if (!host) return;
      if (host.firstChild) { host.innerHTML = ""; return; }   // the button is the toggle
      let cat = null;
      try { cat = await (await fetch("/api/mv/mesh")).json(); } catch { /* say nothing rather than guess */ }
      host.innerHTML = meshForm(kind, id, cat);
      const q = (sel) => host.querySelector(sel);
      q("[data-mcancel]").onclick = () => { host.innerHTML = ""; };
      q("[data-msave]").onclick = async () => {
        /* Empty means "not set" and must travel as null, not as "" or 0 — the
         * route passes what it is given straight into the runner, and an empty
         * string where a path belongs becomes a refusal about a file called "".
         * The same rule the declare form already follows. */
        const num = (el) => (el.value.trim() === "" ? null : Number(el.value));
        const body = {
          action: "mesh_asset", slug: wf.slug, kind, id,
          image: q("[data-mimage]").value.trim() || null,
          rig: !!q("[data-mrig]").checked,
          seed: num(q("[data-mseed]")),
          steps: num(q("[data-msteps]")),
        };
        let r = null;
        /* readBack rather than api(), for the reason every other kind-addressed
         * write on this page uses it: a build that still reads `target` would
         * default the row kind and file the mesh against the wrong row. */
        await busy(async () => { r = await readBack(body, { kind, id }); });
        /* A RIG THAT DID NOT TAKE IS SAID OUT LOUD. The mesh is kept and this
         * is not an error — but a silent drop would be the assertion's whole
         * point wasted, one layer down. */
        if (r?.rigRefused?.length) {
          alert(`The mesh was built and the rig produced no usable skin:\n`
            + r.rigRefused.map((w) => `  - ${w}`).join("\n")
            + `\n\nThe mesh is kept. Try ⬗ Rig on its own, or leave it unrigged.`);
        }
      };
    };
  }

  /* ⬗ RIG — the second verb, on a mesh that already exists.
   *
   * No form: it reads nothing but the row it is on. It is separate from the
   * checkbox in the mesh form because this is the one that can be refused ON
   * EVIDENCE — there is a mesh to measure by now, so its proportions decide. */
  for (const btn of document.querySelectorAll("[data-meshrig]")) {
    btn.onclick = async () => {
      const [kind, id] = btn.dataset.meshrig.split("|");
      let r = null;
      await busy(async () => { r = await readBack({ action: "mesh_rig", slug: wf.slug, kind, id }, { kind, id }); });
      if (r?.joints) alert(`Rigged: ${r.joints} joints, ${r.elapsedSec}s.`);
    };
  }

  // Segment mode changes, delegated — the table is rebuilt on every paint.
  for (const sel of document.querySelectorAll("[data-mode]")) {
    sel.onchange = async (e) => {
      try {
        const d = await api({ action: "update_segment", slug: wf.slug, id: e.target.dataset.mode, mode: e.target.value });
        wf.doc.segments = d.segments; wf.coverage = d.coverage; paint();
      } catch (err) { alert(err.message); await loadProject(); }
    };
  }

  /* RETIMING A SCENE. The pair travels together on either box's change, because
   * resnapSegment reasons about the WINDOW — it swaps a reversed pair and
   * clamps the span to the ceiling, and it cannot do either of those from one
   * number. `id` is the durable handle; `index` is an alias the route also
   * accepts and neither surface should use, because an index moves the moment
   * anybody re-cuts. */
  for (const box of document.querySelectorAll("[data-segstart],[data-segend]")) {
    box.onchange = async (e) => {
      const id = e.target.dataset.segstart || e.target.dataset.segend;
      const sel = (attr) => document.querySelector(`[${attr}="${CSS.escape(id)}"]`);
      const startSec = Number(sel("data-segstart")?.value);
      const endSec = Number(sel("data-segend")?.value);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        alert("Both ends have to be numbers — clear one and the scene has no window to snap.");
        await loadProject();
        return;
      }
      try {
        const d = await api({ action: "update_segment", slug: wf.slug, id, startSec, endSec });
        /* ⚠ READ WHAT CAME BACK BEFORE TRUSTING IT. `fmt` prints "—" for a
         * non-finite number, so a route that hands back a segment with null
         * boundaries repaints as a dash and looks like a rendering quirk. It is
         * not: it means the re-snap produced NaN, and the scene on disk is now
         * a scene with no time. Say that out loud instead. */
        const back = (d.segments || []).find((s) => s.id === id);
        if (back && !(Number.isFinite(back.startSec) && Number.isFinite(back.endSec))) {
          alert(`The server accepted the retime and handed back a scene with no boundaries `
            + `(start ${back.startSec}, end ${back.endSec}).\n\nThat is a fault behind this `
            + `page, not in what you typed: the re-snap ran without the song's length and `
            + `produced NaN. Re-cut the song to rebuild the scenes, and do not retime again `
            + `until the fix has landed. ${RESTART_REQUIRED}`);
        }
        wf.doc.segments = d.segments; wf.coverage = d.coverage; paint();
      } catch (err) { alert(explain(err)); await loadProject(); }
    };
  }

  /* THE BIBLE, BY HAND. This card used to render the bible read-only and print
   * a paragraph telling you to go ask an agent to write it — for the document
   * this fork's own copy calls "what steers the clips". set_bible has always
   * accepted a PARTIAL bible (commitBible applies each section only `if`
   * present), so saving the story does not disturb the cast, the backgrounds
   * or a single board. */
  on("wfSaveStory", "onclick", () => busy(() => api({
    action: "set_bible", slug: wf.slug,
    bible: {
      story: { logline: $("wfLogline").value.trim(), synopsis: $("wfSynopsis").value.trim() },
      styleBible: $("wfStyle").value.trim(),
    },
  })));

  for (const btn of document.querySelectorAll("[data-editboard]")) {
    btn.onclick = () => openBoardEditor(btn.dataset.editboard);
  }

  /* ONE SHOT, OPENED ON ITS OWN. The Generate button beside this one has always
   * been the whole of a human's control over a clip: press it and hope. This is
   * the other half — the exact prompt, the sheets that actually resolved, the
   * takes with the evidence for each one, and a re-render of this scene alone. */
  for (const btn of document.querySelectorAll("[data-shot]")) {
    btn.onclick = () => openShotInspector(btn.dataset.shot);
  }
  /* The clips table's Render opens the SAME panel, scrolled to the same
   * control. Not a second render path that happens to agree — the one path,
   * reached from the row you were already looking at. */
  for (const btn of document.querySelectorAll("[data-shotrender]")) {
    btn.onclick = () => openShotInspector(btn.dataset.shotrender, { focus: "render" });
  }

  /* B-ROLL FOOTAGE. import_clip has existed since the polish loop was built —
   * its own comment says b-roll segments "had no way to receive footage at
   * all" — and it had an MCP tool and no human control whatsoever. It takes a
   * library NAME, never a path (the timeline already plays from that library),
   * so this offers the library rather than prompting for a path the way
   * import_asset does for pictures. */
  for (const btn of document.querySelectorAll("[data-broll]")) {
    btn.onclick = async () => {
      let names = [];
      try {
        const r = await (await fetch("/api/clips")).json();
        /* The bin holds imported stills and songs too; a scene's take must be a
         * video, and import_clip refuses anything else — so the same rule is
         * applied here rather than offering a choice the server will reject. */
        names = (r.clips || []).map((c) => c.name).filter((x) => /\.(mp4|webm|mov|mkv|m4v)$/i.test(x));
      } catch { /* fall through to the empty message */ }
      if (!names.length) {
        alert("No video in the clips library yet. Render one on the Video tab, export from Studio, or drop a file into the clip bin.");
        return;
      }
      const sel = document.createElement("select");
      sel.className = "sel2 sm";
      sel.innerHTML = '<option value="">choose a clip…</option>'
        + names.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
      btn.replaceWith(sel);
      sel.focus();
      sel.onchange = async () => {
        if (!sel.value) { paint(); return; }
        try {
          await busy(() => api({ action: "import_clip", slug: wf.slug,
                                 segmentId: btn.dataset.broll, clip: sel.value }));
        } catch (err) { alert(err.message); await loadProject(); }
      };
    };
  }

  /* Takes: generate strips, pick by click. The strip renders 4 seeds per press
   * for nearly the price of one (one text encode serves the batch). */
  for (const btn of document.querySelectorAll("[data-genasset]")) {
    btn.onclick = () => {
      const [kind, id] = btn.dataset.genasset.split("|");
      /* No `refs` here on purpose, and the section note says why: generateAsset
       * reads it only for a board. Sending it from a sheet render would put a
       * key in the body that the code path never reaches — a promise nothing
       * keeps, which is the failure the parameter census is for.
       *
       * The seed box IS read here, and an empty one is read as empty: the
       * helper drops the key rather than sending a zero, so pressing this
       * button with nothing typed does exactly what it did yesterday. */
      const box = document.querySelector(`[data-genseed="${CSS.escape(btn.dataset.genasset)}"]`);
      busy(() => postGenerateAsset({ kind, id, count: 4, seed: box?.value }));
    };
  }
  /* A seed a take was already drawn on, pressed into the box beside it. It does
   * NOT render — the person still chooses when to spend, and the button they
   * press for that is the one above. */
  for (const chip of document.querySelectorAll("[data-seedhold]")) {
    chip.onclick = () => {
      const [kind, id, seed] = chip.dataset.seedhold.split("|");
      const box = document.querySelector(`[data-genseed="${CSS.escape(`${kind}|${id}`)}"]`);
      if (!box) return;
      box.value = seed;
      box.focus();
    };
  }
  for (const img of document.querySelectorAll("[data-pick]")) {
    img.onclick = () => {
      const [kind, id, file] = img.dataset.pick.split("|");
      busy(() => readBack({ action: "pick_take", slug: wf.slug, kind, id, file }, { kind, id }));
    };
  }
  /* ✦ DRAW A BOARD — and the one place `refs` decides anything.
   *
   * Ticked = SINGLE PANEL = no sheets attached, which DIRECTING.md §2 asks for
   * and which is measurably the setting that produces a usable board today.
   * Unticked is the server's own default (generateAsset: `refs = true`), kept as
   * the default here so the control reports what the machine does rather than
   * what this page would prefer. */
  for (const btn of document.querySelectorAll("[data-genboard]")) {
    btn.onclick = () => {
      const id = btn.dataset.genboard;
      busy(() => postGenerateAsset({ kind: "board", id, count: 2, refs: !singlePanel.has(id) }));
    };
  }
  /* Re-label the button the moment the switch moves: a control that only tells
   * you what it will do after it has done it is a receipt, not a control. */
  for (const cb of document.querySelectorAll("[data-singlepanel]")) {
    cb.onchange = () => {
      const id = cb.dataset.singlepanel;
      if (cb.checked) singlePanel.add(id); else singlePanel.delete(id);
      const btn = document.querySelector(`[data-genboard="${CSS.escape(id)}"]`);
      if (btn) btn.title = cb.checked ? SINGLE_TITLE : SHEETS_TITLE;
    };
  }
  for (const btn of document.querySelectorAll("[data-friendclip]")) {
    btn.onclick = () => document.dispatchEvent(new CustomEvent("aiplay:collab-scene", { detail: { slug: wf.slug, segmentId: btn.dataset.friendclip } }));
  }
  for (const btn of document.querySelectorAll("[data-genclip]")) {
    btn.onclick = () => {
      btn.textContent = "rendering…"; btn.disabled = true;
      busy(() => api({ action: "generate_clip", slug: wf.slug, segmentId: btn.dataset.genclip }));
    };
  }
  on("wfToStudio", "onclick", async () => {
    try {
      const d = await api({ action: "build_timeline", slug: wf.slug });
      alert(`Saved "${d.project}" with ${d.scenes} scenes. Open the Studio tab and load it — right-click any scene there to regenerate or cycle takes.`);
      await loadProject();
    } catch (e) { alert(e.message); }
  });

  on("wfRenderVideo", "onclick", async () => {
    const btn = $("wfRenderVideo"); const note = $("wfRenderNote");
    const fade = $("wfRenderFade")?.checked ? 0.25 : 0;
    const beatZoom = Number($("wfRenderZoom")?.value) || 0;
    btn.disabled = true; btn.textContent = "rendering…";
    try {
      const r = await api({ action: "render_video", slug: wf.slug, fade, beatZoom });
      /* Says what it MADE, not that it succeeded — the length and frame rate are
       * the two things that were wrong about every earlier export. */
      note.innerHTML = `Rendered <b>${esc(r.name)}</b> — ${r.clips} scenes, `
        + `${r.total}s at ${r.fps} fps, ${r.w}×${r.h}, `
        + `${(r.bytes / 1e6).toFixed(0)} MB. It is in your clip library.`
        /* ⚠ THE ROUTE'S OWN SENTENCE FOR A PULSE IT DROPPED, printed rather
         * than swallowed. Asking for the effect and getting a file without it,
         * with no line anywhere saying why, is exactly how a knob nobody can
         * explain gets called broken. The control disables itself below the
         * bar, so this should be unreachable — which is why it is worth
         * printing if it ever is reached. */
        + (r.beatZoomSkipped ? ` <b>No pulse:</b> ${esc(r.beatZoomSkipped)}.` : "")
        + (beatZoom && !r.beatZoomSkipped ? ` Pulsed ${Math.round(beatZoom * 100)}% on the beat.` : "");
    } catch (e) {
      note.textContent = explain(e);
    } finally {
      btn.disabled = false; btn.textContent = "Render the finished video";
    }
  });

  /* ⚠ THE PLAN'S OWN CONTROLS ARE WIRED SEPARATELY, because the card repaints
   * on its own clock — every decision and every poll tick replaces that node
   * and only that node, so its handlers cannot live in this function's single
   * pass. wirePlan() is called from paintPlanCard() too, and this is the call
   * that catches the first paint. */
  { const host = $("planCard"); if (host) wirePlan(); }
  planPolling();
  for (const btn of document.querySelectorAll("[data-planfrom]")) {
    btn.onclick = () => openPropose(btn.dataset.planfrom, null);
  }
  /* "+ Plan" on a scene row or a cast card. With no plan open it stages the
   * item and opens the propose form; with one open it adds to it, because that
   * is what the person meant and a refusal here would just make them press
   * twice. */
  for (const btn of document.querySelectorAll("[data-planadd]")) {
    btn.onclick = () => {
      const item = planItemFor(btn.dataset.planadd);
      if (item) openPropose("", item);
    };
  }

  { const host = $("wfMap"); if (host) loadCrimeBoard(host); }
  {
    const host = $("wfLint");
    if (host) {
      api({ action: "lint", slug: wf.slug }).then((r) => {
        host.innerHTML = r.issues.length
          ? `<ul class="lintlist">${r.issues.map((i, idx) => `<li class="lint-${i.level}">
              ${i.level === "error" ? "✖" : "⚠"} <b>${esc(i.where)}</b> ${esc(i.msg)}${i.fix
                ? ` <button class="edtool sm" type="button" data-lintfix="${idx}">${esc(i.fix.label)}</button>` : ""}</li>`).join("")}</ul>`
          : `<p class="hint">✓ Nothing wrong — sheets, boards and references all line up.</p>`;
        /* A FIX IS ONE CLICK: the server wrote it (bible.js lintProject) as an
         * existing route action, set_shot (tick the name, keeping the board's
         * other references) or set_brief. The page adds no judgement of its own. */
        for (const btn of host.querySelectorAll("[data-lintfix]")) {
          btn.onclick = async () => {
            const i = r.issues[Number(btn.dataset.lintfix)];
            if (!i?.fix) return;
            btn.disabled = true;
            try {
              await api({ action: i.fix.action, slug: wf.slug, segmentId: i.fix.segmentId, refs: i.fix.refs, brief: i.fix.brief });
              await loadProject();
            } catch (e) {
              btn.disabled = false;
              btn.title = explain(e);
            }
          };
        }
      }).catch(() => { host.innerHTML = ""; });
    }
  }

  /* ---- audiobook controls ---- */
  on("abIngest", "onclick", async () => {
    const p = (await appPrompt("Full path to the .epub or .pdf:", ""));
    if (!p) return;
    busy(() => api({ action: "ab_ingest", slug: wf.slug, path: p }));
  });
  on("abPlan", "onclick", () => busy(() => api({
    action: "ab_plan", slug: wf.slug,
    settings: { targetMinMinutes: +($("abMin")?.value || 5), targetMaxMinutes: +($("abMax")?.value || 15) },
  })));
  on("abModel", "onchange", () => {
    const sel = $("abPersona");
    if (sel) sel.innerHTML = (VOICES[$("abModel").value] || []).map((p) => `<option>${p}</option>`).join("");
  });
  on("abSetVoice", "onclick", () => busy(() => api({
    action: "ab_set_voice", slug: wf.slug, model: $("abModel").value, persona: $("abPersona").value,
  })));
  for (const btn of document.querySelectorAll("[data-abbed]")) {
    btn.onclick = () => { btn.disabled = true; busy(() => api({ action: "ab_bed", slug: wf.slug, mood: btn.dataset.abbed })); };
  }
  for (const sel of document.querySelectorAll("[data-abusebed]")) {
    sel.onchange = () => busy(() => api({ action: "ab_use_bed", slug: wf.slug, bundle: +sel.dataset.abusebed, bedId: sel.value || null }));
  }
  for (const btn of document.querySelectorAll("[data-abnarrate]")) {
    btn.onclick = () => { btn.textContent = "narrating…"; btn.disabled = true;
      busy(() => api({ action: "ab_narrate", slug: wf.slug, bundle: +btn.dataset.abnarrate })); };
  }
  for (const btn of document.querySelectorAll("[data-abmix]")) {
    btn.onclick = () => { btn.textContent = "mixing…"; btn.disabled = true;
      busy(() => api({ action: "ab_mix", slug: wf.slug, bundle: +btn.dataset.abmix })); };
  }
  for (const btn of document.querySelectorAll("[data-abskip]")) {
    btn.onclick = () => busy(() => api({ action: "ab_toggle_chapter", slug: wf.slug, idx: +btn.dataset.abskip }));
  }

  // chapter filter — pure DOM, no repaint, fast enough for 730 rows
  on("chFilter", "oninput", () => {
    const q = $("chFilter").value.trim().toLowerCase();
    for (const tr of document.querySelectorAll("#chRows tr")) {
      tr.hidden = !!q && !tr.dataset.chtitle.includes(q);
    }
  });

  // inline description edits save on blur, only if changed (the website's rule)
  for (const ta of document.querySelectorAll("[data-desc]")) {
    const orig = ta.value;
    ta.onblur = () => {
      if (ta.value === orig) return;
      const [kind, id] = ta.dataset.desc.split("|");
      /* NO CASCADE. A description is read by nothing but the generator — it is
       * not a key anything resolves through — so repointing has nothing to
       * repoint, and asking the server to walk every board for a wording change
       * would make the cheap edit the expensive one. */
      busy(() => postUpdateAsset({ kind, id, description: ta.value, cascade: false }));
    };
  }

  /* ⚠ A RENAME IS NOT AN EDIT OF ONE FIELD, and treating it as one is how a
   * project quietly loses a prop.
   *
   * The name is the key every board reference, every refProminence entry, every
   * take's recorded refs and every continuity sentence resolves through. Rename
   * the row alone and each of those still names a thing that no longer exists:
   * the row goes on looking rendered and referenced while the render receives
   * nothing for it — the silent drop, arrived at by housekeeping.
   *
   * So the confirm LISTS the scenes before it writes, from the same boards the
   * cards already read, and the write carries cascade:true. The answer is then
   * checked, because a server that has not learned `cascade` yet renames the row
   * and repoints nothing while answering 200. */
  for (const inp of document.querySelectorAll("[data-mvrename]")) {
    const was = inp.value;
    inp.onblur = async () => {
      const name = inp.value.trim();
      if (!name || name === was) { inp.value = was; return; }
      const [kind, id] = inp.dataset.mvrename.split("|");
      const scenes = refScenes(kind, was);
      const where = scenes.length
        ? `${scenes.length} board${scenes.length === 1 ? "" : "s"} reference it — `
          + `scene${scenes.length === 1 ? "" : "s"} ${scenes.join(", ")}.`
        : "No board references it yet, so there is nothing to repoint.";
      if (!(await appConfirm(`Rename "${was}" to "${name}"?\n\n${where}\n\n`
        + "Every board reference, prominence entry and continuity line that names it is "
        + "repointed in the same write. Clips already on disk keep the old name in their "
        + "evidence — that is the record of what they were actually handed, and it stays true."))) {
        inp.value = was; return;
      }
      let r = null;
      await busy(async () => { r = await postUpdateAsset({ kind, id, name, cascade: true }); });
      /* THE ANSWER IS READ BACK. The response carries the whole project, so
       * "did the cascade happen" is a fact rather than a hope — and the one
       * failure mode that answers 200 is exactly the one worth catching. */
      const stragglers = r?.project ? refScenesIn(r.project, kind, was) : [];
      if (stragglers.length) {
        alert(`The row was renamed, but ${stragglers.length} board reference`
          + `${stragglers.length === 1 ? " on scene" : "s on scenes"} ${stragglers.join(", ")} `
          + `still say "${was}" — the cascade did not run.\n\n${RESTART_REQUIRED}\n\n`
          + "Until then those scenes reference a name nothing declares, and the map will "
          + "draw them as breaks. That is accurate: it is what they are.");
      }
    };
  }

  /* ---- dialogue casting ---- */
  const readCastRows = () => [...document.querySelectorAll("[data-castrow]")].map((row) => {
    const i = row.dataset.castrow;
    const [model, persona] = (row.querySelector(`[data-castvoice="${i}"]`).value || "|").split("|");
    return {
      name: row.querySelector(`[data-castname="${i}"]`).value.trim(),
      aliases: row.querySelector(`[data-castalias="${i}"]`).value.split(",").map((s) => s.trim()).filter(Boolean),
      voice: persona ? { model, persona } : null,
    };
  }).filter((c) => c.name);
  on("abCastAdd", "onclick", () => {
    // stage the row locally so several characters can be added before one save
    wf.doc.cast = [...readCastRows(), { name: "", aliases: [], voice: null }];
    paint();
  });
  on("abCastSave", "onclick", () => busy(() => api({ action: "ab_set_cast", slug: wf.slug, cast: readCastRows() })));
  for (const btn of document.querySelectorAll("[data-castdel]")) {
    btn.onclick = () => {
      const keep = readCastRows().filter((_, i) => i !== +btn.dataset.castdel);
      busy(() => api({ action: "ab_set_cast", slug: wf.slug, cast: keep }));
    };
  }

  /* ---- sound effects ---- */
  for (const btn of document.querySelectorAll("[data-absfxscan]")) {
    btn.onclick = () => { btn.disabled = true; btn.textContent = "scanning…";
      busy(() => api({ action: "ab_sfx", mode: "scan", slug: wf.slug, bundle: +btn.dataset.absfxscan })); };
  }
  on("abAudition", "onclick", async () => {
    const btn = $("abAudition"); btn.disabled = true; btn.textContent = "auditioning…";
    /* Nothing ticked and nothing typed both mean "the server's default", and
     * both travel as null rather than as an empty array or an empty string: an
     * empty personas list would audition nobody, and the route's own reader
     * treats a falsy value as absent. */
    const picked = [...document.querySelectorAll("[data-audvoice]")]
      .filter((cb) => cb.checked)
      .map((cb) => { const [model, persona] = cb.dataset.audvoice.split("|"); return { model, persona }; });
    const line = String($("abAudText")?.value ?? "").trim();
    try {
      wf.audition = await api({ action: "ab_audition", slug: wf.slug,
                                personas: picked.length ? picked : null, text: line || null });
      paint();
    } catch (e) { alert(explain(e)); btn.disabled = false; btn.textContent = "🎧 Audition voices"; }
  });
  for (const btn of document.querySelectorAll("[data-audpick]")) {
    btn.onclick = () => {
      const [model, persona] = btn.dataset.audpick.split("|");
      busy(() => api({ action: "ab_set_voice", slug: wf.slug, model, persona }));
    };
  }
  for (const btn of document.querySelectorAll("[data-absfxjudge]")) {
    btn.onclick = () => { btn.disabled = true; btn.textContent = "judging…";
      busy(() => api({ action: "ab_sfx", mode: "judge", slug: wf.slug, bundle: +btn.dataset.absfxjudge })); };
  }
  for (const btn of document.querySelectorAll("[data-absfxrender]")) {
    btn.onclick = () => { btn.disabled = true; btn.textContent = "rendering…";
      busy(() => api({ action: "ab_sfx", mode: "render", slug: wf.slug, bundle: +btn.dataset.absfxrender })); };
  }
}

async function busy(fn) {
  const body = $("wfBody");
  body.classList.add("wfbusy");
  try { await fn(); await loadList(); await loadProject(); }
  catch (e) { alert(explain(e)); }
  finally { body.classList.remove("wfbusy"); }
}

/** Called once at boot. Everything above is re-wired on each paint. */
export function initWorkflow(library) {
  wf.library = library || [];

  $("wfProject").onchange = async () => { wf.slug = $("wfProject").value; wf.view = null; await loadProject(); };
  $("wfReload").onclick = () => wfOpen();
  $("wfHome").onclick = () => { wf.slug = null; wf.doc = null; wf.view = null; paint(); };
  const newProject = (kind) => async () => {
    const title = (await appPrompt(kind === "audiobook" ? "Name this audiobook:" : "Name this video project:", ""));
    if (!title) return;
    try {
      const d = await api({ action: "create", title, kind });
      wf.slug = d.slug; wf.view = null;
      await wfOpen();
    } catch (e) { alert(e.message); }
  };
  $("wfNew").onclick = newProject("mv");
  $("wfNewAb").onclick = newProject("audiobook");
  $("wfDelete").onclick = async () => {
    if (!wf.slug) return;
    if (!(await appConfirm(`Delete the project "${wf.doc?.title || wf.slug}"? The songs and clips it used are not touched.`))) return;
    try {
      await api({ action: "delete", slug: wf.slug });
      wf.slug = null; wf.doc = null;
      await wfOpen();
    } catch (e) { alert(e.message); }
  };
  /* Every stage is NAVIGABLE, dimmed or not. The dimming says "you are not
   * here yet"; it must not say "you may not look" — characters can be imported
   * and takes rendered before any bible exists, and a wall here forces the
   * manual path through stages it does not need. Actions guard themselves. */
  /* Activity rows that point at a workflow stage. Delegated on the document
   * because the rail is re-rendered on every paint, so a handler bound to the
   * card itself would be thrown away with it. */
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-feedstage]");
    if (!a) return;
    e.preventDefault();
    wf.view = a.dataset.feedstage;
    paint();
  });
  /* Collab asks for a project by slug — a friend's order becomes "Order o_… from
   * <name>", and its plan is the Plan card at the top of that project. This
   * only chooses the project; the app's view change calls wfOpen(), which
   * loads it, and nothing here approves or runs anything. */
  document.addEventListener("aiplay:open-project", (e) => {
    const slug = e.detail?.slug;
    if (typeof slug !== "string" || !slug) return;
    wf.slug = slug;
    wf.view = null;
  });

  $("wfRail").addEventListener("click", (e) => {
    const li = e.target.closest("[data-stage]");
    if (!li) return;
    wf.view = li.dataset.stage === wf.view ? null : li.dataset.stage;
    paint();
  });
}

/** The library arrives after boot, so the song picker is refreshed rather than built once. */
export function wfSetLibrary(library) {
  wf.library = library || [];
  if (!$("workflow").hidden) paint();
}
