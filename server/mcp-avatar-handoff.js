/** Outfit export shares the exact browser snapshot and composition service. */
export function avatarHandoffTools(api) {
  const post=body=>api('POST','/api/avatars/handoff',body);
  return [
    {name:'avatar_outfit_export',description:'Snapshot a saved VRM look and its saved wardrobe into one self-contained VRM and AIPlay outfit package. Requires current source hash and revisions. Preserves original skeleton, textures and existing springs; records local provenance. Import the package into World separately; no account is bound or upload performed.',inputSchema:{type:'object',additionalProperties:false,required:['id','sha256','look_id','expected_look_revision','expected_wardrobe_revision'],properties:{
      id:{type:'string',pattern:'^av_[a-f0-9-]{36}$'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},look_id:{type:['string','null'],pattern:'^look_[a-f0-9-]{36}$'},expected_look_revision:{type:'integer',minimum:0},expected_wardrobe_revision:{type:'integer',minimum:0}}},
      run:a=>post({action:'prepare',id:a.id,sha256:a.sha256,look_id:a.look_id,expected_look_revision:a.expected_look_revision,expected_wardrobe_revision:a.expected_wardrobe_revision})},
    {name:'avatar_outfit_get',description:'Read an immutable prepared outfit export and its local download URLs. Does not upload or bind an avatar.',inputSchema:{type:'object',additionalProperties:false,required:['export_id'],properties:{export_id:{type:'string',pattern:'^outfit_[a-f0-9]{64}$'}}},run:a=>post({action:'get',export_id:a.export_id})},
  ];
}
