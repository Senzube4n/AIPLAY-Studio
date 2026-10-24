import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createHuggingFaceLogin,HUGGINGFACE_OAUTH_KEY,HUGGINGFACE_CLIENT_ID,HUGGINGFACE_CALLBACK_PATH,HUGGINGFACE_SCOPE} from './huggingface-login.js';

const ORIGIN='http://127.0.0.1:4211',ACCESS='hf_oauth_fixtureAccess1234567890',REFRESH='fixture_refresh_secret_1234567890';
const response=(overrides={})=>Response.json({token_type:'bearer',access_token:ACCESS,expires_in:3600,scope:'gated-repos',...overrides});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(setImmediate);assert(predicate(),'Fixture did not reach its expected boundary.');}
function fixture({fetchFn=async()=>response(),timeoutMs=1000}={}){
  let time=1_800_000_000_000;const store=new Map([['MODEL_HUGGINGFACE_TOKEN','hf_priorTypedKey1234567890']]),calls=[];
  const secrets={get:async key=>store.get(key)??null,set:async(key,value)=>{store.set(key,value);},clear:async key=>{store.delete(key);},
    status:async key=>({set:store.has(key),usable:store.has(key),method:'dpapi',encrypted:true,protection:'Windows DPAPI',savedAt:new Date(time).toISOString(),savedHere:true,hint:REFRESH,value:ACCESS})};
  const login=createHuggingFaceLogin({secrets,now:()=>time,timeoutMs,fetchFn:async(url,init)=>{calls.push({url,init,body:new URLSearchParams(init.body)});return fetchFn(url,init);}});
  const callback=(started,changes={},origin=ORIGIN)=>{
    const auth=new URL(started.authorizationUrl),url=new URL(auth.searchParams.get('redirect_uri'));
    url.search=new URLSearchParams({state:auth.searchParams.get('state'),code:'fixture_authorization_code_1234',...changes}).toString();
    return login.callback(url.href,origin);
  };
  return {login,secrets,store,calls,callback,advance:ms=>{time+=ms;},setTime:value=>{time=value;}};
}
function publicOnly(value,...other){
  const serialized=JSON.stringify(value);
  for(const secret of [ACCESS,REFRESH,...other])assert(!serialized.includes(secret),'Public response disclosed a secret.');
  assert(!serialized.includes('authorizationUrl'),'Ordinary status must not repeat the one-time browser URL.');
}

test('public CIMD is secretless and registers the exact portless loopback callback paths',async()=>{
  const doc=JSON.parse(await readFile(new URL('../docs/.well-known/oauth-cimd.json',import.meta.url)));
  assert.equal(doc.client_id,HUGGINGFACE_CLIENT_ID);assert.equal(doc.client_name,'AIPLAY Studio');assert.equal(doc.token_endpoint_auth_method,'none');
  assert.deepEqual(doc.redirect_uris,['http://127.0.0.1'+HUGGINGFACE_CALLBACK_PATH,'http://localhost'+HUGGINGFACE_CALLBACK_PATH]);
  assert(!Object.keys(doc).some(key=>/secret|token$/.test(key)));assert.equal(HUGGINGFACE_SCOPE,'gated-repos');
});

test('PKCE browser login saves a separate protected OAuth grant, never a browser token or private-repo scope',async()=>{
  const f=fixture({fetchFn:async()=>response({refresh_token:REFRESH})}),start=await f.login.start(ORIGIN),url=new URL(start.authorizationUrl);
  assert.equal(start.state,'waiting');assert.equal(f.calls.length,0);assert.equal(url.origin+url.pathname,'https://huggingface.co/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'),HUGGINGFACE_CLIENT_ID);assert.equal(url.searchParams.get('scope'),'gated-repos');
  assert.equal(url.searchParams.get('response_type'),'code');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('redirect_uri'),ORIGIN+HUGGINGFACE_CALLBACK_PATH);assert.equal(url.searchParams.get('state').length,43);
  publicOnly(await f.login.status(),url.searchParams.get('state'));assert.equal((await f.callback(start)).ok,true);
  assert.equal(f.calls.length,1);const call=f.calls[0];assert.equal(call.url,'https://huggingface.co/oauth/token');assert.equal(call.init.redirect,'error');
  assert.equal(call.body.get('grant_type'),'authorization_code');assert.equal(call.body.get('client_id'),HUGGINGFACE_CLIENT_ID);assert.equal(call.body.has('client_secret'),false);
  assert.equal(call.body.get('redirect_uri'),ORIGIN+HUGGINGFACE_CALLBACK_PATH);
  assert.equal(createHash('sha256').update(call.body.get('code_verifier')).digest('base64url'),url.searchParams.get('code_challenge'));
  assert.equal(f.store.get('MODEL_HUGGINGFACE_TOKEN'),'hf_priorTypedKey1234567890');assert(f.store.has(HUGGINGFACE_OAUTH_KEY));
  const credential=await f.login.credential(),status=await f.login.status();assert.equal(credential.token,ACCESS);assert.equal(credential.auth.kind,'oauth');
  assert.match(credential.signature,/^[0-9a-f]{64}$/);assert.equal(status.state,'connected');assert.equal(status.auth.encrypted,true);
  assert.equal(status.auth.said,'Signed in with Hugging Face.');assert.equal(status.auth.expiresAt,status.expiresAt);assert.equal(status.auth.hint,undefined);
  publicOnly(status,url.searchParams.get('state'),call.body.get('code_verifier'));assert.equal(f.calls.length,1);
});

test('wrong origin/state, Unicode state and duplicate query fields never exchange a code; valid callbacks are one use',async()=>{
  const f=fixture();for(const origin of ['https://127.0.0.1:4211','http://evil.example:4211','http://127.0.0.1:4211/path'])await assert.rejects(f.login.start(origin),/this PC/);
  const start=await f.login.start(ORIGIN);assert.equal((await f.callback(start,{state:'wrong'})).ok,false);
  assert.equal((await f.callback(start,{state:'é'.repeat(43)})).ok,false);assert.equal((await f.callback(start,{},'http://localhost:4211')).ok,false);
  const correct=new URL(start.authorizationUrl),url=new URL(correct.searchParams.get('redirect_uri'));
  url.search=new URLSearchParams({state:correct.searchParams.get('state'),code:'fixture_valid_code'});url.searchParams.append('state',correct.searchParams.get('state'));
  assert.equal((await f.login.callback(url.href,ORIGIN)).ok,false);assert.equal(f.calls.length,0);
  assert.equal((await f.callback(start)).ok,true);assert.equal((await f.callback(start)).ok,false);assert.equal(f.calls.length,1);
});

test('pending requests expire at ten minutes; replacement/cancel invalidates old callbacks',async()=>{
  const f=fixture(),expired=await f.login.start(ORIGIN);f.advance(10*60_000);
  assert.equal((await f.callback(expired)).ok,false);assert.equal((await f.login.status()).state,'expired');
  const old=await f.login.start(ORIGIN),current=await f.login.start(ORIGIN);
  assert.equal((await f.callback(old)).ok,false);assert.equal((await f.login.cancel()).state,'cancelled');assert.equal((await f.callback(current)).ok,false);
  assert.equal(f.calls.length,0);publicOnly(await f.login.status());
});

test('browser denial is safe, one-use and never sends a token request',async()=>{
  const f=fixture(),start=await f.login.start(ORIGIN);
  const denied=await f.callback(start,{error:'access_denied',error_description:'diagnostic '+ACCESS,error_uri:'https://evil.example/'+REFRESH});
  assert.equal(denied.ok,false);assert.equal((await f.login.status()).state,'denied');assert.equal(f.calls.length,0);
  publicOnly(denied);publicOnly(await f.login.status());assert.equal((await f.callback(start)).ok,false);
});

test('omitted scope retains exactly the requested gated scope and safe another-copy provenance',async()=>{
  const f=fixture({fetchFn:async()=>response({scope:undefined})}),original=f.secrets.status;
  f.secrets.status=async key=>({...await original(key),savedHere:false,savedBy:'other-copy'});
  assert.equal((await f.callback(await f.login.start(ORIGIN))).ok,true);
  assert.equal(JSON.parse(f.store.get(HUGGINGFACE_OAUTH_KEY)).scope,'gated-repos');
  assert.equal((await f.login.status()).auth.said,'Signed in with Hugging Face. Saved by another copy of Studio.');
  publicOnly(await f.login.status());
});

test('token schemas and exact gated scope are enforced before storage, with bounded safe provider errors',async()=>{
  const variants=[()=>response({token_type:'mac'}),()=>response({access_token:'arbitrary-bearer-string'}),()=>response({access_token:'hf_oauth_'+('x'.repeat(500))}),
    ()=>response({expires_in:0}),()=>response({expires_in:'3600'}),()=>response({scope:'gated-repos read-repos'}),()=>response({scope:'openid profile gated-repos'}),
    ()=>response({scope:null}),()=>response({refresh_token:'bad\r\n'+REFRESH}),()=>new Response('x'.repeat(16_385)),
    ()=>new Response(null,{status:302,headers:{location:'https://evil.example'}}),()=>Response.json({error:'invalid_request',error_description:'internal '+ACCESS},{status:400}),
    ()=>{throw Error('transport diagnostic '+ACCESS);}];
  for(const provider of variants){const f=fixture({fetchFn:async()=>provider()}),start=await f.login.start(ORIGIN),result=await f.callback(start);
    assert.equal(result.ok,false);assert.equal(f.store.has(HUGGINGFACE_OAUTH_KEY),false);publicOnly(result);publicOnly(await f.login.status());
    assert.equal(f.calls.length,1);}
});

test('provider request and body timeouts are bounded even if a mock transport ignores abort',async()=>{
  for(const fetchFn of [()=>new Promise(()=>{}),async()=>new Response(new ReadableStream({start(){}}))]){
    const f=fixture({fetchFn,timeoutMs:10}),start=await f.login.start(ORIGIN),started=Date.now();
    assert.equal((await f.callback(start)).ok,false);assert(Date.now()-started<1000);assert.equal(f.store.has(HUGGINGFACE_OAUTH_KEY),false);publicOnly(await f.login.status());
  }
});

test('offline status never refreshes; explicit renewal coalesces and stores rotated refresh metadata',async()=>{
  const gate=deferred();let calls=0;
  const f=fixture({fetchFn:async()=>++calls===1?response({refresh_token:REFRESH}):gate.promise});
  await f.callback(await f.login.start(ORIGIN));const first=await f.login.credential();f.advance(3_600_001);
  const expired=await f.login.status();assert.equal(expired.state,'expired');assert.equal(expired.auth.usable,true);assert.equal(expired.auth.renewable,true);
  assert.equal(await f.login.credential(),null);assert.equal(f.calls.length,1);
  const a=f.login.credential({refresh:true}),b=f.login.credential({refresh:true});await until(()=>f.calls.length===2);
  assert.equal((await f.login.status()).state,'refreshing');
  const renewed='hf_oauth_renewedFixtureAccess1234567890';gate.resolve(response({access_token:renewed,scope:undefined,refresh_token:'rotated_refresh_secret_123456'}));
  const [ca,cb]=await Promise.all([a,b]);assert.equal(ca.token,renewed);assert.equal(cb.token,renewed);assert.notEqual(ca.signature,first.signature);
  assert.notEqual(ca.auth.expiresAt,first.auth.expiresAt);assert.equal(f.calls[1].body.get('grant_type'),'refresh_token');assert.equal(f.calls[1].body.get('refresh_token'),REFRESH);
  assert.equal(f.calls.length,2);publicOnly(await f.login.status(),renewed,'rotated_refresh_secret_123456');
});

test('a grant without refresh expires honestly, and a rejected refresh requires sign-in',async()=>{
  const f=fixture();await f.callback(await f.login.start(ORIGIN));f.advance(3_600_001);
  assert.equal(await f.login.credential({refresh:true}),null);assert.equal((await f.login.status()).auth.usable,false);assert.equal(f.calls.length,1);
  let calls=0;const rejected=fixture({fetchFn:async()=>++calls===1?response({refresh_token:REFRESH}):Response.json({error:'invalid_grant',error_description:ACCESS},{status:400})});
  await rejected.callback(await rejected.login.start(ORIGIN));rejected.advance(3_600_001);assert.equal(await rejected.login.credential({refresh:true}),null);
  const status=await rejected.login.status();assert.match(status.message,/expired or was revoked/);assert.equal(status.auth.usable,false);
  assert.equal(rejected.store.has(HUGGINGFACE_OAUTH_KEY),false);assert.equal(rejected.store.get('MODEL_HUGGINGFACE_TOKEN'),'hf_priorTypedKey1234567890');
  assert.equal(await rejected.login.credential({refresh:true}),null);assert.equal(rejected.calls.length,2,'A known rejected refresh is not retried');publicOnly(await rejected.login.status());
});

test('transient renewal failures remain retryable while known rejection stays unusable even if clearing fails',async()=>{
  let count=0;const f=fixture({fetchFn:async()=>++count===1?response({refresh_token:REFRESH}):count===2?Promise.reject(Error(ACCESS)):response()});
  await f.callback(await f.login.start(ORIGIN));f.advance(3_600_001);assert.equal(await f.login.credential({refresh:true}),null);
  assert.equal((await f.login.status()).auth.usable,true);assert.equal((await f.login.credential({refresh:true})).token,ACCESS);
  let rejectedCount=0;const rejected=fixture({fetchFn:async()=>++rejectedCount===1?response({refresh_token:REFRESH}):Response.json({error:'invalid_grant'},{status:400})});
  await rejected.callback(await rejected.login.start(ORIGIN));rejected.advance(3_600_001);rejected.secrets.clear=async()=>{throw Error('vault '+ACCESS);};
  assert.equal(await rejected.login.credential({refresh:true}),null);assert.equal((await rejected.login.status()).auth.usable,false);
  assert.equal(await rejected.login.credential({refresh:true}),null);assert.equal(rejected.calls.length,2);publicOnly(await rejected.login.status());
});

test('forget failure throws only a fixed safe message and preserves the separate PAT',async()=>{
  const f=fixture();await f.callback(await f.login.start(ORIGIN));f.secrets.clear=async()=>{throw Error('vault diagnostic '+ACCESS+' '+REFRESH);};
  await assert.rejects(f.login.forget(),error=>error.message==='Could not remove the saved Hugging Face connection. Try again.');
  assert(f.store.has(HUGGINGFACE_OAUTH_KEY));assert.equal(f.store.get('MODEL_HUGGINGFACE_TOKEN'),'hf_priorTypedKey1234567890');
  assert.equal((await f.login.status()).state,'error');publicOnly(await f.login.status());
});

test('cancel during exchange prevents resurrection even after the provider later returns a token',async()=>{
  const gate=deferred(),f=fixture({fetchFn:()=>gate.promise}),start=await f.login.start(ORIGIN),callback=f.callback(start);
  await until(()=>f.calls.length===1);assert.equal((await f.login.cancel()).state,'cancelled');assert.equal((await callback).ok,false);
  gate.resolve(response({refresh_token:REFRESH}));await new Promise(setImmediate);assert.equal(f.store.has(HUGGINGFACE_OAUTH_KEY),false);publicOnly(await f.login.status());
});

test('forget while protected storage is awaiting cannot resurrect a connection or clear the separate PAT',async()=>{
  const gate=deferred(),f=fixture(),original=f.secrets.set;let entered=false;
  f.secrets.set=async(...args)=>{entered=true;await gate.promise;return original(...args);};
  const callback=f.callback(await f.login.start(ORIGIN));await until(()=>entered);
  const forget=f.login.forget();gate.resolve();assert.equal((await callback).ok,false);assert.equal((await forget).state,'signed-out');
  assert.equal(f.store.has(HUGGINGFACE_OAUTH_KEY),false);assert.equal(f.store.get('MODEL_HUGGINGFACE_TOKEN'),'hf_priorTypedKey1234567890');
});

test('cancel during a protected replacement write restores the prior grant, not the cancelled new token',async()=>{
  const f=fixture();await f.callback(await f.login.start(ORIGIN));const baseline=f.store.get(HUGGINGFACE_OAUTH_KEY),gate=deferred(),original=f.secrets.set;let entered=false;
  f.advance(1000);
  f.secrets.set=async(...args)=>{if(!entered){entered=true;await gate.promise;}return original(...args);};
  const callback=f.callback(await f.login.start(ORIGIN));await until(()=>entered);const cancel=f.login.cancel();gate.resolve();
  assert.equal((await callback).ok,false);await cancel;assert.equal(f.store.get(HUGGINGFACE_OAUTH_KEY),baseline);
});

test('forget during refresh and changes by another writer cannot resurrect or replace newer credentials',async()=>{
  let calls=0;const gate=deferred(),f=fixture({fetchFn:async()=>++calls===1?response({refresh_token:REFRESH}):gate.promise});
  await f.callback(await f.login.start(ORIGIN));f.advance(3_600_001);const refreshing=f.login.credential({refresh:true});await until(()=>f.calls.length===2);
  await f.login.forget();assert.equal(await refreshing,null);gate.resolve(response());await new Promise(setImmediate);assert.equal(f.store.has(HUGGINGFACE_OAUTH_KEY),false);
  const other=fixture(),start=await other.login.start(ORIGIN);other.store.set(HUGGINGFACE_OAUTH_KEY,'foreign opaque record');
  assert.equal((await other.callback(start)).ok,false);assert.equal(other.store.get(HUGGINGFACE_OAUTH_KEY),'foreign opaque record');
});

test('protected store failures, malformed records and public status never expose raw diagnostics',async()=>{
  for(const method of ['get','status','set']){
    const f=fixture(),start=await f.login.start(ORIGIN);f.secrets[method]=async()=>{throw Error('vault diagnostic '+ACCESS+' '+REFRESH);};
    publicOnly(await f.callback(start));publicOnly(await f.login.status());assert.equal(await f.login.credential(),null);
  }
  const f=fixture();f.store.set(HUGGINGFACE_OAUTH_KEY,JSON.stringify({version:1,accessToken:ACCESS,refreshToken:false,expiresAt:9e15,scope:'gated-repos'}));
  assert.equal(await f.login.credential({refresh:true}),null);publicOnly(await f.login.status());assert.equal(f.calls.length,0);
});
