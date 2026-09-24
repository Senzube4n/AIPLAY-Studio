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
import {
  STUDIO_PACKAGES, STUDIO_MODULES, constraintsText, MODULES_PROBE, VERSIONS_PROBE, LEFTOVERS_PROBE, studioWarning,
  frozenConstraints, studioInstallPlan, addStudioPackages, diskWords,
} from "./setup/studio-packages.js";

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
ok("the packages are OpenCV (headless), librosa, soundfile and SciPy (librosa imports lazily, so SciPy is checked by name)",
  STUDIO_PACKAGES.join(" ") === "opencv-python-headless librosa soundfile scipy" && STUDIO_MODULES.join(" ") === "cv2 librosa soundfile scipy");
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
ok("the probes are real imports of what the features load (scipy.signal, librosa's pitch tracker), and read versions through importlib.metadata",
  /importlib\.import_module\(imp\.get\(n, n\)\)/.test(MODULES_PROBE) && /m\.version\(n\)/.test(VERSIONS_PROBE)
    && /"scipy":"scipy\.signal"/.test(MODULES_PROBE) && /"librosa":"librosa\.core\.pitch"/.test(MODULES_PROBE) && /purelib/.test(LEFTOVERS_PROBE));
ok("a Studio-package failure is a sentence that names what needs them and the retry",
  /Clip posters, the compositor, hum-to-score, the real-audio tokenizer and the DAW need them/.test(studioWarning(["cv2"]) || "")
    && /press Try again beside "Studio's own packages" in the launcher/.test(studioWarning(["cv2"]) || "")
    && /--studio-packages/.test(studioWarning(["cv2"]) || "") && studioWarning([]) === null);
ok("...and names the half-removed folders pip left in site-packages (R4d 6)",
  /pip left half-removed packages in C:\\e\\venv\\Lib\\site-packages \(~cipy, -umpy\): stop Studio, delete those folders/.test(
    studioWarning(["scipy"], "", { dir: "C:\\e\\venv\\Lib\\site-packages", names: ["~cipy", "-umpy"] }) || "")
    && !/half-removed/.test(studioWarning(["scipy"], "", { dir: "x", names: [] })));
ok("the size is the measured one: about 0.3 GB for OpenCV, librosa and soundfile (R4d 8)",
  diskWords(["cv2", "librosa", "soundfile"]) === "About 0.3 GB on disk." && diskWords(["soundfile"]) === "About 2 MB on disk.");

console.log("\nONLY WHAT IS MISSING, WITH EVERY PACKAGE PINNED (R4d 2-4)");
{
  const FREEZE = [
    "certifi==2025.8.3", "numpy==2.2.6", "opencv-python==4.12.0.88", "pillow==12.0.0", "scipy==1.15.2",
    "torch==2.14.0+cu130", "torchaudio==2.14.0+cu130", "-e git+https://example.invalid/x.git#egg=x",
    "weird @ file:///C:/wheels/weird-1.0-py3-none-any.whl", "# a comment",
  ].join("\n");
  const pins = frozenConstraints(FREEZE, { torch: "2.14.0+cu130", numpy: "2.2.6" });
  ok("the constraints file carries every frozen name==version line, torch's local build whole",
    pins === "certifi==2025.8.3\nnumpy==2.2.6\nopencv-python==4.12.0.88\npillow==12.0.0\nscipy==1.15.2\ntorch==2.14.0+cu130\ntorchaudio==2.14.0+cu130\n", JSON.stringify(pins));
  ok("...and nothing that cannot be a constraint (editable installs, URLs, comments)", !/git\+|@ file|#/.test(pins));
  ok("...adding a probed pin the freeze missed", /^torchvision==0\.29\.0$/m.test(frozenConstraints("numpy==2.2.6\ntorch==2.14.0", { torchvision: "0.29.0" })));
  let refused = null;
  try { frozenConstraints("numpy==2.2.6\n", {}); } catch (e) { refused = e.message; }
  ok("...and an engine with no torch is still refused", /no torch installed/.test(refused || ""), refused);

  const all = studioInstallPlan({ cv2: "ModuleNotFoundError: No module named 'cv2'", librosa: "x", soundfile: "x", scipy: true }, "numpy==2.2.6\nscipy==1.15.2\ntorch==2.14.0");
  ok("pip is handed only the packages whose modules fail", all.add.join(" ") === "opencv-python-headless librosa soundfile" && !all.force.length, JSON.stringify(all));
  const cv = studioInstallPlan({ cv2: "ImportError: DLL load failed while importing cv2", librosa: true, soundfile: true, scipy: true }, FREEZE);
  ok("with an opencv-* distribution installed, no headless is added beside it: that one is put back",
    !cv.add.includes("opencv-python-headless") && cv.force.join() === "opencv-python==4.12.0.88", JSON.stringify(cv));
  const broken = studioInstallPlan({ cv2: true, librosa: true, soundfile: true, scipy: "ModuleNotFoundError: No module named 'scipy'" }, FREEZE);
  ok("a module pip still lists but that does not import is put back at its frozen version (a plain install is a no-op)",
    broken.force.join() === "scipy==1.15.2" && !broken.add.length, JSON.stringify(broken));
  const blind = studioInstallPlan(null, FREEZE);
  ok("...and when the import probe could not run, nothing is forced and only unlisted packages are named",
    !blind.force.length && blind.add.join(" ") === "librosa soundfile", JSON.stringify(blind));

  /* The whole step, with the installer's runners faked: what is written, and
   * what pip is asked, in order. */
  const calls = [], wrote = {};
  const answers = { cv2: true, librosa: "ModuleNotFoundError: No module named 'librosa'", soundfile: "ModuleNotFoundError: No module named 'soundfile'", scipy: "ModuleNotFoundError: No module named 'scipy'" };
  const out = await addStudioPackages({
    root: path.join(tmp, "eng"), log: () => {},
    runPy: async (code) => ({ stdout: code === VERSIONS_PROBE ? '@@versions {"torch":"2.14.0+cu130","numpy":"2.2.6"}' : `@@modules ${JSON.stringify(answers)}` }),
    freeze: async () => FREEZE,
    pip: async (args) => { calls.push(args); },
    write: async (file, text) => { wrote[file] = text; },
  });
  const file = path.join(tmp, "eng", "studio-constraints.txt");
  ok("the step writes <engine>/studio-constraints.txt from pip freeze before pip runs", out.ok && wrote[file] === pins && out.constraints === file, JSON.stringify(out));
  ok("...then puts the listed-but-broken SciPy back with --force-reinstall --no-deps, under the file",
    JSON.stringify(calls[0]) === JSON.stringify(["--force-reinstall", "--no-deps", "scipy==1.15.2", "-c", file]), JSON.stringify(calls));
  ok("...then one plain install: SciPy's frozen line again (adding any requirement of it that is gone), and only librosa and soundfile added (OpenCV imports, so it is not named)",
    calls.length === 2 && JSON.stringify(calls[1]) === JSON.stringify(["scipy==1.15.2", "librosa", "soundfile", "-c", file]), JSON.stringify(calls));

  /* A listed module failing because a requirement of it is gone: --no-deps
   * alone would put it back and still not install the requirement. */
  const DEPS_FREEZE = "numpy==2.2.6\ntorch==2.14.0\nlibrosa==0.11.0\nsoundfile==0.13.1\nscipy==1.15.2\nopencv-python-headless==4.12.0.88";
  const depCalls = [];
  const dep = await addStudioPackages({
    root: path.join(tmp, "eng2"), log: () => {}, write: async () => {}, freeze: async () => DEPS_FREEZE, pip: async (a) => { depCalls.push(a); },
    runPy: async (code) => ({ stdout: code === VERSIONS_PROBE ? '@@versions {"torch":"2.14.0","numpy":"2.2.6"}'
      : `@@modules ${JSON.stringify({ cv2: true, scipy: true, librosa: "ModuleNotFoundError: No module named 'lazy_loader'", soundfile: "ModuleNotFoundError: No module named '_cffi_backend'" })}` }),
  });
  const f2 = path.join(tmp, "eng2", "studio-constraints.txt");
  ok("a listed module missing a requirement (librosa without lazy_loader, soundfile without cffi) is put back AND plain-installed, so pip adds the requirement",
    dep.ok && JSON.stringify(depCalls) === JSON.stringify([
      ["--force-reinstall", "--no-deps", "librosa==0.11.0", "soundfile==0.13.1", "-c", f2],
      ["librosa==0.11.0", "soundfile==0.13.1", "-c", f2]]), JSON.stringify(depCalls));

  /* From inside a running Studio (--add-only): nothing installed is
   * replaced; the plain install still adds what is missing, and what was
   * not put back is handed to the caller for its sentence. */
  const liveCalls = [];
  const live = await addStudioPackages({
    root: path.join(tmp, "eng3"), log: () => {}, write: async () => {}, freeze: async () => FREEZE, pip: async (a) => { liveCalls.push(a); }, replace: false,
    runPy: async (code) => ({ stdout: code === VERSIONS_PROBE ? '@@versions {"torch":"2.14.0+cu130","numpy":"2.2.6"}' : `@@modules ${JSON.stringify(answers)}` }),
  });
  const f3 = path.join(tmp, "eng3", "studio-constraints.txt");
  ok("replace: false runs no --force-reinstall: one plain install, and the kept line comes back with its module",
    live.ok && liveCalls.length === 1 && JSON.stringify(liveCalls[0]) === JSON.stringify(["scipy==1.15.2", "librosa", "soundfile", "-c", f3])
      && !liveCalls.flat().includes("--force-reinstall") && live.kept.join() === "scipy==1.15.2" && live.keptModules.join() === "scipy", JSON.stringify(live));
  ok("...and the sentence then says putting it back needs Studio stopped, and where",
    /Putting back scipy==1\.15\.2 \(installed, but not importing\) replaces files the running engine holds open, so it is done only while Studio is stopped\./.test(
      studioWarning(["scipy"], "", null, { putBack: ["scipy==1.15.2"] }) || "")
      && /To try only these again, stop Studio, then press Try again beside "Studio's own packages" in the launcher's system check/.test(
        studioWarning(["scipy"], "", null, { putBack: ["scipy==1.15.2"] }) || "")
      && !/Putting back|stop Studio, then/.test(studioWarning(["scipy"]) || ""));

  const chained = studioInstallPlan({ cv2: true, soundfile: true, scipy: "ModuleNotFoundError: No module named 'scipy.signal._sigtools'",
    librosa: "ModuleNotFoundError: No module named 'scipy.signal._sigtools'" }, FREEZE);
  ok("librosa failing only because SciPy does is not reinstalled: putting SciPy back fixes both",
    chained.force.join() === "scipy==1.15.2" && JSON.stringify(chained.missing) === '["librosa","scipy"]' && !chained.add.length, JSON.stringify(chained));
  ok("the installer passes --add-only through as replace: false, and records which modules it checked",
    /const addOnly = process\.argv\.includes\("--add-only"\);/.test(src) && /installStudioPackages\(py, pip, \{ replace: !addOnly \}\)/.test(src)
      && /checked: \[\.\.\.STUDIO_MODULES\]/.test(src) && (src.match(/studioRecord\(studio\)/g) || []).length === 4
      && /studioWarning\(check\.missing, got\.ok \? "" : got\.error, check\.ok \? null : await readLeftovers\(py\), \{ putBack \}\)/.test(src));
  const none = [];
  const noop = await addStudioPackages({ root: tmp, log: () => {}, write: async () => {}, freeze: async () => FREEZE, pip: async (a) => { none.push(a); },
    runPy: async (code) => ({ stdout: code === VERSIONS_PROBE ? '@@versions {"torch":"2","numpy":"2"}' : '@@modules {"cv2":true,"librosa":true,"soundfile":true,"scipy":true}' }) });
  ok("everything importing runs no pip at all", noop.ok && noop.noop && none.length === 0);
  const noFreeze = await addStudioPackages({ root: tmp, log: () => {}, write: async () => { throw new Error("must not write"); }, pip: async () => { throw new Error("must not pip"); },
    freeze: async () => { throw Object.assign(new Error("x"), { stderr: "No module named pip" }); },
    runPy: async () => ({ stdout: '@@versions {"torch":"2","numpy":"2"}' }) });
  ok("a pip freeze that fails stops the step before anything is written or installed",
    !noFreeze.ok && /could not list the engine's packages \(pip freeze\): No module named pip/.test(noFreeze.error), JSON.stringify(noFreeze));
  ok("the installer runs this step with its own pip freeze, and names leftovers on failure",
    /addStudioPackages\(\{/.test(src) && /\["-s", "-m", "pip", "freeze"\]/.test(src) && /readLeftovers\(py\)/.test(src)
      && !/pip\(\[\.\.\.STUDIO_PACKAGES/.test(src));
}
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

  /* R4d 7: the pip wheels --studio-packages fetched are not kept beside a
   * finished engine. Here the engine has no python, so the run stops before
   * pip — the cache still goes, and the engine is untouched. */
  const ours = path.join(tmp, "our-engine");
  mkdirSync(path.join(ours, "ComfyUI"), { recursive: true });
  writeFileSync(path.join(ours, ".aiplay-engine.json"), JSON.stringify({ complete: true, backend: "cpu" }));
  const cache = `${ours}-cache`;
  mkdirSync(path.join(cache, "pip", "http-v2"), { recursive: true });
  writeFileSync(path.join(cache, "pip", "http-v2", "librosa.whl"), "wheel");
  writeFileSync(path.join(cache, ".aiplay-engine-cache"), "made by scripts/install-engine.mjs; safe to delete");
  const gone = run({ AIPLAY_APPDATA: path.join(tmp, "appdata3"), AIPLAY_ENGINE_DIR: ours }, ["--studio-packages"]);
  ok("after --studio-packages the pip download cache beside the engine is gone, and so is the emptied cache folder",
    gone.status === 1 && /has no python at/.test(gone.stdout) && !existsSync(path.join(cache, "pip")) && !existsSync(cache), gone.stdout);
  ok("...while the engine folder and its marker stay", existsSync(path.join(ours, "ComfyUI")) && existsSync(path.join(ours, ".aiplay-engine.json")));
  mkdirSync(path.join(cache, "pip"), { recursive: true });
  mkdirSync(path.join(cache, "uv-cache"), { recursive: true });
  run({ AIPLAY_APPDATA: path.join(tmp, "appdata3"), AIPLAY_ENGINE_DIR: ours }, ["--studio-packages"]);
  ok("...a cache folder holding anything else keeps it; only pip's part goes",
    !existsSync(path.join(cache, "pip")) && existsSync(path.join(cache, "uv-cache")));
  mkdirSync(path.join(`${theirs2}-cache`, "pip"), { recursive: true });
  run({ AIPLAY_APPDATA: path.join(tmp, "appdata2"), AIPLAY_ENGINE_DIR: theirs2 }, ["--studio-packages"]);
  ok("...and the cache beside a folder that is not Studio's engine is never touched", existsSync(path.join(`${theirs2}-cache`, "pip")));
}

console.log("\nCPU ENGINE LAUNCH FLAGS");
const cpuArgs = buildLaunchArgs({ tierFlags: ["--lowvram", "--async-offload", "4"], installFlags: ["--cpu"] });
ok("--cpu drops the tier's --lowvram and offload streams (argparse would refuse them)", cpuArgs.join(" ") === "--cpu", cpuArgs.join(" "));
const gpuArgs = buildLaunchArgs({ tierFlags: ["--lowvram", "--async-offload", "4"], installFlags: ["--use-ck-attention"] });
ok("a GPU engine keeps them", gpuArgs.join(" ") === "--lowvram --async-offload 4 --use-ck-attention", gpuArgs.join(" "));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
