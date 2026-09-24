/**
 * Video lab — HTTP. One action-dispatched POST on /api/videolab, plus a GET
 * that hands back the whole document.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * ONE ROUTE BEHIND BOTH HANDS. web/videolab.js posts these actions;
 * server/mcp-videolab.js posts the SAME actions through the same transport the
 * rest of the MCP layer uses. There is no second write path and no UI-only
 * field — server/videolab/ui_test.js fails the commit if one appears, in both
 * directions: a gesture the server does not dispatch, and an action no human
 * can reach.
 *
 * ── WHY COMPARE CALLS /api/video OVER LOOPBACK ────────────────────────────
 * A comparison is N ordinary renders. Every one of them needs the staging the
 * create route already does — covers copied into ComfyUI's input directory,
 * uploaded frames validated against names this server itself minted, reference
 * audio trimmed out of the library, the engine-specific refusals. Rebuilding
 * any of that here would be a second implementation of the most security-
 * sensitive path in the app, and it would drift. So an arm is literally the
 * same POST the Render button makes, made N times with one field changed —
 * which is also the honest definition of the experiment.
 *
 * ⚠ THE ENGINE IS A PERSISTED GLOBAL, so an arm has to switch it and put it
 * back. That is safe for exactly one reason, and it is worth knowing before
 * anyone "simplifies" this: art.js copies `config.video.engine` onto the JOB at
 * request time, and its own comment says why — "carried on the job so a queued
 * clip keeps the engine it was made with, even if the setting changes while it
 * waits for the GPU". Arms are still run STRICTLY ONE AT A TIME and awaited,
 * because a comparison that interleaved would also be measuring the model
 * loading and unloading between them, and the wall time is half the answer.
 *
 * The other half of that: switching engines reloads ~20 GB of weights, so an
 * arm order that alternates engines pays for it twice. Arms are sorted by
 * engine before they run, and the group records the order it used.
 */
import { config } from "../config.js";
import { h3SigmaShiftFor } from "../workflow.js";
import {
  COMPARE_CONFIGS, KNOBS, SIZE_RULES, DOCS, STILL_FRAMES,
  expandConfig, knobRows, setKnob, sizesFor, commitSigma, commitNote, resolveHybrid,
} from "./catalog.js";
import { listGroups, getGroup, remember, save, load } from "./store.js";
import { groupStills } from "./stills.js";

/** Where this server answers itself. Same default the MCP layer uses. */
const BASE = () => `http://127.0.0.1:${config.uiPort}`;

const post = async (path_, body) => {
  const r = await fetch(`${BASE()}${path_}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
};

/**
 * The whole document, in the shape both surfaces render.
 *
 * Built fresh on every read rather than cached: a knob write changes `config`,
 * and a cached copy of this is precisely how an agent and a page end up
 * disagreeing about what the machine is set to.
 */
/**
 * @param {string}  [engineKey]  whose settings and sizes; defaults to the selected engine
 * @param {object}  [refs]       the references the CALLER has attached, so the hybrid arm
 *                               can report the engine it would really route to. Without
 *                               them the badge reads "-> ltx" on a shot that would go to
 *                               H3, which is the exact misreport that cost an evening.
 */
export function labState(engineKey, refs = {}) {
  const engine = engineKey || config.video.engine;
  const eng = config.video.engines[engine] || {};
  const steps = eng.steps ?? null;
  const turbo = steps != null && steps <= (eng.turboMaxSteps ?? 12);
  /* The shift the GRAPH will run — panel value, else the loaded LoRA's trained
   * shift (config turboShiftByLora), else the base — from the one reader the
   * graph itself uses, so the lab never again reports a 12 the render did not
   * send. The references decide the LoRA (ref2v or fl2v), and so the row. */
  const shift = h3SigmaShiftFor(eng, { steps,
    refs: (refs?.refImages?.length || 0) + (refs?.refAudios?.length || 0) > 0 }).video;
  return {
    engine,
    engines: Object.keys(config.video.engines),
    enabled: config.video.enabled,
    docs: DOCS,
    quality: {
      width: eng.width ?? null, height: eng.height ?? null,
      steps, seconds: eng.seconds ?? null, fps: eng.fps ?? null,
      sizes: sizesFor(engine),
      rules: SIZE_RULES,
    },
    /* WHERE THIS SETTING COMMITS. The one number that explains the turbo path,
     * computed for what is selected right now rather than quoted from a table
     * that only ever covered four step counts. */
    commit: engine === "ltx" ? null : {
      steps, shift, turbo,
      sigma: commitSigma(steps, shift),
      note: commitNote(steps, shift),
      cite: DOCS.bleed,
    },
    /* WHICH FRAMES THE STILL STRIP TAKES, as data. The page has no number of
     * its own for this — the same rule that keeps resolutions out of it — so
     * both hands ask for the identical default and a re-measure moves one row
     * in catalog.js. */
    stills: {
      defaultFrames: STILL_FRAMES.default,
      max: STILL_FRAMES.max,
      why: STILL_FRAMES.why,
      cite: STILL_FRAMES.cite,
    },
    knobs: knobRows(engine),
    // Every knob, not only this engine's — an agent switching engines should be
    // able to read what it is switching to without a second call.
    allKnobs: knobRows(null),
    /* Each arm as it would actually run, given what is attached right now:
     * engine-native size unless pinned, and hybrid already resolved. Shown
     * before anything is spent, which is the whole lesson of the evening
     * hybrid spent silently meaning "everything on the expensive engine". */
    configs: COMPARE_CONFIGS.map((c) => expandConfig(c, {
      refImages: refs.refImages, refAudios: refs.refAudios,
    })),
    groups: listGroups(12),
  };
}

export function createVideoLabRoutes(deps) {
  const { json, readBody, art, rememberClip, sameOriginLocalJson } = deps;

  /* One arm's render, awaited by IDENTITY rather than by polling a directory.
   *
   * The create route mints `clip:<id>` as the job's pseudo-file and returns the
   * id, and ArtRunner emits `clip` / `failed` carrying that exact file. So this
   * waits for THIS render and cannot be confused by another one finishing in
   * between — which a before/after listing diff genuinely can be, and this
   * surface exists to run several renders back to back. */
  function awaitClip(fileId, timeoutMs) {
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        art.off("clip", onClip);
        art.off("failed", onFail);
        resolve(v);
      };
      const onClip = (e) => { if (e.file === fileId) done({ clip: e.clip, seconds: e.seconds, meta: e.meta }); };
      const onFail = (e) => { if (e.file === fileId) done({ error: e.error || "the render failed" }); };
      const timer = setTimeout(() => done({ error: "timed out waiting for the render" }), timeoutMs);
      art.on("clip", onClip);
      art.on("failed", onFail);
    });
  }

  /**
   * Run a comparison. Sequential, awaited, and it records a failed arm.
   *
   * `onProgress` is called after every arm so the page can fill the group in as
   * it goes rather than showing nothing for twenty minutes — the render times
   * involved make a silent surface indistinguishable from a hung one.
   */
  async function runCompare(body, onProgress = () => {}) {
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("Describe the clip first — a comparison needs one prompt for every arm.");

    const wanted = Array.isArray(body.configs) && body.configs.length
      ? body.configs : COMPARE_CONFIGS.map((c) => c.id);
    const chosen = wanted
      .map((id) => COMPARE_CONFIGS.find((c) => c.id === id))
      .filter(Boolean);
    if (!chosen.length) {
      throw new Error(`No known configurations named. Available: ${COMPARE_CONFIGS.map((c) => c.id).join(", ")}.`);
    }

    /* ONE seed for every arm, and it is recorded. A comparison on different
     * seeds is not a comparison — docs/RESOLUTION_FOR_FACES.md measured the
     * seed-to-seed spread and found it larger than several of the effects
     * people were trying to read, and a shift finding has already been
     * retracted for exactly this. Rolled here rather than per-arm so the number
     * is written down even when the caller did not choose one. */
    const seed = Number.isFinite(body.seed) ? Number(body.seed) : Math.floor(Math.random() * 4294967296);

    const refImages = Array.isArray(body.refImages) ? body.refImages : [];
    const refAudios = Array.isArray(body.refAudios) ? body.refAudios : [];
    const arms = chosen.map((c) => expandConfig(c, {
      width: body.width, height: body.height, refImages, refAudios,
    }));

    /* Engine-major order: switching reloads ~20 GB, so alternating engines pays
     * that toll once per arm instead of once per engine. Stable within an
     * engine, so the arms of one model still run in the order they were asked
     * for and the group reads the way the person wrote it. */
    arms.sort((a, b) => (a.engine === b.engine ? 0 : a.engine === config.video.engine ? -1 : b.engine === config.video.engine ? 1 : a.engine < b.engine ? -1 : 1));

    const group = {
      id: `cmp${Date.now().toString(36)}`,
      at: Date.now(),
      prompt, seed,
      seconds: Number.isFinite(body.seconds) ? Number(body.seconds) : null,
      refImages, refAudios,
      firstFrame: body.fromCover || body.fromUpload || null,
      running: true,
      arms: arms.map((a) => ({ ...a, status: "waiting", clip: null, wallSeconds: null, error: null })),
    };
    remember(group);
    onProgress(group);

    const restoreEngine = config.video.engine;
    try {
      for (const arm of group.arms) {
        /* TWO ARMS THAT RESOLVE TO THE SAME RENDER ARE ONE RENDER.
         *
         * Found on the first real run of this surface: `hybrid` with no
         * references resolves to LTX, which made it byte-identical to the LTX
         * arm — same prompt, same seed, same size, same schedule. ComfyUI saw
         * an identical graph, served it from cache in a fraction of a second,
         * and handed back the output entry for a file the LTX arm had already
         * renamed into the clip folder. The arm died on ENOENT.
         *
         * Forcing a re-render would be the wrong fix twice over: it would spend
         * a GPU slot proving two identical configurations produce the same
         * clip, and it would have to change something to do it, which means the
         * two arms would no longer be comparable. They are the same render, so
         * the honest answer is to say so and share the clip.
         *
         * This is also the useful ANSWER for a person: "hybrid is the LTX arm
         * here" is precisely what they wanted to know, and it is now visible
         * without paying for it. */
        const twin = group.arms.find((a) => a !== arm && a.status === "done"
          && a.engine === arm.engine && a.steps === arm.steps
          && a.width === arm.width && a.height === arm.height);
        if (twin) {
          arm.status = "done";
          arm.clip = twin.clip;
          arm.wallSeconds = twin.wallSeconds;
          arm.sharedWith = twin.id;
          arm.note = `Identical to the "${twin.label}" arm — same engine, size and schedule, so `
            + `it is the same render and shares its clip rather than paying for it twice.`
            + (arm.routing ? ` (${arm.routing})` : "");
          remember(group);
          onProgress(group);
          continue;
        }
        arm.status = "rendering";
        onProgress(group);
        try {
          if (config.video.engine !== arm.engine) {
            const sw = await post("/api/video", { action: "engine", value: arm.engine });
            if (sw.error) throw new Error(sw.error);
          }
          /* References are H3's alone and the create route refuses them on LTX
           * — correctly. In a COMPARISON that refusal would kill the LTX arm
           * rather than telling anyone anything, so they are dropped for that
           * arm and the drop is RECORDED. An LTX arm of a referenced comparison
           * is not comparable to the H3 arms and the card has to say so. */
          const armRefs = arm.engine === "h3";
          if (!armRefs && (refImages.length || refAudios.length)) {
            arm.note = "References dropped: LTX has no reference input at all (a model limit, "
              + "not a setting). This arm rendered from the prompt alone, so judge it on motion "
              + "and texture, not on identity.";
          }
          const r = await post("/api/video", {
            action: "create",
            prompt, seed,
            seconds: group.seconds ?? undefined,
            width: arm.requestedWidth, height: arm.requestedHeight,
            steps: arm.steps ?? undefined,
            fromCover: body.fromCover || undefined,
            fromUpload: body.fromUpload || undefined,
            refImages: armRefs && refImages.length ? refImages : undefined,
            refAudios: armRefs && refAudios.length ? refAudios : undefined,
            audioTrack: body.audioTrack || undefined,
            negative: body.negative || undefined,
            keepAudio: body.keepAudio !== false,
            title: `${group.id} · ${arm.label}`,
          });
          if (r.error) throw new Error(r.error);
          /* WHAT THE DOOR CHANGED FROM THE ARM (server/video-plain.js
           * videoPlan): the reference build's step count, a tag taken out of
           * the words, the card's size. Recorded on the arm, so a comparison
           * card never shows a setting that did not run without saying so. */
          const said = (Array.isArray(r.warnings) ? r.warnings : []).map((w) => w?.text).filter(Boolean);
          if (said.length) arm.note = [arm.note, ...said].filter(Boolean).join(" ");

          /* Generous, and per arm rather than per comparison: a 20-step H3
           * render at native size is measured at 11 minutes and a 4K LTX one at
           * six minutes for two seconds. The renderer has its own deadline
           * sized from its own cost curve; this only has to be longer than that
           * so a real render is never abandoned by the thing watching it. */
          const budget = Number(body.timeoutSeconds) > 0
            ? Number(body.timeoutSeconds) * 1000 : 3_600_000;
          const out = await awaitClip(`clip:${r.id}`, budget);
          if (out.error) throw new Error(out.error);

          arm.clip = out.clip ? out.clip.split(/[\\/]/).pop() : null;
          arm.wallSeconds = out.seconds ?? null;
          arm.status = "done";

          /* TAG THE CLIP ITSELF, not only the group. This is what makes the
           * comparison survive in the library: /api/clips returns clipMeta on
           * every row, so the grid, list_clips and the MV importer all see the
           * group without knowing this subsystem exists. A group that lived
           * only in videolab.json would vanish from the place people actually
           * look at clips. */
          if (arm.clip) {
            rememberClip(arm.clip, null, {
              compare: {
                group: group.id, config: arm.id, label: arm.label,
                engine: arm.engine, declaredEngine: arm.declaredEngine,
                steps: arm.steps, width: arm.width, height: arm.height,
                sizeLabel: arm.sizeLabel, seed,
                wallSeconds: arm.wallSeconds,
              },
            });
          }
        } catch (err) {
          /* A FAILED ARM IS A RESULT. "H3 at 1920x1088 is out of memory under
           * guidance" is one of the most useful lines in DIRECTING.md's cost
           * table, and it was learned exactly this way. Recorded, and the
           * comparison carries on to the next arm. */
          arm.status = "failed";
          /* NAME THE CAUSE WHEN WE KNOW IT.
           *
           * ComfyUI caches by GRAPH, so re-running a comparison with the same
           * prompt, seed and size hands back the previous run's output entry —
           * pointing at a file the previous run already renamed into the clip
           * folder. The renderer's rename then fails with a bare ENOENT and two
           * absolute Windows paths, which explains nothing to anybody.
           *
           * Measured here on the first re-run of this surface's own proof: both
           * LTX arms failed this way in four seconds flat. The hazard belongs to
           * the render path rather than to this route — an ordinary re-render of
           * an identical clip hits it too — so this translates rather than
           * pretends to fix it, and the advice is the one that actually works. */
          const raw = String(err.message || err);
          arm.error = /ENOENT[\s\S]*rename/i.test(raw)
            ? "ComfyUI served this render from its cache: an identical graph (same prompt, seed "
              + "and size) was rendered before, so it returned the earlier run's file — which had "
              + "already been moved into the clip library. Run the comparison on a different seed. "
              + `(${raw.slice(0, 120)})`
            : raw.slice(0, 300);
        }
        remember(group);
        onProgress(group);
      }
    } finally {
      group.running = false;
      if (config.video.engine !== restoreEngine) {
        // Best effort: the comparison is finished either way, and failing to put
        // a dropdown back must not throw away the results.
        await post("/api/video", { action: "engine", value: restoreEngine }).catch(() => {});
      }
      remember(group);
      onProgress(group);
    }
    return group;
  }

  /** Comparisons in flight, so a second page load can find one already running. */
  const running = new Map();

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/videolab") return false;

    if (req.method !== "POST") {
      json(res, 200, labState(url.searchParams.get("engine") || undefined));
      return true;
    }

    /* A DOOR THAT CHOOSES WHAT RUNS: a comparison switches the engine and
     * queues renders, and set_knob saves video settings. Studio's page or a
     * local client only, the same guard as POST /api/video (whose own guard a
     * comparison's loopback posts pass), and a body capped before it is parsed.
     * Closed when the guard was not handed in: a door that cannot ask, refuses. */
    if (typeof sameOriginLocalJson !== "function" || !sameOriginLocalJson(req)) {
      json(res, 403, { error: "Video Lab changes and comparisons are only accepted from Studio's own page or a local client." });
      return true;
    }
    let b;
    try { b = await readBody(req, 1024 * 1024); }
    catch (err) {
      json(res, err?.tooBig ? 413 : 400, { error: err?.tooBig
        ? `A Video Lab request is at most 1 MB (${err.message}). Nothing was changed.` : "could not read that body as JSON" });
      return true;
    }
    const action = String(b.action || "");
    try {
      switch (action) {
        case "state": {
          json(res, 200, labState(b.engine, {
            refImages: Array.isArray(b.refImages) ? b.refImages : [],
            refAudios: Array.isArray(b.refAudios) ? b.refAudios : [],
          }));
          return true;
        }

        case "set_knob": {
          const out = setKnob(String(b.id || ""), b.value);
          save();
          json(res, 200, { ok: true, ...out, state: labState(b.engine) });
          return true;
        }

        /* THE QUALITY SELECTION. It writes the ENGINE's own width/height —
         * the same fields `/api/video action:create` falls back to when a
         * caller omits a size — rather than inventing a lab-only preference
         * that the renderer would never read. That is the whole "one document"
         * rule applied to the size box: there is nowhere else for this to
         * live, so there is nothing for it to drift from. */
        case "set_quality": {
          const engine = String(b.engine || config.video.engine);
          const eng = config.video.engines[engine];
          if (!eng) { json(res, 400, { error: `Unknown engine "${engine}".` }); return true; }
          const w = Math.round(Number(b.width));
          const h = Math.round(Number(b.height));
          if (!Number.isFinite(w) || !Number.isFinite(h) || w < 256 || h < 256 || w > 3840 || h > 3840) {
            json(res, 400, { error: "Width and height must each be between 256 and 3840." });
            return true;
          }
          eng.width = w; eng.height = h;
          if (Number.isFinite(b.steps) && engine !== "ltx") {
            const s = Math.round(Number(b.steps));
            if (s < 2 || s > 40) { json(res, 400, { error: "Steps must be between 2 and 40." }); return true; }
            eng.steps = s;
          }
          save();
          json(res, 200, { ok: true, state: labState(engine) });
          return true;
        }

        case "compare": {
          /* Kicked off and answered immediately with the group, because the
           * arms are minutes each and an HTTP request that waited for all of
           * them would be a request nobody's client keeps open. The group is
           * already in the store by the time this replies, so the caller polls
           * `group` — the same read an agent uses to collect the result. */
          const started = await new Promise((resolve, reject) => {
            let first = null;
            runCompare(b, (g) => {
              running.set(g.id, g);
              if (!first) { first = g; resolve(g); }
              if (!g.running) running.delete(g.id);
            }).catch((err) => { if (!first) reject(err); });
          });
          json(res, 200, { ok: true, group: started });
          return true;
        }

        case "group": {
          const g = getGroup(String(b.id || "")) || running.get(String(b.id || ""));
          if (!g) { json(res, 404, { error: `No comparison "${b.id}".` }); return true; }
          json(res, 200, { group: g });
          return true;
        }

        case "groups": {
          json(res, 200, { groups: listGroups(b.limit) });
          return true;
        }

        /* THE STILL STRIP. The same numbered frames out of every arm, at full
         * resolution, cached on the clip's own bytes — see stills.js for why it
         * is served through /api/clip/ and not a path of this route's own.
         *
         * The chosen frame numbers are written ONTO THE GROUP, which is the
         * whole point of doing this through the route rather than in the page:
         * a person who moves the strip to frame 40 and an agent that reads the
         * group afterwards are looking at the same three numbers. */
        case "stills": {
          const g = getGroup(String(b.id || "")) || running.get(String(b.id || ""));
          if (!g) { json(res, 404, { error: `No comparison "${b.id}".` }); return true; }
          const asked = Array.isArray(b.frames) && b.frames.length
            ? b.frames.map(Number).filter(Number.isFinite)
            : (Array.isArray(g.frames) && g.frames.length ? g.frames : STILL_FRAMES.default);
          /* No quality knob on this call. A JPEG quality neither surface would
           * ever want to move is a dead parameter with a live default, and this
           * gate names those out loud rather than letting them accumulate. */
          const out = await groupStills(g, asked);
          if (out.frames.length) { g.frames = out.frames; remember(g); }
          json(res, 200, { ok: true, id: g.id, ...out });
          return true;
        }

        /* THE VERDICT — a judgement, written where both hands read it.
         *
         * A comparison that nobody wrote a conclusion on cost several full
         * renders and left nothing behind but wall times, and the wall time is
         * only half the answer. `by` is not decoration: this field is the one
         * place a person's opinion and an agent's sit side by side, and a
         * verdict that does not say which one it is would let a machine's guess
         * be read back as somebody's decision. Same actor-honesty rule the DAW's
         * critique loop holds at its own seam.
         *
         * An EMPTY note clears it, so a verdict written in haste can be taken
         * back from either surface rather than only from the file. */
        case "verdict": {
          const g = getGroup(String(b.id || "")) || running.get(String(b.id || ""));
          if (!g) { json(res, 404, { error: `No comparison "${b.id}".` }); return true; }
          const armId = String(b.armId || "").trim();
          const note = String(b.note ?? "").trim();
          const by = String(b.by || "").trim();
          if (!note && !armId) {
            g.verdict = null;
            remember(g);
            json(res, 200, { ok: true, group: g, verdict: null });
            return true;
          }
          /* An arm that is not in this comparison is a typo, and accepting it
           * would file the judgement against nothing. Named arms, so the error
           * is answerable in one read. */
          if (armId && !(g.arms || []).some((a) => a.id === armId)) {
            json(res, 400, {
              error: `No arm "${armId}" in ${g.id}. Its arms are: ${(g.arms || []).map((a) => a.id).join(", ")}.`,
            });
            return true;
          }
          if (!by) {
            json(res, 400, { error: "Say who this verdict is from — a person's call and an agent's must not read alike." });
            return true;
          }
          g.verdict = { armId: armId || null, note, by, at: Date.now() };
          remember(g);
          json(res, 200, { ok: true, group: g, verdict: g.verdict });
          return true;
        }

        /* Hybrid's routing, answered BEFORE anything is spent. The fork's own
         * history is the reason this is a route and not a comment: "nothing
         * reported which engine a clip chose until after it had run", and
         * hybrid silently meant H3-for-everything for most of an evening. */
        case "resolve_hybrid": {
          json(res, 200, resolveHybrid({
            refImages: Array.isArray(b.refImages) ? b.refImages : [],
            refAudios: Array.isArray(b.refAudios) ? b.refAudios : [],
          }));
          return true;
        }

        default:
          json(res, 400, { error: `Unknown action "${action}". Try state, set_knob, set_quality, compare, group, groups, stills, verdict, resolve_hybrid.` });
          return true;
      }
    } catch (err) {
      json(res, 400, { error: String(err.message || err) });
      return true;
    }
  }

  handle.load = load;
  handle.runCompare = runCompare;
  return handle;
}

export { KNOBS, COMPARE_CONFIGS };
