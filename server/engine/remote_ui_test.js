import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { imageWorkflowOptions, modelChoices, videoWorkflowOptions, prepareCloudSample } from "../../web/runpod-integrated.js";
import { remoteAceShelf, remoteYueCheckpoints } from './remote-models.js';
import { workflowEvidenceKey, curatedArtifactKey } from './workflow-evidence.js';
import { MODEL_BUNDLES } from '../../shared/model-bundles.js';

test('beginner management actions follow confirmed lifecycle state and selected-computer installation',()=>{
 const js=read('web','cloud-computer.js');
 const source=js.slice(js.indexOf('export function cloudManagementState'),js.indexOf('function chooseFlow')).replaceAll('export ','');
 const {cloudManagementState:view,currentFlowReply:reply,cloudReplyContext:context}=runInNewContext(source+'\n({cloudManagementState,currentFlowReply,cloudReplyContext})');
 const running={podId:'one',pod:{status:'RUNNING'},phase:'ready',worker:{connectionReady:true,workload:{known:true,busy:false}}};
 const cases=[
  [null,'empty',false,false],[{...running,providerUncertain:true},'uncertain',false,false],
  [{...running,pod:{status:'EXITED'}},'stopped',true,false],
  [{...running,pod:{status:'STARTING'}},'starting',false,false],
  [{...running,operation:{type:'start'}},'starting',false,false],
  [{...running,operation:{type:'stop'}},'stopping',false,false],
  [{...running,operation:{type:'stop',stage:'uncertain'}},'uncertain',false,false],
  [{...running,issue:{message:'Invalid account key'}},'failed',false,true],
  [{...running,worker:{connectionReady:false}},'offline',false,false],
  [{...running,worker:{connectionReady:true,workload:{known:false,busy:true}}},'failed',false,false],
  [{...running,worker:{connectionReady:true,workload:{known:true,busy:true}}},'generating',false,true],
  [running,'ready',false,true],
 ];
 for(const [s,state,start,stop] of cases){const v=view(s,{ready:true});assert.equal(v.state,state);assert.equal(v.canStart,start);assert.equal(v.canStop,stop);if(state==='stopped'||state==='uncertain')assert.equal(v.canGenerate,false);}
 for(const state of ['downloading','verifying','installing'])assert.equal(view(running,{bundles:[{state}]}).state,'installing');
 assert.equal(view({...running,podId:null},{ready:true}).canGenerate,false);
 assert.equal(view({...running,worker:{connectionReady:true}},{ready:true}).state,'activity_unknown','older workers must not look idle when work cannot be observed');
 assert.equal(view(running,{ready:true,installation:{stage:'failed'}}).state,'ready','a repaired live worker does not inherit a historical installer failure');
 assert.match(view({...running,pod:{status:'EXITED'}}).recovery,/storage continues billing/);
 assert.match(view({...running,providerUncertain:true}).recovery,/Shutdown is not confirmed/);
 const selection={music:'ace15-xl-sft',pictures:'sdxl-turbo'},data={podId:'one',selection};
 assert.equal(reply(running,'one',selection,data),true);
 for(const patch of [{podId:'two'},{pod:{status:'EXITED'}},{providerUncertain:true},{operation:{type:'stop'}},{worker:{connectionReady:false}},{worker:{connectionReady:true,pending:true}}])assert.equal(reply({...running,...patch},'one',selection,data),false);
 assert.equal(reply(running,'one',{music:'ace15-xl-turbo'},data),false);
 assert.notEqual(context(running),context({...running,pod:{status:'EXITED'}}));
 assert.notEqual(context(running),context({...running,pod:{status:'RUNNING',startedAt:'new-session'}}));
 assert.match(js,/epoch !== flowEpoch/);
 const html=read('web','index.html');assert.match(html,/id="cloudFlowWhereTab"/);assert.doesNotMatch(html,/id="cloudFlowReadyTab"/);
 for(const id of ['cloudReadyFinish','cloudReadyNow','cloudReadyCheck','cloudReadyStorageRates','cloudPlanReview'])assert.ok(html.includes(`id="${id}"`));
 assert.match(read('web','setup-plan.js'),/Changing this plan does not switch the running app/);
});

test('guided setup paints before account, computer and model data have loaded',()=>{
 const js=read('web','cloud-computer.js'),nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:'',children:[],classList:{toggle(){}},setAttribute(){},replaceChildren(){},append(){}});return nodes.get(id);};
 const helpers=js.slice(js.indexOf('export function cloudGoalReady'),js.indexOf('function chooseFlow')).replaceAll('export ','');
 const paint=js.slice(js.indexOf('function paintFlow('),js.indexOf('function paintSelectedReadiness'));
 runInNewContext(helpers+'\n'+paint+'\npaintFlow(null);',{$:node,actionError:'Availability could not be verified.',accountConfigured:false,accountBalance:null,flowModels:null,flowPage:null,planningTarget:'runpod',cloudGoal:'all',setupOverride:null,automaticInstall:null,working:false,getSetupPlan:()=>null,chip(){},money:()=> 'Unavailable',paintInstallation(){},document:{querySelectorAll:()=>[],createElement:()=>node('dynamic')}});
 assert.equal(node('cloudFlowGoal').hidden,false);assert.equal(node('cloudFlowGoalNext').disabled,true);assert.equal(node('cloudFlowReady').hidden,true);
 assert.equal(node('cloudFlowIssue').hidden,false);assert.match(node('cloudFlowIssue').textContent,/Availability/);
});

test('a failed review remains visible after read-only reconciliation repaints the computer',async()=>{
 const js=read('web','cloud-computer.js'),source=js.slice(js.indexOf('async function perform('),js.indexOf('async function init('));
 const result=await runInNewContext(source+'\n(async()=>{await perform("/review");return {actionError,working};})()',{
  working:false,activeAction:'',actionError:null,current:{version:1},$:()=>({}),paint(){},api:async action=>{if(action)throw Error('Availability could not be verified.');return {version:1};}
 });assert.equal(result.actionError,'Availability could not be verified.');assert.equal(result.working,false);
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), "utf8");

test('preflight moves only the existing stop-key form into its own advanced slot and keeps creation separately approved',()=>{
  const js=read('web','cloud-computer.js');
  assert.match(js,/target\.append\(keyForm\)/);
  assert.ok(!js.includes("$('cloudComputerKeyForm').closest('details')"),'mountSetup already moves this form out of its original details');
  assert.match(js,/Save test stop key/); assert.match(js,/Creation still needs approval/);
  assert.match(js,/\/api\/runpod\/install\/acceptance-key/);
  assert.ok(!js.includes('acceptanceConfirm:'),'saving a key must never create or authorize a paid test');
});

test('remote ACE/LM inventory is the worker schema, including COMBO descriptors; absent companions stay unavailable', () => {
  const info={UNETLoader:{input:{required:{unet_name:['COMBO',{options:['acestep_v1.5_xl_sft_bf16.safetensors','minimax.safetensors']}]}}},
    DualCLIPLoader:{input:{required:{clip_name1:[['qwen_0.6b_ace15.safetensors']],clip_name2:[['qwen_4b_ace15.safetensors','qwen_1.7b_ace15.safetensors']]}}},
    VAELoader:{input:{required:{vae_name:[['ace_1.5_vae.safetensors']]}}},
    CheckpointLoaderSimple:{input:{required:{ckpt_name:[['yue2_3b_int8_convrot.safetensors','image.safetensors']]}}}};
  const shelf=remoteAceShelf(info,'qwen_1.7b_ace15.safetensors');assert.deepEqual(shelf.dits,['acestep_v1.5_xl_sft_bf16.safetensors']);assert.equal(shelf.ready,true);assert.equal(shelf.lm,'qwen_1.7b_ace15.safetensors');
  assert.deepEqual(remoteYueCheckpoints(info),['yue2_3b_int8_convrot.safetensors']);
  assert.equal(remoteAceShelf({...info,VAELoader:null}).ready,false);
  assert.equal(remoteAceShelf(null).ready,false);assert.deepEqual(remoteAceShelf(null).dits,[]);
  assert.equal(remoteAceShelf({...info,DualCLIPLoader:{input:{required:{clip_name1:[['qwen_4b_ace15.safetensors']],clip_name2:[['qwen_0.6b_ace15.safetensors']]}}}}).ready,false);
});

test('inference evidence identifies model, companions, sampler and workload without retaining prompts', () => {
  const graph={'1':{class_type:'UNETLoader',inputs:{unet_name:'acestep_v1.5_xl_sft_bf16.safetensors'}},'2':{class_type:'KSampler',inputs:{model:['1',0],steps:50,cfg:7,seed:123,text:'private prompt'}}};
  const key=workflowEvidenceKey(graph);assert.match(key,/^[a-f0-9]{64}$/);
  const different=structuredClone(graph);different['2'].inputs.text='other prompt';different['2'].inputs.seed=99;assert.equal(workflowEvidenceKey(different),key);
  different['2'].inputs.cfg=1;assert.notEqual(workflowEvidenceKey(different),key);
  different['1'].inputs.unet_name='acestep_v1.5_turbo.safetensors';assert.notEqual(workflowEvidenceKey(different),key);
  const bundle=MODEL_BUNDLES['ace15-xl-sft'];
  const files=Object.fromEntries(bundle.files.map((f,i)=>[i,{class_type:'Loader',inputs:{file:f.relative.split('/').pop()}}]));
  assert.equal(curatedArtifactKey(files).id,'ace15-xl-sft');assert.match(curatedArtifactKey(files).key,/^[a-f0-9]{64}$/);
  files.extra={class_type:'LoraLoader',inputs:{lora_name:'unverified.safetensors'}};assert.equal(curatedArtifactKey(files),null,'unknown companions or add-ons do not inherit curated acceptance');
});

test('workflow evidence distinguishes rewiring between same-class instances and output slots', () => {
  const graph = {
    first: { class_type: 'Loader', inputs: { model_name: 'first.safetensors' } },
    second: { class_type: 'Loader', inputs: { model_name: 'second.safetensors' } },
    output: { class_type: 'Sampler', inputs: { model: ['first', 0], steps: 20 } },
  };
  const key = workflowEvidenceKey(graph), rewired = structuredClone(graph);
  rewired.output.inputs.model = ['second', 0];
  assert.notEqual(workflowEvidenceKey(rewired), key, 'the selected loader instance matters');
  rewired.output.inputs.model = ['first', 1];
  assert.notEqual(workflowEvidenceKey(rewired), key, 'the selected output slot matters');

  const shared = {
    first: { class_type: 'Value', inputs: { value: 1 } },
    second: { class_type: 'Value', inputs: { value: 1 } },
    output: { class_type: 'Combine', inputs: { left: ['first', 0], right: ['first', 0] } },
  };
  const split = structuredClone(shared);
  split.output.inputs.right = ['second', 0];
  assert.notEqual(workflowEvidenceKey(split), workflowEvidenceKey(shared), 'sharing and two identical instances are different topologies');
});

test('repeated-class evidence ignores private text and ordering but conservatively binds node IDs', () => {
  const graph = {
    first: { class_type: 'Loader', inputs: { model_name: 'first.safetensors' } },
    second: { class_type: 'Loader', inputs: { model_name: 'second.safetensors' } },
    output: { class_type: 'Sampler', inputs: { model: ['first', 0], steps: 20, text: 'private prompt', seed: 1 } },
  };
  const key = workflowEvidenceKey(graph), reordered = Object.fromEntries(Object.entries(graph).reverse().map(([id, node]) =>
    [id, { ...node, inputs: Object.fromEntries(Object.entries(node.inputs).reverse()) }]));
  reordered.output.inputs.text = 'another private prompt';
  reordered.output.inputs.seed = 99;
  assert.equal(workflowEvidenceKey(reordered), key);
  const renumbered = { ...graph, renamed: graph.first };
  delete renumbered.first;
  renumbered.output = { ...graph.output, inputs: { ...graph.output.inputs, model: ['renamed', 0] } };
  assert.notEqual(workflowEvidenceKey(renumbered), key, 'ambiguous node renumbering requires revalidation');
});

test('unique-class evidence preserves the accepted A100 key and node-renumbering stability', () => {
  const { workflow } = JSON.parse(read('docs', 'evidence', 'ace15-xl-sft-a100-2026-10-20.json'));
  const expected = 'a0e15341c36d6beefe4c4a2656e1cf4e9770b622f953404ad42ac2934de23c1e';
  assert.equal(workflowEvidenceKey(workflow.graph), expected);
  const names = new Map(Object.keys(workflow.graph).map((id, i) => [id, `node_${i}`]));
  const renamed = Object.fromEntries(Object.entries(workflow.graph).reverse().map(([id, node]) => [names.get(id), {
    ...node, inputs: Object.fromEntries(Object.entries(node.inputs).reverse().map(([key, value]) =>
      [key, Array.isArray(value) ? [names.get(String(value[0])), value[1]] : value])),
  }]));
  assert.equal(workflowEvidenceKey(renamed), expected);
});

test('a changed selection cannot inherit another model’s ready flags', () => {
  const js=read('web','cloud-computer.js'),source=js.slice(js.indexOf('export function cloudGoalReady'),js.indexOf('function chooseFlow')).replaceAll('export ','');
  const ready=runInNewContext(source+'\ncloudGoalReady;');
 const s={podId:'one',pod:{status:'RUNNING'},worker:{connectionReady:true,generationReady:true}};
  const bundles=[{id:'ace15-xl-sft',state:'ready'},{id:'ace15-turbo',state:'ready'}];
  assert.equal(ready(s,{music:'ace15-xl-sft'},bundles,[{id:'ace15-turbo',workflowValidated:true}]),false);
  assert.equal(ready(s,{music:'ace15-xl-sft'},bundles,[{id:'ace15-xl-sft',workflowValidated:true,inferenceValidated:false}]),true,'workflow readiness enables a test, not an inference acceptance claim');
  assert.equal(ready(s,{},bundles,[]),false);
  const planner=read('web','setup-plan.js');assert.match(planner,/\/api\/setup-plan/);assert.doesNotMatch(planner,/\/api\/runpod\/account\/pods|AIPLAY_REMOTE_ONLY/);
});

test('installation paints before the first provider response without dereferencing an empty model snapshot', () => {
  const js=read('web','cloud-computer.js');
  const source=js.slice(js.indexOf('export function cloudGoalReady'),js.indexOf('export function cloudFlowPage')).replaceAll('export ','');
  const nodes=new Map(),element=()=>({children:Array.from({length:5},()=>({dataset:{},setAttribute(){},removeAttribute(){}})),setAttribute(){}});
  const context={flowModels:null,automaticInstall:null,cloudGoal:'all',working:false,chip(){},$:id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);}};
  runInNewContext(source+'\npaintInstallation(null, []);',context);
  assert.equal(nodes.get('cloudInstallProgress').value,0);assert.equal(nodes.get('cloudInstallStop').disabled,true);
});

test('beginner readiness requires every selected model and a verified running worker', () => {
  const js = read('web', 'cloud-computer.js');
  const source = js.slice(js.indexOf('export function cloudGoalReady'), js.indexOf('function chooseFlow')).replaceAll('export ', '');
  const { cloudGoalReady: ready, cloudFlowPage: page } = runInNewContext(source + '\n({cloudGoalReady, cloudFlowPage})');
  const state = { podId: 'one', pod: { status: 'RUNNING' }, worker: { connectionReady: true, generationReady: true } };
  const image = [{ id: 'sdxl-turbo', state: 'ready' }];
  assert.equal(ready(state, 'pictures', image), true);
  assert.equal(ready(state, 'all', image), false);
  assert.equal(ready(state, 'video', image), false);
  const all = [...image, { id: 'yue2-comfy', state: 'ready' }, { id: 'ltx25', state: 'ready' }];
  assert.equal(ready(state, 'all', all), true);
  for (const s of [{ ...state, providerUncertain: true }, { ...state, operation: { type: 'stop' } },
    { ...state, pod: { status: 'EXITED' } }, { ...state, worker: { ...state.worker, frozen: true } },
    { ...state, worker: { ...state.worker, generationReady: false } }]) assert.equal(ready(s, 'all', all), false);
  assert.equal(page(null, false, false, 'ready'), 'goal');
  assert.equal(page(state, false, true, 'ready'), 'goal');
  assert.equal(page({}, true, false, 'install'), 'costs');
  assert.equal(page(state, true, false, null), 'install');
  assert.equal(page(state, true, true, null), 'ready');
  assert.equal(page(state, true, true, 'costs'), 'costs');
});

test('sample fills existing inputs and navigates without submitting a generation', () => {
  for (const goal of ['pictures', 'music', 'video', 'all']) {
    const inputs = new Map(), navigation = [];
    const doc = { getElementById: id => {
      if (!inputs.has(id)) inputs.set(id, { value: '', options: [], dispatchEvent() {}, focus() {} });
      return inputs.get(id);
    }, querySelector: selector => ({ click: () => navigation.push(selector) }) };
    const result = prepareCloudSample(goal, doc);
    assert.equal(navigation.length, 1);
    assert.match(navigation[0], /\.rail \[data-view=/);
    assert.equal(result, goal === 'all' ? 'pictures' : goal);
    assert.equal([...inputs.keys()].some(id => /make|generate|submit/i.test(id)), false);
    if (result === 'pictures') { assert.equal(inputs.get('imgW').value, '512'); assert.equal(inputs.get('imgCount').value, '1'); }
  }
});

test("the Images and Video screens carry the RunPod controls (shown in RunPod GPU mode only)", () => {
  const html = read("web", "index.html");
  assert.match(html, /id="imgRenderWhere"[\s\S]*value="local"[\s\S]*value="runpod"/);
  assert.match(html, /id="vidRenderWhere"[\s\S]*value="local"[\s\S]*value="runpod"/);
  assert.match(html, /id="runpodWorkerToken"[^>]*type="password"/);
  assert.match(html, /id="runpodApiKey"[^>]*type="password"/);
  assert.match(html, /id="runpodAccountDisconnect"/);
  assert.match(html, /id="runpodReviewPod"/);
  assert.match(html, /id="runpodCostConfirm"[^>]*type="checkbox"/);
  assert.match(html, /id="runpodCreatePod"[^>]*disabled/);
  assert.match(html, /id="runpodCreateTemplates"/);
  assert.match(html, /id="runpodTemplateState"/);
  assert.match(html, /id="runpodBootstrapCommand"[^>]*readonly/);
  assert.match(html, /id="runpodModelList"/);
  assert.match(html, /id="runpodCancelModel"/);
  assert.match(html, /id="imgRunPodCfg"[^>]*value="6"/);
  assert.match(html, /id="imgRunPodNegative"/);
  assert.match(html, /id="vidRunPodSize"[\s\S]*value="512x320"/);
  assert.match(html, /id="vidRunPodGuidance"[^>]*value="3"/);
  assert.match(html, /src="runpod-integrated\.js"/);
  const worker = read("worker", "runpod-worker.js");
  assert.match(worker, /\/v1\/setup\/install/);
  assert.match(worker, /modelSetupVersion: 1/);
});

test("ComfyUI legacy and 0.37 COMBO model choices both populate the integrated picker", () => {
  assert.deepEqual(modelChoices([["a.safetensors", "b.safetensors"]]), ["a.safetensors", "b.safetensors"]);
  assert.deepEqual(modelChoices(["COMBO", { options: ["new.safetensors"] }]), ["new.safetensors"]);
});

test("beginner setup follows verified account, computer, AI and shutdown readiness", () => {
  const js = read("web", "cloud-computer.js");
  const source = js.slice(js.indexOf("export function cloudSetupStage"), js.indexOf("function setupSaved")).replace("export ", "");
  const stage = runInNewContext(source + "\ncloudSetupStage;");
  assert.equal(stage(null, false), 1);
  assert.equal(stage({ computers: [] }, true), 2);
  const s = { podId: "one", pod: { status: "EXITED" }, idleMinutes: 30 };
  assert.equal(stage(s, true), 3);
  s.pod.status = "RUNNING"; s.worker = { connectionReady: true, generationReady: false };
  assert.equal(stage(s, true), 3, "model setup cannot be skipped");
  s.worker.generationReady = true;
  assert.equal(stage(s, true), 4, "default 30 minutes is not a verified remote policy");
  s.worker.authorized = true; s.worker.available = true;
  assert.equal(stage(s, true), 5);
  s.worker.authorized = false; s.idleMinutes = 0;
  assert.equal(stage(s, true), 5, "explicit disabled policy is a supported choice");
  s.pod.status = "EXITED";
  assert.equal(stage(s, true, true), 5, "a completed setup survives compute stopping");
  assert.equal(stage({ ...s, issue: { code: "credentials_invalid" } }, true, true), 1);
  s.pod.status = "RUNNING"; s.worker.connectionReady = false;
  assert.equal(stage(s, true, true), 3, "saved setup never overrides a live worker failure");
});

test("guided setup reuses vault-backed forms without duplicate secret inputs or automatic paid actions", () => {
  const html = read("web", "index.html"), js = read("web", "cloud-computer.js");
  for (const id of ["runpodApiKey", "runpodWorkerToken", "cloudComputerStopKey", "runpodAccountForm", "runpodConnectionForm"])
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
  assert.match(html, /RunPod \/ Easy setup/);
  assert.match(js, /\['cloudSetupAccountFields', \['runpodAccountForm', 'runpodAccountState'\]\]/);
  assert.match(js, /cloudSetupStart'\)\.addEventListener\('click', \(\) => \$\('cloudComputerStart'\)\.click\(\)\)/);
  assert.match(html, /Create cloud computer/);
  assert.match(js, /\['cloudSetupCreateFields', \['runpodCreateForm'\]\]/);
  assert.match(html, /new computers can install and connect automatically/);
});

test("advanced setup remains an explicit footer button and opening it preserves guided work", () => {
  const html = read("web", "index.html"), js = read("web", "cloud-computer.js");
  assert.match(html, /id="cloudSetupAdvanced"[^>]*aria-controls="cloudComputerConnection"/);
  assert.ok(html.indexOf('id="cloudSetupAdvanced"') > html.indexOf('id="cloudFlowReady"'));
  assert.match(html, /id="cloudSetupBack"/);
  const calls = [], controls = new Map();
  for (const id of ["cloudComputerConnection", "runpodAccount", "cloudSetupAdvanced", "cloudSetup", "runpodApiKey", "runpodWorkerToken"])
    controls.set(id, { id, open: false, style: {}, value: `unsaved:${id}`, attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      closest: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ height: 90 }) }) }),
      scrollIntoView: () => calls.push(`scroll:${id}`), focus: () => calls.push(`focus:${id}`),
      querySelector: () => ({ focus: () => calls.push(`summary:${id}`) }) });
  const context = { $: id => controls.get(id), setupOverride: 3,
    current: Object.freeze({ phase: "models-needed", podId: "saved" }),
    api() { assert.fail("navigation must not call the provider"); },
    perform() { assert.fail("navigation must not perform a cloud action"); } };
  const helpers = js.slice(js.indexOf("function scrollSetupTo("), js.indexOf("function mountSetup("));
  runInNewContext(helpers + "\nopenAdvancedSetup();", context);
  assert.equal(controls.get("cloudComputerConnection").open, true);
  assert.equal(controls.get("runpodAccount").open, true);
  assert.equal(controls.get("cloudSetupAdvanced").attrs["aria-expanded"], "true");
  assert.equal(controls.get("cloudComputerConnection").style.scrollMarginTop, "102px");
  runInNewContext(helpers + "\nreturnToGuidedSetup();", context);
  assert.equal(controls.get("cloudComputerConnection").open, false);
  assert.equal(controls.get("cloudSetupAdvanced").attrs["aria-expanded"], "false");
  assert.equal(context.setupOverride, 3);
  assert.equal(context.current.podId, "saved");
  for (const id of ["runpodApiKey", "runpodWorkerToken"]) assert.equal(controls.get(id).value, `unsaved:${id}`);
  assert.deepEqual(calls, ["scroll:cloudComputerConnection", "summary:cloudComputerConnection", "scroll:cloudSetup", "focus:cloudSetupAdvanced"]);
});

test("the shared RunPod setup belongs to Settings, with usage outside account details", () => {
  const html = read("web", "index.html");
  const settings = html.slice(html.indexOf('<div id="settings"'), html.indexOf('<div id="avatars"'));
  assert.match(settings, /id="set-runpod"[\s\S]*One worker connection for music, pictures and video/);
  assert.match(settings, /id="runpodConnection" hidden class="runpod-settings"/);
  assert.match(settings, /id="runpodWorkerUrl"/);
  assert.match(settings, /id="runpodRefreshUsage"/);
  assert.ok(settings.indexOf('id="runpodBalance"') < settings.indexOf('id="runpodAccount"'));
  assert.doesNotMatch(html, /class="overlay" id="runpodConnection"/);
  const js = read("web", "runpod-integrated.js");
  const navigate = js.slice(js.indexOf("function openSettings()"), js.indexOf("function dimensions("));
  const calls = [];
  runInNewContext(navigate + "\nopenSettings();", {
    document: { querySelector: () => ({ click: () => calls.push("settings") }) },
    revealSetting: () => calls.push("reveal"),
    $: id => ({ scrollIntoView: () => calls.push(`scroll:${id}`), focus: () => calls.push(`focus:${id}`) }),
  });
  assert.deepEqual(calls, ["settings", "reveal", "scroll:set-runpod", "focus:runpodWorkerUrl"]);
});

test("usage refresh clears old billing numbers when the key is missing or the account fails", async () => {
  const js = read("web", "runpod-integrated.js");
  const load = js.slice(js.indexOf("async function loadAccount()"), js.indexOf("function creationInput()"));
  for (const failure of [false, true]) {
    const nodes = Object.fromEntries(["runpodAccountPanel", "runpodAccountState", "runpodBalance", "runpodUsageUpdated"]
      .map(id => [id, { textContent: "$20.00", hidden: false, className: "chip ok", classList: { add() {} } }]));
    await runInNewContext(load + "\nloadAccount();", {
      $: id => nodes[id],
      accountApi: async () => { if (failure) throw new Error("Account unavailable"); return { configured: false }; },
      publishBalance: (balance, stale = false) => { assert.equal(balance,null); assert.equal(stale,failure); },
    });
    assert.equal(nodes.runpodAccountPanel.hidden, true);
    assert.equal(nodes.runpodBalance.textContent, failure ? "Usage unavailable" : "Account not connected");
    assert.equal(nodes.runpodBalance.className, failure ? "chip warn" : "chip");
  }
});

function creationRig(post = async () => ({ pod: { id: "new-computer", name: "AIPLAY renderer", workerUrl: "https://new-computer-8787.proxy.runpod.net" } })) {
  const js = read("web", "runpod-integrated.js");
  const source = js.slice(js.indexOf("function creationInput()"), js.indexOf("function setState("));
  const controls = new Map(), calls = [], events = [];
  for (const id of ["runpodPodName", "runpodGpu", "runpodCloud", "runpodVolume", "runpodCostConfirm", "runpodCreatePod",
    "runpodCreateReview", "runpodReviewPod", "runpodCreateState", "runpodReviewPrice", "runpodReviewDetails", "runpodReviewStorage", "runpodWorkerUrl"])
    controls.set(id, { value: "", checked: false, disabled: true, hidden: true, textContent: "", selectedOptions: [{ textContent: "Any available" }] });
  for (const [id, value] of [["runpodPodName", "AIPLAY renderer"], ["runpodGpu", "gpu"], ["runpodCloud", "ALL"], ["runpodVolume", "100"]]) controls.get(id).value = value;
  const data = { pods: [], gpus: [{ id: "gpu", name: "Test GPU", stock: "High", pricePerHr: .5 }] };
  const quote = {cloud:'SECURE',rate:.5};
  let clock = 1000;
  const helpers = runInNewContext(source + "\n({ reviewPod, createReviewedComputer, invalidateCreationReview });", {
    $: id => controls.get(id), creationBusy: false, creationReview: null, Date: class extends Date { static now(){return clock;} },
    money: value => `$${value.toFixed(2)}`, loadAccount: async () => {},
    crypto: {randomUUID:()=> '11111111-1111-4111-8111-111111111111'},
    getSetupPlan:()=>data.plan,
    api: async route => {assert.equal(route,'/install/quote');return quote;},
    accountApi: async (route, body) => { calls.push({ route, body }); return route === "/overview" ? data : post(body); },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    document: { dispatchEvent: event => events.push(event) },
  });
  return { ...helpers, controls, calls, events, data, quote, advance: ms => { clock += ms; } };
}

test('automatic creation locks the reviewed provider pool instead of quoting Any available again',async()=>{
 const r=creationRig();r.controls.set('runpodAutoInstall',{checked:true});await r.reviewPod();
 assert.equal(r.controls.get('runpodCreateReview').hidden,false);
 assert.equal(r.controls.get('runpodCloud').value,'SECURE');
 r.controls.get('runpodCostConfirm').checked=true;await r.createReviewedComputer();
 const creation=r.calls.find(c=>c.body);assert.equal(creation.body.cloudType,'SECURE');assert.equal(creation.body.expectedPricePerHr,.5);
});

test('model changes after cost review require renewed approval before creation',async()=>{
 const r=creationRig();r.data.plan={selection:{music:'ace15-xl-sft'}};await r.reviewPod();
 r.controls.get('runpodCostConfirm').checked=true;r.data.plan={selection:{music:'ace15-xl-turbo'}};
 await r.createReviewedComputer();assert.equal(r.calls.filter(c=>c.body).length,0);assert.equal(r.controls.get('runpodCreateReview').hidden,true);
});

test("computer creation review refreshes prices read-only and includes continuing storage estimates", async () => {
  const r = creationRig(); await r.reviewPod();
  assert.deepEqual(r.calls.map(c => c.route), ["/overview"]);
  assert.equal(r.controls.get("runpodCreatePod").disabled, true);
  assert.equal(r.controls.get("runpodCreateReview").hidden, false);
  assert.match(r.controls.get("runpodReviewStorage").textContent, /\$10.00\/month running, \$20.00\/month stopped/);
  assert.match(r.controls.get("runpodReviewStorage").textContent, /Temporary disk: \$2.00\/month running/);
  assert.match(r.controls.get('runpodReviewPrice').textContent,/Checked/);
  await r.createReviewedComputer();
  assert.equal(r.calls.filter(c => c.route === "/pods").length, 0, "opening/reviewing is never approval to rent");
  r.data.gpus[0].stock = "None"; await r.reviewPod();
  assert.equal(r.controls.get("runpodCreateReview").hidden, true);
  assert.match(r.controls.get("runpodCreateState").textContent, /unavailable/);
});

test("changed or expired creation reviews cannot spend even when the checkbox remains checked", async () => {
  for (const change of [r => { r.controls.get("runpodVolume").value = "200"; }, r => r.advance(300001)]) {
    const r = creationRig(); await r.reviewPod(); r.controls.get("runpodCostConfirm").checked = true; change(r);
    await r.createReviewedComputer();
    assert.equal(r.calls.filter(c => c.route === "/pods").length, 0);
    assert.equal(r.controls.get("runpodCostConfirm").checked, false);
  }
});

test("creation sends only the reviewed choices once and hands the returned ID to AI setup", async () => {
  let release;
  const r = creationRig(() => new Promise(resolve => { release = resolve; }));
  await r.reviewPod(); r.controls.get("runpodCostConfirm").checked = true;
  const pending = r.createReviewedComputer(); await r.createReviewedComputer();
  const writes = r.calls.filter(c => c.route === "/pods");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.volumeInGb, 100); assert.equal(writes[0].body.expectedPricePerHr, .5);
  assert.equal(writes[0].body.confirm, "CREATE PAID POD");
  release({ pod: { id: "returned-id", name: "AIPLAY renderer", workerUrl: "https://returned-id-8787.proxy.runpod.net" } });
  await pending;
  assert.equal(r.events.length, 1); assert.equal(r.events[0].type, "aiplay:cloud-computer-created");
  assert.equal(r.events[0].detail.id, "returned-id");
  assert.equal(r.controls.get("runpodCostConfirm").checked, false);
});

test("an uncertain creation consumes approval and a repeated click cannot create a duplicate", async () => {
  const r = creationRig(async () => { throw new Error("Request timed out"); });
  await r.reviewPod(); r.controls.get("runpodCostConfirm").checked = true;
  await r.createReviewedComputer();
  assert.match(r.controls.get("runpodCreateState").textContent, /Check existing computers/);
  await r.createReviewedComputer();
  assert.equal(r.calls.filter(c => c.route === "/pods").length, 1);
  assert.equal(r.events.length, 0);
});

test("integrated image options retain the selected remote checkpoint and common controls", () => {
  assert.deepEqual(imageWorkflowOptions({ prompt: "lake", checkpoint: "sd15.safetensors", width: 512,
    height: 512, steps: 20, seed: 7, count: 2, negative: "blur", cfg: 6.5 }), {
    prompt: "lake", checkpoint: "sd15.safetensors", ckpt: "sd15.safetensors", width: 512,
    height: 512, steps: 20, seed: 7, count: 2, negative: "blur", cfg: 6.5,
  });
});

test("integrated LTX options retain video controls and duration aliases", () => {
  assert.deepEqual(videoWorkflowOptions({ prompt: "robot", negative: "blur", width: 512, height: 320,
    seconds: 2, steps: 8, seed: 9, guidance: 3 }), {
    prompt: "robot", negative: "blur", width: 512, height: 320, seconds: 2,
    duration: 2, maxDuration: 2, steps: 8, seed: 9, guidance: 3,
  });
});

/* MINIMAX H3 ON THE POD (2026-09-29): the Video box picks LTX or H3; H3 sends
 * the server's "h3" template (Studio's own graph) with the chosen steps. */
test("the Video box offers MiniMax H3 with its own sizes and steps", async () => {
  const html = read("web", "index.html");
  assert.match(html, /<select id="vidRunPodModel"[^>]*>\s*<option value="ltx">LTX 2\.5 distilled<\/option>\s*<option value="h3">MiniMax H3<\/option>/);
  assert.match(html, /id="vidRunPodSteps"[^>]*value="20"/);
  for (const size of ["832x480", "1280x720", "1344x768"]) assert.match(html, new RegExp(`value="${size}" data-for="h3"`));
  const { h3WorkflowOptions, paintRemoteModel } = await import("../../web/runpod-integrated.js");
  assert.deepEqual(h3WorkflowOptions({ prompt: "p", width: 1280, height: 720, seconds: 5, steps: 20, seed: 3, negative: "x" }),
    { prompt: "p", width: 1280, height: 720, seconds: 5, steps: 20, seed: 3 }, "H3 has no negative prompt or guidance");
  const el = (id, extra = {}) => ({ id, hidden: false, ...extra });
  const opts = [{ value: "512x320", dataset: { for: "ltx" } }, { value: "1280x720", dataset: { for: "h3" } }];
  const size = el("vidRunPodSize", { options: opts, value: "512x320", get selectedOptions() { return opts.filter((o) => o.value === this.value); } });
  const nodes = { vidRunPodModel: el("vidRunPodModel", { value: "h3" }), vidRunPodSize: size, vidRunPodGuidance: el("g"), vidRunPodSteps: el("s") };
  const doc = { getElementById: (id) => nodes[id] || null, querySelector: () => null };
  assert.equal(paintRemoteModel(doc), "h3");
  assert.equal(size.value, "1280x720", "an LTX size is swapped for an H3 one");
  assert.equal(nodes.vidRunPodGuidance.hidden, true);
  assert.equal(nodes.vidRunPodSteps.hidden, false);
  const js = read("web", "runpod-integrated.js");
  assert.match(js, /template = \$\("vidRunPodModel"\)\?\.value === "h3" \? "h3" : "ltx";/);
  assert.match(read("server", "engine", "remote-routes.js"), /h3: opts => videoGraph\(\{ \.\.\.opts, engine: "h3" \}\)/);
});

test("remote-only launch opens the integrated application", () => {
  const server = read("server", "index.js");
  assert.match(server, /`http:\/\/127\.0\.0\.1:\$\{config\.uiPort\}`/);
  assert.doesNotMatch(server, /config\.remoteOnly \? "\/runpod\.html"/);
});

/* THE LAUNCHER'S RUNPOD GPU MODE ONLY (2026-09-25). A Pod bills by the hour and
 * the account routes can create one, so full Studio, Music only and Comfy API
 * never show or serve any of it: the no-credits promise of full Studio. */
test("RunPod lives in its own launch mode and nowhere else", () => {
  const html = read("web", "index.html");
  assert.match(html, /id="imgRunPodBlock" hidden/);
  assert.match(html, /id="vidRunPodBlock" hidden/);
  assert.match(html, /<select id="imgRenderWhere" class="sel2" hidden>/, "no local choice in a mode with no local engine");
  assert.doesNotMatch(html, /href="\/runpod\.html" title="RunPod remote rendering"/, "no rail link in full Studio");
  const js = read("web", "runpod-integrated.js");
  assert.match(js, /if \(!status\?\.config\?\.remoteOnly\) return;/);
  const init = js.slice(js.indexOf("async function init() {"));
  assert.ok(init.indexOf("if (!status?.config?.remoteOnly) return;") < init.indexOf("refreshWorker().catch"), "nothing is asked before the mode is known");
  assert.doesNotMatch(js, /localStorage/, "the target is the mode, not a remembered choice");
  const server = read("server", "index.js");
  assert.match(server, /const remoteRoutes = config\.remoteOnly \? createRemoteRoutes\(/);
  assert.match(server, /if \(!remoteRoutes\) return json\(res, 404, \{ error: "RunPod rendering is the launcher's RunPod GPU mode/);
  const config = read("server", "config.js");
  assert.match(config, /const REMOTE_ONLY = !MUSIC_ONLY && !CLOUD_ONLY && process\.env\.AIPLAY_REMOTE_ONLY === "1";/);
  assert.match(config, /comfyAutoStart: !MUSIC_ONLY && !CLOUD_ONLY && !REMOTE_ONLY,/);
  const launcher = read("launcher", "launcher.mjs");
  assert.match(launcher, /mode === "runpod" \? path\.join\("scripts", "start-remote\.mjs"\)/);
  assert.match(launcher, /AIPLAY_REMOTE_ONLY: mode === "runpod" \? "1" : "0"/);
  assert.match(read("launcher", "index.html"), /data-launch="runpod"/);
  assert.match(read("scripts", "start-remote.mjs"), /AIPLAY_REMOTE_ONLY = "1"/);
});

test("the Pod bootstrap installs this Studio's own commit, never a branch that moves", () => {
  /* Review of 40f5859, S2, and again on 7b241ea: the page showed a curl | bash
   * of a branch's head with no checksum, and the script fast-forwarded that
   * branch at every rerun. The command is now the Studio's own
   * (runpod-bootstrap.js, remote_guard_test §6). */
  const sh = read("worker", "bootstrap-runpod.sh");
  assert.match(sh, /REPO="\$\{AIPLAY_REPOSITORY:-\}"\s*COMMIT="\$\{AIPLAY_COMMIT:-\}"/, "no default repository, no branch");
  assert.doesNotMatch(sh, /AIPLAY_BRANCH|merge --ff-only|--branch|bani4kaskashka/);
  const html = read("web", "index.html");
  assert.match(html, /id="runpodBootstrapCommand"[^>]*readonly[^>]*><\/textarea>/, "the page holds no command of its own");
  assert.doesNotMatch(html, /raw\.githubusercontent\.com/);
  assert.match(read("web", "runpod-integrated.js"), /api\("\/bootstrap"\)\.then\(\(b\) => \{\s*\$\("runpodBootstrapCommand"\)\.value = b\.command \|\| "";/, "it asks the Studio");
  assert.match(sh, /check-comfy-loopback\.js/);
  assert.match(sh, /different Git origin/);
  assert.match(read("worker", "runpod-worker.js"), /await waitForComfyLoopback\(\);/, "worker autostart also verifies the listener, waiting for it to come up");
  assert.doesNotMatch(html, /nemesisone-dev\/AIPLAY-Studio\/feature/);
});

/* MUSIC ON THE POD (2026-09-25): in RunPod GPU mode the music queue builds the
 * graph it builds for this PC and renders it on the Pod; the song is filed by
 * the queue's usual "done" path under an aiplay_ name the library lists. */
test("RunPod GPU mode renders music on the Pod too", () => {
  const jobs = read("server", "jobs.js");
  assert.match(jobs, /setRemote\(fn\) \{ this\.remote = typeof fn === "function" \? fn : null; \}/);
  assert.match(jobs, /if \(this\.remote\) return await this\.#runRemote\(job, graph\);/);
  assert.match(jobs, /if \(!config\.api\?\.enabled && !this\.remote && !this\.comfy\.ready/, "the queue does not wait for a local engine");
  assert.match(jobs, /if \(!this\.remote\) await this\.connect\(\);/);
  const server = read("server", "index.js");
  assert.match(server, /if \(remoteRoutes\) jobs\.setRemote\(async \(\{ graph, label, actor, isCancelled, onState \}\) => \{/);
  assert.match(server, /const name = `aiplay_runpod_\$\{details\.runId\}_\$\{path\.basename\(details\.output\.file\)\}`;/, "a name the library lists");
  assert.match(server, /if \(cap && !cap\.ready && !config\.remoteOnly\) \{/, "the Pod, not this disk, decides");
  assert.match(server, /remoteAceShelf\(info, config\.music\.aceLm\)/, 'ACE variants come from this worker');
  assert.match(server, /remoteYueCheckpoints\(info\)/, 'YuE checkpoints come from this worker');
  const app = read("web", "app.js");
  /* The Python kit now answers for its own runtime. Run the actual button
   * condition so adding that branch cannot break remote ComfyUI readiness. */
  const gate = /create\.disabled = ([^;]+);/.exec(app)?.[0];
  assert.ok(gate, "the Music button still has a readiness condition");
  const disabled = ({ runtime = "comfy", ready, engineReady = false, remoteOnly = true, nativeReady = false, noPath = false } = {}) => {
    const create = {};
    runInNewContext(gate, { create, noPath, nativeReady, eng: { runtime, ready }, state: { engineReady, remoteOnly } });
    return create.disabled;
  };
  assert.equal(disabled(), false, "remote ComfyUI does not require a local engine");
  assert.equal(disabled({ remoteOnly: false }), true, "local ComfyUI still requires its engine");
  assert.equal(disabled({ runtime: "python", ready: false }), true, "a Pod does not repair a missing local Python kit");
  assert.equal(disabled({ runtime: "python", ready: true, remoteOnly: false }), false, "a ready separate Python kit does not require ComfyUI");
  assert.equal(disabled({ runtime: "audiocpp" }), true, "local native music still requires its runtime");
  assert.equal(disabled({ noPath: true }), true, "no launch mode enables an absent render path");
});

/* RUNPOD IS ADVANCED ONLY (the owner's decision, 2026-09-26). It ships in the
 * public build, but nothing about it shows in Simple: no launch mode, no star,
 * no RunPod box and no Remote numbers. Advanced keeps the whole mode. A
 * friend's card stays the first advice for a weak card. */
test("the launcher offers RunPod GPU only when Studio opens on Advanced", async () => {
  const { modesForLevel, modeAllowed, launcherLevel, ADVANCED_MODES, advancedOnlyLine, cardAdvice } = await import("../../launcher/checks.mjs");
  assert.deepEqual([...ADVANCED_MODES], ["runpod"]);
  const modes = { full: { available: true }, music: { available: true }, cloud: { available: true }, runpod: { available: true } };
  assert.deepEqual(Object.keys(modesForLevel(modes, "simple")), ["full", "music", "cloud"], "Simple: no RunPod card");
  assert.deepEqual(Object.keys(modesForLevel(modes, "advanced")), ["full", "music", "cloud", "runpod"], "Advanced keeps it");
  assert.equal(modeAllowed("runpod", "simple"), false);
  assert.equal(modeAllowed("cloud", "simple"), true);
  assert.match(advancedOnlyLine("RunPod GPU"), /^RunPod GPU is in Advanced only\. Turn on "Show every setting" in Studio's Settings/);
  /* The level is Studio's own answer from the same file (server/welcome/startlevel.js). */
  assert.equal(launcherLevel(null), "simple", "no settings.json: a new install opens Simple");
  assert.equal(launcherLevel(JSON.stringify({ rig: "C:/rig", python: "C:/py.exe", gpu: { vendor: "nvidia" } })), "simple", "what the launcher writes is not use");
  assert.equal(launcherLevel(JSON.stringify({ api: { enabled: false } })), "advanced", "an install in use keeps Advanced");
  assert.equal(launcherLevel(JSON.stringify({ prefs: { ui: { level: "advanced", levelBy: "you" } } })), "advanced");
  assert.equal(launcherLevel(JSON.stringify({ api: {}, prefs: { ui: { level: "simple", levelBy: "you" } } })), "simple", "a saved choice wins");
  assert.equal(launcherLevel('{"rig": "x",}'), "advanced", "a file that cannot be parsed keeps Advanced, as in Studio");
  assert.equal(launcherLevel("\uFEFF{}"), "advanced", "...a byte-order mark included");
  const cfg = read("server", "config.js");
  assert.match(cfg, /import \{ LEVELS, IN_USE_KEYS, startLevel \} from "\.\/welcome\/startlevel\.js";/, "one rule for Studio and the launcher");
  assert.doesNotMatch(cfg, /export function startLevel\(/, "no second copy in config.js");
  /* A friend's card first, Comfy API second, and no Pod in the advice. */
  const adv = cardAdvice({ gpu: { name: "GTX 1650", totalMb: 4096, vendor: "nvidia" }, torchOnCard: true });
  assert.deepEqual(Object.keys(adv), ["why", "friend", "cloud"]);
  assert.doesNotMatch(JSON.stringify(adv), /runpod|\bpod\b/i);
  const html = read("launcher", "index.html");
  const at = html.indexOf('id="friendCard"');
  const friend = html.slice(at, html.indexOf("</article>", at));
  assert.ok(friend.indexOf("Ask a friend") > 0 && friend.indexOf("Ask a friend") < friend.indexOf("Or use Comfy API"), "the friend comes first");
  assert.doesNotMatch(friend, /runpod/i);
});

test("the launcher's server and page: hidden, not started and not saved as a favourite on Simple", () => {
  const mjs = read("launcher", "launcher.mjs");
  assert.match(mjs, /if \(url\.pathname === "\/api\/check"\) return send\(res, 200, await checkForPage\(await getCheck\(/, "the page gets the modes of this level");
  assert.match(mjs, /return \{ \.\.\.c, level, modes: modesForLevel\(c\.modes, level\) \};/);
  assert.match(mjs, /if \(!modeAllowed\(mode, await studioLevel\(\)\)\) throw new Error\(advancedOnlyLine\(MODE_NAME\[mode\] \|\| mode\)\);/, "a launch is refused");
  assert.match(mjs, /if \(!modeAllowed\(b\.autoLaunch, await studioLevel\(\)\)\) return send\(res, 400, \{ error: advancedOnlyLine\(MODE_NAME\[b\.autoLaunch\]\) \}\);/, "a star is refused");
  assert.match(mjs, /autoLaunch: fav && modeAllowed\(fav, level\) \? fav : null,/, "a saved RunPod star is not started on Simple");
  assert.match(mjs, /const mode = launcherPrefs\(\(await readJson\(SETTINGS\)\) \|\| \{\}, await studioLevel\(\)\)\.autoLaunch;/);
  /* The check itself is cached; the level is read at every ask. */
  const studioLevel = mjs.slice(mjs.indexOf("async function studioLevel() {"), mjs.indexOf("async function checkForPage("));
  assert.match(studioLevel, /catch \(err\) \{ if \(err\?\.code !== "ENOENT"\) return "advanced"; \}\s*return launcherLevel\(text\);/);
  const html = read("launcher", "index.html");
  assert.match(html, /<article class="card mode" id="mode-runpod" data-mode="runpod" data-level="advanced" tabindex="0" role="listitem" hidden>/, "hidden until the check offers it");
  assert.match(html, /if \(card\.dataset\.level === "advanced"\) card\.hidden = !\(check\?\.modes\?\.\[m\] \|\| mine\);/, "shown at Advanced, or while it runs");
  assert.match(html, /@media \(min-width: 1081px\) \{ \.modes:has\(> \.mode\[hidden\]\) \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
});

test("Studio's Simple screens show no RunPod box, and RunPod GPU mode offers no Simple", () => {
  const css = read("web", "styles.css");
  const keepRule = /\.assist-on > ((?::not\([^)]+\))+) \{ display: none !important; \}/.exec(css)?.[1] || "";
  assert.ok(keepRule.length > 100, "the Simple rule was read");
  assert.doesNotMatch(keepRule, /runpod/i, "no RunPod box, so no Remote CFG, negative, size or guidance, in Simple");
  /* The server names the screens that open Advanced in RunPod GPU mode, and only there. */
  const probe = (remote) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
    "const {levelState}=await import('./server/welcome/level.js');console.log(JSON.stringify(levelState().advancedOnly||null))"],
  { cwd: ROOT, env: { ...process.env, AIPLAY_APPDATA: path.join(tmpdir(), `aiplay-remote-level-${process.pid}`),
    AIPLAY_MUSIC_ONLY: "0", AIPLAY_CLOUD_ONLY: "0", AIPLAY_REMOTE_ONLY: remote ? "1" : "0" } }).toString());
  const on = probe(true);
  assert.deepEqual(on?.screens, ["create", "images", "video"]);
  assert.match(on?.why || "", /^RunPod GPU is an Advanced launch mode: while it runs, Music, Pictures and Video open on Advanced/);
  assert.equal(probe(false), null, "full Studio, Music only and Comfy API: the level as saved");
  const assist = read("web", "assist.js"), app = read("web", "app.js");
  assert.match(assist, /if \(lock\(n\.advancedOnly\)\) return;\s*if \(n\.view && n\.view !== P\.view\) return;/, "Pictures and Video: no news opens Simple");
  assert.match(assist, /if \(!b \|\| \(locked && b\.dataset\.m === "simple"\)\) return;/, "...nor the Simple button");
  assert.match(assist, /simpleBtn\.disabled = locked;\s*simpleBtn\.title = locked \? only\.why : simpleTip;/, "which says why");
  assert.match(app, /if \(musicLock\(n\.advancedOnly\)\) return;\s*if \(n\.view && n\.view !== "create"\) return;/, "Music the same");
  assert.match(app, /if \(b\) \{ b\.disabled = locked; b\.title = locked \? only\.why : musicSimpleTip; \}/);
  assert.match(read("web", "level.js"), /\[st\.line, st\.advancedOnly\?\.why\]\.filter\(Boolean\)\.join\(" "\)/, "Settings' line says why");
});

test('installation checklist uses live provider, chosen models and shutdown verification', () => {
  const js=read('web','cloud-computer.js');
  const source=js.slice(js.indexOf('export function cloudGoalReady'),js.indexOf('function paintInstallation')).replaceAll('export ','');
  const progress=runInNewContext(source+'\ncloudInstallationProgress;');
  const state={podId:'one',pod:{status:'RUNNING'},idleMinutes:30,worker:{connectionReady:true,generationReady:true,authorized:false,available:false}};
  const picture=[{id:'sdxl-turbo',state:'ready'}];
  const p=progress(state,'pictures',picture);assert.equal(p.complete,false);assert.equal(p.steps[4],'current');assert.equal(p.done,4);
  state.worker.authorized=true;state.worker.available=true;assert.equal(progress(state,'pictures',picture).complete,true);
  assert.equal(progress(state,'all',picture).steps[2],'current','one ready picture model is not every selected model');
  state.pod.status='EXITED';assert.equal(progress(state,'pictures',picture).done,0);
  state.pod.status='RUNNING';state.providerUncertain=true;assert.equal(progress(state,'pictures',picture).done,0);
});
test('credit updates retain a labelled stale balance on failure and clear it on account removal', () => {
  const js=read('web','runpod-integrated.js'), updates=[];
  const source=js.slice(js.indexOf('function publishBalance'),js.indexOf('function renderBalance'));
  runInNewContext('let balanceCheck=null;'+source+'\npublishBalance(11.25);publishBalance(null,true);publishBalance(null);',{
    document:{dispatchEvent:e=>updates.push(e.detail)},CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}
  });
  assert.equal(updates[0].balance,11.25);assert.equal(updates[1].balance,11.25);assert.equal(updates[1].stale,true);assert.equal(updates[2].balance,null);assert.equal(updates[2].stale,false);
});


test('readiness UI separates historical hardware from current model installation and inference', () => {
  const js=read('web','cloud-computer.js');
  const source=js.slice(js.indexOf('function paintSelectedReadiness'),js.indexOf('async function refreshFlowModels'));
  const element=()=>({children:[],className:'',textContent:'',append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];}});
  const root=element();const paint=runInNewContext(source+'\npaintSelectedReadiness;',{$:()=>root,document:{createElement:element}});
  paint([{label:'XL-SFT',historicalHardwareValidated:true}]);
  const flatten=n=>[n.textContent,...n.children.flatMap(flatten)].join('\n');
  let text=flatten(root);assert.match(text,/Model files needed/);assert.match(text,/Files checksum verified: Not verified/);
  assert.match(text,/This runtime inference: Not verified/);assert.match(text,/Hardware history: A100 SXM workflow tested/);
  assert.doesNotMatch(text,/: Yes/);
  paint([{label:'XL-Base'}]);text=flatten(root);assert.doesNotMatch(text,/Hardware history/);
  const planner=read('web','setup-plan.js');assert.match(planner,/observed GPU peak/);assert.match(planner,/observed process RAM/);
  assert.match(planner,/minimum requirements', 'Not established'/);
});

test('model discovery uses the local provider adapter in Full Studio and RunPod mode, not limited launch modes', async () => {
  const html = read('web', 'index.html');
  assert.match(html, /<section id="set-model-connections" hidden class="pcard" data-nav="Model connections">/);
  const source = read('web', 'model-browser.js').replace(/^import .*;\r?\n/gm, '')
    .replace(/if \(typeof document !== 'undefined'\) init\(\);\s*$/, '');
  async function boot(config, statusOK = true) {
    const calls = [], nodes = new Map();
    const element = () => ({ hidden: true, children: [], dataset: {}, listeners: {}, value: 'read-key',
      addEventListener(type, fn) { this.listeners[type] = fn; }, before() {}, append() {}, classList: { toggle() {} } });
    const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
    const form = element(), forget = element(); form.dataset.modelKey = 'huggingface'; forget.dataset.modelForget = 'huggingface';
    const input = element(); form.querySelector = () => input;
    const document = { getElementById: node, querySelector: node,
      querySelectorAll: selector => selector === '[data-model-key]' ? [form] : selector === '[data-model-forget]' ? [forget] : [] };
    const init = runInNewContext(source + '\ninit;', { document, fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: url === '/api/status' ? statusOK : true,
        json: async () => url === '/api/status' ? { config } : { configured: { huggingface: true, civitai: false } } };
    } });
    await init(); return { calls, nodes, form, forget, input };
  }
  for (const config of [{ remoteOnly: false, musicOnly: true }, { remoteOnly: false, cloudOnly: true }]) {
    const r = await boot(config);
    assert.deepEqual(r.calls.map(c => c.url), ['/api/status']);
    assert.equal(r.nodes.get('set-model-connections').hidden, true);
    assert.equal(r.form.listeners.submit, undefined); assert.equal(r.forget.listeners.click, undefined);
  }
  const unavailable = await boot({ remoteOnly: true }, false);
  assert.equal(unavailable.nodes.get('set-model-connections').hidden, true);
  assert.deepEqual(unavailable.calls.map(c => c.url), ['/api/status']);
  const remote = await boot({ remoteOnly: true });
  assert.equal(remote.nodes.get('set-model-connections').hidden, false);
  assert.deepEqual(remote.calls.map(c => c.url), ['/api/status', '/api/model-library/connections']);
  const local = await boot({ remoteOnly: false });
  assert.equal(local.nodes.get('set-model-connections').hidden, false);
  assert.deepEqual(local.calls.map(c => c.url), ['/api/status', '/api/model-library/connections']);
  assert.equal(local.nodes.get('catalogLocation').value, 'local');
  assert.equal(remote.nodes.get('catalogLocation').value, 'runpod');
  await remote.form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(remote.calls[2].options.body), { provider: 'huggingface', key: 'read-key' });
  assert.equal(remote.input.value, '');
  await remote.forget.listeners.click();
  assert.deepEqual(JSON.parse(remote.calls[4].options.body), { provider: 'huggingface', remove: true });
});

test('the worker update guide follows the approved repository and pinned commit', () => {
  const js = read('web', 'worker-update.js');
  const source = js.slice(js.indexOf('export function workerUpdateGuide'), js.indexOf('function paint')).replace('export ', '');
  const guide = runInNewContext(source + '\nworkerUpdateGuide;');
  const target = 'a'.repeat(40);
  for (const repo of ['Senzube4n/AIPLAY-Studio', 'nemesisone-dev/AIPLAY-Studio']) {
    assert.equal(guide({ repo, target }), `https://github.com/${repo}/blob/${target}/docs/CLOUD_COMPUTER.md#updating-existing-computers`);
    const nodes = new Map(), node = id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
    const paint = runInNewContext(source + '\n' + js.slice(js.indexOf('function paint'), js.indexOf('async function check')) + '\npaint;',
      { $: node, busy: false });
    paint({ repo, target, managed: true, phase: 'none', providerState: 'EXITED' });
    assert.equal(node('cloudUpdateGuide').href, guide({ repo, target }));
  }
  for (const data of [{ repo: 'other/repo', target }, { repo: 'Senzube4n/AIPLAY-Studio', target: 'main' }, { target }])
    assert.equal(guide(data), null);
  assert.match(read('web', 'index.html'), /id="cloudUpdateGuide" href="https:\/\/github\.com\/Senzube4n\/AIPLAY-Studio\/blob\/main\/docs\/CLOUD_COMPUTER\.md#updating-existing-computers"/);
});
