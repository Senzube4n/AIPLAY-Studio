import path from 'node:path';
import {mkdir,rename,rm,readdir,copyFile,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {verifiedDownload,fileMatches} from './gguf-download.js';
import {runTool} from './community-process.js';

const release='https://github.com/timoncool/YuE2-Studio/releases/download/';
const archives={
  planner:{url:'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.0/audio-v0.9.0-bin-windows-x64-cuda13.3.zip',bytes:272814336,sha256:'46eb928af284babb3526fc5198da12a4fe4e4445812d60e90a04e82cb5a87786'},
  midi:{url:release+'music-midi-3e7a0778/music-midi-cuda-windows-x64.zip',bytes:126196178,sha256:'18716b3da081d222d3563110a749bbc971d754142e73d5a063cfaa998003a45b'},
  train:{url:release+'music-train-3e7a0778-r2/music-train-cuda-windows-x64.zip',bytes:224309232,sha256:'086ee56475c03e2fa99cf87d278d423834239ce0c04f2057d3742e55213367c9'},
};
const hf=(repo,rev,file,bytes,digest,gitBlob=false)=>({url:`https://huggingface.co/${repo}/resolve/${rev}/${file}`,bytes,...(gitBlob?{gitBlob:digest}:{sha256:digest}),name:path.basename(file)});
const muscriptor={
 small:[411888600,'bbd482c786b895cf7d8f44185073d951adae2ebb8a66f82ca84cd1f84569549c',124,'153e0fe8f02943abc586031dde1459825e169187','31a8f75d6a8b5383fd71ad1371dc1620389ab722'],
 medium:[1228144472,'ac80adbdf85d87231735fd948af7013441c0afced316c4e9067fd5d8a7fb97ec',126,'3862558703a8c30630ff1149b58e2f070179c774','27246ba68bd4d8f98bdec10a6edf8d7cf42a8826'],
 large:[5465642136,'ac4eb6ea87dfc26b6ca6b954c6b967ab87ad4c7d08e078b25214f13ed051f397',125,'d6e262815ec0b0defc65ac885fae222078e1d367','87f4bf981f56f90fb5043153b3f54af3c3053da9'],
};
const training=[
 hf('Qwen/Qwen2.5-3B','3aab1f1954e9cc14eb9509a215f9e5ca08227a9b','vocab.json',2776833,'4783fe10ac3adce15ac8f358ef5462739852c569',true),
 hf('Qwen/Qwen2.5-3B','3aab1f1954e9cc14eb9509a215f9e5ca08227a9b','merges.txt',1671839,'20024bfe7c83998e9aeaf98a0cd6a2ce6306c2f0',true),
 hf('scragnog/YuE2-GGUF','eb7de0903bf4dfbd14a2384ae0c0d14150cfa2c7','checkpoints/yue2_3b_int8_convrot.safetensors',3960938800,'96fe199377309001ed8cd26a944baeee8cc31a20ba7c36d1d3c0a7e1f4149db6'),
 hf('scragnog/YuE2-GGUF','eb7de0903bf4dfbd14a2384ae0c0d14150cfa2c7','yue2-vae-standard-f32.gguf',530348768,'c4ffc363b246f404c1d150075da4c41c4a031524036042ce45aeb500d4d5fe71'),
 hf('scragnog/YuE2-GGUF','eb7de0903bf4dfbd14a2384ae0c0d14150cfa2c7','yue2-tok-f16.gguf',1211632224,'aaea8c9fb75bf83baf3b99bac27a0eba61029e747df703a11e91a53309695687'),
 hf('scragnog/YuE2-GGUF','eb7de0903bf4dfbd14a2384ae0c0d14150cfa2c7','sheetsage2-f16.gguf',1360020736,'6a205c7ca90f60b388d925c0e4aea8f4ed8bb4404520bb49dbd095d1b7320bd1'),
 hf('Mothersuperior/yue2-mothersuperior-realaudio-tokenizer-v4','e2e63d859f3af879baf1b4d4e9f22d1eeda6fde5','nar_lora_joint_v9.safetensors',140560592,'585f303da1d5252d228d1e8ac6d4c4d11d970df9297406935cc8bdafa49cfa7e'),
];
export function installationFiles(kind,size='small'){
 if(kind==='planner')return [];
 if(kind==='train')return training;
 if(kind!=='midi'||!Object.hasOwn(muscriptor,size))throw new Error('Choose a valid native pack.');
 const [bytes,sha,configBytes,blob,rev]=muscriptor[size],repo=`cocktailpeanut/muscriptor-${size}`;
 return [hf(repo,rev,'config.json',configBytes,blob,true),hf(repo,rev,'model.safetensors',bytes,sha)];
}
export async function installCommunityPack({root,kind,size='small',signal,onProgress=()=>{},checkpoint}){
 if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Bundled native packs require Windows x64. Configure a compatible local tool on this platform.');
 const files=installationFiles(kind,size),archive=archives[kind],downloads=path.join(root,'downloads');
 await mkdir(downloads,{recursive:true});
 const zip=path.join(downloads,`music-${kind}.zip`);
 await verifiedDownload(archive,zip,{signal,onProgress:bytes=>onProgress({file:`music-${kind}.zip`,bytes,total:archive.bytes})});
 const target=path.join(root,kind);
 const executable=kind==='planner'?'audiocpp_cli.exe':`music-${kind}.exe`;
 if(!await stat(path.join(target,executable)).then(s=>s.isFile()).catch(()=>false)){
  const staged=path.join(root,`install-${randomUUID()}`);await mkdir(staged,{recursive:true});
  try{
   // Paths travel in the environment, never as interpolated PowerShell code.
   await runTool('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:AIPLAY_PACK_ZIP -DestinationPath $env:AIPLAY_PACK_STAGE'],{signal,env:{...process.env,AIPLAY_PACK_ZIP:zip,AIPLAY_PACK_STAGE:staged}});
   const names=await readdir(staged);let extracted=staged;
   if(!names.includes(executable)&&names.length===1)extracted=path.join(staged,names[0]);
   if(!await stat(path.join(extracted,executable)).then(s=>s.isFile()).catch(()=>false))throw new Error('Native archive layout is unsupported.');
   await rename(extracted,target);
  }finally{await rm(staged,{recursive:true,force:true});}
 }
 const models=path.join(root,'models',...(kind==='midi'?[`muscriptor-${size}`]:[]));await mkdir(models,{recursive:true});
 for(const spec of files){
  const dest=path.join(models,spec.name);
  if(kind==='train'&&spec.name==='yue2_3b_int8_convrot.safetensors'&&checkpoint&&await fileMatches(checkpoint,spec,{signal})&&!await fileMatches(dest,spec,{signal}))await copyFile(checkpoint,dest);
  await verifiedDownload(spec,dest,{signal,onProgress:bytes=>onProgress({file:spec.name,bytes,total:spec.bytes})});
 }
 return {kind,size,files:files.map(s=>s.name)};
}
