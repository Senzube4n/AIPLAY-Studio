import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';

export const MAX_VECTOR_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_VECTOR_SOURCE_BYTES / 3) * 4;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class VectorImportError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'VectorImportError'; this.status = status; }
}
const invalid = (message) => { throw new VectorImportError(message); };

function headerType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  invalid('Source must have a PNG, JPEG or WebP image header.');
}

function sourceStem(hint) {
  // Treat the hint as a label, including when supplied by an agent on another OS.
  const basename = path.win32.basename(path.basename(hint || 'image'));
  return basename.replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'image';
}

function dataBytes(value) {
  if (typeof value !== 'string' || !value) invalid('data_url must be a PNG, JPEG or WebP base64 data URL.');
  if (value.length > MAX_BASE64_LENGTH + 32) invalid('Image source exceeds 128 MB.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) invalid('data_url must contain valid base64 image data.');
  const encoded = match[2];
  if (encoded.length > MAX_BASE64_LENGTH) invalid('Image source exceeds 128 MB.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_VECTOR_SOURCE_BYTES) invalid('Image source exceeds 128 MB.');
  if (bytes.toString('base64') !== encoded) invalid('data_url must contain valid base64 image data.');
  const extension = headerType(bytes), expected = match[1] === 'jpeg' ? 'jpg' : match[1];
  if (extension !== expected) invalid('Image header does not match the data URL type.');
  return { bytes, extension };
}

async function localBytes(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) {
    invalid('path must name an existing absolute local image file.');
  }
  if (/^[\\/]{2}/.test(value)) invalid('Choose an image on this computer, not a network or device path.');
  const ext = path.extname(value).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) invalid('Local source must be a PNG, JPEG or WebP file.');
  let handle;
  try {
    handle = await open(await realpath(value), 'r');
  } catch { invalid('Local image file could not be opened.'); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) invalid('Local image source must be a regular file.');
    if (!info.size) invalid('Local image file is empty.');
    if (info.size > MAX_VECTOR_SOURCE_BYTES) invalid('Image source exceeds 128 MB.');
    const chunks = [];
    let total = 0;
    // A handle ties the read to one opened file; the running bound also covers a
    // source growing after stat, rather than trusting its earlier size alone.
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_VECTOR_SOURCE_BYTES - total + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_VECTOR_SOURCE_BYTES) invalid('Image source exceeds 128 MB.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total), extension = headerType(bytes);
    if (extension !== (ext === 'jpeg' ? 'jpg' : ext)) invalid('Image header does not match the local file extension.');
    return { bytes, extension };
  } finally { await handle.close(); }
}

/** Copy an explicitly supplied raster into Pictures, then register the new asset. */
export async function importVectorSource({ imageDir, register = async () => {} }, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) invalid('Image import requires an object.');
  const allowed = new Set(['path', 'data_url', 'name']);
  if (Object.keys(request).some((key) => !allowed.has(key))) invalid('Unsupported image import option.');
  const hasPath = Object.hasOwn(request, 'path'), hasData = Object.hasOwn(request, 'data_url');
  if (hasPath === hasData) invalid('Supply exactly one path or data_url.');
  if (request.name !== undefined && (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 240)) {
    invalid('name must be a short image filename hint.');
  }
  const { bytes, extension } = hasPath ? await localBytes(request.path) : dataBytes(request.data_url);
  const stem = sourceStem(request.name || (hasPath ? request.path : 'image'));
  const name = `${stem}_import_${randomUUID()}.${extension}`;
  const output = path.join(imageDir, name);
  let created = false, handle;
  try {
    await mkdir(imageDir, { recursive: true });
    handle = await open(output, 'wx'); created = true;
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const result = { ok: true, name, url: `/api/image/${encodeURIComponent(name)}`, bytes: bytes.length,
      source: hasPath ? 'local' : 'data_url' };
    await register(result);
    return result;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await unlink(output).catch(() => {});
    throw error;
  }
}
