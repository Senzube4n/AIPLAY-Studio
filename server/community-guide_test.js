/** Published guide bytes and the installed offline route. No server or engine boot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { selectInstallManifest } from '../scripts/install-manifest.mjs';
import { installPathAllowed } from '../scripts/verify-install.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUIDE = path.join(ROOT, 'web', 'community-guide');
// The 25 October public package was reviewed and delivered before repository
// integration. Keep this dated edition byte-identical, including the ZIP.
const PUBLISHED = {
  "index.html": {
    "bytes": 865555,
    "sha256": "8780f55e9695df9eff5a96a576dfdd66135ceb05a5143eb8b73d77c2a694ddfb"
  },
  "guide.pdf": {
    "bytes": 789329,
    "sha256": "a1f3adeba701f45f496aa5e07d562ab520e13ccdb67cd1d6be0f2b9303facd26"
  },
  "directors.md": {
    "bytes": 12892,
    "sha256": "ff34e8a5b83714e364f1d296a10bd5865a533cb70e130851cdee559da4dbeccb"
  },
  "discord-posts.html": {
    "bytes": 18595,
    "sha256": "e5f14230d177ff3f6f1f395054979e16e9a940abb340d3280dd1aaa185d49679"
  },
  "screenshots/01-home.jpg": {
    "bytes": 55311,
    "sha256": "3ff5fde80d3956b846d1a91dcd19c9bc6df10df01592a24b9d37cff431e474f7"
  },
  "screenshots/03-music-simple.jpg": {
    "bytes": 114205,
    "sha256": "96458bf6bef0cb73bee33c26a5c7d13179fa49582bdd84c20e8eecc7313ea819"
  },
  "screenshots/04-music-advanced.jpg": {
    "bytes": 126607,
    "sha256": "9db81f8bb1357b7fd07b0f7185dbe2e536f147a799ad514bdaacd3eaaeb1e91f"
  },
  "screenshots/05-pictures.jpg": {
    "bytes": 114147,
    "sha256": "58834ae42824c7cb5c1e653539c866c329de31329ad4ceb53ce10bbdd7e91a7d"
  },
  "screenshots/12-h3-settings.jpg": {
    "bytes": 43594,
    "sha256": "a7e1ef6f08bf0c8fb6011bcb6f6a5080e72767b87678044a6c2c206d7b3578d8"
  },
  "screenshots/13-moss-presets.jpg": {
    "bytes": 75018,
    "sha256": "200a0ca5ee64dfb4a33bfd039bd43c5b2cc358df3a69354bcbf6a661433abc5c"
  },
  "screenshots/14-moss-nsfw.jpg": {
    "bytes": 74726,
    "sha256": "6734ada1f4249caa617ec04121a703175e3202cad5551766026a1368208d4c1f"
  },
  "community-guide-2026-10-25.zip": {
    "bytes": 1468614,
    "sha256": "df4ffd6ab6183aabc7b4fe61ccfa9646d4fb5c07a6bbd65b4d84a3c5e17ffa6e"
  }
};
const digest = data => createHash('sha256').update(data).digest('hex');
const read = name => readFile(path.join(ROOT, name), 'utf8');
async function files(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) found.push(...await files(path.join(dir, entry.name), relative + '/'));
    else {
      assert.ok(entry.isFile(), `Not a regular guide file: ${relative}`);
      found.push(relative);
    }
  }
  return found.sort();
}

test('the bundled guide is exactly the reviewed public edition and download ZIP', async () => {
  assert.deepEqual(await files(GUIDE), Object.keys(PUBLISHED).sort());
  for (const [name, expected] of Object.entries(PUBLISHED)) {
    const data = await readFile(path.join(GUIDE, name));
    assert.equal(data.length, expected.bytes, `${name} size changed`);
    assert.equal(digest(data), expected.sha256, `${name} differs from the delivered edition`);
  }
  assert.equal((await readFile(path.join(GUIDE, 'guide.pdf'))).subarray(0, 5).toString(), '%PDF-');
});

test('both offline HTML pages have closed local links and valid chapter anchors', async () => {
  const base = new URL('https://studio.invalid/community-guide/');
  const htmlFiles = ['index.html', 'discord-posts.html'];
  const pages = new Map(await Promise.all(htmlFiles.map(async name => [name, await readFile(path.join(GUIDE, name), 'utf8')])));
  const embedded = [];
  for (const [name, html] of pages) {
    for (const match of html.matchAll(/<(?:a|img|link|script)\b[^>]*\b(href|src)\s*=\s*(["'])(.*?)\2/gi)) {
      const [, attribute, , raw] = match;
      const value = raw.replace(/&amp;/g, '&');
      if (value.startsWith('data:')) {
        assert.equal(attribute.toLowerCase(), 'src');
        assert.match(value, /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, `${name} has an unsupported inline asset`);
        embedded.push(digest(Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')));
        continue;
      }
      const url = new URL(value, new URL(name, base));
      if (url.origin !== base.origin) {
        assert.equal(url.protocol, 'https:', `${name} has an unsafe external link`);
        continue;
      }
      assert.ok(url.pathname.startsWith(base.pathname), `${name} links outside the offline pack`);
      const target = decodeURIComponent(url.pathname.slice(base.pathname.length));
      assert.ok(Object.hasOwn(PUBLISHED, target), `${name} has missing local target ${target}`);
      if (url.hash) {
        assert.ok(pages.has(target), `Fragment target is not an HTML page: ${target}`);
        const ids = [...pages.get(target).matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)].map(m => m[2]);
        assert.ok(ids.includes(decodeURIComponent(url.hash.slice(1))), `Missing chapter anchor in ${target}: ${url.hash}`);
      }
    }
  }
  const screenshots = Object.entries(PUBLISHED).filter(([name]) => name.endsWith('.jpg')).map(([, pin]) => pin.sha256).sort();
  assert.deepEqual(embedded.sort(), screenshots, 'Editable HTML must embed all seven reviewed screenshots');
  assert.doesNotMatch(pages.get('index.html'), /<script\b/i, 'The guide needs no script or provider connection');
});

test('Windows, Linux and macOS payloads retain all offline guide files', async () => {
  const manifest = JSON.parse(await read('install.json'));
  const required = ['index.html', 'guide.pdf', 'directors.md', 'discord-posts.html', 'community-guide-2026-10-25.zip'];
  for (const platform of ['win32', 'linux', 'darwin']) {
    const selected = selectInstallManifest(manifest, platform);
    for (const name of Object.keys(PUBLISHED)) {
      assert.equal(installPathAllowed(`web/community-guide/${name}`, selected), true, `${platform} would filter ${name}`);
    }
    for (const name of required) assert.ok(selected.required.includes(`web/community-guide/${name}`), `${platform} does not require ${name}`);
    assert.equal(installPathAllowed('web/unrelated.md', selected), false, 'Shipping directors.md must not remove the general Markdown filter');
  }
});

test('the actual static handler serves readable HTML/PDF/template bytes without booting Studio', async () => {
  const index = await read('server/index.js');
  const mimeSource = /const MIME = \{[\s\S]*?\n\};/.exec(index)?.[0];
  const marker = index.lastIndexOf('// ---- static');
  const end = index.indexOf('\n  } catch (err)', marker);
  assert.ok(mimeSource && marker >= 0 && end > marker, 'Static route fixture boundary changed');
  const MIME = new Function(`${mimeSource}\nreturn MIME;`)();
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const route = new AsyncFunction('p', 'path', 'WEB', 'readFile', 'MIME', 'json', 'res', index.slice(marker, end));
  for (const [name, type] of [['index.html', 'text/html; charset=utf-8'], ['guide.pdf', 'application/pdf'], ['directors.md', 'text/plain; charset=utf-8']]) {
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(data) { this.data = data; } };
    await route(`/community-guide/${name}`, path, path.join(ROOT, 'web'), readFile, MIME, () => assert.fail('Unexpected JSON response'), response);
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], type);
    assert.equal(digest(response.data), PUBLISHED[name].sha256, `${name} served different bytes`);
  }
  let rejected = null;
  await route('/community-guide/../install.json', path, path.join(ROOT, 'web'), () => assert.fail('Traversal reached disk'), MIME, (_res, status) => { rejected = status; }, {});
  assert.equal(rejected, 400);
});

test('Home and About both lead to the installed guide', async () => {
  const html = await read('web/index.html');
  const links = [...html.matchAll(/<a\b[^>]*href=["']\/community-guide\/index\.html["'][^>]*>([\s\S]*?)<\/a>/gi)];
  assert.equal(links.length, 2, 'Keep an offline guide link in both Home and About');
  for (const [, label] of links) assert.match(label.replace(/<[^>]*>/g, ''), /\S/, 'Guide link needs an accessible label');
});
