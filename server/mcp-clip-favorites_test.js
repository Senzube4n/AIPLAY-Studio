/** Execute actual MCP tool bodies with a mocked API, never a live Studio. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./mcp.js',import.meta.url),'utf8');
const start=source.lastIndexOf('\n  {',source.indexOf('name: "list_clips"'));
const end=source.lastIndexOf('\n  {',source.indexOf('name: "restyle_clip"'));
const safeName=(name)=>{if(typeof name!=='string'||!name||/[\\/]/.test(name)||name.includes('..'))throw Error('Bad clip name');return name;};
const tools=api=>new Function('api','safeName',`return [${source.slice(start,end)}];`)(api,safeName);

test('list_clips exposes strict starred booleans, preserves checkpoint receipts and filters before limiting',async()=>{
  const calls=[],receipt={file:'h3.safetensors',ranBuild:'auto'},rows=[{name:'plain.mp4',meta:{h3Checkpoint:receipt}},
    {name:'favorite.webm',starred:true,meta:{h3Checkpoint:receipt}},{name:'legacy.mp4'},{name:'also.mov',starred:true},
    {name:'not-boolean.mp4',starred:'true'}];
  const list=tools(async(method,route)=>{calls.push({method,route});return {clips:rows};})[0];
  assert.equal(list.name,'list_clips');assert.equal(list.inputSchema.properties.starred_only.type,'boolean');
  const all=await list.run({});
  assert.deepEqual(all.map(r=>r.starred),[false,true,false,true,false]);
  assert.deepEqual(all[0].h3_checkpoint,receipt);assert.equal(all[2].h3_checkpoint,null);
  assert.deepEqual((await list.run({starred_only:true,limit:1})).map(r=>r.name),['favorite.webm']);
  assert.deepEqual((await list.run({starred_only:false,limit:2})).map(r=>r.name),['plain.mp4','favorite.webm']);
  assert.ok(calls.every(c=>c.method==='GET'&&c.route==='/api/clips'));
  const failed=tools(async()=>({error:'The favorites file is damaged.'}))[0];
  await assert.rejects(failed.run({starred_only:true}),/damaged/,'storage errors cannot masquerade as an empty library');
});

test('clip_favorite forwards both booleans to the shared flag route, validates input and propagates refusal',async()=>{
  const calls=[],favorite=tools(async(method,route,body)=>{calls.push({method,route,body});return {ok:true,name:body.name,starred:body.value};})[1];
  assert.equal(favorite.name,'clip_favorite');assert.deepEqual(favorite.inputSchema.required,['name','starred']);
  for(const starred of [true,false]) assert.deepEqual(await favorite.run({name:'favorite.mp4',starred}),{name:'favorite.mp4',starred});
  assert.deepEqual(calls.map(c=>c.body),[true,false].map(value=>({action:'flag',flag:'starred',name:'favorite.mp4',value})));
  assert.ok(calls.every(c=>c.method==='POST'&&c.route==='/api/clips'));
  await assert.rejects(favorite.run({name:'../other.mp4',starred:true}),/Bad clip name/);
  await assert.rejects(favorite.run({name:'favorite.mp4',starred:'false'}),/true or false/);
  assert.equal(calls.length,2);
  const refused=tools(async()=>({error:'Favorites file is damaged.'}))[1];
  await assert.rejects(refused.run({name:'favorite.mp4',starred:true}),/damaged/);
  const router=readFileSync(new URL('./chat/router.js',import.meta.url),'utf8');
  assert.match(router,/clip_favorite: null,/,'reversible preference edits are available to chat');
});
