/** Windows bootstrap trust boundaries. No live install, certificate or app launch. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8").replaceAll("\r\n", "\n");
const builds = ["scripts/build-installer.mjs", "scripts/build-launcher-exe.mjs"];

function removeFixture(dir, prefix) {
  const resolved = fs.realpathSync(dir), temp = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), temp, "cleanup stays directly inside the system temp folder");
  assert.ok(path.basename(resolved).startsWith(prefix), "cleanup owns only this freshly created fixture");
  fs.rmSync(resolved, { recursive: true, force: true });
}

function signing(source, { requested = true, sdk = true, fail = "" } = {}) {
  const calls = [], logs = [];
  const start = source.indexOf("/* ── signing");
  assert.ok(start >= 0, "execute the actual build script's signing block");
  const env = requested ? { AIPLAY_SIGN_SHA1: "fixture-thumbprint" } : {};
  const state = {
    path, OUT: "fixture.exe", process: { env, exit(code) { throw new Error("exit:" + code); } },
    console: { log(...args) { logs.push(args.join(" ")); }, error(...args) { logs.push(args.join(" ")); } },
    execFileSync(exe, args) { calls.push({ exe, args: Array.from(args) }); if (args[0] === fail) throw new Error("fixture-" + fail + "-failed"); },
  };
  // A source slice must not gain helpers its real module forgot to import.
  const importedFs = /import\s*\{([^}]+)\}\s*from\s*["']node:fs["']/.exec(source);
  assert.ok(importedFs, "read the build's actual named filesystem imports");
  const fsMocks = { existsSync() { return sdk; }, readdirSync() { return ["10.0.26100.0"]; } };
  for (const entry of importedFs[1].split(",")) {
    const binding = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(entry);
    assert.ok(binding, "unsupported filesystem import binding: " + entry);
    if (Object.hasOwn(fsMocks, binding[1])) state[binding[2] || binding[1]] = fsMocks[binding[1]];
  }
  return { calls, logs, run() { return vm.runInNewContext(source.slice(start), state); } };
}

for (const build of builds) {
  const source = read(build);
  test(build + ": unsigned builds are explicit and never call signtool", () => {
    const fixture = signing(source, { requested: false });
    fixture.run(); assert.equal(fixture.calls.length, 0);
    assert.match(fixture.logs.join("\n"), /unsigned/i);
  });
  test(build + ": requested signing refuses a missing SDK", () => {
    const fixture = signing(source, { sdk: false });
    assert.throws(() => fixture.run(), /exit:1/);
    assert.equal(fixture.calls.length, 0);
  });
  test(build + ": a signing failure stops before verification", () => {
    const fixture = signing(source, { fail: "sign" });
    assert.throws(() => fixture.run(), /fixture-sign-failed/);
    assert.deepEqual(fixture.calls.map(x => x.args[0]), ["sign"]);
  });
  test(build + ": untrusted or invalid signatures fail the requested build", () => {
    const fixture = signing(source, { fail: "verify" });
    assert.throws(() => fixture.run(), /fixture-verify-failed/);
    assert.deepEqual(fixture.calls.map(x => x.args[0]), ["sign", "verify"]);
    assert.doesNotMatch(fixture.logs.join("\n"), /signed and verified/);
  });
  test(build + ": successful signing requests a timestamp and verifies Authenticode", () => {
    const fixture = signing(source); fixture.run();
    assert.deepEqual(fixture.calls.map(x => x.args[0]), ["sign", "verify"]);
    assert.ok(fixture.calls[0].args.includes("/tr"));
    assert.ok(fixture.calls[0].args.includes("/td"));
    assert.deepEqual(fixture.calls[1].args, ["verify", "/pa", "fixture.exe"]);
    assert.match(fixture.logs.join("\n"), /signed and verified/);
  });
}

test("the signing fixture does not invent an unimported filesystem helper", () => {
  const source = read("scripts/build-installer.mjs").replace(/\breaddirSync\s*,?\s*(?=[^}]*\}\s*from\s*["']node:fs["'])/, "");
  const fixture = signing(source);
  assert.throws(() => fixture.run(), /readdirSync is not defined/);
  assert.equal(fixture.calls.length, 0);
});

test("both manual bootstrap paths install locked packages without lifecycle scripts", () => {
  const batch = read("AIPLAY Studio.cmd"), launcher = read("launcher/exe/AiplayLauncher.cs");
  assert.match(batch, /call npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  assert.match(launcher, / ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(batch, /call npm install\b/);
  assert.doesNotMatch(launcher, /" install --omit=dev/);
  assert.match(launcher, /!InstallDependencies\(root, node, path\) \|\| !DepsPresent\(root\)/);
  const lock = JSON.parse(read("package-lock.json")), pkg = JSON.parse(read("package.json"));
  assert.equal(Object.values(lock.packages).some(entry => entry.hasInstallScript), false, "a future dependency hook needs an explicit bootstrap review");
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts?.[hook], undefined);
});

function npmCli() {
  const direct = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(direct)) return direct;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
    if (!fs.existsSync(candidate)) continue;
    const real = fs.realpathSync(candidate);
    if (real.endsWith("npm-cli.js")) return real;
    const adjacent = path.join(path.dirname(real), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(adjacent)) return adjacent;
  }
  return null;
}

test("the shipped npm arguments suppress a real local postinstall and preserve the lockfile", t => {
  const cli = npmCli();
  if (!cli) { t.skip("npm CLI is not installed on this test machine"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-npm-proof-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('hook-ran','unexpected')\"" } }));
    const lock = JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", hasInstallScript: true } } });
    fs.writeFileSync(path.join(dir, "package-lock.json"), lock);
    const args = /^call npm (ci .+)$/m.exec(read("AIPLAY Studio.cmd"))[1].split(" ");
    const localArgs = [cli, ...args, "--offline", "--cache", path.join(dir, "cache")];
    execFileSync(process.execPath, localArgs, { cwd: dir, windowsHide: true, stdio: "pipe", timeout: 30_000 });
    assert.equal(fs.existsSync(path.join(dir, "hook-ran")), false);
    assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), lock);
    const changed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    changed.dependencies = { "fixture-not-in-lock": "1.0.0" };
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(changed));
    assert.throws(() => execFileSync(process.execPath, localArgs, { cwd: dir, windowsHide: true, stdio: "pipe", timeout: 30_000 }));
    assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), lock);
    assert.equal(fs.existsSync(path.join(dir, "hook-ran")), false);
  } finally { removeFixture(dir, "aiplay-npm-proof-"); }
});

test("the actual compiled launcher refuses npm failure even when dependency folders exist", t => {
  if (process.platform !== "win32") { t.skip("Windows C# launcher fixture"); return; }
  const csc = ["Framework64", "Framework"].map(part => path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", part, "v4.0.30319", "csc.exe")).find(fs.existsSync);
  if (!csc) { t.skip(".NET Framework C# compiler unavailable"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiplay-launcher-proof-"));
  try {
    const library = path.join(dir, "launcher.dll"), harness = path.join(dir, "proof.exe"), source = path.join(dir, "proof.cs");
    execFileSync(csc, ["/nologo", "/target:library", "/r:System.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", "/out:" + library, path.join(ROOT, "launcher/exe/AiplayLauncher.cs")], { windowsHide: true, stdio: "pipe", timeout: 30_000 });
    fs.writeFileSync(source, `using System; using System.Reflection; class Proof { static int Main(string[] args) { var type = Assembly.LoadFrom(args[0]).GetType("Program"); var method = type.GetMethod("InstallDependencies", BindingFlags.NonPublic | BindingFlags.Static); bool actual = (bool)method.Invoke(null, new object[]{args[1], System.IO.Path.Combine(args[1],"node.exe"), Environment.GetEnvironmentVariable("PATH")}); Console.WriteLine("accepted="+actual); return actual == bool.Parse(args[2]) ? 0 : 17; } }`);
    execFileSync(csc, ["/nologo", "/out:" + harness, source], { windowsHide: true, stdio: "pipe", timeout: 30_000 });
    const app = path.join(dir, "app with spaces"); fs.mkdirSync(app);
    for (const pkg of ["ws", "three", "gltf-validator", "@pixiv/three-vrm", "ag-psd"]) fs.mkdirSync(path.join(app, "node_modules", pkg), { recursive: true });
    for (const [code, accepted] of [[7, false], [0, true]]) {
      fs.writeFileSync(path.join(app, "npm.cmd"), "@echo off\r\n> \"%~dp0npm-args.txt\" echo %*\r\nexit /b " + code + "\r\n");
      const output = execFileSync(harness, [library, app, String(accepted)], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
      assert.match(output, new RegExp("accepted=" + (accepted ? "True" : "False")));
      assert.equal(fs.readFileSync(path.join(app, "npm-args.txt"), "utf8").trim(), "ci --omit=dev --ignore-scripts --no-audit --no-fund");
    }
  } finally { removeFixture(dir, "aiplay-launcher-proof-"); }
});
