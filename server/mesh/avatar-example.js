import {createHash} from 'node:crypto';
export const AVATAR_EXAMPLE=Object.freeze({
  name:'VRM anime reference',bytes:10776032,sha256:'12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2',
  url:'https://raw.githubusercontent.com/vrm-c/vrm-specification/master/samples/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm',
  source:'https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample',
  license:'VRM Public License 1.0 with the original embedded settings; copyright 2022 pixiv Inc. Redistribution and modification permitted; antisocial/hate use prohibited. https://vrm.dev/licenses/1.0/'
});
/** Fixed curated asset, exact size/hash, streaming cap and bounded timeout. */
export async function downloadAvatarExample(fetchImpl=fetch){
  const response=await fetchImpl(AVATAR_EXAMPLE.url,{signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!response.ok||!response.body)throw new Error('The reference model could not be downloaded.');
  const chunks=[];let size=0;const reader=response.body.getReader();
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>AVATAR_EXAMPLE.bytes)throw new Error('Reference model exceeds its pinned size.');chunks.push(Buffer.from(value));}}
  catch(e){await reader.cancel().catch(()=>{});throw e;}
  finally{reader.releaseLock();}
  const bytes=Buffer.concat(chunks);
  if(size!==AVATAR_EXAMPLE.bytes||createHash('sha256').update(bytes).digest('hex')!==AVATAR_EXAMPLE.sha256)throw new Error('Reference model changed upstream; its size/hash must be reviewed before importing.');
  return bytes;
}
export function createExampleInstaller(service,fetchImpl=fetch){
  let pending=null;
  return async actor=>{
    if(pending)return pending;
    pending=(async()=>{
      const existing=(await service.list()).filter(row=>row.inspection?.profile==='vrm'&&row.inspection.sha256===AVATAR_EXAMPLE.sha256);
      for(const row of existing){
        try{return await service.inspect(row.id);}
        catch(error){
          // Keep damaged imports and their provenance intact. Only absence or
          // the file service's exact source-hash conflict permits a fresh copy.
          const missing=error.status===404||error.code==='ENOENT';
          const changed=error.status===409&&/^Avatar changed on disk;/.test(error.message||'');
          if(!missing&&!changed)throw error;
        }
      }
      const bytes=await downloadAvatarExample(fetchImpl);
      return service.importAsset({profile:'vrm',data_base64:bytes.toString('base64'),name:AVATAR_EXAMPLE.name,source:AVATAR_EXAMPLE.source,license:AVATAR_EXAMPLE.license,skeleton_family:'VRM-1.0',facing:'+Z'},actor);
    })();
    try{return await pending;}finally{pending=null;}
  };
}
