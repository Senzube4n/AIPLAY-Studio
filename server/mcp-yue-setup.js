/** Same setup door as the Music/Models page; agents never accept terms implicitly. */
export function yueSetupTools(api) {
  return [{
    name:'yue2_gguf_setup',
    description:'Inspect, install/resume, or cancel the native YuE2 GGUF music-only setup. No ComfyUI/Python/other models. Before install, explain the reported download size and licences and obtain the user’s explicit approval; only then set accepted_terms=true. Never infer licence acceptance. Windows x64/NVIDIA experimental build; lower-VRAM hardware unverified.',
    inputSchema:{type:'object',properties:{action:{type:'string',enum:['status','install','cancel'],default:'status'},accepted_terms:{type:'boolean',description:'User explicitly approved these downloads and reviewed the noncommercial model and CUDA runtime terms.'}},additionalProperties:false},
    async run(a={}) {
      const action=a.action || 'status';
      if (!['status','install','cancel'].includes(action)) throw new Error('Unknown setup action.');
      if (action==='install' && a.accepted_terms!==true) throw new Error('Explicit user approval and licence review are required before download.');
      const r=await api(action==='status'?'GET':'POST','/api/music-gguf/setup',action==='status'?undefined:{action,acceptLicense:a.accepted_terms===true});
      if (r.error && !r.state) throw new Error(r.error);
      return r;
    },
  }];
}
