// No models: executable selection and cleanup of an owned two-process fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { config } from "../config.js";
import { meshPythonForArgs, runMeshCli, killMeshProcessTree } from "./runner.js";

const previous = { python: config.mesh.python, unirigPython: config.mesh.unirigPython };
try {
  config.mesh.python = "missing-tripog-test-python.exe";
  config.mesh.unirigPython = "missing-unirig-test-python.exe";
  assert.equal(meshPythonForArgs(["--image", "x.png"]), config.mesh.python);
  assert.equal(meshPythonForArgs(["--rig-only"]), config.mesh.unirigPython);
  assert.equal(meshPythonForArgs(["--rig-probe"]), config.mesh.unirigPython);
  await assert.rejects(runMeshCli(["--rig-probe"]), /missing-unirig-test-python/);
  await assert.rejects(runMeshCli(["--selftest"]), /missing-tripog-test-python/);
} finally {
  Object.assign(config.mesh, previous);
}

const code = `const {spawn}=require('node:child_process');
const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{windowsHide:true,stdio:'ignore'});
console.log(c.pid);setTimeout(()=>{},60000);`;
const owned = spawn(process.execPath, ["-e", code], {
  windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
});
let childPid;
const timeout = setTimeout(() => { void killMeshProcessTree(owned); }, 10000);
try {
  childPid = await new Promise((resolve, reject) => {
    let text = "";
    owned.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(Number(text.trim()));
    });
    owned.once("error", reject);
    owned.once("exit", () => reject(new Error("fixture exited before reporting its child")));
  });
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  const closed = once(owned, "close");
  assert.equal(await killMeshProcessTree(owned), true);
  await closed;
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
} finally {
  clearTimeout(timeout);
  if (owned.exitCode === null && owned.signalCode === null) await killMeshProcessTree(owned);
}
console.log("UniRig runtime: separate executable dispatch and owned process-tree cleanup passed.");
