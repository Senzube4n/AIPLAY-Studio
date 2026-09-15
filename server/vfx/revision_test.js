import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const dir=await mkdtemp(path.join(os.tmpdir(),"aiplay-vfx-revision-"));
process.env.AIPLAY_APPDATA=path.join(dir,"profile");process.env.AIPLAY_OUTPUT=path.join(dir,"output");process.env.AIPLAY_RIG=path.join(dir,"norig");
const {createComp,readComp,updateComp,deleteComp,withCompRevision}=await import("./store.js");
test.after(async()=>{await rm(dir,{recursive:true,force:true});});
test("concurrent creators allocate separate documents instead of overwriting",async()=>{
  const docs=await Promise.all([1,2,3].map(n=>createComp("same name",{duration:n})));
  assert.equal(new Set(docs.map(d=>d.slug)).size,3);
  assert.deepEqual(await Promise.all(docs.map(async d=>(await readComp(d.slug)).duration)),[1,2,3]);
});
test("one of simultaneous stale edits wins; losing edit cannot overwrite",async()=>{
  const d=await createComp("CAS test");
  const attempts=await Promise.allSettled(["first","second"].map(name=>withCompRevision(d.slug,d.updatedAt,()=>updateComp(d.slug,x=>{x.name=name;}))));
  assert.equal(attempts.filter(x=>x.status==="fulfilled").length,1);
  const err=attempts.find(x=>x.status==="rejected").reason;
  assert.equal(err.code,"comp_conflict");assert.equal(err.comp.name,"first");assert.equal(err.currentRevision,(await readComp(d.slug)).updatedAt);
});
test("checked request holds writer lock across its async steps; later background writer progresses",async()=>{
  const d=await createComp("async lock");let release;const gate=new Promise(r=>{release=r;});let entered;const ready=new Promise(r=>{entered=r;});
  const first=withCompRevision(d.slug,d.updatedAt,async()=>{entered();await gate;await updateComp(d.slug,x=>{x.name="foreground";});});
  await ready;const second=updateComp(d.slug,x=>{assert.equal(x.name,"foreground");x.name="background";});release();await Promise.all([first,second]);assert.equal((await readComp(d.slug)).name,"background");
});
test("failed transaction guard releases lock and legacy writes remain supported",async()=>{
  const d=await createComp("release");await assert.rejects(withCompRevision(d.slug,d.updatedAt,async()=>{throw new Error("fixture");}),/fixture/);
  await updateComp(d.slug,x=>{x.name="live";});assert.equal((await readComp(d.slug)).name,"live");
  await assert.rejects(withCompRevision(d.slug,d.updatedAt,()=>deleteComp(d.slug)),{code:"comp_conflict"});assert.ok(await readComp(d.slug));
  await assert.rejects(withCompRevision(d.slug,"bad",()=>{}),/integer/);
});
