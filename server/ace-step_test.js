/** ACE-Step 1.5 through ComfyUI: the catalogue row, the graph (text, cover,
 *  LoRA, per-model defaults), tempo/key/meter from the style line, LoRA
 *  recognition, the job and route wiring, the Music tab and MCP. No engine,
 *  no network, no render. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from 'node:child_process';
import { modelLeaf, findShelfModel } from "./localmodels.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "aiplay-ace-test-"));
process.env.AIPLAY_APPDATA = tmp;
process.env.AIPLAY_RIG = path.join(tmp, "rig");
process.env.AIPLAY_OUTPUT = path.join(tmp, "out");
const { CATALOG, MODEL_TO_CAPABILITY } = await import("./models.js");
const { config } = await import("./config.js");
const { buildAceStep15Graph, aceMeta, ACE_DEFAULTS } = await import("./workflow.js");
const { loraTarget, loraFits } = await import("./detect.js");
const { buildRecord } = await import('./engine/record.js');
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the catalogue row: ComfyUI's split files at a pinned revision, MIT, output unrestricted", () => {
  const row = CATALOG.find((c) => c.id === "musicAceStep15");
  assert.ok(row, "catalogued");
  assert.equal(MODEL_TO_CAPABILITY["ace-step15"], "musicAceStep15", "songs it makes are stamped with this row's rights");
  assert.equal(config.music.engines["ace-step15"].capability, "musicAceStep15");
  const names = row.files.map((f) => path.basename(f.dest));
  assert.deepEqual(names, ["acestep_v1.5_turbo.safetensors", "ace_1.5_vae.safetensors", "qwen_0.6b_ace15.safetensors", "qwen_4b_ace15.safetensors"]);
  for (const f of row.files) {
    assert.match(f.url, /Comfy-Org\/ace_step_1\.5_ComfyUI_files\/resolve\/6707deb277e9e0907fd9c14ce6b6f1d695c6a3fc\//, "reviewed manifest revision, not main");
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.bytes > 1e8);
  }
  assert.deepEqual(row.files[3].alt, ["qwen_1.7b_ace15.safetensors"], "the lighter planner counts");
  assert.equal(row.outputRights.class, "unrestricted");
  assert.match(row.licence, /^MIT/);
  assert.match(row.outputRights.url, /github\.com\/ace-step\/ACE-Step-1\.5\/blob\/main\/LICENSE/);
});

test("the graph is ComfyUI's ACE-Step 1.5 template, with its sampler for each model", () => {
  const g = buildAceStep15Graph({ caption: "synthwave", lyrics: "[Verse]\nhi", dit: "acestep_v1.5_turbo.safetensors",
    lm: "qwen_4b_ace15.safetensors", duration: 90, bpm: 100, keyscale: "E minor", timesignature: "4", seed: 7 });
  const types = Object.fromEntries(Object.entries(g).map(([k, n]) => [k, n.class_type]));
  assert.equal(types[3], "DualCLIPLoader"); assert.equal(g[3].inputs.type, "ace");
  assert.equal(g[3].inputs.clip_name1, "qwen_0.6b_ace15.safetensors");
  assert.equal(types[4], "TextEncodeAceStepAudio1.5");
  assert.equal(types[10], "EmptyAceStep1.5LatentAudio"); assert.equal(g[10].inputs.seconds, 90);
  assert.equal(g[11].inputs.shift, 3);
  assert.deepEqual([g[7].inputs.steps, g[7].inputs.cfg, g[7].inputs.sampler_name, g[7].inputs.scheduler], [8, 1, "euler", "simple"]);
  assert.equal(g[4].inputs.generate_audio_codes, true);
  assert.ok(!g[2] && !g[5] && !g[13], "no LoRA, no cover");
  assert.equal(g[8].class_type, "VAEDecodeAudio"); assert.match(g[9].class_type, /^SaveAudio/);
  const sft = buildAceStep15Graph({ dit: "acestep_v1.5_xl_sft_bf16.safetensors", lm: "x" });
  assert.deepEqual([sft[7].inputs.steps, sft[7].inputs.cfg], [ACE_DEFAULTS.sft.steps, ACE_DEFAULTS.sft.cfg]);
  assert.deepEqual([ACE_DEFAULTS.base.steps, ACE_DEFAULTS.base.cfg], [50, 6], "XL base template");
});

test("a cover encodes the song and sets it as the reference, with the planner off", () => {
  const g = buildAceStep15Graph({ caption: "c", dit: "acestep_v1.5_turbo.safetensors", lm: "x", cover: "aiplay_refaud_0123456789ab.wav", codes: true });
  assert.equal(g[13].class_type, "LoadAudio");
  assert.equal(g[14].class_type, "VAEEncodeAudio"); assert.deepEqual(g[14].inputs.vae, ["12", 0]);
  assert.equal(g[5].class_type, "ReferenceTimbreAudio");
  assert.deepEqual(g[7].inputs.positive, ["5", 0]);
  assert.equal(g[4].inputs.generate_audio_codes, false, "ComfyUI's tooltip: off when giving an audio reference");
  const lora = buildAceStep15Graph({ dit: "d", lm: "x", lora: "mine.safetensors", loraStrength: 0.8 });
  assert.equal(lora[2].class_type, "LoraLoaderModelOnly"); assert.deepEqual(lora[11].inputs.model, ["2", 0]);
});

test("tempo, key and meter: asked for, else read from the style, else a stated default", () => {
  assert.deepEqual(aceMeta({ caption: "dark synthwave, 92 BPM, F# minor, 3/4", seed: 1 }).from, { bpm: "style", key: "style", meter: "style" });
  const m = aceMeta({ caption: "dark synthwave, 92 BPM, F# minor, 3/4" });
  assert.deepEqual([m.bpm, m.keyscale, m.timesignature], [92, "F# minor", "3"]);
  const d = aceMeta({ caption: "lofi, minor key", seed: 3 });
  assert.equal(d.bpm, 120); assert.match(d.keyscale, / minor$/); assert.equal(d.timesignature, "4");
  assert.equal(aceMeta({ caption: "x", seed: 3 }).keyscale, aceMeta({ caption: "x", seed: 3 }).keyscale, "a re-roll keeps the key");
  assert.deepEqual([aceMeta({ bpm: 140, keyscale: "A minor", timesignature: "6" }).bpm, aceMeta({ keyscale: "A minor" }).keyscale], [140, "A minor"]);
});

test("ACE-Step 1.5 LoRAs are recognised, and one ComfyUI cannot load is named", () => {
  const ok = loraTarget(["base_model.model.layers.0.cross_attn.k_proj.lora_A.weight", "base_model.model.layers.0.self_attn.q_proj.lora_B.weight"]);
  assert.equal(ok.variant, "ACE-Step 1.5");
  assert.equal(loraFits(ok.variant, "ACE-Step 1.5").fit, "yes");
  const nested = loraTarget(["base_model.model.base_model.model.layers.0.cross_attn.k_proj.lora_A.weight"]);
  assert.match(nested.variant, /cannot load/);
  assert.equal(loraFits(nested.variant, "ACE-Step 1.5").fit, "no", "listed disabled, never silently skipped");
  assert.equal(loraTarget(["model.layers.0.qkv_proj.lora_A.weight"]).variant, "YuE2", "YuE2's rule is untouched");
});

test("the ACE shelf discovers nested split files and retains a moved planner selection", async () => {
  const index = src("./index.js");
  const start = index.indexOf("const ACE_DIT ="), end = index.indexOf("async function musicModelChoices", start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const readShelf = new AsyncFunction("scanBases", "modelBases", "modelLeaf", "findShelfModel", "config",
    index.slice(start, end) + "return aceShelf();");
  const files = [
    ["diffusion_models", path.join("ace", "acestep_v1.5_turbo.safetensors")],
    ["vae", path.join("ace", "ace_1.5_vae.safetensors")],
    ["text_encoders", path.join("ace", "qwen_0.6b_ace15.safetensors")],
    ["text_encoders", path.join("ace", "qwen_4b_ace15.safetensors")],
    ["text_encoders", path.join("ace", "qwen_1.7b_ace15.safetensors")],
  ].map(([folder, name]) => ({ folder, name, full: path.join(tmp, folder, name) }));
  const result = await readShelf(async () => files, async () => [tmp], modelLeaf, findShelfModel,
    { music: { aceLm: "qwen_1.7b_ace15.safetensors" } });
  assert.equal(result.ready, true);
  assert.deepEqual(result.dits, [path.join("ace", "acestep_v1.5_turbo.safetensors")]);
  assert.equal(result.lm, path.join("ace", "qwen_1.7b_ace15.safetensors"), "saved 1.7B preference survives moving into a subfolder");
  for (const [folder, leaf, key] of [["vae", "ace_1.5_vae.safetensors", "vae"], ["text_encoders", "qwen_0.6b_ace15.safetensors", "enc"]]) {
    const duplicate = { folder, name: path.join("another", leaf), full: path.join(tmp, folder, "another", leaf) };
    const unavailable = await readShelf(async () => [...files, duplicate], async () => [tmp], modelLeaf, findShelfModel,
      { music: { aceLm: "qwen_1.7b_ace15.safetensors" } });
    assert.equal(unavailable.ready, false, "ambiguous companion disables ACE readiness instead of failing the entire status request");
    assert.equal(unavailable[key], false);
    assert.ok(unavailable.missing);
    assert.equal(unavailable.lm, result.lm, "other unambiguous parts remain available");
  }
});

test("the runner, the route and the API switch", () => {
  const jobs = src("./jobs.js"), index = src("./index.js");
  assert.match(jobs, /value === "ace-step15"/);
  assert.match(jobs, /job\.engine === "ace-step15" \? buildAceStep15Graph\(/);
  assert.match(jobs, /if \(config\.api\?\.enabled && \(!job\.engine \|\| job\.engine === "minimax-music3"\)\) return this\.#runApi\(job\);/,
    "only MiniMax has a hosted twin; ACE-Step and YuE2-through-ComfyUI render locally with API mode on");
  assert.match(index, /const ACE_DIT = \/\^acestep/);
  assert.match(index, /reason: "weights-missing", needsModel: musicCapabilityFor\("ace-step15", config\.music\.aceModel\)/);
  const input = src('./music/ace-comfy-input.js');
  assert.match(index, /aceJob = prepared.job/);
  assert.match(input, /aceCodes: cover \? false : body\.aceCodes === undefined \? !lora : !!body\.aceCodes/,
    'the shared request adapter preserves LoRA/cover planner semantics');
  assert.match(input, /profile\?\.id === 'ace15-xl-sft' \? '' : '\[Instrumental\]'/,
    'only XL-SFT adopts its accepted empty instrumental lyrics; standard ACE keeps its convention');
  assert.match(index, /if \(ck && ACE_DIT\.test\(modelLeaf\(ck\.name\)\)\) against = \{ variant: "ACE-Step 1\.5"/);
  assert.match(index, /const modelName = isAce \? "ace-step15"/, "filed under the name the rights map knows");
});

test("the Music tab panel and MCP", () => {
  const html = src("../web/index.html"), app = src("../web/app.js"), mcp = src("./mcp.js");
  for (const id of ["aceOpts", "aBpm", "aKey", "aMeter", "aLang", "aSteps", "aCfg", "aCodes", "aPlanTemp", "aLm", "aLora", "aLoraStrength", "aCoverSong", "aCoverFile"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<details class="adv sbox" data-engine="ace" hidden id="aceOpts">/);
  assert.match(app, /lyrics: instrumental \? \(aceEngine\(\) \? \(state\.musicAceModel\?\.includes\("xl_sft"\)/);
  assert.match(app, /\.\.\.\(state\.musicEngine === "ace-step15" \? aceSpec\(\) : \{\}\)/);
  assert.match(mcp, /"yue2-gguf", "ace-step15"\]/);
  for (const k of ["language", "ace_steps", "ace_cfg", "planner", "cover_song"]) assert.match(mcp, new RegExp(`${k}: \\{ type:`), k);
});

const { ACE_VARIANTS, MODEL_BUNDLES, ACE_TEMPLATE_REVISION } = await import('../shared/model-bundles.js');
const { validModelSelection, defaultModelSelection, selectedAceDit } = await import('../shared/model-profiles.js');
const { setupPlan, selectionFor, rankSetupGpus, profileGraph, selectedModelReadiness, localModelReadiness } = await import('./setup-plan.js');
const { PREF_PATHS, prefsSnapshot } = await import('./config.js');

test('saved XL selection drives the existing music default and compatibility row instead of standard Turbo', async () => {
  const { musicDefault } = await import('./music-default.js');
  const { musicCapabilityFor } = await import('./models.js');
  const { recommendFor } = await import('./fit.js');
  const dit='acestep_v1.5_xl_sft_bf16.safetensors';
  const choices=[{engine:'ace-step15',dit:'acestep_v1.5_turbo.safetensors',available:true,label:'Turbo'}, {engine:'ace-step15',dit,available:false,label:'XL-SFT'}];
  let result=musicDefault({saved:{engine:'ace-step15',dit},choices});assert.equal(result.ready,false);assert.equal(result.label,'XL-SFT');
  choices[1].available=true;result=musicDefault({saved:{engine:'ace-step15',dit},choices});assert.equal(result.ready,true);assert.equal(result.label,'XL-SFT');
  assert.equal(musicCapabilityFor('ace-step15',dit),'musicAceStep15XlSft');
  const previous=config.music.aceModel;config.music.aceModel=dit;
  try {
    const capabilities=CATALOG.map(c=>({...c,totalBytes:c.files.reduce((n,f)=>n+f.bytes,0),files:c.files.map(f=>({...f,present:false})),ready:false}));
    const rec=recommendFor({capabilities,machine:{gpu:{name:'Fixture',vendor:'nvidia',vramGb:8},ram:{totalGb:32}},disk:{freeBytes:1e12},music:{value:'ace-step15',chosenBy:'you'}});
    const pick=rec.picks.find(p=>p.slot==='music');assert.equal(pick.id,'musicAceStep15XlSft');assert.equal(pick.fit.state,'unknown');
  } finally {config.music.aceModel=previous;}
});

test('the existing gated local LTX helper pins the shared revision and verifies bytes before replacing a model', () => {
  const program = `import runpy, sys, types, hashlib, os
from pathlib import Path
n=runpy.run_path('scripts/fetch_ltx25.py',run_name='fixture')
assert n['REVISION']=='49b093a39c19169a8a81721dcc541e07e945232f'
root=Path(os.environ['AIPLAY_COMFY']); root.mkdir(parents=True,exist_ok=True)
p=root/'synthetic.bin'; p.write_bytes(b'fixture')
assert n['checked_file'](p,7,hashlib.sha256(b'fixture').hexdigest())
assert not n['checked_file'](p,7,'0'*64)
assert not n['checked_file'](p,8,hashlib.sha256(b'fixture').hexdigest())
fn=n['main']; g=fn.__globals__; rel='vae/fixture.safetensors'; g['FILES']=[(rel,'vae',7)]
def info(repo,revision,files_metadata):
 assert revision==n['REVISION'] and files_metadata
 return types.SimpleNamespace(siblings=[types.SimpleNamespace(rfilename=rel,lfs=types.SimpleNamespace(sha256=hashlib.sha256(b'fixture').hexdigest()))])
def download(repo,path,revision,local_dir):
 assert path==rel and revision==n['REVISION']
 return str(p)
sys.modules['huggingface_hub']=types.SimpleNamespace(get_token=lambda:'fixture-only',HfApi=lambda:types.SimpleNamespace(model_info=info),hf_hub_download=download)
assert fn()==0
assert (root/'models/vae/fixture.safetensors').read_bytes()==b'fixture'
`;
  execFileSync(process.env.AIPLAY_PYTHON || 'python', ['-c',program], {cwd:path.resolve(import.meta.dirname,'..'), env:{...process.env,AIPLAY_COMFY:path.join(tmp,'ltx-fixture')},encoding:'utf8'});
});

test('each XL profile is an independent pinned DiT and the official ComfyUI companion/settings combination', () => {
  assert.match(ACE_TEMPLATE_REVISION, /^[a-f0-9]{40}$/);
  const expected = {
    'ace15-xl-sft': [9974719930, '3c05ae268353b3540fb1fd7db4fd77ffbda9802ec641b624e15648e030ecf3ce', 50, 7],
    'ace15-xl-turbo': [9974719892, '86a1afb0a1f711f0e3304ff65d874df3ae6783db683dcf982513fb9b6d14ae71', 8, 1],
    'ace15-xl-base': [9974719930, '56bf816fc9a69a5f45635e867b2ad742e1e648eb51fadb7d124cb8332d2e0940', 50, 6],
  };
  for (const [id, [bytes, sha, steps, cfg]] of Object.entries(expected)) {
    const v = ACE_VARIANTS.find(v => v.id === id), bundle = MODEL_BUNDLES[id];
    assert.equal(bundle.files[0].bytes, bytes); assert.equal(bundle.files[0].sha256, sha);
    assert.match(v.dit, /_xl_.*_bf16\.safetensors$/);
    assert.equal(bundle.files.length, 4); assert.equal(bundle.totalBytes, bundle.files.reduce((n, f) => n + f.bytes, 0));
    assert.deepEqual(bundle.files.slice(1).map(f => f.sha256), MODEL_BUNDLES['ace15-turbo'].files.slice(1).map(f => f.sha256));
    const row = CATALOG.find(c => c.id === v.capability);
    assert.deepEqual(row.files.map(f => f.sha256), bundle.files.map(f => f.sha256));
    assert.equal(row.requires.experimental, true, 'native-backend minima never masquerade as ComfyUI BF16 acceptance');
    const p = setupPlan({ selection: { music: id }, target: 'local' }).profiles[0];
    const graph = profileGraph(p), sampler = Object.values(graph).find(n => n.class_type === 'KSampler');
    assert.deepEqual(buildRecord(graph, { actor: 'system', via: 'setup.check' }).engineFiles.map(f => f.file).sort(), bundle.files.map(f => f.relative.split('/').pop()).sort(), 'receipts capture both DualCLIP encoders and every selected artifact');
    assert.deepEqual([sampler.inputs.steps, sampler.inputs.cfg], [steps, cfg]);
    assert.equal(Object.values(graph).find(n => n.class_type === 'ModelSamplingAuraFlow').inputs.shift, 3);
    assert.equal(Object.values(graph).find(n => n.class_type === 'DualCLIPLoader').inputs.clip_name2, 'qwen_4b_ace15.safetensors');
    assert.equal(p.experimental, true);
  }
  assert.notEqual(MODEL_BUNDLES['ace15-turbo'].files[0].sha256, MODEL_BUNDLES['ace15-xl-turbo'].files[0].sha256);
});

test('category combinations and independent targets persist without rewriting generation defaults', () => {
  assert.equal(selectedAceDit(['acestep_v1.5_turbo.safetensors'],'acestep_v1.5_xl_sft_bf16.safetensors'),null,'an unavailable selected XL never silently becomes standard Turbo');
  assert.equal(selectedAceDit(['acestep_v1.5_xl_sft_bf16.safetensors'],null),'acestep_v1.5_xl_sft_bf16.safetensors');
  for (const v of [{music:'ace15-xl-sft'}, {pictures:'sdxl-turbo',video:'ltx25'}, {music:'yue2-comfy',pictures:'sdxl-turbo',video:'ltx25'}]) assert.equal(validModelSelection(v), true);
  for (const v of [null, {}, [], {music:'ltx25'}, {unknown:'sdxl-turbo'}, {music:'unverified-url'}, {music:['ace15-turbo']}]) assert.equal(validModelSelection(v), false);
  assert.deepEqual(defaultModelSelection('music', {engine:'ace-step15',aceModel:'acestep_v1.5_xl_sft_bf16.safetensors'}), {music:'ace15-xl-sft'});
  assert.deepEqual(selectionFor({cloudSetup:{goal:'pictures'}},'runpod'), {pictures:'sdxl-turbo'});
  const old = {cloud:config.cloudSetup.plan,local:config.modelSetup.local,music:config.music.engine};
  try {
    config.cloudSetup.plan={music:'ace15-xl-sft',pictures:'sdxl-turbo'}; config.modelSetup.local={video:'ltx25'};
    for (const [group,key] of [['cloudSetup','plan'],['modelSetup','local']]) assert.equal(PREF_PATHS.find(([g,k])=>g===group&&k===key)[2](config[group][key]),true);
    const saved = prefsSnapshot(); assert.deepEqual(saved.cloudSetup.plan,config.cloudSetup.plan); assert.deepEqual(saved.modelSetup.local,config.modelSetup.local);
    assert.equal(config.music.engine,old.music); assert.deepEqual(selectionFor(config,'local'),{video:'ltx25'});
  } finally {config.cloudSetup.plan=old.cloud;config.modelSetup.local=old.local;}
});

test('planning reuses fitFor and maximum sequential requirements; unknown XL never gets an invented GPU guarantee', () => {
  const plan = setupPlan({selection:{music:'yue2-comfy',pictures:'sdxl-turbo',video:'ltx25'},target:'runpod'});
  assert.equal(plan.hardware.vramMinGb,16); assert.equal(plan.hardware.vramRecGb,16);
  assert.equal(plan.storage.modelBytes,3960938800+6938081905+39689918812);
  assert.equal(plan.storage.minimumGB,Math.ceil(plan.storage.modelBytes/1e9+20));
  assert.equal(new Set(plan.files.map(f=>f.relative)).size,plan.files.length);
  const gpu=(id,memoryInGb,pricePerHr,stock='High')=>({id:'NVIDIA '+id,name:id,memoryInGb,pricePerHr,stock});
  const inventory=[gpu('8',8,.1),gpu('16',16,.3),gpu('24',24,.4),gpu('48',48,.6),gpu('80',80,2,'None'),gpu('bad',undefined,.01),{id:'AMD',memoryInGb:128,pricePerHr:.01,stock:'High'}];
  const ranks=rankSetupGpus(plan,inventory); assert.equal(ranks.budget,'NVIDIA 16');assert.equal(ranks.recommended,'NVIDIA 16');assert.equal(ranks.performance,'NVIDIA 48');assert.equal(ranks.provisional,true);
  const xl=setupPlan({selection:{music:'ace15-xl-sft'},target:'runpod'});
  assert.equal(xl.hardware.unknown,true); assert.equal(xl.hardware.vramMinGb,null); assert.equal(rankSetupGpus(xl,inventory).recommended,null);
  const cpu=setupPlan({selection:{music:'ace15-xl-sft'},target:'local',machine:{gpu:null,ram:{totalGb:32}}}); assert.equal(cpu.profiles[0].fit.state,'unknown');
  const spec=MODEL_BUNDLES['yue2-comfy'].files[0];
  assert.equal(setupPlan({selection:{music:'yue2-comfy'},target:'local',localFiles:[{folder:'checkpoints',name:'yue2_3b_bf16.safetensors',bytes:spec.bytes}]}).profiles[0].localFilesPresent,false,'a legacy alternative does not claim the selected int8 variant');
  assert.equal(setupPlan({selection:{music:'yue2-comfy'},target:'local',localFiles:[{folder:'checkpoints',name:'yue2_3b_int8_convrot.safetensors',bytes:spec.bytes}]}).profiles[0].localFilesPresent,true);
});

test('selected readiness separates artifacts, runtime nodes, schema checks, previous inference and stopped state', () => {
  const plan=setupPlan({selection:{music:'ace15-xl-sft'},target:'runpod'}), p=plan.profiles[0], graph=profileGraph(p);
  const objects=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{input:{required:{}}}]));
  const bundle={id:p.id,state:'ready'}, input={connected:true,bundles:[bundle],objects};
  let r=selectedModelReadiness(plan,input)[0]; assert.equal(r.workflowValidated,true);assert.equal(r.filesVerified,true);assert.equal(r.inferenceValidated,false);
  assert.equal(selectedModelReadiness(plan,{...input,bundles:[]})[0].workflowValidated,false);
  assert.equal(selectedModelReadiness(plan,{...input,objects:{}})[0].dependenciesAvailable,false);
  const missingChoice=structuredClone(objects); missingChoice.UNETLoader.input.required.unet_name=[['another.safetensors']];
  assert.equal(selectedModelReadiness(plan,{...input,objects:missingChoice})[0].workflowValidated,false);
  r=selectedModelReadiness(plan,{...input,evidenceFor:()=>({at:123})})[0];assert.equal(r.inferenceValidated,true);
  r=selectedModelReadiness(plan,{...input,stopped:true,evidenceFor:()=>({at:123})})[0];assert.equal(r.workerConnected,false);assert.equal(r.workflowValidated,false);assert.equal(r.inferenceValidated,false);
  assert.equal(selectedModelReadiness(plan,{...input,verifiedFiles:false})[0].filesVerified,false,'local size presence never claims a checksum');
});

test('local inference acceptance reuses hashed engine receipts, current file facts and the exact runtime/workload', async () => {
  const bundle=MODEL_BUNDLES['ace15-xl-sft'];
  const localFiles=bundle.files.map(f=>({folder:f.relative.split('/')[0],name:f.relative.split('/')[1],bytes:f.bytes}));
  const plan=setupPlan({selection:{music:'ace15-xl-sft'},target:'local',localFiles}),graph=profileGraph(plan.profiles[0]);
  const objects=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{input:{required:{}}}]));
  const facts=bundle.files.map(f=>({file:f.relative.split('/').pop(),bytes:f.bytes,sha256:'sha256:'+f.sha256,mtimeMs:1,resolvedPath:'/fixture/'+f.relative}));
  let receipt={graph,request:{graphHash:'fixture',enginePort:'auto',engineVersion:'fixture-runtime',engineFiles:structuredClone(facts)},result:{status:'completed',outputs:[{sha256:'a'.repeat(64),bytes:1}]}};
  let changed=false,hashRequests=0;
  const engine={status:async()=>({version:'fixture-runtime'}),activity:async()=>({runs:[{runId:'fixture',t:'2026-10-18T00:00:00Z'}]}),runRecord:async()=>receipt,
    store:{resolveRecordFiles:async(record,{hashModels})=>{if(hashModels)hashRequests++;record.engineFiles=facts.map(f=>({...f,mtimeMs:changed?2:1,sha256:hashModels?f.sha256:null}));}}};
  const read=verify=>localModelReadiness(plan,{engine,connected:true,objects,verify});
  let result=(await read(false))[0];assert.equal(result.inferenceValidated,true);assert.equal(result.filesVerified,true);assert.equal(hashRequests,0,'opening the planner never starts a multi-GB checksum pass');
  changed=true;assert.equal((await read(false))[0].inferenceValidated,false);changed=false;
  const original=structuredClone(receipt);receipt.request.engineVersion='other';assert.equal((await read(false))[0].inferenceValidated,false);receipt=structuredClone(original);
  receipt.request.enginePort='remote';assert.equal((await read(false))[0].inferenceValidated,false);receipt=structuredClone(original);
  receipt.graph=null;assert.equal((await read(false))[0].inferenceValidated,false);receipt=structuredClone(original);
  receipt.request.engineFiles.forEach(f=>f.sha256=null);result=(await read(true))[0];assert.equal(result.filesVerified,true);assert.equal(result.inferenceValidated,false,'a current checksum never manufactures an old inference receipt');assert.equal(hashRequests,1);
});


// Hardware evidence stays in the existing profile/fit/readiness paths. This
// fixture is an immutable selection from the accepted archive, not a GPU mock
// pretending to measure inference.
const { createHash } = await import('node:crypto');
const { MODEL_PROFILES } = await import('../shared/model-profiles.js');
const { fitFor } = await import('./fit.js');
const { workflowEvidenceKey, curatedArtifactKey } = await import('./engine/workflow-evidence.js');
const acceptedSource = JSON.parse(readFileSync(new URL('../docs/evidence/ace15-xl-sft-a100-2026-10-20.json', import.meta.url), 'utf8'));
const acceptedProfile = MODEL_PROFILES.find(p => p.id === 'ace15-xl-sft');
const accepted = acceptedProfile.hardwareAcceptance;
const acceptedMachine = () => ({ gpu: { id: accepted.tested.gpuId, name: 'A100 SXM4', vendor: 'nvidia', count: 1, vramGb: 80 },
  ram: { totalGb: 117 }, vcpuCount: 24, cloud: 'SECURE', image: accepted.tested.image, runtime: { ...accepted.runtime } });
const acceptedContext = () => ({ target: 'runpod', graph: profileGraph(acceptedProfile) });

test('hardware acceptance binds the archived artifact, prepared/executed workflow and audio identities', () => {
  assert.equal(accepted.archiveSha256, acceptedSource.archive.sha256);
  assert.equal(acceptedSource.archive.manifest.files.length, 26);
  assert.equal(accepted.preparedGraphSha256, createHash('sha256').update(JSON.stringify(acceptedSource.workflow.graph)).digest('hex'));
  assert.equal(acceptedSource.workflow.sha256, accepted.preparedGraphSha256);
  const executed = structuredClone(acceptedSource.workflow.graph);
  for (const n of Object.values(executed)) if (typeof n.inputs.filename_prefix === 'string')
    n.inputs.filename_prefix = `aiplay_remote/${acceptedSource.completion.id}/${n.inputs.filename_prefix}`;
  assert.equal(createHash('sha256').update(JSON.stringify(executed)).digest('hex'), accepted.executedGraphSha256);
  assert.equal(acceptedSource.completion.executedGraphHash, accepted.executedGraphSha256);
  assert.equal(workflowEvidenceKey(acceptedSource.workflow.graph), accepted.workflowKey);
  assert.equal(workflowEvidenceKey(profileGraph(acceptedProfile)), accepted.workflowKey);
  assert.equal(curatedArtifactKey(acceptedSource.workflow.graph).key, accepted.artifactKey);
  assert.equal(curatedArtifactKey(profileGraph(acceptedProfile)).key, accepted.artifactKey);
  assert.deepEqual(acceptedSource.artifacts.files.map(({relative,bytes,sha256})=>({relative,bytes,sha256})),
    MODEL_BUNDLES['ace15-xl-sft'].files.map(({relative,bytes,sha256})=>({relative,bytes,sha256})));
  assert.ok(acceptedSource.artifacts.files.every(f=>f.verifiedEqual));
  assert.equal(accepted.output.sha256, acceptedSource.completion.outputs[0].sha256);
  assert.equal(accepted.output.sha256, acceptedSource.audio.sha256);
  assert.equal(accepted.output.humanReview, acceptedSource.audio.fullPlaybackListening.response);
  assert.equal(acceptedSource.finalProviderCheck.status, 'EXITED');
});

test('hardware measurements retain their scope and never become resource minima', () => {
  const m = acceptedSource.measurements, plan = setupPlan({ selection: { music: 'ace15-xl-sft' }, target: 'runpod' });
  assert.equal(accepted.observed.gpuUsedBytes, m.observedPeaks.gpu0UsedBytes);
  assert.equal(accepted.observed.comfyProcessRssBytes, m.observedPeaks.processRssBytes);
  assert.equal(accepted.observed.generationSeconds, m.remoteJobSeconds);
  assert.equal(accepted.observed.samplerNodeSeconds, m.groups['node:KSampler'].sumSeconds);
  assert.ok(Math.abs(accepted.observed.loaderNodeSeconds - ['node:VAELoader','node:DualCLIPLoader','node:UNETLoader'].reduce((n,k)=>n+m.groups[k].sumSeconds,0))<1e-9);
  assert.equal(accepted.observed.samples,m.samples); assert.equal(accepted.observed.sampleIntervalSeconds,m.sampleIntervalSeconds);
  assert.equal(accepted.runtime.workerCommit,acceptedSource.runtime.installCommit);
  assert.equal(accepted.runtime.comfyVersion,acceptedSource.runtime.version);
  assert.deepEqual({python:accepted.runtime.python,torch:accepted.runtime.torch,cudaRuntime:accepted.runtime.cudaRuntime},m.runtime);
  assert.equal(accepted.tested.allocatedRamGB,acceptedSource.allocation.gpu.memory);
  assert.equal(accepted.tested.vcpus,acceptedSource.allocation.gpu.vcpuCount);
  assert.equal(accepted.minimumRequirementsEstablished,false);
  assert.equal(accepted.observed.containerMemoryMeasured,false);assert.equal(accepted.observed.coldLoadingMeasured,false);
  for(const key of ['vramMinGb','vramRecGb','ramMinGb','ramRecGb'])assert.equal(plan.hardware[key],null);
  assert.equal(plan.profiles[0].requires.experimental,true);
});

test('existing fit validates only the exact RunPod A100 allocation, runtime and accepted workflow', () => {
  const req=CATALOG.find(c=>c.id==='musicAceStep15XlSft').requires;
  const check=(machine=acceptedMachine(),context=acceptedContext())=>fitFor(req,machine,context);
  assert.equal(check().state,'fits');assert.equal(check().hardwareValidation.state,'validated');
  assert.equal(check().needVramGb,null);assert.equal(check().needRamGb,null);
  assert.equal(check(acceptedMachine(),{}).state,'unknown','generic catalogue fit is not workload-scoped');
  for(const gpu of [
    {id:'NVIDIA RTX 4090',vramGb:24}, {id:'NVIDIA RTX 5090',vramGb:32}, {id:'NVIDIA A40',vramGb:48},
    {id:'NVIDIA A100 80GB PCIe',vramGb:80}, {id:'NVIDIA H100 80GB HBM3',vramGb:80},
    {id:accepted.tested.gpuId,vramGb:40}, {id:accepted.tested.gpuId,vramGb:80,count:2},
  ]) {
    const machine=acceptedMachine();Object.assign(machine.gpu,gpu);
    assert.equal(check(machine).state,'unknown');assert.equal(check(machine).hardwareValidation,undefined);
  }
  for(const vendor of ['amd','intel']){const machine=acceptedMachine();machine.gpu={name:vendor,vendor,vramGb:80};assert.equal(check(machine).state,'unknown');}
  const cpu=acceptedMachine();cpu.gpu=null;assert.equal(check(cpu).state,'unknown');
  assert.equal(check(acceptedMachine(),{...acceptedContext(),target:'local'}).state,'unknown');
  const community=acceptedMachine();community.cloud='COMMUNITY';assert.equal(check(community).state,'unknown');
  for(const change of [m=>m.ram.totalGb=64,m=>m.vcpuCount=8,m=>m.runtime.torch='other',m=>m.runtime.workerCommit='other',m=>m.runtime.comfyVersion='other',m=>m.image='other']){
    const machine=acceptedMachine();change(machine);assert.equal(check(machine).state,'unknown');assert.equal(check(machine).hardwareValidation.state,'candidate');
  }
});

test('changed workflow, duration, sampler, planner, lyrics or artifacts cannot inherit A100 acceptance', () => {
  const req=CATALOG.find(c=>c.id==='musicAceStep15XlSft').requires;
  for(const change of [g=>g['7'].inputs.steps=8,g=>g['7'].inputs.cfg=1,g=>g['7'].inputs.sampler_name='heun',
    g=>g['10'].inputs.seconds=60,g=>g['10'].inputs.batch_size=2,g=>g['4'].inputs.generate_audio_codes=false,
    g=>g['4'].inputs.lyrics='Untested vocal lyrics',g=>g['4'].inputs.temperature=1,g=>g['4'].inputs.tags='Untested different style',
    g=>g['3'].inputs.clip_name2='qwen_1.7b_ace15.safetensors',g=>g['1'].inputs.unet_name='other.safetensors',
    g=>g['12'].inputs.vae_name='other.safetensors',g=>g.extra={class_type:'LoraLoaderModelOnly',inputs:{lora_name:'other.safetensors'}},
    g=>g['9'].class_type='SaveAudioMP3']){
    const context=acceptedContext();change(context.graph);const result=fitFor(req,acceptedMachine(),context);
    assert.equal(result.state,'unknown');assert.equal(result.hardwareValidation,undefined);
  }
  for(const id of ['ace15-xl-turbo','ace15-xl-base','ace15-turbo']){
    const p=MODEL_PROFILES.find(p=>p.id===id);assert.equal(p.hardwareAcceptance,null);
    const plan=setupPlan({selection:{music:id},target:'runpod'});assert.equal(plan.profiles[0].hardwareAcceptance,null);
  }
});

test('existing ranking recommends only the available exact Secure-capable A100 reference for XL-SFT', () => {
  const plan=setupPlan({selection:{music:'ace15-xl-sft'},target:'runpod'});
  const gpu=(id,memoryInGb,pricePerHr,extra={})=>({id,name:id,memoryInGb,pricePerHr,secureCloud:true,stock:'High',...extra});
  const a100=gpu(accepted.tested.gpuId,80,1.79), others=[gpu('NVIDIA A40',48,.59),gpu('NVIDIA RTX 4090',24,.1),gpu('NVIDIA H100',80,1.5)];
  let ranks=rankSetupGpus(plan,[...others,a100]);assert.equal(ranks.recommended,a100.id);assert.equal(ranks.provisional,true);
  const row=ranks.gpus.find(g=>g.id===a100.id);assert.equal(row.gpuFit,'unknown');assert.equal(row.hardwareEvidenceCandidate,true);
  assert.equal(ranks.gpus.find(g=>g.id==='NVIDIA A40').hardwareEvidenceCandidate,false);
  for(const extra of [{stock:'None'},{stock:'Unknown'},{secureCloud:false},{pricePerHr:0},{pricePerHr:NaN}])
    assert.equal(rankSetupGpus(plan,[...others,{...a100,...extra}]).recommended,null);
  const mixed=setupPlan({selection:{music:'ace15-xl-sft',pictures:'sdxl-turbo'},target:'runpod'});
  assert.equal(rankSetupGpus(mixed,[a100]).recommended,a100.id);
  const untested=setupPlan({selection:{music:'ace15-xl-base',pictures:'sdxl-turbo'},target:'runpod'});
  assert.equal(rankSetupGpus(untested,[a100]).recommended,null);
});

test('historical A100 evidence cannot make a fresh, stopped or differently selected model ready', () => {
  const plan=setupPlan({selection:{music:'ace15-xl-sft'},target:'runpod'}),graph=profileGraph(plan.profiles[0]);
  const objects=Object.fromEntries(Object.values(graph).map(n=>[n.class_type,{input:{required:{}}}]));
  let queries=0;const evidenceFor=()=>{queries++;return {at:123};};
  for(const input of [{}, {connected:true,objects,bundles:[]}, {connected:true,objects,bundles:[{id:'ace15-xl-base',state:'ready'}]},
    {connected:true,objects:{},bundles:[{id:'ace15-xl-sft',state:'ready'}]},
    {connected:true,stopped:true,objects,bundles:[{id:'ace15-xl-sft',state:'ready'}]}]) {
    const row=selectedModelReadiness(plan,{...input,evidenceFor})[0];assert.equal(row.historicalHardwareValidated,true);
    assert.equal(row.workflowValidated,false);assert.equal(row.inferenceValidated,false);
  }
  assert.equal(queries,0,'historical evidence never bypasses current-file/runtime checks');
  const current={connected:true,objects,bundles:[{id:'ace15-xl-sft',state:'ready'}]};
  let row=selectedModelReadiness(plan,current)[0];assert.equal(row.filesVerified,true);assert.equal(row.workflowValidated,true);assert.equal(row.inferenceValidated,false);
  row=selectedModelReadiness(plan,{...current,evidenceFor})[0];assert.equal(row.inferenceValidated,true);assert.equal(queries,1);
  const base=setupPlan({selection:{music:'ace15-xl-base'},target:'runpod'});
  assert.equal(selectedModelReadiness(base,current)[0].historicalHardwareValidated,false);
});
