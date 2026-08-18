/**
 * First-run setup: find the engine, or explain exactly what is missing.
 *
 * Studio drives a ComfyUI install; it does not contain one. That is a deliberate
 * split — ComfyUI is 6 GB of python before any weights, it has its own update
 * story, and most people who want this already have one. Bundling a second copy
 * would be the single largest thing in the download and the most likely to rot.
 *
 * So the one question this asks is "where is it", and it tries hard to answer
 * that itself before asking. Run with --quiet-if-ready and it prints nothing at
 * all once things work, which is what makes it safe to call on every launch.
 */
import { stat, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import path from "node:path";

const SETTINGS = path.join(homedir(), ".aiplay-studio", "settings.json");
const QUIET = process.argv.includes("--quiet-if-ready");

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const isEngine = async (rig) => exists(path.join(rig, "ComfyUI", "main.py"));

/** A ComfyUI needs a python that can actually run it. */
async function pythonFor(rig) {
  for (const rel of [["venv", "Scripts", "python.exe"], ["venv", "bin", "python"],
                     ["python_embeded", "python.exe"], [".venv", "Scripts", "python.exe"]]) {
    const p = path.join(rig, ...rel);
    if (await exists(p)) return p;
  }
  return null;
}

/**
 * Look where ComfyUI actually ends up.
 *
 * Ordered by likelihood, and every drive is checked because "big AI folder on
 * the second disk" is the normal shape of these installs — the C: drive is
 * rarely where 34 GB of weights lives.
 */
async function guess() {
  const home = homedir();
  const roots = [
    path.join(home, "ComfyUI"), path.join(home, "Documents", "ComfyUI"),
    path.join(home, "Desktop", "ComfyUI"),
    ...["C", "D", "E", "F"].flatMap((d) => [
      `${d}:\\ComfyUI`, `${d}:\\AI`, `${d}:\\AI\\ComfyUI`,
      `${d}:\\ComfyUI_windows_portable`, `${d}:\\StabilityMatrix`,
    ]),
  ];
  const found = [];
  for (const r of roots) {
    if (!(await exists(r))) continue;
    if (await isEngine(r)) { found.push(r); continue; }
    // One level down, so `D:\AI\<anything>\ComfyUI\main.py` is caught too.
    try {
      for (const e of await readdir(r, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const c = path.join(r, e.name);
        if (await isEngine(c)) found.push(c);
      }
    } catch { /* unreadable drive */ }
  }
  return [...new Set(found)];
}

async function saved() {
  try { return JSON.parse(await readFile(SETTINGS, "utf-8")); } catch { return {}; }
}

async function main() {
  const cur = await saved();
  const rig = process.env.AIPLAY_RIG || cur.rig || "D:\\AI\\aiplay-studio-bench";

  // Already working: say nothing and get out of the way.
  if (await isEngine(rig)) {
    const py = await pythonFor(rig);
    if (py) {
      if (!QUIET) console.log(`  engine: ${rig}\n  python: ${py}`);
      // Record it. This is the whole point of having looked: config.js cannot
      // tell a portable build from a from-source one by the rig path alone, and
      // guessing wrong used to mean editing a source file by hand.
      if (cur.python !== py) {
        await mkdir(path.dirname(SETTINGS), { recursive: true });
        await writeFile(SETTINGS, JSON.stringify({ ...cur, rig, python: py }, null, 2));
      }
      return 0;
    }
    console.log(`\n  Found ComfyUI at ${rig}, but no python environment inside it.`);
    console.log(`  Looked for venv\\Scripts\\python.exe and python_embeded\\python.exe.`);
    console.log(`  Start ComfyUI once on its own first — that is what creates it.\n`);
    return 1;
  }

  console.log("\n  AIPLAY Studio needs a ComfyUI install to drive.");
  console.log("  It does not ship one: ComfyUI is gigabytes on its own, updates on its");
  console.log("  own schedule, and you very likely already have it.\n");

  const hits = await guess();
  if (hits.length) {
    console.log("  Found:");
    hits.forEach((h, i) => console.log(`    ${i + 1}. ${h}`));
    console.log("");
  } else {
    console.log("  Could not find one automatically.");
    console.log("  If you have none: https://github.com/comfyanonymous/ComfyUI");
    console.log("  Install it, run it once, then start Studio again.\n");
  }

  // Non-interactive (double-clicked, or piped): report and stop rather than
  // hanging on a prompt nobody can see.
  if (!stdin.isTTY) {
    if (hits.length === 1) {
      await mkdir(path.dirname(SETTINGS), { recursive: true });
      await writeFile(SETTINGS, JSON.stringify({ ...cur, rig: hits[0] }, null, 2));
      console.log(`  Using ${hits[0]}.\n  Saved to ${SETTINGS}\n`);
      return 0;
    }
    console.log(`  Set the folder in ${SETTINGS}:\n    { "rig": "D:\\\\path\\\\to\\\\parent-of-ComfyUI" }\n`);
    return 1;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(
    hits.length ? "  Pick a number, or paste a path: " : "  Paste the path to your ComfyUI folder: ")).trim();
  rl.close();
  if (!answer) return 1;

  let chosen = /^\d+$/.test(answer) ? hits[Number(answer) - 1] : answer;
  if (!chosen) return 1;
  // Accept either the folder CONTAINING ComfyUI or ComfyUI itself — both are
  // reasonable things to paste, and guessing wrong here is a bad first minute.
  if (!(await isEngine(chosen)) && await exists(path.join(chosen, "main.py"))) {
    chosen = path.dirname(chosen);
  }
  if (!(await isEngine(chosen))) {
    console.log(`\n  No ComfyUI/main.py under ${chosen}.\n`);
    return 1;
  }

  await mkdir(path.dirname(SETTINGS), { recursive: true });
  await writeFile(SETTINGS, JSON.stringify({ ...cur, rig: chosen }, null, 2));
  console.log(`\n  Saved to ${SETTINGS}`);
  console.log("  Open the Models screen once Studio starts — it lists what each");
  console.log("  feature needs, how large it is, and fetches it when you ask.\n");
  return 0;
}

process.exit(await main());
