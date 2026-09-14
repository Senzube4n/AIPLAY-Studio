/**
 * Repackage ONLY the reviewed upstream Windows CUDA13.3 archives; never execute them.
 * node scripts/package-yue-runtime.mjs --engine-zip <verified.zip> --cuda-zip <verified.zip> --out-dir <NEW directory>
 * No network, installation, overwrite, cleanup/delete, GPU probe or release upload.
 * Output: two release ZIPs and yue-runtime-manifest.json. Inputs must match the
 * pinned upstream whole-archive hashes; extracted payloads must match the allowlist.
 * ZIP output uses fixed times, lexical order and deflate level6. Identical inputs
 * and Node/zlib versions produce identical bytes. MSVC DLLs/weights are excluded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createInflateRaw } from 'node:zlib';

const PIN = 'cda0e3a4762d855e865980506f934ec0e6928691';
const RELEASE = 'https://github.com/Senzube4n/AIPLAY-Studio/releases/download/yue2-runtime-cda0e3a/';
const NOTICES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-notices');
const SOURCES = {
  engine: { id: 10314432667, bytes: 270038557,
    name: 'audio-v0.7.4-dev-cda0e-sheetsage2-bin-windows-x64-cuda13.3',
    sha256: '44b9d30e38180eb8f4608914498ba12017380bd8716a648b49e96dc017e2ea8d' },
  cuda: { id: 10314462699, bytes: 577007056,
    name: 'audio-v0.7.4-dev-cda0e-sheetsage2-cudart-windows-x64-cuda13.3',
    sha256: '7c6f63ba314d66689f8c7ab7eabbf8b12d46b06f74634033c4971b75de662d96' },
};
const ENGINE = {
  'audiocpp_cli.exe': 19958272,
  'ggml-base.dll': 640512, 'ggml.dll': 66560, 'ggml-cuda.dll': 257315328,
  'ggml-cpu-alderlake.dll': 919552, 'ggml-cpu-cannonlake.dll': 1023488,
  'ggml-cpu-cascadelake.dll': 1022464, 'ggml-cpu-haswell.dll': 921600,
  'ggml-cpu-icelake.dll': 1022464, 'ggml-cpu-sandybridge.dll': 862720,
  'ggml-cpu-skylakex.dll': 1023488, 'ggml-cpu-sse42.dll': 782336,
  'ggml-cpu-x64.dll': 783360, 'model_specs/yue2.json': 11420,
};
const CUDA = {
  'cublas64_13.dll': 51870320, 'cublasLt64_13.dll': 460301424,
  'cudart64_13.dll': 551024, 'cufft64_12.dll': 256092784,
};
const CLI_SHA = 'f9db9c396dd777d404bf27150f1f9b0428a17daa3fad68d41d4c42012cf17281';
const fail = (message) => { throw new Error(message); };
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = (data) => createHash('sha256').update(data).digest('hex');
const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function updateCrc(crc, data) {
  for (const value of data) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function safeName(name) {
  if (!name || name.length > 240 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/')
    || name.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail(`Unsafe archive name: ${name}`);
  return name;
}
function beneath(root, name) {
  safeName(name);
  const target = path.resolve(root, ...name.split('/'));
  if (!target.startsWith(path.resolve(root) + path.sep)) fail('Output escaped staging directory.');
  return target;
}
function readAt(fd, length, position) {
  const data = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, data, read, length - read, position + read);
    if (!n) fail('Unexpected EOF in pinned ZIP.');
    read += n;
  }
  return data;
}
async function hashFd(fd, bytes) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream('', { fd, autoClose: false, start: 0, end: bytes - 1 })) hash.update(chunk);
  return hash.digest('hex');
}

/** ZIP32 only: bounds, collisions, local headers, CRCs and regular file modes checked. */
function entries(fd, bytes) {
  const tail = readAt(fd, Math.min(bytes, 65557), Math.max(0, bytes - 65557));
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) fail('Missing ZIP end record.');
  const count = tail.readUInt16LE(end + 10), size = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count
    || count === 65535 || !count || count > 10000 || size > 8 * 1024 * 1024
    || offset + size > bytes - tail.length + end) fail('Unsupported/malformed ZIP layout.');
  const central = readAt(fd, size, offset), found = new Map(), folded = new Set();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > size || central.readUInt32LE(p) !== 0x02014b50) fail('Invalid ZIP central entry.');
    const flags = central.readUInt16LE(p + 8), method = central.readUInt16LE(p + 10);
    const crc = central.readUInt32LE(p + 16), compressed = central.readUInt32LE(p + 20), uncompressed = central.readUInt32LE(p + 24);
    const nameLength = central.readUInt16LE(p + 28), extra = central.readUInt16LE(p + 30), comment = central.readUInt16LE(p + 32);
    const mode = central.readUInt32LE(p + 38) >>> 16, localAt = central.readUInt32LE(p + 42);
    if (p + 46 + nameLength + extra + comment > size || central.readUInt16LE(p + 34)
      || flags & 1 || ![0, 8].includes(method) || [compressed, uncompressed, localAt].includes(0xffffffff)) fail('Unsupported ZIP entry.');
    const rawName = central.subarray(p + 46, p + 46 + nameLength);
    const name = safeName(rawName.toString('utf8'));
    if (!Buffer.from(name).equals(rawName) || folded.has(name.toLowerCase()) || ((mode & 0xf000) && (mode & 0xf000) !== 0x8000)) fail('ZIP collision, invalid encoding or non-regular file.');
    folded.add(name.toLowerCase());
    if (localAt + 30 > offset) fail('ZIP local header out of bounds.');
    const local = readAt(fd, 30, localAt);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method
      || local.readUInt16LE(26) !== nameLength || !readAt(fd, nameLength, localAt + 30).equals(rawName)) fail('ZIP header mismatch.');
    const start = localAt + 30 + nameLength + local.readUInt16LE(28);
    if (start + compressed > offset || uncompressed > 1024 * 1024 * 1024) fail('ZIP data out of bounds.');
    found.set(name, { name, method, crc, compressed, bytes: uncompressed, start });
    p += 46 + nameLength + extra + comment;
  }
  if (p !== size) fail('Unexpected ZIP central directory suffix.');
  return found;
}

async function unpack(input, source, allow, destination) {
  const inputStat = fs.lstatSync(input);
  if (!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.size !== source.bytes) fail(`Wrong ${source.name} input type/size.`);
  const fd = fs.openSync(input, 'r');
  try {
    if (await hashFd(fd, source.bytes) !== source.sha256) fail(`Wrong SHA256 for ${source.name}.`);
    const catalog = entries(fd, source.bytes), files = [];
    fs.mkdirSync(destination);
    for (const name of Object.keys(allow).sort(lexical)) {
      const entry = catalog.get(name);
      if (!entry || entry.bytes !== allow[name] || !entry.compressed) fail(`Missing/wrong-sized allowed file: ${name}`);
      const target = beneath(destination, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let bytes = 0, crc = 0xffffffff;
      const hash = createHash('sha256');
      const check = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > entry.bytes) return callback(new Error('ZIP entry exceeded its declared size.'));
        crc = updateCrc(crc, chunk); hash.update(chunk); callback(null, chunk);
      } });
      const sourceStream = fs.createReadStream('', { fd, autoClose: false, start: entry.start, end: entry.start + entry.compressed - 1 });
      const stages = [sourceStream, ...(entry.method === 8 ? [createInflateRaw()] : []), check, fs.createWriteStream(target, { flags: 'wx' })];
      await pipeline(stages);
      const sha256 = hash.digest('hex');
      if (bytes !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail(`ZIP CRC/size mismatch for ${name}.`);
      if (name === 'audiocpp_cli.exe' && sha256 !== CLI_SHA) fail('CLI differs from the hardware-tested executable.');
      files.push({ name, bytes, sha256 });
    }
    // Detect mutation of an input while it was being extracted, using the same handle.
    if (fs.fstatSync(fd).size !== source.bytes || await hashFd(fd, source.bytes) !== source.sha256) fail('Source ZIP changed during extraction.');
    return files;
  } finally { fs.closeSync(fd); }
}

function addText(stage, name, content) {
  const target = beneath(stage, name), data = Buffer.from(content);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data, { flag: 'wx' });
  return { name, bytes: data.length, sha256: digest(data) };
}

async function zip(stage, files, output) {
  const handle = await fs.promises.open(output, 'wx');
  let offset = 0;
  const central = [];
  const date = ((2026 - 1980) << 9) | (9 << 5) | 14;
  async function write(data) {
    let written = 0;
    while (written < data.length) {
      const r = await handle.write(data, written, data.length - written, null);
      if (!r.bytesWritten) fail('ZIP write made no progress.');
      written += r.bytesWritten; offset += r.bytesWritten;
    }
    if (offset >= 0xffffffff) fail('ZIP32 output limit exceeded.');
  }
  try {
    for (const file of [...files].sort((a, b) => lexical(a.name, b.name))) {
      const name = Buffer.from(file.name), start = offset, local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x808, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(date, 12); local.writeUInt16LE(name.length, 26);
      await write(local); await write(name);
      const dataStart = offset;
      let crc = 0xffffffff, bytes = 0;
      const hash = createHash('sha256');
      const check = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length; crc = updateCrc(crc, chunk); hash.update(chunk); callback(null, chunk);
      } });
      const sink = new Writable({ write(chunk, _encoding, callback) { write(chunk).then(() => callback(), callback); } });
      await pipeline(fs.createReadStream(beneath(stage, file.name)), check, createDeflateRaw({ level: 6 }), sink);
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) fail('Staged file changed while packaging.');
      const compressed = offset - dataStart;
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(bytes, 12); await write(descriptor);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(0x314, 4); header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x808, 8); header.writeUInt16LE(8, 10); header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16); header.writeUInt32LE(compressed, 20); header.writeUInt32LE(bytes, 24);
      header.writeUInt16LE(name.length, 28); header.writeUInt32LE((0o100644 << 16) >>> 0, 38); header.writeUInt32LE(start, 42);
      central.push(header, name);
    }
    const start = offset;
    for (const part of central) await write(part);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); await write(end);
    await handle.sync();
  } finally { await handle.close(); }
  const fd = fs.openSync(output, 'r');
  try { return { bytes: fs.fstatSync(fd).size, sha256: await hashFd(fd, fs.fstatSync(fd).size) }; }
  finally { fs.closeSync(fd); }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('node scripts/package-yue-runtime.mjs --engine-zip <pinned ZIP> --cuda-zip <pinned ZIP> --out-dir <NEW directory>'); return;
  }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--engine-zip', '--cuda-zip', '--out-dir'].includes(argv[i]) || !argv[i + 1] || args[argv[i]]) fail('Missing, duplicate or unknown option.');
    args[argv[i]] = path.resolve(argv[i + 1]);
  }
  if (Object.keys(args).length !== 3) fail('Supply --engine-zip, --cuda-zip and --out-dir.');
  const out = args['--out-dir'];
  if (out === path.parse(out).root || out === process.cwd() || fs.existsSync(out)) fail('Output must be a new, specific directory; nothing is overwritten.');
  const noticeIndex = JSON.parse(fs.readFileSync(path.join(NOTICES, 'sources.json'), 'utf8'));
  if (noticeIndex.schema !== 1 || !Array.isArray(noticeIndex.files)) fail('Invalid notice source manifest.');
  const noticeData = noticeIndex.files.map((record) => {
    safeName(record.name);
    // Git's Windows autocrlf must not change the reviewed UTF-8/LF notice bytes.
    const data = Buffer.from(fs.readFileSync(path.join(NOTICES, record.name), 'utf8').replaceAll('\r\n', '\n'));
    if (data.length !== record.bytes || digest(data) !== record.sha256) fail(`Notice differs from reviewed text: ${record.name}`);
    return { ...record, content: data.toString('utf8') };
  });
  fs.mkdirSync(out);
  const manifest = {
    schema: 1, id: 'yue2-runtime-cda0e3a', platform: 'win32', arch: 'x64',
    source: { repository: 'https://github.com/0xShug0/audio.cpp', revision: PIN,
      version: '0.7.4-dev-cda0e-sheetsage2', workflowRun: 'https://github.com/0xShug0/audio.cpp/actions/runs/34744307903',
      archives: Object.values(SOURCES).map((s) => ({ ...s, url: `https://api.github.com/repos/0xShug0/audio.cpp/actions/artifacts/${s.id}/zip` })) },
    repackaging: { binaryChanges: false, excluded: ['MSVC runtime DLLs', 'server and model-manager executables', 'tools', 'other model specs', 'all model weights'],
      fixedZipTimestamp: '2026-09-14T00:00:00Z', compression: 'deflate level6', node: process.versions.node, zlib: process.versions.zlib },
    prerequisites: { gpu: 'NVIDIA CUDA-compatible GPU and suitable NVIDIA driver; no lower-VRAM fit guarantee',
      visualCpp: { required: true, included: false, arch: 'x64',
        url: 'https://aka.ms/vc14/vc_redist.x64.exe',
        documentation: 'https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist',
        note: 'Install Microsoft Visual C++ v14 Redistributable at least as new as the MSVC build tools; obtain and install directly from Microsoft.' } },
    noticeSources: noticeIndex.files, archives: [],
  };
  for (const kind of ['engine', 'cuda']) {
    const stage = path.join(out, `stage-${kind}`), source = SOURCES[kind];
    console.log(JSON.stringify({ step: 'verify-and-extract', component: kind }));
    const files = await unpack(args[kind === 'engine' ? '--engine-zip' : '--cuda-zip'], source, kind === 'engine' ? ENGINE : CUDA, stage);
    for (const notice of noticeData.filter((n) => n.component === kind)) {
      files.push(addText(stage, `licenses/${kind}/${notice.name}`, notice.content));
    }
    const introName = kind === 'engine' ? 'RUNTIME-NOTICE.txt' : 'CUDA-NOTICE.txt';
    files.push(addText(stage, introName, kind === 'engine'
      ? `AIPlay optional YuE2 runtime component (not an official upstream release).\nUnmodified audio.cpp CLI and GGML binaries from ${PIN}.\nCopyright 2026 ShugoAI LLC; audio.cpp Apache-2.0; third-party terms are preserved under licenses/engine/.\nNo model weights, server, tools, or Microsoft runtime DLLs are included.\nInstall Microsoft Visual C++ v14 x64 Redistributable directly from https://aka.ms/vc14/vc_redist.x64.exe before use.\nThe separate CUDA component is required; its NVIDIA licence is not Apache-2.0.\nThis package is not a minimum-VRAM certification or an output-rights determination.\n`
      : `AIPlay optional CUDA13.3 runtime component for the pinned YuE2 renderer.\nThese four unmodified NVIDIA DLLs are not open-source/Apache-licensed software.\nRead licenses/cuda/NVIDIA-CUDA-EULA.txt before installing or using them.\nThey are provided only as a component used privately by the AIPlay application, not a standalone SDK.\nNo NVIDIA driver, development tools, Microsoft DLLs or model weights are included.\nSource build: audio.cpp ${PIN}; CUDA13.3.0 Windows build.\n`));
    files.push(addText(stage, `licenses/${kind}/SOURCES.json`, JSON.stringify({
      schema: 1, source: manifest.source, notices: noticeIndex.files.filter((n) => n.component === kind),
    }, null, 2) + '\n'));
    files.sort((a, b) => lexical(a.name, b.name));
    const name = kind === 'engine' ? 'aiplay-yue2-runtime-cda0e3a-windows-x64.zip' : 'aiplay-yue2-cuda13.3-cda0e3a-windows-x64.zip';
    console.log(JSON.stringify({ step: 'package', component: kind, files: files.length }));
    const info = await zip(stage, files, path.join(out, name));
    manifest.archives.push({ name, url: RELEASE + name, ...info, files });
  }
  manifest.totalDownloadBytes = manifest.archives.reduce((n, a) => n + a.bytes, 0);
  fs.writeFileSync(path.join(out, 'yue-runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), manifest.archives.map((a) => `${a.sha256}  ${a.name}\n`).join(''), { flag: 'wx' });
  console.log(JSON.stringify({ step: 'complete', out, archives: manifest.archives.map(({ files, ...a }) => a) }));
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
