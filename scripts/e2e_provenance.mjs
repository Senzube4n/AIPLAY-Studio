/**
 * Provenance end-to-end, live and isolated: boot the real server, drive it
 * over the REAL MCP transport, and prove the whole chain the SPEC promises —
 *
 *   edit an image over MCP
 *     → the ledger holds an `edit` event stamped with an agent:* actor
 *   export the image
 *     → the file carries the Tier-1 marker, read back by an INDEPENDENT
 *       reader (a PNG chunk walk in this file, not imgexport's own code)
 *   and the ledger's hash chain verifies by recomputation here.
 *
 * ISOLATION: a scratch AIPLAY_APPDATA + AIPLAY_OUTPUT so nothing touches the
 * real library or ledger, and a deliberately fake AIPLAY_RIG so no ComfyUI
 * (and no GPU) is spawned — AIPLAY_PYTHON still points at the real venv so
 * the image pipeline works. Needs that venv; nothing else.
 *
 *   node scripts/e2e_provenance.mjs
 *
 * NOT in the pre-commit hook: it boots a server and takes ~20 s. Run it after
 * touching the provenance seams, the way smoke_api.mjs is run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const VENV_PY = process.env.AIPLAY_PYTHON
  || (process.env.AIPLAY_RIG ? path.join(process.env.AIPLAY_RIG, "venv", "Scripts", "python.exe")
                             : "D:/AI/aiplay-studio-bench/venv/Scripts/python.exe");

const scratch = path.join(os.tmpdir(), `prov-e2e-${Date.now().toString(36)}`);
const APPDATA = path.join(scratch, "appdata");
const OUTPUT = path.join(scratch, "output");
const IMAGES = path.join(OUTPUT, "images");
mkdirSync(IMAGES, { recursive: true });
mkdirSync(APPDATA, { recursive: true });

let pass = 0;
const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
};

/* ── fixture: a real PNG the editor can decode ─────────────────────────── */
{
  const r = spawn(VENV_PY, ["-c", [
    "from PIL import Image",
    `Image.new("RGBA", (64, 64), (200, 40, 40, 255)).save(r"${path.join(IMAGES, "fixture.png")}")`,
  ].join("\n")], { stdio: "inherit" });
  await new Promise((res) => r.on("close", res));
  if (!existsSync(path.join(IMAGES, "fixture.png"))) {
    console.error("  could not write the fixture PNG — is the venv python at " + VENV_PY + "?");
    process.exit(1);
  }
}

/* ── boot the server, engineless ───────────────────────────────────────── */
const env = {
  ...process.env,
  AIPLAY_APPDATA: APPDATA,
  AIPLAY_OUTPUT: OUTPUT,
  AIPLAY_RIG: path.join(scratch, "no-rig"),   // fake: ComfyUI must NOT spawn
  AIPLAY_PYTHON: VENV_PY,                     // ...but the image pipeline must work
  AIPLAY_UI_PORT: String(PORT),
  AIPLAY_COMFY_PORT: "8299",
};
const server = spawn("node", [path.join(ROOT, "server", "index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const deadline = Date.now() + 30_000;
let up = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${BASE}/api/status`);
    if (r.ok) { up = true; break; }
  } catch { /* not yet */ }
  await new Promise((s) => setTimeout(s, 400));
}
ok("the server boots without an engine", up, serverLog.slice(-500));
if (!up) { server.kill(); process.exit(1); }

/* ── the MCP transport, for real ───────────────────────────────────────── */
const mcp = spawn("node", [path.join(ROOT, "server", "mcp.js")],
  { env: { ...process.env, AIPLAY_URL: BASE }, stdio: ["pipe", "pipe", "inherit"] });
let mcpBuf = "";
const pending = new Map();
mcp.stdout.on("data", (d) => {
  mcpBuf += d;
  let nl;
  while ((nl = mcpBuf.indexOf("\n")) >= 0) {
    const line = mcpBuf.slice(0, nl); mcpBuf = mcpBuf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* stray log line */ }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 60_000);
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  if (r.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });

try {

/* 1 — edit the image over MCP (image_adjust answers {image, url}) */
const edited = await call("image_adjust", { name: "fixture.png", brightness: 120, contrast: 110 });
ok("image_adjust over MCP produced a new file", !!edited.image && edited.image !== "fixture.png", JSON.stringify(edited));

/* 2 — the ledger event exists, with the agent actor, seen through MCP itself */
const led = await call("provenance_read", { asset: `images/${edited.image}`, verify: true });
const editEv = (led.events || []).find((e) => e.type === "edit");
ok("the edit landed in the ledger", !!editEv, JSON.stringify(led).slice(0, 300));
ok("…stamped agent:*, never user", !!editEv && String(editEv.actor).startsWith("agent:"), editEv?.actor);
ok("…naming the ops and the source", !!editEv && editEv.data?.ops?.includes("brightness")
  && editEv.data?.derivedFrom === "images/fixture.png");
ok("the chain verifies through the API", led.chain?.ok === true, JSON.stringify(led.chain));

/* 3 — export, and read the marker back with an independent reader */
const exported = await call("image_export", { name: edited.image, opts: { format: "png" } });
ok("image_export over MCP wrote a file", !!exported.file, JSON.stringify(exported));
ok("the reply says the provenance was EMBEDDED (xmp), not sidecarred", exported.provenance === "xmp",
  String(exported.provenance));

const bytes = readFileSync(path.join(IMAGES, exported.file));
function pngXmp(data) {
  if (data.subarray(0, 8).toString("latin1") !== "\x89PNG\r\n\x1a\n") return null;
  let at = 8;
  while (at + 8 <= data.length) {
    const ln = data.readUInt32BE(at);
    const typ = data.subarray(at + 4, at + 8).toString("latin1");
    const body = data.subarray(at + 8, at + 8 + ln);
    if (typ === "iTXt" && body.subarray(0, 18).toString("latin1") === "XML:com.adobe.xmp\x00") {
      let rest = body.subarray(18);
      const compressed = rest[0] === 1;
      rest = rest.subarray(2);
      for (let i = 0; i < 2; i++) rest = rest.subarray(rest.indexOf(0) + 1);
      return (compressed ? zlib.inflateSync(rest) : rest).toString("utf8");
    }
    at += 12 + ln;
    if (typ === "IEND") break;
  }
  return null;
}
const xmp = pngXmp(bytes);
ok("an XMP packet is in the exported PNG (independent chunk walk)", !!xmp);
ok("the marker carries an IPTC DigitalSourceType URI",
  !!xmp && xmp.includes("http://cv.iptc.org/newscodes/digitalsourcetype/"), (xmp || "").slice(0, 200));
ok("…and a plain-language disclosure", !!xmp && /AI-generated|may be AI-generated|Machine-generated/.test(xmp));

/* 4 — the ledger file itself: recompute the chain here, trust nothing */
const ledgerPath = path.join(APPDATA, "provenance", "library.jsonl");
{
  const lines = readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim());
  let prev = "sha256:genesis", okChain = true;
  for (const l of lines) {
    const e = JSON.parse(l);
    if (e.prev !== prev) { okChain = false; break; }
    prev = "sha256:" + createHash("sha256").update(l, "utf8").digest("hex");
  }
  ok(`the on-disk chain recomputes clean (${lines.length} events)`, okChain && lines.length >= 2);
  const actors = new Set(lines.map((l) => JSON.parse(l).actor));
  ok("every event this run wrote is agent-stamped — none claim to be the user",
    ![...actors].includes("user"), [...actors].join(", "));
  const exportEv = lines.map((l) => JSON.parse(l)).find((e) => e.type === "export");
  ok("the export event records what was embedded", exportEv?.data?.embedded === "xmp",
    JSON.stringify(exportEv?.data));
}

/* 5 — trace_load, same gate the hook runs */
{
  const r = spawn("node", [path.join(ROOT, "scripts", "trace_load.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  r.stdout.on("data", (d) => (out += d)); r.stderr.on("data", (d) => (out += d));
  const code = await new Promise((res) => r.on("close", res));
  ok("trace_load stays clean", code === 0 && /NO top-level throw/.test(out), out.slice(-200));
}

} catch (err) {
  ok("the drive completed without a thrown step", false, String(err.message || err));
}

/* ── teardown: kill the server, always ─────────────────────────────────── */
mcp.kill();
server.kill();
await new Promise((s) => setTimeout(s, 500));
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* windows file locks */ }

console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
