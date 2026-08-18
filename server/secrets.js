/**
 * Local secret storage for API keys.
 *
 * THE THREAT THIS ACTUALLY DEFENDS AGAINST. Not a targeted attacker with your
 * login — nothing running as you can be kept out of your own data forever. The
 * realistic case is the cheap one: a stealer script, a synced folder, a backup
 * blob, a support zip, someone else's account on a shared machine, a settings
 * file pasted into a bug report. All of those move FILES. A key sitting in
 * settings.json as plain text is stolen by every one of them for free.
 *
 * WINDOWS: DPAPI, user scope. The ciphertext is bound to the Windows user
 * account AND the machine, so a copied file is inert — on another PC, under
 * another account, or in a backup restored elsewhere, it decrypts to nothing.
 * Reached through PowerShell's ConvertFrom-SecureString / ConvertTo-SecureString,
 * which call DPAPI underneath. No native module, no npm dependency: Studio's
 * whole dependency list is `ws` and this is not worth changing that.
 *
 * ELSEWHERE: a 0600 file, and the UI says so plainly. That is the same posture
 * as ~/.ssh/id_rsa and ~/.aws/credentials — normal, but it is file permissions
 * rather than cryptography, and pretending otherwise would be worse than saying
 * it. Deriving a key from the hostname or similar would be security theatre: the
 * derivation would sit in this very file, in a public repo.
 *
 * IN EITHER CASE the plaintext is never logged, never written to the sidecar,
 * never sent to the browser, and never leaves this process except in the
 * Authorization header of a request to the provider the user chose.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "./config.js";

const STORE = path.join(config.paths.appData, "secrets.json");
const WIN = process.platform === "win32";

/** Run PowerShell with the SCRIPT base64-encoded in argv and the SECRET on
 *  stdin.
 *
 *  Both halves of that matter. The secret must not be in argv, because argv is
 *  readable by any process on the machine for as long as this one lives — which
 *  would defeat the whole exercise. And the script cannot also come from stdin
 *  (`-Command -`), because then PowerShell consumes stdin as the program and
 *  `[Console]::In.ReadToEnd()` returns empty; the first version of this did
 *  exactly that, failed, and fell back to storing plaintext while reporting
 *  success. -EncodedCommand takes the script through argv (it holds no secret)
 *  and leaves stdin for the data. */
function ps(script, stdin = "") {
  return new Promise((res, rej) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const p = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("close", (code) => (code === 0 ? res(out.trim()) : rej(new Error(err.trim() || `powershell exit ${code}`))));
    // The script went in via -EncodedCommand. stdin carries ONLY the secret —
    // writing the script here too is what made the first version encrypt its own
    // source code instead of the key, and report success while doing it.
    if (stdin) p.stdin.write(stdin);
    p.stdin.end();
  });
}

/**
 * DPAPI-protect a string.
 *
 * The plaintext arrives on stdin rather than being interpolated into the script,
 * because a key spliced into a command line is visible in the process table for
 * as long as the process lives.
 */
async function protect(plain) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$plain = [Console]::In.ReadToEnd().Trim()",
    "$sec = ConvertTo-SecureString -String $plain -AsPlainText -Force",
    // No -Key: user-scope DPAPI. That binding is the entire point.
    "ConvertFrom-SecureString -SecureString $sec",
  ].join("; ");
  return ps(script, plain);
}

async function unprotect(blob) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$blob = [Console]::In.ReadToEnd().Trim()",
    "$sec = ConvertTo-SecureString -String $blob",
    "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)",
    // try/finally MUST stay one element. These lines are joined with "; ", and a
    // semicolon between `try {}` and `finally {}` is a PowerShell parse error —
    // which failed silently here and looked exactly like "wrong machine".
    "try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }",
  ].join("; ");
  return ps(script, blob);
}

async function readStore() {
  try { return JSON.parse(await readFile(STORE, "utf8")); } catch { return {}; }
}

async function writeStore(obj) {
  await mkdir(path.dirname(STORE), { recursive: true });
  await writeFile(STORE, JSON.stringify(obj, null, 2), "utf8");
  // No-op on Windows (ACLs govern there, and DPAPI is doing the real work), but
  // it is the whole protection on everything else.
  try { await chmod(STORE, 0o600); } catch { /* filesystem may not support it */ }
}

/** Save a secret. Returns how it ended up protected, for the UI to report. */
export async function setSecret(name, value) {
  const store = await readStore();
  const v = String(value ?? "").trim();
  if (!v) {
    delete store[name];
    await writeStore(store);
    return { stored: false, method: "cleared" };
  }
  let method = "file-permissions";
  let payload = v;
  if (WIN) {
    try {
      payload = await protect(v);
      method = "dpapi";
    } catch {
      // Better a stored key with a truthful label than a failed save the user
      // works around by pasting it into a config file themselves.
      method = "file-permissions";
      payload = v;
    }
  }
  store[name] = { method, value: payload, hint: v.slice(-4), at: Date.now() };
  await writeStore(store);
  return { stored: true, method };
}

/** Read a secret back. Returns null when absent or undecryptable. */
export async function getSecret(name) {
  const rec = (await readStore())[name];
  if (!rec) return null;
  if (rec.method !== "dpapi") return rec.value;
  try {
    return await unprotect(rec.value);
  } catch {
    /* Wrong user, wrong machine, or a restored backup. That is DPAPI working as
     * intended, not a bug — the UI asks for the key again. */
    return null;
  }
}

/**
 * What the BROWSER is allowed to know: that a key exists, how it is protected,
 * and its last four characters. Never the key.
 *
 * Studio's UI is a web page on localhost. Anything handed to it is one XSS or
 * one careless screenshot away from being public, and a key does not need to be
 * there for the app to work — the server makes the calls.
 */
export async function secretStatus(name) {
  const rec = (await readStore())[name];
  if (!rec) return { set: false, method: null, hint: null };
  const usable = rec.method !== "dpapi" || (await getSecret(name)) !== null;
  return {
    set: true,
    usable,
    method: rec.method,
    hint: rec.hint ? `…${rec.hint}` : null,
    protection: rec.method === "dpapi"
      ? "Encrypted with Windows DPAPI, tied to your Windows account and this machine. A copy of the file is useless anywhere else."
      : "Stored in a file only your user account can read. That is file permissions, not encryption.",
  };
}

export async function clearSecret(name) {
  const store = await readStore();
  delete store[name];
  await writeStore(store);
}

/** Does this machine offer real encryption, or only file permissions? */
export function protectionAvailable() {
  return WIN ? "dpapi" : "file-permissions";
}

export const SECRETS_PATH = STORE;
export const PLATFORM = os.platform();
