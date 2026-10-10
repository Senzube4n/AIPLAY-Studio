/** Ephemeral control for a browser-local PNGtuber. Image bytes never enter this service. */
export const PNGTUBER_LIMITS = Object.freeze({sessions:32, leaseMs:30000, cueMinMs:250, cueMaxMs:10000});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message, status=400) => Object.assign(new Error(message), {status});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(`Invalid ${label} fields.`);
}
function id(value) { if (typeof value !== 'string' || !uuid.test(value)) throw fail('Session id must be a UUID.'); return value; }
function status(value) {
  fields(value,['frame','source','staged','visible'],'PNGtuber status');
  if (!['idle','talking'].includes(value.frame) || !['none','mic','audio'].includes(value.source)
      || typeof value.staged !== 'boolean' || typeof value.visible !== 'boolean') throw fail('Invalid PNGtuber status.');
  return {...value};
}

export function createPngtuberSessions({now=Date.now} = {}) {
  const rows = new Map();
  const view = row => ({session_id:row.session_id,revision:row.revision,applied_revision:row.applied_revision,
    expiresAt:row.expiresAt,status:{...row.status},desired:{talkingCue:row.talkingCue &&
      (row.talkingCue.expiresAt===null || row.talkingCue.expiresAt>now()) ? {...row.talkingCue} : null}});
  const live = session_id => {
    const row = rows.get(id(session_id));
    if (!row) throw fail('PNGtuber session not found.',404);
    if (row.expiresAt<=now()) { rows.delete(session_id); throw fail('PNGtuber session expired.',410); }
    return row;
  };
  const trim = () => { for (const [session_id,row] of rows) if (row.expiresAt<=now()) rows.delete(session_id); };
  function register(input) {
    fields(input,['session_id'],'PNGtuber registration');
    const session_id=id(input.session_id);
    trim();
    let row=rows.get(session_id);
    if (!row) {
      if (rows.size>=PNGTUBER_LIMITS.sessions) throw fail('Too many live PNGtuber sessions.',409);
      row={session_id,revision:0,applied_revision:0,talkingCue:null,commands:new Map(),
        status:{frame:'idle',source:'none',staged:false,visible:false},expiresAt:0};
      rows.set(session_id,row);
    }
    row.expiresAt=now()+PNGTUBER_LIMITS.leaseMs;
    return view(row);
  }
  function heartbeat(input) {
    fields(input,['session_id','applied_revision','status'],'PNGtuber heartbeat');
    const row=live(input.session_id), applied=input.applied_revision;
    if (!Number.isSafeInteger(applied) || applied<row.applied_revision || applied>row.revision)
      throw fail('Applied PNGtuber revision is stale or ahead.',409);
    const reported=status(input.status);
    row.applied_revision=applied;
    row.status=reported;
    if (row.talkingCue?.expiresAt===null && applied>=row.talkingCue.revision)
      row.talkingCue.expiresAt=now()+row.talkingCue.durationMs;
    row.expiresAt=now()+PNGTUBER_LIMITS.leaseMs;
    return view(row);
  }
  function sessions(input={}) {
    fields(input,[],'PNGtuber sessions');
    trim();
    return {sessions:[...rows.values()].map(view).sort((a,b)=>a.session_id.localeCompare(b.session_id))};
  }
  function command(input) {
    fields(input,['session_id','command_id','op','duration_ms'],'PNGtuber command');
    const row=live(input.session_id);
    if (!['talk','clear_talk'].includes(input.op)) throw fail('Unknown PNGtuber command.');
    if (input.op==='talk' && !row.status.visible)
      throw fail('PNGtuber Preview is not visible in its browser source.',409);
    if (input.op==='talk' && (!Number.isSafeInteger(input.duration_ms) || input.duration_ms<PNGTUBER_LIMITS.cueMinMs
        || input.duration_ms>PNGTUBER_LIMITS.cueMaxMs)) throw fail('Talk cue must last 250 to 10000 ms.');
    if (input.op==='clear_talk' && input.duration_ms!==undefined) throw fail('Clear talk takes no duration.');
    const command_id=input.command_id===undefined?null:id(input.command_id);
    const signature=JSON.stringify([input.op,input.duration_ms??null]);
    if (command_id && row.commands.has(command_id)) {
      if (row.commands.get(command_id)!==signature) throw fail('Command id reused with different arguments.',409);
      return view(row);
    }
    const revision=++row.revision;
    row.talkingCue=input.op==='talk'?{revision,durationMs:input.duration_ms,expiresAt:null}:null;
    if (command_id) {
      row.commands.set(command_id,signature);
      if (row.commands.size>128) row.commands.delete(row.commands.keys().next().value);
    }
    return view(row);
  }
  return {register,heartbeat,sessions,command};
}

/** Mounted inside avatar.js, after its loopback Host/Origin/fetch-site guard. */
export function createPngtuberRoutes({json, now=Date.now}) {
  const service=createPngtuberSessions({now});
  return async(req,res,url) => {
    if (url.pathname!=='/api/avatars/pngtuber') return false;
    if (req.method!=='POST') throw fail('Use POST for PNGtuber controls.',405);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) throw fail('PNGtuber controls require application/json.',415);
    const chunks=[];let size=0;
    for await (const chunk of req) { size+=chunk.length; if (size>2048) throw fail('PNGtuber request too large.',413); chunks.push(chunk); }
    let input;try { input=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid PNGtuber JSON.'); }
    fields(input,['action','session_id','applied_revision','status','command_id','op','duration_ms'],'PNGtuber request');
    const {action,...args}=input;
    const result=action==='register'?service.register(args)
      :action==='heartbeat'?service.heartbeat(args)
      :action==='sessions'?service.sessions(args)
      :action==='command'?service.command(args)
      :(()=>{throw fail('Unknown PNGtuber action.');})();
    json(res,200,result);
    return true;
  };
}
