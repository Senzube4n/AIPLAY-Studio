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
 *
 * ONLY KEYS TYPED INTO STUDIO. This store is the one place a paid key comes
 * from (the owner, 2026-09-24: "input their own api key dont use existing
 * keys"). Nothing in server/, launcher/ or scripts/ reads a key from another
 * program's settings or from an environment variable: the names below such as
 * "FAL_KEY" are this file's own record names, not variables, and an exported
 * FAL_KEY or OPENAI_API_KEY is never looked at. The AIPLAY_ variables near the
 * paid path are the person's own switches and are listed in docs/DEEP_DIVE.md
 * ("Your own key, and only yours").
 *
 * ONE STORE PER WINDOWS ACCOUNT, NOT PER COPY. ~/.aiplay-studio is shared by
 * every Studio folder on this account, so a key saved by another copy is still
 * the person's own. Each record notes when and from which Studio folder it was
 * saved, and secretStatus() says so, so the page SHOWS a reused key ("Using
 * the key saved on 21 Sep 2026 by another copy of Studio") rather than using
 * it silently.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, chmod, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { keySentence } from "./cloud-switch.js";

const STORE = path.join(config.paths.appData, "secrets.json");
const WIN = process.platform === "win32";
/* This copy of Studio: the folder above server/. Written beside each saved key
 * so a key another copy saved can be told apart and shown as such. */
const STUDIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const samePath = (a, b) => WIN
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
/* Where the store is, said without the Windows user name: the status reaches
 * the page, cloud_status and so whatever model the in-app chat runs on. The
 * home folder is written the way the person would type it. */
function shownPath(p) {
  const home = os.homedir();
  const inHome = WIN ? p.toLowerCase().startsWith(home.toLowerCase() + path.sep) : p.startsWith(home + path.sep);
  return inHome ? (WIN ? "%USERPROFILE%" : "~") + p.slice(home.length) : p;
}
const STORE_SHOWN = shownPath(STORE);

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
      /* windowsHide: a server the launcher started hidden flashed a console
       * window on every call, and the Comfy API page polls. */
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
  store[name] = { method, value: payload, hint: v.slice(-4), at: Date.now(), from: STUDIO_ROOT };
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
  if (!rec) return { set: false, method: null, hint: null, said: keySentence(null) };
  const usable = rec.method !== "dpapi" || (await getSecret(name)) !== null;
  const out = {
    set: true,
    usable,
    method: rec.method,
    /* True only when DPAPI really encrypted it. The page says "encrypted"
     * from this and from nothing else. */
    encrypted: rec.method === "dpapi",
    hint: rec.hint ? `…${rec.hint}` : null,
    savedAt: Number.isFinite(rec.at) ? new Date(rec.at).toISOString() : null,
    /* false: another copy of Studio on this Windows account saved it. null: a
     * record from before this was noted. */
    savedHere: typeof rec.from === "string" ? samePath(rec.from, STUDIO_ROOT) : null,
    /* That copy's folder NAME only ("AIPLAYStudio-main"), never its full path. */
    savedBy: typeof rec.from === "string" && !samePath(rec.from, STUDIO_ROOT) ? path.basename(rec.from) || null : null,
    where: STORE_SHOWN,
    protection: rec.method === "dpapi"
      ? "Encrypted with Windows DPAPI, tied to your Windows account and this machine. A copy of the file is useless anywhere else."
      : WIN
        ? `Not encrypted: it is stored as plain text in ${STORE_SHOWN}. Your Windows account, this PC's administrators and any program you run can read it.`
        : `Not encrypted: it is stored as plain text in ${STORE_SHOWN}, readable only by your user account (file permissions 0600) and any program you run as you.`,
  };
  /* "Using the key …abcd saved on 21 Sep 2026 by another copy of Studio on
   * this Windows account." The one sentence every key card shows. */
  out.said = keySentence(out);
  return out;
}

/** Is a secret saved under this name? Reads the store only — no decryption,
 *  so it is cheap enough to ask on every page load. */
export async function hasSecret(name) {
  return !!(await readStore())[name];
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
