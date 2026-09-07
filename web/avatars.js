import { mountInfo } from './info.js';
import * as THREE from 'three';
import { GLTFLoader } from '/api/avatars/vendor/loaders/GLTFLoader.js';
import { OrbitControls } from '/api/avatars/vendor/controls/OrbitControls.js';
const $=id=>document.getElementById(id),status=(message,error=false)=>{$('status').textContent=message;$('status').className=error?'error':'';};
const api=async body=>{const r=await fetch('/api/avatars',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const data=await r.json();if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);return data;};
let selected=null,epoch=0,model=null,mixer=null,clips=[],action=null,playing=false,helper=null,renderer=null,controls=null,scene=null,camera=null;
const viewport=$('viewport'),center=new THREE.Vector3(0,1,0);let radius=2;
function initViewer(){
  if(renderer)return;
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
  viewport.append(renderer.domElement);scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(35,1,.01,200);camera.position.set(2,1.5,4);
  controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=.2;controls.maxDistance=15;
  scene.add(new THREE.HemisphereLight(0xeaf3ff,0x4d566a,2.4));const key=new THREE.DirectionalLight(0xffeedb,3);key.position.set(3,5,4);scene.add(key);const fill=new THREE.DirectionalLight(0xa5c8ff,1.8);fill.position.set(-4,2,-3);scene.add(fill);
  scene.add(new THREE.GridHelper(6,30,0x68857e,0x334455));
  new ResizeObserver(()=>{const w=viewport.clientWidth,h=viewport.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}).observe(viewport);
  let last=performance.now();renderer.setAnimationLoop(now=>{const dt=Math.min((now-last)/1000,.05);last=now;if(document.hidden)return;if(playing&&mixer){mixer.update(dt*Number($('speed').value));updateTime();}controls.update();renderer.render(scene,camera);});
}
function dispose(root){root?.traverse(o=>{o.geometry?.dispose();for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m){for(const t of Object.values(m))if(t?.isTexture){t.dispose();t.source?.data?.close?.();}m.dispose();}});}
function cameraView(view){if(!camera)return;const facing=selected?.coordinates.facing||'+Z';let theta={'+Z':0,'-Z':Math.PI,'+X':Math.PI/2,'-X':-Math.PI/2}[facing];if(view==='side')theta+=Math.PI/2;if(view==='back')theta+=Math.PI;if(view==='fit')theta+=.3;camera.position.copy(center).add(new THREE.Vector3(Math.sin(theta)*radius,.1*radius,Math.cos(theta)*radius));controls.target.copy(center);controls.update();}
function updateTime(){const t=action?.time||0;$('time').value=String(t);$('time-label').textContent=`${t.toFixed(2)} s`;}
function setMotion(index){mixer?.stopAllAction();action=null;model?.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.pose();});if(index!==''){action=mixer.clipAction(clips[Number(index)]);action.reset().play();mixer.update(0);$('time').max=String(clips[Number(index)].duration);$('time').disabled=false;$('play').disabled=false;}else{$('time').disabled=true;$('play').disabled=true;}playing=false;$('play').textContent='Play';updateTime();}
function showFacts(row){const i=row.inspection;$('facts').replaceChildren();for(const [value,label] of [[i.triangles.toLocaleString(),'triangles'],[i.joints,'joints'],[(i.bytes/1024/1024).toFixed(2)+' MiB','file size'],[i.clips.length,'own clips']]){const el=document.createElement('div');el.className='fact';const b=document.createElement('strong');b.textContent=value;const s=document.createElement('span');s.textContent=label;el.append(b,s);$('facts').append(el);} $('warnings').replaceChildren();for(const message of i.validation.warnings){const p=document.createElement('p');p.textContent=message;$('warnings').append(p);} $('metadata').textContent=JSON.stringify({source:row.source,license:row.license,persona:row.personaAttribution,coordinates:row.coordinates,skeletonFamily:row.skeletonFamily,sha256:i.sha256,joints:i.jointNames,clips:i.clips,anchors:i.anchors,validation:i.validation},null,2);}
async function select(id){
  const token=++epoch;playing=false;if(model)model.visible=false;if(helper)helper.visible=false;status('Validating character…');$('downloads').replaceChildren();$('export').disabled=true;$('motion').disabled=true;$('play').disabled=true;$('time').disabled=true;
  try{
    const row=await api({action:'inspect',id});if(token!==epoch)return;
    selected=row;playing=false;$('character-name').textContent=row.name;$('family').textContent=row.skeletonFamily;$('review-state').textContent='Needs visual review';$('details').hidden=false;showFacts(row);
    for(const b of $('library').querySelectorAll('button'))b.setAttribute('aria-current',String(b.dataset.id===id));
    initViewer();const gltf=await new GLTFLoader().loadAsync(row.files.glb);if(token!==epoch){dispose(gltf.scene);return;}
    mixer?.stopAllAction();if(model){mixer?.uncacheRoot(model);scene.remove(model);dispose(model);}if(helper){scene.remove(helper);helper.dispose();}
    model=gltf.scene;scene.add(model);model.updateMatrixWorld(true);clips=gltf.animations;mixer=new THREE.AnimationMixer(model);helper=new THREE.SkeletonHelper(model);helper.visible=$('skeleton').checked;scene.add(helper);
    const box=new THREE.Box3().setFromObject(model);box.getCenter(center);radius=Math.max(box.getSize(new THREE.Vector3()).length()*1.3,1);cameraView('fit');
    $('motion').replaceChildren(new Option('Rest pose',''));clips.forEach((c,i)=>$('motion').add(new Option(`${c.name} · ${c.duration.toFixed(2)} s`,String(i))));$('motion').disabled=false;setMotion('');$('empty-view').hidden=true;$('export').disabled=false;
    $('wireframe').dispatchEvent(new Event('change'));history.replaceState(null,'',`?id=${id}`);status('Skin and file structure verified. Review the character and each motion before handoff.');
  }catch(e){if(token===epoch)status(e.message,true);}
}
async function refresh(preferred){const data=await api();$('library').replaceChildren();for(const row of data.avatars){const b=document.createElement('button');b.dataset.id=row.id;b.textContent=row.name;const s=document.createElement('small');s.textContent=`${row.inspection.joints} joints · ${row.inspection.clips.length} clips`;b.append(s);b.onclick=()=>select(row.id);$('library').append(b);}if(!data.avatars.length){$('library').textContent='No characters imported yet.';status('Import a rigged GLB from Blender or your character pipeline.');}else{const id=preferred||selected?.id||data.avatars[0].id;await select(id);}}
$('refresh').onclick=()=>refresh().catch(e=>status(e.message,true));
$('import-form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;try{const f=form.elements.file.files[0];if(!f||f.size>8*1024*1024)throw Error('Choose a GLB up to 8 MiB.');status('Checking the GLB, skin and textures…');const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));const body={action:'import',data_base64:btoa(binary)};for(const name of ['name','persona_id','facing','skeleton_family','source','license'])body[name]=form.elements[name].value;const row=await api(body);$('import-panel').open=false;await refresh(row.id);}catch(e){status(e.message,true);}finally{button.disabled=false;}};
$('motion').onchange=()=>setMotion($('motion').value);
$('play').onclick=()=>{playing=!playing;$('play').textContent=playing?'Pause':'Play';};
$('time').oninput=()=>{playing=false;$('play').textContent='Play';if(action){action.time=Number($('time').value);mixer.update(0);updateTime();}};
$('skeleton').onchange=()=>{if(helper)helper.visible=$('skeleton').checked;};
$('wireframe').onchange=()=>model?.traverse(o=>{for(const m of Array.isArray(o.material)?o.material:[o.material])if(m)m.wireframe=$('wireframe').checked;});
for(const b of document.querySelectorAll('[data-camera]'))b.onclick=()=>cameraView(b.dataset.camera);
$('export').onclick=async()=>{if(!selected)return;const id=selected.id,token=epoch;$('export').disabled=true;try{const row=await api({action:'export',id});if(token!==epoch)return;$('downloads').replaceChildren();for(const [name,url] of [['Download GLB',row.files.glb],['Download manifest',row.files.manifest]]){const a=document.createElement('a');a.textContent=name;a.href=url;a.download=name.includes('GLB')?`${id}.glb`:`${id}.json`;$('downloads').append(a);}status('Handoff files ready. Visual review and world adoption remain separate.');}catch(e){if(token===epoch)status(e.message,true);}finally{if(token===epoch)$('export').disabled=false;}};
refresh(new URLSearchParams(location.search).get('id')).catch(e=>status(e.message,true));
/* The ⓘ this page owes every reader, mounted the way web/daw.js mounts its
   own: this is a page rather than a view, so there is no compositor in
   web/app.js to loop over it. The panel's whole content is the catalogue
   entry that already exists — one import, one call, no prose here. */
mountInfo('avatars', '#avatarInfoHost');
