/** Appearance controls use the exact HTTP actions used by the local workshop. */
const id = {type: 'string', pattern: '^av_[a-f0-9-]{36}$', description: 'Imported local avatar id.'};
const lookId = {type: 'string', pattern: '^look_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
const sha256 = {type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Exact source hash returned by appearance inventory.'};
const expectedRevision = {type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1, description: '0 for a new look; the current saved revision for an edit.'};
const schema = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
export const APPEARANCE_SETTINGS_SCHEMA = schema({
  hidden_nodes: {type: 'array', maxItems: 2048, uniqueItems: true, items: {type: 'integer', minimum: 0}, description: 'Existing mesh node indices only. Omit to preserve embedded visibility.'},
  material_colors: {type: 'object', maxProperties: 128, propertyNames: {pattern: '^(0|[1-9]\\d*)$'}, additionalProperties: {type: 'array', minItems: 4, maxItems: 4, items: {type: 'number', minimum: 0, maximum: 1}}, description: 'Existing material index to RGBA base color factor; textures stay embedded.'},
  expressions: {type: 'object', maxProperties: 256, propertyNames: {maxLength: 100}, additionalProperties: {type: 'number', minimum: 0, maximum: 1}, description: 'Embedded VRM preset or custom expression names only.'},
  spring_enabled: {type: 'boolean', description: 'Enables existing VRM spring chains; does not create hair bones or weights.'},
}, []);

export function avatarAppearanceTools(api) {
  const post = body => api('POST', '/api/avatars', body);
  const tool = (name, description, inputSchema, run) => ({name, description, inputSchema, run});
  return [
    tool('avatar_appearance_inventory', 'Read hash-pinned mesh nodes, material colors, morph names, VRM expressions and embedded spring-chain availability. This is an inventory, not a rig-quality certification.', schema({id}),
      a => post({action: 'appearance_inventory', id: a.id})),
    tool('avatar_appearance_list', 'List saved local looks for an imported avatar. Looks only override existing components; no generated attachments or skeleton changes.', schema({id}),
      a => post({action: 'appearance_list', id: a.id})),
    tool('avatar_appearance_get', 'Read one saved look after checking the original avatar hash.', schema({id, look_id: lookId}),
      a => post({action: 'appearance_get', id: a.id, look_id: a.look_id})),
    tool('avatar_appearance_save', 'Create or replace a named local look using inventory indices and expected_revision. Save does not select a new look; activate it explicitly. Empty settings preserve all embedded defaults. Persona id is attribution only.', schema({id, look_id: lookId, expected_revision: expectedRevision, sha256, name: {type: 'string', minLength: 1, maxLength: 80}, settings: APPEARANCE_SETTINGS_SCHEMA, persona_id: {type: ['string', 'null'], pattern: '^[1-9]\\d{0,11}$'}}, ['id', 'expected_revision', 'sha256', 'name', 'settings']),
      a => post({action: 'appearance_save', id: a.id, expected_revision: a.expected_revision, sha256: a.sha256, name: a.name, settings: a.settings,
        ...(a.look_id === undefined ? {} : {look_id: a.look_id}), ...(a.persona_id === undefined ? {} : {persona_id: a.persona_id})})),
    tool('avatar_appearance_delete', 'Delete a local saved look at its current revision. Clears selection when the deleted look was active. Does not delete or modify the avatar GLB.', schema({id, look_id: lookId, expected_revision: {...expectedRevision, minimum: 1}, sha256}),
      a => post({action: 'appearance_delete', id: a.id, look_id: a.look_id, expected_revision: a.expected_revision, sha256: a.sha256})),
    tool('avatar_appearance_active', 'Read the active local look and its latest revision, or null when none is selected.', schema({id}),
      a => post({action: 'appearance_active', id: a.id})),
    tool('avatar_appearance_activate', 'Select a saved, hash-pinned look for local preview. Does not install an avatar or bind a live AIPlay persona.', schema({id, look_id: lookId, sha256}),
      a => post({action: 'appearance_activate', id: a.id, look_id: a.look_id, sha256: a.sha256})),
  ];
}
