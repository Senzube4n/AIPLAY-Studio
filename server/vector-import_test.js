import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, open, symlink } from 'node:fs/promises';
import { importVectorSource, MAX_VECTOR_SOURCE_BYTES } from './vector-import.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6R8AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 255, 217]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const url = (type, bytes) => `data:image/${type};base64,${bytes.toString('base64')}`;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aiplay-vector-import-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imageDir = path.join(dir, 'pictures');
  return { dir, imageDir };
}

test('local import copies a real raster with a unique safe name and registers only public receipt fields', async (t) => {
  const { dir, imageDir } = await fixture(t), input = path.join(dir, 'original.png');
  await writeFile(input, PNG);
  const registered = [];
  const result = await importVectorSource({ imageDir, register: async (receipt) => { registered.push(receipt); } },
    { path: input, name: '../../My badge.png' });
  assert.equal(result.ok, true); assert.equal(result.source, 'local'); assert.equal(result.bytes, PNG.length);
  assert.match(result.name, /^My_badge_import_[0-9a-f-]{36}\.png$/);
  assert.equal(result.url, `/api/image/${result.name}`);
  assert.deepEqual(await readFile(path.join(imageDir, result.name)), PNG);
  assert.deepEqual(await readFile(input), PNG, 'original is unchanged');
  assert.deepEqual(registered, [result]); assert.equal(JSON.stringify(registered).includes(input), false);
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'name', 'ok', 'source', 'url']);
});

test('PNG, JPEG and WebP data imports use the actual header extension and cap the label', async (t) => {
  const { imageDir } = await fixture(t);
  for (const [type, bytes, ext] of [['png', PNG, 'png'], ['jpeg', JPEG, 'jpg'], ['webp', WEBP, 'webp']]) {
    const result = await importVectorSource({ imageDir }, { data_url: url(type, bytes), name: `${'a'.repeat(100)}.wrong` });
    assert.equal(result.source, 'data_url'); assert.equal(result.bytes, bytes.length);
    assert.match(result.name, new RegExp(`^a{60}_import_[0-9a-f-]{36}\\.${ext}$`));
    assert.deepEqual(await readFile(path.join(imageDir, result.name)), bytes);
  }
});

test('parallel imports never overwrite a previous library file', async (t) => {
  const { imageDir } = await fixture(t);
  await mkdir(imageDir); await writeFile(path.join(imageDir, 'badge.png'), PNG);
  const receipts = await Promise.all(Array.from({ length: 12 }, () =>
    importVectorSource({ imageDir }, { data_url: url('png', PNG), name: 'badge.png' })));
  assert.equal(new Set(receipts.map((receipt) => receipt.name)).size, 12);
  assert.equal((await readdir(imageDir)).length, 13);
  assert.deepEqual(await readFile(path.join(imageDir, 'badge.png')), PNG);
});

test('a registration failure removes only the newly created output', async (t) => {
  const { dir, imageDir } = await fixture(t), input = path.join(dir, 'source.jpeg');
  await writeFile(input, JPEG); await mkdir(imageDir); await writeFile(path.join(imageDir, 'keep.png'), PNG);
  let seen;
  await assert.rejects(importVectorSource({ imageDir, register: async (result) => {
    seen = result; assert.deepEqual(await readFile(path.join(imageDir, result.name)), JPEG);
    throw new Error('Registration failed');
  } }, { path: input }), /Registration failed/);
  assert.ok(seen); assert.deepEqual(await readdir(imageDir), ['keep.png']);
  assert.deepEqual(await readFile(input), JPEG);
});

test('invalid request shapes and unsupported sources cannot create files', async (t) => {
  const { dir, imageDir } = await fixture(t);
  const requests = [null, [], 'image', {}, { path: '', data_url: '' }, { path: 'relative.png' },
    { path: 'https://example.com/image.png' }, { path: 'file:///tmp/image.png' }, { path: 1 },
    { path: path.join(dir, 'missing.png') }, { path: path.join(dir, 'script.svg') },
    { data_url: 1 }, { data_url: url('png', PNG), name: 2 }, { data_url: url('png', PNG), name: '' },
    { data_url: url('png', PNG), name: 'a'.repeat(241) }, { data_url: url('png', PNG), unknown: true }];
  for (const request of requests) await assert.rejects(importVectorSource({ imageDir }, request), { name: 'VectorImportError', status: 400 });
  await assert.rejects(readdir(imageDir), { code: 'ENOENT' });
});

test('Windows network and device paths are rejected before attempting to open their source', { skip: process.platform !== 'win32' }, async (t) => {
  const { imageDir } = await fixture(t);
  for (const input of [String.raw`\\server\share\image.png`, String.raw`\\?\C:\temp\image.png`,
    String.raw`\\.\C:\temp\image.png`, '//server/share/image.png']) {
    await assert.rejects(importVectorSource({ imageDir }, { path: input }), /not a network or device path/);
  }
  await assert.rejects(readdir(imageDir), { code: 'ENOENT' });
});

test('malformed base64, MIME mismatch, bad signatures and unsupported types are rejected', async (t) => {
  const { imageDir } = await fixture(t);
  const requests = ['data:image/png;base64,', 'data:image/png;base64,@@@@', 'data:image/png;base64,AAAAA',
    'data:image/png;base64,AB==', 'data:image/png;base64,YQ===', `${url('png', PNG)}\n`,
    'data:image/svg+xml;base64,AAAA', 'data:image/jpg;base64,AAAA', url('jpeg', PNG), url('png', JPEG),
    url('webp', PNG), url('png', Buffer.from('not a picture'))];
  for (const data_url of requests) await assert.rejects(importVectorSource({ imageDir }, { data_url }), { name: 'VectorImportError', status: 400 });
  await assert.rejects(readdir(imageDir), { code: 'ENOENT' });
});

test('local extension mismatch, empty sources and directories fail without copying', async (t) => {
  const { dir, imageDir } = await fixture(t);
  const wrong = path.join(dir, 'wrong.png'), empty = path.join(dir, 'empty.webp'), folder = path.join(dir, 'folder.png');
  await writeFile(wrong, JPEG); await writeFile(empty, Buffer.alloc(0)); await mkdir(folder);
  for (const input of [wrong, empty, folder]) await assert.rejects(importVectorSource({ imageDir }, { path: input }), { name: 'VectorImportError', status: 400 });
  assert.deepEqual(await readFile(wrong), JPEG);
  await assert.rejects(readdir(imageDir), { code: 'ENOENT' });
});

test('128 MB bounds reject oversized local files and encoded payloads before import', async (t) => {
  const { dir, imageDir } = await fixture(t), input = path.join(dir, 'huge.png');
  const handle = await open(input, 'w'); await handle.write(PNG); await handle.truncate(MAX_VECTOR_SOURCE_BYTES + 1); await handle.close();
  await assert.rejects(importVectorSource({ imageDir }, { path: input }), /128 MB/);
  const data_url = 'data:image/png;base64,' + 'AAAA'.repeat(Math.ceil(MAX_VECTOR_SOURCE_BYTES / 3) + 4);
  await assert.rejects(importVectorSource({ imageDir }, { data_url }), /128 MB/);
  await assert.rejects(readdir(imageDir), { code: 'ENOENT' });
});

test('local raster symlinks are resolved to their existing regular file', async (t) => {
  const { dir, imageDir } = await fixture(t), source = path.join(dir, 'original.png'), link = path.join(dir, 'link.png');
  await writeFile(source, PNG);
  try { await symlink(source, link, 'file'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks require permission on this Windows host.'); return; }
    throw error;
  }
  const result = await importVectorSource({ imageDir }, { path: link });
  assert.deepEqual(await readFile(path.join(imageDir, result.name)), PNG);
  assert.deepEqual(await readFile(source), PNG);
});
