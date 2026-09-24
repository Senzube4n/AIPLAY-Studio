/**
 * POST /api/safety/check — the engine's own backstop asks here.
 *
 * Only server/comfy_nodes/aiplay_safety_gate.py calls this, with the per-boot
 * token the supervisor put in its environment (server/safety/backstop.js). It
 * answers a verdict on a whole ComfyUI graph with the same checkGraph the
 * engine door uses, so the two can never disagree about what is refused.
 *
 *   200 { ok: true }                                   render it
 *   200 { ok: false, error: REFUSAL, code }            swap it out
 *   403                                                wrong or missing token
 *
 * A refusal here is announced like every other one, filed as a `refused`
 * event with door "engine.backstop" and no words.
 */
import { timingSafeEqual } from "node:crypto";
import { checkGraph } from "./graph.js";
import { announceRefusal, refusalText, CODE, REFUSAL } from "./refusal.js";
import { BACKSTOP_PATH } from "./backstop.js";

/** The biggest graph the backstop reads. A graph can carry pictures inline
 *  (base64 inputs), so this is generous; anything larger is refused rather
 *  than waved through unread. */
const MAX_GRAPH_BYTES = 256 * 1024 * 1024;
export const UNREADABLE = "The Studio could not read this graph, so it was not run.";

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ""), "utf8"), y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export function createSafetyRoutes({ json, readBody, token }) {
  if (typeof token !== "string" || token.length < 16) throw new Error("createSafetyRoutes needs the backstop token.");
  return async function handle(req, res, url) {
    if (url.pathname !== BACKSTOP_PATH) return false;
    if (req.method !== "POST") { json(res, 405, { error: "POST a graph." }); return true; }
    if (!sameToken(req.headers?.["x-aiplay-safety-token"], token)) {
      json(res, 403, { error: "Only this Studio's engine may ask here." });
      return true;
    }
    /* A graph this cannot read is not waved through: the engine is told no,
     * with a sentence that says why. Not filed as a minors refusal, because
     * nothing was found; it was never read. */
    let b;
    try { b = await readBody(req, MAX_GRAPH_BYTES); }
    catch {
      json(res, 200, { ok: false, error: UNREADABLE, code: "unreadable" });
      return true;
    }
    const verdict = checkGraph(b?.prompt);
    if (verdict.ok) { json(res, 200, { ok: true }); return true; }
    announceRefusal({ door: "engine.backstop", via: "comfyui", actor: "system", code: verdict.code });
    json(res, 200, { ok: false, error: refusalText({ reason: verdict.reason || REFUSAL, hint: verdict.hint }), code: verdict.code || CODE });
    return true;
  };
}
