import { avatarAppearanceTools } from './mcp-avatar-appearance.js';
import { avatarHandoffTools } from './mcp-avatar-handoff.js';
/** One HTTP contract for the avatar UI and agents. */
export function avatarTools(api) {
  const post=body=>api('POST','/api/avatars',body);
  const identity={type:'object',required:['id'],properties:{id:{type:'string',description:'Local av_ id returned by avatar_import or avatar_list.'}},additionalProperties:false};
  return [
    ...avatarAppearanceTools(api),
    ...avatarHandoffTools(api),
    {name:'avatar_install_example',description:'Download and import the curated official anime VRM reference (10.3 MiB, hash pinned, VRM Public License 1.0 with embedded usage terms). Reuses an exact installed copy. This is a sample with expressions and hair springs, not a custom persona model or live account binding.',inputSchema:{type:'object',properties:{},additionalProperties:false},run:()=>post({action:'install_example'})},
    {name:'avatar_list',description:'List local reviewed/imported 3D avatar assets and native-world budgets. Local persona attribution is not account ownership or an installed world binding.',inputSchema:{type:'object',properties:{},additionalProperties:false},run:()=>api('GET','/api/avatars')},
    {name:'avatar_import',description:'Import a local self-contained rigged GLB for visual review. Runs Khronos validation and actual skin-data checks; preserves textures/embedded clips. Does not generate a mesh, retarget Senzu clips or bind a live persona. Review deformation and identity in previewUrl before handing off.',inputSchema:{type:'object',required:['path','name','source','license','skeleton_family','facing'],properties:{
      profile:{type:'string',enum:['world','vrm'],description:'world retains strict GLB world budgets; vrm is local VRM 1.0 preview with expressions and springs, not world admission.'},path:{type:'string',description:'Absolute local GLB path, 8 MiB for world GLB; 64 MiB for local VRM 1.0.'},name:{type:'string'},persona_id:{type:'string',description:'Optional source persona attribution only.'},source:{type:'string',description:'Canonical reference and creation method.'},license:{type:'string',description:'Actual license/rights provenance, without guessing.'},skeleton_family:{type:'string',description:'Exact rig family/version; generic name matching does not establish compatibility.'},facing:{type:'string',enum:['+Z','-Z','+X','-X']}},additionalProperties:false},run:a=>post({action:'import',...(a.profile?{profile:a.profile}:{}),path:a.path,name:a.name,persona_id:a.persona_id,source:a.source,license:a.license,skeleton_family:a.skeleton_family,facing:a.facing})},
    {name:'avatar_inspect',description:'Rehash and revalidate an imported rig, return joints, textures, clips, anchors, warnings and review state. Does not certify appearance, foot contact or mobile performance.',inputSchema:identity,run:a=>post({action:'inspect',id:a.id})},
    {name:'avatar_export',description:'Revalidate and return GLB/manifest download URLs and local paths for an avatar handoff. Records provenance. Does not install on AIPlay or authorize persona binding.',inputSchema:identity,run:a=>post({action:'export',id:a.id})},
  ];
}
