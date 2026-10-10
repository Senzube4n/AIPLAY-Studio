import test from "node:test";
import assert from "node:assert/strict";
import { fastCoverTools } from "./mcp-fastcovers.js";

test("CPU cover controls use Settings routes; status starts no setup", async () => {
  const calls = [];
  const tools = Object.fromEntries(fastCoverTools(async (...args) => { calls.push(args); return { enabled: args[2]?.enabled ?? true }; }).map(t => [t.name, t]));
  await tools.fastcovers_status.run({});
  assert.deepEqual(calls, [["GET", "/api/fastcovers"]]);
  assert.deepEqual(await tools.set_fastcovers.run({ enabled: false }), { enabled: false });
  assert.deepEqual(calls[1], ["POST", "/api/fastcovers", { enabled: false }]);
  await tools.set_fastcovers.run({ enabled: true });
  assert.deepEqual(calls[2], ["POST", "/api/fastcovers", { enabled: true }]);
  const count = calls.length;
  for (const bad of [null, [], {}, { enabled: "true" }, { enabled: true, python: "arbitrary" }]) await assert.rejects(tools.set_fastcovers.run(bad));
  await assert.rejects(tools.fastcovers_status.run({ enabled: true }));
  assert.equal(calls.length, count, "invalid controls must not start downloads or alter preferences");
});
