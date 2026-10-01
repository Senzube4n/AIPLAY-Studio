let owner=null;
export const externalMusicWork={
  get owner(){return owner;},
  acquire(label){
    if(owner) throw new Error(`Music tools are busy: ${owner.label}`);
    const token=Object.freeze({label}); owner=token;
    return ()=>{if(owner===token) owner=null;};
  },
  assertFree(){if(owner) throw new Error(`Music tools are busy: ${owner.label}`);},
};
