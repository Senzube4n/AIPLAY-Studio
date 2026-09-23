import test from 'node:test';import assert from 'node:assert/strict';
import {makeVideoRecipe,readVideoRecipe,videoRecipeMcpArgs} from './video-recipe.js';
import {createPreviewStore} from './preview.js';import {collabTools} from '../mcp-collab.js';
const video={engine:'ltx',prompt:'A dancer steps into the light',width:1280,height:704,seconds:5,steps:8,guidance:3,keepAudio:false,negative:'blur',seed:123};
test('video recipe and MCP rendering arguments preserve the reviewed settings',()=>{
 const p=makeVideoRecipe(video);assert.deepEqual(readVideoRecipe(JSON.parse(JSON.stringify(p))),video);
 assert.deepEqual(videoRecipeMcpArgs(p),{engine:'ltx',prompt:video.prompt,width:1280,height:704,seconds:5,steps:8,guidance:3,negative:'blur',seed:123,keep_audio:false,bridge:'off',bridge_alpha:0});
});
test('unrepresentable settings are refused instead of clipped, truncated or omitted',()=>{
 for(const patch of [{width:1279},{seconds:30},{steps:41},{guidance:0},{negative:'x'.repeat(501)},{prompt:' '},{keepAudio:'false'},{seed:NaN},{sourceVideo:'secret.mp4'},{refImages:['a.png']},{graph:{}}])assert.throws(()=>makeVideoRecipe({...video,...patch}),/recipe|setting|LTX/);
 const p=makeVideoRecipe(video);assert.throws(()=>readVideoRecipe({...p,recipeVersion:99}));assert.throws(()=>readVideoRecipe({...p,files:[{file:'secret'}]}));
 const {seed,...noSeed}=video;assert.ok(Number.isInteger(makeVideoRecipe(noSeed).video.seed));assert.throws(()=>readVideoRecipe({...p,video:noSeed}));
});
test('frozen preview survives caller mutations and packs only the reviewed recipe',()=>{
 const p=makeVideoRecipe(video),store=createPreviewStore();const preview=store.create({payload:p,peer:{fp:'friend',sign:'s',seal:'e'},name:'recipe.aiplay',describes:'recipe'});
 p.video.prompt='Changed';assert.equal(store.take(preview.previewId).payload.video.prompt,video.prompt);assert.throws(()=>store.take(preview.previewId));
});
test('MCP preview has parity and no pack or render side effect',async()=>{
 const calls=[];const tool=collabTools(async(...a)=>{calls.push(a);return {previewId:'p'};},x=>x).find(t=>t.name==='collab_video_preview');
 assert.deepEqual(await tool.run({to:'friend',video}),{previewId:'p'});assert.deepEqual(calls,[['POST','/api/collab',{action:'preview',kind:'video-recipe',to:'friend',video}]]);
 await assert.rejects(()=>tool.run({to:'friend',video:{...video,audioTrack:'track.wav'}}));assert.equal(calls.length,1);
});


test('receiver loads exact settings and clears incompatible local conditioning without rendering',async()=>{
 const {readFile}=await import('node:fs/promises');const vm=await import('node:vm');
 const source=await readFile(new URL('../../web/app.js',import.meta.url),'utf8');
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,addEventListener(type,fn){this[type]=fn;}});return nodes.get(id);};
 const recipe={...video,seconds:17.5,steps:32,guidance:2.3};node('cbFile').value='incoming.aiplay';
 const state={frameUploads:{vidFrom:'a',vidTo:'b'},midFrames:['x'],refImages:['x'],refAudios:['x'],sndUpload:'x'};
 const views=[];const context=vm.createContext({$:node,state,cbOpenedVideo:{file:'incoming.aiplay',video:recipe},setVideoEngine:async()=>true,setView:x=>views.push(x),vidPaint(){},vidPaintLoras(){},vidLoraStack:['old']});
 vm.runInContext(source.slice(source.indexOf('function videoFriendRecipe()'),source.indexOf('$("vidCreate").onclick')),context);
 await node('cbUseVideo').click();
 for(const [id,key] of [['vidPrompt','prompt'],['vidSecs','seconds'],['vidSteps','steps'],['vidGuide','guidance'],['vidSeed','seed'],['vidW','width'],['vidH','height']])assert.equal(node(id).value,String(recipe[key]));
 assert.equal(node('vidSecs').max,'20');assert.equal(node('vidSecs').step,'any');assert.equal(node('vidSteps').max,'40');assert.equal(node('vidGuide').step,'any');
 assert.equal(state.sndUpload,null);assert.equal(state.refImages.length,0);assert.equal(context.vidLoraStack.length,0);assert.equal(state.videoRecipeLoaded,true);assert.deepEqual(views,['video']);
 node('vidRecipeClear').click();assert.equal(state.videoRecipeLoaded,false);
});

/* EVERY ENGINE ON THE VIDEO SCREEN EITHER MAKES A RECIPE OR IS REFUSED BY NAME.
 * FastH3 came in beside the recipe and the two first met in the merge: Ask
 * friend built {engine:'fasth3'}, and the collab door answered only "Invalid
 * video setting: engine." The page's own videoFriendRecipe() runs here once per
 * engine config has. An engine the wire format carries must pass
 * makeVideoRecipe; any other must be in NOT_RECIPE AND refused on the page with
 * a sentence that says what to do, so a future engine fails this lane rather
 * than the button. */
const NOT_RECIPE = new Set(['fasth3']);
test('Ask friend: every video engine makes a valid recipe, or is refused on the page by name', async () => {
  const { config } = await import('../config.js');
  const { readFile } = await import('node:fs/promises'); const vm = await import('node:vm');
  const source = await readFile(new URL('../../web/app.js', import.meta.url), 'utf8');
  const fields = { vidPrompt: 'A dancer steps into the light', vidSecs: '5', vidSteps: '8', vidGuide: '3', vidNeg: '', vidAudio: '1', vidSeed: '123',
    vidFrom: '', vidTo: '', vidSndSong: '' };
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { value: fields[id] ?? '', checked: false, hidden: false, addEventListener() {} }); return nodes.get(id); };
  const state = { video: {}, frameUploads: {}, midFrames: [], refImages: [], refAudios: [], sndUpload: null };
  const context = vm.createContext({ $: node, state, vidWH: () => [1280, 704], vidModelChoice: () => ({}), vidLoraStack: [] });
  vm.runInContext(source.slice(source.indexOf('function videoFriendRecipe()'), source.indexOf('$("vidCreate").onclick')), context);
  const engines = Object.keys(config.video.engines);
  assert.ok(engines.includes('h3') && engines.includes('ltx') && engines.includes('fasth3'), engines.join(', '));
  for (const eng of NOT_RECIPE) assert.ok(engines.includes(eng), `${eng} is a real engine`);
  for (const eng of engines) {
    state.video.engine = eng;
    let recipe = null, refusal = null;
    try { recipe = vm.runInContext('videoFriendRecipe()', context); } catch (e) { refusal = e; }
    if (NOT_RECIPE.has(eng)) {
      assert.ok(refusal, `${eng}: the page refuses it`);
      assert.match(refusal.message, /Recipes carry MiniMax H3 or LTX settings.*switch the engine to MiniMax H3/, `${eng}: and says what to do`);
      assert.throws(() => makeVideoRecipe({ engine: eng, prompt: 'p', width: 1280, height: 704, seconds: 5, steps: 8, guidance: 3, keepAudio: true }),
        /engine/, `${eng}: the wire format does not carry it, which is why the page refuses it`);
    } else {
      assert.equal(refusal, null, `${eng}: ${refusal?.message}`);
      assert.equal(recipe.engine, eng);
      assert.equal(makeVideoRecipe(recipe).video.engine, eng, `${eng}: the collab door accepts what the page built`);
    }
  }
});
