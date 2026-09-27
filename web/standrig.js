// Optional local 2D performer. StandRig owns the model; Studio owns this control surface.
const stage = document.getElementById('radioPerformer');

if (stage) {
  const byId = id => document.getElementById(id);
  const status = byId('srStatus');
  const note = byId('srNote');
  const check = byId('srCheck');
  const editor = byId('srEditor');
  const overlay = byId('srOverlay');
  const content = byId('srStage');
  const preview = byId('srPreview');
  const parameter = byId('srParameter');
  const slider = byId('srValue');
  const valueLabel = byId('srValueLabel');
  const demo = byId('srDemo');
  const play = byId('srPlay');
  const pause = byId('srPause');
  const reset = byId('srReset');
  const playerUrl = 'http://127.0.0.1:5180/player';
  let snapshot = null;
  let definitions = [];
  let definitionKey = '';
  let busy = false;
  let queued = Promise.resolve();

  async function api(method, body) {
    const response = await fetch('/api/standrig', {
      method,
      ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || `StandRig request failed (${response.status}).`);
    return result;
  }

  function message(text) {
    note.textContent = text;
    note.hidden = !text;
  }

  function selectedDefinition() { return definitions.find(item => item.id === parameter.value); }

  function paintValue() {
    const item = selectedDefinition();
    if (!item) { slider.disabled = true; valueLabel.textContent = '0'; return; }
    slider.disabled = parameter.disabled;
    slider.min = String(item.min);
    slider.max = String(item.max);
    slider.step = String(item.step);
    const value = Number(snapshot?.values?.[item.id]);
    slider.value = String(Number.isFinite(value) ? Math.min(item.max, Math.max(item.min, value)) : item.default);
    valueLabel.textContent = Number(slider.value).toFixed(item.step < 0.01 ? 3 : item.step < 1 ? 2 : 0);
  }

  function paint(result) {
    const connected = result?.connected === true;
    const ready = connected && result?.ready === true;
    const playable = ready && result.playerUrl === playerUrl;
    snapshot = connected ? result.playback : null;
    status.className = `chip ${ready ? 'ok' : 'warn'}`;
    status.textContent = ready ? 'Performer ready' : connected ? 'No 2D model' : 'Not connected';
    status.title = typeof result?.reason === 'string' ? result.reason.slice(0, 160) : '';
    message(playable ? '' : ready ? 'Player URL unavailable.' : connected ? 'Load a layered PSD in StandRig.' : 'Start StandRig on this computer.');
    editor.hidden = !connected;
    overlay.hidden = !playable;
    overlay.href = playable ? playerUrl : '#';
    content.hidden = !playable;
    if (playable) {
      if (preview.getAttribute('src') !== playerUrl) preview.src = playerUrl;
    } else if (preview.hasAttribute('src')) preview.removeAttribute('src');

    definitions = Array.isArray(snapshot?.parameters) ? snapshot.parameters.filter(item =>
      item && typeof item.id === 'string' && item.id.length > 0 &&
      Number.isFinite(item.min) && Number.isFinite(item.max) && item.max > item.min &&
      Number.isFinite(item.default)).map(item => ({...item,
        step: Number.isFinite(item.step) && item.step > 0 ? item.step : (item.max - item.min) / 100})) : [];
    const key = JSON.stringify(definitions.map(item => [item.id, item.label, item.min, item.max, item.default, item.step]));
    if (key !== definitionKey) {
      const previous = parameter.value;
      parameter.replaceChildren(...definitions.map(item => {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = String(item.label || item.id).slice(0, 60);
        return option;
      }));
      parameter.value = definitions.some(item => item.id === previous) ? previous :
        definitions.find(item => /mouth.*open/i.test(item.id))?.id || definitions[0]?.id || '';
      definitionKey = key;
    }
    parameter.disabled = !playable || !definitions.length;
    paintValue();
    for (const button of [demo, play, pause, reset]) button.disabled = !playable;
    demo.textContent = snapshot?.demo?.active ? 'Stop test' : 'Test motion';
  }

  async function refresh() {
    if (busy) return;
    busy = true; check.disabled = true;
    status.className = 'chip busy'; status.textContent = 'Checking';
    try { paint(await api('GET')); }
    catch (error) {
      paint({connected: false});
      status.className = 'chip err'; status.textContent = 'Could not check';
      message(error.message || 'Could not reach Studio.');
    } finally { busy = false; check.disabled = false; }
  }

  function send(body) {
    queued = queued.catch(() => {}).then(async () => {
      try { paint(await api('POST', body)); }
      catch (error) { message(error.message || 'Could not update the performer.'); }
    });
  }

  check.addEventListener('click', refresh);
  parameter.addEventListener('change', paintValue);
  slider.addEventListener('input', () => {
    const item = selectedDefinition();
    if (item) valueLabel.textContent = Number(slider.value).toFixed(item.step < 0.01 ? 3 : item.step < 1 ? 2 : 0);
  });
  slider.addEventListener('change', () => {
    const item = selectedDefinition();
    if (item) send({action: 'parameters', values: {[item.id]: Number(slider.value)}});
  });
  demo.addEventListener('click', () => send({action: 'control', command: snapshot?.demo?.active ? 'demo-stop' : 'demo-start'}));
  play.addEventListener('click', () => send({action: 'control', command: 'play'}));
  pause.addEventListener('click', () => send({action: 'control', command: 'pause'}));
  reset.addEventListener('click', () => send({action: 'control', command: 'reset'}));

  const radio = byId('radio');
  if (radio && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
      if (!radio.hidden) refresh();
    });
    observer.observe(radio, {attributes: true, attributeFilter: ['hidden']});
    if (!radio.hidden) refresh();
  }
}
