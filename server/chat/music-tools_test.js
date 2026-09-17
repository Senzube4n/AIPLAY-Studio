/**
 * The Music panel's Simple mode: /api/chat/music with its three tools, no GPU.
 *   node server/chat/music-tools_test.js
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { createChatRoutes } from "./routes.js";
import { createChatTools } from "./tools.js";
import { createMusicTools, describeForm } from "./music-tools.js";

let pass = 0;
const failures = [];
function ok(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}

/* ══ 1. the tools on their own ════════════════════════════════════════════ */
console.log("\nTHE THREE TOOLS");
const tools = createMusicTools();
ok("exactly write_song, change_settings and generate", tools.names.join(",") === "write_song,change_settings,generate", tools.names.join(","));
ok("only generate spends, and it ends the turn", tools.spending.join(",") === "generate" && tools.get("generate").endsTurn === true);
ok("every argument is flat", tools.all.every((t) => Object.values(t.args).every((a) => ["string", "integer", "number", "boolean"].includes(a.type))));

const w = await tools.get("write_song").run({ style: "dark synthwave, female vocal", lyrics: "[Verse]\nneon on the wet road\n[Chorus]\ndrive", title: "Night" });
ok("write_song returns a form patch with style, lyrics and title",
  w.form.style === "dark synthwave, female vocal" && w.form.lyrics.startsWith("[Verse]") && w.form.title === "Night" && w.form.instrumental === false);
const wi = await tools.get("write_song").run({ style: "ambient drone", instrumental: "true", lyrics: "ignored" });
ok("an instrumental carries no lyrics", wi.form.instrumental === true && !("lyrics" in wi.form));
let threw = null;
try { await tools.get("write_song").run({ style: "rock" }); } catch (e) { threw = e.message; }
ok("a song without lyrics is refused unless instrumental", /lyrics are required/.test(threw || ""), threw);

const c = await tools.get("change_settings").run({ length_seconds: 900, takes: 9, tempo: 120, key: "F#m", meter: "6/8", thinking: "Melody", random_seed: true });
ok("change_settings clamps to the panel's ranges",
  c.form.lengthSeconds === 360 && c.form.takes === 4 && c.form.tempo === 120 && c.form.key === "F#m"
  && c.form.meter === "6/8" && c.form.thinking === "melody" && c.form.randomSeed === true, JSON.stringify(c.form));
threw = null;
try { await tools.get("change_settings").run({ key: "H major" }); } catch (e) { threw = e.message; }
ok("a key that is not a key is refused", /not a key/.test(threw || ""), threw);
threw = null;
try { await tools.get("change_settings").run({}); } catch (e) { threw = e.message; }
ok("nothing to change is refused", /at least one/.test(threw || ""), threw);
ok("generate asks the page to press Create", (await tools.get("generate").run({})).action === "generate");

const described = describeForm({ engine: "YuE2", instrumental: false, title: "", style: "punk", lyrics: "[Verse]\na\nb", settings: { takes: 2, key: "" } });
ok("the form snapshot reads as lines, blank settings left out",
  /style: punk/.test(described) && /lyrics \(3 lines\)/.test(described) && /takes=2/.test(described) && !/key=/.test(described), described);

/* ══ 2. the route ═════════════════════════════════════════════════════════ */
console.log("\nTHE ROUTE");
const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-chatmusic-"));
const prompts = [];
let answers = [];
const model = async (p) => { prompts.push(p); return answers.shift() ?? '{"say":"done"}'; };
const engine = { status: async () => ({ ready: true, queue: { running: 0, pending: 0 }, running: [] }) };
const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
};
const readBody = async (req) => { const b = []; for await (const x of req) b.push(x); return b.length ? JSON.parse(Buffer.concat(b).toString()) : {}; };
const studioTools = createChatTools({ api: async () => ({ library: [], queue: [], history: [], current: null }) });
const handle = createChatRoutes({
  json, readBody, config: { uiPort: 4173, paths: { appData: dir } }, engine, model, dir, tools: studioTools,
  chatModels: { resolve: async () => null, status: async () => ({ models: [], current: null, offline: true }) },
});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (await handle(req, res, url)) return;
  json(res, 404, { error: "not found" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function post(body) {
  const r = await fetch(`${BASE}/api/chat/music`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-aiplay-actor": "script:music-tools-test" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5).trim()));
}

answers = [
  '{"tool":"write_song","args":{"style":"sad synthwave, male vocal","lyrics":"[Verse]\\nhome at three\\n[Chorus]\\nlights","title":"3AM"}}',
  '{"tool":"generate","args":{}}',
];
const form = { engine: "YuE2", instrumental: false, title: "", style: "", lyrics: "", settings: { takes: 1 } };
let ev = await post({ message: "a sad synthwave song about driving home at 3am, then make it", form });
const session = ev.find((e) => e.type === "open")?.session;
const wrote = ev.find((e) => e.type === "tool_result" && e.tool === "write_song");
ok("write_song ran and its form patch reached the stream", wrote?.result?.form?.title === "3AM", JSON.stringify(wrote));
ok("generate was PROPOSED, not run", ev.some((e) => e.type === "proposal" && e.tool === "generate")
  && !ev.some((e) => e.type === "tool_call" && e.tool === "generate"));
ok("the prompt is the Music panel's, not the studio's", /songwriting assistant inside the Music panel/.test(prompts[0]) && !/music videos by calling/.test(prompts[0]));
ok("the prompt carries what is in the form right now", /WHAT IS ON THE SCREEN RIGHT NOW:[\s\S]*music model: YuE2/.test(prompts[0]));
ok("...and the next step of the same turn sees what write_song just wrote", /title: 3AM[\s\S]*style: sad synthwave/.test(prompts[1] || ""), (prompts[1] || "").slice(-600));
ok("the studio's tools are not in the prompt", !/TOOL list_library|TOOL make_song|TOOL make_image/.test(prompts[0]));

const before = prompts.length;
ev = await post({ message: "yes", session, form });
const gen = ev.find((e) => e.type === "tool_result" && e.tool === "generate");
ok("yes runs generate and hands the page the Create action", gen?.result?.action === "generate", JSON.stringify(ev.map((e) => e.type)));
ok("...and the turn ends WITHOUT another model call (the render holds the card)", prompts.length === before, `${prompts.length - before} extra calls`);
ok("...with a plain sentence for the person", ev.some((e) => e.type === "say" && /rendering/.test(e.text)));

answers = ['{"tool":"list_library","args":{}}', '{"tool":"list_library","args":{}}', '{"say":"I can only write and make songs here."}'];
ev = await post({ message: "what is in my library?", form });
ok("a studio tool cannot be called from Simple mode", !ev.some((e) => e.type === "tool_call" && e.tool === "list_library"),
  JSON.stringify(ev.filter((e) => e.type === "tool_call")));

const r404 = await fetch(`${BASE}/api/chat/music/sessions`, { headers: { "x-aiplay-actor": "script:t" } });
ok("Simple mode serves no session list", r404.status === 404);
const files = await readdir(path.join(dir, "music")).catch(() => []);
ok("Simple conversations are kept apart from the Chat tab's", files.some((f) => f.endsWith(".jsonl")) && !(await readdir(dir)).some((f) => f.endsWith(".jsonl")));

/* ══ 3. its own model choice ══════════════════════════════════════════════ */
console.log("\nTHE MODEL DROPDOWN");
const { createChatModels } = await import("./models.js");
const info = { CLIPLoader: { input: { required: { clip_name: [["qwen3-vl-4b_fp8.safetensors", "umt5_xxl.safetensors", "gemma_3_12B_it.safetensors"]] } } } };
const fakeEngine = { objectInfo: async (cls) => { if (cls === "CLIPLoader") return info; throw new Error("no node"); } };
const settingsFile = path.join(dir, "settings.json");
const cfg = { chatModel: "gemma_3_12B_it.safetensors", chatModelMusic: null, settingsFile };
const simpleModels = createChatModels({ engine: fakeEngine, config: cfg, key: "chatModelMusic", fallbackKey: "chatModel" });
let st = await simpleModels.status();
ok("lists only chat-capable files", st.models.map((m) => m.file).join(",") === "qwen3-vl-4b_fp8.safetensors,gemma_3_12B_it.safetensors", st.models.map((m) => m.file).join(","));
ok("with nothing chosen for Simple it uses the Chat tab's model", st.current === "gemma_3_12B_it.safetensors", st.current);
await simpleModels.choose("qwen3-vl-4b_fp8.safetensors");
st = await simpleModels.status();
const { readFile: rf } = await import("node:fs/promises");
const written = JSON.parse(await rf(settingsFile, "utf8"));
ok("choosing in Simple saves chatModelMusic and leaves the Chat tab's alone",
  st.current === "qwen3-vl-4b_fp8.safetensors" && written.chatModelMusic === "qwen3-vl-4b_fp8.safetensors" && cfg.chatModel === "gemma_3_12B_it.safetensors" && !("chatModel" in written), JSON.stringify(written));
threw = null;
try { await simpleModels.choose("umt5_xxl.safetensors"); } catch (e) { threw = e.message; }
ok("a file that is not a chat model is refused", /cannot load/.test(threw || ""), threw);
const { clipTypeFor } = await import("./models.js");
ok("Qwen3-VL files load as native Qwen3-VL, not through flux2 (which skips the language_model key rename)",
  clipTypeFor("Huihui-Qwen3-VL-4B-Instruct-abliterated-fp8_scaled.safetensors") === "qwen_image"
  && clipTypeFor("qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors") === "qwen_image"
  && clipTypeFor("qwen3-4b-abliterated-q8_0.gguf") === "flux2" && clipTypeFor("gemma_3_12B_it.safetensors") === "ltxv");
const mr = await fetch(`${BASE}/api/chat/music/models`, { headers: { "x-aiplay-actor": "script:t" } });
ok("GET /api/chat/music/models answers", mr.status === 200 && Array.isArray((await mr.json()).models));

server.close();
await rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
