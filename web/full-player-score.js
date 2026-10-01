import {mountNotationTimeline} from './score-follow.js';

export function scoreSource(track) {
  if (track?.scoreSlug && track?.scoreVersion) return {url:'/api/score',
    body:{action:'read',slug:track.scoreSlug,version:track.scoreVersion}};
  if (track?.musicToolsRun) return {url:'/api/music-tools', body:{action:'read',run:track.musicToolsRun}};
  return null;
}
export function scoreText(data, source) {
  if (source.body.run) return data.run?.score || data.run?.request?.abc || '';
  return data.versions?.find(row => row.id === source.body.version)?.score?.text || '';
}
let library;
function notationLibrary() {
  if (window.ABCJS) return Promise.resolve(window.ABCJS);
  if (!library) library = new Promise((resolve,reject) => {
    const script = document.createElement('script'); script.src='/api/score/vendor/abcjs.js';
    script.onload=() => window.ABCJS ? resolve(window.ABCJS) : reject(new Error('Notation renderer unavailable.'));
    script.onerror=() => reject(new Error('Notation renderer unavailable.')); document.head.append(script);
  }).catch(error => {library=null; throw error;});
  return library;
}

/** Lazy-load the chosen song's sheet and dispose its listeners on close/skip. */
export function mountFullPlayerScore({audio}) {
  const $ = id => document.getElementById(id);
  const panel=$('fpScore'), paper=$('fpScorePaper'), status=$('fpScoreStatus');
  if (!panel) return {setTrack(){},setOpen(){}};
  let source, key='', open=false, mode='lyrics', timeline, revision=0, cached, pending=false;
  const stop = () => {revision++; pending=false; timeline?.dispose(); timeline=null;};
  function paint() {
    const show=mode==='score';
    $('fpLyrics').hidden=show; panel.hidden=!show;
    $('fullPlayer').classList.toggle('fp-with-score',show);
    $('fpLyricsTab').setAttribute('aria-selected',String(!show));
    $('fpScoreTab').setAttribute('aria-selected',String(show));
    $('fpLyricsTab').tabIndex=show?-1:0; $('fpScoreTab').tabIndex=show?0:-1;
    $('fpScoreTab').disabled=!source;
    $('fpScoreTab').title=source?'Follow this song\'s saved score':'This song has no saved score';
  }
  async function load() {
    if (!open || mode!=='score' || !source || timeline || pending) return;
    pending=true;
    const request=++revision, wanted=source;
    status.textContent='Loading score…'; status.className='chip busy';
    try {
      const [abcjs, data] = await Promise.all([notationLibrary(), cached ? Promise.resolve(cached) :
        fetch(wanted.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(wanted.body)})
          .then(async response => {const data=await response.json();
            if (!response.ok || data.error) throw new Error(data.error || 'Could not open the score.'); return data;})]);
      if (request!==revision) return;
      const abc=scoreText(data,wanted);
      if (!abc) throw new Error('No notation saved for this take.');
      cached=data;
      timeline=mountNotationTimeline({audio,paper,abc,abcjs,follow:$('fpScoreFollow'),position:$('fpScorePosition'),
        offset:$('fpScoreOffset'),scale:$('fpScoreScale'),fit:$('fpScoreFit'),scrollRoot:$('fpScoreScroll')});
      status.textContent='Approximate timing'; status.className='chip';
    } catch(error) {
      if (request!==revision) return;
      status.textContent=error.message; status.className='chip warn';
    } finally {if (request===revision) pending=false;}
  }
  function select(value) {mode=value; stop(); paint(); load();}
  $('fpLyricsTab').addEventListener('click',()=>select('lyrics'));
  $('fpScoreTab').addEventListener('click',()=>select('score'));
  for (const id of ['fpLyricsTab','fpScoreTab']) $(id).addEventListener('keydown',event=>{
    if (!source || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault(); const value=event.key==='Home'?'lyrics':event.key==='End'?'score':mode==='lyrics'?'score':'lyrics';
    select(value); $(value==='score'?'fpScoreTab':'fpLyricsTab').focus();
  });
  paint();
  return {
    setTrack(value) {
      const next=scoreSource(value), nextKey=JSON.stringify([value?.file,next]);
      if (key!==nextKey) {
        stop(); key=nextKey; source=next; cached=null; paper.replaceChildren();
        $('fpScoreOffset').value='0'; $('fpScoreScale').value='1'; $('fpScorePosition').textContent='Ready';
        $('fpScoreScroll').scrollTop=0;
        if (!source) mode='lyrics';
      }
      paint(); load();
    },
    setOpen(value) {open=value; if (!open) stop(); else load();},
  };
}
