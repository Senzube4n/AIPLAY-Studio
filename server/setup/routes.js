/**
 * POST /api/setup — the one-click setups (server/setup/venv.js).
 *
 *   { action: "status", id? }            what each setup would build, where, how big,
 *                                         and its job's state. Open: it runs nothing new.
 *   { action: "run", id, torch? }        start it. Runs programs and writes the
 *                                         interpreter Studio uses, so only Studio's own
 *                                         page or a local client may: sameOriginLocalJson,
 *                                         the guard every door that chooses what runs uses.
 *
 * `torch` ("auto", "cu126" or "cpu") is the number behind the button: "auto"
 * follows the card as read, the other two choose. It means nothing to a setup
 * that builds no Python (studio-packages) and is ignored there.
 *
 * The ids: "lyrics" (server/setup/venv.js, a private Python for timed lyrics)
 * and "studio-packages" (server/setup/engine-packages.js, Studio's own OpenCV,
 * librosa, soundfile and SciPy again, into an engine Studio installed, only
 * the ones that do not import).
 *
 * A setup that would change nothing answers 409 with the sentence saying why
 * (AIPLAY_WHISPER_PYTHON names the interpreter; an engine Studio did not
 * install; Studio running a python other than its engine's own), and nothing
 * is fetched.
 *
 * The same door serves the Models row, Settings > Songs, every refusal that
 * carries a setup id (the "Time the lyrics" refusal, and a missing module in
 * hum-to-score, the tokenizer, the compositor or the DAW), and the MCP tools
 * setup_feature and setup_status.
 */
import { TORCH_CHOICES } from "./venv.js";

/** Several runners ({ has, ids, run, status }) as one: each id is served by
 *  the runner that has it, and status lists every runner's setups. */
export function oneRunner(...runners) {
  const owner = (id) => runners.find((r) => r.has(id));
  return {
    ids: runners.flatMap((r) => r.ids),
    has: (id) => !!owner(id),
    run: (id, opts) => owner(id).run(id, opts),
    async status(id = null) {
      const parts = await Promise.all(runners.filter((r) => !id || r.has(id)).map((r) => r.status(id)));
      return { setups: parts.flatMap((p) => p.setups || []) };
    },
  };
}

export function createSetupRoutes({ json, readBody, sameOriginLocalJson, runner }) {
  return async (req, res, url) => {
    if (url.pathname !== "/api/setup") return false;
    if (req.method !== "POST") {
      json(res, 405, { error: "Use POST with an action: run or status." });
      return true;
    }
    let b;
    /* Small by construction: an id and two words. Capped while reading, before
     * JSON.parse sees a byte. */
    try { b = await readBody(req, 4096); }
    catch (e) {
      json(res, e?.tooBig ? 413 : 400, { error: e?.tooBig ? "That request is too large for /api/setup." : "The request body is not JSON." });
      return true;
    }
    const action = String(b?.action || "");
    switch (action) {
      case "status": {
        const id = b.id === undefined || b.id === null || b.id === "" ? null : String(b.id);
        if (id && !runner.has(id)) {
          json(res, 400, { error: `No setup called "${id}". There is: ${runner.ids.join(", ")}.` });
          return true;
        }
        json(res, 200, await runner.status(id));
        return true;
      }
      case "run": {
        if (!sameOriginLocalJson(req)) {
          json(res, 403, { error: "Starting a setup requires a same-origin local JSON request." });
          return true;
        }
        const id = String(b.id || "");
        if (!runner.has(id)) {
          json(res, 400, { error: `No setup called "${id}". There is: ${runner.ids.join(", ")}.` });
          return true;
        }
        const torch = b.torch === undefined || b.torch === null ? "auto" : String(b.torch);
        if (!TORCH_CHOICES.includes(torch)) {
          json(res, 400, { error: `torch must be one of: ${TORCH_CHOICES.join(", ")}.` });
          return true;
        }
        const job = await runner.run(id, { torch });
        if (job?.state === "blocked") {
          json(res, 409, { error: job.message, job });
          return true;
        }
        json(res, 200, { ok: true, job });
        return true;
      }
      default:
        json(res, 400, { error: "Unknown action. Try: run, status." });
        return true;
    }
  };
}
