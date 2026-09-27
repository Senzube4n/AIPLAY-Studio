import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAvatarImport } from '../../web/avatar-import.js';

function form(file, profile = 'world') {
  const fields = {
    file: { files: file ? [file] : [] }, profile: { value: profile },
    name: { value: 'Mika' }, persona_id: { value: '17' }, facing: { value: '+Z' },
    skeleton_family: { value: 'mika-v1' }, source: { value: 'Original source' },
    license: { value: 'Original license' },
  };
  return { elements: fields };
}

test('Workshop imports the submitted bytes with the same submitted attribution', async () => {
  const original = { size: 1024, name: 'first.glb' };
  const changed = { size: 2048, name: 'second.glb' };
  const submitted = form(original);
  let release;
  const encoding = new Promise(resolve => { release = resolve; });
  const encoded = [];
  const request = prepareAvatarImport(submitted, file => { encoded.push(file); return encoding; });
  assert.deepEqual(encoded, [original], 'encoding starts from the submitted file');
  submitted.elements.file.files[0] = changed;
  submitted.elements.profile.value = 'vrm';
  for (const key of ['name', 'persona_id', 'facing', 'skeleton_family', 'source', 'license']) {
    submitted.elements[key].value = `Changed ${key}`;
  }
  release('original-bytes');
  assert.deepEqual(await request, {
    action: 'import', profile: 'world', data_base64: 'original-bytes',
    name: 'Mika', persona_id: '17', facing: '+Z', skeleton_family: 'mika-v1',
    source: 'Original source', license: 'Original license',
  });
});

test('Workshop keeps the selected profile size limit before reading the file', async () => {
  for (const [profile, size, valid] of [
    ['world', 8 * 1024 * 1024, true],
    ['world', 8 * 1024 * 1024 + 1, false],
    ['vrm', 64 * 1024 * 1024, true],
    ['vrm', 64 * 1024 * 1024 + 1, false],
  ]) {
    let reads = 0;
    const request = prepareAvatarImport(form({ size }, profile), async () => { reads++; return 'bytes'; });
    if (valid) assert.equal((await request).data_base64, 'bytes');
    else await assert.rejects(request, new RegExp(profile === 'vrm' ? '64 MiB' : '8 MiB'));
    assert.equal(reads, Number(valid));
  }
  await assert.rejects(prepareAvatarImport(form(null), async () => 'bytes'), /Choose an avatar/);
});
