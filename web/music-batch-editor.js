import { MUSIC_BATCH_FIELDS, musicBatchIdea } from './music-batch-spec.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const engines = { 'minimax-music3': 'MiniMax Music 3', yue2: 'YuE2 Python', 'yue2-gguf': 'YuE2 GGUF', 'yue2-comfy': 'YuE2 ComfyUI', 'ace-step15': 'ACE-Step 1.5' };
const numbers = {
  maxDuration: ['length (s)', 1, 983], steps: ['steps', 1, 100, 1], arCfg: ['AR guidance', 0, 20], flowCfg: ['flow guidance', 0, 20], cfg: ['guidance', 0, 20],
  audioRefDenoise: ['reference strength', .05, 1], narSteps: ['audio steps', 1, 256, 1], cfgScale: ['guidance', 0, 20],
  temperature: ['temperature', 0, 5], topP: ['top P', .01, 1], topK: ['top K', 1, 32768, 1], repetitionPenalty: ['repeat penalty', .01, 10],
  planTemperature: ['planner temperature', 0, 5], planTopP: ['planner top P', .01, 1], bpm: ['tempo', 30, 300, 1],
  loraStrength: ['audio LoRA strength', -4, 4], loraClipStrength: ['planner LoRA strength', -4, 4], aceSteps: ['steps', 1, 100, 1], aceCfg: ['guidance', .01, 20], acePlanTemp: ['planner temperature', 0, 2],
};
const texts = { key: ['key', 16], meter: ['meter', 8], keyscale: ['key / scale', 40], timesignature: ['time signature', 8], language: ['language', 16],
  checkpoint: ['checkpoint', 200], lora: ['audio LoRA', 200], loraClip: ['planner LoRA', 200], audioRef: ['audio reference', 200] };
const booleans = { allowSectionLabels: 'allow lyric sections', abcOpen: 'continue the score', aceCodes: 'ACE planner' };
const enums = { cot: ['thinking', [['full', 'Full'], ['melody', 'Melody'], ['off', 'Off']]], model: ['model precision', [['int8', 'INT8'], ['fp16', 'FP16'], ['fp32', 'FP32']]] };

export function musicBatchPlannerOff(idea) {
  return ['yue2-gguf', 'yue2-comfy'].includes(idea.engine) && (idea.cot === 'off' || !!idea.abc?.trim());
}

/** Match the Music form: a planner that does not run receives no planner dials. */
export function musicBatchSubmission(idea) {
  const out = musicBatchIdea(idea);
  if (musicBatchPlannerOff(out)) { delete out.planTemperature; delete out.planTopP; }
  return out;
}

const plannerReason = idea => idea.abc?.trim() ? 'Planner off for this score.' : 'Thinking is Off.';

export function syncMusicBatchPlannerFields(card, idea) {
  const off = musicBatchPlannerOff(idea);
  for (const field of card.querySelectorAll?.('[data-ov-field="planTemperature"], [data-ov-field="planTopP"]') || []) {
    field.disabled = off;
    field.title = off ? plannerReason(idea) : '';
    field.value = idea[field.dataset.ovField] ?? '';
  }
  const note = card.querySelector?.('[data-ov-planner-note]');
  if (note) { note.hidden = !off; note.textContent = off ? plannerReason(idea) : ''; }
}

function settings(idea, index) {
  const allowed = MUSIC_BATCH_FIELDS[idea.engine] || [];
  const row = (key, label, control) => `<label for="ovIdea${index}-${key}">${label}</label><span class="pv">${control}</span>`;
  const props = key => `id="ovIdea${index}-${key}" data-ov-field="${key}"`;
  const result = [];
  for (const key of allowed) {
    // ComfyUI has fixed guidance. A saved 1 remains in the snapshot, but is not an editable dial.
    if (key === 'cfgScale' && idea.engine === 'yue2-comfy') continue;
    if (key === 'narSteps' && idea.engine === 'yue2') {
      result.push(row(key, 'audio steps', `<select ${props(key)} class="sel2"><option value="">Automatic</option>${[16, 32].map(value => `<option value="${value}" ${idea[key] === value ? 'selected' : ''}>${value}</option>`).join('')}</select>`));
    } else if (numbers[key]) {
      const [label, min, max, step = 'any'] = key === 'narSteps' && idea.engine === 'yue2-comfy' ? ['audio steps', 8, 64, 1] : numbers[key];
      const off = ['planTemperature', 'planTopP'].includes(key) && musicBatchPlannerOff(idea);
      result.push(row(key, label, `<input ${props(key)} class="in2 num" type="number" min="${min}" max="${max}" step="${step}" value="${off ? '' : esc(idea[key])}" ${off ? `disabled title="${plannerReason(idea)}"` : ''} placeholder="Automatic">`));
    } else if (texts[key]) {
      const [label, max] = texts[key];
      result.push(row(key, label, `<input ${props(key)} class="in2" maxlength="${max}" value="${esc(idea[key])}" placeholder="Automatic">`));
    } else if (booleans[key]) {
      result.push(row(key, booleans[key], `<select ${props(key)} class="sel2"><option value="">Automatic</option><option value="true" ${idea[key] === true ? 'selected' : ''}>On</option><option value="false" ${idea[key] === false ? 'selected' : ''}>Off</option></select>`));
    } else if (enums[key] || key === 'quantization') {
      const [label, choices] = key === 'quantization' ? ['precision', idea.engine === 'yue2-gguf' ? [['q4_0', 'Q4'], ['q8_0', 'Q8']] : [['none', 'Full'], ['fp8', 'FP8']]] : enums[key];
      result.push(row(key, label, `<select ${props(key)} class="sel2"><option value="">Automatic</option>${choices.map(([value, name]) => `<option value="${value}" ${idea[key] === value ? 'selected' : ''}>${name}</option>`).join('')}</select>`));
    }
  }
  if (allowed.includes('planTemperature')) result.push(`<p class="hint ovb-wide" data-ov-planner-note ${musicBatchPlannerOff(idea) ? '' : 'hidden'}>${musicBatchPlannerOff(idea) ? plannerReason(idea) : ''}</p>`);
  if (allowed.includes('abc')) result.push(`<label class="ovb-wide" for="ovIdea${index}-abc">score (ABC)<textarea ${props('abc')} rows="5" spellcheck="false" maxlength="65536" placeholder="Optional score">${esc(idea.abc)}</textarea></label>`);
  const reference = Object.fromEntries(['coverOf', 'aceCover', 'scoreSlug', 'scoreVersion'].filter(key => idea[key] !== undefined).map(key => [key, idea[key]]));
  if (Object.keys(reference).length) result.push(`<details class="more ovb-wide"><summary>Saved references</summary><pre>${esc(JSON.stringify(reference, null, 2))}</pre></details>`);
  return result.join('');
}

/** Untouched text and references keep their exact values. Changing planner
 * context also clears dials that the selected engine can no longer apply. */
export function updateMusicBatchField(idea, key, value) {
  if (key === 'engine') {
    if (!MUSIC_BATCH_FIELDS[value]) throw new Error('Choose a supported music engine.');
    if (value === 'yue2-gguf' && idea.instrumental) throw new Error('YuE2 GGUF needs lyrics. Turn off Instrumental before changing engine.');
    return musicBatchIdea({ engine: value, title: idea.title, caption: idea.caption, lyrics: idea.lyrics, instrumental: !!idea.instrumental }, value);
  }
  if (!(MUSIC_BATCH_FIELDS[idea.engine] || []).includes(key)) throw new Error('This engine does not accept that setting.');
  const out = structuredClone(idea);
  if (numbers[key]) {
    if (value === '') delete out[key];
    else { const number = Number(value); if (!Number.isFinite(number)) throw new Error('Enter a finite number.'); out[key] = number; }
  } else if (booleans[key]) {
    if (value === '') delete out[key];
    else if ([true, false, 'true', 'false'].includes(value)) out[key] = value === true || value === 'true';
    else throw new Error('Choose Automatic, On or Off.');
  } else if (key === 'instrumental') out[key] = !!value;
  else if (typeof value === 'string') {
    if (!['title', 'caption', 'lyrics'].includes(key) && value === '') delete out[key];
    else out[key] = value;
  } else throw new Error('Choose a supported field value.');
  return musicBatchSubmission(out);
}

export function renderMusicBatchIdea(idea, index) {
  return `<article class="ovb-idea" data-ov-idea="${index}">
    <header class="ovb-ideahead"><b>Song ${index + 1}</b><span class="chip ${idea.caption?.trim() ? 'ok' : 'warn'}">${idea.caption?.trim() ? 'Ready to review' : 'Style needed'}</span><button class="edtool" type="button" data-rm="${index}" aria-label="Remove song ${index + 1}">Remove</button></header>
    <label for="ovIdea${index}-title">title<input id="ovIdea${index}-title" data-ov-field="title" class="in2" maxlength="120" value="${esc(idea.title)}" placeholder="Song title"></label>
    <label for="ovIdea${index}-caption">style<textarea id="ovIdea${index}-caption" data-ov-field="caption" rows="3" maxlength="10000" required placeholder="Genre, mood, instruments…">${esc(idea.caption)}</textarea></label>
    ${idea.engine === 'yue2-gguf' ? '<p class="hint">YuE2 GGUF requires lyrics.</p>' : `<label class="tog"><input data-ov-field="instrumental" type="checkbox" ${idea.instrumental ? 'checked' : ''}> Instrumental</label>`}
    <label for="ovIdea${index}-lyrics">lyrics<textarea id="ovIdea${index}-lyrics" data-ov-field="lyrics" rows="4" maxlength="20000" ${idea.engine === 'yue2-gguf' ? 'required' : ''} spellcheck="false" placeholder="Lyrics for this song">${esc(idea.lyrics)}</textarea></label>
    <details class="more"><summary>${esc(engines[idea.engine] || idea.engine)} settings</summary><div class="params ovb-settings">
      <label for="ovIdea${index}-engine">engine</label><span class="pv"><select id="ovIdea${index}-engine" data-ov-field="engine" class="sel2">${Object.entries(engines).map(([key, name]) => `<option value="${key}" ${idea.engine === key ? 'selected' : ''}>${name}</option>`).join('')}</select></span>
      ${settings(idea, index)}</div></details>
  </article>`;
}
