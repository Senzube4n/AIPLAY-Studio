import test from 'node:test';
import assert from 'node:assert/strict';
import {sharedCueTools} from './mcp-shared-cues.js';
test('seven typed cue tools forward every declared control to the shared HTTP route',async()=>{
  const calls=[],tools=sharedCueTools(async(method,route,body)=>{calls.push({method,route,body:body&&JSON.parse(JSON.stringify(body))});return {ok:true};});
  const values={id:'a'.repeat(32),name:'Drop',project:'my-song',comp:'my-visual',bar:3,beat:2,tick:123,accent:'kick',velocity:110,gainDb:-12.5,durationBeats:1.2,flashStrength:35,compOffsetSeconds:-2.25,previewToken:'b'.repeat(64)};
  assert.equal(tools.length,7);
  for(const tool of tools){assert.equal(tool.inputSchema.additionalProperties,false);const input=Object.fromEntries(Object.keys(tool.inputSchema.properties).map(k=>[k,values[k]]));await tool.run(input);const call=calls.at(-1);assert.equal(call.route,'/api/music-cues');for(const [key,value]of Object.entries(input))assert.equal(call.body[key],value,`${tool.name}.${key}`);}
  assert.equal(calls[0].method,'GET');assert.equal(calls.find(c=>c.body?.accent)?.body.action,'save');
});
test('cue MCP validates direct invocations instead of trusting schema enforcement',async()=>{
  const tools=sharedCueTools(async()=>({ok:true})),save=tools.find(t=>t.name==='music_cue_save'),apply=tools.find(t=>t.name==='music_cue_apply'),status=tools[0];
  for(const input of [{project:'song',comp:'stage',bar:1,camera:'x'},{project:'../song',comp:'stage',bar:1},{project:'song',comp:'stage',bar:1.5},{project:'song',comp:'stage',bar:1,flashStrength:NaN},{project:'song',comp:'stage',bar:1,accent:'snare'}])await assert.rejects(save.run(input));
  await assert.rejects(apply.run({id:'a'.repeat(32)}),/previewToken/);await assert.rejects(status.run({by:'user'}),/Unsupported/);
  const failed=sharedCueTools(async()=>({error:'Changed project'})).find(t=>t.name==='music_cue_preview');await assert.rejects(failed.run({id:'a'.repeat(32)}),/Changed project/);
});
