/* film_run.mjs — render "The Quiet" from scripts/shots_anomaly.mjs.
 *
 *   node scripts/film_run.mjs                 # DRY RUN (default), builds + validates
 *   node scripts/film_run.mjs --run           # dispatch
 *   node scripts/film_run.mjs --run --only 17,18,31
 *   node scripts/film_run.mjs --run --from 27 --to 40
 *
 * DRY RUN IS THE DEFAULT, deliberately: this queues two hours of GPU and an
 * accidental `node scripts/film_run.mjs` must not start it.
 *
 * WHY THIS EXISTS RATHER THAN THE APP. The app server is the right home for a
 * finished pipeline, but it refuses to adopt a ComfyUI it did not spawn (the
 * adoption guard in server/comfy.js, which exists because a foreign engine's
 * --output-directory once won and renders landed in another install's library).
 * The engine currently on 8266 was started by hand for the gate experiment. So
 * this runner talks to that engine directly, the same way scripts/gate_run.mjs
 * does, and writes into the gate-style output tree rather than the clip library.
 *
 * RESUMABLE BY CONSTRUCTION. Every shot writes to its own directory and the
 * runner skips a shot whose output already exists unless --force is given. Two
 * hours of renders WILL be interrupted at some point; losing the first ninety
 * minutes to a crash would be the expensive kind of avoidable.
 */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../server/config.js";
import { videoGraphLtx, videoReady } from "../server/workflow.js";
import { SHOTS, build } from "./shots_anomaly.mjs";

const BASE = `http://${config.comfy.host}:${config.comfy.port}`;
const OUT = path.join(config.outputDir, "film");
const arg = (f) => { const i = process.argv.indexOf(f); return i < 0 ? null : process.argv[i + 1]; };
const has = (f) => process.argv.includes(f);

const RUN = has("--run");
const FORCE = has("--force");
const SECONDS = Number(arg("--seconds") ?? 5);
const WIDTH = Number(arg("--width") ?? config.video.engines.ltx.width);
const HEIGHT = Number(arg("--height") ?? config.video.engines.ltx.height);

const only = (arg("--only") || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
const from = Number(arg("--from") ?? 0), to = Number(arg("--to") ?? 0);
let shots = SHOTS;
if (only.length) shots = shots.filter((s) => only.includes(s.id));
else if (from || to) shots = shots.filter((s) => s.id >= (from || 1) && s.id <= (to || 999));

const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
};

/* Poll with a real deadline and a consecutive-failure bound. An unbounded
 * for(;;) here would spin forever if the engine died mid-job — the exact defect
 * an adversarial review found in the gate harness. */
async function wait(promptId, label) {
  const started = Date.now();
  const DEADLINE = 30 * 60_000;
  let fails = 0;
  for (;;) {
    if (Date.now() - started > DEADLINE) throw new Error(`${label}: deadline exceeded`);
    try {
      const r = await fetch(`${BASE}/history/${promptId}`, { signal: AbortSignal.timeout(15_000) });
      const h = await r.json();
      fails = 0;
      const rec = h[promptId];
      if (rec) {
        const st = rec.status || {};
        if (st.status_str === "error" || st.completed === false && st.status_str === "error") {
          throw new Error(`${label}: engine reported error — ${JSON.stringify(st.messages || []).slice(0, 400)}`);
        }
        if (st.completed) return rec;
      }
    } catch (e) {
      if (String(e.message).includes("engine reported error")) throw e;
      if (++fails > 10) throw new Error(`${label}: engine unreachable for ${fails} polls — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/* WHERE THE FILE ACTUALLY LANDS.
 *
 * The graph is built with prefix `film/NN`, and ComfyUI treats that as a
 * filename prefix, not a directory: the output is output/film/NN_00001_.mp4,
 * NOT output/film/NN/something.mp4. The first version of this runner made an
 * empty per-shot directory and then looked inside it for the resume check, so
 * it would have re-rendered all sixty shots on every restart while quietly
 * leaving sixty empty folders behind — the resume feature would have looked
 * like it worked and done nothing. Caught on the smoke shot. */
const rendered = async (id) => {
  const tag = String(id).padStart(2, "0");
  try {
    return (await readdir(OUT)).some((f) => f.startsWith(tag + "_") && f.endsWith(".mp4"));
  } catch { return false; }
};

console.log(`film_run — ${RUN ? "DISPATCH" : "DRY RUN"}   ${BASE}`);
console.log(`  ${WIDTH}x${HEIGHT}  ${SECONDS}s  ${shots.length} shot(s)  ->  ${OUT}\n`);

const ready = videoReady("ltx");
if (!ready.ready) {
  console.log(`  WEIGHTS MISSING: ${ready.missing.join(", ")}`);
  process.exit(1);
}
console.log("  weights       ready");

let built = 0, skipped = 0, problems = 0;
const jobs = [];
for (const shot of shots) {
  if (!FORCE && await rendered(shot.id)) { skipped++; continue; }
  const b = build(shot);
  let graph;
  try {
    graph = videoGraphLtx({
      prompt: b.prompt, negative: b.negative, seed: b.seed,
      seconds: SECONDS, width: WIDTH, height: HEIGHT,
      prefix: `film/${String(shot.id).padStart(2, "0")}`,
    });
  } catch (e) {
    console.log(`  SHOT ${shot.id} BUILD FAIL: ${e.message}`);
    problems++; continue;
  }
  // every node input must reference a node that exists — a dangling edge is a
  // 400 from the engine two hours into a queue, which is a bad time to find out
  for (const [id, n] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && !graph[v[0]]) {
        console.log(`  SHOT ${shot.id} DANGLING: node ${id}.${k} -> ${v[0]}`);
        problems++;
      }
    }
  }
  jobs.push({ shot, graph });
  built++;
}

console.log(`  built ${built}, skipped ${skipped} already rendered, ${problems} problem(s)\n`);
if (problems) { console.log("  refusing to dispatch with build problems"); process.exit(1); }

if (!RUN) {
  await mkdir(path.join(OUT, "_graphs"), { recursive: true });
  for (const j of jobs.slice(0, 3)) {
    await writeFile(path.join(OUT, "_graphs", `${j.shot.id}.json`), JSON.stringify(j.graph, null, 1));
  }
  console.log(`  DRY RUN — nothing posted. First 3 graphs written to ${path.join(OUT, "_graphs")}.`);
  console.log("  Add --run to dispatch.");
  process.exit(0);
}

let n = 0;
const t0 = Date.now();
for (const j of jobs) {
  const label = `shot ${String(j.shot.id).padStart(2, "0")} [${j.shot.t}]`;
  process.stdout.write(`  ${label} `);
  const s = Date.now();
  try {
    const { prompt_id } = await post("/prompt", { prompt: j.graph });
    await wait(prompt_id, label);
    const secs = Math.round((Date.now() - s) / 1000);
    n++;
    const eta = Math.round((Date.now() - t0) / 1000 / n * (jobs.length - n) / 60);
    console.log(`ok ${secs}s   (${n}/${jobs.length}, ~${eta} min left)`);
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    // keep going: one bad shot must not cost the other fifty-nine
  }
}
console.log(`\n  ${n}/${jobs.length} rendered in ${Math.round((Date.now() - t0) / 60000)} min -> ${OUT}`);
