import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const slug = "episode-3";
const projects = [{ slug, title: "Episode 3" }];

test("Code Mode over Studio's stdio MCP transport", async (t) => {
  const requests = [];
  const pending = new Map();
  const studio = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const reply = (value, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/mv/previz") return reply({ sets: { names: ["corridor"] } });
    requests.push({ method: req.method, path: req.url, body, actor: req.headers["x-aiplay-actor"] });

    // Neither response is released until both calls arrive. A serial bridge
    // will time out instead of passing a test that only checks the result.
    if (req.method === "GET" && req.url === `/api/mv/project/${slug}`) {
      const segments = [{ id: "s1", index: 0 }, { id: "s2", index: 1 }];
      pending.set("project", () => reply({ project: { slug, segments } }));
    } else if (req.method === "POST" && req.url === "/api/mv" && body.action === "lint" && body.slug === slug) {
      const issues = [{ level: "warn", where: "scene 2", msg: "Mara's reference sheet is missing." }];
      pending.set("lint", () => reply({ issues }));
    } else if (req.method === "POST" && req.url === "/api/mv" && body.action === "shot" && body.slug === slug && body.segmentId === "s2") {
      return reply({ shot: { refsMissing: [{ name: "Mara" }], prompt: "Private prompt from the project" }, declared: [] });
    } else if (req.method === "GET" && req.url === "/api/mv/projects") {
      return reply({ projects });
    } else {
      return reply({ error: `Unexpected fixture request ${req.method} ${req.url}` }, 404);
    }
    if (pending.size === 2) {
      for (const send of pending.values()) send();
      pending.clear();
    }
  });
  studio.listen(0, "127.0.0.1");
  await once(studio, "listening");

  const mcp = spawn(process.execPath, [fileURLToPath(new URL("./mcp.js", import.meta.url))], {
    env: { ...process.env, AIPLAY_URL: `http://127.0.0.1:${studio.address().port}`, AIPLAY_AGENT: "code-mode-test" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = createInterface({ input: mcp.stdout });
  const lines = stdout[Symbol.asyncIterator]();
  let stderr = "";
  let serial = 0;
  mcp.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });

  async function rpc(method, params) {
    const id = ++serial;
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const line = await Promise.race([lines.next(), setTimeout(12_000, null, { ref: false })]);
    assert.ok(line && !line.done, `No MCP reply for ${method}. ${stderr}`);
    const response = JSON.parse(line.value);
    assert.equal(response.id, id);
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  }

  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  const run = (code) => call("studio_run", { code });
  function jsonResult(result) {
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    return JSON.parse(result.content[0].text);
  }

  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "code-mode-test", version: "1.0.0" },
    });
    await t.test("lists the tool and returns a small result from parallel, conditional Studio calls", async () => {
      const { tools } = await rpc("tools/list");
      assert.ok(tools.some((tool) => tool.name === "studio_run"));
      assert.ok(tools.some((tool) => tool.name === "mv_list_projects"));
      const result = jsonResult(await run(`
        const slug = "episode-3";
        const [opened, issues] = await Promise.all([
          tools.mv_open_project({ slug }), tools.mv_lint({ slug }),
        ]);
        const rows = [];
        for (const segment of opened.project.segments) {
          const where = "scene " + (segment.index + 1);
          if (!issues.some((issue) => issue.where === where)) continue;
          const { shot } = await tools.mv_shot({ slug, segment: segment.id });
          rows.push({ segment: segment.id, missing: shot.refsMissing.map((ref) => ref.name) });
        }
        return { slug, rows };
      `));
      assert.deepEqual(result, { slug, rows: [{ segment: "s2", missing: ["Mara"] }] });
      assert.equal(requests.length, 3);
      assert.ok(requests.every((request) => request.actor === "agent:code-mode-test"));
    });

    await t.test("has no Node or network globals and refuses writes through the generic API tool", async () => {
      const before = requests.length;
      const types = jsonResult(await run("return [typeof process, typeof require, typeof fetch];"));
      assert.deepEqual(types, ["undefined", "undefined", "undefined"]);
      const denied = await run(`
        return await tools.studio_api_request({ method: "POST", path: "/api/mv",
          body: { action: "create", title: "Should not be created" } });
      `);
      assert.equal(denied.isError, true);
      assert.equal(requests.length, before);
    });

    await t.test("validates allowlisted call arguments before contacting Studio", async () => {
      const before = requests.length;
      const invalid = await run(`return await tools.mv_lint({ slug: 17 });`);
      assert.equal(invalid.isError, true);
      assert.equal(requests.length, before);
    });

    await t.test("preserves JSON fields that ordinary tools reserve for images", async () => {
      assert.deepEqual(jsonResult(await run('return { _images: ["example"] };')), { _images: ["example"] });
    });

    await t.test("interrupts an unbounded script and still serves ordinary MCP calls", async () => {
      const interrupted = await run("while (true) {}");
      assert.equal(interrupted.isError, true);
      assert.match(interrupted.content[0].text, /interrupt|timeout|timed out|time limit|deadline/i);
      assert.deepEqual(jsonResult(await call("mv_list_projects")), projects);
    });

    await t.test("reports a script with no JSON return as a tool error", async () => {
      const result = await run("return undefined;");
      assert.equal(result.isError, true);
    });
  } finally {
    stdout.close();
    mcp.kill();
    await new Promise((resolve) => {
      studio.close(resolve);
      studio.closeAllConnections();
    });
  }
});
