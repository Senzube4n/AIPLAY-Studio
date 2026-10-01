import assert from 'node:assert/strict';
import {eventAt, scorePosition,mountNotationTimeline} from '../../web/score-follow.js';
import {test} from 'node:test';
const events = [0,500,1000,2000].map(milliseconds=>({milliseconds}));
assert.equal(eventAt([], 10), null);
assert.equal(eventAt(events, -1), null);
assert.equal(eventAt(events, .499), events[0]);
assert.equal(eventAt(events, .5), events[1]);
assert.equal(eventAt(events, 999), events[3]);
assert.equal(scorePosition(11, {offset:1,scale:2}),5);
assert.equal(scorePosition(.5,{offset:1,scale:1}),0);
// Seek backwards must select the new note, independent of playback history.
assert.equal(eventAt(events,scorePosition(1.8)),events[2]);
assert.equal(eventAt(events,scorePosition(.2)),events[0]);
console.log('Score playback timing checks passed');
test('one transport drives notes, seeks, fit timing and cleanup',()=>{
  const control=value=>Object.assign(new EventTarget(),{value});
  const audio=Object.assign(control(''),{currentTime:0,paused:true,ended:false,duration:8});
  const note=()=>({classList:{values:new Set(),add(name){this.values.add(name)},remove(name){this.values.delete(name)}},
    getBoundingClientRect(){return {top:400,bottom:420}},scrollIntoView(){throw new Error('Must scroll only the score pane');}});
  const a=note(), b=note(), position={},follow=Object.assign(control(''),{checked:true}),offset=control('0'),scale=control('1'),fit=control('');
  const events=[{type:'event',milliseconds:0,measureNumber:0,startCharArray:[1],elements:[[a]]},
    {type:'event',milliseconds:1000,measureNumber:1,startCharArray:[2],elements:[[b]]},{type:'end',milliseconds:4000}];
  const frames=new Map();let sequence=0, clicks, scrolls=0;
  const timeline=mountNotationTimeline({audio,paper:{},abc:'C D',abcjs:{renderAbc(_paper,_abc,options){clicks=options.clickListener;
    return [{getBpm(){return 120},setTiming(){return events}}];}},follow,position,offset,scale,fit,
    scrollRoot:{scrollTop:0,getBoundingClientRect(){return {top:0,bottom:300,height:300}},scrollTo(){scrolls++;}},
    schedule:fn=>{frames.set(++sequence,fn);return sequence;},cancel:id=>frames.delete(id)});
  assert.equal(position.textContent,'Bar 1');assert(a.classList.values.has('playing-note'));
  audio.currentTime=1.5;audio.dispatchEvent(new Event('seeked'));
  assert.equal(position.textContent,'Bar 2');assert.equal(a.classList.values.size,0);assert(b.classList.values.has('playing-note'));
  audio.currentTime=.1;audio.dispatchEvent(new Event('seeked'));assert.equal(position.textContent,'Bar 1');
  fit.dispatchEvent(new Event('click'));assert.equal(scale.value,'2.0000');
  clicks({startChar:2});assert.equal(audio.currentTime,2);
  follow.checked=false;follow.dispatchEvent(new Event('change'));const before=scrolls;
  audio.currentTime=0;audio.dispatchEvent(new Event('seeked'));assert.equal(scrolls,before);
  audio.paused=false;audio.dispatchEvent(new Event('play'));assert.equal(frames.size,1);
  audio.paused=true;audio.dispatchEvent(new Event('pause'));assert.equal(frames.size,0);
  const label=position.textContent;timeline.dispose();assert.equal(a.classList.values.size,0);assert.equal(b.classList.values.size,0);
  audio.currentTime=3;audio.dispatchEvent(new Event('seeked'));assert.equal(position.textContent,label);assert.equal(frames.size,0);
});
