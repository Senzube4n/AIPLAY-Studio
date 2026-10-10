/** Same cue route as Music Lab. Every input is explicit at the HTTP seam. */
const id = {type:'string',pattern:'^[a-f0-9]{32}$'};
const slug = {type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$'};
const token = {type:'string',pattern:'^[a-f0-9]{64}$'};
const number = (minimum,maximum,integer=false) => ({type:integer?'integer':'number',minimum,maximum});
const schema = (properties={},required=[]) => ({type:'object',properties,required,additionalProperties:false});
export function validateSharedCueInput(spec,input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('Cue request must be an object.');
  for(const key of spec.required) if(input[key]===undefined) throw new Error(`${key} is required.`);
  for(const [key,value] of Object.entries(input)) {
    const s=spec.properties[key]; if(!s) throw new Error(`Unsupported cue field: ${key}.`);
    if(s.type==='string' && (typeof value!=='string' || value.includes('\0') || (s.pattern && !new RegExp(s.pattern).test(value)) || value.length<(s.minLength||0) || value.length>(s.maxLength||Infinity))) throw new Error(`${key} must be valid text.`);
    if(['number','integer'].includes(s.type) && (typeof value!=='number'||!Number.isFinite(value)||value<s.minimum||value>s.maximum||(s.type==='integer'&&!Number.isInteger(value)))) throw new Error(`${key} is outside its numeric bounds.`);
    if(s.enum && !s.enum.includes(value)) throw new Error(`${key} is not supported.`);
  }
}
export function sharedCueTools(api) {
  const checked = result => {if(result?.error) throw new Error(result.error);return result;};
  const save = schema({id,name:{type:'string',minLength:1,maxLength:32},project:slug,comp:slug,
    bar:number(1,256,true),beat:number(1,32,true),tick:number(0,959,true),accent:{type:'string',enum:['impact','kick']},
    velocity:number(1,127,true),gainDb:number(-24,0),durationBeats:number(.1,4),flashStrength:number(1,50),compOffsetSeconds:number(-600,600)},['project','comp','bar']);
  const one = schema({id},['id']),reviewed = schema({id,previewToken:token},['id','previewToken']),empty = schema();
  return [{name:'music_cue_status',description:'Read saved shared cues, DAW projects and VFX compositions. Supported bindings: builtin impact/kick plus flash. Camera, light and avatar bindings are not available. UI: Music Lab > Shared cues.',inputSchema:empty,
    async run(a={}) {validateSharedCueInput(empty,a);return checked(await api('GET','/api/music-cues'));}},
  {name:'music_cue_save',description:'Save or edit a draft musical cue and inspect its exact plan. bar/beat are 1-based; tick is 0–959. VFX time = DAW seconds + compOffsetSeconds. durationBeats uses the local meter beat. Preview again after any project change; Apply is separate.',inputSchema:save,
    async run(a={}) {validateSharedCueInput(save,a);return checked(await api('POST','/api/music-cues',{action:'save',id:a.id,name:a.name,project:a.project,comp:a.comp,
      bar:a.bar,beat:a.beat,tick:a.tick,accent:a.accent,velocity:a.velocity,gainDb:a.gainDb,durationBeats:a.durationBeats,flashStrength:a.flashStrength,compOffsetSeconds:a.compOffsetSeconds}));}},
  {name:'music_cue_read',description:'Read a saved cue and recover its apply/undo receipt after interruption. A partial state means only some cue-owned objects exist; Undo can recover them after edit conflicts are resolved.',inputSchema:one,
    async run(a={}) {validateSharedCueInput(one,a);return checked(await api('POST','/api/music-cues',{action:'read',id:a.id}));}},
  {name:'music_cue_preview',description:'Resolve a saved cue against current musical timing and composition revision. Returns exact notes, opacity keys, alignment and previewToken. This does not render audio or change either project.',inputSchema:one,
    async run(a={}) {validateSharedCueInput(one,a);return checked(await api('POST','/api/music-cues',{action:'preview',id:a.id}));}},
  {name:'music_cue_audition',description:'Render the reviewed dry builtin accent through the DAW CPU audition lane. Returns audio and composition-still URLs plus flash keys for simulated overlay. The project mix/master can change the sound. Requires current previewToken; no model generation.',inputSchema:reviewed,
    async run(a={}) {validateSharedCueInput(reviewed,a);return checked(await api('POST','/api/music-cues',{action:'audition',id:a.id,previewToken:a.previewToken},90000));}},
  {name:'music_cue_apply',description:'Apply a reviewed cue as a dedicated DAW accent track, VFX flash layer and labeled marker. Requires current previewToken. Existing content stays editable. Read the receipt after any interruption; Undo removes only unchanged cue-owned objects.',inputSchema:reviewed,
    async run(a={}) {validateSharedCueInput(reviewed,a);return checked(await api('POST','/api/music-cues',{action:'apply',id:a.id,previewToken:a.previewToken}));}},
  {name:'music_cue_undo',description:'Undo this cue’s dedicated accent track, flash layer and marker. Other content is preserved. Edits or dependencies on cue-owned objects refuse Undo until resolved. Also recovers a partial apply; safe to retry.',inputSchema:one,
    async run(a={}) {validateSharedCueInput(one,a);return checked(await api('POST','/api/music-cues',{action:'undo',id:a.id}));}}];
}
