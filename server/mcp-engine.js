/**
 * The engine door — the MCP tools.
 *
 * ┌─ FOR THE INTEGRATOR ───────────────────────────────────────────────────┐
 * │ Two lines in server/mcp.js:                                            │
 * │                                                                        │
 * │  1. beside the other imports:                                          │
 * │     import { engineTools } from "./mcp-engine.js";                     │
 * │                                                                        │
 * │  2. inside the TOOLS array, alongside the existing entries:            │
 * │     ...engineTools(api),                                               │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Ten tools, thirteen actions, and every one of them is also a human control
 * on the Engine panel — server/engine/ui_test.js fails the commit if either
 * side grows something the other cannot reach.
 *
 * ── WHY AN AGENT NEEDS THESE AT ALL ───────────────────────────────────────
 *
 * Every other tool in this server is a FINISHED verb: make a song, render a
 * clip, add an effect. This family is the raw one underneath — an arbitrary
 * ComfyUI graph, run on this machine's engine. It exists because the engine's
 * own address does not: the app picks an unpublished loopback port at every
 * start, so there is nothing to post to directly, on purpose. For one night in
 * September 2026, 245 renders were driven straight at the engine by scripts
 * that had a port number baked in, and not one of them exists in the ledger,
 * the clip library, or any project. Everything through here does.
 *
 * ── WHAT THE DESCRIPTIONS ARE FOR ─────────────────────────────────────────
 *
 * An agent cannot see the GPU, cannot feel thirty-two minutes pass, and cannot
 * tell ComfyUI's two save formats apart by looking. So the descriptions carry
 * the measured consequence of each choice — the same sentences the person
 * reads beside the same control. A description that says "runs a graph" has
 * told the agent nothing it could act on; one that says what a wrong file
 * costs has.
 */

/** Where the measured numbers in these descriptions came from, so nobody has
 *  to rediscover them by spending them again. */
const COSTS =
  "H3 is roughly 10x LTX for the same shot. A guided 1344x768 H3 clip measured "
  + "2259 s on this rig; a VACE pass is about 32 minutes a clip; LTX 2.5 at 5 s is "
  + "about 121 s; a FLUX.2 cover is about 3 s.";

export function engineTools(api) {
  const door = async (body) => {
    /* Thirty minutes, because that is what one clip of the expensive kind
     * really costs — the default 120 s would abandon a job that is going
     * perfectly well, and an abandoned poll looks exactly like a failed render
     * while the GPU carries on burning either way. */
    const r = await api("POST", "/api/engine", body, 2_400_000);
    if (r.error) throw new Error(r.error);
    return r;
  };

  return [
    {
      name: "engine_run_graph",
      description:
        "Run a ComfyUI graph on this machine's engine, through the app's door. THIS IS THE ONLY "
        + "WAY TO REACH THE ENGINE. It is bound to loopback on a port the app picks fresh at every "
        + "start and does not publish, so there is no address to post to directly — deliberately: "
        + "for one night in September 2026, 245 renders were driven straight at the engine by "
        + "scripts, and none of them exists in the provenance ledger, the clip library or any "
        + "project. Everything that goes through here does.\n\n"
        + "⚠ API FORMAT, NOT THE UI SAVE. ComfyUI's \"Save\" writes an editor document — nodes, "
        + "links, positions, widget arrays — and the engine cannot execute it. The one that works "
        + "is \"Save (API Format)\" (enable Dev Mode in ComfyUI's settings if you cannot see it). "
        + "The two files look equally like JSON and fail very differently; this tool tells them "
        + "apart and says which one you gave it.\n\n"
        + "WHAT IS RECORDED, BEFORE THE GPU SPENDS ANYTHING: the graph (hashed, and stored whole so "
        + "the run can be reproduced), the resolved positive and negative prompt, every seed, step "
        + "count, cfg, sampler and scheduler, the size and frame count, every model and LoRA FILE "
        + "with its size and date, every reference image with its SHA-256, who asked, and which "
        + "project and shot it belongs to. When it finishes: the wall time, whether the engine "
        + "served it from cache, and the SHA-256 of every file it wrote. A run that FAILS is "
        + "recorded too — before this door existed, a failed render left no trace at all.\n\n"
        + "COST IS REAL AND THIS TOOL WILL NOT HIDE IT. " + COSTS + " Call it with dry_run first: "
        + "that returns the exact record that would be written — model files, steps, size, seed — "
        + "and posts nothing. It is the cheapest way to find out you were about to spend half an "
        + "hour on the wrong checkpoint. It deliberately returns no cost estimate for an arbitrary "
        + "graph, because a fabricated number is worse than none.\n\n"
        + "adopt (default true) files whatever the graph writes into the normal clip/image "
        + "library, so list_clips and the Workflow importer see it like any other render. Pass "
        + "adopt: false for a probe whose output is not worth keeping — it is still fully "
        + "recorded, just not shelved.\n\n"
        + "wait (default true) blocks until the render is done. With wait: false you get a runId "
        + "immediately and poll engine_activity; the record is completed by the app either way, "
        + "even if you never come back.",
      inputSchema: {
        type: "object",
        required: ["graph"],
        properties: {
          graph: { type: "object", description: "The API-format graph: an object of node ids, each with class_type and an inputs object." },
          wait: { type: "boolean", description: "Block until the render finishes. Default true." },
          adopt: { type: "boolean", description: "File the outputs into the clip/image library. Default true." },
          label: { type: "string", description: "What this run is, in a few words. It is what engine_activity shows you a week later." },
          note: { type: "string", description: "Anything worth knowing about this run that the graph does not say." },
          project: { type: "string", description: "Which project this belongs to, recorded in the ledger and filterable in engine_activity." },
          shot: { type: "string", description: "Which shot, for the same reason." },
          timeoutMs: { type: "integer", description: "Abandon after this long. Default 30 minutes; a VACE pass needs more." },
          pollMs: { type: "integer", description: "How often to ask whether it is done, in milliseconds. Default 3000 — right for a 32-minute pass, and about a second of pure waiting added to a 3-second image. Lower it for short graphs." },
          dry_run: { type: "boolean", description: "Return the record that WOULD be written and post nothing. Costs nothing; answers most questions." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await door({
          action: "prompt",
          graph: a.graph, wait: a.wait, adopt: a.adopt,
          label: a.label, note: a.note, project: a.project, shot: a.shot,
          timeoutMs: a.timeoutMs, pollMs: a.pollMs, dry_run: a.dry_run,
        });
        if (r.dry_run) {
          return {
            dry_run: true,
            nothing_was_spent: true,
            problems: r.problems,
            would_record: summarise(r.record),
          };
        }
        return {
          runId: r.runId, promptId: r.promptId, status: r.status, error: r.error,
          elapsed_seconds: r.elapsedSec, queued_seconds: r.queuedSec,
          served_from_cache: r.cached,
          outputs: (r.outputs || []).map((o) => ({
            file: o.file, subfolder: o.subfolder, kind: o.kind,
            bytes: o.bytes, sha256: o.sha256, in_library_as: o.adoptedAs,
          })),
          recorded: summarise(r.record),
          ledger: r.ledger,
        };
      },
    },

    {
      name: "engine_activity",
      description:
        "Every prompt this engine has been asked to run, newest first, with WHO ASKED: user "
        + "(someone clicked), agent:<name> (an MCP client — including you), script:<name> (a "
        + "harness) or system (an internal job). Each row carries the model, size, steps, seed, "
        + "wall time, cache hit and the files it wrote.\n\n"
        + "This is the answer to \"what happened on this machine last night\" and to \"is this "
        + "clip's origin recorded\" — and because the door is the only way in, the ABSENCE of a "
        + "row means the render did not happen, rather than that it went unrecorded. That is a "
        + "new property: before the door, absence meant nothing at all.\n\n"
        + "Filter by actor, status, project or via (which part of the app asked: art.cover, "
        + "jobs.music, mv.sfx_judge, imagetools, export.audio, api). engine_run gives one row's "
        + "complete record, including the graph itself.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "How many rows. Default 50." },
          actor: { type: "string", description: "Exactly one actor: user, system, agent:<name> or script:<name>." },
          since: { type: "string", description: "ISO timestamp. Only runs at or after it." },
          project: { type: "string", description: "Only runs recorded against this project." },
          status: { type: "string", description: "completed, error, rejected, timeout, vanished, or running." },
          via: { type: "string", description: "Which part of the app asked — api is everything through this door." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await door({
          action: "activity",
          limit: a.limit, actor: a.actor, since: a.since,
          project: a.project, status: a.status, via: a.via,
        });
        return {
          total: r.total,
          runs: (r.runs || []).map((x) => ({
            runId: x.runId, at: x.t, asked_by: x.actor, via: x.via, label: x.label,
            model: x.model, size: x.width && x.height ? `${x.width}x${x.height}` : null,
            steps: x.steps, seed: x.seed, status: x.status,
            elapsed_seconds: x.elapsedSec, served_from_cache: x.cached,
            project: x.project, shot: x.shot,
            outputs: (x.outputs || []).map((o) => o.adoptedAs || o.file),
          })),
        };
      },
    },

    {
      name: "engine_run",
      description:
        "ONE run's complete record: everything that was known before it started and everything "
        + "that was true when it finished — the resolved prompt and negative, every sampler's "
        + "seed and schedule, the size and frame count, every model and LoRA file with its bytes "
        + "and date, every reference image with its digest, the wall time, and the SHA-256 of "
        + "every file it wrote.\n\n"
        + "Pass graph: true to get the EXACT graph back as well. That is the field that makes a "
        + "render reproducible rather than merely described — a record that says what happened is "
        + "worth much less than one you can run again.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: {
          runId: { type: "string", description: "From engine_activity, or returned by engine_run_graph." },
          graph: { type: "boolean", description: "Include the stored graph itself. Default false — graphs are large." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await door({ action: "run", runId: a.runId, graph: a.graph });
        return { runId: r.runId, requested: r.request, result: r.result, graph: r.graph };
      },
    },

    {
      name: "engine_graph",
      description:
        "Fetch a stored graph by its hash. Graphs are content-addressed, so a hundred arms of one "
        + "sweep that share a graph share ONE stored file and a re-run costs zero extra bytes — "
        + "and \"did these two runs really use the same graph?\" is a string comparison rather "
        + "than a diff. Nothing here is ever pruned: a ledger line that names a hash nothing can "
        + "resolve is worse than no record, because it looks like evidence.",
      inputSchema: {
        type: "object",
        required: ["graphHash"],
        properties: {
          graphHash: { type: "string", description: "The sha256:... every run's record carries." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await door({ action: "graph", graphHash: a.graphHash });
        return { graphHash: r.graphHash, graph: r.graph };
      },
    },

    {
      name: "engine_nodes",
      description:
        "What node classes and samplers THIS install actually has, read from the engine itself "
        + "rather than from a list in the source. Use it before writing a graph by hand: a "
        + "misspelled class or a sampler this build does not ship fails HERE, in a second, "
        + "instead of thirty minutes into a render. Pass a node name for one class's inputs and "
        + "their real ranges; omit it for the whole catalogue, which is large.",
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string", description: "One class name, e.g. KSampler. Omit for everything." },
        },
        additionalProperties: false,
      },
      async run(a) {
        const r = await door({ action: "object_info", node: a.node });
        return { nodes: r.nodes };
      },
    },

    {
      name: "engine_status",
      description:
        "Is the engine up, which memory tier it was launched on, whether its CUDA build is the "
        + "fused one (a cu128 torch silently costs about 5x and everything still 'works'), how "
        + "deep the queue is and what is rendering right now.\n\n"
        + "It also says HOW EXPOSED this engine is, which is the fact this whole subsystem exists "
        + "for: ephemeral (the app picked an unpublished port at start — nothing else on this "
        + "machine can find it by guessing), pinned (someone set AIPLAY_COMFY_PORT, so anything "
        + "here can drive it directly and those renders will not appear in the ledger) or "
        + "revealed (a person asked for the number, and the ledger says when). The number itself "
        + "comes back only in the last two cases, because only then is it already discoverable — "
        + "hiding a number that netstat prints would help nobody and pretending otherwise would "
        + "be the dishonest half.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const r = await door({ action: "status" });
        return {
          ready: r.ready, ours: r.ours,
          exposure: r.mode, port: r.port,
          tier: r.tier, backend: r.backend, version: r.version,
          uptime_seconds: r.uptimeSec,
          queue: r.queue, running: r.running,
          hash_models: r.hashModels,
          graph_store: r.graphStore,
          engine_ledger_entries: r.ledgerEntries,
        };
      },
    },

    {
      name: "engine_identity",
      description:
        "WHICH ComfyUI this is, read from its own launch arguments: its main.py, its "
        + "--input-directory, its --output-directory, and whether those are this Studio's.\n\n"
        + "A PORT IS NOT AN IDENTITY, and this is the check that proves it. Two copies of this app "
        + "on one machine share a rig, an output folder and a ledger path; a job posted at a port "
        + "that answers can render happily into the OTHER install's library, and the only symptom "
        + "is an evening's work in a place nobody looks. Anything it cannot verify appears in "
        + "problems[] rather than being assumed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const r = await door({ action: "identity" });
        return {
          version: r.version, main_py: r.mainPy,
          input_directory: r.inputDirectory, output_directory: r.outputDirectory,
          is_this_studio: r.matchesThisStudio,
          exposure: r.mode, port: r.port,
          problems: r.problems,
        };
      },
    },

    {
      name: "engine_stop",
      description:
        "Stop work. interrupt kills what is rendering right now; clear_queue drops everything "
        + "that has not started yet; both does both, and is what you want when a sweep is heading "
        + "somewhere wrong.\n\n"
        + "The ledger's record of an interrupted run stays exactly where it is, with status "
        + "error — a render that was stopped still happened, still cost GPU time, and is still "
        + "the reason a file with that seed does not exist.",
      inputSchema: {
        type: "object",
        properties: {
          what: {
            type: "string", enum: ["interrupt", "clear_queue", "both"],
            description: "Default both.",
          },
        },
        additionalProperties: false,
      },
      async run(a) {
        const what = a.what || "both";
        const out = {};
        if (what !== "clear_queue") out.interrupted = (await door({ action: "interrupt" })).stopped;
        if (what !== "interrupt") out.dropped = (await door({ action: "clear_queue" })).dropped;
        return out;
      },
    },

    {
      name: "engine_hash_models",
      description:
        "Turn weight-file hashing on or off, and say what it costs — because it is a real cost "
        + "and hiding it would be the wrong kind of helpful.\n\n"
        + "Every render already records each model file's name, byte size and modification date, "
        + "which is free and enough to notice a swapped file. The full SHA-256 is the only thing "
        + "that PROVES which weights rendered a clip. It costs about ten seconds per file the "
        + "first time each one is seen (a 21 GB transformer on NVMe), then nothing — the digest "
        + "is cached against the file's path, size and date, so a file swapped underneath cannot "
        + "keep claiming the old one.\n\n"
        + "Off by default. Reference images and outputs are hashed ALWAYS, whatever this says: "
        + "those are megabytes, and the reference digest is what answers 'was the reference I "
        + "declared actually the one that reached the render?'.",
      inputSchema: {
        type: "object",
        required: ["on"],
        properties: { on: { type: "boolean", description: "true to hash weight files on every render." } },
        additionalProperties: false,
      },
      async run(a) {
        const r = await door({ action: "set_hash_models", on: a.on });
        return {
          hash_models: r.hashModels,
          note: r.hashModels
            ? "Every render from now on records the SHA-256 of its weight files. The first sight of each file costs about ten seconds."
            : "Weight files are recorded by name, bytes and date only. References and outputs are still hashed.",
        };
      },
    },

    /* ⚠ THE TENTH TOOL, AND IT IS HERE BECAUSE THE CENSUS SAYS SO.
     *
     * The design sketched nine tools and put Reveal on the panel alone. But
     * server/engine/ui_test.js requires that every action the route dispatches
     * be reachable by BOTH hands with no exemption table, and the reason that
     * rule is worth more than my instinct here is exactly this case: an agent
     * that wants the port and cannot ask for it does not stop wanting it — it
     * reads comfy.log, or runs netstat, and neither of those leaves a line in
     * the ledger. Giving it the same recorded control the person has is the
     * choice that keeps the record true. */
    {
      name: "engine_reveal_port",
      description:
        "Ask for the engine's actual port number, and leave a dated line in the ledger saying you "
        + "did.\n\n"
        + "Read this before calling it. The port is unpublished on purpose: the app picks a fresh "
        + "one at every start so that no script, no stale note and no second copy of this app can "
        + "find the engine by guessing. Once you know the number you can post to ComfyUI directly "
        + "— and anything you render that way exists nowhere: not in this ledger, not in the clip "
        + "library, not in any project. That is not a rule being enforced against you, it is "
        + "simply what happens.\n\n"
        + "So call this only when you genuinely need ComfyUI's own web interface or a tool that "
        + "cannot be pointed at engine_run_graph — and know that after it, this install's history "
        + "can honestly say 'at 02:14 the port was revealed; renders after that may have "
        + "bypassed'. That visible bypass is the entire reason this control exists rather than "
        + "the port simply being secret: a hole somebody can see is worth more than one they "
        + "cannot.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        const r = await door({ action: "reveal" });
        return {
          port: r.port, exposure: r.mode,
          recorded: "A choice event was appended to this install's ledger on asset \"engine\".",
          note: "Renders posted straight at this port will not appear in engine_activity, the clip library, or any project.",
        };
      },
    },

    {
      name: "engine_adopt_unrecorded",
      description:
        "Files sitting in the output folder that this ledger has never heard of — everything made "
        + "before this door existed, plus anything a process outside the app still writes there. "
        + "On the day the door was built there were 424 of them, 85 in the clip folder the app "
        + "already lists.\n\n"
        + "With no arguments it PREVIEWS: the paths, sizes and dates, and nothing is written. "
        + "Adopting appends one honest event per file — an edit whose origin is \"unrecorded\", "
        + "which folds to the class composite: \"parts may be AI-generated; origin partially "
        + "unrecorded\". It never claims to know what made the file, because it does not. That is "
        + "the whole point: a record that guesses is worse than an absence that is visible.\n\n"
        + "Opt-in and previewable on purpose. Writing hundreds of events into a hash chain "
        + "without being asked is not something a compliance layer gets to do.",
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" }, description: "Paths relative to the output folder, as list mode returns them." },
          all: { type: "boolean", description: "Adopt everything the scan can see. Preview it first." },
          dry_run: { type: "boolean", description: "Show the exact events and append nothing." },
          limit: { type: "integer", description: "Preview mode: how many rows. Default 200." },
          prefix: { type: "string", description: "Preview mode: only this top folder, e.g. gate or clips." },
        },
        additionalProperties: false,
      },
      async run(a) {
        if (!a.files && !a.all) {
          const r = await door({ action: "list_unrecorded", limit: a.limit, prefix: a.prefix });
          return {
            scanned: r.scanned, total_unrecorded: r.total,
            files: r.files,
            next: "Pass files: [...] or all: true to adopt them. Add dry_run: true to see the events first.",
          };
        }
        const r = await door({ action: "adopt_unrecorded", files: a.files, all: a.all, dry_run: a.dry_run });
        return { adopted: r.adopted, dry_run: r.dry_run, events: r.events };
      },
    },
  ];
}

/**
 * The record, said in the words an agent can act on.
 *
 * The stored record is deliberately exhaustive — it is evidence. What comes
 * back through a tool call is the half that changes a decision: which weights,
 * how many steps, how big, and what it is about to be told to draw.
 */
function summarise(rec) {
  if (!rec) return null;
  return {
    model: rec.model,
    prompt: rec.prompt,
    negative: rec.negative,
    prompt_resolved: rec.promptResolved,
    seed: rec.seed, steps: rec.steps, cfg: rec.cfg,
    size: rec.width && rec.height ? `${rec.width}x${rec.height}` : null,
    frames: rec.frames, fps: rec.fps, seconds: rec.seconds,
    samplers: rec.samplers,
    model_files: (rec.engineFiles || []).map((f) => ({ file: f.file, bytes: f.bytes, sha256: f.sha256 })),
    loras: rec.loras,
    references: (rec.references || []).map((f) => ({ file: f.file, bytes: f.bytes, sha256: f.sha256 })),
    output_prefixes: rec.outputPrefixes,
    graph_hash: rec.graphHash, graph_nodes: rec.graphNodes,
    exposure: rec.enginePort,
  };
}
