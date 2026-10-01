import {TICKS_PER_BEAT,LIMITS} from '../daw/store.js';
export function midiDawPlan(notes,bpm=120){
 if(typeof bpm!=='number'||!Number.isFinite(bpm)||bpm<40||bpm>240)throw new Error('Timeline tempo must be 40 to 240 BPM.');
 if(!Array.isArray(notes)||!notes.length)throw new Error('The transcription has no notes.');
 const tracks=new Map();let end=0,omitted=0;
 for(const note of notes){
  if(!Number.isInteger(note.pitch)||note.pitch<0||note.pitch>127||!Number.isFinite(note.start)||note.start<0||!Number.isFinite(note.end)||note.end<=note.start){omitted++;continue;}
  const at=Math.round(note.start*bpm/60*TICKS_PER_BEAT),dur=Math.max(1,Math.round((note.end-note.start)*bpm/60*TICKS_PER_BEAT));
  if(dur>LIMITS.durTicks[1])throw new Error('A predicted note exceeds the DAW duration limit. Download MIDI instead.');
  const name=String(note.instrument||'Predicted instrument').slice(0,80);if(!tracks.has(name))tracks.set(name,[]);
  const rows=tracks.get(name);rows.push({bar:Math.floor(at/(4*TICKS_PER_BEAT))+1,beat:Math.floor((at%(4*TICKS_PER_BEAT))/TICKS_PER_BEAT)+1,tick:at%TICKS_PER_BEAT,dur_ticks:dur,pitch:note.pitch,vel:100});
  if(rows.length>LIMITS.notesPerClip)throw new Error('A predicted track exceeds the DAW note limit. Download MIDI instead.');
  end=Math.max(end,at+dur);
 }
 const bars=Math.max(1,Math.ceil(end/(4*TICKS_PER_BEAT)));
 if(!tracks.size)throw new Error('No complete predicted notes can be imported.');
 if(tracks.size>LIMITS.tracks||bars>256)throw new Error('This transcription exceeds the DAW project limits. Download MIDI instead.');
 return {bpm,bars,tracks:[...tracks].map(([name,notes])=>({name,notes})),omitted};
}
