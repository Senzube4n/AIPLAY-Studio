/** The same bounded attachment preparation service is available to agents. */
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const file={type:'string',minLength:1,maxLength:4096,description:'Absolute local self-contained GLB path. The original file stays unchanged.'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const id={type:'string',pattern:'^wt_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
export function avatarWeightTransferTools(api){
  const post=body=>api('POST','/api/avatar-weight-transfer',body);
  return [
    {name:'avatar_weight_transfer_status',description:'Check the optional local Blender Python configuration for attachment weight transfer. Availability needs both an installed interpreter and the out-of-tree weight_transfer.py script (AIPLAY_WEIGHT_TRANSFER_SCRIPT); inspection proves bpy and the selected base are usable. No model download or rig generation.',inputSchema:schema({}),run:()=>post({action:'status'})},
    {name:'avatar_weight_transfer_inspect',description:'Inspect the full rest-pose skeleton of a weighted base and hash the selected base and optional unrigged attachment. Returns the fingerprint and exact byte hashes required for transfer. Does not certify topology or visual quality.',
      inputSchema:schema({reference_path:file,target_path:file},['reference_path']),run:a=>post({action:'inspect',reference_path:a.reference_path,...(a.target_path?{target_path:a.target_path}:{})})},
    {name:'avatar_weight_transfer_submit',description:'Prepare one locally aligned unrigged attachment by transferring barycentric weights from the nearest reference triangles. Requires exact inspected source hashes and skeleton; every vertex must meet the distance limit. Preserves materials, UVs and the full joint hierarchy. Starts an asynchronous local CPU job, without creating a new rig, hair physics, or automatically installing the attachment.',
      inputSchema:schema({reference_path:file,target_path:file,reference_sha256:hash,target_sha256:hash,expected_skeleton:hash,
        transform:{type:'array',minItems:16,maxItems:16,items:{type:'number'},description:'Explicit affine column-major glTF matrix, metres, +Y up; identity is [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]. No automatic alignment.'},
        max_distance:{type:'number',exclusiveMinimum:0,maximum:1,description:'Every attachment vertex must be this close to a weighted reference surface, in metres.'},
        name:{type:'string',minLength:1,maxLength:100},source:{type:'string',minLength:1,maxLength:2000},license:{type:'string',minLength:1,maxLength:2000}}),
      run:a=>post({action:'submit',reference_path:a.reference_path,target_path:a.target_path,reference_sha256:a.reference_sha256,target_sha256:a.target_sha256,expected_skeleton:a.expected_skeleton,transform:a.transform,max_distance:a.max_distance,name:a.name,source:a.source,license:a.license})},
    {name:'avatar_weight_transfer_get',description:'Poll a local attachment-binding job and revalidate completed output bytes. Complete means verified skin data awaiting visual review, not a finished character or installed outfit.',inputSchema:schema({id}),run:a=>post({action:'get',id:a.id})},
  ];
}
