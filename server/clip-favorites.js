/** Personal bin favorites, separate from media and generation lineage. */
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat,unlink} from 'node:fs/promises';
import {renameAtomic} from './fs-atomic.js';

const MEDIA = /\.(mp4|webm|mov|mkv|m4v|mp3|wav|flac|ogg|opus|m4a|png|jpg|jpeg|webp|gif)$/i;
const chains = new Map();
const MAX_STORE_BYTES = 4 * 1024 * 1024;
class FavoriteError extends Error {
  constructor(status,reason,message) { super(message); this.status=status; this.reason=reason; }
}
const invalid = () => new FavoriteError(400,'invalid-favorite','Choose an existing clip name and a true or false favorite value.');
const corrupt = () => new FavoriteError(409,'favorites-corrupt','The clip favorites file is damaged. Restore it before changing favorites.');
export function clipFavoriteName(name) {
  if (typeof name !== 'string' || !name || name.length > 255 || /[\\/:*?"<>|\x00-\x1f]/.test(name)
    || name.includes('..') || /[. ]$/.test(name) || !MEDIA.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw invalid();
  return name;
}
export function clipFavoriteFailure(error) {
  return error instanceof FavoriteError ? {status:error.status,body:{error:error.message,reason:error.reason}}
    : {status:500,body:{error:'Clip favorites could not be saved or read. Check access to the Studio data folder.',reason:'favorites-unavailable'}};
}

/** A fresh read inside each serialized transaction prevents lost updates from
 * concurrent HTTP requests (including separate store instances in this server).
 * Replace only a valid store; a malformed/unreadable original is never repaired
 * by overwriting it. Each acknowledged mutation has completed its atomic save. */
export function createClipFavorites({file,clipDir,io={readFile,writeFile,mkdir,lstat,unlink},replace=renameAtomic}) {
  const full = path.resolve(file);
  function serial(operation) {
    const previous = chains.get(full) || Promise.resolve();
    const next = previous.then(operation,operation), tail = next.catch(() => {});
    chains.set(full,tail);
    void tail.finally(() => { if (chains.get(full) === tail) chains.delete(full); });
    return next;
  }
  async function read() {
    let bytes;
    try {
      const info=await io.lstat(full);
      if (!info.isFile() || info.size > MAX_STORE_BYTES) throw corrupt();
      bytes=await io.readFile(full);
    }
    catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
    if (bytes.length > MAX_STORE_BYTES) throw corrupt();
    let data;
    try { data=JSON.parse(bytes.toString('utf8')); } catch { throw corrupt(); }
    if (!data || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.starred)
      || Object.keys(data).some(key => !['version','starred'].includes(key))) throw corrupt();
    for (const name of data.starred) { try { clipFavoriteName(name); } catch { throw corrupt(); } }
    return new Set(data.starred);
  }
  return {
    read: () => serial(read),
    async set(name,value) {
      clipFavoriteName(name);
      if (typeof value !== 'boolean') throw invalid();
      return serial(async () => {
        const favorites=await read();
        let info;
        try { info=await io.lstat(path.join(clipDir,name)); }
        catch (error) { if (error.code === 'ENOENT') throw new FavoriteError(404,'clip-missing','That clip is no longer in the library.'); throw error; }
        if (!info.isFile()) throw new FavoriteError(404,'clip-missing','Choose a file in the clips library.');
        if (favorites.has(name) === value) return {name,starred:value};
        if (value) favorites.add(name); else favorites.delete(name);
        const text=JSON.stringify({version:1,starred:[...favorites].sort()},null,2)+'\n';
        if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw new FavoriteError(409,'favorites-full','The clip favorites file is full. Remove a favorite first.');
        await io.mkdir(path.dirname(full),{recursive:true});
        const temporary=`${full}.${randomUUID()}.tmp`;
        try {
          await io.writeFile(temporary,text,{flag:'wx',mode:0o600});
          await replace(temporary,full);
        } finally { await io.unlink(temporary).catch(() => {}); }
        return {name,starred:value};
      });
    },
  };
}

export function createClipFavoriteFlagRoute({favorites,json,sameOriginLocalJson}) {
  return async (req,res,body) => {
    if (!sameOriginLocalJson(req)) return json(res,403,{error:'Favorite changes require Studio’s own JSON request.',reason:'favorite-origin'});
    try {
      if (!body || body.action !== 'flag' || body.flag !== 'starred'
        || Object.keys(body).some(key => !['action','flag','name','value'].includes(key))) throw invalid();
      const result=await favorites.set(body.name,body.value);
      return json(res,200,{ok:true,...result});
    } catch (error) { const failure=clipFavoriteFailure(error); return json(res,failure.status,failure.body); }
  };
}
