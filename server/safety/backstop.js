/**
 * THE BACKSTOP INSIDE THE ENGINE — how ComfyUI asks this Studio.
 *
 * The check in the engine door (server/engine/client.js) covers everything
 * this app sends. It cannot cover a POST that never passes through Node: the
 * port handed out by engine_reveal_port, ComfyUI's own web page, or a script
 * on a pinned port (AIPLAY_COMFY_PORT). So the Studio deploys its own node,
 * server/comfy_nodes/aiplay_safety_gate.py, which registers an on_prompt
 * handler that sends every submitted graph back here for a verdict and swaps a
 * refused graph for one that cannot run.
 *
 * The handler learns WHERE to ask and a per-boot TOKEN from its environment;
 * the supervisor (server/comfy.js) sets both when it spawns the engine. The
 * token keeps the check door from being a thing a web page can poke to fill
 * the ledger with refusals. A ComfyUI started by hand, with neither variable,
 * leaves the node inert: it is then simply a ComfyUI, which this app does not
 * govern.
 *
 * ⚠ THE HANDLER FAILS CLOSED WHEN THE VARIABLES ARE SET AND THE STUDIO CANNOT
 * ANSWER. A Studio-launched engine whose Studio is gone refuses every prompt
 * rather than render unchecked.
 */
import { randomBytes } from "node:crypto";

/** Fresh at every start of the server, never written to disk. */
export const BACKSTOP_TOKEN = randomBytes(24).toString("hex");

export const BACKSTOP_PATH = "/api/safety/check";

/** The environment the engine is spawned with, beside the python one. */
export function backstopEnv(uiPort) {
  return {
    AIPLAY_SAFETY_URL: `http://127.0.0.1:${Number(uiPort)}${BACKSTOP_PATH}`,
    AIPLAY_SAFETY_TOKEN: BACKSTOP_TOKEN,
  };
}
