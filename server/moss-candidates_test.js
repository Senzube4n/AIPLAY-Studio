/** Pinned checkpoint selection and bounded native high-resolution recipes. CPU fixtures only. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { MOSS_PRESETS, MOSS_KROMOSS_MODEL, MOSS_DMD2_ADAPTER, MOSS_HIRES_ADAPTER, mossRecipeIdentity } from "./moss-presets.js";
import { mossImageOptions, mossImageGraph, mossImageSettings, MOSS_IMAGE_FILES } from "./moss-image.js";
import { mossImageStatus } from "./moss-status.js";
import { mossModelPin } from "./moss-adapter.js";
import { CATALOG, isPictureModel } from "./models.js";
import { jobIdentity } from "./wildcards.js";

function fixtures(name, changes = {}) {
  const recipe = MOSS_PRESETS[name], graph = mossImageGraph({prompt:"check",mossPreset:name});
  const shelf = CATALOG.find(c=>c.id==="moss-image").files.map(f=>({name:path.basename(f.dest),folder:path.basename(path.dirname(f.dest)),bytes:f.bytes}));
  if (recipe.base) shelf.push({name:recipe.base.filename,folder:"diffusion_models",bytes:recipe.base.bytes});
  if (recipe.adapter) shelf.push({name:recipe.adapter.filename,folder:"loras",bytes:recipe.adapter.bytes});
  const info = Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{}]));
  info.CLIPLoader = {input:{required:{type:[["moss_image"]]}}};
  info.KSampler = {input:{required:{sampler_name:[["er_sde","euler"]],scheduler:[["simple"]]}}};
  if (recipe.adapter) info.LoraLoaderModelOnly = {input:{required:{model:["MODEL"],lora_name:[[recipe.adapter.filename]],strength_model:["FLOAT",{min:-100,max:100}]}}};
  return {options:{mossPreset:name},config:{},bases:async()=>[],scan:async()=>shelf,engine:{objectInfo:async()=>info},
    modelPin:async(_found,pin)=>({ready:true,sha256:pin.sha256,bytes:pin.bytes}),adapterPin:async(_found,pin)=>({ready:true,sha256:pin.sha256}),...changes};
}

test("Kromoss recipes select their exact checkpoint while preserving the accepted SFT recipe",()=>{
  for (const name of ["kromoss-standard","kromoss-dmd2-8"]) {
    const graph=mossImageGraph({prompt:"unchanged prompt",mossPreset:name}),settings=mossImageSettings(graph);
    assert.equal(graph[1].inputs.unet_name,MOSS_KROMOSS_MODEL.filename);
    assert.equal(graph[2].inputs.clip_name,MOSS_IMAGE_FILES.encoder); assert.equal(graph[3].inputs.vae_name,MOSS_IMAGE_FILES.vae);
    assert.equal(settings.baseModel.sha256,MOSS_KROMOSS_MODEL.sha256); assert.equal(settings.mossRecipe,mossRecipeIdentity(name));
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset:name,dit:MOSS_IMAGE_FILES.dit}),/Kromoss/);
  }
  assert.throws(()=>mossImageOptions({prompt:"x",dit:MOSS_KROMOSS_MODEL.filename}),/SFT bundle/);
  assert.equal(mossImageGraph({prompt:"x"})[1].inputs.unet_name,MOSS_IMAGE_FILES.dit);
  assert.equal(mossImageSettings(mossImageGraph({prompt:"x"})).mossRecipe,undefined);
});

test("DMD2 is exactly the new pinned adapter and cannot acquire another recipe's base or stack",()=>{
  const graph=mossImageGraph({prompt:"x",mossPreset:"kromoss-dmd2-8"});
  assert.equal(graph[6].inputs.lora_name,"kromoss_dmd2_8step.safetensors");
  assert.equal(graph[6].inputs.strength_model,1); assert.equal(graph[8].inputs.steps,8); assert.equal(graph[8].inputs.cfg,1);
  assert.equal(graph[8].inputs.sampler_name,"euler");
  assert.notEqual(MOSS_DMD2_ADAPTER.sha256,MOSS_PRESETS["dmd-8"].adapter.sha256);
  for(const extra of [{loras:[{name:"other.safetensors"}]},{negative:"blur"},{steps:4},{cfg:2.5},{width:2048,height:1024}]) {
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset:"kromoss-dmd2-8",...extra}));
  }
});

test("HiRes is exactly 2048 square/count1 and retains explicit native VAE decoding",()=>{
  const options=mossImageOptions({prompt:"x",mossPreset:"moss-hires-v03"}),graph=mossImageGraph(options),settings=mossImageSettings(graph);
  assert.equal(options.width,2048); assert.equal(options.height,2048); assert.equal(options.count,1);
  assert.equal(options.cfg,4); assert.equal(options.steps,25); assert.equal(graph[6].inputs.lora_name,MOSS_HIRES_ADAPTER.filename);
  assert.equal(graph[1].inputs.unet_name,MOSS_IMAGE_FILES.dit); assert.equal(graph[12].class_type,"VAEDecode"); assert.equal(settings.vaeDecode,"native");
  assert.equal(mossImageOptions({prompt:"matched control",width:2048,height:2048,count:1,cfg:4,steps:25}).cfg,4);
  for(const extra of [{width:1024},{height:1536},{width:2064},{count:2},{cfg:2.5},{refImages:["face.png"]},{loras:[{name:"other.safetensors"}]}]) {
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset:"moss-hires-v03",...extra}));
  }
});

test("same-sized SFT cannot satisfy missing Kromoss and failed checkpoint hashes refuse readiness",async()=>{
  for(const name of ["kromoss-standard","kromoss-dmd2-8","moss-hires-v03"]) assert.equal((await mossImageStatus(fixtures(name))).ready,true,name);
  const d=fixtures("kromoss-standard"),shelf=await d.scan();
  const missing=await mossImageStatus({...d,scan:async()=>shelf.filter(f=>f.name!==MOSS_KROMOSS_MODEL.filename)});
  assert.equal(missing.ready,false); assert.equal(missing.needsModel,MOSS_KROMOSS_MODEL.catalogueId);
  const corrupt=await mossImageStatus({...d,modelPin:async()=>({ready:false,error:"Diffusion model SHA256 mismatch"})});
  assert.equal(corrupt.ready,false); assert.equal(corrupt.baseModel.ready,false); assert.match(corrupt.error,/SHA256/);
  const overridden=await mossImageStatus(fixtures("kromoss-standard",{config:{modelOverrides:{[MOSS_KROMOSS_MODEL.filename]:MOSS_IMAGE_FILES.dit}}}));
  assert.equal(overridden.ready,false);
  const oldRuntime=await d.engine.objectInfo();oldRuntime.KSampler.input.required.sampler_name=[["euler"]];
  assert.equal((await mossImageStatus({...d,engine:{objectInfo:async()=>oldRuntime}})).ready,false);
});

test("checkpoint verification streams stable bytes and invalidates a same-size changed artifact",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"moss-checkpoint-pin-")),file=path.join(dir,"model.safetensors");
  const data=Buffer.from("small checkpoint verification fixture"),pin={bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")};
  try {
    await writeFile(file,data);const found={full:file,bytes:data.length};
    const verified=await mossModelPin(found,pin); assert.equal(verified.ready,true);assert.strictEqual(await mossModelPin(found,pin),verified);
    await writeFile(file,Buffer.alloc(data.length,120));
    const bad=await mossModelPin(found,pin); assert.equal(bad.ready,false);assert.match(bad.error,/Diffusion model SHA256/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("catalogue pins match explicit recipes and unknown HiRes terms remain unknown",()=>{
  for(const pin of [MOSS_KROMOSS_MODEL,MOSS_DMD2_ADAPTER,MOSS_HIRES_ADAPTER]) {
    const cap=CATALOG.find(c=>c.id===pin.catalogueId); assert.ok(cap); assert.equal(isPictureModel(cap),false);assert.equal(cap.addonFor,"moss-image");
    assert.equal(cap.files[0].sha256,pin.sha256); assert.equal(cap.files[0].url,pin.url);assert.equal(cap.files[0].bytes,pin.bytes);
  }
  const rights=CATALOG.find(c=>c.id===MOSS_HIRES_ADAPTER.catalogueId).outputRights;
  assert.equal(rights.class,"unknown");assert.equal(rights.sellable,null);assert.equal(rights.quote,"");assert.equal(rights.clause,"");
  assert.notEqual(jobIdentity({engine:"moss-image",prompt:"x",mossPreset:"standard"}),jobIdentity({engine:"moss-image",prompt:"x",mossPreset:"kromoss-standard"}));
});
