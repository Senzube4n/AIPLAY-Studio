/**
 * The derivative that makes music LoRA training possible, checked.
 *
 * server/comfy_nodes/aiplay_rope_autograd.py supplies the backward pass that
 * comfy_kitchen's rotary-embedding kernels never had — the single thing that
 * stopped a gradient leaving the first attention block of the DiT YuE2 rides
 * on. The formula there is hand-derived from the op's documented forward, and a
 * hand-derived gradient that is subtly wrong is the worst kind of bug available
 * here: it does not crash, it trains at full speed on gradients pointing
 * somewhere other than downhill, and the resulting LoRA is blamed on the
 * dataset for a fortnight.
 *
 * So it is checked against autograd through a pure-torch reimplementation, in
 * float64, including a real cos/sin rotation rather than only random matrices.
 *
 *   node scripts/yue2_rope_grad_test.mjs
 *
 * Skips rather than fails where the engine's python is not installed: this is a
 * lane on a laptop as well as on the rig.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../server/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, "rope_grad_check.py");
const python = config.python;

if (!python || !existsSync(python)) {
  console.log(`SKIP — the engine's python is not at ${python || "(unset)"}, so the`);
  console.log("       derivative cannot be checked on this machine. Not a failure:");
  console.log("       this lane needs torch, and torch lives in the engine's venv.");
  process.exit(0);
}

const child = spawn(python, [CHECK], { stdio: "inherit" });
child.on("error", (e) => {
  console.log(`SKIP — could not run ${python}: ${e.message}`);
  process.exit(0);
});
child.on("exit", (code) => {
  if (code === 0) {
    console.log("\n1 lane passed — rotary embeddings differentiate correctly.");
    process.exit(0);
  }
  console.log("\nTHE ROPE DERIVATIVE IS WRONG. Do not train through it: the run will");
  console.log("succeed and the adapter will have learned from the wrong direction.");
  process.exit(1);
});
