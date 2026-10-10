import {frameKind, audioLevel, nextSpeechState} from './pngtuber-level.js';

const $ = id => document.getElementById(id);
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_PIXELS = 32_000_000;
const frameUrls = {idle:null, talking:null};
const frameSizes = {idle:null, talking:null};
const frameVersions = {idle:0, talking:0};
const media = $('pn-audio');
let audioFileUrl = null;
let context = null, analyser = null, samples = null, mediaSource = null, liveSource = null, micStream = null;
let audioKind = null, raf = 0, requestVersion = 0;
let speech = {talking:false, lastLoudAt:-Infinity};
let localProblem = null;
const session_id = crypto.randomUUID();
let bridgeTimer = 0, bridgeBusy = false, bridgeReady = false, bridgeError = '';
let appliedRevision = 0, seenCueRevision = 0, remoteCue = null, remoteCueTimer = 0;

function framesReady() { return !!(frameUrls.idle && frameUrls.talking); }
function status(label, tone = '', detail = '') {
  $('pn-state').textContent = label;
  $('pn-state').className = `chip${tone ? ` ${tone}` : ''}`;
  $('pn-state').title = detail;
  $('pn-detail').textContent = detail;
  $('pn-detail').hidden = !detail;
}
function paint() {
  const ready = framesReady();
  $('pn-stage').disabled = !ready;
  $('pn-mic').disabled = !ready;
  $('pn-play').disabled = !ready || !audioFileUrl;
  $('pn-empty').hidden = ready;
  $('pn-canvas').dataset.talking = String(ready && (speech.talking || !!remoteCue));
  if (localProblem) status(localProblem.label, 'warn', localProblem.detail);
  else if (!ready) status('Choose frames');
  else if (bridgeError) status('Agent link offline', 'warn', bridgeError);
  else if (remoteCue) status('Cue · Talking', 'ok');
  else if (audioKind === 'mic') status(speech.talking ? 'Mic · Talking' : 'Mic · Listening', 'ok');
  else if (audioKind === 'file') status(speech.talking ? 'Audio · Talking' : 'Audio · Playing', 'ok');
  else if (frameSizes.idle?.[0] !== frameSizes.talking?.[0] || frameSizes.idle?.[1] !== frameSizes.talking?.[1])
    status('Frame sizes differ', 'warn', 'Matching canvas sizes prevent a jump when switching frames.');
  else status('Ready', 'ok');
}
function showProblem(label, detail) { localProblem = {label,detail}; paint(); }

async function setFrame(kind, file) {
  if (!file) return;
  localProblem = null;
  const version = ++frameVersions[kind];
  let url = null;
  try {
    if (file.size < 12 || file.size > MAX_FRAME_BYTES) throw new Error('Choose a PNG or WebP under 64 MiB.');
    const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!frameKind(signature)) throw new Error('Choose a PNG or WebP image.');
    url = URL.createObjectURL(file);
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    if (!probe.naturalWidth || !probe.naturalHeight || probe.naturalWidth * probe.naturalHeight > MAX_FRAME_PIXELS)
      throw new Error('Frame is too large for a live overlay.');
    if (version !== frameVersions[kind]) return;
    const previous = frameUrls[kind];
    frameUrls[kind] = url;
    frameSizes[kind] = [probe.naturalWidth, probe.naturalHeight];
    const image = $(kind === 'idle' ? 'pn-idle-frame' : 'pn-talking-frame');
    image.src = url;
    image.hidden = false;
    url = null;
    if (previous) URL.revokeObjectURL(previous);
    paint();
    if (framesReady()) startBridge();
  } catch (error) {
    if (version === frameVersions[kind]) showProblem('Frame unavailable', error.message);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function stopLive({rewind = false} = {}) {
  localProblem = null;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (liveSource) liveSource.disconnect();
  liveSource = null;
  if (micStream) for (const track of micStream.getTracks()) track.stop();
  micStream = null;
  media.pause();
  if (rewind && media.src) media.currentTime = 0;
  audioKind = null;
  speech = {talking:false, lastLoudAt:-Infinity};
  $('pn-level').value = 0;
  $('pn-stop').disabled = true;
  $('pn-play').textContent = 'Play audio';
  paint();
}

function ensureAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('Audio analysis is unavailable in this browser.');
  if (!context) {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    samples = new Float32Array(analyser.fftSize);
  }
  return context;
}

function awaitSound(started, maxMs = 8000) {
  let timer;
  return Promise.race([Promise.all(started), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Audio needs a click in this browser source.')), maxMs);
  })]).finally(() => clearTimeout(timer));
}

async function bridgePost(body) {
  const response = await fetch('/api/avatars/pngtuber', {method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`),{status:response.status});
  return result;
}
function clearRemoteCue() {
  if (remoteCueTimer) clearTimeout(remoteCueTimer);
  remoteCueTimer = 0;
  remoteCue = null;
  paint();
}
function applyBridge(session) {
  const cue = session.desired?.talkingCue;
  if (cue && cue.revision > seenCueRevision && document.hidden) return; // Do not acknowledge unseen frames.
  if (cue && cue.revision > seenCueRevision) {
    clearRemoteCue();
    seenCueRevision = cue.revision;
    remoteCue = cue;
    remoteCueTimer = setTimeout(() => { if (remoteCue?.revision === cue.revision) clearRemoteCue(); }, cue.durationMs);
    paint();
  } else if (!cue && remoteCue) clearRemoteCue();
  appliedRevision = Math.max(appliedRevision, session.revision);
}
function browserStatus() {
  return {frame:$('pn-canvas').dataset.talking === 'true' ? 'talking' : 'idle',
    source:audioKind === 'file' ? 'audio' : audioKind || 'none',
    staged:document.body.classList.contains('pn-stage'),visible:!document.hidden};
}
async function pollBridge() {
  if (!framesReady() || bridgeBusy) return;
  bridgeBusy = true;
  try {
    if (!bridgeReady) {
      applyBridge(await bridgePost({action:'register',session_id}));
      bridgeReady = true;
    }
    applyBridge(await bridgePost({action:'heartbeat',session_id,applied_revision:appliedRevision,status:browserStatus()}));
    bridgeError = '';
    paint();
  } catch (error) {
    if (error.status === 404 || error.status === 410) {
      bridgeReady = false;
      appliedRevision = seenCueRevision = 0;
      clearRemoteCue();
    }
    bridgeError = error.message;
    paint();
  } finally { bridgeBusy = false; }
}
function startBridge() {
  if (bridgeTimer) return;
  bridgeTimer = setInterval(pollBridge, 1000);
  void pollBridge();
}

function sample() {
  if (!audioKind || !analyser || context?.state !== 'running') return;
  analyser.getFloatTimeDomainData(samples);
  const level = audioLevel(samples);
  $('pn-level').value = Math.min(0.2, level);
  const previous = speech.talking;
  speech = nextSpeechState(speech, level, Number($('pn-trigger').value), performance.now());
  if (speech.talking !== previous) paint();
  raf = requestAnimationFrame(sample);
}

async function useMic() {
  const version = ++requestVersion;
  stopLive();
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs a local secure browser context.');
    ensureAudio();
    const resumed = context.resume();
    Promise.resolve(resumed).catch(() => {});
    const permission = navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
    $('pn-stop').disabled = false;
    status('Opening mic', 'busy');
    const stream = await permission;
    if (version !== requestVersion) { stream.getTracks().forEach(track => track.stop()); return; }
    micStream = stream;
    await awaitSound([resumed]);
    if (version !== requestVersion) { stream.getTracks().forEach(track => track.stop()); return; }
    liveSource = context.createMediaStreamSource(stream);
    liveSource.connect(analyser); // Never send microphone capture to speakers.
    audioKind = 'mic';
    $('pn-stop').disabled = false;
    paint();
    sample();
  } catch (error) {
    if (version !== requestVersion) return;
    stopLive();
    showProblem(error.name === 'NotAllowedError' ? 'Mic blocked' : 'Mic unavailable',
      error.name === 'NotAllowedError' ? 'Allow microphone access in the browser, then click Use mic again.' : error.message);
  }
}

async function playAudio() {
  if (!audioFileUrl) return;
  if (audioKind === 'file' && !media.paused) {
    ++requestVersion;
    stopLive();
    return;
  }
  const version = ++requestVersion;
  stopLive();
  try {
    ensureAudio();
    if (!mediaSource) mediaSource = context.createMediaElementSource(media);
    if (media.ended) media.currentTime = 0;
    mediaSource.connect(analyser);
    mediaSource.connect(context.destination);
    liveSource = mediaSource;
    // Both calls happen inside this click, before awaiting browser activation.
    const resumed = context.resume();
    const started = media.play();
    $('pn-stop').disabled = false;
    status('Starting audio', 'busy');
    await awaitSound([resumed, started]);
    if (version !== requestVersion) { stopLive(); return; }
    if (context.state !== 'running') throw new Error('Audio is paused by the browser.');
    audioKind = 'file';
    $('pn-stop').disabled = false;
    $('pn-play').textContent = 'Pause audio';
    paint();
    sample();
  } catch (error) {
    if (version !== requestVersion) return;
    stopLive();
    showProblem(error.name === 'NotAllowedError' ? 'Audio blocked' : 'Audio unavailable',
      error.name === 'NotAllowedError' ? 'Click Play audio again to allow playback.' : error.message);
  }
}

for (const [kind, id] of [['idle','pn-idle'],['talking','pn-talking']])
  $(id).addEventListener('change', event => setFrame(kind, event.target.files?.[0]));
$('pn-audio-file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (!file) return;
  ++requestVersion;
  stopLive({rewind:true});
  if (audioFileUrl) URL.revokeObjectURL(audioFileUrl);
  audioFileUrl = URL.createObjectURL(file);
  media.src = audioFileUrl;
  $('pn-audio-name').textContent = file.name;
  $('pn-play').disabled = false;
  paint();
});
$('pn-trigger').addEventListener('input', () => { $('pn-trigger-label').value = Number($('pn-trigger').value).toFixed(3); });
$('pn-mic').addEventListener('click', useMic);
$('pn-play').addEventListener('click', playAudio);
$('pn-stop').addEventListener('click', () => { ++requestVersion; stopLive({rewind:true}); });
media.addEventListener('ended', () => { if (audioKind === 'file') { ++requestVersion; stopLive({rewind:true}); } });
$('pn-stage').addEventListener('click', () => {
  if (!framesReady()) return;
  document.body.classList.add('pn-stage');
  $('pn-edit').hidden = false;
});
function exitStage() { document.body.classList.remove('pn-stage'); $('pn-edit').hidden = true; }
$('pn-edit').addEventListener('click', exitStage);
document.addEventListener('keydown', event => { if (event.key === 'Escape') exitStage(); });
window.addEventListener('pagehide', event => {
  ++requestVersion;
  clearInterval(bridgeTimer);
  bridgeTimer = 0;
  clearRemoteCue();
  stopLive();
  if (event.persisted) { // BFCache keeps this document and its local frame URLs alive.
    Promise.resolve(context?.suspend?.()).catch(() => {});
    return;
  }
  frameVersions.idle++; frameVersions.talking++;
  for (const url of Object.values(frameUrls)) if (url) URL.revokeObjectURL(url);
  if (audioFileUrl) URL.revokeObjectURL(audioFileUrl);
  Promise.resolve(context?.close()).catch(() => {});
});
window.addEventListener('pageshow', event => { if (event.persisted && framesReady()) startBridge(); });
paint();
