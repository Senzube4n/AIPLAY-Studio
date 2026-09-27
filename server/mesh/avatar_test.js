import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { glbDoc,packGlb,fixtureBin } from './fixtures.js';
import { inspectAvatar,createAvatarService,createAvatarRoutes } from './avatar.js';
import { inspectAvatarSource, inspectAvatarSourceBytes, summarizeAvatarColorSources } from './avatar-source.js';
import { inspectAvatarFootControls } from './avatar-foot-controls.js';
import { avatarTools } from '../mcp-avatars.js';
let pass=0;async function test(name,fn){await fn();pass++;console.log(`ok ${name}`);}
const fixture=(opts={skinned:true})=>{const doc=glbDoc(opts);doc.materials=[{pbrMetallicRoughness:{baseColorFactor:[.3,.5,.7,1],metallicFactor:0,roughnessFactor:.6}}];doc.meshes[0].primitives[0].material=0;return doc;};
const temp=await mkdtemp(path.join(os.tmpdir(),'studio-avatar-'));
let server;
try{
  const input=path.join(temp,'input.glb'),bytes=packGlb(fixture());await writeFile(input,bytes);
  await test('source preflight gives useful facts for an unrigged, untextured GLB without claiming quality',async()=>{
    const raw=packGlb(glbDoc());const result=await inspectAvatarSourceBytes(raw);
    assert.equal(result.geometry.triangles,12);assert.equal(result.geometry.meshNodes,1);
    assert.equal(result.surface.materials,0);assert.equal(result.surface.images,0);
    assert.equal(result.surface.colorSources.defaultColorOnlyPrimitives,1);
    assert.equal(result.surface.colorSources.baseColorTextureWithUv,0);
    assert.equal(result.skin.structural,'absent');assert.equal(result.vrm.version,null);
    assert.equal(result.deformation.state,'absent');
    assert.equal(result.springMotion.status,'no_springs');
    assert.deepEqual(result.next.map(step=>step.code),['surface','parts','rig','vrm']);
    assert.equal(result.footControls.geometrySeparation,'unverified');
    assert.match(result.caveat,/Review fused anatomy/);
  });
  await test('source colour inventory distinguishes embedded images from connected base-colour textures and UVs',async()=>{
    const doc={images:[{},{}],textures:[{source:1}],materials:[
      {pbrMetallicRoughness:{baseColorTexture:{index:0,texCoord:1}}},
      {pbrMetallicRoughness:{baseColorFactor:[.4,.5,.6,1]}},
    ],meshes:[{primitives:[
      {material:0,attributes:{POSITION:0,TEXCOORD_0:1}},
      {material:1,attributes:{POSITION:0}},
      {attributes:{POSITION:0,COLOR_0:2}},
      {attributes:{POSITION:0}},
    ]}]};
    const missing=summarizeAvatarColorSources(doc);
    assert.equal(missing.baseColorTextureBindings,1);
    assert.equal(missing.baseColorTextureMissingUv,1);
    assert.equal(missing.baseColorTextureWithUv,0);
    assert.deepEqual(missing.baseColorImageIndices,[1]);
    assert.equal(missing.vertexColorBindings,1);
    assert.equal(missing.materialColorOnlyPrimitives,1);
    assert.equal(missing.defaultColorOnlyPrimitives,1);
    doc.meshes[0].primitives[0].attributes.TEXCOORD_1=3;
    const connected=summarizeAvatarColorSources(doc);
    assert.equal(connected.baseColorTextureWithUv,1);
    assert.equal(connected.baseColorTextureMissingUv,0);
    doc.materials[0].pbrMetallicRoughness.baseColorTexture.extensions={KHR_texture_transform:{texCoord:0}};
    assert.equal(summarizeAvatarColorSources(doc).baseColorTextureWithUv,1);
    assert.equal(summarizeAvatarColorSources({...doc,meshes:[{primitives:[{material:1,attributes:{POSITION:0}}]}]}).baseColorTextureBindings,0);
  });
  await test('source colour inventory includes extension-backed images and a core fallback',async()=>{
    const doc={images:[{},{},{},{}],textures:[{source:0,extensions:{
      KHR_texture_basisu:{source:1},EXT_texture_webp:{source:2},EXT_texture_avif:{source:3},
    }}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],
      meshes:[{primitives:[{material:0,attributes:{POSITION:0,TEXCOORD_0:1}}]}]};
    assert.deepEqual(summarizeAvatarColorSources(doc).baseColorImageIndices,[0,1,2,3]);
    delete doc.textures[0].source;
    assert.deepEqual(summarizeAvatarColorSources(doc).baseColorImageIndices,[1,2,3]);
    assert.equal(summarizeAvatarColorSources(doc).baseColorTextureWithUv,1);
  });
  await test('source preflight flags an embedded image that supplies no mesh base colour',async()=>{
    const doc=glbDoc();
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=','base64');
    const bin=Buffer.concat([fixtureBin(doc),png]);
    doc.bufferViews.push({buffer:0,byteOffset:fixtureBin(doc).length,byteLength:png.length});
    doc.buffers[0].byteLength=bin.length;
    doc.images=[{bufferView:doc.bufferViews.length-1,mimeType:'image/png'}];
    const result=await inspectAvatarSourceBytes(packGlb(doc,bin));
    assert.equal(result.surface.images,1);
    assert.equal(result.surface.colorSources.baseColorTextureBindings,0);
    assert.ok(result.next.some(step=>step.code==='base-color'));
  });
  await test('source preflight recognizes a connected base-colour texture with the requested UV set',async()=>{
    const doc=glbDoc();
    const uv=Buffer.alloc(8*8);
    for(let i=0;i<8;i++){uv.writeFloatLE((i%2),i*8);uv.writeFloatLE((i>>1)%2,i*8+4);}
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6cAAAAASUVORK5CYII=','base64');
    const bin=Buffer.concat([fixtureBin(doc),uv,png]);
    doc.bufferViews.push({buffer:0,byteOffset:fixtureBin(doc).length,byteLength:uv.length});
    doc.bufferViews.push({buffer:0,byteOffset:fixtureBin(doc).length+uv.length,byteLength:png.length});
    doc.buffers[0].byteLength=bin.length;
    doc.accessors.push({bufferView:5,componentType:5126,count:8,type:'VEC2'});
    doc.meshes[0].primitives[0].attributes.TEXCOORD_0=2;
    doc.meshes[0].primitives[0].material=0;
    doc.images=[{bufferView:6,mimeType:'image/png'}];
    doc.textures=[{source:0}];
    doc.materials=[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}];
    const result=await inspectAvatarSourceBytes(packGlb(doc,bin));
    assert.equal(result.surface.colorSources.baseColorTextureWithUv,1);
    assert.equal(result.surface.colorSources.baseColorTextureMissingUv,0);
    assert.deepEqual(result.surface.colorSources.baseColorImageIndices,[0]);
    assert.ok(!result.next.some(step=>step.code==='base-color'));
  });
  await test('source preflight distinguishes a deforming rig from an equally valid rigid skin',async()=>{
    const moving=await inspectAvatarSourceBytes(packGlb(glbDoc({skinned:true})));
    const rigid=await inspectAvatarSourceBytes(packGlb(glbDoc({skinned:true,rigid:true})));
    assert.equal(moving.skin.structural,'valid');assert.equal(rigid.skin.structural,'valid');
    assert.equal(moving.skin.joints,3);assert.equal(rigid.skin.joints,3);
    assert.equal(moving.deformation.state,'deforms');assert.equal(rigid.deformation.state,'rigid');
    assert.ok(moving.deformation.strain>rigid.deformation.strain);
    assert.ok(!moving.next.some(step=>step.code==='rig-bend'));
    assert.ok(rigid.next.some(step=>step.code==='rig-bend'));
    assert.ok(moving.next.some(step=>step.code==='foot-review'));
    assert.equal(moving.footControls.state,'unverified');
    assert.equal(moving.footControls.reviewRequired,true);
    assert.match(rigid.caveat,/not whether bends look good/);
  });
  await test('source preflight exposes disconnected spring chains before import',async()=>{
    const doc=glbDoc({skinned:true});
    doc.nodes[3].children=[4];doc.nodes.push({name:'Unweighted strand'});
    doc.extensionsUsed=['VRMC_springBone'];
    doc.extensions={VRMC_springBone:{specVersion:'1.0',springs:[
      {name:'Weighted strand',joints:[{node:3}]},
      {name:'Unweighted strand',joints:[{node:4}]},
    ]}};
    const result=await inspectAvatarSourceBytes(packGlb(doc));
    assert.equal(result.springMotion.status,'linked');
    assert.equal(result.springMotion.linkedChains,1);
    assert.equal(result.springMotion.declaredChains,2);
    assert.deepEqual(result.springMotion.unlinkedChainNames,['Unweighted strand']);
    assert.ok(result.next.some(step=>step.code==='spring-links'));
    doc.extensions.VRMC_springBone.springs=[{name:'Unweighted strand',joints:[{node:4}]}];
    const disconnected=await inspectAvatarSourceBytes(packGlb(doc));
    assert.equal(disconnected.springMotion.status,'unlinked');
    assert.equal(disconnected.springMotion.linkedChains,0);
  });
  await test('a VRM without spring chains offers an optional movement preparation step',async()=>{
    const doc=glbDoc({skinned:true});
    doc.extensionsUsed=['VRMC_vrm'];
    doc.extensions={VRMC_vrm:{specVersion:'1.0'}};
    const result=await inspectAvatarSourceBytes(packGlb(doc));
    assert.equal(result.springMotion.status,'no_springs');
    assert.ok(result.next.some(step=>step.code==='spring-author'));
  });
  await test('VRM foot controls report independent, missing and cross-weighted vertices without claiming a leg gap',async()=>{
    const make=()=>{const doc=glbDoc({skinned:true});doc.nodes[1].children=[2,3];delete doc.nodes[2].children;doc.extensions={VRMC_vrm:{specVersion:'1.0',humanoid:{humanBones:{leftFoot:{node:2},rightFoot:{node:3}}}}};return doc;};
    const separate=make(),linked=inspectAvatarFootControls(separate,fixtureBin(separate));
    assert.equal(linked.state,'independent_weights');
    assert.equal(linked.leftFootNode,2);assert.equal(linked.rightFootNode,3);
    assert.ok(linked.leftVertices>0&&linked.rightVertices>0);
    assert.equal(linked.sharedVertices,0);
    assert.equal(linked.geometrySeparation,'unverified');
    assert.equal(linked.reviewRequired,true);
    const missing=make();for(let vertex=0;vertex<8;vertex++)fixtureBin(missing).writeUInt8(1,288+vertex*4);
    assert.equal(inspectAvatarFootControls(missing,fixtureBin(missing)).state,'unweighted');
    const mixed=make(),bin=fixtureBin(mixed);
    bin.writeUInt8(1,288);bin.writeUInt8(2,289);bin.writeFloatLE(.5,320);bin.writeFloatLE(.5,324);
    const overlap=inspectAvatarFootControls(mixed,bin);
    assert.equal(overlap.state,'cross_weighted');assert.equal(overlap.sharedVertices,1);
    const unmapped=make();delete unmapped.extensions.VRMC_vrm.humanoid.humanBones.rightFoot;
    const noMapping=inspectAvatarFootControls(unmapped,fixtureBin(unmapped));
    assert.equal(noMapping.state,'unverified');assert.equal(noMapping.leftFootNode,undefined);
    const hidden=make();hidden.scenes[0].nodes=[0];
    assert.equal(inspectAvatarFootControls(hidden,fixtureBin(hidden)).state,'unverified');
  });
  await test('source preflight reads paths and canonical uploads but rejects external resources',async()=>{
    const raw=packGlb(glbDoc());const source=path.join(temp,'source.glb');await writeFile(source,raw);
    const fromPath=await inspectAvatarSource({path:source});
    const fromUpload=await inspectAvatarSource({data_base64:raw.toString('base64')});
    assert.equal(fromPath.sha256,fromUpload.sha256);
    await assert.rejects(inspectAvatarSource({path:source,data_base64:raw.toString('base64')}),/exactly one/);
    await assert.rejects(inspectAvatarSource({data_base64:'AA=A'}),/canonical base64/);
    const external=glbDoc();external.images=[{uri:'https://example.test/texture.png'}];
    await assert.rejects(inspectAvatarSourceBytes(packGlb(external)),/Embed all buffers and images/);
  });
  await test('valid binary skin is admitted but visual, foot and clip readiness stay pending',async()=>{const r=await inspectAvatar(bytes);assert.equal(r.validation.errors,0);assert.equal(r.joints,3);assert.equal(r.triangles,12);assert.equal(r.state,'needs_visual_review');assert.equal(r.footControls.state,'unverified');assert.equal(r.footControls.geometrySeparation,'unverified');assert.deepEqual(r.missingClips,['idle','walk','run']);});
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
  await test('source preflight HTTP accepts an unrigged upload without importing it',async()=>{
    const response=await post({action:'source_preflight',data_base64:packGlb(glbDoc()).toString('base64')},{Origin:base});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).skin.structural,'absent');
    await assert.rejects(readdir(path.join(temp,'http')),{code:'ENOENT'});
  });
  await test('source preflight HTTP and MCP report the same measured bend state',async()=>{
    const rigid=await post({action:'source_preflight',data_base64:packGlb(glbDoc({skinned:true,rigid:true})).toString('base64')},{Origin:base});
    assert.equal(rigid.status,200,await rigid.clone().text());
    assert.equal((await rigid.json()).deformation.state,'rigid');
    const api=async(method,route,body)=>{
      assert.equal(method,'POST');assert.equal(route,'/api/avatars');
      const response=await post(body,{Origin:base});assert.equal(response.status,200,await response.clone().text());
      return response.json();
    };
    const result=await avatarTools(api).find(tool=>tool.name==='avatar_source_preflight').run({path:input});
    assert.equal(result.deformation.state,'deforms');
    assert.equal(result.surface.colorSources.materialColorOnlyPrimitives,1);
    assert.ok(result.deformation.probedJoints>0);
    assert.equal(result.footControls.geometrySeparation,'unverified');
  });
  await test('source preflight HTTP and MCP agree on spring links for identical bytes',async()=>{
    const doc=glbDoc({skinned:true});
    doc.nodes[3].children=[4];doc.nodes.push({name:'Free strand'});
    doc.extensionsUsed=['VRMC_springBone'];
    doc.extensions={VRMC_springBone:{specVersion:'1.0',springs:[{name:'Free strand',joints:[{node:4}]}]}};
    const raw=packGlb(doc),file=path.join(temp,'spring-source.glb');await writeFile(file,raw);
    const response=await post({action:'source_preflight',data_base64:raw.toString('base64')},{Origin:base});
    assert.equal(response.status,200,await response.clone().text());
    const browser=await response.json();
    const api=async(_method,_route,body)=>{
      const reply=await post(body,{Origin:base});assert.equal(reply.status,200,await reply.clone().text());
      return reply.json();
    };
    const mcp=await avatarTools(api).find(tool=>tool.name==='avatar_source_preflight').run({path:file});
    assert.equal(browser.sha256,mcp.sha256);
    assert.deepEqual(browser.springMotion,mcp.springMotion);
    assert.equal(mcp.springMotion.status,'unlinked');
  });
  await test('HTTP rejects cross-site, opaque and different-port origins',async()=>{for(const h of [{Origin:'https://evil.test'},{Origin:'null'},{Origin:'http://127.0.0.1:1'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await post({action:'inspect',id:row.id},h)).status,403);});
  await test('HTTP refuses DNS rebinding Host on reads too',async()=>{const code=await new Promise((resolve,reject)=>{http.get(base+'/api/avatars',{headers:{Host:'evil.test'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject);});assert.equal(code,403);});
  await test('HTTP imports and serves local GLB/manifest and actual Three modules',async()=>{const res=await post({action:'import',...options},{Origin:base});assert.equal(res.status,200,await res.clone().text());const r=await res.json();const glb=await fetch(base+r.files.glb);assert.deepEqual(Buffer.from(await glb.arrayBuffer()),bytes);assert.equal((await fetch(base+r.files.manifest)).status,200);const mod=await fetch(base+'/api/avatars/vendor/three.module.js');assert.equal(mod.status,200);assert.match(mod.headers.get('Content-Type'),/javascript/);assert.ok((await mod.text()).length>10000);});
  await test('MCP verbs preserve their shared route arguments',async()=>{const calls=[];const tools=avatarTools(async(...args)=>{calls.push(args);return {ok:true};});await tools.find(t=>t.name==='avatar_source_preflight').run({path:input});assert.deepEqual(calls[0],['POST','/api/avatars',{action:'source_preflight',path:input}]);await tools.find(t=>t.name==='avatar_import').run(options);assert.deepEqual(calls[1],['POST','/api/avatars',{action:'import',...options}]);await tools.find(t=>t.name==='avatar_export').run({id:row.id});assert.deepEqual(calls[2],['POST','/api/avatars',{action:'export',id:row.id}]);});
  console.log(`${pass} avatar checks passed`);
}finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});}
