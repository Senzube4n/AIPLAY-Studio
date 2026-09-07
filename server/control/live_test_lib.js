/**
 * ASK THE DOOR WHAT THIS INSTALL REALLY HAS — the live half of the two control
 * suites, and the one line that closes their entry in the bypass census.
 *
 * ⚠ WHAT THIS REPLACES, because the shape of the mistake is the useful part.
 * `pose_test.js` and `vace_test.js` each used to do
 *
 *     const r = await fetch(`${engineBase()}/object_info`)
 *
 * which found a live engine BY GUESSING port 8266 — the side door wearing a lab
 * coat. After the engine door landed there is no published engine base at all,
 * `engineBase()` returned null, and both probes took their "no engine, skip
 * loudly" branch every single time while printing the word `null` where a URL
 * used to be. Measured on 2026-09-03: both suites were the same size before and
 * after that change, because the check had already stopped running.
 *
 * So the check is not deleted, it is ASKED PROPERLY. The application's own door
 * answers the same question and needs no address: `POST /api/engine` with
 * `{action:"object_info"}` and an actor header. It works exactly when the app is
 * running — which is also exactly when there is an engine to ask about — and it
 * is attributed, so even a test's read of the engine is a thing the ledger's
 * reader could account for.
 *
 * WHY A SHARED FILE FOR TWELVE LINES. Two copies of a hardened thing decay into
 * one hardened thing and one that looks like it; that is this repository's own
 * rule (server/engine/client.js's poll loop against scripts/gate_lib.mjs) and it
 * applies at any size. Both suites need the identical question, the identical
 * skip sentence and the identical actor discipline.
 */
import { config } from "../config.js";

/** The app's own base. NOT the engine's — that number is module-private inside
 *  server/engine/client.js and nothing here is entitled to it. */
const APP = `http://127.0.0.1:${config.uiPort}`;

/**
 * askObjectInfo(who) -> { nodes, why }
 *
 * `nodes` is the engine's own node table when the app answered, and null when
 * it did not; `why` is the sentence to print in that case. A machine running the
 * pre-commit hook with the app down is the normal case, and it must skip LOUDLY
 * rather than pass quietly — so the caller prints `why` and counts the
 * assertions it did not make.
 *
 * `who` becomes the actor: `script:<who>`. The door refuses a request it cannot
 * attribute, which is the rule that stopped 424 renders being anonymous, and a
 * test is not exempt from it.
 */
export async function askObjectInfo(who) {
  const url = `${APP}/api/engine`;
  let r, body;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-aiplay-actor": `script:${who}` },
      body: JSON.stringify({ action: "object_info" }),
      signal: AbortSignal.timeout(30_000),
    });
    body = await r.json();
  } catch (e) {
    return { nodes: null, why:
      `no AIPLAY Studio at ${url} (${e.message}), so the graph was not checked against what this `
      + `install really has. That is the normal state of a machine running the hook — and it is `
      + `now the ONLY state in which this check skips, because the engine has no address of its `
      + `own to guess at any more.` };
  }
  if (!r.ok) {
    return { nodes: null, why: `the door refused (HTTP ${r.status}): ${String(body?.error ?? "").slice(0, 300)}` };
  }
  /* The engine may be down while the app is up — the door answers, the question
   * does not. Reported as a skip with the door's own words rather than as a
   * failure of the graph. */
  if (!body?.nodes || typeof body.nodes !== "object") {
    return { nodes: null, why: "the app answered but the engine did not — no node table to check against." };
  }
  return { nodes: body.nodes, why: null };
}

/**
 * A combo's option list, whichever of the two shapes the node declares.
 *
 * Older nodes (DWPreprocessor) put the array in slot 0; newer ones (LoadVideo)
 * say "COMBO" and put `options` in slot 1. Both are read, so the membership
 * check really runs on both rather than silently skipping the new one — a check
 * that skips is the failure mode this whole file exists to fix.
 */
export function comboOptions(decl) {
  if (Array.isArray(decl?.[0])) return decl[0];
  if (decl?.[0] === "COMBO" && Array.isArray(decl?.[1]?.options)) return decl[1].options;
  return null;
}

/**
 * Every class, every required input and every combo value in a built graph,
 * checked against the live node table. Returns the problems, so the caller
 * decides what to say about them.
 */
export function graphProblemsAgainst(nodes, graph) {
  const problems = [];
  for (const [id, node] of Object.entries(graph)) {
    const spec = nodes[node.class_type];
    if (!spec) { problems.push(`node ${id}: the engine has no ${node.class_type}`); continue; }
    const req = spec.input?.required || {};
    const opt = spec.input?.optional || {};
    for (const name of Object.keys(req)) {
      if (!(name in node.inputs)) problems.push(`${node.class_type} ${id}: required input ${name} is missing`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const decl = req[name] || opt[name];
      if (!decl) { problems.push(`${node.class_type} ${id}: ${name} is not an input this node has`); continue; }
      const opts = comboOptions(decl);
      if (opts && !Array.isArray(value) && !opts.includes(value)) {
        problems.push(`${node.class_type} ${id}: ${name}=${JSON.stringify(value)} is not one of the engine's options`);
      }
    }
  }
  return problems;
}
