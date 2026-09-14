import test from 'node:test';
import assert from 'node:assert/strict';
import {yueSetupTools} from './mcp-yue-setup.js';
test('MCP default is a read-only status request',async()=>{
 let calls=[];const [tool]=yueSetupTools(async(...args)=>{calls.push(args);return {ok:true};});
 await tool.run({});assert.deepEqual(calls,[['GET','/api/music-gguf/setup',undefined]]);
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
});
