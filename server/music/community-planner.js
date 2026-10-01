import path from 'node:path';
import {validateGgufRequest,buildGgufArgs} from './yue-gguf.js';
export function plannerRequest(body){
 const stage=body.stage||'abc';if(!['abc','semantic','audio'].includes(stage))throw new Error('Choose score, semantic tokens or audio.');
 const maxTokens=body.maxTokens??9000;if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>9000)throw new Error('Semantic token limit must be 1 to 9000.');
 const request=validateGgufRequest({style:body.style,lyrics:body.lyrics,seed:body.seed,cot:'full',quantization:body.quantization||'q4_0',narSteps:body.narSteps??8,
   ...(body.abc?{abc:body.abc}:{}),allowSectionLabels:true});
 if(stage==='abc'&&request.abc)throw new Error('A score-only run must generate a fresh score.');
 return {...request,stage,maxTokens};
}
export function plannerArgs(request,{modelDir,dir,semanticFile,semanticFrames,threads=8}){
 const {stage,maxTokens,...input}=request;
 const args=buildGgufArgs(input,{modelDir,output:path.join(dir,'audio.wav'),abcFile:input.abc?path.join(dir,'input.abc'):null,backend:'cuda',threads,cfgKey:'guidance_scale'});
 args.push('--out-dir',dir,'--request-option',`stop_after=${stage}`,'--request-option','export_semantic=true');
 if(semanticFile){
  if(!Number.isInteger(semanticFrames)||semanticFrames<1||semanticFrames>9000)throw new Error('Invalid semantic stream.');
  args.push('--request-option',`semantic_prefix_file=${semanticFile}`,'--request-option',`semantic_min_tokens=${semanticFrames}`,'--request-option',`semantic_max_tokens=${semanticFrames}`);
 }else args.push('--request-option',`semantic_min_tokens=${Math.min(200,maxTokens)}`,'--request-option',`semantic_max_tokens=${maxTokens}`);
 return args;
}
