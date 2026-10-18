import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createModelManager, MODEL_BUNDLES } from "./model-manager.js";

const waitFor = async (manager) => {
  for (let i = 0; i < 100 && manager.status().active; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return manager.status();
};

test('every production bundle has pinned source URLs, sizes and checksums', () => {
  for (const bundle of Object.values(MODEL_BUNDLES)) {
    assert.equal(bundle.totalBytes, bundle.files.reduce((n, f) => n + f.bytes, 0));
    for (const f of bundle.files) { assert.match(f.sha256, /^[a-f0-9]{64}$/); assert.match(f.url, /https:\/\/huggingface.co\/.+\/resolve\/[a-f0-9]{40}\//); }
  }
});

test('gated models require accepted terms and a read token, which never appears in status', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiplay-gated-')); t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from('model'), token = 'hf_testReadToken123456789'; let auth;
  const manager = await createModelManager({ modelsDir: root, bundles: { gated: { label: 'Gated', requiresToken: true, totalBytes: 5,
    files: [{ relative: 'checkpoints/gated.bin', bytes: 5, sha256: createHash('sha256').update(body).digest('hex'), url: 'https://huggingface.co/test' }] } },
    fetchFn: async (_, init) => { auth = init.headers.Authorization; return new Response(body); } });
  await assert.rejects(manager.install('gated', false, token), /accept/);
  await assert.rejects(manager.install('gated', true), /read token/);
  await manager.install('gated', true, token); const state = await waitFor(manager);
  assert.equal(auth, `Bearer ${token}`); assert.equal(JSON.stringify(state).includes(token), false);
});

test("curated model install removes a corrupt legacy partial and verifies the final file", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("verified model bytes");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const relative = "checkpoints/test.safetensors";
  const finalFile = path.join(root, relative);
  await mkdir(path.dirname(finalFile), { recursive: true });
  await writeFile(`${finalFile}.part`, "corrupt");
  const bundles = { test: { label: "Test", description: "Fixture", licenseUrl: "https://example.test/terms",
    totalBytes: body.length, files: [{ relative, bytes: body.length, sha256, url: "https://example.test/model" }] } };
  const calls = [];
  const manager = await createModelManager({ modelsDir: root, bundles, fetchFn: async (url, init) => {
    calls.push({ url, range: init.headers.Range || null });
    return new Response(body, { status: 200 });
  } });

  await assert.rejects(manager.install("test", false), /accept/);
  await manager.install("test", true);
  const done = await waitFor(manager);
  assert.equal(done.active, null);
  assert.equal(done.bundles[0].state, "ready");
  assert.deepEqual(await readFile(finalFile), body);
  await assert.rejects(readFile(`${finalFile}.part`));
  assert.equal(calls.length, 1);
});

test("curated model install resumes its own partial with a Range request", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiplay-models-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = Buffer.from("0123456789");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const relative = "checkpoints/resume.bin";
  const finalFile = path.join(root, relative);
  await mkdir(path.dirname(finalFile), { recursive: true });
  await writeFile(`${finalFile}.aiplay-part`, body.subarray(0, 4));
  const bundles = { test: { label: "Test", description: "Fixture", licenseUrl: "https://example.test/terms",
    totalBytes: body.length, files: [{ relative, bytes: body.length, sha256, url: "https://example.test/model" }] } };
  let range = null;
  const manager = await createModelManager({ modelsDir: root, bundles, fetchFn: async (url, init) => {
    range = init.headers.Range;
    return new Response(body.subarray(4), { status: 206, headers: { "Content-Range": "bytes 4-9/10" } });
  } });
  await manager.install("test", true);
  const done = await waitFor(manager);
  assert.equal(done.bundles[0].state, "ready");
  assert.equal(range, "bytes=4-");
  assert.deepEqual(await readFile(finalFile), body);
});

import { searchCatalog, catalogFiles, resolveCatalogFile, fetchModelFile } from '../server/engine/model-catalog.js';
import { createModelDisk } from './model-disk.js';
import { symlink, stat } from 'node:fs/promises';
const sample = Buffer.from('verified-model-file'), sampleHash = createHash('sha256').update(sample).digest('hex');
const hfInfo = { sha: 'a'.repeat(40), cardData: { license: 'mit' }, siblings: [{ rfilename: 'model.safetensors', lfs: { size: sample.length, sha256: sampleHash } }, { rfilename: 'unsafe.py' }] };
const chosen = { provider: 'huggingface', id: 'test/model', file: 'model.safetensors', folder: 'loras' };
const expectedFile = { bytes: sample.length, sha256: sampleHash };

test('catalog accepts pinned SafeTensors metadata and rejects arbitrary providers, URLs and destinations', async () => {
  const options = { fetchFn: async () => Response.json(hfInfo) };
  const d = await catalogFiles(chosen,options); assert.equal(d.files.length,1);
  const b = await resolveCatalogFile(chosen,options); assert.match(b.files[0].relative,/^loras\/aiplay_[a-f0-9]{12}_model.safetensors$/);
  assert.match(b.files[0].url,/resolve\/[a-f0-9]{40}\//);
  for (const bad of [{provider:'evil'}, {...chosen,id:'../etc'}, {...chosen,folder:'../output'}, {...chosen,file:'unsafe.py'}]) await assert.rejects(resolveCatalogFile(bad,options));
});
test('catalog search keeps descriptions as text and only accepts provider preview hosts', async () => {
  const data = await searchCatalog({provider:'civitai',type:'lora'}, {fetchFn: async u => {
    assert.equal(new URL(u).searchParams.get('nsfw'),'false');
    return Response.json({items:[{id:1,name:'Example',description:'<script>bad()</script><b>Style</b>',modelVersions:[{id:2,images:[{url:'http://127.0.0.1/private',nsfwLevel:1}]}]}]});
  }});
  assert.equal(data.items[0].image,null); assert.doesNotMatch(data.items[0].purpose,/<|>/);
});
test('Civitai file review retains exact file selector and SHA while dropping token query fields', async () => {
  const b = await resolveCatalogFile({provider:'civitai',id:'1',version:'2',file:'3',folder:'checkpoints'}, {fetchFn: async () => Response.json({modelVersions:[{id:2,files:[{id:3,name:'model.safetensors',sizeKB:sample.length/1024,hashes:{SHA256:sampleHash},downloadUrl:'https://civitai.com/api/download/models/2?fileId=3&token=not-saved'}]}]})});
  assert.match(b.files[0].url,/fileId=3/); assert.doesNotMatch(JSON.stringify(b),/not-saved|token=/);
});
test('download redirects drop authentication and refuse arbitrary network hosts', async () => {
  let calls=0;
  const r = await fetchModelFile('https://huggingface.co/test/model/resolve/a/model.safetensors',{headers:{Authorization:'Bearer only-provider'},signal:AbortSignal.timeout(5000)},async (u,i) => {
    calls++; if(calls===1){assert.equal(i.headers.Authorization,'Bearer only-provider');return new Response(null,{status:302,headers:{location:'https://us.aws.cdn.hf.co/file'}});}
    assert.equal(i.headers.Authorization,undefined);return new Response(sample);
  }); assert.equal(await r.text(),sample.toString());
  await assert.rejects(fetchModelFile('https://huggingface.co/file',{headers:{}},async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})),/unsupported host/);
});
test('catalog download writes only to worker models, persists identity and preserves other assets', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'aiplay-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const fetchFn=async u=>u.includes('/api/models/')?Response.json(hfInfo):new Response(sample);
  const manager=await createModelManager({modelsDir:root,bundles:{},fetchFn});
  await assert.rejects(manager.installCatalog(chosen,false,expectedFile),/terms/);
  await assert.rejects(manager.installCatalog(chosen,true,{...expectedFile,sha256:'0'.repeat(64)}),/changed/);
  await writeFile(path.join(root,'user-asset.txt'),'keep');
  await manager.installCatalog(chosen,true,expectedFile,'hf_testTokenOnlyInMemory');
  const state=await waitFor(manager);assert.equal(state.bundles[0].state,'ready');
  const entries=JSON.parse(await readFile(path.join(root,'.aiplay-catalog.json'),'utf8'));
  const b=Object.values(entries)[0];assert.deepEqual(await readFile(path.join(root,b.files[0].relative)),sample);
  assert.doesNotMatch(JSON.stringify(entries),/hf_test/);assert.equal(await readFile(path.join(root,'user-asset.txt'),'utf8'),'keep');
  const restart=await createModelManager({modelsDir:root,bundles:{},fetchFn});assert.equal(restart.status().bundles[0].state,'ready');
  await assert.rejects(restart.install(b.id,true),/model browser/);
});
test('catalog checksum failure never installs an unverified model', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'aiplay-bad-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const manager=await createModelManager({modelsDir:root,bundles:{},fetchFn:async u=>u.includes('/api/models/')?Response.json(hfInfo):new Response(Buffer.alloc(sample.length))});
  await manager.installCatalog(chosen,true,expectedFile);const state=await waitFor(manager);assert.equal(state.bundles[0].state,'failed');
  const b=Object.values(JSON.parse(await readFile(path.join(root,'.aiplay-catalog.json'),'utf8')))[0]; await assert.rejects(stat(path.join(root,b.files[0].relative)),/ENOENT/);
});
test('disk deletion requires review and confirmation, refuses active work, changed files and traversal', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'aiplay-model-disk-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'loras'));const target=path.join(root,'loras/example.safetensors');await writeFile(target,sample);
  let active=false, removed=null;
  const disk=createModelDisk({modelsDir:root,assertIdle:async()=>{if(active)throw Error('active work');},removed:r=>removed=r});
  assert.equal((await disk.list()).files.length,1);
  await assert.rejects(disk.review('../outside.safetensors'));
  const p=await disk.review('loras/example.safetensors');await assert.rejects(disk.remove({id:p.id}),/confirm/);
  active=true;await assert.rejects(disk.remove({id:p.id,confirm:'DELETE MODEL FILE'}),/active work/);active=false;
  const changed=await disk.review('loras/example.safetensors');await writeFile(target,'changed');
  await assert.rejects(disk.remove({id:changed.id,confirm:'DELETE MODEL FILE'}),/changed/);assert.equal(await readFile(target,'utf8'),'changed');
  const approved=await disk.review('loras/example.safetensors');await disk.remove({id:approved.id,confirm:'DELETE MODEL FILE'});
  assert.equal(removed,'loras/example.safetensors');await assert.rejects(stat(target),/ENOENT/);
  await assert.rejects(disk.remove({id:approved.id,confirm:'DELETE MODEL FILE'}),/review/i);
});
