export function trainingRecipe(input={}) {
  const presets={fast:{steps:200,accumulation:1},balanced:{steps:600,accumulation:2},thorough:{steps:1200,accumulation:4}};
  const preset=input.preset || 'balanced';
  if(!Object.hasOwn(presets,preset) && preset!=='custom') throw new Error('Choose fast, balanced, thorough or custom.');
  const recipe={preset,steps:presets[preset]?.steps || 600,accumulation:presets[preset]?.accumulation || 1,
    optimizer:'adamw-lm',adapter:'lokr',rank:16,alpha:256,lokrDim:128,lokrFactor:4,learningRate:0.0001,
    targetKl:0,seed:0,saveEvery:100};
  if(preset==='custom') Object.assign(recipe,input);
  for(const [key,min,max] of [['steps',1,20000],['accumulation',1,16],['rank',1,256],['lokrDim',1,512],['lokrFactor',1,64],['saveEvery',1,20000],['seed',0,4294967295]]) {
    if(!Number.isInteger(recipe[key]) || recipe[key]<min || recipe[key]>max) throw new Error(`Invalid ${key}.`);
  }
  if(!['adamw-lm','adamw','prodigy','muon'].includes(recipe.optimizer)) throw new Error('Unknown optimizer.');
  if(!['lora','lokr'].includes(recipe.adapter)) throw new Error('Unknown adapter type.');
  for(const [key,min,max] of [['learningRate',0.000001,0.01],['alpha',1,512],['targetKl',0,10]]) {
    if(!Number.isFinite(recipe[key]) || recipe[key]<min || recipe[key]>max) throw new Error(`Invalid ${key}.`);
  }
  return recipe;
}
export function nativeTrainingArgs({models,companion,dataset,output,recipe,resume}) {
  const args=['yue2-joint-train','--checkpoint',models+'/yue2_3b_int8_convrot.safetensors',
    '--companion',companion,'--dataset',dataset,'--output',output,'--device','CUDA0',
    '--steps',String(recipe.steps),'--save-every',String(recipe.saveEvery),'--seed',String(recipe.seed),
    '--adapter-type',recipe.adapter,'--rank',String(recipe.rank),'--alpha',String(recipe.alpha),
    '--optimizer',recipe.optimizer,'--lr',String(recipe.optimizer==='prodigy'?1:recipe.learningRate),
    '--grad-accum',String(recipe.accumulation),'--cursor-weight','0','--target-kl',String(recipe.targetKl),
    '--nar-crop-frames','1500'];
  if(recipe.adapter==='lokr') args.push('--lokr-dim',String(recipe.lokrDim),'--lokr-factor',String(recipe.lokrFactor));
  if(recipe.preset!=='custom') args.push('--weight-decay','0.1','--beta1','0.9','--beta2','0.95',
    '--kl-weight','0','--caption-dropout','0','--abc-dropout','0.5','--planner-lr-scale','1',
    '--lr-schedule','cosine-floor','--lr-floor','0.1','--ar-loss-weight','0.25','--ar-targets','base',
    '--text-dropout','0.1','--lyric-dropout','0.1','--both-dropout','0.1');
  if(resume) args.push('--resume',resume);
  return args;
}
