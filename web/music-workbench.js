export async function mountMusicWorkbench(root) {
 if (!root.classList.contains('music-workbench')) {
  const response=await fetch('/music-workbench.html');
  if (!response.ok) throw new Error('Could not open native tools.');
  const template=new DOMParser().parseFromString(await response.text(),'text/html').querySelector('main.music-workbench');
  template.querySelector('.page-head')?.remove();
  for (const node of template.querySelectorAll('[id]')) {node.dataset.workbenchId=node.id;node.id='mwb-'+node.id;}
  root.replaceChildren(template);
 } else for (const node of root.querySelectorAll('[id]')) node.dataset.workbenchId=node.id;
 const $=id=>root.querySelector('[data-workbench-id="'+id+'"]');
 for (const node of root.querySelectorAll('input:not([type=checkbox]):not([type=range]),textarea')) node.classList.add('in2');
 for (const node of root.querySelectorAll('select')) node.classList.add('sel2');
let state={datasets:[],runs:[]},library=[],busy=false,historyKey='';
const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node;};
function options(node,rows,empty){const previous=node.value;node.replaceChildren();if(empty)node.add(new Option(empty,''));for(const row of rows)node.add(new Option((row.title||row.name||row.file||row.id)+(row.title&&row.file?' · '+row.file:''),row.file||row.id));if([...node.options].some(o=>o.value===previous))node.value=previous;}
function dataset(){return state.datasets.find(d=>d.id===$('datasets').value);}
function showSong(){const item=dataset()?.items.find(i=>i.id===$('songs').value);$('style').value=item?.style||'';$('lyrics').value=item?.lyrics||'';$('instrumental').checked=!!item?.instrumental;}
function showDataset(){options($('songs'),dataset()?.items||[]);showSong();}
async function action(body){const res=await fetch('/api/music-tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.error||'Request failed');return data;}
function button(id,fn){$(id).addEventListener('click',async()=>{if(busy)return;busy=true;$(id).disabled=true;$('message').textContent='';try{await fn();await refresh();}catch(e){$('message').textContent=e.message;$('message').className='hint warnhint';}finally{busy=false;$(id).disabled=false;}});}
function history(){const host=$('history');host.replaceChildren();for(const run of [...state.runs].sort((a,b)=>b.createdAt-a.createdAt).slice(0,30)){
 const card=text('div','');card.className='mwb-run';card.append(text('strong',`${run.kind} · ${run.state} · ${new Date(run.createdAt).toLocaleString()}`));
 if(run.error){const more=text('details','');more.className='more';more.append(text('summary','Diagnostics'),text('pre',run.error));card.append(more);}
 if(run.kind==='midi'&&run.state==='done'){
  if(run.daw){const link=text('a',run.dawReady?'Open editable tracks':'Inspect partial import');link.href='/daw.html?project='+encodeURIComponent(run.daw);link.target='_blank';link.rel='noopener';card.append(text('p',''),link);}
  else {const imp=text('button','Import notes to DAW');imp.className='btn2';imp.onclick=()=>action({action:'toDaw',run:run.id,bpm:120}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(imp);}
  card.append(text('p','Notes use a provisional 120 BPM timeline and the default pluck sound. Change tempo and instruments in the DAW.'));
 }
 if(run.kind==='plan'&&run.state==='done'){
  const follow=text('a','Follow playback');follow.href='/score-player.html?run='+encodeURIComponent(run.id);follow.target='_blank';follow.rel='noopener';card.append(text('p',''),follow);
  for(const [label,url]of [['Score',run.scoreUrl],['Semantic tokens',run.semanticUrl],['Exact request',run.requestUrl]])if(url){const link=text('a',label);link.href=url;link.download='';card.append(text('span',' · '),link);}
  const editor=document.createElement('textarea');editor.value=run.score||run.request.abc||'';editor.setAttribute('aria-label','Edit saved score');card.append(editor);
  const render=text('button','Render edited score');render.className='btn2';render.onclick=()=>action({action:'replay',run:run.id,abc:editor.value}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(render);
  if(run.semanticUrl){const replay=text('button','Replay saved tokens');replay.className='btn2';replay.onclick=()=>action({action:'replay',run:run.id,useTokens:true}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(replay);}
 }
 if(run.outputUrl){const a=text('a',run.kind==='midi'?'Download MIDI':run.kind==='export'?'Download adapter':'Download take');a.href=run.outputUrl;a.download='';card.append(text('p',''),a);
 if(run.kind==='export'){const install=text('button',run.installedAs?'Installed in Studio':'Use in Studio');install.className='btn2';install.disabled=!!run.installedAs;install.onclick=()=>action({action:'installAdapter',run:run.id}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(install);card.append(text('p',`Trigger: ${run.trigger||'none'}. On Music, choose YuE2 through ComfyUI and select this file in both Audio LoRA and Planner LoRA to apply both halves.`));}
 if(run.kind==='plan'){const keep=text('button',run.keptAs?'Saved to library':'Keep song');keep.className='btn2';keep.disabled=!!run.keptAs;keep.onclick=()=>action({action:'keepSong',run:run.id}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(keep);}
 if(run.kind==='process'){
  for(const [label,url]of [['Original',run.originalUrl],['Preview',run.outputUrl]]){card.append(text('p',label));const audio=document.createElement('audio');audio.controls=true;audio.preload='none';audio.src=url;card.append(audio);}
  const keep=text('button',run.keptAs?'Saved to library':'Keep preview');keep.className='btn2';keep.disabled=!!run.keptAs;keep.onclick=()=>action({action:'keep',run:run.id}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(keep);
 }}
 if(run.kind==='train'&&run.recipe){card.append(text('p',`Dataset ${run.body.dataset} · ${run.recipe.adapter} · ${run.recipe.optimizer} · ${run.recipe.steps} steps`));const more=text('button','Continue checkpoint');more.className='btn2';more.disabled=run.state==='running';more.onclick=()=>action({action:'continue',run:run.id,steps:Number($('steps').value)}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(more);const exp=text('button','Export ComfyUI LoRA');exp.className='btn2';exp.disabled=run.state==='running';exp.onclick=()=>action({action:'exportAdapter',run:run.id}).then(refresh).catch(e=>{$('message').textContent=e.message});card.append(exp);}
 host.append(card);
}}
async function refresh(){state=await action({action:'status'});const a=state.active;let progress='';if(a?.progress){const p=a.progress;if(p.file&&p.total)progress=` · ${p.file}: ${Math.round(p.bytes/p.total*100)}%`;else if(p.total!=null)progress=` · ${p.completed??p.done??p.step??0}/${p.total}`;else if(p.step!=null)progress=` · step ${p.step}`;}
 $('live').textContent=a?`${a.kind}: ${a.stage}${a.item?' · '+a.item:''}${progress}`:'Ready';$('diagnostics').textContent=(a?.log||[]).slice(-20).join('\n');$('stop').disabled=!a;
 const old=$('datasets').value;options($('datasets'),state.datasets);if(old!==$('datasets').value||!$('songs').options.length)showDataset();
 const caps=state.capabilities;$('trainCaps').textContent=`Native trainer: ${caps.training.runtime?'installed':'missing'}. Missing model files: ${caps.training.missing.length}.`;
 $('plannerCaps').textContent=`Planner: ${caps.planner.runtime?'installed':'missing'}. Optional Windows CUDA runtime; uses your installed native YuE2 Q4 model.`;
 $('midiCaps').textContent=`Runtime: ${caps.midi.runtime?'installed':'missing'}. Models: ${Object.entries(caps.midi.models).filter(([,ready])=>ready).map(([name])=>name).join(', ')||'none'}. Downloads: small 0.41 GB, medium 1.23 GB, large 5.47 GB.`;
 const key=JSON.stringify(state.runs);if(key!==historyKey){historyKey=key;history();}
}
$('datasets').onchange=showDataset;$('songs').onchange=showSong;
button('create',async()=>{const result=await action({action:'dataset',name:$('name').value,files:[...$('sources').selectedOptions].map(o=>o.value)});await refresh();$('datasets').value=result.dataset.id;showDataset();});
button('createFolder',async()=>{const result=await action({action:'dataset',name:$('name').value,folder:$('folder').value});await refresh();$('datasets').value=result.dataset.id;showDataset();});
button('save',()=>action({action:'edit',id:$('datasets').value,item:$('songs').value,style:$('style').value,lyrics:$('lyrics').value,instrumental:$('instrumental').checked}));
button('prepare',()=>action({action:'prepare',dataset:$('datasets').value}));
button('train',()=>action({action:'train',dataset:$('datasets').value,recipe:{preset:$('recipe').value,optimizer:$('optimizer').value,adapter:$('adapter').value,steps:Number($('steps').value)}}));
button('installTrain',()=>action({action:'install',kind:'train'}));button('installMidi',()=>action({action:'install',kind:'midi',size:$('size').value}));
button('installPlanner',()=>action({action:'install',kind:'planner'}));button('plan',()=>action({action:'plan',style:$('planStyle').value,lyrics:$('planLyrics').value,stage:$('planStage').value,...($('planSeed').value.trim()?{seed:Number($('planSeed').value)}:{}),maxTokens:Number($('planLimit').value)}));
button('transcribe',()=>action({action:'midi',file:$('midiSource').value,size:$('size').value,device:$('device').value}));
button('processTrack',()=>action({action:'process',file:$('processSource').value,reference:$('reference').value,denoise:$('denoise').checked,smoothing:Number($('smoothing').value),plugins:JSON.parse($('plugins').value)}));
button('stop',()=>action({action:'stop'}));
async function init(){const status=await fetch('/api/status').then(r=>r.json());library=(status.library||[]).filter(r=>/\.(wav|flac|mp3|ogg|m4a)$/i.test(r.file));for(const id of ['sources','midiSource','processSource'])options($(id),library);options($('reference'),library,'None');await refresh();setInterval(()=>{if(document.visibilityState==='visible' && root.isConnected && !root.closest('[hidden]'))refresh().catch(e=>{$('message').textContent=e.message});},4000);}
await init();
}
const standalone=document.querySelector('body > main.music-workbench');
if(standalone) mountMusicWorkbench(standalone).catch(e=>{standalone.querySelector('#message').textContent=e.message});
