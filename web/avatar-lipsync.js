/** Local audio-envelope mouth motion. No microphone or phoneme inference. */
export const LIPSYNC_MAX_BYTES = 256 * 1024 * 1024;
const clamp = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const audioName = /\.(wav|mp3|ogg|oga|opus|flac|m4a|aac|aif|aiff|webm)$/i;

/**
 * update(dt) must run immediately BEFORE the avatar runtime's update(dt).
 * captureBaseline() can follow runtime.apply() to preserve a newly applied look.
 * Environment injection is for browser tests; ordinary callers need only the
 * three-vrm expressionManager and an optional onState callback.
 */
export function createAvatarLipSync({expressionManager, onState = () => {}, environment = {}} = {}) {
  const AudioClass = environment.Audio ?? globalThis.Audio;
  const Context = Object.hasOwn(environment, 'AudioContext') ? environment.AudioContext : globalThis.AudioContext || globalThis.webkitAudioContext;
  const urls = environment.URL ?? globalThis.URL;
  const BlobClass = environment.Blob ?? globalThis.Blob;
  const schedule = environment.setTimeout ?? globalThis.setTimeout;
  const unschedule = environment.clearTimeout ?? globalThis.clearTimeout;
  if (typeof AudioClass !== 'function') throw new Error('Audio playback is unavailable in this browser.');
  const audio = new AudioClass();
  audio.preload = 'metadata'; audio.autoplay = false; audio.loop = false;
  const mouth = ['aa', 'jawOpen'].find(name => expressionManager?.getExpression?.(name)) || null;
  let disposed = false, file = null, objectUrl = null, context = null, source = null, analyser = null;
  let samples = null, bytes = null, phase = 'empty', error = '', stalled = false;
  let envelope = 0, rms = 0, baseline = 0, lastApplied = null, epoch = 0, pending = null, requestedPlay = false;
  const listeners = [];
  const snapshot = () => ({phase, name: file?.name || '', bytes: file?.size || 0,
    time: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : null,
    playing: phase === 'playing' && !audio.paused, mouth, lipSyncSupported: Boolean(mouth && Context),
    audioOnlyReason: !mouth ? 'No aa or jawOpen expression.' : !Context ? 'Web Audio is unavailable.' : '',
    level: envelope, rms, error});
  const emit = () => { if (!disposed) onState(snapshot()); };
  const ensureLive = () => { if (disposed) throw new Error('Audio lip sync has been disposed.'); };
  function cancelPlay() { epoch++; requestedPlay = false; pending?.cancel(); pending = null; }
  const mouthValue = () => clamp(expressionManager?.getValue?.(mouth));
  function restoreMouth() {
    if (mouth && lastApplied !== null && Math.abs(mouthValue() - lastApplied) < 1e-7) expressionManager.setValue(mouth, baseline);
    lastApplied = null; envelope = 0; rms = 0;
  }
  function captureBaseline() {
    if (!disposed && mouth) { baseline = mouthValue(); lastApplied = null; }
  }
  function bind(name, listener) { audio.addEventListener(name, listener); listeners.push([name, listener]); }
  bind('loadedmetadata', emit);
  bind('durationchange', emit);
  bind('timeupdate', emit);
  bind('waiting', () => { stalled = true; });
  bind('playing', () => { if (!disposed && requestedPlay && !audio.paused) { stalled = false; if (!pending) phase = 'playing'; emit(); } });
  bind('pause', () => {
    if (disposed || !file || !audio.paused) return;
    if (phase === 'playing') { cancelPlay(); phase = audio.ended ? 'ended' : 'paused'; restoreMouth(); emit(); }
  });
  bind('ended', () => { if (disposed) return; cancelPlay(); phase = 'ended'; restoreMouth(); emit(); });
  bind('error', () => {
    if (disposed || !file || !audio.error) return;
    cancelPlay(); audio.pause(); restoreMouth(); phase = 'error';
    error = 'This browser could not decode the selected audio.'; emit();
  });

  function loadFile(next) {
    ensureLive();
    if (!BlobClass || !(next instanceof BlobClass) || typeof next.name !== 'string' || !next.name) throw new TypeError('Choose a local audio file.');
    if (!next.size || next.size > LIPSYNC_MAX_BYTES) throw new RangeError('Choose audio between 1 byte and 256 MiB.');
    if (!/^audio\//i.test(next.type) && !(next.type === 'application/ogg' || !next.type) && !(next.type === 'video/webm' && /\.webm$/i.test(next.name))) throw new TypeError('Choose a supported audio file.');
    if (!next.type && !audioName.test(next.name)) throw new TypeError('Choose a supported audio file.');
    const nextUrl = urls.createObjectURL(next);
    cancelPlay(); audio.pause(); restoreMouth();
    audio.removeAttribute('src'); audio.load();
    if (objectUrl) urls.revokeObjectURL(objectUrl);
    objectUrl = nextUrl; file = next; error = ''; stalled = false; phase = 'ready';
    audio.src = objectUrl; audio.load(); captureBaseline(); emit();
    return snapshot();
  }

  function loadUrl(url, {name = 'Local audio', bytes: size = 0} = {}) {
    ensureLive();
    if (typeof url !== 'string' || !/^\/api\/avatars\/playback\/audio\/au_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(url)) throw new TypeError('Use a managed local avatar audio URL.');
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\u0000-\u001f]/.test(name)) throw new TypeError('Invalid audio name.');
    if (!Number.isSafeInteger(size) || size < 0 || size > LIPSYNC_MAX_BYTES) throw new TypeError('Invalid audio size.');
    cancelPlay(); audio.pause(); restoreMouth();
    audio.removeAttribute('src'); audio.load();
    if (objectUrl) urls.revokeObjectURL(objectUrl);
    objectUrl = null; file = {name, size}; error = ''; stalled = false; phase = 'ready';
    audio.src = url; audio.load(); captureBaseline(); emit(); return snapshot();
  }

  function ensureGraph() {
    if (!mouth || !Context || context) return;
    const nextContext = new Context(); let nextAnalyser, nextSource;
    try {
      nextAnalyser = nextContext.createAnalyser(); nextAnalyser.fftSize = 2048;
      // Time-domain RMS is smoothed below, independently of frame rate.
      nextAnalyser.smoothingTimeConstant = 0;
      if (typeof nextAnalyser.getFloatTimeDomainData === 'function') samples = new Float32Array(nextAnalyser.fftSize);
      else if (typeof nextAnalyser.getByteTimeDomainData === 'function') bytes = new Uint8Array(nextAnalyser.fftSize);
      else throw new Error('Audio waveform analysis is unavailable in this browser.');
      nextSource = nextContext.createMediaElementSource(audio);
      nextSource.connect(nextAnalyser); nextAnalyser.connect(nextContext.destination);
      context = nextContext; analyser = nextAnalyser; source = nextSource;
    } catch (cause) {
      nextSource?.disconnect(); nextAnalyser?.disconnect();
      Promise.resolve(nextContext.close()).catch(() => {}); throw cause;
    }
  }

  function play() {
    ensureLive();
    if (!file) return Promise.reject(new Error('Choose audio first.'));
    // A fresh user gesture must be able to unlock an earlier remote request.
    // The first resume() promise may never settle while a browser is suspended.
    if (pending) { const current = pending; current.retry(); return current.promise; }
    if (phase === 'playing' && !audio.paused) return Promise.resolve(snapshot());
    const token = ++epoch; requestedPlay = true; error = ''; phase = 'loading'; captureBaseline();
    let resolve, reject, timer, attempt = 0, settled = false;
    const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    const clear = () => { if (timer !== undefined) unschedule(timer); timer = undefined; if (pending === operation) pending = null; };
    const valid = current => !settled && !disposed && token === epoch && current === attempt;
    const failed = (cause, current) => {
      if (!valid(current)) return;
      settled = true; clear();
      requestedPlay = false; audio.pause(); restoreMouth(); phase = cause?.name === 'NotAllowedError' ? 'blocked' : 'error';
      error = cause?.name === 'NotAllowedError' ? 'Press Play in this browser to enable audio.' : cause?.message || 'Audio playback failed.';
      emit(); const failure = new Error(error); failure.name = cause?.name || 'Error'; reject(failure);
    };
    const operation = {
      // Resolve the snapshot after synchronous pause/load/dispose has finished.
      promise: completion.then(() => snapshot()),
      cancel() { if (settled) return; settled = true; clear(); resolve(); },
      retry() {
        const current = ++attempt;
        if (timer !== undefined) unschedule(timer);
        timer = schedule(() => {
          const suspended = context && context.state !== 'running' && context.state !== 'closed';
          const cause = new Error(suspended ? 'Audio needs browser activation.' : 'Audio playback did not become ready. Try Play again.');
          cause.name = suspended ? 'NotAllowedError' : 'TimeoutError'; failed(cause, current);
        }, 8000);
        let resumed, started;
        try {
          ensureGraph();
          // Both calls remain synchronous within the fresh click/keyboard gesture.
          resumed = context?.resume();
          // Attach rejection handling before audio.play(), which may throw.
          if (resumed) Promise.resolve(resumed).catch(() => {});
          started = audio.play();
        } catch (cause) { failed(cause, current); return; }
        Promise.all([resumed, started]).then(() => {
          if (!valid(current) || !requestedPlay) return;
          settled = true; clear(); phase = 'playing'; stalled = false; emit(); resolve();
        }, cause => failed(cause, current));
      },
    };
    pending = operation;
    emit(); operation.retry(); return operation.promise;
  }

  function pause() {
    ensureLive(); cancelPlay(); audio.pause(); restoreMouth();
    phase = file ? 'paused' : 'empty'; error = ''; emit(); return snapshot();
  }
  function stop() {
    pause();
    try { audio.currentTime = 0; } catch { /* Some browsers refuse a seek before metadata. */ }
    phase = file ? 'ready' : 'empty'; emit(); return snapshot();
  }
  function seek(seconds) {
    ensureLive();
    if (!file) throw new Error('Choose audio first.');
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new TypeError('Seek time must be a nonnegative number.');
    if (!Number.isFinite(audio.duration) && seconds !== 0) throw new Error('Wait for audio metadata before seeking.');
    audio.currentTime = Number.isFinite(audio.duration) ? Math.min(seconds, audio.duration) : 0;
    restoreMouth(); captureBaseline(); emit(); return snapshot();
  }

  function update(dt) {
    if (disposed || !mouth || !analyser || phase !== 'playing' || audio.paused || audio.ended) return;
    const delta = typeof dt === 'number' && Number.isFinite(dt) ? Math.min(.1, Math.max(0, dt)) : 0;
    if (!delta) return;
    if (samples) analyser.getFloatTimeDomainData(samples);
    else analyser.getByteTimeDomainData(bytes);
    const count = samples?.length || bytes.length;
    let total = 0, square = 0;
    for (let index = 0; index < count; index++) {
      const value = samples ? samples[index] : (bytes[index] - 128) / 128;
      if (!Number.isFinite(value)) continue;
      total += value; square += value * value;
    }
    rms = stalled ? 0 : Math.sqrt(Math.max(0, square / count - (total / count) ** 2));
    const target = clamp((rms - .008) / .18) * .9;
    const smoothing = target > envelope ? .045 : .12;
    envelope += (target - envelope) * (1 - Math.exp(-delta / smoothing));
    const observed = mouthValue();
    if (lastApplied === null || Math.abs(observed - lastApplied) > 1e-7) baseline = observed;
    const next = baseline + (1 - baseline) * envelope;
    expressionManager.setValue(mouth, next); lastApplied = next;
  }

  function dispose() {
    if (disposed) return Promise.resolve();
    cancelPlay(); audio.pause(); restoreMouth();
    disposed = true; phase = 'disposed';
    for (const [name, listener] of listeners) audio.removeEventListener(name, listener);
    audio.removeAttribute('src'); audio.load();
    if (objectUrl) urls.revokeObjectURL(objectUrl);
    objectUrl = null; file = null; source?.disconnect(); analyser?.disconnect();
    return Promise.resolve(context?.close()).catch(() => {});
  }
  return {loadFile, loadUrl, play, pause, stop, seek, update, captureBaseline, state: snapshot, dispose};
}
