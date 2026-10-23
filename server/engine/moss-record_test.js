/** Exact optional checkpoint identity; no filename heuristics, engine, shelf or media reads. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildRecord, modelKeyFromFiles } from "./record.js";
import { CATALOG, MODEL_TO_CAPABILITY, isPictureModel } from "../models.js";
import { mossImageGraph, MOSS_IMAGE_FILES } from "../moss-image.js";
import { MOSS_KROMOSS_MODEL, MOSS_DMD2_ADAPTER, MOSS_HIRES_ADAPTER } from "../moss-presets.js";

test("the optional Kromoss row declares the existing canonical family without becoming an automatic engine",()=>{
  const cap=CATALOG.find(row=>row.id===MOSS_KROMOSS_MODEL.catalogueId);
  assert.equal(cap.model,"moss-image");assert.equal(MODEL_TO_CAPABILITY[cap.model],"moss-image");
  assert.equal(cap.addonFor,"moss-image");assert.equal(isPictureModel(cap),false);
  assert.equal(cap.files.length,1);assert.equal(cap.files[0].sha256,MOSS_KROMOSS_MODEL.sha256);
});

test("native SFT, Kromoss and Kromoss DMD2 graphs record their MOSS family from the exact diffusion file",()=>{
  for(const mossPreset of ["standard","kromoss-standard","kromoss-dmd2-8","moss-hires-v03"]) {
    const graph=mossImageGraph({prompt:"Literal record fixture",seed:19,mossPreset});
    const record=buildRecord(graph,{runId:"fixture"});
    assert.equal(record.model,"moss-image",mossPreset);
    assert.equal(record.engineFiles.find(file=>file.input==="unet_name").file,graph[1].inputs.unet_name);
    assert.equal(record.prompt,"Literal record fixture");
  }
  assert.equal(modelKeyFromFiles([{file:"models\\diffusion_models\\KROMOSS_INT8_CONVROT.SAFETENSORS"}]),"moss-image");
});

test("MOSS encoder types, companions, adapters and lookalike checkpoint names do not establish a model",()=>{
  const companions={
    "2":{class_type:"CLIPLoader",inputs:{clip_name:MOSS_IMAGE_FILES.encoder,type:"moss_image"}},
    "3":{class_type:"VAELoader",inputs:{vae_name:MOSS_IMAGE_FILES.vae}},
    "6":{class_type:"LoraLoaderModelOnly",inputs:{lora_name:MOSS_DMD2_ADAPTER.filename,strength_model:1}},
  };
  assert.equal(buildRecord(companions).model,null);
  assert.equal(modelKeyFromFiles([{file:MOSS_DMD2_ADAPTER.filename},{file:MOSS_HIRES_ADAPTER.filename}]),null);
  for(const name of ["mine_kromoss.safetensors","kromoss_int8_convrot_v2.safetensors","kromoss_int8_convrot.safetensors.bak"]) {
    const graph={...companions,"1":{class_type:"UNETLoader",inputs:{unet_name:name}}};
    assert.equal(buildRecord(graph).model,null,name);
  }
});

test("a second known diffusion family remains ambiguous and LoRA names cannot override the real base",()=>{
  const flux=CATALOG.find(row=>row.id===MODEL_TO_CAPABILITY.flux2).files.find(file=>/[/\\](diffusion_models|unet)[/\\]/.test(file.dest));
  assert.ok(flux);
  const graph=mossImageGraph({prompt:"fixture",mossPreset:"kromoss-standard"});
  graph.other={class_type:"UNETLoader",inputs:{unet_name:path.basename(flux.dest)}};
  assert.equal(buildRecord(graph).model,null);
  delete graph.other;
  graph.adapter={class_type:"LoraLoaderModelOnly",inputs:{model:["1",0],lora_name:path.basename(flux.dest),strength_model:1}};
  assert.equal(buildRecord(graph).model,"moss-image");
});
