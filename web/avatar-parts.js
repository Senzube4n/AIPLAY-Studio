/** Advanced local part preparation; the HTTP service is also exposed through MCP. */
export function mountAvatarParts() {
  const $=id=>document.getElementById(id), form=$('part-form');
  let inspection=null,busy=false,timer;
  const api=async body=>{const r=await fetch('/api/avatar-weight-transfer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error||`HTTP ${r.status}`);return value;};
  const paths=()=>({reference_path:form.elements.reference_path.value.trim(),target_path:form.elements.target_path.value.trim()});
  const note=(message,isError=false)=>{$('part-note').textContent=message;$('part-note').className=`hint${isError?' warnhint':''}`;};
  const paint=()=>{$('part-inspect').disabled=busy;$('part-submit').disabled=busy||!inspection;$('part-get').disabled=busy;};
  const work=async task=>{if(busy)return;busy=true;paint();try{await task();}catch(e){note(e.message,true);}finally{busy=false;paint();}};
  function display(job){
    $('part-job').value=job.id;$('part-state').textContent=job.state==='complete'?'Review required':job.state;
    if(job.state==='complete'){note(`${job.result.vertices.toLocaleString()} vertices · ${job.result.joints} joints`);$('part-output').textContent=job.result.output;}
    else if(job.error)note(job.error,true);
    clearTimeout(timer);
    if(job.state==='running')timer=setTimeout(()=>work(async()=>display(await api({action:'get',id:job.id}))),1500);
  }
  for(const name of ['reference_path','target_path'])form.elements[name].oninput=()=>{inspection=null;paint();};
  $('part-inspect').onclick=()=>work(async()=>{
    const selected=paths();inspection=null;$('part-state').textContent='Inspecting';
    const next=await api({action:'inspect',...selected});
    if(JSON.stringify(selected)!==JSON.stringify(paths())){note('Paths changed. Inspect again.',true);return;}
    inspection=next;$('part-state').textContent='Inputs checked';note(`${next.joints} joints. Confirm alignment before transfer.`);
  });
  form.onsubmit=event=>{event.preventDefault();work(async()=>{
    if(!inspection)throw Error('Inspect both files first.');
    const body={action:'submit',...paths(),reference_sha256:inspection.reference_sha256,target_sha256:inspection.target_sha256,expected_skeleton:inspection.skeleton,
      transform:JSON.parse(form.elements.transform.value),max_distance:Number(form.elements.max_distance.value)};
    for(const name of ['name','source','license'])body[name]=form.elements[name].value.trim();
    $('part-output').textContent='';display(await api(body));
  });};
  $('part-get').onclick=()=>work(async()=>display(await api({action:'get',id:$('part-job').value.trim()})));
  $('part-panel').addEventListener('toggle',()=>{if($('part-panel').open&&!inspection)work(async()=>{const info=await api({action:'status'});$('part-state').textContent=info.available?'Local CPU tool':'Setup needed';note(info.available?'Use an aligned, unrigged attachment and a weighted base.':info.reason,!info.available);});});
  paint();
}
