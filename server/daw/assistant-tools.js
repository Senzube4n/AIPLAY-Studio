/** Project-bound desktop assistants. These are the existing DAW reducers,
 * never the global MCP surface. The route owns approvals and agent identity. */
import { dawTools } from '../mcp-daw.js';

// Reviewed against chat/router.js ROUTABLE; absence always means unavailable.
export const ASSISTANT_TOOL_GATES = Object.freeze({
  daw_get_project: null, daw_layout: null, daw_set_length: null,
  daw_add_track: null, daw_set_track: null, daw_remove_track: 'destroys',
  daw_add_clip: null, daw_set_clip: null, daw_remove_clip: 'destroys',
  daw_add_note: null, daw_move_note: null, daw_edit_notes: null,
  daw_delete_note: 'destroys', daw_restore_note: null,
  daw_set_meter: null, daw_set_tempo: null, daw_render_plan: null,
  daw_render: 'gpu', daw_render_ahead: 'gpu', daw_preview_note: 'gpu',
  daw_bounce: 'gpu', daw_render_stems: 'gpu', daw_patches: null,
  daw_credits: null, daw_ledger: null, daw_insert: null, daw_mixer: null,
});
const ACTIONS = new Set([
  'set_view', 'set_length', 'add_track', 'set_track', 'remove_track',
  'add_clip', 'set_clip', 'remove_clip', 'add_note', 'move_note', 'edit_notes',
  'delete_note', 'restore_note', 'set_meter', 'remove_meter', 'set_tempo', 'remove_tempo',
  'render_plan', 'render', 'render_ahead', 'preview_note', 'bounce', 'render_stems', 'credits',
  'insert_add', 'insert_set', 'insert_remove', 'mixer_set', 'send_set', 'send_remove',
  'return_add', 'return_remove',
]);
export const ASSISTANT_ARGUMENT_BYTES = 128 * 1024;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function boundedJson(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 12 || ++budget.nodes > 20000) throw Error('Tool arguments are too complex.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('Tool numbers must be finite.'); return; }
  if (typeof value === 'string') { if (value.length > 16384) throw Error('Tool text is too long.'); return; }
  if (Array.isArray(value)) {
    if (value.length > 2048) throw Error('Too many tool items.');
    for (const item of value) boundedJson(item, depth + 1, budget);
    return;
  }
  if (!plain(value)) throw Error('Tool arguments must contain only JSON values.');
  const entries = Object.entries(value);
  if (entries.length > 256) throw Error('Too many tool fields.');
  for (const [key, item] of entries) {
    if (FORBIDDEN.has(key) || key.length > 256) throw Error('Invalid tool field.');
    boundedJson(item, depth + 1, budget);
  }
}

function checkSchema(schema, value, at = 'arguments') {
  const kinds = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const isType = type => type === 'null' ? value === null : type === 'object' ? plain(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type;
  if (kinds.length && !kinds.some(isType)) throw Error(`${at} has the wrong type.`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw Error(`${at} is not an allowed value.`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)
      throw Error(`${at} is outside its allowed range.`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)
      throw Error(`${at} has an invalid length.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw Error(`${at} has an invalid format.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems)
      throw Error(`${at} has too many or too few items.`);
    if (schema.items) value.forEach((item, i) => checkSchema(schema.items, item, `${at}[${i}]`));
  } else if (plain(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw Error(`${at}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) checkSchema(schema.properties[key], item, `${at}.${key}`);
      else if (schema.additionalProperties === false) throw Error(`${at}.${key} is not supported.`);
      else if (plain(schema.additionalProperties)) checkSchema(schema.additionalProperties, item, `${at}.${key}`);
    }
  }
}

/** Validate before approval as well as before execution; return an owned copy. */
export function validateAssistantArguments(schema, args) {
  if (!plain(args)) throw Error('Tool arguments must be a JSON object.');
  boundedJson(args);
  if (Buffer.byteLength(JSON.stringify(args)) > ASSISTANT_ARGUMENT_BYTES) throw Error('Tool arguments are too large.');
  checkSchema(schema, args);
  return JSON.parse(JSON.stringify(args));
}

export function createAssistantTools({ slug, api }) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(slug)) throw Error('Choose a valid DAW project.');
  if (typeof api !== 'function') throw Error('A scoped Studio API is required.');
  const projectPath = `/api/daw/project/${encodeURIComponent(slug)}`;
  const scopedApi = async (method, route, body) => {
    if (method === 'GET' && [projectPath, '/api/daw/rack', '/api/daw/patches'].includes(route) && body === undefined)
      return api(method, route);
    if (method !== 'POST' || route !== '/api/daw' || !plain(body) || body.slug !== slug || !ACTIONS.has(body.action))
      throw Error('This assistant can only use its selected DAW project.');
    // No file paths, global settings, plugins or raw HTTP fallback enter here.
    if (['file', 'path', 'source', 'reference', 'profile', 'plugin', 'plugin_snapshot'].some(key => body[key] !== undefined))
      throw Error('External files and native plugin operations are unavailable here.');
    return api(method, route, { ...body, slug, by: 'agent' });
  };
  const safeName = value => {
    if (value !== slug) throw Error('The tool belongs to a different DAW project.');
    return slug;
  };
  return dawTools(scopedApi, safeName).filter(tool => Object.hasOwn(ASSISTANT_TOOL_GATES, tool.name)).map(tool => {
    const inputSchema = structuredClone(tool.inputSchema);
    inputSchema.properties.slug = { type: 'string', enum: [slug], description: 'The project selected for this conversation.' };
    inputSchema.required = [...new Set([...(inputSchema.required || []), 'slug'])];
    let description = tool.description;
    if (tool.name === 'daw_patches') {
      for (const field of ['patch', 'pack', 'accept_licence']) delete inputSchema.properties[field];
      inputSchema.properties.action.enum = ['list'];
      description = 'Read the installed instrument catalogue, parameter ranges and licences. This assistant cannot install or uninstall packs.';
    }
    if (tool.name === 'daw_insert') {
      for (const field of ['plugin', 'plugin_snapshot']) delete inputSchema.properties[field];
      inputSchema.properties.type.enum = inputSchema.properties.type.enum.filter(type => type !== 'vst3');
      description += ' Native plugin installation and adding VST3 inserts are unavailable in this assistant.';
    }
    const validate = args => validateAssistantArguments(inputSchema, args);
    return { name: tool.name, description, inputSchema, gate: ASSISTANT_TOOL_GATES[tool.name], validate,
      run: args => tool.run(validate(args)) };
  });
}
