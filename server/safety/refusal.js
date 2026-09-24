/**
 * THE REFUSAL: one sentence, one error shape, one ledger event.
 *
 * Every door that refuses sexual content involving minors answers the same
 * way, so a person, the UI, an MCP agent and the overnight runner all read the
 * same words and the same code:
 *
 *   HTTP 422  { error: REFUSAL[ + " " + hint], code: "minor-sexual", hint?, found? }
 *
 * and nothing is queued. `error` always STARTS with the sentence; when there
 * is something the person can do about it ("put 'no children' in the negative
 * prompt", "part of it comes from a picture this request uses") that follows
 * it, in `error` itself, because that is the field every client already shows.
 * `found` says WHERE each half came from ("prompt" or "context"), never what.
 *
 * The ledger records THAT a refusal happened, where, and for whom, as an event
 * of type "refused" carrying the code, the door and the caller id. It carries
 * no prompt, no label, no title and no hash of any of them: a hash of a short
 * prompt is a lookup key, not an anonymisation (provenance.js measured 305 of
 * 419 prompt hashes recovered that way), and a refused prompt is the last
 * thing this app should file.
 *
 * WHO WRITES THE EVENT. The engine door writes its own, through the ledger it
 * was built with (server/engine/client.js), because it is the choke point and
 * its test hands it a ledger to watch. Everything else ANNOUNCES the refusal
 * here and server/index.js, which owns the app's ledger, files it through the
 * one listener it registers at boot. That keeps the pure modules that refuse
 * (collab orders, video recipes, overnight plans, the Comfy Router queue, the
 * enhancer) free of the ledger, so their own tests can never write into the
 * owner's real one.
 */
import { CODE, REFUSAL, checkPrompt } from "./minors.js";

export { CODE, REFUSAL };

/** The ledger scope-free event for one refusal. Nothing in it is words. */
export function refusalEvent({ door, via = null, actor = "system", code = CODE } = {}) {
  return {
    actor,
    type: "refused",
    asset: "safety/refusals",
    /* Belt and braces: a private event is redacted by provenance.js even if a
     * text field were ever added here by mistake. */
    private: true,
    data: {
      code: String(code || CODE).slice(0, 40),
      door: String(door || "unknown").slice(0, 60),
      via: via ? String(via).slice(0, 60) : null,
    },
  };
}

/** The words a refusal answers with: the sentence, then the hint if any. */
export const refusalText = ({ reason = REFUSAL, hint = null } = {}) => (hint ? `${reason} ${hint}` : reason);

/** The error a refusing module throws. `status` and `reason` are what the
 *  existing route catches already read, so a refusal reaches the caller as a
 *  422 with this sentence without each catch learning a new field. */
export function safetyError({ door = null, hint = null, code = CODE, reason = REFUSAL, found = null } = {}) {
  const e = new Error(refusalText({ reason, hint }));
  e.code = code;
  e.reason = code;
  e.status = 422;
  e.safety = true;
  e.door = door;
  if (hint) e.hint = hint;
  if (found) e.found = found;
  return e;
}

/** The JSON body of a 422. */
export const refusalBody = ({ hint = null, code = CODE, reason = REFUSAL, found = null } = {}) => ({
  error: refusalText({ reason, hint }), code, ...(hint ? { hint } : {}), ...(found ? { found } : {}),
});

/** The body of a 422 for an error a refusing module threw. */
export const bodyOfError = (err) => ({
  error: String(err?.message || REFUSAL), code: err?.code || CODE,
  ...(err?.hint ? { hint: err.hint } : {}), ...(err?.found ? { found: err.found } : {}),
});

const listeners = new Set();

/** Register the app's ledger writer. Returns the unsubscribe. */
export function onRefusal(fn) {
  if (typeof fn !== "function") throw new TypeError("onRefusal takes a function");
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tell the ledger writer a refusal happened. A listener that throws is its
 *  own problem: the refusal stands whatever the ledger does. */
export function announceRefusal({ door, via = null, actor = "system", code = CODE } = {}) {
  const evt = refusalEvent({ door, via, actor, code });
  for (const fn of listeners) {
    try {
      const r = fn(evt);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* the refusal stands */ }
  }
  return evt;
}

/**
 * Check, and on a refusal announce it. Returns null when the words may be
 * rendered, or the 422 body when they may not. For routes:
 *
 *   const no = safetyRefusal({ door: "api.image", actor, texts: [finalPrompt] });
 *   if (no) return json(res, 422, no);
 *
 * `context` is words behind the pictures the request uses; `flags` is the
 * wordless fingerprint those pictures carry (server/safety/lineage.js).
 */
export function safetyRefusal({ door, via = null, actor = "system", texts = [], context = [], flags = [] } = {}) {
  const verdict = checkPrompt(texts, { context, flags });
  if (verdict.ok) return null;
  announceRefusal({ door, via, actor });
  return refusalBody({ hint: verdict.hint, found: verdict.found });
}

/** The same, for modules that throw: announces and throws safetyError. */
export function assertSafe({ door, via = null, actor = "system", texts = [], context = [], flags = [] } = {}) {
  const verdict = checkPrompt(texts, { context, flags });
  if (verdict.ok) return;
  announceRefusal({ door, via, actor });
  throw safetyError({ door, hint: verdict.hint, found: verdict.found });
}
