/** Export saved state, never an unsaved appearance or a partial outfit preview. */
export function outfitExportRequest(row, appearance, wardrobe) {
  if(row.inspection.profile!=='vrm') throw Error('Choose a VRM avatar.');
  if(!appearance || !wardrobe || appearance.busy || wardrobe.busy) throw Error('Wait for the current change.');
  if(appearance.dirty) throw Error('Save the look before exporting.');
  if(wardrobe.dirty) throw Error('Save the outfit before exporting.');
  const look=appearance.look, selected=wardrobe.selection;
  if(!selected || selected.look_id!==(look?.id??null) || selected.sha256!==row.inspection.sha256) throw Error('Wait for the saved outfit to load.');
  return {action:'prepare',id:row.id,sha256:row.inspection.sha256,look_id:look?.id??null,
    expected_look_revision:look?.revision??0,expected_wardrobe_revision:selected.revision};
}
export function mountAvatarHandoff({row,getContext,isCurrent=()=>true,documentRef=document,
  api=async body=>{const r=await fetch('/api/avatars/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error||'Export unavailable');return value;}}) {
  const button=documentRef.getElementById('outfit-export'),note=documentRef.getElementById('outfit-note'),downloads=documentRef.getElementById('outfit-downloads');
  let live=true,busy=false;
  button.disabled=row.inspection.profile!=='vrm';note.hidden=true;downloads.replaceChildren();
  const exportOutfit=async()=>{
    if(!live||!isCurrent()||busy)return;
    busy=true;button.disabled=true;note.hidden=false;note.textContent='Preparing outfit';downloads.replaceChildren();
    try {
      const context=getContext(),body=outfitExportRequest(row,context.appearance,context.wardrobe);
      const result=await api(body);
      if(!live||!isCurrent())return;
      const now=getContext();
      if(JSON.stringify(outfitExportRequest(row,now.appearance,now.wardrobe))!==JSON.stringify(body)) throw Error('The preview changed. Export the saved outfit again.');
      for(const [key,label,name] of [['bundle','Download outfit','outfit.aiplay-avatar.json'],['vrm','Download VRM','outfit.vrm']]) {
        const url=result.files?.[key];
        if(typeof url!=='string'||!/^\/api\/avatars\/handoff\/outfit_[a-f0-9]{64}\/(outfit\.vrm|outfit\.aiplay-avatar\.json)$/.test(url)) throw Error('Invalid outfit download.');
        const link=documentRef.createElement('a');link.className='btn2';link.href=url;link.download=name;link.textContent=label;downloads.append(link);
      }
      note.textContent=result.worldCandidate?'Outfit ready':'Local export ready. World requires the sample base and at most 16 MiB.';
    } catch(error) {if(live&&isCurrent()){downloads.replaceChildren();note.textContent=error.message;}}
    finally {busy=false;if(live&&isCurrent())button.disabled=row.inspection.profile!=='vrm';}
  };
  button.onclick=exportOutfit;
  return {dispose(){
    live=false;
    // The same controls are reused by another avatar mount. Only their current
    // owner may clear existing links or unbind the click handler.
    if(button.onclick===exportOutfit){button.onclick=null;button.disabled=true;downloads.replaceChildren();note.hidden=true;note.textContent='';}
  }};
}
