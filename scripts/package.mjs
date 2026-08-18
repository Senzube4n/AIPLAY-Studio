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
import { cp, mkdir, rm, readdir, stat, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist");

/** Whole directories that ship as-is. */
const DIRS = ["server", "web", "workflows"];

/** Individual files at the root. */
const FILES = ["package.json", "package-lock.json", "Start AIPLAY Studio.cmd", "README.md", "LICENSE"];
// LICENSE is listed but deliberately NOT yet written. Choosing one is the
// owner's call and it is irrevocable for whatever version ships under it, so
// the packager warns about the absence rather than inventing an answer.

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
  "dav_encode.py",          // audio reference: the encode ComfyUI refuses to do
  "_audio_io.py",           // the only correct audio loader; dav_encode needs it
  "make_thumbs.py",         // cover thumbnails
  "export_workflows.mjs",   // regenerate workflows/ from the live graph builders
  "trace_load.mjs",         // "the UI went blank" — finds a top-level throw
  // The measurements behind the shipped defaults.
  "dav_generality.py", "dav_realistic.py", "audio_ref_score.py",
  "h3_smoke.mjs", "h3_sweep.mjs", "h3_confirm.mjs", "h3_score.py", "h3_confirm_score.py",
];

/** A second pair of eyes on the result, in case the lists above drift. */
const FORBIDDEN = [/^dev[_-]/i, /aiplay\.live/, /\bssh\b/, /\bscp\b/, /aiplay_creds/];

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

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf-8"));
  const stage = path.join(OUT, `aiplay-studio-${pkg.version}`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  for (const d of DIRS) {
    if (await exists(path.join(ROOT, d))) {
      await cp(path.join(ROOT, d), path.join(stage, d), { recursive: true });
    }
  }
  await mkdir(path.join(stage, "scripts"), { recursive: true });
  const missing = [];
  for (const s of SCRIPTS) {
    if (await exists(path.join(ROOT, "scripts", s))) {
      await cp(path.join(ROOT, "scripts", s), path.join(stage, "scripts", s));
    } else missing.push(s);
  }
  for (const f of FILES) {
    if (await exists(path.join(ROOT, f))) await cp(path.join(ROOT, f), path.join(stage, f));
    else missing.push(f);
  }

  // ---- the check that makes the allow-list trustworthy --------------------
  const shipped = await walk(stage);
  const leaks = [];
  for (const rel of shipped) {
    if (FORBIDDEN.some((re) => re.test(path.basename(rel)))) { leaks.push(`${rel} (filename)`); continue; }
    if (/\.(js|mjs|py|json|md|cmd|html|css)$/i.test(rel)) {
      const text = await readFile(path.join(stage, rel), "utf-8").catch(() => "");
      // A hostname in a COMMENT is fine — the community feed genuinely points at
      // aiplay.live, and saying so is documentation. A dev-only script is not.
      for (const re of FORBIDDEN.slice(2)) {
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

process.exit(await main());
