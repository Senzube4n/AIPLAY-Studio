/**
 * Build the distributable.
 *
 * ALLOW-LIST, NOT DENY-LIST. This is the one decision in the file that matters.
 * The working tree contains 20-odd `dev_*.py` scripts that talk to AIPLAY's own
 * dev server, plus `dev-endpoint/`, which is platform code. None of it holds a
 * literal secret — credentials come from an external helper — but all of it
 * describes private infrastructure, and a deny-list would leak the next one
 * somebody writes. Anything not named below simply does not ship.
 *
 * The output is a zip, not an installer. Two reasons: an unsigned .exe that
 * wants to download 34 GB of model weights deserves more suspicion than it can
 * answer, and a zip can be read before it is run.
 */
import { cp, mkdir, rm, readdir, stat, lstat, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stampForPackage, versionLine } from "../server/version.js";
import { installPathAllowed } from "./verify-install.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist");

// Runtime folders/files come from install.json, the same manifest as Setup.exe.
// Scripts remain separately reviewed below so a new dev harness cannot ship.

/**
 * Scripts that ship. Named one by one on purpose.
 *
 * The test that decides: does a USER ever need to run this? Setup and the audio
 * encoder are part of the product. The measurement harnesses are how the
 * defaults were arrived at, and they ship too — the numbers in config.js are
 * checkable claims, and a claim nobody can re-run is just an assertion.
 */
const SCRIPTS = [
  "setup.mjs",              // first run: find the engine
  // The launcher's other two ways in, and the engine installer it runs. Each
  // was missing here, so a zip could only ever start Full Studio.
  "start-music.mjs",        // Music only
  "start-cloud.mjs",        // Use Comfy API
  "start-remote.mjs",       // RunPod GPU
  "verify-install.mjs",     // offline runtime payload validation
  "install-engine.mjs",     // the launcher's "Install ComfyUI"
  "build-launcher-exe.mjs", // rebuild AIPLAY Studio.exe + launcher/aiplay.ico from source
  "dav_encode.py",          // audio reference: the encode ComfyUI refuses to do
  "_audio_io.py",           // the only correct audio loader; dav_encode needs it
  "make_thumbs.py",         // cover thumbnails
  "export_workflows.mjs",   // regenerate workflows/ from the live graph builders
  "trace_load.mjs",         // "the UI went blank" — finds a top-level throw
  // The measurements behind the shipped defaults.
  "dav_generality.py", "dav_realistic.py", "audio_ref_score.py",
  "h3_smoke.mjs", "h3_sweep.mjs", "h3_confirm.mjs", "h3_score.py", "h3_confirm_score.py",
];

/** A second pair of eyes on the result, in case the lists above drift.
 *  FILENAMES only — see FORBIDDEN_CONTENT for what is scanned inside files. */
const FORBIDDEN = [/^dev[_-]/i, /aiplay\.live/, /\bssh\b/, /\bscp\b/, /aiplay_creds/];

/**
 * What counts as private infrastructure INSIDE a file.
 *
 * Deliberately not the same list. A filename rule can be blunt; a content rule
 * cannot. `\bssh\b` matched the phrase "~/.ssh/id_rsa" in a comment in
 * server/secrets.js explaining that its non-Windows fallback uses the same
 * posture as an ssh private key — documentation, in a file that is
 * unambiguously part of the product. Refusing to ship over that is a check that
 * trains you to bypass it, which is worse than not having one.
 *
 * So this matches what cannot appear innocently: an ssh/scp INVOCATION, or a
 * deployment account and endpoint. The account and port patterns are read from
 * the environment rather than written here, because a scanner that hardcodes
 * the secret it looks for publishes it to everyone who reads the scanner.
 */
const FORBIDDEN_CONTENT = [
  /(?:^|[\s"'`(])(?:ssh|scp)\s+-/m,                    // `ssh -i …`, `scp -P …`
  /\b(?:spawn|exec|execSync|execFile)\s*\(\s*["'`](?:ssh|scp)["'`]/,
  ...(process.env.AIPLAY_DEPLOY_ACCOUNT ? [new RegExp(`${process.env.AIPLAY_DEPLOY_ACCOUNT}@`)] : []),
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/,      // any host:port pair
  /aiplay_creds/,
];

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

/** Stage the manifest-selected payload without running it or touching dist. */
export async function stageInstallPayload({ root, stage }) {
  const manifest = JSON.parse(await readFile(path.join(root, "install.json"), "utf8"));
  if (!Array.isArray(manifest.include) || !manifest.include.length
    || manifest.include.some(name => typeof name !== "string" || !name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === "." || name === "..")) {
    throw new Error("install.json must name safe top-level payload files and folders.");
  }
  await mkdir(stage, { recursive: true });
  if ((await readdir(stage)).length) throw new Error("Package staging must start in an empty folder.");
  const missing = [];
  const filter = async file => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!installPathAllowed(relative, manifest)) return false;
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Linked payload paths cannot ship: ${relative}`);
    return true;
  };
  for (const entry of manifest.include) {
    if (entry === "scripts") {
      await mkdir(path.join(stage, "scripts"), { recursive: true });
      for (const script of SCRIPTS) {
        const source = path.join(root, "scripts", script);
        if (await exists(source)) await cp(source, path.join(stage, "scripts", script), { filter });
        else missing.push("scripts/" + script);
      }
      continue;
    }
    const source = path.join(root, entry);
    if (await exists(source)) await cp(source, path.join(stage, entry), { recursive: true, filter });
    else missing.push(entry);
  }
  return { manifest, missing };
}

async function validateStage(stage) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-vm-modules", path.join(stage, "scripts", "verify-install.mjs"), "--root", stage], { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => {
      try { resolve({ code, report: JSON.parse(stdout) }); }
      catch { reject(new Error("The staged payload checker did not return JSON: " + stderr.slice(-400))); }
    });
  });
  if (result.code !== 0 || result.report.ok !== true) {
    throw new Error("Incomplete runtime payload: " + (result.report.errors || []).map(error => error.message).join("; "));
  }
  console.log(`  verified ${result.report.modulesChecked} local startup modules without executing them`);
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf-8"));
  const stage = path.join(OUT, `aiplay-studio-${pkg.version}`);
  if (path.relative(path.resolve(ROOT), path.resolve(OUT)) !== "dist") throw new Error("Package output escaped its expected dist folder.");
  await rm(OUT, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const { missing } = await stageInstallPayload({ root: ROOT, stage });

  /* WHICH BUILD IS IN THE ZIP. A packaged install has no .git, so the three
   * facts server/version.js would have read from it are written here instead.
   * Without this a zip can only name its lineage, and every bug report from a
   * packaged install would be about "unknown". */
  await writeFile(path.join(stage, "server", "version.gen.json"), `${JSON.stringify(stampForPackage(), null, 2)}
`);
  console.log(`  stamped ${versionLine()}`);
  await validateStage(stage);

  // ---- the check that makes the allow-list trustworthy --------------------
  const shipped = await walk(stage);
  const leaks = [];
  for (const rel of shipped) {
    if (FORBIDDEN.some((re) => re.test(path.basename(rel)))) { leaks.push(`${rel} (filename)`); continue; }
    if (/\.(js|mjs|py|json|md|cmd|html|css)$/i.test(rel)) {
      const text = await readFile(path.join(stage, rel), "utf-8").catch(() => "");
      // A hostname in a COMMENT is fine — the community feed genuinely points at
      // aiplay.live, and saying so is documentation. A dev-only script is not.
      for (const re of FORBIDDEN_CONTENT) {
        if (re.test(text)) leaks.push(`${rel} (contains ${re})`);
      }
    }
  }

  console.log(`  staged ${shipped.length} files`);
  if (missing.length) console.log(`  ⚠ not found, skipped: ${missing.join(", ")}`);
  if (leaks.length) {
    console.log("\n  ✗ REFUSING TO PACKAGE — private material in the staging tree:");
    leaks.forEach((l) => console.log(`      ${l}`));
    console.log("\n  Fix the allow-list in scripts/package.mjs, or the file itself.\n");
    return 1;
  }
  console.log("  ✓ no dev-server scripts, no credentials helper, no remote-shell calls");

  const zip = path.join(OUT, `aiplay-studio-${pkg.version}.zip`);
  await new Promise((resolve, reject) => {
    // PowerShell's Compress-Archive: present on every Windows since 8.1, so the
    // packager needs nothing installed.
    const p = spawn("powershell", ["-NoProfile", "-Command",
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err || `exit ${c}`))));
    p.on("error", reject);
  });

  const { size } = await stat(zip);
  console.log(`\n  ${path.relative(ROOT, zip)}  ${(size / 1e6).toFixed(2)} MB`);
  console.log("\n  Contains no weights. On first run Studio finds ComfyUI, and the");
  console.log("  Models screen fetches what each feature needs, when asked.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
