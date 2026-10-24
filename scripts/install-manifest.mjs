/** Pure payload selection, shared by setup, offline validation and updates. */
function relativePath(value) {
  return typeof value === 'string' && !!value && !value.startsWith('/')
    && !/[\\:*?"<>|\x00-\x1f]/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function validManifest(manifest) {
  return manifest && !Array.isArray(manifest)
    && Array.isArray(manifest.include) && manifest.include.length > 0
    && manifest.include.every(entry => relativePath(entry) && !entry.includes('/'))
    && ['required', 'preserve'].every(key => manifest[key] === undefined || (Array.isArray(manifest[key]) && manifest[key].every(relativePath)))
    && ['exclude', 'keep'].every(key => manifest[key] === undefined || (Array.isArray(manifest[key])
      && manifest[key].every(pattern => typeof pattern === 'string' && !!pattern && !/[\x00-\x1f]/.test(pattern))));
}

/** Original fields remain Windows-compatible for released Setup versions.
 * Explicit Unix overlays omit top-level files, never arbitrary glob paths.
 * Older platform-neutral fixtures retain their common payload. */
export function selectInstallManifest(manifest, platform = process.platform) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw Error(`Unsupported installation platform: ${platform}`);
  if (!validManifest(manifest)) throw Error('The installation manifest needs valid include, required, preserve, exclude and keep arrays.');
  const platforms = manifest.platforms;
  if (platforms !== undefined) {
    if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) throw Error('The installation platform list is invalid.');
    for (const [name, overlay] of Object.entries(platforms)) {
      if (!['linux', 'darwin'].includes(name) || !overlay || typeof overlay !== 'object' || Array.isArray(overlay)
        || Object.keys(overlay).some(key => key !== 'omit') || !Array.isArray(overlay.omit)
        || overlay.omit.some(entry => !relativePath(entry) || entry.includes('/'))) {
        throw Error('The installation platform omission list is invalid.');
      }
    }
    if (platform !== 'win32' && !Object.hasOwn(platforms, platform)) throw Error(`This build does not provide an installation payload for ${platform}.`);
  }
  const omit = new Set(platforms?.[platform]?.omit || []);
  const omitted = file => omit.has(file.split('/')[0]);
  return {
    ...manifest,
    include: manifest.include.filter(entry => !omitted(entry)),
    ...(manifest.required !== undefined ? { required: manifest.required.filter(entry => !omitted(entry)) } : {}),
  };
}
