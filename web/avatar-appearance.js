import * as THREE from 'three';

/** The page and MCP share the persisted, source-hashed appearance service. */
export async function mountAvatarAppearance({row,runtime,api,status,isCurrent=()=>true,onLook=()=>{}}) {
  const $=id=>document.getElementById(id),host=$('appearance-panel');
  let live=true,dirty=false,busy=false,polling=false,look=null,lastActive='',settings={},timer,version=0;
  const current=()=>live&&isCurrent();
  const inventory=await api({action:'appearance_inventory',id:row.id});
  if(!current())return {dispose(){live=false;}};
  const ids=['appearance-parts','appearance-colors','appearance-expressions'];
  const elements=Object.fromEntries(ids.map(id=>[id,$(id)]));
  for(const el of Object.values(elements))el.replaceChildren();
  const controls=[],inputs=[];
  const markDirty=()=>{if(!current()||busy)return;dirty=true;version++;$('appearance-state').textContent='Unsaved look';};
  const changed=()=>{markDirty();try{runtime.apply(settings);}catch(e){if(current())status(e.message,true);}};
  const label=(text,input,container)=>{const el=document.createElement('label');const name=document.createElement('span');name.textContent=text;el.append(name,input);container.append(el);inputs.push(input);return el;};
  for(const n of inventory.nodes.filter(n=>n.activeInScene)){
    const input=document.createElement('input');input.type='checkbox';input.checked=true;
    input.title='Show this existing mesh; its rig and weights stay attached.';
    label(n.name,input,elements['appearance-parts']);
    input.onchange=()=>{if(!current()||busy)return;const hidden=new Set(settings.hidden_nodes||[]);input.checked?hidden.delete(n.index):hidden.add(n.index);settings.hidden_nodes=[...hidden];changed();};
    controls.push(()=>{input.checked=!(settings.hidden_nodes||[]).includes(n.index);});
  }
  for(const m of inventory.materials){
    const input=document.createElement('input');input.type='color';input.title='Tint the existing material and texture.';
    label(m.name,input,elements['appearance-colors']);
    input.oninput=()=>{if(!current()||busy)return;const c=new THREE.Color(input.value);settings.material_colors={...settings.material_colors,[m.index]:[c.r,c.g,c.b,(settings.material_colors?.[m.index]||m.baseColor)[3]]};changed();};
    controls.push(()=>{const c=settings.material_colors?.[m.index]||m.baseColor;input.value='#'+new THREE.Color().setRGB(...c.slice(0,3)).getHexString();});
  }
  for(const e of inventory.expressions){
    const input=document.createElement('input');input.type='range';input.min='0';input.max='1';input.step=e.isBinary?'1':'.01';input.value='0';
    label(e.name,input,elements['appearance-expressions']);input.oninput=()=>{if(!current()||busy)return;settings.expressions={...settings.expressions,[e.name]:Number(input.value)};changed();};
    controls.push(()=>{input.value=String(settings.expressions?.[e.name]||0);});
  }
  $('appearance-expression-group').hidden=!inventory.expressions.length;
  $('appearance-springs').title=inventory.spring.supported?`${inventory.spring.chains} embedded spring chains`:'This file has no spring chains.';
  const updateDisabled=()=>{
    for(const input of inputs)input.disabled=busy;
    for(const id of ['appearance-name','appearance-persona','appearance-looks','appearance-new','appearance-save'])$(id).disabled=busy;
    $('appearance-delete').disabled=busy||!look;
    $('appearance-springs').disabled=busy||!inventory.spring.supported;
  };
  const paint=()=>{for(const c of controls)c();$('appearance-springs').checked=inventory.spring.supported&&settings.spring_enabled!==false;updateDisabled();};
  const apply=next=>{look=next;settings=structuredClone(next?.settings||{});$('appearance-name').value=next?.name||'';$('appearance-persona').value=next?.personaAttribution?.personaId||'';dirty=false;runtime.apply(settings);paint();$('appearance-state').textContent=next?'Saved look':'Embedded defaults';onLook(next);};
  const refresh=async(token=version)=>{const rows=await api({action:'appearance_list',id:row.id});if(!current()||token!==version)return;$('appearance-looks').replaceChildren(new Option('Choose a look',''));for(const r of rows)$('appearance-looks').add(new Option(r.name,r.id));$('appearance-looks').value=look?.id||'';};
  const select=async(id,token)=>{const next=await api({action:'appearance_activate',id:row.id,look_id:id,sha256:inventory.sha256});if(!current()||token!==version)return;apply(next);lastActive=`${next.id}:${next.revision}`;$('appearance-looks').value=next.id;};
  const operation=async work=>{
    if(!current()||busy)return;
    const token=++version;busy=true;updateDisabled();
    try{await work(token);}catch(e){if(current()&&token===version){$('appearance-looks').value=look?.id||'';status(e.message,true);}}
    finally{if(current()&&token===version){busy=false;updateDisabled();}}
  };
  $('appearance-springs').onchange=()=>{if(!current()||busy)return;settings.spring_enabled=$('appearance-springs').checked;changed();};
  $('appearance-name').oninput=$('appearance-persona').oninput=markDirty;
  $('appearance-looks').onchange=()=>operation(async token=>{const id=$('appearance-looks').value;if(id)await select(id,token);else $('appearance-looks').value=look?.id||'';});
  $('appearance-new').onclick=()=>{if(!current()||busy)return;version++;apply(null);dirty=true;$('appearance-looks').value='';$('appearance-state').textContent='Unsaved look';};
  $('appearance-save').onclick=()=>operation(async token=>{
    const next=await api({action:'appearance_save',id:row.id,sha256:inventory.sha256,...(look?{look_id:look.id}:{}),expected_revision:look?.revision||0,name:$('appearance-name').value,persona_id:$('appearance-persona').value||null,settings:structuredClone(settings)});
    if(!current()||token!==version)return;
    // Remember a successful save even if activation fails, so retrying cannot create a duplicate.
    apply(next);$('appearance-state').textContent='Saved, not active';await refresh(token);
    if(current()&&token===version)await select(next.id,token);
  });
  $('appearance-delete').onclick=()=>operation(async token=>{
    if(!look)return;
    await api({action:'appearance_delete',id:row.id,look_id:look.id,sha256:inventory.sha256,expected_revision:look.revision});
    if(!current()||token!==version)return;
    apply(null);lastActive='';await refresh(token);
  });
  const poll=async()=>{
    if(!current()||document.hidden||dirty||busy||polling)return;
    const token=version;polling=true;
    try{
      const active=await api({action:'appearance_active',id:row.id});
      if(!current()||dirty||busy||token!==version)return;
      const key=active?`${active.id}:${active.revision}`:'';
      if(key!==lastActive){apply(active);lastActive=key;await refresh(token);}
    }catch(e){if(current()&&!dirty&&!busy&&token===version)$('appearance-state').textContent=e.message;}
    finally{polling=false;}
  };
  const active=await api({action:'appearance_active',id:row.id});
  if(!current())return {dispose(){live=false;}};
  apply(active);lastActive=look?`${look.id}:${look.revision}`:'';
  await refresh();
  if(!current())return {dispose(){live=false;}};
  host.hidden=false;timer=setInterval(poll,2000);
  return {snapshot:()=>({look:look?structuredClone(look):null,dirty,busy}),dispose(){const ownsPanel=current();live=false;clearInterval(timer);if(ownsPanel)host.hidden=true;}};
}
