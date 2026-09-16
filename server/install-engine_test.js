/**
 * scripts/install-engine.mjs without the network: which PyTorch command each
 * card gets, and the safety rules around the folders it may delete.
 *   node server/install-engine_test.js
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLaunchArgs } from "./comfyargs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "install-engine.mjs");
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-install-engine-"));
const README = path.join(tmp, "README.md");
writeFileSync(README, `
### AMD GPUs (Windows, ROCm 10.0)
| GPU | Device extra |
| --- | --- |
| RX 9070 / XT, Radeon AI PRO R9700 | \`device-gfx1201\` |
| RX 9060 / XT | \`device-gfx1200\` |
| RX 7900 XT / XTX | \`device-gfx1100\` |
| Ryzen AI Max / Max+ (Strix Halo) | \`device-gfx1151\` |

\`\`\`bat
pip install --index-url https://stable.repo.amd.com/rocm/whl-next/ "torch[device-all]==9.9.0+rocm99" "torchvision[device-all]==9.9.0+rocm99"
\`\`\`

### Intel GPUs (Windows and Linux)
\`\`\`pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/xpu\`\`\`

### NVIDIA
\`\`\`pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu999\`\`\`
\`\`\`pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu999\`\`\`
`);

const plan = (backend, gpu, readme = README) => JSON.parse(execFileSync(process.execPath,
  [SCRIPT, "--backend", backend, "--gpu-name", gpu, "--plan", readme], { encoding: "utf8" }).trim());

console.log("\nWHICH PYTORCH EACH CARD GETS");
const amd = plan("amd", "AMD Radeon RX 9060 XT");
if (process.platform === "win32") {
  ok("RX 9060 XT gets only its own kernels", amd.args.includes("torch[device-gfx1200]==9.9.0+rocm99") && !amd.cmd.includes("device-all"), amd.cmd);
  ok("...on Python 3.13", amd.python === "3.13");
  ok("the command is read from the README, not the fallback", amd.cmd.includes("rocm99"));
  ok("Strix Halo maps to gfx1151", plan("amd", "AMD Radeon(TM) 8060S Graphics").cmd.includes("device-gfx1151"));
  ok("an unlisted AMD card keeps device-all", plan("amd", "AMD Radeon RX 6700 XT").cmd.includes("device-all"));
}
const nv = plan("nvidia", "NVIDIA GeForce RTX 4090");
ok("NVIDIA takes the stable line, not --pre nightly", nv.cmd.includes("cu999") && !nv.cmd.includes("--pre"), nv.cmd);
const old = plan("nvidia", "NVIDIA GeForce GTX 1080 Ti");
ok("a GTX 10-series card gets the CUDA 12.6 build on Python 3.12", old.cmd.includes("cu126") && old.python === "3.12", old.cmd);
ok("Intel reads the XPU line", plan("intel", "Intel(R) Arc(TM) A770").cmd.includes("/whl/xpu"));
ok("CPU uses the CPU wheel index", process.platform === "darwin" || plan("cpu", "").cmd.includes("/whl/cpu"));
const empty = path.join(tmp, "EMPTY.md");
writeFileSync(empty, "# nothing here\n");
ok("a README without the sections falls back to built-in commands", plan("nvidia", "RTX 5090", empty).cmd.includes("download.pytorch.org/whl/cu"));

console.log("\nFOLDERS IT MAY AND MAY NOT TOUCH");
const run = (env, args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
const bad = run({ AIPLAY_APPDATA: path.join(tmp, "appdata") }, ["--backend", "quantum"]);
ok("an unknown backend is refused with a readable error", bad.status === 1 && /@@error .*nvidia, amd, intel or cpu/.test(bad.stdout), bad.stdout);

const theirs = path.join(tmp, "someone-elses-folder");
mkdirSync(theirs);
writeFileSync(path.join(theirs, "precious.txt"), "do not delete");
const refused = run({ AIPLAY_APPDATA: path.join(tmp, "appdata"), AIPLAY_ENGINE_DIR: theirs }, ["--backend", "cpu"]);
ok("a non-empty folder without the installer's marker is refused", refused.status === 1 && /was not made by this installer/.test(refused.stdout), refused.stdout);
ok("...and left exactly as it was", existsSync(path.join(theirs, "precious.txt")) && readFileSync(path.join(theirs, "precious.txt"), "utf8") === "do not delete");
ok("...with no settings written", !existsSync(path.join(tmp, "appdata", "settings.json")));

console.log("\nCPU ENGINE LAUNCH FLAGS");
const cpuArgs = buildLaunchArgs({ tierFlags: ["--lowvram", "--async-offload", "4"], installFlags: ["--cpu"] });
ok("--cpu drops the tier's --lowvram and offload streams (argparse would refuse them)", cpuArgs.join(" ") === "--cpu", cpuArgs.join(" "));
const gpuArgs = buildLaunchArgs({ tierFlags: ["--lowvram", "--async-offload", "4"], installFlags: ["--use-ck-attention"] });
ok("a GPU engine keeps them", gpuArgs.join(" ") === "--lowvram --async-offload 4 --use-ck-attention", gpuArgs.join(" "));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
