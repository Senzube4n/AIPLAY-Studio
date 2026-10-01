const esc = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const cueOverlayOpacity = (elapsed,duration,strength) => elapsed < 0 || elapsed >= duration ? 0 : strength / 100 * (1-elapsed/duration);
export const cuePreviewAlignment = plan => `${plan.position.bar}.${plan.position.beat}.${plan.position.tick} · DAW ${plan.musicSeconds.toFixed(3)} s · VFX ${plan.visualSeconds.toFixed(3)} s`;

/** Music Lab tab; all edits use the same typed route as MCP. */
export async function mountSharedCues(host,{fetch:request = globalThis.fetch.bind(globalThis)}={}) {
  host.classList.add('music-shared-cues');
  host.innerHTML=`<section class="pcard" data-nav="Cue" id="sharedCueEditor">
    <h3>Shared cues</h3><p class="pcard-sub">Place a musical accent and a flash at the same moment.</p>
    <div class="params"><label for="sharedCueSaved">saved cue</label><span class="pv"><select id="sharedCueSaved" class="sel2" name="saved"><option value="">New cue</option></select></span></div>
    <form class="sc-form"><div class="params">
      <label for="sharedCueName">name</label><span class="pv"><input id="sharedCueName" name="name" class="in2" value="Drop" maxlength="32" required></span>
      <label for="sharedCueProject">DAW project</label><span class="pv"><select id="sharedCueProject" name="project" class="sel2" required><option value="">Choose project…</option></select></span>
      <label for="sharedCueComp">VFX composition</label><span class="pv"><select id="sharedCueComp" name="comp" class="sel2" required><option value="">Choose composition…</option></select></span>
      <label for="sharedCueBar">bar / beat</label><span class="pv sc-position"><input id="sharedCueBar" name="bar" class="in2 num" type="number" min="1" max="256" step="1" value="1" aria-label="Bar" required><input name="beat" class="in2 num" type="number" min="1" max="32" step="1" value="1" aria-label="Beat" required></span>
      <label for="sharedCueAccent">accent</label><span class="pv"><select id="sharedCueAccent" name="accent" class="sel2"><option value="impact">Impact</option><option value="kick">909 kick</option></select></span>
      <label for="sharedCueDuration">length (beats)</label><span class="pv"><input id="sharedCueDuration" name="durationBeats" class="in2 num" type="number" min="0.1" max="4" step="0.1" value="0.5" required></span>
      <label for="sharedCueStrength">flash (%)</label><span class="pv"><input id="sharedCueStrength" name="flashStrength" class="in2 num" type="number" min="1" max="50" step="1" value="20" required></span>
      <label for="sharedCueOffset">VFX offset (s)</label><span class="pv"><input id="sharedCueOffset" name="compOffsetSeconds" class="in2 num" type="number" min="-600" max="600" step="0.001" value="0" title="VFX time = DAW time + this offset. Set this when the composition starts at a different song time." required></span>
    </div><details class="more"><summary>Accent controls</summary><div class="params">
      <label for="sharedCueTick">tick</label><span class="pv"><input id="sharedCueTick" name="tick" class="in2 num" type="number" min="0" max="959" step="1" value="0" required></span>
      <label for="sharedCueVelocity">velocity</label><span class="pv"><input id="sharedCueVelocity" name="velocity" class="in2 num" type="number" min="1" max="127" step="1" value="100" required></span>
      <label for="sharedCueGain">gain (dB)</label><span class="pv"><input id="sharedCueGain" name="gainDb" class="in2 num" type="number" min="-24" max="0" step="0.1" value="-6" required></span>
    </div></details><div class="cta"><button type="submit" class="btn primary" data-action="preview">Preview</button><button type="button" class="btn2 go" data-action="apply" disabled>Apply</button><button type="button" class="btn2" data-action="undo" disabled>Undo</button><button type="button" class="btn2" data-action="new">New cue</button><button type="button" class="btn2" data-action="refresh">Refresh</button></div></form>
    <p class="sc-state"><span class="chip" role="status" aria-live="polite">Choose projects</span></p><p class="hint warnhint sc-error" hidden></p>
  </section><section class="pcard sc-preview" data-nav="Preview" id="sharedCuePreview" hidden>
    <div class="sc-preview-head"><h3>Preview</h3><span class="chip sc-preview-kind">Flash simulation</span></div>
    <p class="sc-alignment"></p><div class="sc-media"><canvas aria-label="Composition still with flash preview"></canvas><p class="hint sc-frame-error" hidden></p></div>
    <label class="sc-audio-label">Dry accent<audio controls preload="none"></audio></label>
    <p class="hint">The DAW mix and master can change the accent sound.</p>
    <details class="more"><summary>Plan details</summary><pre class="sc-plan"></pre></details>
  </section>`;
  const q=selector=>host.querySelector(selector),field=name=>q(`[name="${name}"]`),form=q('form'),audio=q('audio'),canvas=q('canvas'),state=q('[role="status"]');
  let data=null,current=null,plan=null,baseFrame=null,pending=false,epoch=0,frameEpoch=0,raf=null,disposed=false;
  const defaults={name:'Drop',project:'',comp:'',bar:1,beat:1,tick:0,accent:'impact',durationBeats:.5,flashStrength:20,velocity:100,gainDb:-6,compOffsetSeconds:0};
  function status(text,tone='') {state.textContent=text;state.className=`chip ${tone}`;}
  function error(text='') {q('.sc-error').textContent=text;q('.sc-error').hidden=!text;}
  async function api(body) {const response=await request('/api/music-cues',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
    const value=await response.json();if(!response.ok||value.error){if(value.cue)current=value.cue;throw new Error(value.error||`HTTP ${response.status}`);}return value;}
  function controls() {
    const applied=['applied','partial','applying','undoing'].includes(current?.state);
    for(const input of form.querySelectorAll('input,select')) input.disabled=pending||applied;
    field('saved').disabled=pending;
    for(const button of form.querySelectorAll('button')) button.disabled=pending;
    q('[data-action="preview"]').disabled=pending||applied;
    q('[data-action="apply"]').disabled=pending||applied||!plan;
    q('[data-action="undo"]').disabled=pending||!applied;
  }
  const clearPlayback=()=>{audio.pause();audio.removeAttribute('src');audio.load();if(raf!==null)cancelAnimationFrame(raf);raf=null;};
  function invalidate() {epoch++;frameEpoch++;plan=null;baseFrame=null;clearPlayback();q('.sc-preview').hidden=true;error();controls();status('Preview needed');}
  function options(select,rows,placeholder) {const chosen=select.value;select.innerHTML=`<option value="">${placeholder}</option>`+rows.map(row=>`<option value="${esc(row.slug)}">${esc(row.name||row.slug)}</option>`).join('');select.value=chosen;}
  function savedOptions() {const chosen=current?.id||'';field('saved').innerHTML='<option value="">New cue</option>'+(data?.cues||[]).map(c=>`<option value="${esc(c.id)}">${esc(c.recipe.name)} · ${esc(c.state)}</option>`).join('');field('saved').value=chosen;}
  function recipe() {const r={};for(const key of Object.keys(defaults))r[key]=['name','project','comp','accent'].includes(key)?field(key).value:Number(field(key).value);return r;}
  function setRecipe(value) {for(const [key,defaultValue] of Object.entries(defaults))field(key).value=value?.[key]??defaultValue;}
  function paintFrame(elapsed=-1) {
    if(!baseFrame||!plan) return;const ctx=canvas.getContext('2d');if(!ctx)return;
    canvas.width=baseFrame.naturalWidth;canvas.height=baseFrame.naturalHeight;ctx.drawImage(baseFrame,0,0);
    if(current?.state!=='applied') {const opacity=cueOverlayOpacity(elapsed,plan.durationSeconds,plan.recipe.flashStrength);
      if(opacity>0){ctx.globalAlpha=opacity;ctx.fillStyle=`rgb(${plan.layer.color.slice(0,3).join(',')})`;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.globalAlpha=1;}}
  }
  async function frame(url,actual=false) {
    const key=++frameEpoch,image=new Image();q('.sc-frame-error').hidden=true;
    try {await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Composition preview unavailable.'));image.src=url;});
      if(disposed||key!==frameEpoch)return;baseFrame=image;paintFrame(actual?-1:0);
    }catch(e){if(key!==frameEpoch)return;q('.sc-frame-error').textContent=e.message;q('.sc-frame-error').hidden=false;}
  }
  function showPlan(value) {plan=value;q('.sc-preview').hidden=false;q('.sc-alignment').textContent=cuePreviewAlignment(plan);
    q('.sc-plan').textContent=JSON.stringify({position:plan.position,musicSeconds:plan.musicSeconds,visualSeconds:plan.visualSeconds,compOffsetSeconds:plan.recipe.compOffsetSeconds,
      accent:plan.audioJob.notes[0],opacityKeys:plan.layer.transform.opacity.keys,previewToken:plan.previewToken},null,2);
    const actual=current?.state==='applied';q('.sc-preview-kind').textContent=actual?'Applied frame':'Flash simulation';canvas.setAttribute('aria-label',actual?'Applied VFX composition frame':'Composition still with simulated flash');controls();}
  async function refresh() {data=await api();if(disposed)return;options(field('project'),data.projects,'Choose project…');options(field('comp'),data.comps,'Choose composition…');
    if(current){current=data.cues.find(c=>c.id===current.id)||null;}savedOptions();controls();}
  async function task(text,fn) {if(pending||disposed)return;pending=true;controls();error();status(text,'busy');
    try{await fn();}catch(e){error(e.message);status(current?.state==='partial'?'Undo needed':'Could not finish','err');}
    finally{pending=false;controls();}}
  form.addEventListener('input',()=>{if(!pending)invalidate();});
  form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity())return;
    task('Preparing preview',async()=>{
      const ticket=++epoch,result=await api({action:'save',...(current?{id:current.id}:{}),...recipe()});if(disposed||ticket!==epoch)return;
      current=result.cue;showPlan(result.plan);await refresh();
      const audition=await api({action:'audition',id:current.id,previewToken:plan.previewToken});if(disposed||ticket!==epoch)return;
      audio.src=audition.audioUrl;await frame(audition.frameUrl);status('Preview ready','ok');
    });});
  field('saved').addEventListener('change',()=>task('Opening cue',async()=>{
    invalidate();current=data.cues.find(c=>c.id===field('saved').value)||null;setRecipe(current?.recipe);
    if(!current){status('New cue');return;}
    const result=await api({action:'read',id:current.id});current=result.cue;
    if(current.state==='partial'){status('Undo needed','warn');error(current.error||'A partial change needs Undo.');return;}
    if(current.state==='applied'){const receipt=current.receipt;
      plan={position:{bar:current.recipe.bar,beat:current.recipe.beat,tick:current.recipe.tick},musicSeconds:receipt.musicSeconds,visualSeconds:receipt.visualSeconds,
        durationSeconds:receipt.layer.end-receipt.layer.start,recipe:current.recipe,layer:receipt.layer,audioJob:{notes:[{inst:current.recipe.accent==='kick'?'tr909':'impact'}]}};
      showPlan(plan);await frame(`/api/vfx/frame/${encodeURIComponent(current.recipe.comp)}?t=${receipt.visualSeconds}&scale=.25&draft=1&cueRevision=${current.updatedAt}`,true);
      status('Applied','ok');return;}
    status('Preview needed');
  }));
  q('[data-action="apply"]').addEventListener('click',()=>task('Applying cue',async()=>{
    const result=await api({action:'apply',id:current.id,previewToken:plan.previewToken});current=result.cue;audio.pause();showPlan(plan);
    await frame(`${plan.frameUrl}&cueRevision=${current.updatedAt}`,true);await refresh();status('Applied','ok');
  }));
  q('[data-action="undo"]').addEventListener('click',()=>task('Undoing cue',async()=>{
    const result=await api({action:'undo',id:current.id});current=result.cue;invalidate();await refresh();status('Undone','ok');
  }));
  q('[data-action="new"]').addEventListener('click',()=>{if(pending)return;invalidate();current=null;setRecipe();savedOptions();controls();status('New cue');});
  q('[data-action="refresh"]').addEventListener('click',()=>task('Refreshing',async()=>{invalidate();await refresh();status(current?.state==='applied'?'Applied':'Preview needed',current?.state==='applied'?'ok':'');}));
  const reducedMotion=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const animate=()=>{if(disposed||!plan||audio.paused)return;paintFrame(reducedMotion()?0:audio.currentTime);if(!reducedMotion())raf=requestAnimationFrame(animate);};
  audio.addEventListener('play',()=>{const mainAudio=document.getElementById('audio');if(mainAudio&&mainAudio!==audio)mainAudio.pause();if(raf!==null)cancelAnimationFrame(raf);animate();});
  audio.addEventListener('pause',()=>{if(raf!==null)cancelAnimationFrame(raf);raf=null;paintFrame(audio.currentTime);});
  audio.addEventListener('seeked',()=>paintFrame(audio.currentTime));audio.addEventListener('ended',()=>paintFrame(-1));
  const visibility=()=>{if(document.hidden||host.closest('[hidden]'))audio.pause();};
  document.addEventListener('visibilitychange',visibility);
  const observer=typeof MutationObserver==='function'?new MutationObserver(visibility):null;
  if(observer)observer.observe(host.parentElement||host,{attributes:true,subtree:true,attributeFilter:['hidden']});
  await task('Loading cues',async()=>{await refresh();status(data.projects.length&&data.comps.length?'Ready':'Choose projects');});
  return {dispose(){disposed=true;epoch++;frameEpoch++;clearPlayback();observer?.disconnect();document.removeEventListener('visibilitychange',visibility);}};
}
