/** Offline runtime validation. Parses modules without linking or evaluating them. */
import path from 'node:path';
import vm from 'node:vm';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectInstallManifest } from './install-manifest.mjs';
export { selectInstallManifest };

const DEFAULT_ENTRIES = ['server/index.js', 'launcher/launcher.mjs'];
const MAX_MODULE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_MODULES = 4096;

function relativePath(value) {
  return typeof value === 'string' && !!value && !path.isAbsolute(value)
    && !/[\\:*?"<>|\x00-\x1f]/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function matches(value, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i').test(value);
}
export function installPathAllowed(file, manifest) {
  if (!relativePath(file) || !manifest.include.some(entry => file === entry || file.startsWith(entry + '/'))) return false;
  const basename = path.posix.basename(file);
  const match = pattern => matches(pattern.includes('/') ? file : basename, pattern);
  return (manifest.keep || []).some(match) || !(manifest.exclude || []).some(match);
}

/** Local static startup imports only. Bare npm packages and dynamic imports are
 * deliberately out of scope. An optional required array adds non-JS entry files.
 * Older manifests without required are valid; worker is required only if shipped. */
export async function verifyInstall({ root, manifest, platform = process.platform } = {}) {
  const result = { ok: false, root: path.resolve(root || '.'), platform, entries: [], modulesChecked: 0, filesChecked: 0, errors: [] };
  function error(file, message, dependency) {
    if (result.errors.length < 100) result.errors.push({ file, ...(dependency ? { dependency } : {}), message });
  }
  if (typeof vm.SourceTextModule !== 'function') {
    error('scripts/verify-install.mjs', 'Run this checker with node --experimental-vm-modules.');
    return { ...result, unsupportedParser: true };
  }
  let base;
  try {
    base = await realpath(result.root);
    if (!(await stat(base)).isDirectory()) throw Error('not a directory');
  } catch {
    error('.', 'The installation root is missing or is not a directory.');
    return result;
  }
  if (manifest === undefined) {
    try { manifest = JSON.parse(await readFile(path.join(base, 'install.json'), 'utf8')); }
    catch {
      error('install.json', 'The installation manifest is missing or invalid.');
      return result;
    }
  }
  try { manifest = selectInstallManifest(manifest, platform); }
  catch (failure) {
    error('install.json', failure.message);
    return result;
  }
  result.entries = [...DEFAULT_ENTRIES, ...(manifest.include.includes('worker') ? ['worker/runpod-worker.js'] : [])];
  const required = [...new Set([...result.entries, ...(manifest.required || [])])];
  const seen = new Set(), checked = new Set(), located = new Map(), queue = [];
  let totalBytes = 0;
  async function locate(file, owner = file, dependency) {
    if (!installPathAllowed(file, manifest)) {
      error(owner, `Runtime file is excluded from the installation payload: ${file}`, dependency);
      return null;
    }
    if (located.has(file)) return located.get(file);
    let actual;
    try {
      actual = await realpath(path.join(base, file));
      if (!inside(base, actual) || !(await stat(actual)).isFile()) throw Error('outside or not a file');
    } catch {
      error(owner, `Missing or inaccessible runtime file: ${file}`, dependency);
      return null;
    }
    if (!checked.has(actual)) { checked.add(actual); result.filesChecked++; }
    located.set(file, actual);
    return actual;
  }
  for (const file of required) {
    const actual = await locate(file);
    if (actual && /\.(?:m?js)$/i.test(actual)) queue.push(actual);
  }
  const context = vm.createContext(Object.create(null));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const relative = path.relative(base, file).split(path.sep).join('/');
    if (seen.size > MAX_MODULES) { error(relative, 'The startup module graph exceeds the validation limit.'); break; }
    let text;
    try {
      const size = (await stat(file)).size;
      totalBytes += size;
      if (size > MAX_MODULE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw Error('size');
      text = await readFile(file, 'utf8');
    } catch {
      error(relative, 'The runtime module cannot be read within the validation limits.');
      continue;
    }
    let module;
    try { module = new vm.SourceTextModule(text, { identifier: pathToFileURL(file).href, context }); }
    catch {
      error(relative, 'The runtime JavaScript module has invalid syntax.');
      continue;
    }
    result.modulesChecked++;
    for (const dependency of module.dependencySpecifiers) {
      if (!dependency.startsWith('./') && !dependency.startsWith('../')) continue;
      let target;
      try {
        const url = new URL(dependency, pathToFileURL(file));
        url.search = ''; url.hash = '';
        const full = fileURLToPath(url);
        if (!inside(base, full)) throw Error('outside');
        target = path.relative(base, full).split(path.sep).join('/');
      } catch {
        error(relative, 'A relative module import escapes the installation root or is invalid.', dependency);
        continue;
      }
      const actual = await locate(target, relative, dependency);
      if (actual && /\.(?:m?js)$/i.test(actual)) queue.push(actual);
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

async function cli(args) {
  if (![2, 4].includes(args.length) || args[0] !== '--root' || !path.isAbsolute(args[1])
    || (args.length === 4 && (args[2] !== '--platform' || !['win32', 'linux', 'darwin'].includes(args[3])))) {
    console.log(JSON.stringify({ ok: false, errors: [{ file: '.', message: 'Use node --experimental-vm-modules scripts/verify-install.mjs --root ABSOLUTE_APP_FOLDER [--platform win32|linux|darwin].' }] }));
    return 2;
  }
  const result = await verifyInstall({ root: args[1], ...(args.length === 4 ? { platform: args[3] } : {}) });
  console.log(JSON.stringify(result));
  return result.ok ? 0 : result.unsupportedParser ? 2 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await cli(process.argv.slice(2));
