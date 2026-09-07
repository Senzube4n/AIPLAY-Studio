/**
 * Render the dance clips by driving the MCP server, not the HTTP API.
 *
 * The point is not convenience — it is that this is the same surface an agent
 * gets, so if the tools are awkward or under-described, this script is where it
 * shows. It speaks JSON-RPC to `server/mcp.js` over a pipe exactly as an MCP
 * client would.
 *
 *   node scripts/demo_dance_clips.mjs
 *
 * Each clip starts from a still made on the Images screen. That only became
 * possible when `stageFrame` stopped looking in the cover folder alone.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* Motion, not subject. The still already carries the look; a clip prompt that
 * re-describes the picture fights it, while one that describes MOVEMENT gives
 * the model the only thing it has to invent. */
const SHOTS = [
  {
    frame: "imt07yytu.png",
    prompt: "slow motion, the dancer turns and her arms sweep down through the light, "
      + "haze drifting across the beam, camera pushes in very slowly, hair moving",
  },
  {
    frame: "imt07yyu7.png",
    prompt: "the liquid paint flows and swirls slowly around the dancing figure, "
      + "glossy enamel folding into itself, colours bleeding into each other, "
      + "slow continuous motion, camera drifts",
  },
  {
    frame: "imt07yyuc.png",
    prompt: "thick liquid paint churning and folding, magenta and cyan marbling "
      + "through each other in slow motion, the figure dissolving further into the flow",
  },
  {
    frame: "imt07yyui.png",
    prompt: "ripples spread outward across the mirrored floor in slow motion, "
      + "coloured ink blooming through the water, the heels shifting weight, "
      + "reflections rippling",
  },
];

const proc = spawn(process.execPath, [path.join(here, "..", "server", "mcp.js")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const waiting = new Map();
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const done = waiting.get(msg.id);
    if (done) { waiting.delete(msg.id); done(msg); }
  }
});

let nextId = 1;
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const tool = async (name, args) => {
  const r = await call("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  if (r.result?.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
};

await call("initialize", {});

const made = [];
for (let i = 0; i < SHOTS.length; i++) {
  const s = SHOTS[i];
  process.stdout.write(`  [${i + 1}/${SHOTS.length}] ${s.frame} … `);
  const t0 = Date.now();
  try {
    const r = await tool("make_clip", {
      prompt: s.prompt, first_frame: s.frame, seconds: 5, seed: 4200 + i,
      timeout_seconds: 1800,
    });
    const names = r.clips || [];
    made.push(...names);
    console.log(`${names.join(", ") || "nothing"}  (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

console.log("\nclips:", made.join(" ") || "(none)");
proc.stdin.end();
