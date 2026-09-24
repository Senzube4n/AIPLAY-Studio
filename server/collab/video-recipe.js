import { randomBytes } from 'node:crypto';
import { assertSafe } from '../safety/refusal.js';
export const VIDEO_RECIPE_SCHEMA = {type:'object',required:['engine','prompt','width','height','seconds','steps','guidance','keepAudio'],additionalProperties:false,properties:{
 engine:{type:'string',enum:['h3','ltx']},prompt:{type:'string',minLength:1,maxLength:8000},negative:{type:'string',maxLength:500},
 width:{type:'integer',minimum:256,maximum:3840},height:{type:'integer',minimum:256,maximum:3840},seconds:{type:'number',minimum:1,maximum:20},steps:{type:'integer',minimum:2,maximum:40},guidance:{type:'number',minimum:1,maximum:8},keepAudio:{type:'boolean'},seed:{type:'integer',minimum:0,maximum:4294967295}
}};
const fail=message=>{const e=new Error(message);e.reason='video-recipe';throw e;};
/** Data-only recipe. No files, graphs, URLs, model paths or executable operations. */
export function normalizeVideoRecipe(input,{rollSeed=true}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Choose video settings first.');
 for(const key of Object.keys(input))if(!Object.hasOwn(VIDEO_RECIPE_SCHEMA.properties,key))fail(`Video recipes do not support ${key}. Remove that input before preparing a recipe.`);
 for(const key of VIDEO_RECIPE_SCHEMA.required)if(!Object.hasOwn(input,key))fail(`Missing video setting: ${key}.`);
 const out={};
 for(const [key,value] of Object.entries(input)){
  const rule=VIDEO_RECIPE_SCHEMA.properties[key];
  if(rule.type==='string'){
   if(typeof value!=='string'||value.length>(rule.maxLength??Infinity)||value.trim().length<(rule.minLength??0)||rule.enum&&!rule.enum.includes(value))fail(`Invalid video setting: ${key}.`);
  }else if(rule.type==='boolean'){if(typeof value!=='boolean')fail(`Invalid video setting: ${key}.`);}
  else if(typeof value!=='number'||!Number.isFinite(value)||value<rule.minimum||value>rule.maximum||rule.type==='integer'&&!Number.isInteger(value))fail(`Invalid video setting: ${key}.`);
  out[key]=value;
 }
 // The minors rule, on pack AND open: one function serves both, so a recipe that pairs a child or
 // teenager with sexual content can neither be sent nor received. 422 with the one sentence.
 assertSafe({door:'collab.video-recipe',via:'collab',texts:[out.prompt]});
 // LTX's current unguided path floors both dimensions to multiples of 64.
 if(out.engine==='ltx'&&(out.width%64||out.height%64))fail('LTX recipes need width and height in multiples of 64.');
 if(out.seed===undefined){if(!rollSeed)fail('The recipe has no resolved seed.');out.seed=randomBytes(4).readUInt32LE();}
 return out;
}
export function makeVideoRecipe(input,{now=Date.now()}={}){return {v:1,kind:'video-recipe',recipeVersion:1,id:'vr_'+randomBytes(8).toString('hex'),at:now,modelPolicy:'receiver-defaults',video:normalizeVideoRecipe(input)};}
export function readVideoRecipe(packet){
 if(packet?.v!==1||packet.kind!=='video-recipe'||packet.recipeVersion!==1||packet.modelPolicy!=='receiver-defaults')fail('Unsupported video recipe. Update Studio before using it.');
 if(Object.keys(packet).some(k=>!["v","kind","recipeVersion","id","at","modelPolicy","video","by"].includes(k)))fail("This recipe contains unsupported data.");
 return normalizeVideoRecipe(packet.video,{rollSeed:false});
}
export function describeVideoRecipe(packet){const v=readVideoRecipe(packet);return `${v.engine.toUpperCase()} · ${v.width} × ${v.height} · ${v.seconds}s · ${v.steps} steps · seed ${v.seed} · receiver default models`;}
export function videoRecipeMcpArgs(packet){const {keepAudio,...v}=readVideoRecipe(packet);return {...v,keep_audio:keepAudio,bridge:'off',bridge_alpha:0};}
