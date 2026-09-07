import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { glbDoc,packGlb,fixtureBin } from './fixtures.js';
import { inspectAvatar,createAvatarService,createAvatarRoutes } from './avatar.js';
import { avatarTools } from '../mcp-avatars.js';
let pass=0;async function test(name,fn){await fn();pass++;console.log(`ok ${name}`);}
const fixture=(opts={skinned:true})=>{const doc=glbDoc(opts);doc.materials=[{pbrMetallicRoughness:{baseColorFactor:[.3,.5,.7,1],metallicFactor:0,roughnessFactor:.6}}];doc.meshes[0].primitives[0].material=0;return doc;};
const temp=await mkdtemp(path.join(os.tmpdir(),'studio-avatar-'));
let server;
try{
  const input=path.join(temp,'input.glb'),bytes=packGlb(fixture());await writeFile(input,bytes);
  await test('valid binary skin is admitted but visual and clip readiness stay pending',async()=>{const r=await inspectAvatar(bytes);assert.equal(r.validation.errors,0);assert.equal(r.joints,3);assert.equal(r.triangles,12);assert.equal(r.state,'needs_visual_review');assert.deepEqual(r.missingClips,['idle','walk','run']);});
  /* ⚠ THE ADMISSION assertSkinned CANNOT MAKE. This is the surface where
   * people hand each other files, and it used to admit a GLB on its skin
   * structure alone. The fixture below is IDENTICAL to the accepted one in
   * every structural respect a glTF reader can name — same skins[], same
   * joints, same bind matrices, same JOINTS_0/WEIGHTS_0, same size to the
   * byte — with every gram of weight on the root, so posing it carries the
   * mesh rigidly instead of deforming it. It is a handle, not a rig, and
   * only server/mesh/deform.js can tell. See deform_test.js §1-§2. */
  await test('a skin that binds but does not deform is refused, though nothing structural separates it',async()=>{const d=fixture({skinned:true,rigid:true});assert.equal(packGlb(d).length,bytes.length);await assert.rejects(inspectAvatar(packGlb(d)),/binds but does not deform/);});
  await test('an unposeable skin is refused as not shown to deform, never as a pass',async()=>{const d=fixture({skinned:true});d.bufferViews[0].extensions={EXT_meshopt_compression:{}};await assert.rejects(inspectAvatar(packGlb(d)),/not shown to deform|validation failed/);});
  await test('the admitted file carries its measurement, and says the Blender cross-check is UNRUN',async()=>{const r=await inspectAvatar(bytes);assert.equal(r.deformation.state,'deforms');assert.ok(r.deformation.strain>r.deformation.minStrain);assert.equal(r.deformation.crossCheck,'unrun');assert.equal(r.deformation.crossAgreed,null);assert.match(r.caveat,/UNRUN/);});
  await test('declared skin without weights is rejected',async()=>{const d=fixture();delete d.meshes[0].primitives[0].attributes.WEIGHTS_0;await assert.rejects(inspectAvatar(packGlb(d)),/validation failed|Unusable skin/);});
  await test('remote and data URI images are refused before resource loading',async()=>{for(const uri of ['https://example.test/private','data:image/png;base64,AAAA']){const d=fixture();d.images=[{uri}];await assert.rejects(inspectAvatar(packGlb(d)),/Embed all/);}});
  await test('custom extension requirements are refused',async()=>{const d=fixture();d.extensionsUsed=['VENDOR_custom_shader'];await assert.rejects(inspectAvatar(packGlb(d)),/unsupported extensions/);});
  await test('oversize and malformed files are refused',async()=>{await assert.rejects(inspectAvatar(Buffer.alloc(8*1024*1024+1)),/8 MiB/);await assert.rejects(inspectAvatar(Buffer.from('bad file')),/not a GLB/);});
  await test('nonfinite vertex values fail Khronos binary validation',async()=>{const d=fixture();fixtureBin(d).writeFloatLE(NaN,0);await assert.rejects(inspectAvatar(packGlb(d)),/validation failed/);});
  const events=[],service=createAvatarService({directory:path.join(temp,'shelf'),record:async e=>events.push(e)});
  const options={path:input,name:'QA fixture',source:'Procedural cuboid for binary checks, not a character.',license:'Test fixture only.',skeleton_family:'qa-three-joints',facing:'+Z',persona_id:'9'};
  let row;
  await test('import records agent and attribution without claiming account binding',async()=>{row=await service.importAsset(options,'agent:test');assert.equal(row.actor,'agent:test');assert.match(row.personaAttribution.authority,/not an account binding/);assert.equal(row.review.state,'pending');assert.equal(events[0].type,'import');});
  await test('fresh service can list and inspect the exact imported bytes',async()=>{const next=createAvatarService({directory:path.join(temp,'shelf')});assert.equal((await next.list()).length,1);assert.equal((await next.inspect(row.id)).inspection.sha256,row.inspection.sha256);});
  await test('export hashes the original and records local destination',async()=>{const result=await service.exportAsset(row.id,'agent:test');assert.deepEqual(await readFile(result.localFiles.glb),bytes);assert.equal(events.at(-1).type,'export');assert.equal(events.at(-1).data.destination,'local handoff');});
  await test('invalid ids cannot escape the shelf',async()=>{await assert.rejects(service.get('../../outside'),/Invalid avatar id/);});
  await test('provenance fields and facing are required',async()=>{await assert.rejects(service.importAsset({...options,license:''}),/License/);await assert.rejects(service.importAsset({...options,facing:'north'}),/facing/);});
  await test('base64 import roundtrips with same content hash',async()=>{const r=await service.importAsset({...options,path:undefined,data_base64:bytes.toString('base64')});assert.equal(r.inspection.sha256,row.inspection.sha256);});
  await test('post-import tampering blocks inspect and export',async()=>{await writeFile(path.join(temp,'shelf',row.id,'avatar.glb'),Buffer.from('changed'));await assert.rejects(service.inspect(row.id),/changed on disk/);await assert.rejects(service.exportAsset(row.id),/changed on disk/);});
  const routes=createAvatarRoutes({directory:path.join(temp,'http'),json:(res,code,b)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(b));},provenance:{append:async()=>{},actorFrom:()=> 'agent:http-test'}});
  server=http.createServer((req,res)=>routes(req,res,new URL(req.url,'http://localhost')).catch(e=>{res.writeHead(500);res.end(e.message);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const post=(body,headers={})=>fetch(base+'/api/avatars',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  await test('HTTP rejects cross-site, opaque and different-port origins',async()=>{for(const h of [{Origin:'https://evil.test'},{Origin:'null'},{Origin:'http://127.0.0.1:1'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await post({action:'inspect',id:row.id},h)).status,403);});
  await test('HTTP refuses DNS rebinding Host on reads too',async()=>{const code=await new Promise((resolve,reject)=>{http.get(base+'/api/avatars',{headers:{Host:'evil.test'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject);});assert.equal(code,403);});
  await test('HTTP imports and serves local GLB/manifest and actual Three modules',async()=>{const res=await post({action:'import',...options},{Origin:base});assert.equal(res.status,200,await res.clone().text());const r=await res.json();const glb=await fetch(base+r.files.glb);assert.deepEqual(Buffer.from(await glb.arrayBuffer()),bytes);assert.equal((await fetch(base+r.files.manifest)).status,200);const mod=await fetch(base+'/api/avatars/vendor/three.module.js');assert.equal(mod.status,200);assert.match(mod.headers.get('Content-Type'),/javascript/);assert.ok((await mod.text()).length>10000);});
  await test('MCP verbs preserve their shared route arguments',async()=>{const calls=[];const tools=avatarTools(async(...args)=>{calls.push(args);return {ok:true};});await tools.find(t=>t.name==='avatar_import').run(options);assert.deepEqual(calls[0],['POST','/api/avatars',{action:'import',...options}]);await tools.find(t=>t.name==='avatar_export').run({id:row.id});assert.deepEqual(calls[1],['POST','/api/avatars',{action:'export',id:row.id}]);});
  console.log(`${pass} avatar checks passed`);
}finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
