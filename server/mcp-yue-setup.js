/** Same setup door as the Music/Models page; agents never accept terms implicitly. */
export function yueSetupTools(api) {
  return [{
    name:'yue2_gguf_setup',
    description:'Inspect, install/resume, or cancel the native YuE2 GGUF music-only setup. Choose precision q4_0 (default, smaller) or optional q8_0 (larger; quality and VRAM unbenchmarked). Installs only the selected transformer plus shared decoder/runtime, without removing the other precision. No ComfyUI/Python/other models. Before install, explain the selected download size and licences and obtain the user’s explicit approval; only then set accepted_terms=true. Never infer licence acceptance. Cancel stops the active setup regardless of selected precision. Windows x64/NVIDIA experimental build; lower-VRAM hardware unverified.',
    inputSchema:{type:'object',properties:{action:{type:'string',enum:['status','install','cancel'],default:'status'},precision:{type:'string',enum:['q4_0','q8_0'],default:'q4_0',description:'Exact native transformer to inspect or install. Q8 is optional and never silently substituted.'},accepted_terms:{type:'boolean',description:'User explicitly approved these downloads and reviewed the noncommercial model and CUDA runtime terms.'}},additionalProperties:false},
    async run(a={}) {
      const action=a.action || 'status';
      const precision=a.precision===undefined?'q4_0':a.precision;
      if (!['status','install','cancel'].includes(action)) throw new Error('Unknown setup action.');
      if (!['q4_0','q8_0'].includes(precision)) throw new Error('Native YuE2 precision must be q4_0 or q8_0.');
      if (action==='install' && a.accepted_terms!==true) throw new Error('Explicit user approval and licence review are required before download.');
      const endpoint='/api/music-gguf/setup'+(action==='status'?`?precision=${precision}`:'');
      const r=await api(action==='status'?'GET':'POST',endpoint,action==='status'?undefined:{action,quantization:precision,acceptLicense:a.accepted_terms===true});
      if (r.error && !r.state) throw new Error(r.error);
      return r;
    },
  }];
}
