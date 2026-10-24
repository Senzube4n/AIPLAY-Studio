/** Explicit user-approved browser login. No environment/cache import or client secret. */
import {createHash,randomBytes as secureRandomBytes,timingSafeEqual} from 'node:crypto';

export const HUGGINGFACE_OAUTH_KEY='MODEL_HUGGINGFACE_OAUTH';
export const HUGGINGFACE_CLIENT_ID='https://senzube4n.github.io/AIPLAY-Studio/.well-known/oauth-cimd.json';
export const HUGGINGFACE_CALLBACK_PATH='/api/models/access/callback';
export const HUGGINGFACE_SCOPE='gated-repos';
const AUTHORIZE='https://huggingface.co/oauth/authorize',TOKEN='https://huggingface.co/oauth/token';
const TTL=10*60_000,MAX_BODY=16_384;
const sha=value=>createHash('sha256').update(value).digest('hex');
const b64=value=>Buffer.from(value).toString('base64url');
class LoginFailure extends Error{constructor(state,message){super(message);this.state=state;}}
const failure=(state,message)=>{throw new LoginFailure(state,message);};
const safeFailure=error=>error instanceof LoginFailure?{state:error.state,message:error.message}
  :{state:'error',message:'Could not complete Hugging Face sign-in. Try again.'};
function localOrigin(value){
  let url;try{url=new URL(value);}catch{failure('error','Open sign-in from this PC’s Studio.');}
  if(url.origin!==value||url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password)
    failure('error','Open sign-in from this PC’s Studio.');
  return url.origin;
}
function accessToken(value){
  return typeof value==='string'&&value.length<=500&&/^hf_oauth_[A-Za-z0-9_.-]{8,}$/.test(value);
}
function refreshToken(value){return typeof value==='string'&&value.length>=10&&value.length<=4096&&/^[A-Za-z0-9._~+\/-]+=*$/.test(value);}
function protection(value={}){
  const out={kind:'oauth',set:!!value.set,usable:!!value.usable,method:value.method||null,encrypted:!!value.encrypted};
  for(const name of ['protection','savedAt','savedHere','savedBy','where'])if(value[name]!==undefined)out[name]=value[name];
  return out;
}
function parseRecord(raw){
  if(typeof raw!=='string'||raw.length>MAX_BODY)return null;
  let record;try{record=JSON.parse(raw);}catch{return null;}
  return record?.version===1&&record.clientId===HUGGINGFACE_CLIENT_ID&&record.scope===HUGGINGFACE_SCOPE&&accessToken(record.accessToken)
    &&Number.isSafeInteger(record.expiresAt)&&record.expiresAt>0&&record.expiresAt<=8.64e15
    &&(record.refreshToken===undefined||refreshToken(record.refreshToken))?record:null;
}
function tokenRecord(body,now,previous=null){
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.token_type!=='string'||body.token_type.toLowerCase()!=='bearer'
    ||!accessToken(body.access_token)||!Number.isSafeInteger(body.expires_in)||body.expires_in<1||body.expires_in>366*86400)
    failure('error','Hugging Face returned an unsupported sign-in response. Sign in again.');
  // RFC6749 §5.1 permits omission only when the requested scope is unchanged.
  const scope=body.scope===undefined?(previous?.scope||HUGGINGFACE_SCOPE):body.scope;
  if(typeof scope!=='string'||scope.trim()!==HUGGINGFACE_SCOPE)
    failure('error','Hugging Face did not grant the requested model-download permission. Sign in again.');
  if(body.refresh_token!==undefined&&!refreshToken(body.refresh_token))failure('error','Hugging Face returned an unsupported sign-in response. Sign in again.');
  return {version:1,clientId:HUGGINGFACE_CLIENT_ID,scope:HUGGINGFACE_SCOPE,accessToken:body.access_token,
    expiresAt:now+body.expires_in*1000,...(body.refresh_token||previous?.refreshToken?{refreshToken:body.refresh_token||previous.refreshToken}:{})};
}

export function createHuggingFaceLogin({secrets,fetchFn=fetch,now=Date.now,randomBytes=secureRandomBytes,timeoutMs=20_000}={}){
  if(!secrets||!['get','set','clear','status'].every(name=>typeof secrets[name]==='function'))throw Error('A protected Studio secret store is required.');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw Error('Bounded provider timeout required.');
  let epoch=0,pending=null,active=null,refreshing=null,last=null,storage=Promise.resolve();
  const rejectedGrants=new Set();
  const serial=fn=>{const job=storage.then(fn,fn);storage=job.catch(()=>{});return job;};
  async function saved(){return serial(async()=>{
    const [raw,stored]=await Promise.all([secrets.get(HUGGINGFACE_OAUTH_KEY),secrets.status(HUGGINGFACE_OAUTH_KEY)]);
    return {raw,record:parseRecord(raw),auth:protection(stored)};
  });}
  function invalidate(){epoch++;pending=null;active?.controller.abort();refreshing?.controller.abort();active=null;refreshing=null;}
  function credentialAuth(value,allowRenewable=false){
    const {record}=value;
    return {...value.auth,usable:!!record&&value.auth.usable&&!rejectedGrants.has(sha(value.raw))&&(record.expiresAt>now()||(allowRenewable&&!!record.refreshToken)),
      renewable:!!record?.refreshToken,said:record?'Signed in with Hugging Face.'+(value.auth.savedHere===false?' Saved by another copy of Studio.':''):'No usable Hugging Face browser connection.',
      ...(record?{expiresAt:new Date(record.expiresAt).toISOString()}:{})};
  }
  function publicState(value){
    const {record}=value,auth=credentialAuth(value,true);
    if(pending&&pending.deadline<=now()){pending=null;last={state:'expired',message:'This sign-in request expired. Sign in again.'};}
    const current=pending?{state:'waiting',message:'Finish signing in with Hugging Face in your browser.'}
      :active?{state:'finishing',message:'Completing Hugging Face sign-in.'}
      :refreshing?{state:'refreshing',message:'Renewing the Hugging Face connection.'}
      :last||(record?(record.expiresAt>now()?{state:'connected',message:'Hugging Face is connected for gated model downloads.'}
        :{state:'expired',message:'The Hugging Face connection expired. Sign in again.'})
        :{state:'signed-out',message:'Sign in with Hugging Face to download optional gated models.'});
    return {...current,auth,...(record?{expiresAt:new Date(record.expiresAt).toISOString()}:{})};
  }
  async function status(){try{return publicState(await saved());}catch{return {state:'error',message:'Could not read the saved Hugging Face connection.',auth:{kind:'oauth',set:false,usable:false,method:null,encrypted:false}};}}
  async function persist(record,baseline,version){
    const encoded=JSON.stringify(record);
    return serial(async()=>{
      if(version!==epoch||await secrets.get(HUGGINGFACE_OAUTH_KEY)!==baseline||version!==epoch)return false;
      await secrets.set(HUGGINGFACE_OAUTH_KEY,encoded);
      if(version===epoch)return true;
      // Cancel/forget may happen while the asynchronous protected write runs.
      // Restore only our own write; a later queued forget then clears it.
      if(await secrets.get(HUGGINGFACE_OAUTH_KEY)===encoded){
        if(baseline===null||baseline===undefined)await secrets.clear(HUGGINGFACE_OAUTH_KEY);
        else await secrets.set(HUGGINGFACE_OAUTH_KEY,baseline);
      }
      return false;
    });
  }
  async function rejectGrant(value,version){
    // A known revoked/expired refresh must not remain an apparently renewable
    // grant if the vault clear fails. Never clear a newer grant or the PAT.
    rejectedGrants.add(sha(value.raw));
    await serial(async()=>{
      if(version===epoch&&await secrets.get(HUGGINGFACE_OAUTH_KEY)===value.raw&&version===epoch)
        await secrets.clear(HUGGINGFACE_OAUTH_KEY);
    });
  }
  async function postToken(parameters,controller){
    let response,onAbort;
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),timeoutMs);
    const signal=AbortSignal.any([controller.signal,timeout.signal]);
    const aborted=new Promise((_,reject)=>{onAbort=()=>reject(Error('Sign-in request aborted.'));if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});});
    aborted.catch(()=>{});
    try{
      response=await Promise.race([Promise.resolve().then(()=>fetchFn(TOKEN,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams(parameters).toString(),signal})),aborted]);
      if(response.status>=300&&response.status<400)failure('error','Hugging Face sign-in could not be completed. Try again.');
      const reader=response.body?.getReader();if(!reader)failure('error','Hugging Face sign-in could not be completed. Try again.');
      let size=0;const chunks=[];
      try{for(;;){const {done,value}=await Promise.race([reader.read(),aborted]);if(done)break;size+=value.length;if(size>MAX_BODY)failure('error','Hugging Face sign-in could not be completed. Try again.');chunks.push(value);}}
      finally{reader.cancel().catch(()=>{});}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{failure('error','Hugging Face sign-in could not be completed. Try again.');}
      if(!response.ok||body.error){
        if(body.error==='invalid_grant')failure('expired','The Hugging Face connection expired or was revoked. Sign in again.');
        if(body.error==='access_denied')failure('denied','Hugging Face sign-in was not approved.');
        failure('error','Hugging Face sign-in could not be completed. Try again.');
      }
      return body;
    }catch(error){if(error instanceof LoginFailure)throw error;failure('error','Could not reach Hugging Face to complete sign-in. Try again.');}
    finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);response?.body?.cancel().catch(()=>{});}
  }
  async function start(origin){
    origin=localOrigin(origin);invalidate();const version=epoch;last=null;
    try{
      const previous=await saved();if(version!==epoch)return status();
      const state=b64(randomBytes(32)),verifier=b64(randomBytes(48));
      pending={state,verifier,origin,deadline:now()+TTL,epoch:version,baseline:previous.raw};
      const url=new URL(AUTHORIZE);url.search=new URLSearchParams({client_id:HUGGINGFACE_CLIENT_ID,response_type:'code',
        redirect_uri:origin+HUGGINGFACE_CALLBACK_PATH,scope:HUGGINGFACE_SCOPE,state,
        code_challenge:b64(createHash('sha256').update(verifier).digest()),code_challenge_method:'S256'}).toString();
      return {...publicState(previous),authorizationUrl:url.href};
    }catch(error){if(version===epoch)last=safeFailure(error);return status();}
  }
  async function callback(value,origin){
    let url;try{origin=localOrigin(origin);url=new URL(value);}catch{return {ok:false,message:'This sign-in callback is not valid. Sign in again.'};}
    const request=pending;
    if(!request||request.epoch!==epoch||request.deadline<=now()||origin!==request.origin||url.origin!==origin||url.username||url.password||url.hash||url.pathname!==HUGGINGFACE_CALLBACK_PATH)
      return {ok:false,message:'This sign-in request expired or was already used. Sign in again.'};
    const query=url.searchParams,provided=query.get('state')||'';
    if(query.getAll('state').length!==1||provided.length!==request.state.length||!/^[A-Za-z0-9_-]+$/.test(provided)||!timingSafeEqual(Buffer.from(provided),Buffer.from(request.state)))
      return {ok:false,message:'This sign-in callback is not valid. Sign in again.'};
    if([...query.keys()].some(key=>!['state','code','error','error_description','error_uri'].includes(key))||query.getAll('code').length>1||query.getAll('error').length>1)
      return {ok:false,message:'This sign-in callback is not valid. Sign in again.'};
    pending=null;const version=epoch;
    if(query.has('error')){last={state:'denied',message:'Hugging Face sign-in was not approved.'};return {ok:false,message:last.message};}
    const code=query.get('code');
    if(typeof code!=='string'||code.length<8||code.length>4096||!/^[A-Za-z0-9._~+\/-]+=*$/.test(code)){
      last={state:'error',message:'This sign-in callback is not valid. Sign in again.'};return {ok:false,message:last.message};
    }
    const job={controller:new AbortController()};active=job;last=null;
    try{
      const body=await postToken({grant_type:'authorization_code',client_id:HUGGINGFACE_CLIENT_ID,code,
        redirect_uri:origin+HUGGINGFACE_CALLBACK_PATH,code_verifier:request.verifier},job.controller);
      const record=tokenRecord(body,now());
      if(!await persist(record,request.baseline,version)){
        if(version===epoch)last={state:'error',message:'The saved Hugging Face connection changed. Sign in again.'};
        return {ok:false,message:'This sign-in request was cancelled or the saved connection changed.'};
      }
      if(version!==epoch)return {ok:false,message:'This sign-in request was cancelled.'};
      rejectedGrants.delete(sha(JSON.stringify(record)));
      last=null;return {ok:true,message:'Hugging Face is connected. You can return to Studio.'};
    }catch(error){if(version===epoch)last=safeFailure(error);return {ok:false,message:version===epoch?last.message:'This sign-in request was cancelled.'};}
    finally{if(active===job)active=null;}
  }
  function privateCredential(value){return value.record&&value.auth.usable&&!rejectedGrants.has(sha(value.raw))&&value.record.expiresAt>now()
    ?{token:value.record.accessToken,auth:credentialAuth(value),signature:sha(value.raw)}:null;}
  async function credential({refresh=false}={}){
    const version=epoch;
    let value;try{value=await saved();}catch{last={state:'error',message:'Could not read the saved Hugging Face connection.'};return null;}
    if(version!==epoch)return null;
    const current=privateCredential(value);if(current||!refresh||!value.record?.refreshToken||!value.auth.usable||rejectedGrants.has(sha(value.raw)))return current;
    if(refreshing)return refreshing.promise;
    const job={controller:new AbortController()};refreshing=job;last=null;
    job.promise=(async()=>{
      try{
        const body=await postToken({grant_type:'refresh_token',client_id:HUGGINGFACE_CLIENT_ID,refresh_token:value.record.refreshToken},job.controller);
        const record=tokenRecord(body,now(),value.record);
        if(!await persist(record,value.raw,version)){if(version===epoch)last={state:'error',message:'The saved Hugging Face connection changed. Sign in again.'};return null;}
        return version===epoch?privateCredential(await saved()):null;
      }catch(error){
        if(version===epoch){
          if(error instanceof LoginFailure&&error.state==='expired'){try{await rejectGrant(value,version);}catch{/* Kept unusable in this process; never expose vault diagnostics. */}}
          if(version===epoch)last=safeFailure(error);
        }
        return null;
      }
      finally{if(refreshing===job)refreshing=null;}
    })();return job.promise;
  }
  async function cancel(){invalidate();last={state:'cancelled',message:'Hugging Face sign-in was cancelled.'};return status();}
  async function forget(){
    invalidate();last=null;
    try{await serial(()=>secrets.clear(HUGGINGFACE_OAUTH_KEY));}
    catch{last={state:'error',message:'Could not remove the saved Hugging Face connection. Try again.'};throw new LoginFailure(last.state,last.message);}
    return status();
  }
  return {start,status,credential,cancel,forget,callback};
}
