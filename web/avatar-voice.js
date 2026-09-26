import {createAvatarLipSync} from './avatar-lipsync.js';

/** One expiring browser preview. Human controls and MCP share desired state. */
export async function mountAvatarVoice({row, runtime, isCurrent = () => true}) {
  const $ = id => document.getElementById(id);
  const overlayEnable = $('voice-enable-overlay');
  const post = async body => {
    const response = await fetch('/api/avatars/playback', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body), signal:AbortSignal.timeout(8000)});
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), {status:response.status});
    return value;
  };
  let session_id = crypto.randomUUID(), generation = 0;
  let live = true, active = !document.hidden, polling = false, applied = 0, consumed = 0, consumedAudio = 0, loaded = 0, sought = 0, timer;
  let override = '', error = '', pendingStart = false, startToken = 0, uploadToken = 0;
  let commandTail = Promise.resolve(), recovering = null, commandSerial = 0, settledCommand = 0;
  let cue = null, cueError = '', cueSeenRevision = 0, completedCueRevision = 0;
  const valid = () => live && isCurrent();
  const paintCue = () => {
    if (!valid()) return;
    const chip = $('voice-cue-state');
    chip.hidden = !cue && !cueError;
    chip.textContent = cue ? `${cue.expression} active` : cueError;
    chip.className = `chip${cueError && !cue ? ' warn' : ''}`;
    $('voice-cue-clear').disabled = !cue;
  };
  const syncCue = next => {
    if (!next) {
      if (cue) {
        runtime.clearExpressionCue?.();
        completedCueRevision = Math.max(completedCueRevision, cue.revision);
      }
      cue = null; paintCue(); return true;
    }
    if (next.revision <= completedCueRevision || cue?.revision === next.revision) return true;
    // The server retains a pending cue until this browser acknowledges it.
    // Give it its full duration here, even when the next poll came later.
    const duration = Number.isSafeInteger(next.durationMs) ? next.durationMs : next.expiresAt - Date.now();
    if (!Number.isFinite(duration) || duration <= 0) {
      completedCueRevision = Math.max(completedCueRevision, next.revision);
      return true;
    }
    if (!runtime.setExpressionCue?.(next.expression)) return false;
    cue = {...next, expiresAt:Date.now() + Math.min(duration, 10000)};
    paintCue();
    return true;
  };
  const paint = s => {
    if (!valid()) return;
    $('voice-state').textContent = override || ({empty:'Choose audio', ready:'Ready', playing:'Playing', paused:'Paused', ended:'Finished', error:'Audio error'}[s.phase] || s.phase);
    $('voice-state').className = `chip${error || s.error ? ' warn' : s.playing ? ' ok' : ''}`;
    $('voice-note').textContent = error || s.error || s.audioOnlyReason || '';
    $('voice-note').hidden = !$('voice-note').textContent;
    $('voice-name').textContent = s.name || 'No audio selected';
    $('voice-play').textContent = pendingStart ? 'Enable audio' : s.playing ? 'Pause voice' : 'Play voice';
    // Activation and Stop remain available while browser/network work is pending.
    $('voice-play').disabled = !s.name || !active;
    $('voice-stop').disabled = !s.name;
    $('voice-time').disabled = !Number.isFinite(s.duration);
    $('voice-time').max = String(s.duration || 1);
    $('voice-time').value = String(s.time);
    $('voice-clock').textContent = `${s.time.toFixed(1)} s`;
    if (overlayEnable) {
      const overlay = document.body?.classList?.contains('avatar-overlay') === true;
      overlayEnable.hidden = !(overlay && active && s.name && (pendingStart || override === 'Enable audio' || s.phase === 'blocked'));
      overlayEnable.disabled = !active || !s.name;
    }
  };
  const newLip = () => createAvatarLipSync({expressionManager:runtime.vrm?.expressionManager, onState:paint});
  let lip = newLip();
  const report = () => {
    const s = lip.state();
    return {phase: override === 'Enable audio' || (!active && s.name) ? 'blocked'
      : override === 'Audio error' ? 'error' : pendingStart || override === 'Loading' ? 'loading' : s.phase,
      time:s.time, duration:s.duration, error:(error || s.error || (!active ? 'Open the 3D view to play audio.' : '')).slice(0,300)};
  };
  function cancelStart() { startToken++; pendingStart = false; }
  function showFailure(cause) {
    if (!valid()) return;
    const blocked = cause?.name === 'NotAllowedError' || cause?.cause?.name === 'NotAllowedError';
    override = blocked ? 'Enable audio' : 'Audio error'; error = cause?.message || 'Audio playback failed.';
    paint(lip.state());
  }
  function start(revision = null) {
    const token = ++startToken, epoch = generation;
    pendingStart = true; override = 'Loading'; error = '';
    // Never await activation in polling/command queues: later Stop or a human
    // gesture must be able to supersede a suspended AudioContext.
    let started;
    try { started = lip.play(); } catch (cause) { started = Promise.reject(cause); }
    Promise.resolve(started).then(() => {
      if (!valid() || epoch !== generation || token !== startToken) return;
      pendingStart = false; override = ''; error = '';
      if (revision !== null) applied = Math.max(applied, revision);
      paint(lip.state());
    }, cause => {
      if (!valid() || epoch !== generation || token !== startToken) return;
      pendingStart = false;
      if (revision !== null) applied = Math.max(applied, revision);
      showFailure(cause);
    });
    paint(lip.state());
  }
  function apply(session) {
    if (!valid() || session.revision < consumed) return;
    let cueApplied = true;
    if (session.revision >= cueSeenRevision) {
      // An inactive preview draws no frames. Keep an unseen cue pending on the
      // server until this view can actually show it.
      cueApplied = !active && session.desired?.cue?.revision > completedCueRevision
        ? false : syncCue(session.desired?.cue);
      if (cueApplied) cueSeenRevision = session.revision;
    }
    if (session.revision <= consumed) {
      if (cueApplied) applied = Math.max(applied, session.revision);
      return;
    }
    const d = session.desired;
    const acknowledged = cueApplied ? session.revision : Math.min(session.revision, d.cue.revision - 1);
    // An expression cue has its own session revision. It must never replay an
    // ended song, clear a blocked-audio warning, or re-seek the audio.
    const audioRevision = Number.isSafeInteger(d.audio_revision) ? d.audio_revision : session.revision;
    if (audioRevision <= consumedAudio) {
      consumed = session.revision;
      applied = Math.max(applied, acknowledged);
      return;
    }
    override = ''; error = '';
    if (d.load_revision > loaded && d.url) {
      cancelStart(); lip.loadUrl(d.url, {name:d.name, bytes:d.bytes}); loaded = d.load_revision;
    }
    if (d.seek_revision > sought && d.url) {
      if (d.time > 0 && !Number.isFinite(lip.state().duration)) {
        const state = lip.state();
        if (state.phase === 'error') {
          consumed = session.revision; applied = Math.max(applied, session.revision);
          override = 'Audio error'; error = state.error; paint(state); return;
        }
        cancelStart(); lip.pause(); override = 'Loading'; paint(lip.state()); return;
      }
      lip.seek(d.time); sought = d.seek_revision;
    }
    consumed = session.revision; consumedAudio = audioRevision;
    if (d.playing && active) start(acknowledged);
    else {
      cancelStart(); lip.pause(); applied = Math.max(applied, acknowledged);
      if (d.playing) override = 'View hidden';
      paint(lip.state());
    }
  }
  const registration = () => ({action:'register',session_id,id:row.id,sha256:row.inspection.sha256,
    capabilities:{audio:true,lip_sync:lip.state().lipSyncSupported}});
  async function recover() {
    if (recovering) return recovering;
    const epoch = ++generation;
    cancelStart(); uploadToken++; lip.dispose(); lip = newLip();
    syncCue(null);
    cueSeenRevision = completedCueRevision = 0;
    session_id = crypto.randomUUID(); applied = consumed = consumedAudio = loaded = sought = 0;
    commandTail = Promise.resolve(); commandSerial = settledCommand = 0;
    override = ''; error = 'Preview expired. Choose audio again.';
    $('voice-file').value = ''; $('voice-session').textContent = session_id; paint(lip.state());
    const work = post(registration()).then(() => {
      if (valid() && epoch === generation) paint(lip.state());
    }).finally(() => { if (recovering === work) recovering = null; });
    recovering = work;
    return work;
  }
  async function networkFailure(cause, epoch) {
    if (!valid() || epoch !== generation) return;
    cancelStart(); lip.pause();
    if (cause.status === 410 || (cause.status === 404 && cause.message === 'Preview session not found.')) {
      try { await recover(); } catch (failure) { if (valid()) showFailure(failure); }
    } else showFailure(cause);
  }
  function command(op, fields = {}) {
    const epoch = generation, id = session_id, command_id = crypto.randomUUID();
    const serial = ++commandSerial;
    const work = commandTail.catch(() => {}).then(async () => {
      if (!valid() || epoch !== generation) return;
      try {
        const session = await post({action:'command', session_id:id, command_id, op, ...fields});
        if (valid() && epoch === generation && serial === commandSerial) apply(session);
      } catch (cause) {
        if (serial === commandSerial) await networkFailure(cause, epoch);
      } finally {
        if (epoch === generation && serial === commandSerial) settledCommand = serial;
      }
    });
    commandTail = work;
    return work;
  }
  async function poll() {
    if (!valid() || polling || recovering) return;
    polling = true; const epoch = generation;
    try {
      const session = await post({action:'heartbeat', session_id, applied_revision:applied, status:report()});
      // A prior Play response must not undo an immediate local Stop while its
      // newer command is still in flight. Heartbeats continue renewing the lease.
      if (valid() && epoch === generation && commandSerial === settledCommand) apply(session);
    } catch (cause) { await networkFailure(cause, epoch); }
    finally { polling = false; if(valid()) paint(lip.state()); }
  }
  try { await post(registration()); } catch(cause) { await lip.dispose(); throw cause; }
  if (!valid()) { await lip.dispose(); return {dispose(){}}; }
  // The same controls survive avatar switches; a generic GLB must not inherit
  // the prior VRM's selector or click target while the new inventory loads.
  $('voice-cue-row').hidden = true;
  $('voice-cue-expression').textContent = '';
  $('voice-cue-expression').disabled = true;
  $('voice-cue').disabled = true;
  $('voice-cue-clear').disabled = true;
  $('voice-cue-state').hidden = true;
  $('voice-cue-state').title = '';
  if (row.inspection.profile === 'vrm') {
    $('voice-cue-row').hidden = false;
    try {
      const inventory = await post({action:'cue_inventory',id:row.id,sha256:row.inspection.sha256});
      if (!valid()) { await lip.dispose(); return {dispose(){}}; }
      const select = $('voice-cue-expression');
      select.textContent = '';
      for (const expression of inventory.expressions) {
        const option = document.createElement('option');
        option.value = expression.name; option.textContent = expression.name;
        select.append(option);
      }
      select.disabled = inventory.expressions.length === 0;
      $('voice-cue').disabled = select.disabled;
      cueError = select.disabled ? 'No expressions' : '';
    } catch (cause) {
      if (valid()) { cueError = 'Cue unavailable'; $('voice-cue-state').title = cause.message; }
    }
  }
  if (!valid()) { await lip.dispose(); return {dispose(){}}; }
  $('voice-panel').hidden = false;
  $('voice-session').textContent = session_id;
  $('voice-file').onchange = async event => {
    if (!valid()) return;
    const token = ++uploadToken, epoch = generation;
    try {
      const file = event.target.files[0]; if (!file) return;
      if (!file.size || file.size > 32 * 1024 * 1024) throw Error('Choose audio up to 32 MiB.');
      override = 'Loading'; error = ''; paint(lip.state());
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!valid() || epoch !== generation || token !== uploadToken) return;
      let binary = ''; for(let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
      const audio = await post({action:'upload',name:file.name,data_base64:btoa(binary)});
      if (valid() && epoch === generation && token === uploadToken) await command('load',{audio_id:audio.audio_id});
    } catch (cause) { if (token === uploadToken) await networkFailure(cause, epoch); }
  };
  $('voice-play').onclick = () => {
    if (!valid() || !active || !lip.state().name) return;
    const pause = lip.state().playing && !pendingStart;
    if (pause) { cancelStart(); lip.pause(); }
    else start(); // Inside this gesture, before the command request.
    return command(pause ? 'pause' : 'play');
  };
  $('voice-stop').onclick = () => {
    if (!valid() || !lip.state().name) return;
    cancelStart(); lip.stop(); override = ''; error = ''; paint(lip.state());
    return command('stop');
  };
  $('voice-time').onchange = () => command('seek',{seconds:Number($('voice-time').value)});
  $('voice-cue').onclick = () => {
    const expression = $('voice-cue-expression').value;
    if (valid() && expression) return command('cue',{expression,duration_ms:3000});
  };
  $('voice-cue-clear').onclick = () => {
    if (!valid()) return;
    syncCue(null);
    return command('clear_cue');
  };
  // Overlay controls are otherwise hidden, but browser activation must happen
  // in this actual source window; a click in the Studio parent cannot grant it.
  const enableOverlay = () => $('voice-play').onclick();
  if (overlayEnable) overlayEnable.onclick = enableOverlay;
  timer = setInterval(poll, 1000); paint(lip.state()); paintCue();
  return {
    update(dt) { if (!valid()) return; if (cue?.expiresAt <= Date.now()) syncCue(null); lip.update(dt); $('voice-level').value = lip.state().level; },
    captureBaseline() { if (valid()) lip.captureBaseline(); },
    setActive(value) {
      if (!valid()) return;
      const next = value === true && !document.hidden, wasActive = active;
      active = next;
      if (!active) {
        cancelStart(); lip.pause(); override = '';
        // Record the pause so reopening cannot replay an old shared command.
        if (wasActive && lip.state().name) command('pause');
      } else if (override === 'View hidden') override = '';
      paint(lip.state());
    },
    dispose() {
      live = false; generation++; uploadToken++; cancelStart(); clearInterval(timer); syncCue(null); lip.dispose();
      if (overlayEnable?.onclick === enableOverlay) { overlayEnable.hidden = true; overlayEnable.onclick = null; }
    },
  };
}
