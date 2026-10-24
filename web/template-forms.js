/** Only settings supported by the existing curated workflow adapters. */
export function musicTemplateSettings(spec) {
  if(spec.engine!=='ace-step15') throw Error('This music engine does not yet support creative templates.');
  if(spec.aceCover || spec.audioRef || spec.lora) throw Error('Remove private audio references and unsupported LoRAs before sharing this template.');
  const values={caption:spec.caption,lyrics:spec.lyrics,instrumental:spec.instrumental,duration:spec.maxDuration,seed:spec.seed,
    dit:spec.aceDit,lm:spec.aceLm,steps:spec.aceSteps,cfg:spec.aceCfg,codes:spec.aceCodes,planTemperature:spec.acePlanTemp,
    bpm:spec.bpm,keyscale:spec.keyscale,timesignature:spec.timesignature,language:spec.language};
  return Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined));
}
export function templateFormFields(category, settings, target='local') {
  const map=category==='music'?{caption:'caption',lyrics:'lyrics',duration:'maxDur',seed:'seed',lm:'aLm',steps:'aSteps',cfg:'aCfg',bpm:'aBpm',keyscale:'aKey',timesignature:'aMeter',language:'aLang',planTemperature:'aPlanTemp'}
    :category==='pictures'?{prompt:'imgPrompt',negative:'imgNeg',width:'imgW',height:'imgH',steps:'imgSteps',cfg:target==='runpod'?'imgRunPodCfg':'imgCfg',seed:'imgSeed'}
    :{prompt:'vidPrompt',seconds:'vidSecs',steps:'vidSteps',width:'vidW',height:'vidH',seed:'vidSeed'};
  const fields=Object.fromEntries(Object.entries(map).filter(([key])=>settings[key]!==undefined).map(([key,id])=>[id,settings[key]]));
  if(category==='video'&&target==='runpod'&&settings.width!==undefined&&settings.height!==undefined){delete fields.vidW;delete fields.vidH;fields.vidRunPodSize=`${settings.width}x${settings.height}`;}
  if(category==='video'&&target==='local'&&(settings.width!==undefined||settings.height!==undefined))return {vidSize:'custom',...fields};
  return fields;
}
export function assertTemplateFields(doc,fields){
  for(const [id,value]of Object.entries(fields)){
    const n=doc.getElementById(id);if(!n)throw Error('This form cannot load one of the template settings.');
    if(n.tagName==='SELECT' && ![...n.options].some(o=>o.value===String(value)&&!o.disabled))throw Error(`Install or select the required model component before loading ${id}.`);
    if(['range','number'].includes(n.type) && (n.min!==''&&Number(value)<Number(n.min)||n.max!==''&&Number(value)>Number(n.max)))throw Error('A template value is outside this form’s supported range.');
  }
}
