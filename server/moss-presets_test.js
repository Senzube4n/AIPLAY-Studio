import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { mossImageGraph, mossImageOptions, mossImageSettings } from "./moss-image.js";
import { MOSS_PRESETS, MOSS_PRESET_NAMES, MOSS_SPECTRUM, mossRecipeIdentity } from "./moss-presets.js";
import { mossImageStatus } from "./moss-status.js";
import { mossSpectrumPin } from "./moss-spectrum.js";
import { mossAdapterPin } from "./moss-adapter.js";
import { CATALOG, isPictureModel } from "./models.js";
import { defaultFor, recommendFor } from "./fit.js";
import { jobIdentity } from "./wildcards.js";
import { workspaceTools } from "./mcp-workspace.js";
import { TOOLS } from "./mcp.js";

// Literal native INPUT_TYPES extracted from the pinned public source without importing it.
const spectrumContracts = {
  "SpectrumMOSSImageManual": {
    "input": {
      "required": {
        "model": [
          "MODEL",
          {}
        ],
        "warmup_steps": [
          "INT",
          {
            "min": 0,
            "max": 64
          }
        ],
        "tail_actual_steps": [
          "INT",
          {
            "min": 0,
            "max": 64
          }
        ],
        "window_size": [
          "FLOAT",
          {
            "min": 1.0,
            "max": 16.0
          }
        ],
        "flex_window": [
          "FLOAT",
          {
            "min": 0.0,
            "max": 8.0
          }
        ],
        "max_consecutive_forecasts": [
          "INT",
          {
            "min": 0,
            "max": 32
          }
        ],
        "history_points": [
          "INT",
          {
            "min": 2,
            "max": 32
          }
        ],
        "chebyshev_degree": [
          "INT",
          {
            "min": 1,
            "max": 12
          }
        ],
        "ridge_lambda": [
          "FLOAT",
          {
            "min": 0.0,
            "max": 10.0
          }
        ],
        "blend_weight": [
          "FLOAT",
          {
            "min": 0.0,
            "max": 1.0
          }
        ],
        "cache_device": [
          [
            "main_device",
            "offload_device",
            "cpu"
          ],
          {}
        ],
        "force_actual_on_control": [
          "BOOLEAN",
          {}
        ],
        "debug": [
          "BOOLEAN",
          {}
        ],
        "warn_unverified_sampler": [
          "BOOLEAN",
          {}
        ]
      }
    }
  },
  "SpectrumMOSSImageAdaptive": {
    "input": {
      "required": {
        "model": [
          "MODEL",
          {}
        ],
        "warmup_steps": [
          "INT",
          {
            "min": 0,
            "max": 64
          }
        ],
        "detail_guard_steps": [
          "INT",
          {
            "min": 0,
            "max": 32
          }
        ],
        "tail_actual_steps": [
          "INT",
          {
            "min": 0,
            "max": 16
          }
        ],
        "post_guard_horizon_cap": [
          "INT",
          {
            "min": 1,
            "max": 16
          }
        ],
        "window_size": [
          "FLOAT",
          {
            "min": 1.0,
            "max": 16.0
          }
        ],
        "flex_window": [
          "FLOAT",
          {
            "min": 0.0,
            "max": 8.0
          }
        ],
        "cache_device": [
          [
            "main_device",
            "offload_device",
            "cpu"
          ],
          {}
        ],
        "error_tolerance": [
          "FLOAT",
          {
            "min": 0.75,
            "max": 1.5
          }
        ],
        "debug": [
          "BOOLEAN",
          {}
        ],
        "warn_unverified_sampler": [
          "BOOLEAN",
          {}
        ]
      }
    }
  }
};
const cap = CATALOG.find(c=>c.id==="moss-image");
const shelf = cap.files.map(f=>({name:path.basename(f.dest),folder:path.basename(path.dirname(f.dest)),bytes:f.bytes}));
function deps(name, extra={}) {
  const recipe=MOSS_PRESETS[name];
  const graph=mossImageGraph({prompt:"check",mossPreset:name});
  const info=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{}]));
  Object.assign(info,structuredClone(spectrumContracts));
  info.CLIPLoader={input:{required:{type:[["moss_image"]]}}};
  info.KSampler={input:{required:{sampler_name:[["er_sde","euler"]],scheduler:[["simple"]]}}};
  info.LoraLoaderModelOnly={input:{required:{model:["MODEL"],lora_name:[[...(recipe.adapter?[recipe.adapter.filename]:[])]],strength_model:["FLOAT",{min:-100,max:100}]}}};
  return { options:{mossPreset:name},config:{},bases:async()=>[],scan:async()=>[...shelf,...(recipe.base?[{name:recipe.base.filename,folder:"diffusion_models",bytes:recipe.base.bytes}]:[]),...(recipe.adapter?[{name:recipe.adapter.filename,folder:"loras",bytes:recipe.adapter.bytes}]:[])],
    spectrumPin:async()=>({ready:true,commit:MOSS_SPECTRUM.commit}),modelPin:async(_found,pin)=>({ready:true,sha256:pin.sha256}),adapterPin:async(_found,pin)=>({ready:true,sha256:pin.sha256}),engine:{objectInfo:async()=>info},...extra };
}

test("accepted Standard graph is byte-equivalent and all explicit policies wire MODEL before sampling",()=>{
  const graph=mossImageGraph({prompt:"baseline byte equivalence",seed:19});
  assert.equal(createHash("sha256").update(JSON.stringify(graph)).digest("hex"),"0c550ba1b6b9d59d19ab7f40982c6198877ae8cd6c4990d69a16878c24e620a8");
  assert.deepEqual(mossImageGraph({prompt:"baseline byte equivalence",seed:19,mossPreset:"standard"}),graph);
  for(const name of MOSS_PRESET_NAMES) {
    const g=mossImageGraph({prompt:"raw prompt",seed:19,mossPreset:name}),r=MOSS_PRESETS[name],settings=mossImageSettings(g);
    assert.equal(g[4].inputs.text,"raw prompt"); assert.equal(g[8].inputs.steps,r.steps); assert.equal(g[8].inputs.cfg,r.cfg);
    assert.equal(g[8].inputs.sampler_name,r.sampler); assert.equal(g[8].inputs.scheduler,"simple");
    assert.equal(settings.shift,5); assert.equal(settings.promptUpsampler,false); assert.equal(settings.skipLayerGuidance,false);
    if(name==="standard") { assert.equal(g[6],undefined); continue; }
    if(name==="kromoss-standard") {
      assert.equal(g[6],undefined); assert.deepEqual(g[8].inputs.model,["1",0]);
      assert.equal(settings.baseModel.sha256,r.base.sha256); assert.equal(settings.mossRecipe,mossRecipeIdentity(name)); continue;
    }
    assert.equal(g[6].class_type,r.node); assert.deepEqual(g[8].inputs.model,["6",0]); assert.deepEqual(g[6].inputs.model,["1",0]);
    assert.equal(settings.mossPreset,name); assert.equal(settings.mossRecipe,mossRecipeIdentity(name));
    if(r.policy) {
      assert.deepEqual(Object.keys(g[6].inputs).sort(),Object.keys(spectrumContracts[r.node].input.required).sort());
      assert.equal(g[6].inputs.warmup_steps,8); assert.equal(g[6].inputs.tail_actual_steps,1); assert.equal(g[6].inputs.debug,true);
      assert.equal(settings.spectrum.commit,"d3f7e243ea2db6cc3ff26f42b935b167f938b599");
      if(name==="spectrum-manual-h1") assert.equal(g[6].inputs.max_consecutive_forecasts,1);
      else assert.equal(settings.spectrum.erSdeInternal.post_guard_horizon_cap,2);
    } else {
      assert.equal(g[6].inputs.lora_name,r.adapter.filename); assert.equal(g[6].inputs.strength_model,r.adapter.strength);
      assert.equal(settings.adapter.sha256,r.adapter.sha256); assert.equal(settings.publisherBf16Equivalent,false);
      assert.match(settings.loraPrecision,/int8.*requantization/);
    }
  }
});

test("unknown recipes, mismatched fixed dials and unsupported fast dimensions are refused",()=>{
  for(const mossPreset of ["constructor","toString","unknown",{},3]) assert.throws(()=>mossImageOptions({prompt:"x",mossPreset}));
  for(const mossPreset of MOSS_PRESET_NAMES.slice(1)) {
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset,steps:MOSS_PRESETS[mossPreset].steps+1}));
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset,cfg:MOSS_PRESETS[mossPreset].cfg+1}));
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset,loras:[{name:"other.safetensors"}]}));
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset,refImages:["x.png"]}));
  }
  for(const mossPreset of ["turbo-4","dmd-8"]) {
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset,width:1536,height:1024}),/1024/);
    assert.throws(()=>mossImageOptions({prompt:"x",mossPreset,negative:"blur"}),/CFG/);
  }
  assert.equal(mossImageOptions({prompt:"x",steps:50,cfg:3,width:2048,height:2048}).steps,50);
});

test("installed readiness requires the exact source pin, runtime schema, sampler and selected adapter",async()=>{
  for(const name of MOSS_PRESET_NAMES) {
    const result=await mossImageStatus(deps(name)); assert.equal(result.ready,true,name+": "+result.error);
  }
  const noSource=await mossImageStatus(deps("spectrum-manual-h1",{spectrumPin:async()=>({ready:false,error:"source mismatch"})}));
  assert.equal(noSource.ready,false); assert.equal(noSource.filesReady,true); assert.equal(noSource.runtimeReady,false); assert.match(noSource.error,/source mismatch/);
  const d=deps("spectrum-manual-h1"),old=await d.engine.objectInfo();delete old.SpectrumMOSSImageManual.input.required.warmup_steps;
  const bad=await mossImageStatus({...d,engine:{objectInfo:async()=>old}});assert.equal(bad.ready,false);assert.match(bad.error,/warmup_steps/);
  const missing=await mossImageStatus(deps("turbo-4",{scan:async()=>shelf}));assert.equal(missing.ready,false);assert.equal(missing.needsModel,"moss-image-turbo-4");
  assert.match(missing.error,/pinned experimental MOSS adapter/);
  const short=deps("dmd-8");const list=await short.scan();list.at(-1).bytes--;
  assert.equal((await mossImageStatus({...short,scan:async()=>list})).ready,false);
  const replaced=await mossImageStatus(deps("turbo-4",{config:{modelOverrides:{[MOSS_PRESETS["turbo-4"].adapter.filename]:"different.safetensors"}}}));
  assert.equal(replaced.ready,false);assert.match(replaced.error,/cannot be replaced/);
  const wrongSampler=deps("turbo-4"),info=await wrongSampler.engine.objectInfo();info.KSampler.input.required.sampler_name=[["er_sde"]];
  assert.equal((await mossImageStatus({...wrongSampler,engine:{objectInfo:async()=>info}})).ready,false);
});

test("Spectrum verifies actual small source hashes, not only a forgeable marker",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"moss-source-pin-"));
  const data=Buffer.from("reviewed source fixture"),hash=createHash("sha256").update(data).digest("hex");
  const pin={...MOSS_SPECTRUM,files:[{file:"nodes.py",bytes:data.length,sha256:hash}]};
  const target=path.join(dir,"custom_nodes",pin.folder); await mkdir(target,{recursive:true});
  await writeFile(path.join(target,"nodes.py"),data); await writeFile(path.join(target,pin.marker),JSON.stringify({schemaVersion:1,...pin}));
  try {
    assert.equal((await mossSpectrumPin({comfyDir:dir},pin)).ready,true);
    await writeFile(path.join(target,"nodes.py"),Buffer.alloc(data.length,120));
    const changed=await mossSpectrumPin({comfyDir:dir},pin); assert.equal(changed.ready,false);assert.match(changed.error,/hash/);
    assert.equal((await mossSpectrumPin({comfyDir:dir,remoteOnly:true},pin)).ready,false);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("duplicate/cache identity separates policy and adapter SHA while Standard stays compatible",()=>{
  const job={engine:"moss-image",prompt:"x",seed:9,steps:25,cfg:2.5};
  assert.equal(jobIdentity(job),jobIdentity({...job,mossPreset:"standard"}));
  assert.equal(new Set(MOSS_PRESET_NAMES.map(mossPreset=>jobIdentity({...job,mossPreset}))).size,MOSS_PRESET_NAMES.length);
  assert.equal(new Set(MOSS_PRESET_NAMES.map(mossRecipeIdentity)).size,MOSS_PRESET_NAMES.length);
  assert.equal(Object.isFrozen(MOSS_PRESETS["spectrum-manual-h1"].policy),true);
});

test("MCP and browser expose the same explicit recipes and readiness forwards the selected one",async()=>{
  const make=TOOLS.find(t=>t.name==="make_image");assert.deepEqual(make.inputSchema.properties.moss_preset.enum,MOSS_PRESET_NAMES);
  const calls=[],status=workspaceTools(async(...args)=>{calls.push(args);return {ready:false};},x=>x).find(t=>t.name==="moss_image_status");
  assert.deepEqual(status.inputSchema.properties.moss_preset.enum,MOSS_PRESET_NAMES);
  await status.run({moss_preset:"dmd-8"}); assert.equal(new URL(calls[0][1],"http://fixture").searchParams.get("mossPreset"),"dmd-8");
  const app=await readFile(new URL("../web/app.js",import.meta.url),"utf8");
  const start=app.indexOf("const IMG_MOSS_PRESETS = {"),end=app.indexOf("\n};",start)+3;
  const ui=vm.runInNewContext(app.slice(start,end)+";IMG_MOSS_PRESETS");
  assert.deepEqual(Object.keys(ui),MOSS_PRESET_NAMES);
  for(const name of MOSS_PRESET_NAMES) for(const key of ["steps","cfg","sampler","scheduler"]) assert.equal(ui[name][key],MOSS_PRESETS[name][key]);
});


test("adapter readiness rejects same-size corruption and invalidates a prior verified cache entry",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"moss-adapter-pin-")),file=path.join(dir,"fixture.safetensors");
  const data=Buffer.from("reviewed adapter fixture"),pin={bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")};
  try {
    await writeFile(file,data);const found={full:file,bytes:data.length};
    const first=await mossAdapterPin(found,pin);assert.equal(first.ready,true);assert.equal(first.sha256,pin.sha256);
    assert.strictEqual(await mossAdapterPin(found,pin),first,"unchanged bytes use the same verified cache entry");
    await writeFile(file,Buffer.alloc(data.length,120));
    const results=await Promise.all([mossAdapterPin(found,pin),mossAdapterPin(found,pin)]);
    const bad=results[0];assert.equal(bad.ready,false);assert.equal(results[1].ready,false);assert.match(bad.error,/SHA256/);
    const d=deps("turbo-4",{adapterPin:async()=>bad}); const status=await mossImageStatus(d);
    assert.equal(status.ready,false);assert.equal(status.adapter.ready,false);assert.match(status.error,/SHA256/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Spectrum source verification refuses a linked parent directory",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"moss-source-link-")),actual=path.join(dir,"actual"),link=path.join(dir,"linked");
  try {
    await mkdir(path.join(actual,"custom_nodes",MOSS_SPECTRUM.folder),{recursive:true});
    await symlink(actual,link,process.platform==="win32"?"junction":"dir");
    const result=await mossSpectrumPin({comfyDir:link});assert.equal(result.ready,false);assert.match(result.error,/parent links/);
  }finally{await rm(dir,{recursive:true,force:true});}
});


test("actual GET readiness route refuses auto/empty/unknown recipe values instead of reporting Standard",async()=>{
  const source=await readFile(new URL("./index.js",import.meta.url),"utf8");
  const start=source.indexOf('if (p === "/api/images/moss-status"'),end=source.indexOf('if (p === "/api/images/qwen-status"',start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const handler=new AsyncFunction("url","mossImageStatus","json",`const p="/api/images/moss-status",req={method:"GET"},res={}; ${source.slice(start,end)}`);
  for(const name of ["auto","","unknown","standard"]) {
    const result=await handler(new URL("http://fixture/api/images/moss-status?mossPreset="+name),({options})=>mossImageStatus({...deps("standard"),options}),(_res,_status,body)=>body);
    assert.equal(result.ready,name==="standard",name); if(name!=="standard") assert.match(result.error,/mossPreset/);
  }
});


test("selected adapter Models rows share exact recipe pins without becoming new picture engines",()=>{
  for(const name of ["turbo-4","dmd-8"]) {
    const r=MOSS_PRESETS[name],cap=CATALOG.find(c=>c.id==="moss-image-"+name);
    assert.ok(cap);assert.equal(cap.addonFor,"moss-image");assert.equal(cap.makes,undefined);
    assert.equal(cap.files.length,1);assert.equal(cap.files[0].url,r.adapter.url);assert.equal(cap.files[0].bytes,r.adapter.bytes);
    assert.equal(cap.files[0].sha256,r.adapter.sha256);assert.equal(path.basename(cap.files[0].dest),r.adapter.filename);
    assert.equal(isPictureModel(cap),false);
    const ready={...cap,ready:true}; assert.notEqual(defaultFor("image",{capabilities:[ready]}).value,cap.id);
    assert.ok(!recommendFor({capabilities:[ready],machine:{gpu:null,ram:{totalGb:32}}}).picks.some(p=>p.id===cap.id));
  }
});
