import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VfxRenderQueue } from "./render-queue.js";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async (fn) => { for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));} throw new Error("condition timeout"); };
const row = id => ({ id, slug: "test", kind: "render", status: "queued", retryable: true });
async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aiplay-vfx-queue-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test("bounded worker reserves concurrent arrivals, never overlaps", async () => fixture(async dir => {
  const q = new VfxRenderQueue({dir, records:new Map(), limit:2});
  const gate = deferred(); let active=0, peak=0, ran=0;
  const run = async()=>{ peak=Math.max(peak,++active); ran++; await gate.promise; active--; };
  const accepted = await Promise.allSettled([q.add(row("a"),run),q.add(row("b"),run),q.add(row("c"),run)]);
  assert.equal(accepted.filter(x=>x.status==="fulfilled").length,2);
  assert.equal(accepted.filter(x=>x.status==="rejected").length,1);
  await until(()=>ran===1); assert.equal(peak,1);
  gate.resolve(); await until(()=>!q.active && !q.pending.length); assert.equal(ran,2); assert.equal(peak,1);
}));
test("queued cancellation never starts its runner; active cancellation aborts then finishes", async()=>fixture(async dir=>{
  const q=new VfxRenderQueue({dir,records:new Map()}); let second=false;
  await q.add(row("a"),signal=>new Promise(resolve=>signal.addEventListener("abort",resolve,{once:true})));
  await until(()=>q.active?.rec.id==="a");
  await q.add(row("b"),async()=>{second=true;});
  assert.equal(await q.cancel("b"),true); assert.equal(second,false);
  assert.equal(q.records.get("b").status,"cancelled");
  assert.equal(await q.cancel("a"),true); await until(()=>!q.active);
  assert.equal(q.records.get("a").status,"cancelled");
  assert.equal(await q.cancel("missing"),false);
}));
test("startup persists interrupted outcomes without auto-running",async()=>fixture(async dir=>{
  await writeFile(path.join(dir,"render-jobs.json"),JSON.stringify({jobs:[{...row("a"),status:"running"},{...row("b"),status:"queued"},{...row("c"),status:"done"}]}));
  const q=new VfxRenderQueue({dir,records:new Map()});await q.load();
  assert.equal(q.records.get("a").status,"interrupted");assert.equal(q.records.get("b").status,"interrupted");assert.equal(q.records.get("c").status,"done");assert.equal(q.active,null);assert.equal(q.pending.length,0);
  assert.equal(JSON.parse(await readFile(path.join(dir,"render-jobs.json"))).jobs[0].status,"interrupted");
}));
test("failure releases worker and history records it",async()=>fixture(async dir=>{
  const q=new VfxRenderQueue({dir,records:new Map()});
  await q.add(row("a"),async()=>{throw new Error("fixture failure");});
  await q.add(row("b"),async()=>{q.records.get("b").status="done";});
  await until(()=>!q.active && !q.pending.length);
  assert.equal(q.records.get("a").status,"failed");assert.equal(q.records.get("b").status,"done");
  assert.equal(JSON.parse(await readFile(path.join(dir,"render-jobs.json"))).jobs[0].error,"fixture failure");
}));
test("corrupt history is refused, not overwritten",async()=>fixture(async dir=>{
  const file=path.join(dir,"render-jobs.json");await writeFile(file,"broken");
  const q=new VfxRenderQueue({dir,records:new Map()});await assert.rejects(q.add(row("a"),async()=>{}),/Cannot read/);assert.equal(await readFile(file,"utf8"),"broken");
}));
