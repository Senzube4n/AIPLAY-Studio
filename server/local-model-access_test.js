import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root=await mkdtemp(path.join(tmpdir(),'aiplay-ltx-access-'));
process.env.AIPLAY_APPDATA=root;process.env.AIPLAY_MODELS_DIR=root;
const {createLocalModelAccessRoutes,checkLocalLtxAccess,LOCAL_MODEL_ACCESS_KEY}=await import('./local-model-access.js');
const {ModelManager,CATALOG,authorizeLocalLtxDownload}=await import('./models.js');
const {MODEL_BUNDLES}=await import('../shared/model-bundles.js');
const TOKEN='hf_fixtureOnly1234567890ABCDEFGHIJK',HERE='127.0.0.1:4211';
const hash=b=>createHash('sha256').update(b).digest('hex');
test.after(()=>rm(root,{recursive:true,force:true}));

function fixture({fetchFn=async()=>new Response(null,{status:200}),free=50e9,statusError=false,enabled=true,onDisk=null,downloadError=null,login=null}={}) {
  const keys=new Map(),calls={network:0,downloads:[],cancelled:0,bodyCaps:[]};let release;
  const secrets={get:async k=>keys.get(k)||null,set:async(k,v)=>keys.set(k,v),clear:async k=>keys.delete(k),status:async k=>{
    if(statusError)throw Error(TOKEN);
    const value=keys.get(k);return value?{set:true,usable:true,method:'dpapi',encrypted:true,hint:'…'+value.slice(-4),said:'Using a saved key.',protection:'Windows DPAPI',savedAt:'2026-10-23T00:00:00Z',value}:{set:false,method:null};
  }};
  const models={status:async()=>[{id:'videoLtx',totalBytes:MODEL_BUNDLES.ltx25.totalBytes,haveBytes:0,ready:false}],
    download:(id,options)=>{calls.downloads.push({id,options});return downloadError?Promise.reject(Error(downloadError)):new Promise(r=>{release=r;});},cancel:id=>{assert.equal(id,'videoLtx');calls.cancelled++;release?.({cancelled:true});}};
  const route=createLocalModelAccessRoutes({json:(res,status,body)=>Object.assign(res,{status,body}),
    readBody:async(req,max)=>{calls.bodyCaps.push(max);if(req.tooBig){const e=Error('big');e.tooBig=true;throw e;}return req.body;},
    sameOriginLocalJson:req=>req.headers.host===HERE&&(!req.headers.origin||req.headers.origin==='http://'+HERE)&&req.headers['content-type']==='application/json',
    models,secrets,login,modelsDir:()=>root,diskFree:async()=>{await onDisk?.(keys);return {freeBytes:free,totalBytes:100e9};},uiPort:4211,enabled:()=>enabled,
    fetchFn:async(...args)=>{calls.network++;return fetchFn(...args);}});
  async function call(method='GET',body=null,headers={},query='?id=videoLtx',tooBig=false,extra={}){
    const res={},req={method,body,tooBig,socket:{remoteAddress:'127.0.0.1'},...extra,headers:{host:HERE,origin:'http://'+HERE,'content-type':'application/json',...headers}};
    assert.equal(await route(req,res,new URL('http://'+HERE+'/api/models/access'+query)),true);
    assert(!JSON.stringify(res.body).includes(TOKEN),'No response may disclose the key');return res;
  }
  return {keys,calls,call,secrets,route,release:()=>release?.({ok:true})};
}

function signedLogin() {
  const token='hf_oauth_fixtureOnly1234567890ABCDEFGHIJK';
  let state='idle',revision=1,connected=false;
  const calls={starts:0,cancels:0,forgets:0,callbacks:0,refreshes:0};
  const auth=()=>({set:connected,usable:connected,method:'dpapi',encrypted:true,kind:'oauth',savedAt:'2026-10-24T00:00:00Z',expiresAt:'2026-10-25T00:00:00Z'});
  const login={status:async()=>({state,auth:auth()}),
    start:async origin=>{assert.equal(origin,'http://'+HERE);calls.starts++;state='waiting';return {authorizationUrl:'https://huggingface.co/oauth/authorize?client_id=fixture'};},
    cancel:async()=>{calls.cancels++;state='cancelled';},
    forget:async()=>{calls.forgets++;connected=false;revision++;state='idle';},
    callback:async(url,origin)=>{assert.equal(url.origin,'http://'+HERE);assert.equal(origin,'http://'+HERE);calls.callbacks++;connected=true;state='connected';return {ok:true,message:token};},
    credential:async({refresh=false}={})=>{if(refresh)calls.refreshes++;return connected?{token,auth:auth(),signature:'server-only-signature-'+revision}:null;}};
  return {login,calls,token,connect(){connected=true;state='connected';},change(){revision++;}};
}

async function callback(f,{headers={},method='GET',extra={}}={}) {
  const res={writeHead(status,h){this.status=status;this.headers=h;},end(body){this.body=body;}};
  const req={method,socket:{remoteAddress:'127.0.0.1'},headers:{host:HERE,'sec-fetch-site':'cross-site','sec-fetch-dest':'document',...headers},...extra};
  // The production router deliberately uses a dummy URL base without a port.
  assert.equal(await f.route(req,res,new URL('/api/models/access/callback?code=fake-code&state=fake-state','http://localhost')),true);
  return res;
}

test('browser login starts only from this PC and status never returns its authorization data or credentials',async()=>{
  const s=signedLogin(),f=fixture({login:s.login});
  assert.equal((await f.call()).body.oauth.state,'idle');assert.equal(s.calls.starts,0);assert.equal(f.calls.network,0);
  for(const extra of [{lanClient:true},{socket:{remoteAddress:'192.168.1.2'}}])
    assert.equal((await f.call('POST',{id:'videoLtx',action:'login'},{},'?id=videoLtx',false,extra)).status,403);
  assert.equal(s.calls.starts,0);
  const start=await f.call('POST',{id:'videoLtx',action:'login'});assert.equal(start.status,200);assert.match(start.body.oauth.authorizationUrl,/^https:\/\/huggingface.co\/oauth\/authorize/);
  const status=(await f.call()).body;assert.equal(status.oauth.state,'waiting');assert.equal(status.oauth.authorizationUrl,undefined);assert.equal(status.auth.value,undefined);assert.equal(f.calls.network,0);
  const cancel=await f.call('POST',{id:'videoLtx',action:'login-cancel'});assert.equal(cancel.body.oauth.state,'cancelled');assert.equal(s.calls.cancels,1);
});

test('OAuth callback alone permits provider navigation, checks fixed files once and emits a code-free page',async()=>{
  const s=signedLogin(),seen=[],f=fixture({login:s.login,fetchFn:async(url,init)=>{seen.push(init.headers.Authorization);return new Response(null,{status:200});}});
  const result=await callback(f);assert.equal(result.status,200);assert.match(result.body,/Signed in/);assert(!result.body.includes(s.token));assert(!result.body.includes('fake-code'));assert(!result.body.includes('fake-state'));
  assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(result.headers['Referrer-Policy'],'no-referrer');assert.match(result.headers['Content-Security-Policy'],/default-src 'none'/);
  assert.equal(f.calls.network,5);assert(seen.every(v=>v==='Bearer '+s.token));assert.equal(f.calls.downloads.length,0,'Sign-in never installs a model');
  const status=(await f.call()).body;assert.equal(status.auth.kind,'oauth');assert.equal(status.access.state,'granted');assert.equal(status.oauth.auth,undefined);assert(!JSON.stringify(status).includes('server-only-signature'));assert(!JSON.stringify(status).includes(s.token));assert.equal(f.calls.network,5,'Saved GET status never repeats HEAD or refresh');
  for(const options of [{method:'POST'},{extra:{lanClient:true}},{extra:{socket:{remoteAddress:'192.168.1.2'}}},{headers:{origin:'https://evil.example'}},{headers:{'sec-fetch-dest':'iframe'}}])assert.equal((await callback(f,options)).status,403);
  assert.equal(s.calls.callbacks,1);
});

test('OAuth preserves native terms and stale-credential guards, and manual fallback explicitly replaces the login',async()=>{
  const s=signedLogin();s.connect();const f=fixture({login:s.login,onDisk:()=>s.change()});
  assert.equal((await f.call('POST',{id:'videoLtx',action:'install'})).status,400);assert.equal(f.calls.network,0);
  const changed=await f.call('POST',{id:'videoLtx',action:'install',acceptLicense:true});assert.equal(changed.status,409);assert.equal(changed.body.reason,'credentials-changed');assert.equal(f.calls.downloads.length,0);
  const plain=fixture({login:s.login});const replace=await plain.call('POST',{id:'videoLtx',action:'connect',token:TOKEN});assert.equal(replace.status,200);assert.equal(s.calls.forgets,1);assert.equal(plain.keys.get(LOCAL_MODEL_ACCESS_KEY),TOKEN);assert.notEqual(replace.body.auth.kind,'oauth');
});

test('disconnect removes the selected credential and a failed OAuth removal preserves the manual token',async()=>{
  const s=signedLogin();s.connect();const f=fixture({login:s.login});f.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);
  const forget=s.login.forget;s.login.forget=async()=>{throw Error('vault '+TOKEN);};
  const failed=await f.call('POST',{id:'videoLtx',action:'forget'});assert.equal(failed.status,503);assert.equal(failed.body.reason,'disconnect-failed');assert.equal(f.keys.get(LOCAL_MODEL_ACCESS_KEY),TOKEN);assert(!JSON.stringify(failed.body).includes('vault'));
  s.login.forget=forget;
  const disconnected=await f.call('POST',{id:'videoLtx',action:'forget'});assert.equal(disconnected.status,200);assert.equal(f.keys.get(LOCAL_MODEL_ACCESS_KEY),TOKEN);assert.equal(disconnected.body.access.state,'unchecked');assert.notEqual(disconnected.body.auth.kind,'oauth');
  await f.call('POST',{id:'videoLtx',action:'forget'});assert.equal(f.keys.size,0);
});

test('failure to resolve an expired grant clears previously granted access before responding',async()=>{
  const s=signedLogin();s.connect();const f=fixture({login:s.login});
  assert.equal((await f.call('POST',{id:'videoLtx',action:'check'})).body.access.state,'granted');
  s.login.credential=async()=>null;
  const failed=await f.call('POST',{id:'videoLtx',action:'check'});assert.equal(failed.status,401);assert.notEqual(failed.body.access.state,'granted');
  assert.notEqual((await f.call()).body.access.state,'granted');assert.equal(f.calls.downloads.length,0);
});

test('forget invalidates a first pending login even before it has saved a grant',async()=>{
  const s=signedLogin(),f=fixture({login:s.login});
  await f.call('POST',{id:'videoLtx',action:'login'});
  assert.equal((await f.call()).body.oauth.state,'waiting');
  await f.call('POST',{id:'videoLtx',action:'forget'});
  assert.equal(s.calls.forgets,1,'Pending login must use the same invalidating removal path as a saved grant');
  assert.equal((await f.call()).body.oauth.state,'idle');
});

test('status is offline, reuses only the explicit vault key and exposes no key value',async()=>{
  const f=fixture();
  // Inject only this process's fake value; never read a pre-existing credential.
  // The dedicated test process and its environment are discarded on exit.
  Object.assign(process.env,{HF_TOKEN:TOKEN});
  assert.equal((await f.call()).body.auth.set,false);assert.equal(f.calls.network,0);
  assert.equal((await f.call('POST',{id:'videoLtx',action:'check'})).status,401);assert.equal(f.calls.network,0,'HF environment is not imported');
  f.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);const s=(await f.call()).body;
  assert.equal(s.auth.set,true);assert.equal(s.auth.encrypted,true);assert.equal(s.auth.value,undefined);assert.equal(s.access.state,'unchecked');assert.equal(f.calls.network,0);
});

test('local Host/Origin/JSON, body bound, exact model and action schema are enforced before credentials or network',async()=>{
  const f=fixture();
  for(const headers of [{host:'evil.example:4211'},{host:'localhost:9999'},{origin:'https://evil.example'}])assert.equal((await f.call('GET',null,headers)).status,403);
  assert.equal((await f.call('POST',{id:'videoLtx',action:'connect',token:TOKEN},{'content-type':'text/plain'})).status,403);
  for(const body of [{id:'engine',action:'install',acceptLicense:true},{id:'videoLtx',action:'connect',token:TOKEN,url:'https://evil.example'},{id:'videoLtx',action:'install',acceptLicense:true,path:root}])assert.equal((await f.call('POST',body)).status,400);
  assert.equal((await f.call('GET',null,{},'?token='+TOKEN)).status,400);
  assert.equal((await f.call('POST',{id:'videoLtx',action:'connect',token:TOKEN},{},'?id=videoLtx',true)).status,413);
  assert(f.calls.bodyCaps.every(n=>n===4096));assert.equal(f.keys.size,0);assert.equal(f.calls.network,0);
  const remote=fixture({enabled:false});assert.equal((await remote.call()).status,409);assert.equal(remote.calls.network,0);
});

test('connection checks all pinned files with HEAD; subsequent GET is still offline',async()=>{
  const seen=[],f=fixture({fetchFn:async(url,init)=>{seen.push([url,init]);return new Response(null,{status:200});}});
  const out=await f.call('POST',{id:'videoLtx',action:'connect',token:TOKEN});
  assert.equal(out.status,200);assert.equal(out.body.auth.set,true);assert.equal(out.body.access.state,'granted');
  assert.deepEqual(seen.map(r=>r[0]),MODEL_BUNDLES.ltx25.files.map(f=>f.url));
  assert(seen.every(([,i])=>i.method==='HEAD'&&i.headers.Authorization==='Bearer '+TOKEN&&i.redirect==='manual'));
  await f.call();assert.equal(f.calls.network,5);assert.equal(f.calls.downloads.length,0);
});

test('bearer stays on pinned publisher first hop and is stripped from CDN redirects',async()=>{
  const seen=[];
  await checkLocalLtxAccess(TOKEN,{fetchFn:async(url,init)=>{seen.push([url,init.headers]);return new URL(url).hostname==='huggingface.co'
    ?new Response(null,{status:302,headers:{location:'https://cdn-lfs.huggingface.co/fixture.bin'}}):new Response(null,{status:200});}});
  assert.equal(seen.length,10);
  for(const[url,headers]of seen)assert.equal(headers.Authorization,new URL(url).hostname==='huggingface.co'?'Bearer '+TOKEN:undefined);
  let evil=0;await assert.rejects(checkLocalLtxAccess(TOKEN,{fetchFn:async url=>{if(new URL(url).hostname==='evil.example')evil++;return new Response(null,{status:302,headers:{location:'https://evil.example/stolen'}});}}),/Could not check/);assert.equal(evil,0);
});

test('access denials, network errors and status failures are safe and actionable after saving a key',async()=>{
  for(const[status,state]of[[401,'unauthorized'],[403,'access-required'],[429,'rate-limited']]){
    const f=fixture({fetchFn:async()=>new Response(null,{status})});const r=await f.call('POST',{id:'videoLtx',action:'connect',token:TOKEN});
    assert.equal(r.status,status);assert.equal(r.body.auth.set,true);assert.equal(r.body.access.state,state);assert.equal(f.calls.downloads.length,0);
  }
  const f=fixture({fetchFn:async()=>{throw Error('secret '+TOKEN);}}),r=await f.call('POST',{id:'videoLtx',action:'connect',token:TOKEN});
  assert.equal(r.status,503);assert.equal(r.body.access.state,'network');
  assert.equal((await fixture({statusError:true}).call()).status,503);
});

test('post-HEAD vault failures never persist raw diagnostics in the response or later status',async()=>{
  const diagnostic='internal vault failure '+TOKEN;
  for(const method of ['get','status']){
    const f=fixture();f.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);
    const original=f.secrets[method];let reads=0;
    f.secrets[method]=async(...args)=>{if(++reads===2)throw Error(diagnostic);return original(...args);};
    const failed=await f.call('POST',{id:'videoLtx',action:'check'});
    assert.equal(f.calls.network,5,'The transient failure occurs after the publisher HEADs');
    assert.equal(failed.status,500);assert.equal(failed.body.reason,'setup-failed');
    assert.equal(failed.body.access.state,'network');assert.equal(failed.body.access.reason,'setup-failed');
    for(const response of [failed,await f.call()]){
      const serialized=JSON.stringify(response.body);
      assert(!serialized.includes(diagnostic));assert(!serialized.includes('internal vault failure'));
      assert(!serialized.includes(TOKEN));assert.match(response.body.access.message,/Try again/);
    }
    assert.equal(f.calls.downloads.length,0);
  }
});

test('install needs explicit terms and a fresh access check; cancellation and duplicate installs use ordinary Models state',async()=>{
  const f=fixture();f.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);
  assert.equal((await f.call('POST',{id:'videoLtx',action:'install'})).status,400);assert.equal(f.calls.network,0);
  const started=await f.call('POST',{id:'videoLtx',action:'install',acceptLicense:true});
  assert.equal(started.status,202);assert.equal(started.body.installing,true);assert.equal(f.calls.network,5);assert.equal(f.calls.downloads.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.downloads[0])),{id:'videoLtx',options:{localAccess:{}}},'Opaque authorization contains no enumerable token');
  assert.equal((await f.call('POST',{id:'videoLtx',action:'install',acceptLicense:true})).status,409);assert.equal(f.calls.downloads.length,1);
  assert.equal((await f.call('POST',{id:'videoLtx',action:'cancel'})).status,200);assert.equal(f.calls.cancelled,1);
  await new Promise(setImmediate);assert.equal((await f.call('POST',{id:'videoLtx',action:'forget'})).body.auth.set,false);
  const small=fixture({free:1});small.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);
  assert.equal((await small.call('POST',{id:'videoLtx',action:'install',acceptLicense:true})).status,409);assert.equal(small.calls.downloads.length,0);
});

test('a shared key change during publisher checks or disk awaits cannot mint a stale authorization',async()=>{
  const newer='hf_anotherFixture9876543210KLMNOP',waiting=[];
  const f=fixture({fetchFn:()=>new Promise(resolve=>waiting.push(()=>resolve(new Response(null,{status:200}))))});
  f.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);const checking=f.call('POST',{id:'videoLtx',action:'check'});
  for(let i=0;i<100&&waiting.length<5;i++)await new Promise(setImmediate);
  assert.equal(waiting.length,5);f.keys.set(LOCAL_MODEL_ACCESS_KEY,newer);waiting.forEach(release=>release());
  const changed=await checking;assert.equal(changed.status,409);assert.equal(changed.body.reason,'credentials-changed');assert.notEqual(changed.body.access.state,'granted');assert(!JSON.stringify(changed.body).includes(newer));assert.equal(f.calls.downloads.length,0);
  const duringDisk=fixture({onDisk:keys=>keys.set(LOCAL_MODEL_ACCESS_KEY,newer)});duringDisk.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);
  const result=await duringDisk.call('POST',{id:'videoLtx',action:'install',acceptLicense:true});
  assert.equal(result.status,409);assert.equal(result.body.reason,'credentials-changed');assert.equal(duringDisk.calls.downloads.length,0);
});

test('download preflight rejection remains visible without Models progress or leaked diagnostics',async()=>{
  const f=fixture({downloadError:'shared-file conflict '+TOKEN});f.keys.set(LOCAL_MODEL_ACCESS_KEY,TOKEN);
  const started=await f.call('POST',{id:'videoLtx',action:'install',acceptLicense:true});assert([202,409].includes(started.status));
  await new Promise(setImmediate);const status=(await f.call()).body;
  assert.equal(status.install.state,'failed');assert.equal(status.installing,false);assert.match(status.install.message,/resume/);assert(!status.install.message.includes('shared-file conflict'));assert.equal(status.access.state,'granted');
});

test('public downloader and forged/expired permissions cannot bypass gated models',async()=>{
  const m=new ModelManager();
  await assert.rejects(m.download('videoLtx'),/Optional LTX/);
  await assert.rejects(m.download('videoLtx',{localAccess:{},token:TOKEN,acceptLicense:true}),/Optional LTX/);
  assert.throws(()=>authorizeLocalLtxDownload(TOKEN),/terms/);
  const originalNow=Date.now;let permission;
  try{Date.now=()=>1000;permission=authorizeLocalLtxDownload(TOKEN,{acceptLicense:true});Date.now=()=>62000;await assert.rejects(m.download('videoLtx',{localAccess:permission}),/Optional LTX/);}finally{Date.now=originalNow;}
  const id='fixture-gated';CATALOG.push({id,gated:{how:'Other gated model'},files:[]});
  try{await assert.rejects(m.download(id,{localAccess:authorizeLocalLtxDownload(TOKEN,{acceptLicense:true})}),/Other gated/);}finally{CATALOG.splice(CATALOG.findIndex(c=>c.id===id),1);}
});

async function tinyLtx(fn){
  const cap=CATALOG.find(c=>c.id==='videoLtx'),saved=cap.files,dir=await mkdtemp(path.join(root,'download-')),body=Buffer.from('fixture-download');
  cap.files=[{...saved[0],dest:path.join(dir,'fixture.safetensors'),bytes:body.length,sha256:hash(body),alt:[]}];
  const originalFetch=globalThis.fetch;
  try{await fn({cap,file:cap.files[0],body,manager:new ModelManager(),permit:()=>authorizeLocalLtxDownload(TOKEN,{acceptLicense:true})});}
  finally{globalThis.fetch=originalFetch;cap.files=saved;await rm(dir,{recursive:true,force:true});}
}
test('authenticated download preserves Range resume, strips redirect bearer, checks SHA and renames only complete bytes',async()=>tinyLtx(async({file,body,manager,permit})=>{
  await writeFile(file.dest+'.part',body.subarray(0,3));const seen=[];
  globalThis.fetch=async(url,init)=>{seen.push([url,init.headers]);if(new URL(url).hostname==='huggingface.co')return new Response(null,{status:302,headers:{location:'https://cdn-lfs.huggingface.co/fixture'}});return new Response(body.subarray(3),{status:206});};
  assert.deepEqual(await manager.download('videoLtx',{localAccess:permit()}),{ok:true});assert.deepEqual(await readFile(file.dest),body);assert.equal(existsSync(file.dest+'.part'),false);
  assert.equal(seen[0][1].Range,'bytes=3-');assert.equal(seen[0][1].Authorization,'Bearer '+TOKEN);assert.equal(seen[1][1].Range,'bytes=3-');assert.equal(seen[1][1].Authorization,undefined);
  await assert.rejects(manager.download('videoLtx',{localAccess:permit(),exact:true}).then(()=>manager.download('videoLtx',{localAccess:{}})),/Optional LTX/);
}));
test('authenticated corrupt bytes never replace an existing model and no token reaches failure progress',async()=>tinyLtx(async({file,body,manager,permit})=>{
  await writeFile(file.dest,Buffer.from('prior'));file.sha256='0'.repeat(64);globalThis.fetch=async()=>new Response(body,{status:200});
  await assert.rejects(manager.download('videoLtx',{localAccess:permit()}),/sha256/);assert.equal((await readFile(file.dest)).toString(),'prior');assert.equal(existsSync(file.dest+'.part'),false);
  assert(!JSON.stringify([...manager.progress]).includes(TOKEN));
}));
test('authenticated cancellation aborts a silent transfer and keeps only resumable partial bytes',async()=>tinyLtx(async({file,body,manager,permit})=>{
  globalThis.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){controller.enqueue(body.subarray(0,3));init.signal.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});}}),{status:200});
  const job=manager.download('videoLtx',{localAccess:permit()});
  for(let i=0;i<100&&!(manager.progress.get('videoLtx')?.received>0);i++)await new Promise(r=>setTimeout(r,5));
  assert(manager.progress.get('videoLtx')?.received>0);manager.cancel('videoLtx');assert.deepEqual(await job,{cancelled:true});assert((await stat(file.dest+'.part')).size<=3,'Only bytes actually written before Cancel remain resumable');assert.equal(existsSync(file.dest),false);
}));
