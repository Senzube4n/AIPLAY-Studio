/** Local adapter for the existing provider downloader and creative references. */
import { createModelManager } from '../worker/model-manager.js';
import { MODEL_PROVIDERS, catalogFiles, searchCatalog } from './engine/model-catalog.js';
import { isLoopbackAddress } from './lan.js';
import { modelCompatibility } from './engine/model-compatibility.js';
import { createCreativeTemplates, makeCreativeTemplate, previewCreativeTemplate } from './creative-templates.js';
import { MODEL_PROFILES } from '../shared/model-profiles.js';
import { setupPlan } from './setup-plan.js';

class ModelLibraryRequestError extends Error {}

export function createModelLibraryRoutes({ config, json, readBody, sameOriginLocalJson, getSecret, setSecret, clearSecret, localFiles, localObjects, localMachine = ()=>null, busy, fetchFn = fetch, managerFactory = createModelManager }) {
  const templates = createCreativeTemplates({dir:config.paths.appData});
  let manager;
  const downloads = () => manager ||= managerFactory({modelsDir:config.modelsDir,bundles:{},fetchFn});
  return async (req,res,url) => {
    if (!url.pathname.startsWith('/api/model-library/')) return false;
    const local=[`127.0.0.1:${config.uiPort}`,`localhost:${config.uiPort}`,`[::1]:${config.uiPort}`];
    const origins=local.map(host=>`http://${host}`);
    if (req.lanClient || !isLoopbackAddress(req.socket?.remoteAddress)
      || !local.includes(String(req.headers.host || '')) || req.headers.origin && !origins.includes(req.headers.origin)
      || req.method !== 'GET' && !sameOriginLocalJson(req)) {json(res,403,{error:'Use JSON from this PC’s Studio page.'});return true;}
    const route=url.pathname.slice('/api/model-library/'.length), input=Object.fromEntries(url.searchParams);
    try {
      if(route==='connections' && req.method==='GET') {
        const configured={};
        for(const [provider,key] of Object.entries(MODEL_PROVIDERS))configured[provider]=!!await getSecret(key);
        json(res,200,{configured});
      } else if(route==='connections' && req.method==='POST') {
        const b=await readBody(req,4096);
        if(!Object.hasOwn(MODEL_PROVIDERS,b.provider))throw new ModelLibraryRequestError('Choose a model provider.');
        if(b.remove===true)await clearSecret(MODEL_PROVIDERS[b.provider]);
        else {
          const key=String(b.key||'').trim();
          if(key.length<10 || key.length>500 || /[^A-Za-z0-9_.-]/.test(key) || b.provider==='huggingface' && !key.startsWith('hf_'))throw new ModelLibraryRequestError('Enter a valid provider read key.');
          await setSecret(MODEL_PROVIDERS[b.provider],key);
        }
        json(res,200,{saved:b.remove!==true});
      } else if(['search','files'].includes(route) && req.method==='GET') {
        if(!Object.hasOwn(MODEL_PROVIDERS,input.provider))throw new ModelLibraryRequestError('Choose a model provider.');
        const token=await getSecret(MODEL_PROVIDERS[input.provider]);
        json(res,200,await(route==='search'?searchCatalog:catalogFiles)(input,{token,fetchFn}));
      } else if(route==='profiles' && req.method==='GET') {
        const target=input.target||'local';if(!['local','runpod'].includes(target))throw new ModelLibraryRequestError('Choose My Computer or RunPod.');
        const files=target==='local'?await localFiles():[],machine=target==='local'?localMachine():null;
        json(res,200,{target,profiles:MODEL_PROFILES.filter(p=>p.targets.includes(target)).map(p=>setupPlan({target,selection:{[p.category]:p.id},localFiles:files,machine}).profiles[0])});
      } else if(route==='templates' && req.method==='GET') json(res,200,{items:await templates.list()});
      else if(route==='templates' && req.method==='POST') {
        const b=await readBody(req,262144);
        if(b.action==='preview') {const target=b.target||b.template?.preferredLocation;json(res,200,previewCreativeTemplate(b.template,{target,localFiles:target==='local'?await localFiles():[],machine:target==='local'?localMachine():null}));}
        else if(b.action==='capture') json(res,200,{template:makeCreativeTemplate(b)});
        else if(b.action==='save') json(res,200,await templates.put(b.template,b.id));
        else if(b.action==='delete' && b.confirm==='DELETE TEMPLATE') json(res,200,await templates.remove(b.id));
        else throw new ModelLibraryRequestError('Choose a supported template action.');
      } else if(route==='disk' && req.method==='GET') json(res,200,{files:(await localFiles()).map(f=>({relative:f.folder+'/'+f.name,bytes:f.bytes})),partial:false});
      else if(route==='setup' && req.method==='GET') json(res,200,{...(await downloads()).status(),catalogVersion:1,downloadable:!config.remoteOnly});
      else if(route==='compatibility' && req.method==='GET') {
        if(!Object.hasOwn(MODEL_PROVIDERS,input.provider))throw new ModelLibraryRequestError('Choose a model provider.');
        const details=await catalogFiles(input,{token:await getSecret(MODEL_PROVIDERS[input.provider]),fetchFn});
        const file=details.files.find(f=>f.id===input.file),objects=await localObjects().catch(()=>null);
        // The local provider downloader cannot establish curated hash readiness.
        // Existing setup-plan verification remains authoritative for execution.
        const verdict=modelCompatibility({file,folder:input.folder,setup:null,objects});
        if(objects)verdict.note='Use Check setup to verify the complete local bundle and workflow.';
        json(res,200,verdict);
      } else if(route==='install' && req.method==='POST') {
        if(config.remoteOnly)throw new ModelLibraryRequestError('Use My Computer in the launcher before installing here.');
        if(await busy())throw new ModelLibraryRequestError('Wait for current work or model installation to finish.');
        const b=await readBody(req,4096);
        if(b.acceptLicense!==true)throw new ModelLibraryRequestError('Review and accept the model terms first.');
        if(!Object.hasOwn(MODEL_PROVIDERS,b.selection?.provider))throw new ModelLibraryRequestError('Choose a model provider.');
        const token=await getSecret(MODEL_PROVIDERS[b.selection.provider]);
        json(res,202,await(await downloads()).installCatalog(b.selection,b.acceptLicense,b.expected,token));
      } else if(route==='cancel' && req.method==='POST') json(res,200,(await downloads()).cancel());
      else json(res,405,{error:'Unsupported model library request.'});
    } catch(e) {json(res,e?.tooBig?413:400,{error:e instanceof ModelLibraryRequestError?e.message:'The model library request could not be completed. Check model access and storage.'});}
    return true;
  };
}
