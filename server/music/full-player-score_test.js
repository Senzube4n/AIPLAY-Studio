import test from 'node:test';
import assert from 'node:assert/strict';
import {mountFullPlayerScore, scoreSource, scoreText} from '../../web/full-player-score.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const data = abc => ({versions:[{id:'v1',score:{text:abc}}]});
function fixture(t) {
  const globals = ['document','window','fetch','requestAnimationFrame','cancelAnimationFrame'];
  const previous = new Map(globals.map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(() => {for (const [key,descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }});
  class Element {
    constructor() {this.listeners=new Map(); this.value=''; this.checked=true; this.textContent='';
      this.hidden=false; this.classes=new Set(); this.attrs={}; this.children=[];
      this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),
        toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
    addEventListener(name,fn) {if (!this.listeners.has(name)) this.listeners.set(name,new Set()); this.listeners.get(name).add(fn);}
    removeEventListener(name,fn) {this.listeners.get(name)?.delete(fn);}
    emit(name,event={}) {for (const fn of [...this.listeners.get(name)||[]]) fn(event);}
    count(name) {return this.listeners.get(name)?.size || 0;}
    setAttribute(name,value) {this.attrs[name]=value;}
    replaceChildren(...children) {this.children=children;}
    focus() {}
    getBoundingClientRect() {return {top:100,bottom:130,height:300};}
    scrollTo() {}
  }
  const ids=['fpScore','fpScorePaper','fpScoreStatus','fpLyrics','fullPlayer','fpLyricsTab','fpScoreTab',
    'fpScoreFollow','fpScorePosition','fpScoreOffset','fpScoreScale','fpScoreFit','fpScoreScroll'];
  const nodes=Object.fromEntries(ids.map(id=>[id,new Element()]));
  const audio=new Element(); Object.assign(audio,{currentTime:13,duration:120,paused:true,ended:false,src:'existing.flac'});
  audio.play=()=>{throw new Error('Score view must use the existing transport state.');};
  const renders=[], requests=[], frames=new Map(); let serial=0;
  globalThis.document={getElementById:id=>nodes[id]};
  globalThis.window={ABCJS:{renderAbc(paper,abc,options) {
    const note=new Element(); renders.push({paper,abc,options,note});
    return [{metaText:{},getBpm:()=>120,setTiming:()=>[
      {type:'event',milliseconds:0,measureNumber:0,elements:[[note]]},{type:'end',milliseconds:2000},
    ]}];
  }}};
  globalThis.fetch=(url,options)=>new Promise(resolve=>requests.push({url,body:JSON.parse(options.body),
    finish:result=>resolve({ok:true,json:async()=>result})}));
  globalThis.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};
  globalThis.cancelAnimationFrame=id=>frames.delete(id);
  return {nodes,audio,renders,requests,frames,controller:mountFullPlayerScore({audio})};
}
const track=file=>({file,scoreSlug:file,scoreVersion:'v1'});

test('score source chooses the saved version or native run and reads that exact version',()=>{
  assert.deepEqual(scoreSource({...track('song'),musicToolsRun:'native'}),
    {url:'/api/score',body:{action:'read',slug:'song',version:'v1'}});
  const native=scoreSource({musicToolsRun:'native'});
  assert.equal(scoreText({run:{request:{abc:'native ABC'}}},native),'native ABC');
  assert.equal(scoreText({versions:[{id:'other',score:{text:'wrong'}},{id:'v1',score:{text:'right'}}]},scoreSource(track('song'))),'right');
  assert.equal(scoreSource({file:'ordinary.flac'}),null);
});

test('score is lazy and closing or changing tabs removes listeners without changing audio',async(t)=>{
  const {controller,nodes,audio,requests,renders}=fixture(t);
  controller.setTrack(track('song')); controller.setOpen(true);
  assert.equal(requests.length,0,'the default lyrics view does not fetch notation');
  nodes.fpScoreTab.emit('click');
  assert.equal(requests.length,1); requests[0].finish(data('song ABC')); await tick();
  assert.equal(renders.length,1); assert.equal(renders[0].paper,nodes.fpScorePaper);
  assert.deepEqual([audio.src,audio.currentTime,audio.paused],['existing.flac',13,true]);
  assert.equal(audio.count('timeupdate'),1); assert.equal(nodes.fpScoreOffset.count('input'),1);
  nodes.fpLyricsTab.emit('click');
  assert.equal(audio.count('timeupdate'),0); assert.equal(nodes.fpScoreOffset.count('input'),0);
  assert.equal(renders[0].note.classes.has('playing-note'),false);
  nodes.fpScoreTab.emit('click'); await tick();
  assert.equal(requests.length,1,'returning to the same score reuses fetched notation');
  assert.equal(audio.count('timeupdate'),1);
  controller.setOpen(false);
  assert.equal(audio.count('timeupdate'),0); assert.equal(nodes.fpScoreFit.count('click'),0);
  assert.deepEqual([audio.src,audio.currentTime,audio.paused],['existing.flac',13,true]);
});

test('late score responses cannot redraw after closing the player',async(t)=>{
  const {controller,nodes,requests,renders,audio}=fixture(t);
  controller.setTrack(track('song')); controller.setOpen(true); nodes.fpScoreTab.emit('click');
  controller.setOpen(false); requests[0].finish(data('closed ABC')); await tick();
  assert.equal(renders.length,0); assert.equal(audio.count('play'),0);
});

test('skipping songs rejects the old request even when it completes after the new song',async(t)=>{
  const {controller,nodes,requests,renders,audio}=fixture(t);
  controller.setTrack(track('first')); controller.setOpen(true); nodes.fpScoreTab.emit('click');
  controller.setTrack(track('second'));
  assert.equal(requests.length,2);
  requests[1].finish(data('second ABC')); await tick();
  requests[0].finish(data('first ABC')); await tick();
  assert.deepEqual(renders.map(row=>row.abc),['second ABC']);
  assert.equal(audio.count('play'),1,'only the new score has transport listeners');
  controller.setTrack({file:'no-score.flac'});
  assert.equal(nodes.fpScoreTab.disabled,true); assert.equal(nodes.fpScore.hidden,true);
  assert.equal(audio.count('play'),0); assert.equal(nodes.fpScoreOffset.value,'0');
});

test('same-track updates during loading do not start duplicate requests',async(t)=>{
  const {controller,nodes,requests,renders}=fixture(t);
  controller.setTrack(track('song')); nodes.fpScoreTab.emit('click');
  controller.setOpen(true); controller.setTrack(track('song'));
  assert.equal(requests.length,1,'opening the player and updating its current track share one pending load');
  requests[0].finish(data('song ABC')); await tick();
  assert.equal(renders.length,1);
});
