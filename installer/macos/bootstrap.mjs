/** macOS first-launch setup. Built-ins only; downloaded application modules are
 * never imported here. The private Node runtime is supplied by the package. */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPO = 'Senzube4n/AIPLAY-Studio';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const HEADERS = { 'User-Agent': 'AIPLAY-Studio-macOS-Setup', Accept: 'application/vnd.github+json' };
const LIMIT = { archive: 512 * 1024 ** 2, unpacked: 2 * 1024 ** 3, file: 512 * 1024 ** 2, entries: 100_000 };
const OMIT = ['AIPLAY Studio.exe', 'AIPLAY Studio.cmd'];
const fail = message => { throw new Error(message); };
const exists = async file => { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const safeRelative = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && !/[\\:\x00-\x1f\x7f]/.test(value) && !value.startsWith('/')
  && !value.split('/').some(piece => !piece || piece === '.' || piece === '..');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const stamp = () => `${Date.now()}-${randomBytes(6).toString('hex')}`;

export function defaultDataRoot(_env = process.env, home = os.homedir()) {
  if (!path.isAbsolute(home)) fail('The home folder must be absolute.');
  return path.join(home, 'Library', 'Application Support', 'AIPLAY Studio');
}

export function parseOptions(args) {
  const result = { repo: DEFAULT_REPO, ref: 'main', repair: false, installOnly: false, noOpen: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--install-only') result.installOnly = true;
    else if (arg === '--no-open') result.noOpen = true;
    else if (arg === '--repair') result.repair = true;
    else if (arg === '--repo' || arg === '--ref') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`${arg} needs a value.`);
      result[arg.slice(2)] = args[++i];
    } else fail(`Unknown setup option: ${arg}.`);
  }
  if (!REPO.test(result.repo) || result.repo.length > 180 || result.repo.split('/').some(s => s === '.' || s === '..')) fail('Use a GitHub repository in owner/name form.');
  if (result.ref !== 'main' && !SHA.test(result.ref)) fail('The source must be main or a full lowercase commit SHA.');
  return result;
}

/** Mirror only the declarative macOS manifest selection; no downloaded code is
 * evaluated to decide what files may reach the writable installation. */
export function macosManifest(raw) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object'
    || !Array.isArray(raw.include) || !raw.include.length
    || raw.include.some(p => !safeRelative(p) || p.includes('/') || p.startsWith('.') || ['node_modules', 'node', 'runtime'].includes(p))) fail('The app payload has an invalid include list.');
  for (const key of ['required', 'preserve']) if (!Array.isArray(raw[key]) || raw[key].some(p => !safeRelative(p))) fail(`The app payload has an invalid ${key} list.`);
  for (const key of ['exclude', 'keep']) if (!Array.isArray(raw[key]) || raw[key].some(p => typeof p !== 'string' || !p || /[\x00-\x1f]/.test(p))) fail(`The app payload has an invalid ${key} list.`);
  const omit = raw.platforms?.darwin?.omit;
  if (!Array.isArray(omit) || omit.length !== OMIT.length || OMIT.some(p => !omit.includes(p))) fail('This source does not declare a supported macOS payload.');
  const manifest = { ...raw, include: raw.include.filter(p => !omit.includes(p)), required: raw.required.filter(p => !omit.includes(p)) };
  for (const p of manifest.required) if (!manifest.include.some(top => p === top || p.startsWith(top + '/'))) fail('A required path is outside the app payload.');
  if (manifest.preserve.some(p => !['workflows/custom', 'vendor/previz-blender'].includes(p))) fail('The app payload requests an unsupported personal folder.');
  for (const needed of ['install.json', 'package.json', 'package-lock.json', 'launcher/launcher.mjs', 'server/index.js', 'scripts/verify-install.mjs']) if (!manifest.required.includes(needed)) fail(`The macOS payload must require ${needed}.`);
  return manifest;
}

function matches(value, pattern) {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(value);
}
function included(file, manifest) {
  if (!manifest.include.some(top => file === top || file.startsWith(top + '/'))) return false;
  const match = pattern => matches(pattern.includes('/') ? file : path.posix.basename(file), pattern);
  return manifest.keep.some(match) || !manifest.exclude.some(match);
}

export function validateArchiveEntries(entries) {
  const seen = new Set(); let root = null;
  for (const { name, type = '0' } of entries) {
    const clean = String(name).replace(/\/$/, '');
    if (!safeRelative(clean) || !['0', '\0', '5'].includes(type)) fail('The source archive contains an unsafe path or link.');
    const top = clean.split('/')[0];
    if (root && top !== root) fail('The source archive has more than one root folder.');
    root = top;
    const key = clean.toLowerCase();
    if (seen.has(key)) fail('The source archive repeats a path.');
    seen.add(key);
  }
  return root;
}

function octal(buffer, begin, length) {
  const value = buffer.subarray(begin, begin + length).toString('ascii').replace(/\0/g, '').trim();
  if (value && !/^[0-7]+$/.test(value)) fail('The source archive has an invalid numeric field.');
  const n = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(n) || n < 0) fail('The source archive is too large.');
  return n;
}
function tarString(buffer, begin, length) {
  const bytes = buffer.subarray(begin, begin + length), nul = bytes.indexOf(0);
  const value = bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
  if (value.includes('\ufffd')) fail('The source archive contains an invalid UTF-8 path.');
  return value;
}
function paxFields(buffer) {
  const fields = {}; let cursor = 0;
  while (cursor < buffer.length) {
    const space = buffer.indexOf(32, cursor);
    if (space < cursor || space > cursor + 10) fail('The source archive has invalid extended metadata.');
    const lengthText = buffer.subarray(cursor, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) fail('The source archive has invalid extended metadata.');
    const length = Number(lengthText), end = cursor + length;
    if (end > buffer.length || end <= space + 2 || buffer[end - 1] !== 10) fail('The source archive has invalid extended metadata.');
    const value = buffer.subarray(space + 1, end - 1).toString('utf8'), eq = value.indexOf('=');
    if (eq < 1 || value.includes('\ufffd')) fail('The source archive has invalid extended metadata.');
    const key = value.slice(0, eq);
    if (Object.hasOwn(fields, key) || key === 'linkpath') fail('The source archive contains unsupported link metadata.');
    fields[key] = value.slice(eq + 1); cursor = end;
  }
  return fields;
}

/** A bounded streaming tar reader. GitHub git-archive PAX paths are supported;
 * hard links, symbolic links, devices and executable archive hooks are refused. */
export async function extractSource(archive, destination) {
  const input = createReadStream(archive), unzip = createGunzip(); input.pipe(unzip);
  input.on('error', error => unzip.destroy(error));
  const iterator = unzip[Symbol.asyncIterator](); let buffer = Buffer.alloc(0), offset = 0, total = 0, ended = false;
  async function take(count, sink) {
    let left = count, result = sink ? null : Buffer.alloc(count), at = 0;
    while (left) {
      if (offset === buffer.length) {
        const next = await iterator.next();
        if (next.done) fail('The source archive ended early.');
        buffer = next.value; offset = 0; total += buffer.length;
        if (total > LIMIT.unpacked) fail('The unpacked source exceeds the setup size limit.');
      }
      const n = Math.min(left, buffer.length - offset), part = buffer.subarray(offset, offset + n);
      if (sink) await sink.writeFile(part); else part.copy(result, at);
      offset += n; at += n; left -= n;
    }
    return result;
  }
  const entries = [], seen = new Set(); let root = null, extended = {}, count = 0;
  try {
    while (!ended) {
      const header = await take(512);
      if (header.every(byte => byte === 0)) {
        if (!(await take(512)).every(byte => byte === 0)) fail('The source archive has an invalid end marker.');
        ended = true; break;
      }
      let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (sum !== octal(header, 148, 8)) fail('The source archive header checksum is invalid.');
      const type = String.fromCharCode(header[156]), size = octal(header, 124, 12);
      if (size > LIMIT.file || ++count > LIMIT.entries) fail('The source archive exceeds setup limits.');
      const prefix = tarString(header, 345, 155), base = tarString(header, 0, 100);
      let name = prefix ? `${prefix}/${base}` : base;
      if (type === 'x' || type === 'g') {
        if (size > 64 * 1024) fail('The source archive has excessive extended metadata.');
        const fields = paxFields(await take(size));
        if (type === 'g' && (fields.path || fields.size)) fail('The source archive has unsupported global path metadata.');
        if (type === 'x') extended = fields;
      } else {
        if (extended.path !== undefined) name = extended.path;
        if (extended.size !== undefined && extended.size !== String(size)) fail('The source archive has conflicting size metadata.');
        extended = {};
        const clean = name.replace(/\/$/, '');
        if (!safeRelative(clean) || !['0', '\0', '5'].includes(type)) fail('The source archive contains an unsafe path or link.');
        const top = clean.split('/')[0], key = clean.toLowerCase();
        if (root && top !== root) fail('The source archive has more than one root folder.');
        root = top;
        if (seen.has(key)) fail('The source archive repeats a path.');
        seen.add(key); entries.push({ name: clean, type });
        const target = path.join(destination, ...clean.split('/'));
        if (!inside(destination, target)) fail('The source archive escapes its setup folder.');
        if (type === '5') {
          if (size !== 0) fail('The source archive has a directory with file data.');
          await mkdir(target, { recursive: true, mode: 0o700 });
        } else {
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          const file = await open(target, 'wx', 0o600);
          try { await take(size, file); } finally { await file.close(); }
          // Only executable-vs-data is inherited; no setuid or writable-to-all bits.
          await chmod(target, octal(header, 100, 8) & 0o111 ? 0o700 : 0o600);
        }
      }
      if (size % 512) await take(512 - size % 512);
    }
    if (Object.keys(extended).length) fail('The source archive ends with unused path metadata.');
    if (buffer.subarray(offset).some(byte => byte !== 0)) fail('The source archive contains trailing data.');
    for await (const tail of { [Symbol.asyncIterator]: () => iterator }) {
      total += tail.length;
      if (total > LIMIT.unpacked || tail.some(byte => byte !== 0)) fail('The source archive contains trailing data.');
    }
    if (!root || entries.length < 1) fail('The source archive has no application files.');
    return path.join(destination, root);
  } finally { input.destroy(); unzip.destroy(); }
}

async function ordinary(file, directory) {
  const info = await lstat(file);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) fail('A setup path is not an ordinary file or folder.');
}
async function ordinaryTree(folder) {
  await ordinary(folder, true);
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) await ordinaryTree(target);
    else await ordinary(target, false);
  }
}
async function ordinaryPath(root, relative) {
  let current = root;
  for (const piece of relative.split('/')) {
    current = path.join(current, piece);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) fail('A personal folder contains an unsafe link or file.');
  }
}

async function boundedText(response, limit = 2 * 1024 ** 2) {
  let length = 0; const chunks = [];
  if (!response.body) fail('The server returned an empty response.');
  for await (const chunk of response.body) {
    length += chunk.length; if (length > limit) fail('The server returned excessive metadata.'); chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A repair must not replace files under a running launcher or Studio. These
 * conservative, read-only checks use only the two configured loopback ports. */
export async function probeRunning({ fetchFn = fetch, env = process.env } = {}) {
  const ports = [env.AIPLAY_LAUNCHER_PORT || '4170', env.AIPLAY_UI_PORT || '4173'];
  if (ports.some(port => !/^[0-9]{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)) fail('The configured Studio port is invalid.');
  let busy = false, launcherUrl = null;
  for (let i = 0; i < ports.length; i++) {
    const base = `http://127.0.0.1:${Number(ports[i])}`;
    try {
      const response = await fetchFn(base + (i === 0 ? '/api/ping' : '/api/status'), { redirect: 'error', signal: AbortSignal.timeout(1200) });
      busy = true;
      if (i === 0 && response.ok) {
        let body; try { body = JSON.parse(await boundedText(response, 8192)); } catch { /* unrelated service is still busy */ }
        if (body?.app === 'aiplay-launcher') launcherUrl = base + '/';
      } else await response.body?.cancel();
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') busy = true;
    }
  }
  return { busy, launcherUrl };
}

function openBrowserUrl(url, spawnFn = spawn) {
  let reported = false;
  const report = () => { if (!reported) { reported = true; console.error(`Open this address in your browser: ${url}`); } };
  const child = spawnFn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
  child.once('error', report); child.once('exit', code => { if (code !== 0) report(); }); child.unref();
}

/** A second menu click reopens the real existing launcher without starting a
 * progress server or another launcher. Headless install-only never takes this shortcut. */
export async function reuseLauncher(options, { runtimeCheck = probeRunning, spawnFn = spawn, say = console.log } = {}) {
  const running = await runtimeCheck();
  if (options.repair && running.busy) fail('Close the Studio launcher and Studio before repairing this app.');
  if (!options.repair && !options.installOnly && running.launcherUrl) {
    say(`Studio launcher: ${running.launcherUrl}`);
    if (!options.noOpen) openBrowserUrl(running.launcherUrl, spawnFn);
    return true;
  }
  return false;
}

async function copyPayload(source, stage, manifest) {
  async function walk(relative) {
    const from = path.join(source, ...relative.split('/')), info = await lstat(from);
    if (info.isSymbolicLink()) fail('The application payload contains a link.');
    if (info.isDirectory()) {
      await mkdir(path.join(stage, ...relative.split('/')), { recursive: true, mode: 0o700 });
      for (const entry of await readdir(from)) await walk(`${relative}/${entry}`);
    } else if (info.isFile()) {
      if (!included(relative, manifest)) return;
      const target = path.join(stage, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await cp(from, target, { errorOnExist: true, force: false });
    } else fail('The application payload contains an unsupported file.');
  }
  for (const name of manifest.include) if (await exists(path.join(source, name))) await walk(name);
}

async function installedInfo(app, repo) {
  if (!await exists(app)) return null;
  await ordinary(app, true);
  let info;
  try { await ordinary(path.join(app, 'install-info.json'), false); info = await json(path.join(app, 'install-info.json')); }
  catch { fail('This app folder is not managed by macOS Setup. Keep that folder and move it aside before retrying setup.'); }
  if (info.macosBootstrap?.version !== 1 || !REPO.test(info.repo || '') || repo && info.repo !== repo || !SHA.test(info.commit || '')) fail('This app folder belongs to another installation.');
  return info;
}

export const runCommand = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2, timeout: 15 * 60_000, ...options }, (error, stdout) => {
    if (error) reject(new Error('A setup command failed. Restart setup to retry; your previous app is preserved.'));
    else resolve(stdout);
  });
});

async function download(fetchFn, url, target, expectedSha256, say) {
  const response = await fetchFn(url, { headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) fail(`The source download failed (${response.status}). Check your connection and restart setup.`);
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > LIMIT.archive) fail('The source download exceeds the setup size limit.');
  const hash = createHash('sha256'), file = await open(target, 'wx', 0o600); let bytes = 0, last = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > LIMIT.archive) fail('The source download exceeds the setup size limit.');
      hash.update(chunk); await file.writeFile(chunk);
      if (bytes - last > 8 * 1024 ** 2) { say(`Downloading Studio: ${Math.ceil(bytes / 1024 ** 2)} MB`); last = bytes; }
    }
    await file.sync();
  } finally { await file.close(); }
  const sha256 = hash.digest('hex');
  if (!bytes || expectedSha256 && sha256 !== expectedSha256) fail('The source download checksum does not match.');
  return { bytes, sha256 };
}

/** Transaction seam for fixture tests. fetchFn/command/hooks are injected by
 * local tests only; the public CLI exposes no URL, filesystem or command hook. */
export async function installStudio({ dataRoot = defaultDataRoot(), repo = DEFAULT_REPO, ref = 'main', repair = false,
  fetchFn = fetch, command = runCommand, say = () => {}, nodePath = process.execPath,
  npmCli = path.resolve(path.dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  expectedArchiveSha256, transactionHook = async () => {}, runtimeCheck = probeRunning } = {}) {
  parseOptions(['--repo', repo, '--ref', ref]);
  if (!path.isAbsolute(dataRoot)) fail('The app data folder must be absolute.');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 }); await ordinary(dataRoot, true);
  const app = path.join(dataRoot, 'app'), lockPath = path.join(dataRoot, 'install.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('Another setup owns this folder. If it stopped unexpectedly, keep install.lock and inspect it before trying again.'); throw error; }
  const token = randomBytes(24).toString('hex'); let workspace, backup = null, keepRecovery = false;
  try {
    await lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, token, startedAt: new Date().toISOString(), repo })); await lock.sync();
    const previous = await installedInfo(app, repair ? repo : undefined);
    if (previous && !repair) {
      if (await exists(path.join(app, '.aiplay-update-npm-pending'))) fail('Studio has an unfinished dependency update. Close its launcher, then run open -a "AIPLAY Studio" --args --repair.');
      await ordinary(path.join(app, 'launcher', 'launcher.mjs'), false);
      say('Studio is installed.'); return { ok: true, changed: false, app, repo: previous.repo, commit: previous.commit, backup: null };
    }
    if (repair && (await runtimeCheck()).busy) fail('Close the Studio launcher and Studio before repairing this app.');
    say('Checking the Studio source…');
    const response = await fetchFn(`https://api.github.com/repos/${repo}/commits/${ref}`, { headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) fail(`GitHub could not resolve this build (${response.status}). Check your connection and restart setup.`);
    const text = await boundedText(response);
    let source; try { source = JSON.parse(text); } catch { fail('GitHub returned invalid build metadata.'); }
    const sha = source?.sha, date = source?.commit?.committer?.date;
    if (!SHA.test(sha || '') || ref !== 'main' && sha !== ref || typeof date !== 'string' || !Number.isFinite(Date.parse(date))) fail('GitHub did not verify the requested source commit.');
    if (previous && previous.commit !== sha) {
      say('Checking that this build contains the installed app…');
      const comparison = await fetchFn(`https://api.github.com/repos/${repo}/compare/${previous.commit}...${sha}`, { headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      let relation; try { if (comparison.ok) relation = JSON.parse(await boundedText(comparison)); } catch { /* unknown ancestry never authorizes replacement */ }
      if (relation?.status !== 'ahead' || !Number.isSafeInteger(relation.ahead_by) || relation.ahead_by < 1 || relation.behind_by !== 0) fail('This source is older, diverged or could not be verified as a forward update. Your app is preserved.');
    }
    workspace = await mkdtemp(path.join(dataRoot, '.setup-')); await chmod(workspace, 0o700);
    const archive = path.join(workspace, 'source.tar.gz'), unpacked = path.join(workspace, 'source'), stage = path.join(workspace, 'app');
    await mkdir(unpacked, { mode: 0o700 }); await mkdir(stage, { mode: 0o700 });
    say(`Downloading Studio ${sha.slice(0, 7)}…`);
    const downloaded = await download(fetchFn, `https://codeload.github.com/${repo}/tar.gz/${sha}`, archive, expectedArchiveSha256, say);
    say('Checking and unpacking the source…');
    const sourceRoot = await extractSource(archive, unpacked);
    if (path.basename(sourceRoot) !== `${repo.split('/')[1]}-${sha}`) fail('The source archive does not identify the requested commit.');
    let raw; try { raw = await json(path.join(sourceRoot, 'install.json')); } catch { fail('The source install manifest is missing or invalid.'); }
    const manifest = macosManifest(raw);
    await copyPayload(sourceRoot, stage, manifest);
    if (previous) for (const rel of manifest.preserve) {
      const from = path.join(app, ...rel.split('/'));
      if (!await exists(from)) continue;
      await ordinaryPath(app, rel);
      const info = await lstat(from);
      if (info.isDirectory()) await ordinaryTree(from); else await ordinary(from, false);
      await cp(from, path.join(stage, ...rel.split('/')), { recursive: info.isDirectory(), force: true });
    }
    await writeFile(path.join(stage, 'install-info.json'), JSON.stringify({ repo, commit: sha, date, installedAt: new Date().toISOString(),
      macosBootstrap: { version: 1, archiveCommit: sha, archiveSha256: downloaded.sha256, archiveBytes: downloaded.bytes } }, null, 2) + '\n', { mode: 0o600 });
    await writeFile(path.join(stage, 'server', 'version.gen.json'), JSON.stringify({ commit: sha, date, modified: false, source: 'macos-setup' }) + '\n', { mode: 0o600 });
    // Required paths are checked before executing either npm or the shipped validator.
    for (const rel of manifest.required) await ordinary(path.join(stage, ...rel.split('/')), false);
    await ordinary(npmCli, false);
    const env = { ...process.env, PATH: path.dirname(nodePath) + path.delimiter + (process.env.PATH || ''),
      npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
    say('Installing Studio packages…');
    await command(nodePath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, env });
    say('Validating the installed runtime…');
    let checked;
    try { checked = JSON.parse(await command(nodePath, ['--experimental-vm-modules', path.join(stage, 'scripts', 'verify-install.mjs'), '--root', stage, '--platform', 'darwin'], { cwd: stage, env, timeout: 120_000 })); }
    catch { fail('The app runtime failed validation. Your previous installation is preserved.'); }
    if (checked?.ok !== true) fail('The app runtime failed validation. Your previous installation is preserved.');
    if (repair && (await runtimeCheck()).busy) fail('Studio started during setup. Close it before repairing this app.');
    await transactionHook('before-swap', { app, stage });
    if (previous) { backup = path.join(dataRoot, `app.backup-${stamp()}`); await rename(app, backup); }
    try { await transactionHook('after-backup', { app, stage, backup }); await rename(stage, app); }
    catch (error) {
      if (backup) try { await rename(backup, app); backup = null; } catch { error.message = 'Setup could not finish rollback. Keep the app.backup folder and install.lock for recovery.'; keepRecovery = true; }
      throw error;
    }
    if (backup) {
      try { await rm(backup, { recursive: true }); backup = null; }
      catch { say('Studio is ready. The previous app backup could not be removed; keep it for recovery.'); }
    }
    say('Studio is ready.'); return { ok: true, changed: true, app, repo, commit: sha, archiveSha256: downloaded.sha256, backup, validation: checked };
  } finally {
    await lock.close();
    let owned = false;
    try { owned = (await json(lockPath)).token === token; } catch { /* unknown ownership is preserved */ }
    if (owned && !keepRecovery) await rm(lockPath);
    if (workspace && inside(dataRoot, workspace) && !keepRecovery) await rm(workspace, { recursive: true, force: true });
  }
}

export async function startLauncher(app, { nodePath = process.execPath, noOpen = false, spawnFn = spawn, onOutput } = {}) {
  if (await exists(path.join(app, '.aiplay-update-npm-pending'))) fail('Studio has an unfinished dependency update. Run open -a "AIPLAY Studio" --args --repair before opening it.');
  await ordinary(path.join(app, 'launcher', 'launcher.mjs'), false);
  const child = spawnFn(nodePath, [path.join(app, 'launcher', 'launcher.mjs')], { cwd: app, stdio: onOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, PATH: path.dirname(nodePath) + path.delimiter + (process.env.PATH || ''), ...(noOpen ? { AIPLAY_LAUNCHER_NO_WINDOW: '1' } : {}) } });
  child.completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  if (onOutput) { child.stdout?.on('data', chunk => onOutput(String(chunk), false)); child.stderr?.on('data', chunk => onOutput(String(chunk), true)); }
  return child;
}

export async function statusPage(state, { openBrowser = true, spawnFn = spawn } = {}) {
  const secret = randomBytes(24).toString('hex'), html = await readFile(path.join(HERE, 'index.html'));
  let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = http.createServer((req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, `http://${host}`);
    if (!url.pathname.startsWith(`/${secret}/`)) { res.writeHead(404).end(); return; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method === 'POST' && url.pathname === `/${secret}/close`) {
      if (req.headers.origin !== `http://${host}` || state.state !== 'failed' || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) { res.writeHead(403).end(); return; }
      res.writeHead(204).end(); resolveClosed();
    } else if (req.method !== 'GET') res.writeHead(403).end();
    else if (url.pathname === `/${secret}/status`) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(state)); }
    else if (url.pathname === `/${secret}/`) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
    else res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/${secret}/`;
  if (openBrowser) openBrowserUrl(url, spawnFn);
  return { server, url, closed };
}

async function cli(args) {
  const options = parseOptions(args);
  if (options.help) { console.log('AIPLAY Studio macOS\n  --install-only  --repair  --no-open\n  --repo owner/name  --ref main|FULL_COMMIT_SHA'); return; }
  if (process.platform !== 'darwin') fail('This package is for macOS.');
  if (typeof process.getuid === 'function' && process.getuid() === 0) fail('Open AIPLAY Studio as your regular user, without sudo.');
  const dataRoot = defaultDataRoot();
  if (!options.repair && !await exists(path.join(dataRoot, 'app', '.aiplay-update-npm-pending')) && await reuseLauncher(options)) return;
  const state = { state: 'working', message: 'Preparing Studio…', log: [] };
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await ordinary(dataRoot, true);
  if (options.repair && !args.includes('--repo')) { const previous = await installedInfo(path.join(dataRoot, 'app')); if (previous) options.repo = previous.repo; }
  if (await exists(path.join(dataRoot, 'setup.log'))) await ordinary(path.join(dataRoot, 'setup.log'), false);
  const log = await open(path.join(dataRoot, 'setup.log'), 'a', 0o600);
  let logging = Promise.resolve();
  const say = line => { state.message = line; state.log.push(line); state.log = state.log.slice(-80); console.log(line); logging = logging.then(() => log.writeFile(`${new Date().toISOString()} ${line}\n`)).catch(() => {}); };
  const page = options.installOnly ? null : await statusPage(state, { openBrowser: !options.noOpen });
  if (page) console.log(`Setup: ${page.url}`);
  try {
    const result = await installStudio({ ...options, dataRoot, say });
    console.log(JSON.stringify({ ok: true, app: result.app, commit: result.commit, changed: result.changed, backup: result.backup }));
    if (!options.installOnly) {
      say('Opening the Studio launcher…');
      let output = '';
      const child = await startLauncher(result.app, { ...options, noOpen: true, onOutput(text, error) {
        (error ? process.stderr : process.stdout).write(text); output = (output + text).slice(-8192);
        const match = output.match(/launcher: (http:\/\/127\.0\.0\.1:([0-9]{1,5})\/)\r?\n/);
        if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) { state.launcherUrl = match[1]; state.state = 'ready'; state.message = 'Studio is ready.'; }
      } });
      const stop = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
      const exitCode = await child.completion;
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); process.exitCode = exitCode;
    } else state.state = 'ready';
  } catch (error) {
    state.state = 'failed'; say(error.message); process.exitCode = 1;
    if (page && !options.noOpen) await page.closed;
  } finally { if (page) await new Promise(resolve => page.server.close(resolve)); await logging; await log.sync(); await log.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
