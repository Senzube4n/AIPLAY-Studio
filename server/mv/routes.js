/**
 * Video Workflow — HTTP routes.
 *
 * One action-dispatched POST (`/api/mv`) plus a few GETs, which is the shape
 * `/api/video` and `/api/lyrics` already use — so this is one insert into the
 * route table rather than twenty.
 *
 * EVERY capability here is reachable from MCP too (see server/mcp-mv.js), and
 * both surfaces call THESE functions. That is the rule that stops the agent
 * path and the GUI path drifting apart, which is the failure this whole app has
 * been bitten by before: a feature that works from one surface and silently does
 * nothing from the other.
 *
 * Dependencies are injected rather than imported so this file stays additive —
 * index.js owns the paths and the runners, and a rebase onto upstream touches
 * one line there instead of a tangle here.
 */
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import {
  listProjects, createProject, readProject, updateProject, deleteProject,
  stageAsset, assetsDir, stageOfDoc, noteRun, slugify,
  assetReferences, cascadeRename, projectDir,
} from "./store.js";
import { lrcToLines } from "./lyricLines.js";
import { segmentSong, resnapSegment, computeCoverage } from "./segmentation.js";
/* Studio's own pass over the port's cut: a line longer than the longest scene
 * is split rather than losing its tail, and a breath between two scenes is
 * closed, so no sung second is left without a picture (cutfill.js). */
import { closeCutHoles } from "./cutfill.js";
import { generateAsset, generateClip, pickTake, buildTimeline, crimeBoard } from "./generate.js";
import { readTimeline } from "./timeline_read.js";
import { regenStale } from "./regen.js";
import { ingestBook, planBundles, narrateBundle, makeBed, mixBundle, abBoard, setCast, auditionVoices } from "./audiobook.js";
import { scanCues, setCues, renderCues, clearCues, judgeCues } from "./sfxcue.js";
import { bibleSpec, commitBible, upsertBoard, lintProject } from "./bible.js";
import {
  blenderAsset, blenderStatus, referenceSafe, BUILTINS, ANGLES, DEFAULT_ANGLES, toolkitSets,
} from "./blender.js";
import { previzCatalogue, previzShot } from "./previz.js";
/* THE THIRD SOURCE OF GEOMETRY, and the one that is neither a picture nor a
 * camera. blender.js renders an object somebody already modelled; this MAKES
 * one out of the panel a row already carries. It lives outside server/mv/
 * because it is not an MV capability wearing a hat — it spawns its own python
 * and writes its own ledger rows. See the header of server/mesh/runner.js for
 * why a second door exists at all. */
import { meshAsset, rigAsset, meshCatalogue } from "../mesh/asset.js";
/* THE OTHER HALF OF THE SAME QUESTION. previz.js blocks a camera move for a
 * HUMAN to watch and says loudly that the clip must never reach a model;
 * control.js hands a REAL clip to WAN 2.1 VACE's control_video, which is a
 * different node and a measured positive. Both are here so a reader meets them
 * together rather than discovering the second one months later. */
import { controlCatalogue, controlRender } from "./control.js";
import { shotPlan } from "./moves.js";
import { shotRecord, applyShotEdit, findSegment, setLtxReady, ltxReadyNow } from "./shot.js";
/* THE MUSIC VIDEO FOLLOWS THE CARD: the size list and the default longest
 * scene (sizes.js), the matched step count (clipsteps.js), and the card
 * reading they are judged against (gpu.js, the reading the status bar takes). */
import {
  sizeChoices, sceneCutFor, aspectNote, sizeOfBrief, MV_SIZE_IDS, MV_ASPECTS, MV_CLIP_CEILING_SEC,
} from "./sizes.js";
/* What LTX really renders a size at (it floors each side to a multiple of 64),
 * the function the graph itself asks, so the brief can say it. */
import { videoSizeFor } from "../workflow.js";
import { stepChoices, clipStepsFor, clipStepsNote } from "./clipsteps.js";
import { gpuStatus, ramStatus } from "../gpu.js";
/* THE PLAN OBJECT — set up · go through · approve or change · start.
 *
 * plan.js is pure and knows nothing about a request or a disk; planrun.js owns
 * the walk and the one-GPU rule. This file is the door between them: it reads
 * the actor off the request, persists through the same updateProject every
 * other write here uses, and writes the decisions to the project's own ledger.
 *
 * `config` arrives by import rather than through deps because the runner needs
 * ONE number — this server's own HTTP port, so a plan item goes back through
 * the same route a direct tool call goes through. Passing it in would have
 * meant a third line in index.js for a value store.js already imports the same
 * module to get. */
import { config } from "../config.js";
import {
  makePlan, addPlan, findPlan, planIndex, planView, applyItemOp, decideItems,
  setPolicy, autoApprovable, discardPlan, healPlan, seedItems, RUN_OPS,
  estimateOne, spendMeter, budgetRefusal, SPEND_FIELD,
} from "./plan.js";
import { SPENDING_ACTIONS, CONTROL_VIA, CONTROL_TOOLS, controlMeasuredFrom } from "./plancost.js";
/* ⚠ THE READER, NEVER THE WIRE. `engine.activity()` joins the delegate and
 * generate events on each `engine/<runId>` asset and hands back rows — it is
 * the same read `/api/engine` {action:"activity"} does, and it names no port,
 * builds no URL and posts nothing. Everything this route SPENDS goes through
 * server/mv/control.js's dispatch, which is the one door. */
import { engine } from "../engine/client.js";
import {
  createPlanRunner, toolTable, loopbackApi, plannableFrom, isRunning, runState, anyRunning,
  PLAN_ACTOR,
} from "./planrun.js";

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm",
};

/** Names come from a model or a URL, so nothing is trusted as a path. */
const safe = (v) => {
  const s = path.basename(String(v ?? ""));
  return s && !s.includes("..") ? s : null;
};

/**
 * WHICH CAST LIST, in the document's own words.
 *
 * `kind` is the shared name across the three asset actions and it resolves to
 * the array on the project — `characters`, `backgrounds`, `props` — because
 * that is the thing every lookup, every board reference and every cascade
 * actually walks. Singular is accepted because the older spelling of this
 * argument was `target` and its vocabulary was singular; both land on the same
 * array, so no caller has to know which era it is from.
 */
const KIND = {
  character: "characters", characters: "characters",
  background: "backgrounds", backgrounds: "backgrounds",
  prop: "props", props: "props",
  board: "boards", boards: "boards",
  /* pick_take switches between the takes on a CLIP as well as on a sheet — one
   * loop, one vocabulary. `only` keeps clips out of the three cast actions. */
  clip: "clips", clips: "clips",
};
const ONE = { characters: "character", backgrounds: "background", props: "prop",
              boards: "board", clips: "clip" };
/** The four the cast actions accept; boards and clips are not cast. */
const CAST_KINDS = ["characters", "backgrounds", "props"];
/** The plural array name, or null. `only` narrows it (boards are not cast). */
const assetKind = (v, only = null) => {
  const k = KIND[String(v ?? "").trim().toLowerCase()] || null;
  return k && (!only || only.includes(k)) ? k : null;
};
/**
 * `kind`, or the default when it is ABSENT — but a spelling nobody recognises
 * is an error rather than a silent fallback.
 *
 * ⚠ THE DIFFERENCE MATTERS AND IT USED TO BE LOST. `assetKind(b.kind) || "characters"`
 * reads a missing kind and a mistyped one the same way, so `kind: "charcter"`
 * did not refuse — it declared, drew or re-picked a CHARACTER, which is the
 * silent-wrong-row failure the cast vocabulary exists to prevent. add_asset and
 * update_asset have refused it all along; this is that refusal, once, for every
 * action that speaks the word.
 */
const needKind = (v, dflt, only = null) => {
  if (v === undefined || v === null || v === "") return dflt;
  const k = assetKind(v, only);
  if (k) return k;
  const legal = [...new Set(only || Object.values(KIND))].join(" | ");
  throw new Error(`kind must be ${legal} — not "${v}".`);
};
/** The actions that speak `kind`; see the alias note at the dispatch.
 *
 * ⚠ IT IS NOW ALL OF THEM. `import_asset`, `blender_asset` and `pick_take` read
 * `b.target` and nothing else, which is why the page still had to carry a
 * transition shim of its own — one spelling on five routes and a different one
 * on three is two vocabularies, not one. They read `kind` below; this line is
 * what keeps a page that has not been redeployed yet working, and it goes when
 * no caller in this tree posts `target` any more. */
const ASSET_ACTIONS = new Set(["add_asset", "update_asset", "generate_asset",
                               "import_asset", "blender_asset", "pick_take",
                               /* The two mesh verbs speak the same vocabulary and are
                                * addressed the same way, so they take the same shim. */
                               "mesh_asset", "mesh_rig"]);

/**
 * `role` is lead, support, or nothing at all.
 *
 * It was written straight through from the body, so any string an agent sent
 * became the row's role — and nothing downstream reads a role it does not
 * recognise, so a typo produced a character that silently had no role rather
 * than an error anybody could see. Empty and null are the real third value
 * (most rows have no role) and clear it.
 */
const readRole = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "lead" || s === "support") return s;
  throw new Error(`role must be "lead", "support", or null — not "${v}".`);
};

/**
 * WHICH OF THE THREE PROMPTS THIS RENDER USES, asked for out loud.
 *
 * There have always been three — the builder's, the one stored on the scene by
 * hand, and one supplied for this render alone — and which won was inferred
 * from whether `prompt` happened to be in the body. That inference is what
 * split one capability across two buttons: the inspector posted the text of its
 * box whether or not it had been saved, so every render from it recorded
 * `promptSource:"argument"` even a second after Save prompt; the clips table
 * posted no prompt at all and so could never try a wording. Naming the choice
 * lets both surfaces post the same body and get what they asked for.
 *
 *   "argument" — render this text, store nothing. A trial.
 *   "edited"   — the scene's stored prompt (the builder's if there is none).
 *   "built"    — the builder's, ignoring a stored override FOR THIS RENDER.
 *
 * ⚠ ONE HONEST RESIDUE. With an override stored, "built" is delivered by
 * handing the computed text down as an argument, so the take's evidence records
 * promptSource "argument" — which is true: for this render it was one. shot.js
 * owns that vocabulary and this route does not get to invent a fourth word in
 * it. The response says what was ASKED for, so the two are readable together.
 */
/**
 * The shot record with the render facts generate.js will send beside it: the
 * step count (clipsteps.js, the one number generate.js sends and plan.js
 * prices) and, when a scene with cast pictures raises the brief's count to the
 * reference file's own, the sentence saying so. `songUnder` / `songLine`
 * come from resolveShot itself. One wrapper, so every door that returns a
 * shot says the same number.
 */
function withRenderFacts(doc, rec) {
  const refs = !!rec?.useRefs;
  return { ...rec, steps: clipStepsFor(doc.brief, { refs }), stepsNote: clipStepsNote(doc.brief, { refs }) };
}

function renderPrompt(doc, segmentId, promptSource, prompt) {
  const src = promptSource === undefined || promptSource === null ? null : String(promptSource);
  /* No promptSource is exactly today's behaviour, bit for bit: a string renders
   * as an argument, anything else leaves the stored prompt to win. */
  if (src === null) return typeof prompt === "string" ? prompt : undefined;
  if (src === "argument") {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error('promptSource "argument" means "render the text I am sending" — send a prompt, '
        + 'or ask for "edited" to use the one stored on the scene.');
    }
    return prompt;
  }
  if (src === "edited") return undefined;
  if (src === "built") {
    const rec = shotRecord(doc, segmentId);
    /* With nothing stored, the builder's prompt is what an empty body already
     * renders — so send nothing and let the take record "computed" honestly. */
    return rec.promptOverride ? rec.computedPrompt : undefined;
  }
  throw new Error('promptSource must be "built", "edited" or "argument".');
}

export function createMvRoutes(deps) {
  const { json, readBody, library, art, beatsFor, LRC_DIR } = deps;

  /* WHAT THIS CARD AND THIS DISK GIVE A PROJECT. `cardReading` is injectable so
   * a test can be any card; the server's is the reading the status bar takes.
   * `ltxReady` (index.js passes videoReady("ltx")) decides where "hybrid"
   * sends a scene with no cast: LTX only when LTX is on this PC (shot.js).
   * Cached for five seconds, because a plan prices every scene through it. */
  /* index.js passes the reading the Video screen takes (cpuOnly: no card, the
   * engine on the CPU; vaeMeasured: the decoder the H3 lab measured with).
   * The fallback reads the same settings.json field index.js cpuOnlyEngine does. */
  const cardReading = typeof deps.cardReading === "function"
    ? deps.cardReading : () => ({ gpu: gpuStatus(), ram: ramStatus(), cpuOnly: config.torchBackend === "cpu" });
  if (typeof deps.ltxReady === "function") {
    let at = 0, last = true;
    setLtxReady(() => {
      if (Date.now() - at > 5000) { at = Date.now(); last = deps.ltxReady() !== false; }
      return last;
    });
  }
  /** The block the brief's controls are drawn from, and mv_open_project returns. */
  const cardFit = (doc) => {
    if (doc?.kind === "audiobook") return null;
    const ltxHere = ltxReadyNow();
    const sizes = sizeChoices(cardReading());
    /* WHAT LTX MAKES OF EACH SIZE. H3 renders the size it is given; LTX floors
     * each side to a multiple of 64, so 960x544 comes out 960x512. Said on the
     * size itself, for a project whose scenes can land on LTX. */
    for (const c of sizes.choices) {
      const l = videoSizeFor("ltx", c.width, c.height);
      c.ltx = l.width !== c.width || l.height !== c.height ? { width: l.width, height: l.height } : null;
      c.ltxLine = c.ltx ? `LTX renders this size at ${l.width}x${l.height}: it floors each side to a multiple of 64.` : null;
    }
    const cut = sceneCutFor(doc?.brief);
    const used = doc?.cutUsed || null;
    return {
      sizes,
      size: sizeOfBrief(doc?.brief).id,
      aspectNote: aspectNote(doc?.brief),
      /* The default longest scene and where it comes from, and a sentence when
       * the scenes on file were cut at another default (the size or the
       * engine changed after the cut). A number the person typed is theirs. */
      cut: {
        maxClipSec: cut.maxClipSec, why: cut.why, hardCeilingSec: MV_CLIP_CEILING_SEC,
        madeWithSec: used?.maxClipSec ?? null,
        note: used && !used.chosen && doc?.segments?.length && used.maxClipSec !== cut.maxClipSec
          ? `These scenes were cut with a ${used.maxClipSec} s longest scene; with this brief the default is `
            + `${cut.maxClipSec} s. Cut the song again on Upload & analyze to follow it (boards and clips made `
            + "so far are then marked stale)."
          : null,
      },
      steps: stepChoices(),
      ltxReady: ltxHere,
      hybridLine: ltxHere
        ? "hybrid: H3 for scenes with cast, LTX for the rest"
        : "hybrid: LTX is not on this PC, so every scene renders on H3 (scenes without cast too)",
    };
  };

  /* ══════════════════════════════════════════════════════════════════════════
   * THE PLAN OBJECT — the seam
   *
   * Four verbs, and this block is what turns each of them into a document
   * write and a ledger line: set up (plan_propose), go through (plan_read),
   * approve or change (plan_item / plan_decide / plan_policy / plan_discard),
   * start (plan_run).
   * ════════════════════════════════════════════════════════════════════════ */

  /* The ledger, injected exactly as vfx and the DAW take it — optional, so a
   * structural test can build this factory bare, and caught at every call, so
   * a ledger failure never costs a render. Loud on failure, because a
   * compliance layer that fails silently is not one. */
  const prov = deps.provenance ?? null;
  const actorOf = (req) => (prov ? prov.actorFrom(req) : "system");
  const planScope = (slug) => ({ dir: projectDir(slug) });
  const planAsset = (slug) => `mv/${slug}`;

  /** Append and WAIT — unlike the fire-and-forget note the DAW uses, because
   *  the delegate event's id has to be stored on the policy that acts under
   *  it. An event nobody can name is an authority nobody can check. */
  async function planEvent(slug, evt) {
    if (!prov?.append) return null;
    try { return await prov.append(planScope(slug), { asset: planAsset(slug), ...evt }); }
    catch (err) {
      console.error(`  [provenance] event lost (${evt?.type}/${planAsset(slug)}): ${err.message}`);
      return null;
    }
  }

  /** The project's own events, for the spend meter. ABSENT IS ABSENT: with no
   *  ledger reader the meter reports null rather than a zero that reads like a
   *  quiet project. */
  async function planLedger(slug) {
    if (!prov?.read) return undefined;
    try { return (await prov.read(planScope(slug), { asset: planAsset(slug) })).events; }
    catch { return undefined; }
  }

  /**
   * WHAT A CONTROL RENDER REALLY COSTS ON THIS MACHINE, when it has ever run
   * one — read once per view rather than once per item.
   *
   * ⚠ IT IS THE ENGINE LEDGER, NOT THE PROJECT'S. A control render's cost is a
   * fact about this card and this queue, not about this project: the first one
   * ever run in another project is still the best number available here, and
   * `planLedger` above would never see it. So this reads `engine/<runId>` and
   * filters by `via`, which is the field that says which part of the app spent
   * the time.
   *
   * LAZY, because it is a whole-ledger scan and most plans hold no control item
   * at all. Absent is reported as absent: with no runs the estimate falls back
   * to the stated constant and tags itself `unmeasuredHere`, which is a better
   * answer than a zero and a much better one than a silent guess.
   */
  async function controlRuns(plan) {
    const items = plan?.items || [];
    if (!items.some((i) => CONTROL_TOOLS.has(i.tool))) return null;
    try {
      const { runs } = await engine.activity({ limit: 200 });
      return {
        [CONTROL_VIA.vace]: controlMeasuredFrom(runs, CONTROL_VIA.vace),
        [CONTROL_VIA.pose]: controlMeasuredFrom(runs, CONTROL_VIA.pose),
      };
    } catch { return null; }
  }

  /** The same read for a SINGLE tool call — the spend meter's stamp, which has
   *  no plan to look inside. Shaped as a one-item plan so there is one
   *  definition of "is this worth a ledger scan" rather than two. */
  const controlRunsFor = (tool) => controlRuns({ items: [{ tool }] });

  /* ══════════════════════════════════════════════════════════════════════
   * §11 THE SPEND METER — the half that was missing, which was all of it.
   *
   * `spendMeter` has read `data.estimatedMinutes` off agent-actor events since
   * it was written, and NOTHING ANYWHERE WROTE THAT FIELD. So the meter was
   * always 0, "over budget" was always false, and `budgetRefusal` — a sentence
   * with no caller — could never be said. A gate that cannot fire is not a
   * gate; it is a comment about one.
   *
   * ⚠ IT LIVES AT THE ROUTE, WHICH IS WHY IT ALSO COVERS THE PLAN. The runner
   * executes an item by posting to THIS server on THIS route with the header
   * `agent:plan` (planrun.js's loopback), so stamping here charges a plan's
   * renders and a direct MCP call through one piece of code. Stamping in the
   * runner as well would double-count the same render.
   *
   * TWO HALVES, BOTH HERE:
   *   before — an agent already over the project's budget is refused, with the
   *            sentence plan.js owns. It still ships OFF: agentBudgetMinutes
   *            defaults to null and a null budget refuses nothing.
   *   after  — the estimate is written to the ledger, and ONLY on the way out
   *            of a request that did not throw. A render that was refused at
   *            the door spent no GPU and must not be charged for it.
   * ════════════════════════════════════════════════════════════════════════ */

  /** A human's own click is never charged. provenance.js already refuses to let
   *  a non-browser caller claim to be one, so this is a read of a fact. */
  const isAgent = (actor) => String(actor || "").startsWith("agent:");

  /** What this request is about to spend, or null if it spends nothing. */
  async function priceRequest(action, b) {
    const row = SPENDING_ACTIONS[action];
    const slug = safe(b.slug);
    if (!row || !slug) return null;
    const doc = await readProject(slug);
    if (!doc) return null;
    try {
      const est = estimateOne(doc, { tool: row.tool, args: row.args(b) },
        { controlRuns: await controlRunsFor(row.tool) });
      const minutes = Number(est?.minutes);
      return Number.isFinite(minutes) ? { slug, tool: row.tool, minutes, basis: est.basis } : null;
    } catch { return null; }    // an unpriceable request is never a refused one
  }

  /** The refusal, before anything is spent. */
  async function refuseIfOverBudget(slug) {
    const doc = await readProject(slug);
    if (!doc) return;
    const meter = spendMeter(doc, await planLedger(slug));
    if (meter.over) throw new Error(budgetRefusal(meter));
  }

  /** The stamp, after the work really happened. */
  async function chargeSpend(actor, priced) {
    if (!priced || !(priced.minutes > 0)) return;
    await planEvent(priced.slug, {
      actor,
      /* The ledger's own vocabulary, not a new one: these actions really do
       * author an artefact, and the two that remake an existing one say so. */
      type: priced.tool.startsWith("mv_regen") ? "regen" : "generate",
      data: { surface: "mv", tool: priced.tool, basis: priced.basis,
              [SPEND_FIELD]: priced.minutes },
    });
  }

  /**
   * THE RUNNER, and the one decision inside it worth reading twice: the tool
   * table is built by mvTools() — the same function the MCP entry point spreads
   * into its own list — and an item is executed by calling the tool it names.
   * There is no dispatch here that could drift from the tool the card promised.
   *
   * Built once, at wiring time: mvTools() is a pure array of descriptors with
   * no side effects and no server imports, so this costs nothing until an item
   * actually runs.
   */
  const planRunner = createPlanRunner({
    /* `deps.planTools` is a test's table, so a plan can run without posting
     * to a real server on this machine's port. */
    tools: deps.planTools ?? toolTable(loopbackApi({ port: config.uiPort })),
    updateProject,
    noteRun,
    provenance: prov,
    /* index.js owns the process, the same way it owns renderTimeline: this
     * route asks for an outcome and never learns how to spawn one. */
    keepAwake: deps.keepAwake ?? (() => {}),
  });

  /** Which tool names a plan may contain — DERIVED from the live table, never
   *  typed twice. A second list is a list that goes stale. */
  const plannable = () => plannableFrom(planRunner.tools);

  /**
   * A READ THAT CANNOT RACE THE WRITER, and it is not a nicety — it is the fix
   * for a measured failure.
   *
   * store.js writes a project by writing a temp file and renaming it over the
   * old one, but `readProject` is NOT in the writer's queue. On Windows a
   * rename over a file that another handle has open fails with EPERM, and the
   * plan is the first thing in this app to read a document ON A TIMER WHILE
   * SOMETHING ELSE WRITES IT: a page polls every three seconds for hours while
   * the runner marks each item, and the runner's own tool calls come back
   * through these routes and read too. Measured on this tree: with a reader
   * looping flat out, 290 of 300 writes failed that way; at the spec's own
   * three-second poll, 0 of 40 did. Rare, then — but the failure is a run that
   * stops in the middle of the night for no reason and says "the runner
   * stopped: EPERM", which is the worst kind of rare.
   *
   * `updateProject` with a mutator that returns `false` is store.js's own
   * documented way to abandon a write — so this reads the document INSIDE the
   * single-writer queue and writes nothing. It costs the wait for whatever
   * write is in flight, which is milliseconds.
   *
   * ⚠ It fixes the plan's reads only. `/api/mv/project/<slug>` and every other
   * readProject caller still take the raw path, so the underlying hazard is
   * store.js's and is reported as such rather than papered over here.
   */
  const readSerialised = (slug) => updateProject(slug, () => false);

  /**
   * Read a project with its plan healed if it needs healing — batch.js's lazy
   * rule. There is no boot scan; a plan left at `running` by a process that
   * died comes back `paused` the moment somebody looks, and the write only
   * happens when there is something to heal. A poll every three seconds must
   * not rewrite the document every three seconds.
   */
  async function planDoc(slug, planId) {
    const doc = await readSerialised(slug).catch(() => null);
    if (!doc) throw new Error(`No such project: ${slug}`);
    const cur = findPlan(doc, planId);
    if (cur && cur.state === "running" && !isRunning(slug)) {
      return updateProject(slug, (d) => {
        healPlan(findPlan(d, planId), { live: false });
        return d;
      });
    }
    return doc;
  }

  /**
   * WHICH PLAN A READ MEANS, and it is not quite the same question a write
   * asks.
   *
   * findPlan with no id returns the LIVE plan, which is right for every write:
   * you approve, edit and start the open one. But a plan stops being live the
   * instant it finishes, so a page polling this while a four-hour run walked
   * would get `null` at the exact moment the run completed — the card would
   * vanish precisely when there was something to look at. Found by polling a
   * real run: the last poll before `done` had a plan and the one after had
   * none. A read with no id therefore falls back to the newest plan, which is
   * what a person means by "the plan"; an id given is still answered exactly,
   * so an archived plan reads as itself.
   */
  const planForRead = (doc, planId) =>
    findPlan(doc, planId) ?? (planId ? null : (doc?.plans?.[0] ?? null));

  /**
   * THE REFUSAL WHEN THERE IS NOTHING TO WRITE TO, and it names the fix rather
   * than the absence. The write verbs deliberately keep the STRICT live lookup
   * — approving items on a finished plan would edit a record of what already
   * ran — so "there is no live plan" has to say what to do instead.
   */
  const noPlan = (planId) => new Error(planId
    ? `No plan ${planId} on this project. Every reply carries a "plans" list naming the ones there are.`
    : "No plan is open on this project. mv_plan_propose starts one; a finished plan can still be "
      + "read with mv_plan_read, and named by its id.");

  /** One reply shape for all seven, so the page and an agent read the same
   *  answer. Everything derivable is derived HERE, on read. */
  async function planReply(res, slug, doc, planId, extra = {}) {
    const cur = planForRead(doc, planId);
    return json(res, 200, {
      ok: true,
      plan: planView(doc, cur, { events: await planLedger(slug), controlRuns: await controlRuns(cur) }),
      plans: planIndex(doc),
      running: isRunning(slug),
      ...extra,
    }), true;
  }

  /**
   * WHAT THE DELEGATION APPROVES, and the record it leaves.
   *
   * plan.js works out which items qualify; this flips them and writes ONE
   * `judge` per item naming the `delegate` event that authorised it. The two
   * cannot come apart, because the ids the ledger names are the ids that were
   * flipped, in the same function.
   *
   * ⚠ NEVER A `choice`. A machine approval recorded as a human's decision is
   * the one thing the ledger exists to make impossible, and a `judge` with no
   * delegation to point at is refused here before provenance ever sees it.
   */
  async function applyDelegation(slug, doc, planId) {
    const cur = findPlan(doc, planId);
    const under = Number(cur?.policy?.autoApproveUnderMinutes);
    if (!cur || !Number.isFinite(under) || under <= 0) return { doc, changed: [] };
    if (!cur.policy.delegateEventId) return { doc, changed: [] };
    const ids = autoApprovable(doc, cur);
    if (!ids.length) return { doc, changed: [] };
    const next = await updateProject(slug, (d) => {
      const q = findPlan(d, cur.id);
      for (const it of q.items || []) if (ids.includes(it.id)) it.status = "approved";
      if (q.state === "proposed") q.state = "approved";
      return d;
    });
    for (const id of ids) {
      await planEvent(slug, {
        actor: PLAN_ACTOR,
        type: "judge",
        data: {
          surface: "plan", planId: cur.id, itemId: id, verdict: "approved",
          delegatedBy: cur.policy.delegateEventId,
          underMinutes: under,
          why: cur.policy.delegateBrief,
        },
      });
    }
    return {
      doc: next,
      changed: ids.map((id) =>
        `${id} approved by the delegation, under the brief — recorded as a judge, not as your choice`),
    };
  }

  /**
   * THIS PROJECT'S CLIPS, OUT OF THE APP'S QUEUE AND OFF THE ENGINE.
   *
   * A clip job is named `clip:mv_<slug>_<segment id>_<time>` (generate.js),
   * so the project's own segment ids pick out its jobs and nobody else's.
   * Waiting ones are dropped (generate.js's wait notices a dropped job). The
   * one rendering is cancelled by the engine's run id, the way the rail's
   * Stop cancels its own (index.js /api/cancel): the art queue runs one job
   * at a time, so while it is ours the engine's one art.* run is ours too. A
   * job the art queue has taken but not yet handed to the engine (art.js may
   * first unload the music model) is asked about again, once a second for up
   * to ten seconds, so a Stop pressed in that gap still lands; past that the
   * answer says the clip could not be reached rather than claiming it was.
   */
  async function stopClipsOf(slug, doc) {
    /* The engine door, injectable so a test never reaches a real engine. */
    const door = deps.engineDoor ?? engine;
    const prefixes = (doc?.segments || []).map((sg) => `clip:mv_${slug}_${sg.id}_`);
    const ours = (f) => prefixes.some((p) => String(f || "").startsWith(p));
    let dropped = 0, cancelled = 0, was = null;
    for (const f of [...new Set((art?.queue || []).map((j) => j.file))]) {
      if (ours(f)) dropped += art.drop(f).removed || 0;
    }
    for (let tries = 0; tries < 10; tries++) {
      const cur = art?.status?.().art?.current;
      if (!cur || !ours(cur.file)) break;
      was = cur.title || cur.file;
      const live = await door.status().catch(() => ({ running: [] }));
      const mine = (live.running || []).filter((x) => String(x.via || "").startsWith("art."));
      if (mine.length) {
        const stops = await Promise.all(mine.map((x) => door.cancelRun({ runId: x.runId }).catch(() => ({}))));
        cancelled += stops.filter((x) => x.stopped === true).length;
        break;
      }
      await new Promise((r) => setTimeout(r, deps.stopRetryMs ?? 1000));
    }
    return { dropped, cancelled, was };
  }

  /** The plan card's Stop, in one sentence, from what stopClipsOf really did
   *  and what the plan was running. Never "cancelled" unless it was. */
  function stopWords(c, tool) {
    if (!c) return "";
    const isClip = !tool || /clip|regen/.test(String(tool));
    const bits = [];
    if (c.cancelled) bits.push(`The clip it was rendering${c.was ? ` (${c.was})` : ""} is cancelled on the graphics card.`);
    else if (c.was) bits.push(`The clip being handed to the graphics card (${c.was}) could not be reached in time, so it renders to the end.`);
    if (c.dropped) bits.push(c.dropped === 1 ? "Its clip waiting in the queue is taken off it."
      : `Its ${c.dropped} clips waiting in the queue are taken off it.`);
    if (!c.cancelled && !c.was && !c.dropped) {
      bits.push(isClip ? "No clip of this project was waiting or rendering."
        : `The item it was running (${tool}) is not a clip, so it finishes; nothing after it runs.`);
    }
    return bits.join(" ");
  }

  /**
   * THE RAIL'S STOP REACHES A WORKFLOW PLAN, AND PAUSES IT. index.js
   * /api/cancel calls this, only when the rail's Stop asks (?plans=1), before
   * it cancels the art queue, so a plan whose clip is stopped does not start
   * its next item. The Music screen's Cancel and the Chat's Cancel post the
   * same route without asking: they do not pause a plan themselves (a plan
   * whose clip they cancel stops on that failure, as it always has).
   *
   * ⚠ PAUSED, NOT CANCELLED. A plan can hold a night of approvals; one press
   * to kill a render must not throw them away. The item whose render is
   * cancelled goes back to approved (planrun.js, pause with byStop), so Run on
   * the Plan card carries on from it. The plan card's own Stop is the one
   * that cancels a plan.
   */
  async function pauseRunningPlans() {
    const out = [];
    for (const slug of anyRunning()) {
      const planId = runState(slug)?.planId;
      if (!planId) continue;
      try {
        const r = await planRunner.pause(slug, planId, {
          byStop: true,
          /* Written before the cancel, so it claims nothing about it; the
           * walk says which item's render was cancelled once it knows. */
          note: "Paused by the Stop button. A render it cancelled goes back to approved, and "
            + "everything approved stays approved: press Run to carry on.",
        });
        out.push({ slug, planId, paused: !!r?.changed });
      } catch (err) {
        out.push({ slug, planId, error: String(err?.message || err) });
      }
    }
    return out;
  }

  /** Shared by the GUI and MCP: attach a library track and read its timing. */
  async function analyze(slug) {
    return updateProject(slug, async (doc) => {
      if (!doc.song?.file) throw new Error("Attach a song first.");
      const file = doc.song.file;
      const meta = library.meta.get(file) || {};

      /* Lyric lines come from the LRC Studio already makes. The website gets
       * word-level timings from a paid Whisper queue and folds them into lines;
       * here the line IS the unit, which is what the segmenter wants anyway. */
      let lines = [];
      if (meta.lrc) {
        try {
          lines = lrcToLines(await readFile(path.join(LRC_DIR, meta.lrc), "utf8"));
        } catch { /* an unreadable LRC is a song with no lyrics, not an error */ }
      }
      doc.lyricLines = lines;
      doc.totalDurationSec = Number(meta.durationSeconds || doc.song.durationSeconds || 0);

      /* The beat grid is Studio's own and the website has no equivalent. It is
       * advisory here — segmentation is lyric-driven, exactly as upstream — but
       * it is what lets the timeline snap every cut to a bar later. */
      try {
        const b = await beatsFor(file);
        if (b) {
          doc.beats = { bpm: b.bpm, bars: b.bars, beats: b.beats, confidence: b.confidence ?? null };
          /* ⚠ AND THE DURATION, when the library has none.
           *
           * import_song copies an external file in and calls library.remember
           * with a title — it never measures the audio, so an IMPORTED track
           * has no durationSeconds. totalDurationSec then lands at 0, segment()
           * cuts a zero-length song into nothing, and the project looks broken
           * for a reason nothing reports. Measured on a 94.6 s mp3 that came
           * through as 0.0 s.
           *
           * beats.py already returns the duration it decoded, so the number is
           * sitting right here and was being thrown away. Only used as a
           * fallback: a library track's own metadata stays authoritative. */
          if (!doc.totalDurationSec && Number(b.duration) > 0) {
            doc.totalDurationSec = Number(b.duration);
            doc.song.durationSeconds = Number(b.duration);
            library.remember(file, { durationSeconds: Number(b.duration) });
          }
        }
      } catch { /* beats are a bonus, never a blocker */ }

      noteRun(doc, { tool: "analyze", outcome: `${lines.length} lyric lines, ${doc.totalDurationSec.toFixed(1)}s` });
      return doc;
    });
  }

  /** Cut the song into scenes. Destructive by design, like upstream. */
  async function segment(slug, options = {}) {
    return updateProject(slug, (doc) => {
      if (!doc.totalDurationSec) throw new Error("Analyze the song first.");
      /* The longest scene defaults to the brief's (sizes.js sceneCutFor: 8 s
       * at full size, 5 s at the smaller sizes and High, 15 s for an LTX
       * project), not the website segmenter's 15 s everywhere, which was a
       * video vendor's audio limit and runs past anything H3 was measured at.
       * A number sent wins. Then cutfill.js makes sure a shorter scene never
       * costs picture: a long line is split, a breath is closed. */
      const cutOpts = { maxClipSec: sceneCutFor(doc.brief).maxClipSec, ...options };
      const segs = closeCutHoles(segmentSong(doc.lyricLines, doc.totalDurationSec, cutOpts),
        doc.lyricLines, cutOpts);
      /* Which longest scene this cut used, and whether a person chose it, so
       * the brief can say when a later size or engine change moved the default
       * away from the scenes on file (cardFit.cut.note). */
      doc.cutUsed = { maxClipSec: cutOpts.maxClipSec, chosen: options.maxClipSec !== undefined };
      /* ⚠ Upstream deletes and re-inserts every segment without touching the
       * boards and clips that point at them, which silently orphans the whole
       * chain whenever anyone re-segments after a script exists. Version the
       * set instead, so anything built on the old cut can SEE that it is stale
       * rather than pointing at an index that now means something else. */
      const version = (doc.segmentVersion ?? 0) + 1;
      doc.segmentVersion = version;
      doc.segments = segs.map((s) => ({
        ...s,
        id: `s${version}_${s.index}`,
        // Upstream's insert default — every scene is generated unless the user
        // marks it b-roll or skip.
        mode: "generate",
        segmentVersion: version,
        userAdjusted: false,
      }));
      const stale = doc.boards.length || doc.clips.length;
      if (stale) {
        for (const b of doc.boards) b.staleSegments = true;
        for (const c of doc.clips) c.staleSegments = true;
      }
      noteRun(doc, { tool: "segment", outcome: `${doc.segments.length} scenes (v${version})${stale ? " — existing boards/clips marked stale" : ""}` });
      return doc;
    });
  }

  async function handle(p, req, res, url) {
    /* ---- reads ---- */
    if (p === "/api/mv/projects" && req.method === "GET") {
      json(res, 200, { projects: await listProjects() });
      return true;
    }

    /* What Blender can be asked for, and whether it is here at all.
     *
     * A GET rather than an action because it is the thing a surface reads
     * BEFORE offering the button: with no Blender installed the honest UI is
     * a disabled control and a sentence, not a render that fails a minute
     * later. It also carries the builtin catalogue, so neither surface has to
     * hold its own copy of a list that lives in a separate repository. */
    if (p === "/api/mv/blender" && req.method === "GET") {
      /* ⚠ DERIVE BEFORE ANSWERING. `builtins` is keyed by the toolkit's set
       * names, and blenderStatus() deliberately never launches anything — so
       * without this await the FIRST caller in a fresh process would be served
       * the transcribed seed while /api/mv/previz served the toolkit's eight.
       * Two doors, two answers, which is the split this whole pass removed.
       * One Blender launch per process, cached on disk under a version stamp;
       * every later call is free. */
      const sets = await toolkitSets();
      json(res, 200, {
        ...(await blenderStatus()),
        builtins: BUILTINS, angles: ANGLES, defaultAngles: DEFAULT_ANGLES,
        /* WHERE THAT LIST CAME FROM, so an agent reading this can tell the
         * toolkit's own answer from this app's last-known copy. */
        sets: { names: [...sets.sets], source: sets.source, stale: sets.stale,
                meshesFrom: sets.meshesFrom, why: sets.why || [] },
        assetFormats: [".blend", ".obj", ".glb", ".gltf", ".fbx", ".stl"],
      });
      return true;
    }

    /* The SHOT vocabulary — the camera moves a board can name, the gray-box
     * sets they can be blocked in, and whether Blender is here.
     *
     * Separate from /api/mv/blender because it answers a different question:
     * that one is "what object can be rendered", this one is "what shot can be
     * planned". The move list is returned WHETHER OR NOT Blender is installed,
     * because the words half needs none — a shot plan is the deliverable, and
     * gating it on a 400 MB download would be gating the useful part on the
     * optional one. `?probe=1` costs one Blender launch and asks the toolkit
     * what IT knows, which is the only way a rename on the far side shows up as
     * a disagreement rather than as one failed render months from now. */
    /* IS THERE A 3D RUNTIME, AND WHAT COMES OUT OF IT.
     *
     * The same shape and the same reason as /api/mv/blender above: a surface
     * reads this BEFORE it offers the button, so a machine with no venv gets a
     * sentence naming the missing file and the setting that moves it, rather
     * than a render that dies inside a subprocess a minute later.
     *
     * It also carries the FORMAT CONTRACT — GLB with glTF joints and
     * inverseBindMatrices — from ONE place, so the page, the MCP tool
     * description and the docs cannot come to disagree about what a rigged
     * mesh is. Free: no python, no GPU, no weights needed to answer. */
    if (p === "/api/mv/mesh" && req.method === "GET") {
      json(res, 200, await meshCatalogue());
      return true;
    }

    if (p === "/api/mv/previz" && req.method === "GET") {
      json(res, 200, await previzCatalogue({ probe: url.searchParams.get("probe") === "1" }));
      return true;
    }

    /* WHAT STRUCTURAL CONTROL COSTS AND WHAT IT IS ALLOWED TO CLAIM.
     *
     * Same shape and same reason as /api/mv/previz above: the surface reads
     * this BEFORE it offers the button, so the three numbers, the measured
     * strength ladder, the ~32-minute cost and BOTH licence answers arrive as
     * payload and no page ever holds its own copy of them.
     *
     * ⚠ BOTH licence answers, never one. WAN's is settled and a clip is yours
     * to sell; the DWPose ESTIMATOR that draws the skeletons has no readable
     * terms at all and its catalogue row says so with class "unknown". A card
     * that let the settled half speak for the whole path would be overstating
     * exactly the half nobody has read. Free — no Blender, no engine, no GPU. */
    if (p === "/api/mv/control" && req.method === "GET") {
      json(res, 200, controlCatalogue());
      return true;
    }

    if (p.startsWith("/api/mv/project/") && req.method === "GET") {
      const slug = safe(p.slice("/api/mv/project/".length));
      const doc = slug && await readProject(slug);
      if (!doc) { json(res, 404, { error: "No such project." }); return true; }
      json(res, 200, {
        project: doc,
        stage: stageOfDoc(doc),
        // Audiobook docs have no segments array at all — guard, don't assume.
        coverage: doc.segments?.length
          ? computeCoverage(doc.segments, doc.totalDurationSec) : [],
        /* The sizes this card reaches and Studio's pick, the default longest
         * scene, the step choices worded from the disk, and where hybrid
         * sends a cast-less scene. The page draws the brief from it and an
         * agent reads it here (mv_open_project); the judgements are all made
         * on this side. */
        cardFit: cardFit(doc),
      });
      return true;
    }

    /* THE PLAN, AND THE CHEAP POLL WHILE IT RUNS.
     *
     * Same answer as the `plan_read` action, as a GET, because a page watching
     * a four-hour run asks every three seconds and the project document is
     * megabytes of takes and boards it already has. It heals a plan left
     * `running` by a process that died, which is exactly when somebody is
     * looking — see planDoc. */
    if (p.startsWith("/api/mv/plan/") && req.method === "GET") {
      const slug = safe(p.slice("/api/mv/plan/".length));
      let doc = null;
      try { doc = slug && await planDoc(slug, null); } catch { doc = null; }
      if (!doc) { json(res, 404, { error: "No such project." }); return true; }
      json(res, 200, {
        plan: planView(doc, planForRead(doc, null),
          { events: await planLedger(slug), controlRuns: await controlRuns(planForRead(doc, null)) }),
        plans: planIndex(doc),
        running: isRunning(slug),
        runState: runState(slug),
      });
      return true;
    }

    // Project assets, served straight off disk so the page can show them.
    if (p.startsWith("/api/mv/asset/")) {
      const [slug, file] = p.slice("/api/mv/asset/".length).split("/").map(safe);
      if (!slug || !file) { json(res, 400, { error: "bad asset path" }); return true; }
      const full = path.join(assetsDir(slug), file);
      try {
        const st = await stat(full);
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "Content-Length": st.size,
        });
        createReadStream(full).pipe(res);
      } catch {
        json(res, 404, { error: "not found" });
      }
      return true;
    }

    /* Finished audiobook MP3s stream straight off their recorded path, so the
     * produce panel can play them without knowing the output layout. */
    if (p.startsWith("/api/mv/abmix/")) {
      const [slug, idxStr] = p.slice("/api/mv/abmix/".length).split("/").map(safe);
      const doc = await readProject(slug);
      const bundle = doc?.bundles?.find((x) => x.idx === Number(idxStr));
      if (!bundle?.mixFile) { json(res, 404, { error: "no mix for that bundle" }); return true; }
      try {
        const st = await stat(bundle.mixFile);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": st.size, "Accept-Ranges": "none" });
        createReadStream(bundle.mixFile).pipe(res);
      } catch { json(res, 404, { error: "mix file missing on disk" }); }
      return true;
    }

    /* ---- writes ---- */
    if (p !== "/api/mv" || req.method !== "POST") return false;
    const b = await readBody(req);
    const action = String(b.action || "");

    /* ⚠ ONE SPELLING, WITH ONE LINE OF GRACE FOR THE OLDER ONE.
     *
     * The three asset actions read `kind`. They grew up reading `target`, and
     * both surfaces have been posting that word for months — so a deploy where
     * the page and the routes land a minute apart would otherwise be a page
     * whose Declare and Generate buttons do nothing. This is not a second
     * parameter: `target` is never read inside a case, nothing documents it,
     * and no schema offers it. It is a one-line translation with a date on it —
     * delete it once no caller in this tree posts `target` to these three. */
    if (ASSET_ACTIONS.has(action) && b.kind === undefined && typeof b.target === "string") b.kind = b.target;

    /* §11, the two halves. Both are no-ops for a human and for every action
     * that spends nothing, which is most of them. */
    const actor = actorOf(req);
    const priced = isAgent(actor) ? await priceRequest(action, b) : null;
    let threw = false;

    try {
      /* INSIDE the try, so the refusal reaches the caller as the 400 every
       * other refusal on this route is. Thrown outside it, it escaped `handle`
       * and became a 500 with a stack — a budget message nobody would read. */
      if (priced) await refuseIfOverBudget(priced.slug);
      switch (action) {
        case "create": {
          const kind = b.kind === "audiobook" ? "audiobook" : "mv";
          /* A NEW VIDEO STARTS AT THE CARD'S SIZE: the size of the card's H3
           * tier (sizes.js, from h3tier.js). Shown and changeable in the
           * brief; no reading, or a card H3 is not offered on, keeps full. */
          const pick = kind === "mv" ? sizeChoices(cardReading()).cardPick : null;
          const doc = await createProject(b.title || "Untitled", kind,
            pick ? { brief: { qualityMode: pick } } : {});
          return json(res, 200, { ok: true, slug: doc.slug, project: doc }), true;
        }

        case "delete": {
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          await deleteProject(slug);
          return json(res, 200, { ok: true }), true;
        }

        case "import_song": {
          /* External audio in: a file from ANYWHERE becomes a library track
           * and is attached in one move. The library re-reads its folder on
           * every list, so a copy is all "importing" is — the beat grid works
           * on any audio, and lyrical segmentation simply finds no lines
           * unless timed lyrics are made for it later. */
          const slug = safe(b.slug);
          const src = String(b.path || "");
          if (!slug || !src) throw new Error("bad slug or path");
          if (!/\.(mp3|wav|flac|ogg|m4a)$/i.test(src)) throw new Error("Audio only: mp3, wav, flac, ogg or m4a.");
          const base = path.basename(src).replace(/[^\w. -]+/g, "_");
          const dest = path.join(deps.outputDir(), base);
          try { await stat(dest); } catch { await deps.copyFile(src, dest); }
          library.remember(base, { title: b.title || path.parse(base).name, imported: true });
          b.file = base;
          // fall through into attach_song by reusing its body below
        }
        // eslint-disable-next-line no-fallthrough
        case "attach_song": {
          const slug = safe(b.slug), file = safe(b.file);
          if (!slug || !file) throw new Error("bad slug or file");
          const meta = library.meta.get(file);
          if (!meta) throw new Error(`Not in the library: ${file}`);
          await updateProject(slug, (doc) => {
            doc.song = {
              file,
              title: meta.title || file,
              durationSeconds: Number(meta.durationSeconds || 0),
              source: "library",
              lrc: meta.lrc || null,
              cover: meta.cover || null,
            };
            if (!doc.title || doc.title === "Untitled") doc.title = meta.title || doc.title;
            noteRun(doc, { tool: "attach_song", outcome: file });
            return doc;
          });
          const doc = await analyze(slug);
          return json(res, 200, { ok: true, project: doc, stage: stageOfDoc(doc) }), true;
        }

        case "analyze": {
          const doc = await analyze(safe(b.slug));
          return json(res, 200, { ok: true, project: doc, stage: stageOfDoc(doc) }), true;
        }

        case "segment": {
          const opts = {};
          for (const k of ["maxClipSec", "minClipSec", "leadInSec", "instrumentalGapSec"]) {
            if (Number.isFinite(b[k])) opts[k] = Number(b[k]);
          }
          /* REFUSED, NOT CLAMPED. A scene longer than the ceiling renders at
           * the ceiling (generate.js), so the rest of it would have no picture;
           * a longest scene under a second is not a scene. */
          if (opts.maxClipSec !== undefined && !(opts.maxClipSec >= 1 && opts.maxClipSec <= MV_CLIP_CEILING_SEC)) {
            throw new Error(`maxClipSec must be from 1 to ${MV_CLIP_CEILING_SEC} seconds: ${MV_CLIP_CEILING_SEC} s is the `
              + "longest one clip renders, and a longer scene would leave the rest of it without a picture.");
          }
          const doc = await segment(safe(b.slug), opts);
          return json(res, 200, {
            ok: true, segments: doc.segments, stage: stageOfDoc(doc),
            coverage: computeCoverage(doc.segments, doc.totalDurationSec),
          }), true;
        }

        case "update_segment": {
          const slug = safe(b.slug);
          const doc = await updateProject(slug, (doc) => {
            /* ⚠ ONE HANDLE. There was a second parameter here, an `index`
             * alias beside the id, and no surface has ever sent it — both post
             * `id`, which is the durable handle. What the alias was FOR is
             * still here and is now reachable through the one door: an index
             * passed as `id` resolves, exactly as import_clip's `segmentId`
             * already did. (Spelled in prose on purpose: the census reads this
             * file for the parameters the route names, and a dead one written
             * out in a comment reads to it as a live one.) */
            const seg = doc.segments.find((s) => s.id === b.id || s.index === b.id);
            if (!seg) throw new Error("No such segment.");
            if (b.mode) {
              if (!["generate", "broll", "skip"].includes(b.mode)) throw new Error("mode must be generate, broll or skip");
              /* A mode change has to reach the CLIP, because the renderer and
               * the edit list read the clip, not the segment — change only the
               * segment and the toggle looks like it worked and does nothing.
               * A clip that already rendered is left alone. */
              const clip = doc.clips.find((c) => c.segmentId === seg.id);
              if (clip && clip.status === "done" && clip.mode !== b.mode) {
                throw new Error("That scene has already rendered. Delete its clip first if you want to change how it is covered.");
              }
              seg.mode = b.mode;
              if (clip) clip.mode = b.mode;
            }
            if (Number.isFinite(b.startSec) || Number.isFinite(b.endSec)) {
              /* ⚠ THE FIFTH ARGUMENT IS THE SONG'S LENGTH, and it was missing.
               *
               * resnapSegment's first act is `Math.min(newStartSec, total)` to
               * clamp the window inside the song. `Math.min(x, undefined)` is
               * NaN, so BOTH ends came back NaN, round1 turned them into null,
               * and the scene was written back with startSec, endSec and
               * durationSec all null and kind flipped to "instrumental" —
               * because a window of NaN covers no lyric line. Retiming a scene
               * DESTROYED it, silently, and answered ok.
               *
               * Nothing caught it because until now no human control sent these
               * two: `update_segment.startSec` and `.endSec` were an agent-only
               * pair sitting in HUMAN_DEFAULTS as an open gap, and the parameter
               * census proves a knob is REACHABLE, never that turning it does
               * what it says. Measured at the wire on a copy of
               * aiplay-aftermovie: asked 15.5→20.5, got null→null. */
              const next = resnapSegment(
                seg,
                Number.isFinite(b.startSec) ? Number(b.startSec) : seg.startSec,
                Number.isFinite(b.endSec) ? Number(b.endSec) : seg.endSec,
                doc.lyricLines,
                doc.totalDurationSec,
              );
              Object.assign(seg, next);
            }
            seg.userAdjusted = true;
            return doc;
          });
          return json(res, 200, {
            ok: true, segments: doc.segments,
            coverage: computeCoverage(doc.segments, doc.totalDurationSec),
          }), true;
        }

        case "set_brief": {
          const doc = await updateProject(safe(b.slug), (doc) => {
            const allowed = ["medium", "tone", "narrative", "aspectRatio", "resolution",
                             "qualityMode", "freeText", "directionSummary", "videoEngine", "storyboardStyle",
                             /* castRefs:false keeps the cast in the PROMPT rather than as
                              * reference pictures, which is the only way to stay on LTX —
                              * references are H3-only, and H3 at 1080p is ten times the
                              * cost per clip. A project can now choose consistency-by-
                              * description over consistency-by-reference. */
                             "castRefs", "baseScale", "videoSteps", "boardRef",
                             "imageEngine", "imageCheckpoint",
                             /* THE SONG UNDER A REFERENCE CLIP. generate.js freezes
                              * the song into an H3 reference render only where the
                              * board sings or where the brief says "always" — and
                              * until 2026-09-19 nothing could say it: the Hex Appeal
                              * video's 44 close-ups of a singer rendered with no
                              * song under them and no lipsync. "always" puts it
                              * under every scene and is where NEW projects start
                              * since 2026-09-24 (store.js blankProject; the REWIND
                              * A/B, DIRECTING.md §2); "auto" (or a brief with no
                              * value, every older project) only under a board that
                              * sings (lipSync). */
                             "songConditioning",
                             /* THE SPEND METER'S BUDGET, and it ships OFF.
                              *
                              * null — the value every existing document already
                              * has, because it has no such key — is no gate at
                              * all, and the meter is painted on the plan card
                              * anyway. A default that started refusing calls an
                              * agent used to be allowed to make would be a
                              * regression however good the reason, and a week
                              * of real numbers beats a guessed threshold. */
                             "agentBudgetMinutes"];
            /* ⚠ VALIDATE THE ENUMS. This loop used to write any value at all
             * onto the brief, and the two enum fields both fail SILENTLY
             * downstream: videoGraph treats anything that is not exactly "ltx"
             * as H3 (workflow.js), so a typo'd engine did not error, it just
             * rendered every clip on the ten-times-more-expensive model. The
             * global engine route (index.js) has always validated; this one
             * never did. */
            const ENUMS = {
              songConditioning: ["auto", "always"],
              videoEngine: ["h3", "ltx", "hybrid"],
              /* Qwen Image 2.1 too: it is an image engine art.js renders, and a
               * project that names it must not be refused (INSTALLER_PLAN S5). */
              imageEngine: ["flux2", "ideogram", "checkpoint", "qwen-image-2.1"],
              baseScale: ["auto", "full"],
              /* The size list (sizes.js): the card tiers and the two older sizes. */
              qualityMode: MV_SIZE_IDS,
              /* ⚠ MATCHES THE CONTROL, which offers two now. It offered five,
               * and 1:1, 4:3 and 21:9 were accepted here and then rendered as
               * 16:9 1344x768 by renderSize without a word. Validation that
               * accepts a shape the renderer cannot make is the same lie as
               * one that refuses the app's own dropdown. */
              aspectRatio: MV_ASPECTS,
            };
            for (const k of allowed) {
              if (!b.brief || b.brief[k] === undefined) continue;
              const v = b.brief[k];
              if (ENUMS[k] && v !== null && !ENUMS[k].includes(String(v))) {
                throw new Error(`brief.${k} must be one of ${ENUMS[k].join(", ")} — got ${JSON.stringify(v)}`
                  + (k === "aspectRatio" ? ". Studio renders only these two shapes." : ""));
              }
              if (k === "videoSteps" && v !== null
                  && (!Number.isInteger(Number(v)) || Number(v) < 2 || Number(v) > 40)) {
                throw new Error(`brief.videoSteps must be an integer 2-40 — got ${JSON.stringify(v)}`);
              }
              if (k === "agentBudgetMinutes" && v !== null
                  && (!Number.isFinite(Number(v)) || Number(v) <= 0)) {
                throw new Error("brief.agentBudgetMinutes must be a positive number of minutes, "
                  + `or null for no gate at all — got ${JSON.stringify(v)}`);
              }
              doc.brief[k] = v;
            }
            noteRun(doc, { tool: "set_brief", outcome: Object.keys(b.brief || {}).join(", ") });
            return doc;
          });
          return json(res, 200, { ok: true, brief: doc.brief, stage: stageOfDoc(doc) }), true;
        }

        case "add_asset": {
          /* DECLARE a character, background or prop that does not exist yet.
           *
           * ⚠ THE HOLE THIS FILLS IS THE WHOLE PROPS PROBLEM. Until now the only
           * ways a row came into being were set_bible (an LLM authoring the
           * entire bible at once) and import_asset (which REQUIRES a picture you
           * already have). So a person who noticed the car — the object in eight
           * scenes that DIRECTING.md says cost a whole video — could not write it
           * down. They could tick it on a board only if something else had
           * already declared it, and the one control that would have created it
           * belonged to an agent. "Props are cast" was a rule with no door.
           *
           * A declared row with imageFile:null is a legitimate, useful state: it
           * is what the Generate and Blender buttons act on, and what stageOfDoc
           * now holds the cast stage open for. This creates exactly that.
           *
           * NAMES ARE THE BINDING KEY — boards reference by name, and commitBible
           * merges by name — so a duplicate is refused here rather than allowed
           * to make two rows that every later lookup resolves to the first of. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const target = assetKind(b.kind, ["characters", "backgrounds", "props"]);
          if (!target) throw new Error("kind must be characters | backgrounds | props");
          /* Validated BEFORE the write, and by the same reader update_asset
           * uses, so the two doors cannot disagree about what a role is. */
          const role = readRole(b.role);
          const name = String(b.name || "").trim();
          if (!name) throw new Error("Give it a name — the name IS how boards and clip prompts refer to it.");
          const doc = await updateProject(slug, (doc) => {
            doc[target] = doc[target] || [];        // props post-date some documents
            const taken = [...doc.characters, ...doc.backgrounds, ...(doc.props || [])]
              .find((x) => String(x.name).toLowerCase() === name.toLowerCase());
            if (taken) {
              throw new Error(
                `"${taken.name}" is already declared. Names bind references across the whole `
                + `project, so they have to be unique — edit that row, or pick another name.`);
            }
            const row = {
              id: `${target[0]}${doc[target].length + 1}_${Date.now().toString(36).slice(-4)}`,
              name, role,
              description: String(b.description || "").trim(),
              imageFile: null, status: "pending", takes: [],
            };
            /* The prompt field each generator reads. generateAsset falls back to
             * `description` when it is null, which is what makes a row declared
             * with two words immediately renderable. */
            if (target === "backgrounds") row.platePrompt = b.prompt ?? null;
            else row.sheetPrompt = b.prompt ?? null;
            doc[target].push(row);
            noteRun(doc, { tool: "add_asset", outcome: `${ONE[target]} ${row.name} declared` });
            return doc;
          });
          return json(res, 200, { ok: true, project: doc, stage: stageOfDoc(doc) }), true;
        }

        case "import_asset": {
          /* The local answer to the website's "base characters": point at a
           * picture you already have and it becomes a character or a
           * background. No generation, no model, no wall — a file copy. */
          const slug = safe(b.slug);
          const src = String(b.path || "");
          if (!slug || !src) throw new Error("bad slug or path");

          /* ⚠ THE ONE DOOR A CONTACT SHEET COULD STILL WALK THROUGH.
           *
           * blender_asset cannot produce a grid — the toolkit refuses to write
           * one to a reference path — but this action takes any path on disk,
           * and a grid rendered by hand beside its sidecar would have become an
           * `imageFile` like anything else. That is the failure DIRECTING.md
           * measured twice: handed a contact strip, the model draws a contact
           * strip.
           *
           * The check refuses only what is PROVEN unsafe (see blender.js:
           * `safe` is "not proven unsafe"). A picture off the Images tab has no
           * sidecar, has never had one, and is imported exactly as before. */
          const gate = await referenceSafe(src);
          if (!gate.safe) {
            throw new Error(
              `${path.basename(src)} cannot be installed as a sheet:\n`
              + gate.why.map((w) => `  - ${w}`).join("\n")
              + `\nCrop one panel out of it and import that instead.`);
          }

          const target = needKind(b.kind, "characters", CAST_KINDS);
          const name = await stageAsset(slug, src,
            target === "characters" ? "char" : target === "props" ? "prop" : "bg");
          const doc = await updateProject(slug, (doc) => {
            doc[target] = doc[target] || [];        // props post-date some documents
            const row = {
              id: `${target[0]}${doc[target].length + 1}_${Date.now().toString(36).slice(-4)}`,
              name: String(b.name || path.parse(src).name),
              /* ⚠ THROUGH readRole, like its two siblings. This was
               * `b.role ?? null` — any string an agent sent became the row's
               * role, and nothing downstream reads a role it does not
               * recognise, so a typo produced a row that silently had none.
               * add_asset and update_asset have validated it all along; this
               * one door was unlocked. */
              role: readRole(b.role),
              description: String(b.description || ""),
              imageFile: name,
              status: "approved",
              imported: true,
              // Same shape as a generated take — a null seed says "imported".
              takes: [{ file: name, seed: null, at: Date.now() }],
            };
            if (target === "backgrounds") row.platePrompt = null; else row.sheetPrompt = null;
            doc[target].push(row);
            noteRun(doc, { tool: "import_asset", outcome: `${target}: ${row.name}` });
            return doc;
          });
          return json(res, 200, { ok: true, project: doc, stage: stageOfDoc(doc) }), true;
        }

        case "import_clip": {
          /* The video half of import_asset, and the missing return leg of the
           * polish loop: a clip that ALREADY EXISTS in the clips library — a
           * vfx render, a Studio export, an imported file — becomes a TAKE on
           * a scene, exactly as generate_clip's output does. No generation, no
           * model, no copy: build_timeline already points items at
           * /api/clip/<name>, and the file is already in that library.
           *
           * Until this existed, b-roll segments had no way to receive footage
           * at all, and a vfx-polished clip could reach the timeline only as a
           * hand-placed foreign item that read_timeline could not own. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const name = safe(b.clip);
          if (!name) throw new Error("Give `clip`, a name from the clips library.");
          if (!/\.(mp4|webm|mov|mkv|m4v)$/i.test(name)) {
            throw new Error(`${name} is not a video — a scene's take must be one (mp4, webm, mov, mkv or m4v).`);
          }
          try { await stat(path.join(deps.CLIP_DIR, name)); } catch {
            throw new Error(`${name} is not in the clips library. Takes are library names, not paths.`);
          }
          /* MEDIA length, when anything recorded one (a vfx render stamps it).
           * An explicit `seconds` wins — the caller may know better — and the
           * segment length is the honest fallback, not a probe we cannot make
           * (this app ships without ffprobe by promise). */
          const known = deps.clipSeconds ? deps.clipSeconds(name) : null;
          const seconds = Number.isFinite(b.seconds) && b.seconds > 0 ? Number(b.seconds) : known;
          const pick = b.pick !== false;
          const doc = await updateProject(slug, (doc) => {
            /* `segmentId` already accepts an index; the `index` alias beside
             * it was read by the route and sent by neither surface. */
            const seg = doc.segments.find((s) => s.id === b.segmentId || s.index === b.segmentId);
            if (!seg) throw new Error(`No such segment: ${b.segmentId}`);
            if (seg.mode === "skip") {
              throw new Error(`Segment ${seg.index} is set to skip — update_segment it to generate or broll first.`);
            }
            let row = doc.clips.find((c) => c.segmentId === seg.id);
            if (!row) {
              row = { id: `c_${seg.id}`, segmentId: seg.id, clipIndex: seg.index,
                      boardId: null, mode: seg.mode, takes: [] };
              doc.clips.push(row);
            }
            row.takes = row.takes || [];
            // Same shape as a generated take — a null seed says "imported".
            row.takes.push({ clip: name, seed: null, at: Date.now(), imported: true,
                             ...(seconds ? { seconds } : {}) });
            if (pick) {
              row.clipFile = name;
              row.status = "done";
              row.engine = "import";
              row.durationSeconds = seconds ?? seg.durationSec ?? null;
            }
            noteRun(doc, { tool: "import_clip", outcome: `scene ${seg.index + 1} ← ${name}${pick ? "" : " (take only)"}` });
            return doc;
          });
          /* ⚠ AND A LEDGER EVENT, which this route did not write for as long as
           * it has existed. A generated take leaves a `generate` naming the
           * model that made it; an imported one left `runs`, a capped activity
           * list inside the document, and nothing the compliance layer could
           * read — so a scene could carry footage whose origin no ledger had
           * ever heard of, and an export could fold an origin class over a
           * stream that was silent about six of its shots.
           *
           * The type is `import`, which EVENT_TYPES has always had, and it
           * claims exactly what is true: a file that already existed became a
           * take, at a time, by an actor. It names NO model, because this
           * route does not know one and inventing one would be worse than the
           * silence it replaces. Where the clip came from — a vfx render, an
           * export, a file somebody dropped in — is the clip library's to say,
           * and `clip` is the name to ask it with. */
          await planEvent(slug, {
            actor: actorOf(req),
            type: "import",
            data: {
              clip: name, segmentId: b.segmentId, picked: pick,
              seconds: seconds ?? null,
              /* Said out loud rather than left to be inferred from an absent
               * field: nothing here knows what rendered this. */
              model: null, note: "a clip that already existed became a take; no model is claimed",
            },
          });
          const row = doc.clips.find((c) => {
            const s = doc.segments.find((sg) => sg.id === c.segmentId);
            return s && (s.id === b.segmentId || s.index === b.segmentId);
          });
          return json(res, 200, { ok: true, clip: row?.clipFile, takes: row?.takes, project: doc, stage: stageOfDoc(doc) }), true;
        }

        case "generate_asset": {
          /* Renders a TAKE STRIP (up to 4 variants, one text encode) for a
           * character, background, prop or board, and appends to takes[].
           * Blocks until done — an image is seconds, and the caller wants the
           * files. */
          const kind = needKind(b.kind, "characters");
          const doc = await generateAsset(deps, safe(b.slug), {
            target: ONE[kind],
            id: b.id, count: b.count, seed: b.seed,
            /* ⚠ `refs` REACHES A CALLER FROM HERE ON, and the note this
             * replaces claimed that on 2026-08-28 and was wrong for six days.
             * The route did forward b.refs — and NOTHING PUT refs IN THE BODY:
             * no page control, no MCP argument. The dead end had moved one
             * layer up while the comment read as closed. It is reachable now
             * from both surfaces, which is the only sense in which a knob
             * exists.
             *
             * WHAT IT IS FOR, measured twice and written into DIRECTING.md §2:
             * a character sheet here is a multi-panel contact strip, and handed
             * a whole strip as an in-context reference FLUX reproduces THE
             * STRIP — same three-panel layout — instead of composing the shot
             * the board prompt describes. The identical prompt with refs off
             * produced the correct single composed frame with the look carried
             * by the style bible alone. So `refs:false` is the single-panel
             * path, and on a BOARD it is usually the one that works.
             *
             * The default is untouched: generateAsset still defaults to true,
             * because a default changes on a measurement over a whole library
             * rather than on one strand's inference. What changes is that
             * anybody can now say otherwise, and be told which it will do
             * before spending the render. */
            refs: b.refs,
          });
          return json(res, 200, { ok: true, project: doc, stage: stageOfDoc(doc) }), true;
        }

        case "blender_asset": {
          /* generate_asset's sibling: the SAME row, the SAME takes[], the same
           * auto-select — rendered by Blender rather than by the image engine.
           *
           * The reason it is worth a second path at all is identity. An image
           * model re-invents an object from its description on every call; a
           * mesh IS the same object on every call, and H3 takes the picture as
           * a reference and renders in the style OF that picture. So the rows
           * where identity matters most — DIRECTING.md's "props are cast" —
           * can be held by geometry instead of by adjectives.
           *
           * What it cannot do is model a noun. See blender.js: a named builtin
           * out of the toolkit's gray-box sets, or a model file somebody
           * supplies. Everything else stays on generate_asset. */
          const doc = await blenderAsset(safe(b.slug), {
            target: ONE[needKind(b.kind, "props", CAST_KINDS)], id: b.id,
            builtin: b.builtin, asset: b.asset,
            angles: b.angles, res: b.res, aspect: b.aspect,
            samples: b.samples, lens: b.lens, transparent: b.transparent,
          });
          return json(res, 200, {
            ok: true, project: doc.doc, stage: stageOfDoc(doc.doc),
            takes: doc.made.map((m) => ({ file: m.staged, angle: m.angle })),
            /* A panel the reference gate threw away is REPORTED, not swallowed.
             * The whole point of the gate is that somebody finds out. */
            refused: doc.refused,
          }), true;
        }

        /* ── GEOMETRY FROM THE PANEL THE ROW ALREADY HAS ─────────────────
         *
         * blender_asset above renders an object somebody modelled first, and
         * says so loudly: there is no text-to-3D in it. This is the other half
         * — TripoSG turns ONE reference panel into a mesh, so the prop nobody
         * has a .blend for can still be held by geometry instead of by
         * adjectives.
         *
         * ⚠ IT DOES NOT TOUCH imageFile. The clip engines take PICTURES;
         * control.js's IMAGE_RE is the list of what may be a reference and a
         * mesh is not on it. The mesh lands in its own field beside the sheet,
         * counts as a body for the stage machine (store.js's assetComplete),
         * and leaves the row's reference exactly where it was.
         *
         * Every refusal happens before a python starts — see server/mesh/
         * runner.js. The one worth naming here is VRAM: on a 16 GB card with
         * the music and video engine resident there is not enough free, and the
         * answer is "unload the engine first", not an out-of-memory forty
         * seconds in. */
        case "mesh_asset": {
          const r = await meshAsset(safe(b.slug), {
            target: ONE[needKind(b.kind, "props", CAST_KINDS)], id: b.id,
            /* A panel other than the row's selected take. The normal path is
             * null and the row's own sheet; this exists because the selected
             * take is not always the best single panel of the object. */
            image: b.image || null,
            rig: b.rig === true,
            seed: b.seed, steps: b.steps,
            actor,
          });
          return json(res, 200, {
            ok: true, project: r.doc, stage: stageOfDoc(r.doc),
            mesh: r.staged, skinned: r.skinned, joints: r.joints,
            /* A rig that ran and produced no usable skin is REPORTED, never
             * swallowed — the same rule blender_asset's `refused` follows. */
            rigRefused: r.rigRefused, runId: r.runId, elapsedSec: r.elapsedSec,
          }), true;
        }

        /* The rig, as its own verb, because it is the one that can be refused
         * ON EVIDENCE: by now there is a GLB to measure, so the proportions
         * decide instead of a guess from a picture. UniRig asked to rig a crate
         * does not fail — it invents a skeleton for a crate and reports
         * success, which is the expensive kind of wrong. */
        case "mesh_rig": {
          const r = await rigAsset(safe(b.slug), {
            target: ONE[needKind(b.kind, "props", CAST_KINDS)], id: b.id,
            actor,
          });
          return json(res, 200, {
            ok: true, project: r.doc, stage: stageOfDoc(r.doc),
            rig: r.staged, joints: r.joints, runId: r.runId, elapsedSec: r.elapsedSec,
          }), true;
        }

        case "pick_take": {
          const doc = await pickTake(safe(b.slug), {
            /* Boards and clips both switch takes here, so this one reads the
             * whole vocabulary rather than the cast three. */
            target: ONE[needKind(b.kind, "characters")], id: b.id, file: safe(b.file),
          });
          return json(res, 200, { ok: true, project: doc }), true;
        }

        /* ─────────────── ONE SHOT: look at it, change it, redo it ───────────
         *
         * Free and destructive-of-nothing. `shot` is the answer to "why did
         * this come out like that" — the EXACT prompt, which sheets actually
         * resolved and to which file, which named references reached the render
         * as nothing, the engine that choice implies, and every take with the
         * evidence for its own render rather than the row's latest. It is
         * deliberately a read: an agent about to spend twenty-eight minutes of
         * H3 should be able to check what it is buying for nothing first. */
        case "shot": {
          const doc = await readProject(safe(b.slug));
          if (!doc) return json(res, 404, { error: "no such project" }), true;
          return json(res, 200, {
            ok: true,
            shot: withRenderFacts(doc, shotRecord(doc, b.segmentId)),
            /* The names a human may tick, with whether each can actually be
             * carried. The page must not have to re-derive this — a picker that
             * offers a name with no sheet is the silent drop one step earlier. */
            declared: [
              ...doc.characters.map((x) => ({ name: x.name, kind: "character", file: x.imageFile || null })),
              ...doc.backgrounds.map((x) => ({ name: x.name, kind: "background", file: x.imageFile || null })),
              ...(doc.props || []).map((x) => ({ name: x.name, kind: "prop", file: x.imageFile || null })),
            ],
          }), true;
        }

        /* Edit ONE shot: the prompt, the references it carries, or both.
         *
         * ⚠ MERGES, where set_board replaces. The board editor sends a complete
         * board and means every field it omits; this is a per-shot tweak from a
         * panel showing one thing at a time, so sending refs alone must not
         * erase the shot list. Writing only — it never renders, because "I
         * meant to save the prompt and it spent twenty minutes" is not a
         * mistake this route may make. */
        case "set_shot": {
          const slug = safe(b.slug);
          let changed = [];
          const doc = await updateProject(slug, (d) => {
            /* ⚠ A STRING MEANS "SET IT", INCLUDING THE EMPTY ONE — undefined
             * means "do not touch it". This was `"prompt" in b`, which made the
             * wire format load-bearing (JSON.stringify silently drops an
             * undefined value, so the key's mere presence decided whether a
             * refs-only save wiped the hand-written prompt) and forced both
             * surfaces to assemble their body conditionally. A type test says
             * the same thing out loud and cannot be broken by a serialiser. */
            changed = applyShotEdit(d, b.segmentId, {
              prompt: typeof b.prompt === "string" ? b.prompt : undefined,
              refs: Array.isArray(b.refs) ? b.refs : undefined,
              prominence: b.prominence,
            });
            const seg = findSegment(d, b.segmentId);
            noteRun(d, { tool: "mv_set_shot", outcome: `scene ${(seg?.index ?? 0) + 1}: ${changed.join("; ")}` });
            return d;
          });
          /* The shot record comes back with the edit applied, so the caller
           * sees the new prompt and the drift it just created without a second
           * round trip — which is what makes "and see what that changed" true
           * for an agent as well as for the page. */
          return json(res, 200, { ok: true, changed, shot: withRenderFacts(doc, shotRecord(doc, b.segmentId)), project: doc }), true;
        }

        case "generate_clip":
        case "regen_clip": {
          /* regen_clip IS generate_clip with a fresh seed — the relationships
           * (segment, board, cast, soundtrack window) all come from the
           * project metadata, so a regenerated clip is the same shot re-rolled,
           * never a reconstruction from memory. The old take stays.
           *
           * `prompt` is the one-render override: re-render THIS shot with this
           * text and change nothing else about the project. That is different
           * from set_shot's stored edit on purpose — trying a wording is not
           * the same as adopting it, and a trial that quietly rewrote the
           * project would make the undo be "remember what it used to say". */
          const slug = safe(b.slug);
          const before = await readProject(slug);
          if (!before) throw new Error(`No such project: ${slug}`);
          /* ONE RENDER, TWO HANDLES. The shot inspector knows the scene; a row
           * in the clips table knows the clip it IS. Resolving both here is
           * what lets the two controls post the same body at the same action —
           * which is the whole reason the two Render buttons had drifted into
           * offering different halves of the same capability.
           *
           * This is NOT the second spelling that was deleted from this case. A
           * bare scene index under its own key was a synonym for segmentId that
           * no surface ever sent; a clip id is a different handle, held by a
           * different caller, and findSegment cannot resolve it. */
          const segmentId = b.segmentId ?? (b.clipId
            ? before.clips.find((c) => c.id === b.clipId)?.segmentId
            : undefined);
          if (segmentId === undefined || segmentId === null || segmentId === "") {
            throw new Error(b.clipId ? `No such clip: ${b.clipId}` : "Name the shot: send segmentId or clipId.");
          }
          const doc = await generateClip(deps, slug, {
            segmentId,
            /* ⚠ regen_clip USED TO FORCE `undefined` HERE, throwing away a seed
             * the caller had supplied on purpose. That was right when a re-roll
             * was the only thing regenerating could mean; it is wrong now that
             * the prompt is editable, because HOLDING the seed and changing one
             * sentence is the only way to see what the sentence did. Omitting
             * the seed still rolls a fresh one, so the plain re-roll is
             * unchanged — it is now a choice rather than the only option. */
            seed: b.seed,
            prompt: renderPrompt(before, segmentId, b.promptSource, b.prompt),
            /* `loop:false` renders WITHOUT closing on the opening frame. That
             * leaves the shot unpinned — measured as 3x the motion, and as
             * identity drift in 1 of 3 on the one small sample there is. */
            loop: b.loop,
          });
          const seg = findSegment(doc, segmentId);
          const row = doc.clips.find((c) => c.segmentId === seg?.id);
          return json(res, 200, { ok: true, clip: row?.clipFile, takes: row?.takes, project: doc,
                                  promptSource: b.promptSource ?? null,
                                  shot: withRenderFacts(doc, shotRecord(doc, segmentId)), stage: stageOfDoc(doc) }), true;
        }

        case "regen_by_clip_id": {
          /* The Studio right-click path: the timeline item knows only its
           * mvClipId and the doc its mvProjectId — resolve back to the segment
           * and re-roll. Returns the NEW clip file so the caller can repoint
           * the item it was invoked from. */
          const slug = safe(b.slug);
          const doc0 = await readProject(slug);
          if (!doc0) throw new Error(`No such project: ${slug}`);
          const row0 = doc0.clips.find((c) => c.id === b.clipId);
          if (!row0) throw new Error(`No such clip: ${b.clipId}`);
          /* Same knobs as regen_clip. An id-addressed door that quietly cannot
           * carry an edited prompt or a held seed is not the same capability
           * wearing a different handle — it is a worse one, and the caller has
           * no way to find that out except by the result. */
          const doc = await generateClip(deps, slug, {
            segmentId: row0.segmentId, seed: b.seed,
            prompt: renderPrompt(doc0, row0.segmentId, b.promptSource, b.prompt),
            loop: b.loop,
          });
          const row = doc.clips.find((c) => c.id === b.clipId);
          return json(res, 200, { ok: true, clip: row?.clipFile, takes: row?.takes,
                                  promptSource: b.promptSource ?? null,
                                  shot: withRenderFacts(doc, shotRecord(doc, row0.segmentId)) }), true;
        }

        case "build_timeline": {
          /* Compose the Studio project and save it through the SAME route the
           * Save button uses, so the two can never drift. */
          const out = await buildTimeline(deps, safe(b.slug));
          const saved = await deps.saveStudioProject(out.name, out.doc);
          return json(res, 200, { ok: true, project: saved?.name ?? out.name, scenes: out.scenes }), true;
        }

        case "render_video": {
          /* The finished film, composed offline rather than recorded in real
           * time. build_timeline hands the cut to Studio; this turns that cut
           * into a file without anyone sitting through it.
           *
           * ⚠ Needs a timeline saved by build_timeline first, and ffmpeg on the
           * machine. Studio's own Export stays the path that needs neither.
           *
           * `fade` cross-dissolves the cuts. It is only honest because clips now
           * overshoot their slots -- alignFrames rounds UP, so the outgoing clip
           * has real frames to hold under the incoming one. Zero is a hard cut,
           * which stays the default: a dissolve is a choice, not a repair. */
          const doc = await readProject(safe(b.slug));
          if (!doc) throw new Error("No such project.");
          if (!doc.timelineProject) throw new Error("Nothing to render — run build_timeline first.");
          /* THE BEAT PULSE, and the tempo comes from the project's own analysis
           * rather than from the caller — the number is already measured and
           * sitting on doc.beats, and asking a caller to repeat it is asking
           * for the two to disagree.
           *
           * ⚠ Gated on beat CONFIDENCE. Pulsing the image on a grid that is not
           * really there is worse than not pulsing at all: it reads as a fault
           * in the encode rather than as an edit. 0.40 is the same bar the
           * "edit on the music" clause uses for snapping cuts. */
          const conf = Number(doc.beats?.confidence) || 0;
          const bpm = Number(doc.beats?.bpm) || 0;
          const wantZoom = Number.isFinite(b.beatZoom) ? Math.max(0, Math.min(Number(b.beatZoom), 0.08)) : 0;
          const beatZoom = (wantZoom > 0 && conf >= 0.40 && bpm > 0) ? wantZoom : 0;
          /* The FULL analysis, from its cache — doc.beats keeps only four
           * fields and the pulse needs the bass envelope, which beats.py has
           * been publishing all along. */
          const beatsFile = beatZoom
            ? path.join(deps.outputDir(), ".beats", `${doc.song?.file}.json`) : null;
          const out = await deps.renderTimeline(doc.timelineProject, {
            fade: Number.isFinite(b.fade) ? Math.max(0, Math.min(Number(b.fade), 2)) : 0,
            beatZoom, beatsFile,
          });
          if (wantZoom > 0 && !beatZoom) {
            out.beatZoomSkipped = `beat confidence ${conf.toFixed(3)} is below 0.40 — pulsing on a grid this weak reads as an encode fault`;
          }
          await updateProject(safe(b.slug), (d) => {
            noteRun(d, { tool: "render_video", outcome: `${out.name} — ${out.clips} clips, ${out.total}s at ${out.fps}fps` });
            return d;
          });
          return json(res, 200, { ok: true, ...out }), true;
        }

        case "read_timeline": {
          /* The other half of build_timeline. Reads the SAVED Studio document
           * back and diffs it against the cut the workflow would compose now,
           * so the agent that handed over a rough cut can still say what
           * happened to it. Read-only — it never writes the workflow doc. */
          const out = await readTimeline(safe(b.slug), { project: b.project });
          return json(res, 200, { ok: true, ...out }), true;
        }

        case "regen_stale": {
          /* DRY BY DEFAULT: only an explicit dryRun === false spends GPU. The
           * body arrives from an agent as often as from the tab, and "it
           * rendered twelve clips because I left a field out" is not a mistake
           * this route is allowed to make. */
          const out = await regenStale(deps, safe(b.slug), {
            dryRun: b.dryRun !== false,
            limit: Number.isFinite(b.limit) ? Number(b.limit) : undefined,
            segmentIds: Array.isArray(b.segmentIds) ? b.segmentIds : undefined,
          });
          return json(res, 200, { ok: true, ...out }), true;
        }

        case "crime_board": {
          const doc = await readProject(safe(b.slug));
          if (!doc) throw new Error("No such project.");
          return json(res, 200, { ok: true, ...(doc.kind === "audiobook" ? abBoard(doc) : crimeBoard(doc)) }), true;
        }

        /* ─────────── blocked shots: previz, reference frame, words ───────────
         *
         * Two actions, and the split is the honest one: planning a shot costs
         * NOTHING and needs no Blender, while blocking one spends a subprocess
         * and a minute. Folding them together would make the free half look
         * expensive and would make a machine with no Blender look like a
         * machine with no shot vocabulary. */

        case "previz_plan": {
          /* WORDS ONLY. No render, no Blender, no project write — this is a
           * pure function of the move name and the framing, exposed as a route
           * so both surfaces read the same sentences. It is the only part of
           * the previz path that is claimed to reach the model at all. */
          /* `shotAction`, not `action` — the dispatch key owns that name on this
           * route, and a shot's own action sentence would land on top of it. */
          const plan = shotPlan(String(b.move || "push_in"), {
            framing: b.framing, subject: b.subject, third: b.third, angle: b.angle,
            pronoun: b.pronoun, side: b.side, action: b.shotAction,
            lensFeel: b.lensFeel, lighting: b.lighting, degrees: b.degrees, base: b.base,
            /* THE SAME KEYWORDS THE RENDER TAKES, on the half that costs
             * nothing. previz_shot could steer the camera with these long
             * before shotPlan was handed them, so this free route answered the
             * DEFAULT move's sentences for a shot that would be rendered
             * steered — and this is the one place a caller could have read the
             * difference before paying for it. Not validated here: this route
             * spends nothing, and previz_shot refuses a bad key on the paid
             * path before Blender is launched. */
            moveArgs: b.moveArgs,
          });
          return json(res, 200, { ok: true, plan }), true;
        }

        case "previz_shot": {
          /* ONE ACTION, TWO KINDS OF CLIP, and not two actions. A previz and a
           * blockout are the same Blender launch with the same arguments and
           * one flag between them; splitting them would put two names in the
           * parity census for one capability and let the second drift behind
           * the first. `blockout` is the flag and `spec` is the staging — the
           * pair is what makes a shot's grey boxes reproducible. */
          const out = await previzShot(safe(b.slug), {
            segmentId: b.segmentId, move: b.move, scene: b.scene, frames: b.frames,
            lens: b.lens, framing: b.framing, subject: b.subject, third: b.third,
            angle: b.angle, pronoun: b.pronoun, action: b.shotAction,
            lensFeel: b.lensFeel, lighting: b.lighting,
            render: b.render, reference: b.reference, u: b.u,
            /* `moveArgs` is the move's OWN keyword arguments — how far an orbit
             * sweeps, what a crane aims at, which band a push-in has to hold.
             * It rides the same action as everything else here for the reason
             * stated above: a blockout and a previz are one Blender launch, and
             * a second action for "the same launch with the camera argued"
             * would put two names in the parity census for one capability. */
            blockout: b.blockout, spec: b.spec, moveArgs: b.moveArgs,
          });
          return json(res, 200, { ok: true, ...out }), true;
        }

        /* ─────────── structural control: a real clip steers the render ──────
         *
         * The opposite of the case above and the pair has to be read together.
         * A previz is grey boxes marked HUMAN-REVIEW and handing one to a model
         * gives the grey boxes back — measured, on LTX's appearance guides. This
         * hands a REAL clip to WAN 2.1 VACE's `control_video`, which is a
         * different mechanism (a scaled additive residual, not pixels written
         * into the latent) and a measured positive: arm W1, CMA 0.924, and still
         * generating rather than reconstructing.
         *
         * ⚠ ONE ACTION, THREE MODES, and not three actions. camera / pose /
         * extract are the same staging, the same gate, the same door and the
         * same record; splitting them would put three names in the parity census
         * for one capability and let two of them drift. mv_control_render and
         * mv_pose_extract are two TOOLS over this one action, because an agent
         * choosing between them is choosing between two very different costs.
         *
         * Everything expensive happens inside controlRender, and the first thing
         * it does is measure the clip and refuse by name and number. */
        case "control_render": {
          /* `lineage`: what a library clip was made from, for the minors rule
           * (server/safety/lineage.js). Optional: a harness without it checks
           * the prompt and the reference only. */
          const out = await controlRender({ CLIP_DIR: deps.CLIP_DIR, lineage: deps.lineage }, safe(b.slug), {
            /* `source` is which DOOR the frames come through — the shared clips
             * library, or this shot's own blockout out of the project's assets.
             * One gate behind both: whichever door it came through, the clip is
             * measured with ffprobe and refused by number before a byte is
             * staged. See CONTROL_SOURCES in server/mv/control.js for why the
             * blockout is resolved here rather than shelved in the library. */
            segmentId: b.segmentId, source: b.source, clip: b.clip, reference: b.reference,
            mode: b.mode, prompt: b.prompt, negative: b.negative,
            seed: b.seed, strength: b.strength,
            /* Which Depth Anything V2 the depth modes read with — judged by
             * name in controlRender, before anything is staged. */
            model: b.model,
            /* conform only: which second the 121-frame window starts at. */
            start: b.start,
            /* ⚠ THE CALLER'S OWN ACTOR, never a made-up one. A browser is
             * recognised by its Origin and an MCP client by its header; the door
             * refuses a request it cannot attribute, and filing half an hour of
             * GPU under a name that means "the app did this on its own" is not a
             * smaller lie than no record at all. */
            actor,
          });
          return json(res, 200, { ok: true, ...out }), true;
        }

        /* ─────────── audiobook actions ─────────── */

        case "ab_ingest": {
          const doc = await ingestBook(safe(b.slug), String(b.path || ""));
          return json(res, 200, { ok: true, book: doc.book, stage: stageOfDoc(doc) }), true;
        }

        case "ab_plan": {
          const slug = safe(b.slug);
          if (b.settings) {
            await updateProject(slug, (doc) => {
              for (const k of ["targetMinMinutes", "targetMaxMinutes", "wpm", "bed", "sfx", "bedGainDb", "duckDb"]) {
                if (b.settings[k] !== undefined) doc.settings[k] = b.settings[k];
              }
              return doc;
            });
          }
          const doc = await planBundles(slug);
          return json(res, 200, { ok: true, bundles: doc.bundles, stage: stageOfDoc(doc) }), true;
        }

        case "ab_set_voice": {
          const doc = await updateProject(safe(b.slug), (doc) => {
            /* One voice per book, set once. Changing it after narration exists
             * is a decision, not a slip — it invalidates every narrated
             * bundle, and the route says so instead of quietly diverging. */
            const narrated = doc.bundles.filter((x) => x.narration?.length);
            if (narrated.length && doc.voice &&
                (doc.voice.model !== b.model || doc.voice.persona !== b.persona)) {
              for (const x of narrated) { x.status = "stale-voice"; }
            }
            doc.voice = { model: String(b.model || "kokoro"), persona: String(b.persona || "") };
            noteRun(doc, { tool: "ab_set_voice", outcome: `${doc.voice.model}/${doc.voice.persona}` });
            return doc;
          });
          return json(res, 200, { ok: true, voice: doc.voice }), true;
        }

        case "ab_toggle_chapter": {
          const doc = await updateProject(safe(b.slug), (doc) => {
            const ch = doc.book?.chapters.find((c) => c.idx === Number(b.idx));
            if (!ch) throw new Error("No such chapter.");
            ch.skip = !ch.skip;
            return doc;
          });
          return json(res, 200, { ok: true, chapters: doc.book.chapters }), true;
        }

        case "ab_narrate": {
          const doc = await narrateBundle(deps, safe(b.slug), b.bundle, { waitForIdle: deps.waitForIdle });
          const row = doc.bundles.find((x) => x.idx === Number(b.bundle));
          return json(res, 200, { ok: true, bundle: row, stage: stageOfDoc(doc) }), true;
        }

        case "ab_bed": {
          const doc = await makeBed(deps, safe(b.slug), { mood: b.mood, seed: b.seed });
          return json(res, 200, { ok: true, beds: doc.beds }), true;
        }

        case "bible_spec": {
          const doc = await readProject(safe(b.slug));
          if (!doc) return json(res, 404, { error: "no such project" }), true;
          return json(res, 200, { ok: true, spec: bibleSpec(doc) }), true;
        }

        case "set_bible": {
          const doc = await commitBible(safe(b.slug), b.bible);
          return json(res, 200, { ok: true, project: doc, lint: lintProject(doc) }), true;
        }

        case "set_board": {
          const doc = await upsertBoard(safe(b.slug), b.segmentId, b.board || {});
          return json(res, 200, { ok: true, board: doc.boards.find((x) => x.segmentId === b.segmentId || x.segmentIndex === b.board?.segmentIndex) }), true;
        }

        case "lint": {
          const doc = await readProject(safe(b.slug));
          if (!doc) return json(res, 404, { error: "no such project" }), true;
          return json(res, 200, { ok: true, issues: lintProject(doc) }), true;
        }

        case "update_asset": {
          /* EDIT A DECLARED ROW — the description, the sheet prompt, the role,
           * and THE NAME, which is the one that is not a field edit at all.
           *
           * ⚠ THE NAME IS THE BINDING KEY. add_asset refuses a duplicate for
           * that exact reason, and this route used to change the same key with
           * `row.name = b.name.trim()` and repoint nothing. Measured on the
           * felt-hammers sequence: renaming a prop that two boards carried took
           * the project from 1 continuity break to 4 breaks and 2 errors, both
           * boards pointing at a name the bible no longer declared, and the
           * render would have dropped it in silence. The map caught it after
           * the fact; nothing stopped it.
           *
           * So a rename now has exactly two outcomes and no third:
           *   cascade:true  — the row AND every reference move together, in one
           *                   transaction, and the response says what moved.
           *   otherwise     — REFUSED with the list of scenes that would break,
           *                   because a rename you did not know was a graph
           *                   edit is the thing that cost the evening. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const kind = assetKind(b.kind, ["characters", "backgrounds", "props"]);
          if (!kind) throw new Error("kind must be characters | backgrounds | props");
          let moved = null;
          const changed = [];
          const doc = await updateProject(slug, (d) => {
            const list = d[kind] = d[kind] || [];
            const row = list.find((x) => x.id === b.id || String(x.name).toLowerCase() === String(b.id ?? "").toLowerCase());
            if (!row) throw new Error(`No such ${ONE[kind]}: ${b.id}`);

            if (typeof b.description === "string") { row.description = b.description.trim(); changed.push("description"); }
            /* The explicit sheet/plate prompt the generator uses INSTEAD of the
             * description. Same field add_asset writes, same fallback: emptying
             * it returns the row to being rendered from its description. */
            if (typeof b.prompt === "string") {
              row[kind === "backgrounds" ? "platePrompt" : "sheetPrompt"] = b.prompt.trim() || null;
              changed.push("prompt");
            }
            if (b.role !== undefined) { row.role = readRole(b.role); changed.push("role"); }

            if (typeof b.name === "string" && b.name.trim() && b.name.trim() !== row.name) {
              const next = b.name.trim();
              const taken = [...d.characters, ...d.backgrounds, ...(d.props || [])]
                .find((x) => x !== row && String(x.name).toLowerCase() === next.toLowerCase());
              if (taken) {
                throw new Error(
                  `"${taken.name}" is already declared. Names bind references across the whole `
                  + `project, so they have to be unique — pick another name.`);
              }
              const found = assetReferences(d, row.name);
              if (found.total && b.cascade !== true) {
                const err = new Error(
                  `"${row.name}" is referenced in ${found.total} place${found.total === 1 ? "" : "s"}`
                  + `${found.scenes.length ? ` (scene${found.scenes.length === 1 ? "" : "s"} ${found.scenes.join(", ")})` : ""}`
                  + ` — the name is the key every one of them resolves through. Send cascade:true to `
                  + `rename it everywhere in one move, or leave the name alone.`);
                err.detail = { references: found };
                throw err;
              }
              moved = cascadeRename(d, row, next);
              changed.push(`renamed to "${next}"`);
            }
            if (!changed.length) throw new Error("Nothing to change — send name, description, prompt or role.");

            /* PROVENANCE CARRIES BOTH NAMES. A run line saying "prop edited"
             * over a row that now has a different name is unreadable a week
             * later — the old name is the only handle anybody searching the
             * boards, the takes or their own memory still has. */
            noteRun(d, { tool: "update_asset", outcome:
              `${ONE[kind]} ${moved ? `"${moved.from}" → "${moved.to}" (${moved.total} reference${moved.total === 1 ? "" : "s"} repointed`
                                      + `${moved.scenes.length ? `, scene${moved.scenes.length === 1 ? "" : "s"} ${moved.scenes.join(", ")}` : ""})`
                                    : `${row.name}: ${changed.join(", ")}`}` });
            return d;
          });
          return json(res, 200, {
            ok: true, project: doc, changed,
            /* What the cascade actually touched, and — separately — the prose
             * it deliberately did not. Silence about the synopsis would be the
             * same silence this route was fixed for. */
            renamed: moved,
          }), true;
        }

        case "ab_set_cast": {
          const doc = await setCast(safe(b.slug), b.cast);
          return json(res, 200, { ok: true, cast: doc.cast }), true;
        }

        case "ab_audition": {
          const r = await auditionVoices(safe(b.slug), { personas: b.personas, text: b.text });
          return json(res, 200, { ok: true, ...r }), true;
        }

        /* SFX in three moves: scan proposes (lexicon), set overrides (a human
         * or the driving agent), render spends GPU on what survived. */
        case "ab_sfx": {
          const slug = safe(b.slug);
          if (b.mode === "scan") {
            const cues = await scanCues(slug, b.bundle);
            return json(res, 200, { ok: true, cues }), true;
          }
          if (b.mode === "set") {
            const doc = await setCues(slug, b.bundle, b.cues);
            return json(res, 200, { ok: true, bundle: doc.bundles.find((x) => x.idx === Number(b.bundle)) }), true;
          }
          if (b.mode === "judge") {
            const cues = await judgeCues(deps, slug, b.bundle);
            return json(res, 200, { ok: true, cues }), true;
          }
          if (b.mode === "render") {
            const rendered = await renderCues(deps, slug, b.bundle, { only: b.only, seed: b.seed });
            return json(res, 200, { ok: true, sfx: rendered }), true;
          }
          if (b.mode === "clear") {
            await clearCues(slug, b.bundle);
            return json(res, 200, { ok: true }), true;
          }
          return json(res, 400, { error: "ab_sfx mode must be scan | judge | set | render | clear" }), true;
        }

        case "ab_use_bed": {
          const doc = await updateProject(safe(b.slug), (doc) => {
            const row = doc.bundles.find((x) => x.idx === Number(b.bundle));
            if (!row) throw new Error("No such bundle.");
            if (b.bedId && !doc.beds.some((x) => x.id === b.bedId)) throw new Error("No such bed.");
            row.bedId = b.bedId || null;
            return doc;
          });
          return json(res, 200, { ok: true, bundles: doc.bundles }), true;
        }

        case "ab_mix": {
          const doc = await mixBundle(deps, safe(b.slug), b.bundle);
          const row = doc.bundles.find((x) => x.idx === Number(b.bundle));
          return json(res, 200, { ok: true, bundle: row, stage: stageOfDoc(doc) }), true;
        }

        /* ══════════════════ THE PLAN OBJECT ══════════════════════════════════
         *
         * "people value high quality more then speed but it still needs to be
         *  asking you directive choices when you do run through MCP and we
         *  should have it able to setup things for you and you can go through
         *  it approve it change things and then start."
         *
         * Seven cases, and NOT ONE OF THEM SPENDS A GPU except plan_run. That
         * separation is the whole object: proposing is free, reading is free,
         * approving is free, and the expensive verb is the one a person presses
         * on purpose after reading the other six.
         *
         * Nothing derivable is stored. Every reply runs planView, which asks
         * resolveShot for the engine, renderSize plus videoSizeFor for the
         * size, crimeBoard for the breaks and the runs list for the minutes —
         * the renderer's own functions, so the card and the render cannot
         * disagree because there is only one of each. */

        case "plan_propose": {
          /* SET UP A RUN AND HAND IT OVER. Refused if a plan is already open —
           * batch.js:152 pressed Start twice and silently discarded the
           * in-flight object, and an approval is not a thing to throw away
           * quietly. `from` seeds the items out of the scanners that already
           * exist, so a seeded plan and mv_regen_stale cannot describe two
           * different sets of scenes. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const by = actorOf(req);
          const legal = plannable();
          let made = null;
          const doc = await updateProject(slug, (d) => {
            const given = Array.isArray(b.items) ? b.items : null;
            const raw = given && given.length
              ? given
              : (b.from ? seedItems(d, String(b.from)) : (given || []));
            const fresh = makePlan(
              { title: b.title, intent: b.intent, createdBy: by, items: raw },
              { tools: legal });
            addPlan(d, fresh);
            made = fresh.id;
            noteRun(d, {
              tool: "plan_propose",
              outcome: `${fresh.items.length} items proposed — nothing is approved yet`,
            });
            return d;
          });
          return planReply(res, slug, doc, made);
        }

        case "plan_read": {
          /* The plan with FRESH estimates. Nothing here is stored, which is why
           * it cannot disagree with what the renderer does. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const doc = await planDoc(slug, b.planId);
          return planReply(res, slug, doc, b.planId);
        }

        case "plan_item": {
          /* CHANGE IT BEFORE IT RUNS.
           *
           * ⚠ An edit to an approved item drops it back to `edited`, loudly, in
           * `changed`. Approval is of a SPECIFIC SET OF ARGUMENTS; carrying it
           * across a change would make approval mean nothing, which is the
           * laundering this object exists to prevent. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const by = actorOf(req);
          const legal = plannable();
          let changed = [];
          const doc = await updateProject(slug, (d) => {
            const cur = findPlan(d, b.planId);
            if (!cur) throw noPlan(b.planId);
            changed = applyItemOp(cur, {
              op: String(b.op ?? "edit"),
              itemId: b.itemId,
              tool: b.tool,
              args: b.args,
              why: b.why,
              at: b.at,
            }, { tools: legal, by }).changed;
            return d;
          });
          const after = await applyDelegation(slug, doc, b.planId);
          return planReply(res, slug, after.doc, b.planId,
                           { changed: [...changed, ...after.changed] });
        }

        case "plan_decide": {
          /* APPROVE, SKIP, OR PUT BACK — per item, because partial approval is
           * the normal case: approve the eight you are sure of, skip the four
           * you are not.
           *
           * The refusal that earns its place: an item whose scene names a
           * reference with no rendered sheet is about to spend up to
           * twenty-eight minutes rendering a scene where a named prop reaches
           * the model as NOTHING. It can still be approved — sometimes you mean
           * it — but only with the acknowledgement, and the rejection names the
           * references. A speed bump with the reason attached, not a wall. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const by = actorOf(req);
          const status = String(b.status ?? "approved");
          let out = { changed: [], rejected: [] };
          let planId = null, landed = [];
          const doc = await updateProject(slug, (d) => {
            const cur = findPlan(d, b.planId);
            if (!cur) throw noPlan(b.planId);
            /* The same lazy heal planDoc applies on a read: a plan left at
             * `running` by a process that died is paused, and its running item
             * approved again, before decideItems can refuse it as running.
             * Found on a real run — the server restarted under a plan, and the
             * approve of the item whose render died came back "This plan is
             * running. Pause it first" from a runner that no longer existed. */
            if (cur.state === "running" && !isRunning(slug)) healPlan(cur, { live: false });
            planId = cur.id;
            out = decideItems(d, cur,
              { items: b.items, status, acknowledge: b.acknowledge === true });
            /* WHAT THE LEDGER RECORDS IS WHAT ENDED UP DECIDED, not what moved:
             * an item already approved and named again in an "all" is still
             * authorised by this call, and planrun's approvedBy has to be able
             * to find the event that says so. */
            const all = b.items === "all" || b.items === undefined || b.items === null;
            const want = all
              ? (cur.items || []).map((i) => i.id)
              : (Array.isArray(b.items) ? b.items.map(String) : [String(b.items)]);
            landed = (cur.items || [])
              .filter((i) => want.includes(i.id) && i.status === status).map((i) => i.id);
            return d;
          });
          /* ⚠ THE ACTOR IS THE ONE THAT ARRIVED, never a guess. A browser sends
           * no header and records as `user`; an agent records as itself. There
           * is no argument that makes an agent's decision look like a human's,
           * and this route does not invent one.
           *
           * No decideMs: nothing on either surface measures how long the person
           * looked, and a field neither surface fills is a knob nobody can turn
           * dressed up as evidence. */
          if (out.changed.length || landed.length) {
            await planEvent(slug, {
              actor: by,
              type: "choice",
              data: {
                surface: "plan", planId, items: landed, status,
                rejected: out.rejected.map((r) => r.id),
                acknowledge: b.acknowledge === true,
                reasoning: b.reasoning ?? null,
                freeText: b.freeText ?? null,
              },
            });
          }
          return planReply(res, slug, doc, planId,
                           { changed: out.changed, rejected: out.rejected });
        }

        case "plan_policy": {
          /* THE FAILURE POLICY, AND THE DELEGATION.
           *
           * halt is the default and it is the owner's stated decision: on a
           * failure the remaining approved items STAY approved and the run
           * stops. Somebody presses Run again — approve-then-start holds on
           * every resumption, not only the first.
           *
           * A threshold that approves on a human's behalf is a DELEGATION, so
           * it needs their brief in their own words, and the `delegate` event
           * is written BEFORE the policy that acts under it — an authority the
           * ledger cannot name is not an authority. With no brief, setPolicy
           * refuses and no event was written. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const by = actorOf(req);
          const doc0 = await readSerialised(slug);
          const cur0 = doc0 && findPlan(doc0, b.planId);
          if (!cur0) throw noPlan(b.planId);
          const wants = b.autoApproveUnderMinutes !== undefined
            && b.autoApproveUnderMinutes !== null;
          const brief = String(b.delegateBrief ?? "").trim();
          let delegateEventId = null;
          if (wants && brief) {
            /* An MCP-relayed delegation records the AGENT with relayed:true,
             * never the human — recording it as a direct human act would be the
             * fabrication the ledger exists to refuse. The human's words still
             * travel verbatim, which is the part that has weight. */
            const ev = await planEvent(slug, {
              actor: by,
              type: "delegate",
              data: {
                surface: "plan", planId: cur0.id, brief,
                underMinutes: Number(b.autoApproveUnderMinutes),
                ...(by === "user" ? {} : { relayed: true }),
              },
            });
            delegateEventId = ev?.id ?? null;
          }
          let changed = [];
          const doc = await updateProject(slug, (d) => {
            changed = setPolicy(findPlan(d, cur0.id), {
              onFailure: b.onFailure,
              autoApproveUnderMinutes: b.autoApproveUnderMinutes,
              delegateBrief: b.delegateBrief,
              delegateEventId,
            }).changed;
            return d;
          });
          const after = await applyDelegation(slug, doc, cur0.id);
          return planReply(res, slug, after.doc, cur0.id,
                           { changed: [...changed, ...after.changed] });
        }

        case "plan_run": {
          /* START — the one verb here that spends anything, and it returns
           * IMMEDIATELY. The runner walks the approved items in array order
           * behind this call; poll plan_read or the GET.
           *
           * pause lets the render in flight finish, exactly as batch.js does:
           * killing a nearly-complete H3 clip throws away twenty minutes for
           * nothing. stop cancels the PLAN and this project's clip in flight
           * (stopClipsOf), and its note says what was really reached: a clip
           * that could not be, or a picture item, is said to finish. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          const op = String(b.op ?? "start");
          if (!RUN_OPS.has(op)) {
            throw new Error(`op must be one of ${[...RUN_OPS].join(", ")} — not "${op}".`);
          }
          const doc0 = await planDoc(slug, b.planId);
          const cur0 = findPlan(doc0, b.planId);
          if (!cur0) throw noPlan(b.planId);
          let note = null;
          if (op === "start" || op === "resume") {
            const r = await planRunner.start(slug, cur0.id, { resume: op === "resume" });
            /* The walk swallows its own failures into the plan's note; this
             * catch exists only so a throw out of the store can never surface
             * as an unhandled rejection that takes the process with it. */
            r.done?.catch?.((err) =>
              console.error(`  [plan] ${slug}/${cur0.id} ended badly: ${err?.message || err}`));
            /* ⚠ NO ACTIVITY-FEED LINE HERE, AND THE REASON IS MEASURED. A note
             * written after start() lands while the runner is already walking:
             * its first act is to call the item's tool over the loopback, and
             * that route reads project.json — so on Windows the rename behind
             * this write hits the open read handle and throws EPERM, which the
             * runner catches as "the runner stopped" and pauses a run that had
             * nothing wrong with it. Reproduced on the live sequence: a start
             * note, then a plan paused two milliseconds later for no reason.
             * The run IS recorded — plan.note says started/resumed while it
             * walks, the runner writes one plan_run line when it finishes and
             * one plan_step line per failure, which is §5.2's budget anyway. */
            note = `${r.approved} approved item${r.approved === 1 ? "" : "s"}. This returned `
              + "immediately — poll mv_plan_read to watch it.";
          } else if (op === "pause") {
            await planRunner.pause(slug, cur0.id);
            note = "Pausing. The render in flight finishes first, then the run stops; "
              + "the rest stay approved and resume carries on from there.";
          } else {
            /* STOP MEANS NOW, and in flight is three queues. The plan is
             * marked stopped FIRST, so the runner cannot start its next item
             * when the clip it is waiting on fails; then this project's clip
             * is taken out of the app's queue and, if it is rendering,
             * cancelled on the engine by its run id. Pause is the one that
             * lets a render finish. */
            const walking = isRunning(slug);
            /* The item in flight, so the sentence can say a picture or a
             * Blender pass finishes (only clips can be cancelled from here). */
            const itemId = runState(slug)?.itemId;
            const tool = itemId ? (cur0.items || []).find((i) => i.id === itemId)?.tool ?? null : null;
            const r = await planRunner.stop(slug, cur0.id, walking ? {
              note: "Stopping: everything still approved is skipped, and this project's clip is being "
                + "taken off the queue and the graphics card.",
            } : {});
            const c = walking ? await stopClipsOf(slug, doc0) : null;
            const said = stopWords(c, tool);
            /* WRITTEN AFTER, FROM WHAT HAPPENED: the note above is only ever
             * seen for the few seconds stopClipsOf takes. */
            if (walking) {
              await planRunner.note(slug, cur0.id, `Stopped. Everything still approved is skipped. ${said}`)
                .catch(() => {});
            }
            note = `Stopped — ${r.skipped.length} item${r.skipped.length === 1 ? "" : "s"} skipped.`
              + (said ? ` ${said}` : "");
          }
          /* Serialised, because the runner is ALREADY WALKING behind the start
           * above and a raw read here lands on top of its first write. */
          const doc = await readSerialised(slug);
          return planReply(res, slug, doc, cur0.id, { op, note });
        }

        case "plan_discard": {
          /* Throw it away. Refused while it is running — discarding under the
           * runner leaves a GPU job walking a plan that no longer exists, which
           * is the one way to get a render nobody can see. */
          const slug = safe(b.slug);
          if (!slug) throw new Error("bad slug");
          let out = null;
          const doc = await updateProject(slug, (d) => {
            /* The same plan a READ means — a run that has just finished is
             * still the plan the caller is looking at, and "throw it away"
             * should not need an id they were never shown. */
            const target = planForRead(d, b.planId);
            out = discardPlan(d, target?.id ?? b.planId, { live: isRunning(slug) });
            noteRun(d, {
              tool: "plan_discard",
              outcome: `"${out.title}" discarded — ${out.items} items thrown away`,
            });
            return d;
          });
          return json(res, 200, { ok: true, ...out, plans: planIndex(doc) }), true;
        }

        default:
          return json(res, 400, { error: `Unknown action: ${action}` }), true;
      }
    } catch (err) {
      /* ⚠ AND NOTHING IS CHARGED. A request that threw was refused before the
       * GPU or died on the way to it; billing the budget for it would teach an
       * agent that a validation error costs the same as a render. */
      threw = true;
      /* A REFUSAL THAT CAN BE ACTED ON. Most errors here are one sentence and
       * that is enough; a refused rename is not — the caller needs the list of
       * scenes it would have broken to decide whether to cascade. `detail` is
       * that list, carried on the Error so the refusal stays inside the same
       * transaction that computed it. Absent everywhere else, so no response
       * shape changes for any route that does not set it. */
      const out = { error: String(err.message || err) };
      if (err && typeof err.detail === "object" && err.detail) Object.assign(out, err.detail);
      /* The minors rule answers 422 with its code at every door, this one too:
       * a board, a sheet, a clip or a control render it refused. */
      if (err?.safety) return json(res, 422, { ...out, code: err.code, ...(err.hint ? { hint: err.hint } : {}), ...(err.found ? { found: err.found } : {}) }), true;
      return json(res, 400, out), true;
    } finally {
      /* The response is already composed by the time this runs, on both paths —
       * which is exactly what makes "charge only what really ran" one line
       * rather than an edit to every spending case. */
      if (priced && !threw) await chargeSpend(actor, priced);
    }
  }

  return { handle, analyze, segment, pauseRunningPlans };
}
