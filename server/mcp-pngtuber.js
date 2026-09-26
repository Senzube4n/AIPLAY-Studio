/** Agent controls for live, browser-local PNGtuber sessions. No image bytes or paths. */
const sid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
export function pngtuberTools(api) {
  const post=body=>api('POST','/api/avatars/pngtuber',body);
  return [
    {name:'pngtuber_sessions',description:'List live PNGtuber browser previews, their current frame and applied cue revision. Frames stay in the browser; separate OBS browser sources cannot inherit them.',inputSchema:{type:'object',properties:{},additionalProperties:false},run:()=>post({action:'sessions'})},
    {name:'pngtuber_talk',description:'Show the talking PNG/WebP frame for 250-10000 ms in one live PNGtuber preview. The browser must acknowledge the cue; this does not start a microphone or audio file.',inputSchema:{type:'object',required:['session_id','duration_ms'],additionalProperties:false,properties:{session_id:sid,command_id:sid,duration_ms:{type:'integer',minimum:250,maximum:10000}}},run:a=>post({action:'command',session_id:a.session_id,command_id:a.command_id,op:'talk',duration_ms:a.duration_ms})},
    {name:'pngtuber_clear_talk',description:'Clear an agent talking cue in one live PNGtuber preview; local microphone or audio can still move its frame.',inputSchema:{type:'object',required:['session_id'],additionalProperties:false,properties:{session_id:sid,command_id:sid}},run:a=>post({action:'command',session_id:a.session_id,command_id:a.command_id,op:'clear_talk'})},
  ];
}
