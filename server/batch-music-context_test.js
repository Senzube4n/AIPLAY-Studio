import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBatchMusicBridge} from './batch-music-context.js';
import {prepareGgufJob} from './music-gguf-input.js';

test('overnight uses the normal music door with temporary trusted metadata',async()=>{
  let token;
  const bridge=createBatchMusicBridge({submit:async(url,body,actor,headers)=>{
    assert.equal(url,'/api/generate'); assert.equal(actor,'agent:test');
    assert.equal(body.engine,'yue2-gguf'); assert.equal(body.lyrics,'[Verse]\nhello  \n');
    assert.equal(Object.hasOwn(body,'confirmSpend'),false);
    for(const key of ['batchId','stages','paidConfirmed','actor']) assert.equal(Object.hasOwn(body,key),false);
    token=headers['x-aiplay-batch-call'];
    assert.deepEqual(bridge.metadata({headers}),{batchId:'night',stages:{cover:false},paidConfirmed:true});
    assert.throws(()=>bridge.metadata({headers:{'x-aiplay-batch-call':'forged'}}),/expired/);
    return {job:{id:'job-one'}};
  }});
  assert.deepEqual(await bridge.enqueue({engine:'yue2-gguf',lyrics:'[Verse]\nhello  \n',caption:'Dance',
    batchId:'night',stages:{cover:false},actor:'agent:test',paidConfirmed:true}),{id:'job-one'});
  assert.throws(()=>bridge.metadata({headers:{'x-aiplay-batch-call':token}}),/expired/);
});
test('failed submissions revoke tokens and preserve refusals',async()=>{
  let headers;
  const bridge=createBatchMusicBridge({submit:async(_url,body,_actor,h)=>{
    headers=h; assert.equal(Object.hasOwn(body,'confirmSpend'),false); throw new Error('Native model missing');
  }});
  await assert.rejects(bridge.enqueue({caption:'Dance',batchId:'night',stages:{},paidConfirmed:false}),/Native model missing/);
  assert.throws(()=>bridge.metadata({headers}),/expired/);
  assert.deepEqual(bridge.metadata({headers:{}}),{});
});
test('a queued job survives a lost HTTP acknowledgement without retrying',async()=>{
  const job={id:'owned-before-ack'};
  const bridge=createBatchMusicBridge({submit:async(_url,_body,_actor,headers)=>{
    const req={headers}; bridge.metadata(req);bridge.beforeQueue(req);bridge.record(req,job);
    throw new Error('Connection closed before acknowledgement');
  }});
  assert.equal(await bridge.enqueue({caption:'Dance',batchId:'night'}),job);
});
test('a lost acknowledgement before queueing revokes both new and already-preparing requests',async()=>{
  let request;
  const bridge=createBatchMusicBridge({submit:async(_url,_body,_actor,headers)=>{
    request={headers};bridge.metadata(request);throw new Error('Cover preparation outlived the connection');
  }});
  await assert.rejects(bridge.enqueue({caption:'Dance',batchId:'night'}),error=>error.definitelyNotQueued===true);
  assert.throws(()=>bridge.beforeQueue(request),/expired/);
  assert.throws(()=>bridge.metadata({headers:request.headers}),/expired/);
  assert.throws(()=>bridge.beforeQueue({headers:request.headers}),/expired/);
  assert.doesNotThrow(()=>bridge.beforeQueue({headers:{}}));
});
test('native batches pass the strict real GGUF boundary even in a mixed paid night',async()=>{
  const bridge=createBatchMusicBridge({submit:async(_url,body)=>{
    const spec=prepareGgufJob(body,'agent:test');
    assert.equal(spec.engine,'yue2-gguf'); assert.equal(spec.seed,123);
    assert.equal(spec.lyrics,'[Verse]\nhello  \n'); return {job:{id:'native'}};
  }});
  assert.equal((await bridge.enqueue({engine:'yue2-gguf',caption:'Dance',lyrics:'[Verse]\nhello  \n',seed:123,
    batchId:'night',stages:{cover:false},actor:'agent:test',paidConfirmed:true})).id,'native');
});
test('only a consented hosted MiniMax step carries confirmSpend in request JSON',async()=>{
  const received=[];
  const bridge=createBatchMusicBridge({submit:async(_url,body)=>{received.push(body);return {job:{id:'hosted'}};}});
  await bridge.enqueue({engine:'minimax-music3',caption:'Dance',paidConfirmed:true});
  await bridge.enqueue({engine:'minimax-music3',caption:'Dance',paidConfirmed:false});
  assert.equal(received[0].confirmSpend,true);
  assert.equal(Object.hasOwn(received[1],'confirmSpend'),false);
});
