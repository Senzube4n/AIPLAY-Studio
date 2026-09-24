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
import { createHash } from "node:crypto";
import net from "node:net";
import { buildLaunchArgs } from "./comfyargs.js";
import { COMFY_TAG, comfyArchiveUrl, comfyPinNote, UV_VERSION, uvPin, keptUvPath, UV_PYTHON_INSTALL_ARGS, UV_PRIVATE_ENV } from "./setup/pins.js";
import { ensureUv } from "./setup/uv.js";
import { STUDIO_PACKAGES, constraintsText, MODULES_PROBE, VERSIONS_PROBE, studioWarning } from "./setup/studio-packages.js";

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

console.log("\nWHICH COMFYUI, AND THE STUDIO PACKAGES STEP (S2, S3)");
const src = readFileSync(SCRIPT, "utf8");
const full = plan("nvidia", "NVIDIA GeForce RTX 4070 Ti SUPER");
ok("the steps put Studio's own packages after ComfyUI's requirements and before verify",
  full.steps?.join(",") === "space,uv,comfy,python,torch,deps,studio,verify,test,save", JSON.stringify(full.steps));
ok("ComfyUI is the pinned tag, from the constant, as a tag archive",
  full.comfy?.tag === COMFY_TAG && COMFY_TAG === "v0.36.0" && full.comfy.url === comfyArchiveUrl(COMFY_TAG)
    && /\/archive\/refs\/tags\/v0\.36\.0\.tar\.gz$/.test(full.comfy.url), JSON.stringify(full.comfy));
ok("...and the installer never asks for ComfyUI's latest release or the main branch",
  !/releases\/latest/.test(src) && !/refs\/heads\/master/.test(src));
ok("the packages are OpenCV (headless), librosa and soundfile", STUDIO_PACKAGES.join(" ") === "opencv-python-headless librosa soundfile");
ok("uv installs the engine's Python with no ~/.local/bin copy and no registry entry",
  JSON.stringify(full.uvPythonInstall) === JSON.stringify(["python", "install", "--no-bin", "--no-registry", full.python])
    && full.uvEnv?.UV_PYTHON_INSTALL_BIN === "0" && full.uvEnv?.UV_PYTHON_INSTALL_REGISTRY === "0", JSON.stringify([full.uvPythonInstall, full.uvEnv]));
ok("...the install runs exactly that (the same constants, not a copy)",
  /await exec\(uv, \["python", "install", \.\.\.UV_PYTHON_INSTALL_ARGS, plan\.python\], \{ env: uvEnv \}\);/.test(src)
    && /const uvEnv = \{ \.\.\.UV_PRIVATE_ENV, UV_PYTHON_INSTALL_DIR:/.test(src)
    && UV_PYTHON_INSTALL_ARGS.join(" ") === "--no-bin --no-registry" && UV_PRIVATE_ENV.UV_PYTHON_INSTALL_REGISTRY === "0");
const pins = constraintsText({ torch: "2.13.0+cu130", numpy: "2.2.6", torchaudio: "2.11.0+cu130", pillow: "12.0.0" });
ok("the constraints file carries the probed torch and numpy, exactly as installed",
  pins === "torch==2.13.0+cu130\ntorchaudio==2.11.0+cu130\nnumpy==2.2.6\n", JSON.stringify(pins));
ok("...and pins nothing it was not asked to (Pillow is ComfyUI's to move)", !/pillow/i.test(pins));
let noTorch = null;
try { constraintsText({ numpy: "2.2.6" }); } catch (e) { noTorch = e.message; }
ok("an engine with no torch is refused rather than pinned against nothing", /no torch installed/.test(noTorch || ""), noTorch);
ok("pip is handed the file with -c, and the file goes in the marked engine folder",
  /pip\(\[\.\.\.STUDIO_PACKAGES, "-c", file\]\)/.test(src) && /path\.join\(ROOT, "studio-constraints\.txt"\)/.test(src));
ok("the probes are real imports, and read versions through importlib.metadata",
  /importlib\.import_module\(n\)/.test(MODULES_PROBE) && /m\.version\(n\)/.test(VERSIONS_PROBE));
ok("a Studio-package failure is a sentence that names what needs them and the retry",
  /Clip posters, the compositor, hum-to-score and the DAW bounce/.test(studioWarning(["cv2"]) || "")
    && /press Try again beside "Studio's own packages" in the launcher/.test(studioWarning(["cv2"]) || "")
    && /--studio-packages/.test(studioWarning(["cv2"]) || "") && studioWarning([]) === null);
ok("the pin note speaks only about Studio's own engine on another tag",
  /is v0\.35\.0, but this version of Studio is tested with v0\.36\.0/.test(comfyPinNote({ complete: true, comfy: "v0.35.0" }) || "")
    && /is the main branch/.test(comfyPinNote({ complete: true, comfy: null }) || "")
    && comfyPinNote({ complete: true, comfy: COMFY_TAG }) === null && comfyPinNote(null) === null
    && comfyPinNote({ complete: false, comfy: "v0.1.0" }) === null);
ok("setup.mjs reads the engine folder's own marker for it", /comfyPinNote\(engineMark\)/.test(readFileSync(path.join(ROOT, "scripts", "setup.mjs"), "utf8")));
{
  /* The whole of setup.mjs --json on a Studio-owned engine from before the pin.
   * The saved python, card and torch are what a finished install recorded, so
   * nothing is detected or imported: only the marker is read. */
  const rig = path.join(tmp, "old-engine");
  const py = process.platform === "win32" ? path.join(rig, "venv", "Scripts", "python.exe") : path.join(rig, "venv", "bin", "python");
  mkdirSync(path.join(rig, "ComfyUI"), { recursive: true });
  mkdirSync(path.dirname(py), { recursive: true });
  writeFileSync(path.join(rig, "ComfyUI", "main.py"), "");
  writeFileSync(py, "");
  writeFileSync(path.join(rig, ".aiplay-engine.json"), JSON.stringify({ backend: "nvidia", complete: true, comfy: "v0.35.0" }));
  const data = path.join(tmp, "pin-appdata");
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, "settings.json"), JSON.stringify({ rig, python: py, torchBackend: "cuda", torchVersion: "2.13.0+cu130",
    gpu: { vendor: "nvidia", name: "Test card", totalMb: 16376, source: "test" }, launchFlagsSync: false, engineInstall: { backend: "nvidia", comfy: "v0.35.0" } }));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "setup.mjs"), "--json"], { encoding: "utf8", env: { ...process.env, AIPLAY_APPDATA: data, AIPLAY_RIG: "" }, timeout: 30_000 });
  const report = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || "{}");
  ok("setup.mjs --json warns about a Studio-owned engine on another ComfyUI, and reports both tags",
    report.ok && report.notes.some((n) => /is v0\.35\.0, but this version of Studio is tested with v0\.36\.0/.test(n))
      && report.comfyPin?.pinned === "v0.36.0" && report.comfyPin?.installed === "v0.35.0", r.stdout.slice(-600));
}

console.log("\nTHE KEPT UV (S4)");
const appdata = path.join(tmp, "uv-appdata");
ok("uv is kept outside the engine folder and its download cache",
  full.uv && !full.uv.toLowerCase().startsWith(full.cache.toLowerCase()) && !full.uv.toLowerCase().startsWith(full.root.toLowerCase())
    && /[\\/]tools[\\/]uv[\\/]uv(\.exe)?$/.test(full.uv), JSON.stringify({ uv: full.uv, cache: full.cache, root: full.root }));
ok("every uv archive this machine could ask for has a published SHA-256 pinned",
  ["win32", "darwin", "linux"].every((p) => ["x64", "arm64"].every((a) => /^[0-9a-f]{64}$/.test(uvPin(p, a).sha256 || "")))
    && uvPin("win32", "x64").url === `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`);
{
  /* A fixture archive holding a stand-in uv, served by a fake fetch: the
   * checksum is the fixture's own, so the whole path runs with no network. */
  const win = process.platform === "win32";
  const stage = path.join(tmp, "uv-stage", "uv-9.9.9");
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, win ? "uv.exe" : "uv"), "stand-in uv");
  const asset = win ? "uv-x86_64-pc-windows-msvc.zip" : "uv-x86_64-unknown-linux-gnu.tar.gz";
  const archive = path.join(tmp, asset);
  const tar = win ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, win ? ["-a", "-cf", archive, "-C", path.dirname(stage), "uv-9.9.9"] : ["-czf", archive, "-C", path.dirname(stage), "uv-9.9.9"]);
  const bytes = readFileSync(archive);
  const sha = createHash("sha256").update(bytes).digest("hex");
  let fetches = 0;
  const serve = async () => { fetches++; return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }); };
  const pin = { version: "9.9.9", asset, sha256: sha, url: "https://example.invalid/uv" };
  const exe = await ensureUv({ appData: appdata, pin, fetchImpl: serve });
  ok("a verified archive is unpacked to <app data>/tools/uv", exe === keptUvPath(appdata) && readFileSync(exe, "utf8") === "stand-in uv", exe);
  const receipt = JSON.parse(readFileSync(path.join(appdata, "tools", "uv", "uv.json"), "utf8"));
  ok("...with a receipt naming the version and checksum it was checked against", receipt.version === "9.9.9" && receipt.sha256 === sha);
  ok("...and the download folder is gone", !existsSync(path.join(appdata, "tools", "uv-download")));
  const again = await ensureUv({ appData: appdata, pin, fetchImpl: async () => { throw new Error("must not download"); } });
  ok("a kept uv with a matching receipt is reused without a download", again === exe && fetches === 1);
  let bad = null;
  try { await ensureUv({ appData: appdata, pin: { ...pin, version: "9.9.10", sha256: "0".repeat(64) }, fetchImpl: serve }); }
  catch (e) { bad = e.message; }
  ok("an archive that does not hash to the pin is refused, deleted and never unpacked",
    /did not match its published checksum/.test(bad || "") && !existsSync(path.join(appdata, "tools", "uv-download"))
      && JSON.parse(readFileSync(path.join(appdata, "tools", "uv", "uv.json"), "utf8")).version === "9.9.9", bad);
}

console.log("\nA FAILED INSTALL KEEPS THE CACHES (S4)");
{
  /* A closed port for ComfyUI's download: the install fails at "comfy" (or at
   * "space" on a nearly full temp drive), with no network either way. */
  const closed = await new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const engine = path.join(tmp, "fail", "engine");
  const cache = `${engine}-cache`;
  const failData = path.join(tmp, "fail", "appdata");
  mkdirSync(path.join(cache, "pip"), { recursive: true });
  writeFileSync(path.join(cache, ".aiplay-engine-cache"), "made by scripts/install-engine.mjs; safe to delete");
  writeFileSync(path.join(cache, "pip", "torch-2.13.0-cp313-win_amd64.whl"), "three gigabytes, notionally");
  // A previous attempt that did not finish, and a kept uv from an earlier install.
  mkdirSync(path.join(engine, "ComfyUI"), { recursive: true });
  writeFileSync(path.join(engine, ".aiplay-engine.json"), JSON.stringify({ backend: "cpu", complete: false }));
  const uvDir = path.join(failData, "tools", "uv");
  mkdirSync(uvDir, { recursive: true });
  const keptExe = keptUvPath(failData);
  writeFileSync(keptExe, "kept");
  writeFileSync(path.join(uvDir, "uv.json"), JSON.stringify({ version: UV_VERSION, sha256: uvPin().sha256 }));
  const failed = run({ AIPLAY_APPDATA: failData, AIPLAY_ENGINE_DIR: engine, AIPLAY_COMFY_ARCHIVE_URL: `http://127.0.0.1:${closed}/comfy.tar.gz` }, ["--backend", "cpu"]);
  const err = /@@error (.*)/.exec(failed.stdout);
  ok("the install fails with a sentence naming the host it could not reach (or the disk that is full)",
    failed.status === 1 && !!err && /Could not reach 127\.0\.0\.1:\d+ to download ComfyUI|Not enough disk space/.test(err[1]), failed.stdout.slice(-600));
  ok("...the marked engine folder is removed", !existsSync(engine));
  ok("...the pip and uv download cache is kept", readFileSync(path.join(cache, "pip", "torch-2.13.0-cp313-win_amd64.whl"), "utf8") === "three gigabytes, notionally");
  ok("...and so is the kept uv", readFileSync(keptExe, "utf8") === "kept");
  ok("...and the log says so", /download cache .* stay/.test(failed.stdout), failed.stdout.slice(-400));
  ok("...with no settings written", !existsSync(path.join(failData, "settings.json")));
}

console.log("\n--studio-packages ONLY TOUCHES A FINISHED ENGINE STUDIO MADE (S2)");
{
  const theirs2 = path.join(tmp, "their-comfy");
  mkdirSync(path.join(theirs2, "venv"), { recursive: true });
  writeFileSync(path.join(theirs2, "keep.txt"), "mine");
  const r = run({ AIPLAY_APPDATA: path.join(tmp, "appdata2"), AIPLAY_ENGINE_DIR: theirs2 }, ["--studio-packages"]);
  ok("a folder without the installer's marker is refused, before any pip",
    r.status === 1 && /no finished engine made by this installer/.test(r.stdout) && !/Pinned so pip/.test(r.stdout), r.stdout);
  ok("...and nothing in it is touched", readFileSync(path.join(theirs2, "keep.txt"), "utf8") === "mine" && existsSync(path.join(theirs2, "venv")));
  writeFileSync(path.join(theirs2, ".aiplay-engine.json"), JSON.stringify({ complete: false }));
  const half = run({ AIPLAY_APPDATA: path.join(tmp, "appdata2"), AIPLAY_ENGINE_DIR: theirs2 }, ["--studio-packages"]);
  ok("an unfinished engine is refused too, and never cleaned up by this path",
    half.status === 1 && /no finished engine/.test(half.stdout) && existsSync(path.join(theirs2, "keep.txt")), half.stdout);
}

console.log("\nCPU ENGINE LAUNCH FLAGS");
const cpuArgs = buildLaunchArgs({ tierFlags: ["--lowvram", "--async-offload", "4"], installFlags: ["--cpu"] });
ok("--cpu drops the tier's --lowvram and offload streams (argparse would refuse them)", cpuArgs.join(" ") === "--cpu", cpuArgs.join(" "));
const gpuArgs = buildLaunchArgs({ tierFlags: ["--lowvram", "--async-offload", "4"], installFlags: ["--use-ck-attention"] });
ok("a GPU engine keeps them", gpuArgs.join(" ") === "--lowvram --async-offload 4 --use-ck-attention", gpuArgs.join(" "));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
