import test from 'node:test';
import assert from 'node:assert/strict';
import {yueSetupTools} from './mcp-yue-setup.js';
test('MCP default is a read-only status request',async()=>{
 let calls=[];const [tool]=yueSetupTools(async(...args)=>{calls.push(args);return {ok:true};});
 await tool.run({});assert.deepEqual(calls,[['GET','/api/music-gguf/setup?precision=q4_0',undefined]]);
});
test('MCP install requires explicit approval before invoking HTTP',async()=>{
 let called=false;const [tool]=yueSetupTools(async()=>{called=true;});
 await assert.rejects(tool.run({action:'install'}),/approval/);assert.equal(called,false);
});
test('MCP installation and cancellation share the UI endpoint',async()=>{
 let calls=[];const [tool]=yueSetupTools(async(...args)=>{calls.push(args);return {ok:true,state:'downloading'};});
 await tool.run({action:'install',accepted_terms:true});await tool.run({action:'cancel'});
 assert.deepEqual(calls.map(c=>c.slice(0,2)),[['POST','/api/music-gguf/setup'],['POST','/api/music-gguf/setup']]);
 assert.equal(calls[0][2].acceptLicense,true);assert.equal(calls[1][2].action,'cancel');
 assert.equal(calls[0][2].quantization,'q4_0');
});

test('MCP Q8 status/install keeps selection explicit and quotes experimental capability',async()=>{
 let calls=[];const status={ok:true,quantization:'q8_0',ready:false,variants:{q4_0:{ready:true},q8_0:{ready:false}}};
 const [tool]=yueSetupTools(async(...args)=>{calls.push(args);return status;});
 assert.deepEqual(await tool.run({action:'status',precision:'q8_0'}),status);
 await tool.run({action:'install',precision:'q8_0',accepted_terms:true});
 assert.deepEqual(calls,[['GET','/api/music-gguf/setup?precision=q8_0',undefined],
   ['POST','/api/music-gguf/setup',{action:'install',quantization:'q8_0',acceptLicense:true}]]);
 assert.deepEqual(tool.inputSchema.properties.precision.enum,['q4_0','q8_0']);
 assert.match(tool.description,/unbenchmarked/);assert.match(tool.description,/selected transformer/);
});

test('invalid precision and nonboolean Q8 consent never invoke HTTP',async()=>{
 let calls=0;const [tool]=yueSetupTools(async()=>{calls++;return {ok:true};});
 for(const precision of [null,'q8','Q8_0','auto','__proto__',{},1]) await assert.rejects(tool.run({precision}),/precision/);
 for(const accepted_terms of [undefined,false,'true',1]) await assert.rejects(tool.run({action:'install',precision:'q8_0',accepted_terms}),/approval/);
 assert.equal(calls,0);
});

test('MCP different-precision install conflict remains visible and never retries another model',async()=>{
 let calls=0;const [tool]=yueSetupTools(async()=>{calls++;return {error:'Q8_0 setup already running; wait or cancel.'};});
 await assert.rejects(tool.run({action:'install',precision:'q4_0',accepted_terms:true}),/already running/);
 assert.equal(calls,1);
});
