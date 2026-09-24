/**
 * /api/engine — THE PUBLIC DOOR.
 *
 * ── WHAT THIS ROUTE IS FOR ────────────────────────────────────────────────
 *
 * `server/engine/client.js` closed the inside of the house: nothing in this
 * application can reach ComfyUI except through `dispatch()`, and the port is
 * a number the app picks fresh at every start and does not publish. That alone
 * would leave a harness with nowhere to go — and a harness with nowhere to go
 * either stops working or goes looking for the port with `netstat`, which is
 * the same bypass wearing a hat.
 *
 * So this is the way in from outside. One path, one envelope, and it records
 * everything: on 2026-09-02 the rig's output folder held 426 files written
 * since the previous noon, and 424 of them had no ledger entry of any kind,
 * because three scripts in the other repo posted straight at the engine. Every
 * one of those renders would now arrive here, and every one of them would be
 * in the ledger before the GPU spent a millisecond.
 *
 * ── ONE ROUTE BEHIND BOTH HANDS ───────────────────────────────────────────
 *
 * The same bargain `vfx`, `daw`, `videolab` and `mv` hold: `web/engine.js`
 * posts these actions, `server/mcp-engine.js` posts the SAME actions, and
 * `server/engine/ui_test.js` fails the commit if either side grows something
 * the other cannot reach. There is no UI-only field and no agent-only knob.
 *
 * `clientId` and `claim` are deliberately absent from this surface. They are
 * `dispatch()` options for INTERNAL callers — art.js registers the clip it is
 * about to rename, jobs.js watches its own websocket — and neither means
 * anything over HTTP. Keeping them out is what lets the parity census demand
 * that every route parameter really is reachable from both hands, with no
 * exemption table at all.
 *
 * ── THE ACTOR REFUSAL, AND WHY IT IS A REFUSAL ────────────────────────────
 *
 * `prov.actorFrom(req)` is unchanged and stays one rule for the whole app. But
 * this door adds something no other route does: it REFUSES a request it cannot
 * attribute, rather than quietly filing it as `system`. Everywhere else an
 * unattributed call is a person clicking a button; here it is a script, and a
 * script that does not say who it is would land 245 renders in the ledger
 * under a name that means "the app did this on its own". That is not a smaller
 * lie than no record at all — it is a more convincing one.
 *
 * A browser needs nothing: it is recognised by the `Origin` header it sends on
 * a cross-content-type POST, which curl and node do not. A script COULD forge
 * that header, and then it is deliberately lying rather than forgetting — this
 * guard is against accident, which is this whole design's stance.
 */
import path from "node:path";
import { rename, stat, mkdir } from "node:fs/promises";

const HELP_ACTOR =
  "This door records who asked. Send x-aiplay-actor: script:<name> (a harness), "
  + "agent:<name> (an MCP client) — a browser is recognised by its Origin header and "
  + "needs nothing. Nothing here will invent an actor for you.";

/** Video first, because a clip is the expensive thing and the one the library
 *  has been unable to describe. Kept beside the adopter it serves. */
const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

export function createEngineRoutes(deps) {
  const {
    json, readBody, config, provenance: prov, engine,
    IMAGE_DIR, CLIP_DIR, rememberClip = () => {},
  } = deps;
  const store = deps.store ?? engine.store;
  /** The supervisor, for the two facts it owns and the client does not: which
   *  memory tier this engine was launched on and whether its CUDA build is the
   *  fused one. Optional, so a test can mount this route without one. */
  const comfy = deps.comfy ?? null;

  /**
   * A browser, by the header browsers send and command-line tools do not.
   *
   * Deliberately exact rather than a prefix match: `http://127.0.0.1:4173` and
   * `http://localhost:4173` are this app, and `http://127.0.0.1:41730` is not.
   */
  function sameOriginBrowser(req) {
    const o = String(req?.headers?.origin || "");
    if (!o) return false;
    return o === `http://127.0.0.1:${config.uiPort}` || o === `http://localhost:${config.uiPort}`;
  }

  /**
   * Put an engine output into the library the rest of the app reads.
   *
   * This is the seam `client.js` calls when a dispatch has `adopt` on and no
   * `claim`, and it is what turns "a file appeared in the output folder" into
   * "a clip in the library with a render time and a record behind it". The 85
   * unledgered files in `clips/` are the whole argument: `/api/clips` already
   * listed them and could say nothing whatsoever about them.
   *
   * Deliberately narrow. A video goes to `clips/`, an image to `images/`, and
   * ANYTHING ELSE is left exactly where the graph put it with `adoptedAs: null`
   * — audio in particular, because a bare file in the output root is a SONG to
   * this library and adopting a probe's forty-second test render as one would
   * put a thing nobody made into somebody's discography. The record still has
   * its name, bytes and SHA-256 either way; adoption is about the shelf, not
   * about the evidence.
   */
  async function adopt({ runId, record, output }) {
    const src = path.join(config.outputDir, output.subfolder || "", output.file);
    const dir = VIDEO_RE.test(output.file) ? CLIP_DIR
      : IMAGE_RE.test(output.file) ? IMAGE_DIR : null;
    if (!dir) return null;
    await mkdir(dir, { recursive: true });

    /* Never overwrite. Two arms of a sweep that both wrote `arm_00001.mp4`
     * into different subfolders would otherwise silently become one file, and
     * the second run's ledger entry would point at the first one's bytes. */
    let name = path.basename(output.file);
    const stem = name.replace(/\.[a-z0-9]+$/i, "");
    const ext = name.slice(stem.length);
    const dest = () => path.join(dir, name);
    if (path.resolve(src) !== path.resolve(dest())) {
      for (let n = 2; n < 500; n++) {
        try { await stat(dest()); } catch { break; }
        name = `${stem}_${n}${ext}`;
      }
      try { await rename(src, dest()); }
      catch (e) {
        if (e.code !== "ENOENT") throw e;
        /* The engine served this graph from its own cache and the earlier run
         * already moved the file. Saying so beats re-rendering to prove that
         * identical settings produce an identical clip. */
        return null;
      }
    }
    if (VIDEO_RE.test(name)) {
      rememberClip(name, null, {
        source: "engine", runId, via: record.via, label: record.label,
        model: record.model, prompt: record.prompt, seed: record.seed,
        width: record.width, height: record.height, project: record.project, shot: record.shot,
      });
    }
    return `${VIDEO_RE.test(name) ? "clips" : "images"}/${name}`;
  }

  /**
   * The unrecorded-file adoption, one honest event per file.
   *
   * `edit` with an `origin`, NOT `import`. foldOrigin's import branch labels an
   * undeclared import `third-party-licensed`, which for a file this machine
   * almost certainly made itself is a lie; its edit branch already has the
   * exact right sentence — class `composite`, "parts may be AI-generated
   * (origin partially unrecorded)". No new event type, honest class, and every
   * existing reader copes.
   *
   * `actor: "system"` and not the caller: a person pressing this button did not
   * make the file, and an `edit` by `user` on an `ai-generated` asset promotes
   * it to `ai-assisted-human-edited`. Adopting a record must never change what
   * the record says happened.
   */
  async function adoptUnrecorded(files, { dryRun }) {
    const out = [];
    for (const rel of files) {
      const clean = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
      if (clean.includes("..")) { out.push({ file: clean, ok: false, error: "path escapes the output folder" }); continue; }
      const full = path.join(config.outputDir, clean);
      let st;
      try { st = await stat(full); }
      catch { out.push({ file: clean, ok: false, error: "not in the output folder any more" }); continue; }
      const data = {
        op: "adopt_unrecorded", origin: "unrecorded",
        foundAt: clean, bytes: st.size, mtimeMs: Math.round(st.mtimeMs),
        sha256: dryRun ? null : await store.hashFile(full),
        note: "present in the output folder before the engine door existed; origin unrecorded",
      };
      if (dryRun) { out.push({ file: clean, ok: true, wouldAppend: data }); continue; }
      try {
        const ev = await prov.append("library", { actor: "system", type: "edit", asset: clean, data });
        out.push({ file: clean, ok: true, id: ev?.id ?? null });
      } catch (e) { out.push({ file: clean, ok: false, error: e.message }); }
    }
    return out;
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== "/api/engine" && p !== "/api/engine/prompt") return false;

    if (req.method !== "POST") {
      json(res, 405, {
        error: "POST a body like {\"action\":\"status\"}. " + HELP_ACTOR,
      });
      return true;
    }

    /* ⚠ THE ATTRIBUTION GATE, BEFORE THE BODY IS EVEN READ. A request nobody
     * will own is refused rather than filed under a name that means nothing. */
    if (!req.headers["x-aiplay-actor"] && !sameOriginBrowser(req)) {
      json(res, 400, { error: HELP_ACTOR });
      return true;
    }

    let b;
    try { b = await readBody(req); }
    catch { json(res, 400, { error: "that body is not JSON." }); return true; }

    /* THE DOCUMENTED FRIENDLY ALIAS. A script author reading INSTALL.md should
     * not have to learn an envelope to run one graph, and one rewritten line
     * here means the parity census still sees exactly one dispatch. */
    if (p === "/api/engine/prompt") b.action = "prompt";

    const actor = prov.actorFrom(req);
    const action = String(b.action || "");

    try {
      switch (action) {
        /* THE RUN. Everything below the ledger line is client.js's; what this
         * case owns is turning an HTTP body into a spec and refusing to invent
         * anything that is missing from it. */
        case "prompt": {
          const out = await engine.dispatch({
            graph: b.graph,
            actor,
            via: "api",
            wait: b.wait !== false,
            adopt: b.adopt !== false,
            label: b.label ?? null,
            note: b.note ?? null,
            project: b.project ?? null,
            shot: b.shot ?? null,
            timeoutMs: Number(b.timeoutMs) || undefined,
            /* HOW OFTEN TO ASK, and it is not one number for every graph.
             *
             * The client's 3 s default is right for a 32-minute VACE pass and
             * wrong for a 3-second FLUX cover, where it would roughly double
             * the wall time for nothing — art.js already chose 400 ms for
             * images and 1000 for clips, from measurement. The harnesses that
             * used to poll the engine themselves each had their own cadence
             * too, down to 250 ms for a frame-by-frame feedback render, and
             * migrating them to this door must not silently make them slower.
             * So the caller keeps its own number. The BOUNDS it is checked
             * against are durations, not poll counts, so a fast cadence cannot
             * weaken them. */
            pollMs: Number(b.pollMs) || undefined,
            dryRun: b.dry_run === true,
          });
          /* The record that WOULD be written, and nothing spent — the model
           * files, the steps, the size and the seed, before thirty-two minutes
           * go on the wrong checkpoint. It deliberately returns no cost
           * estimate: a fabricated number is worse than none. */
          if (out.dryRun) {
            json(res, 200, { ok: true, dry_run: true, record: out.record, problems: out.problems || [] });
            return true;
          }
          json(res, 200, {
            ok: out.ok, runId: out.runId, promptId: out.promptId ?? null,
            status: out.status, error: out.error ?? null,
            /* THREE NUMBERS, because one cannot answer both questions a caller
             * has. `elapsedSec` is what you waited; `queuedSec` is what the
             * engine spent finishing somebody else's job first; `runningSec` is
             * the only one that is about YOUR render — and the only one the
             * door's deadline is measured against (client.js, watch()). */
            elapsedSec: out.elapsedSec ?? null, queuedSec: out.queuedSec ?? null,
            runningSec: out.runningSec ?? null,
            cached: out.cached ?? false,
            outputs: out.outputs || [],
            record: out.record,
            ledger: { delegate: out.ledger?.delegate?.id ?? null, generate: out.ledger?.generate?.id ?? null },
          });
          return true;
        }

        /* What happened on this machine, newest first, with who asked. Because
         * the door is the only way in, the ABSENCE of a row now means the
         * render did not happen — rather than that it happened unrecorded,
         * which is what absence meant before. */
        case "activity": {
          json(res, 200, await engine.activity({
            limit: Number(b.limit) || 50,
            actor: b.actor ? String(b.actor) : null,
            since: b.since ? String(b.since) : null,
            project: b.project ? String(b.project) : null,
            statusOf: b.status ? String(b.status) : null,
            via: b.via ? String(b.via) : null,
          }));
          return true;
        }

        case "run": {
          const id = String(b.runId || "").trim();
          if (!id) { json(res, 400, { error: "Which run? Pass runId — engine_activity lists them." }); return true; }
          const rec = await engine.runRecord(id, { graph: b.graph === true });
          if (!rec) { json(res, 404, { error: `No run "${id}" in this ledger.` }); return true; }
          json(res, 200, rec);
          return true;
        }

        /* Content-addressed, so a hundred arms of one sweep share one file and
         * "did these two really run the same graph" is a string comparison. */
        case "graph": {
          const h = String(b.graphHash || "").trim();
          if (!h) { json(res, 400, { error: "Pass graphHash — every run's record carries one." }); return true; }
          const g = await store.getGraph(h);
          if (!g) { json(res, 404, { error: `No graph stored under ${h}.` }); return true; }
          json(res, 200, { graphHash: h, graph: g });
          return true;
        }

        /* What nodes and samplers THIS install really has, read from the engine
         * rather than from a list in the source — a typo fails here instead of
         * thirty minutes into a render. */
        case "object_info": {
          json(res, 200, { nodes: await engine.objectInfo(b.node ? String(b.node) : undefined) });
          return true;
        }

        case "status": {
          const s = await engine.status();
          json(res, 200, {
            ...s,
            tier: comfy?.tier ?? config.tier ?? null,
            backend: comfy ? comfy.backend : null,
            uptimeSec: comfy?.startedAt ? Math.round((Date.now() - comfy.startedAt) / 1000) : null,
            ledgerEntries: (await prov.read("library", { assetPrefix: "engine/" })).events.length,
          });
          return true;
        }

        /* A PORT IS NOT AN IDENTITY. Which ComfyUI this is, from its own argv —
         * the check that stops renders landing in another install's library,
         * and the answer on screen to two repos sharing one machine. */
        case "identity": {
          json(res, 200, await engine.identity());
          return true;
        }

        case "interrupt": {
          json(res, 200, await engine.interrupt());
          return true;
        }

        case "clear_queue": {
          json(res, 200, await engine.clearQueue());
          return true;
        }

        /* The explicit quality/cost choice, said out loud wherever it is
         * offered: the digest is the only thing that PROVES which weights
         * rendered a clip, and it costs about ten seconds per file the first
         * time each one is seen. */
        case "set_hash_models": {
          if (typeof b.on !== "boolean") { json(res, 400, { error: "Pass on: true or on: false." }); return true; }
          const s = await store.writeSettings({ hashModels: b.on });
          json(res, 200, { hashModels: s.hashModels === true });
          return true;
        }

        /* THE ESCAPE HATCH THAT LEAVES A DATED LINE. A developer who wants
         * ComfyUI's own web UI gets it; the ledger can then honestly say "at
         * 02:14 the port was revealed; renders after that may have bypassed",
         * which is the entire difference between an invisible bypass and a
         * visible one. Recorded first, and a failed record aborts it. */
        case "reveal": {
          /* Refused, with its sentence, when the engine's minors backstop is
           * not armed (engine/client.js reveal): a port nobody checks. */
          try { json(res, 200, await engine.reveal({ actor })); }
          catch (err) {
            if (err?.reason !== "backstop-not-armed") throw err;
            json(res, 409, { error: String(err.message), reason: err.reason });
          }
          return true;
        }

        case "list_unrecorded": {
          json(res, 200, await store.scanUnrecorded({
            limit: Number(b.limit) || 200,
            prefix: b.prefix ? String(b.prefix) : null,
          }));
          return true;
        }

        /* Opt-in and previewed, because writing hundreds of events into a hash
         * chain without being asked is not something a compliance layer gets to
         * do. `all` adopts everything the scan can see; `dry_run` shows the
         * exact events first and appends nothing. */
        case "adopt_unrecorded": {
          const dryRun = b.dry_run === true;
          let files = Array.isArray(b.files) ? b.files.map(String) : [];
          if (b.all === true) files = (await store.scanUnrecorded({ limit: 5000 })).files.map((f) => f.path);
          if (!files.length) {
            json(res, 400, { error: "Name the files, or pass all: true. list_unrecorded shows what there is." });
            return true;
          }
          const events = await adoptUnrecorded(files, { dryRun });
          json(res, 200, { adopted: events.filter((e) => e.ok && !dryRun).length, dry_run: dryRun, events });
          return true;
        }

        default:
          json(res, 400, {
            error: `Unknown action "${action}". Try prompt, activity, run, graph, object_info, `
              + "status, identity, interrupt, clear_queue, set_hash_models, reveal, "
              + "list_unrecorded, adopt_unrecorded.",
          });
          return true;
      }
    } catch (err) {
      /* A graph this engine cannot run says WHICH of the two ComfyUI save
       * formats it looks like — see record.js. The problems array rides along
       * so a caller can act on it without parsing prose. */
      /* A refusal of sexual content involving minors is its own answer: 422,
       * the one sentence and its code, the same as every other door. */
      if (err?.safety) {
        json(res, 422, { error: String(err.message), code: err.code, ...(err.hint ? { hint: err.hint } : {}), ...(err.found ? { found: err.found } : {}) });
        return true;
      }
      json(res, 400, { error: String(err.message || err), problems: err.problems || undefined });
      return true;
    }
  }

  handle.adopt = adopt;
  handle.sameOriginBrowser = sameOriginBrowser;
  return handle;
}

export default createEngineRoutes;
