/** Real route/store/queue calls; injected fake subprocess writes only fixture
 * bytes. No Python, GPU, browser, live profile, media encoder or network. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
const root=await mkdtemp(path.join(os.tmpdir(),"aiplay-vfx-routes-"));
process.env.AIPLAY_APPDATA=path.join(root,"profile");process.env.AIPLAY_OUTPUT=path.join(root,"output");process.env.AIPLAY_RIG=path.join(root,"norig");
const {config}=await import("../config.js");
const {createComp,updateComp,blankLayer,readComp}=await import("./store.js");
const {createVfxRoutes}=await import("./routes.js");
const {vfxTools}=await import("../mcp-vfx.js");
const clips=path.join(root,"clips");await mkdir(clips,{recursive:true});
const pending=[];let started=0;
const analyses=[];let analysisStarted=0;
const until=async fn=>{for(let n=0;n<400;n++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error("fixture timeout");};
const handler=createVfxRoutes({config,CLIP_DIR:clips,IMAGE_DIR:path.join(root,"images"),art:null,
  readBody:async req=>req.body,json:(res,status,body)=>{res.status=status;res.body=body;},
  spawnPython(args){
    const analysis=["audiokeys.py","tracker.py"].includes(path.basename(args[0]));
    if(!analysis)assert.equal(args[1],"render");
    const proc=new EventEmitter();proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();
    let closed=false;
    proc.kill=()=>{if(!closed){closed=true;queueMicrotask(()=>proc.emit("close",1));}return true;};
    if(analysis){
      analysisStarted++;
      analyses.push(()=>{
        const result=path.basename(args[0])==="audiokeys.py"
          ?{ok:true,tracks:{amplitude:{keys:[{t:0,v:.2},{t:1,v:.8}]}},bpm:120,beats:[0]}
          :{ok:true,keys:{position:{keys:[{t:0,v:[4,8]},{t:1,v:[6,10]}]}},frames:2,fps:2};
        closed=true;proc.stdout.emit("data",JSON.stringify(result)+"\n");proc.emit("close",0);
      });
      return proc;
    }
    started++;
    pending.push(async(fail=false)=>{
      if(closed)return;
      const job=JSON.parse(await readFile(args[2],"utf8"));
      await writeFile(job.out,Buffer.from("isolated encoder fixture"));
      closed=true;
      proc.stdout.emit("data",JSON.stringify(fail?{ok:false,error:"fixture encode failure"}:{ok:true,frames:2,seconds:1,ms:1})+"\n");
      proc.emit("close",fail?1:0);
    });
    return proc;
  },
});
async function call(body,url="/api/vfx",method="POST"){
  const req={method,body,headers:{}};const res={};await handler(req,res,new URL(url,"http://127.0.0.1"));return res;
}
test.after(async()=>{await rm(root,{recursive:true,force:true});});
test("HTTP409 protects a real comp and MCP forwards revision guards",async()=>{
  const d=await createComp("revision route");
  const tools=vfxTools(async(method,url,body)=>(await call(body,url,method)).body,x=>x);
  const rename=await call({action:"rename",slug:d.slug,name:"human edit",expectedRevision:d.updatedAt});assert.equal(rename.status,200);
  const stale=await call({action:"rename",slug:d.slug,name:"stale edit",expectedRevision:d.updatedAt});assert.equal(stale.status,409);assert.equal(stale.body.code,"comp_conflict");assert.equal(stale.body.comp.name,"human edit");
  const tool=tools.find(t=>t.name==="vfx_set_comp");
  await assert.rejects(tool.run({slug:d.slug,expected_revision:d.updatedAt,duration:3}),{code:"comp_conflict"});
  const result=await tool.run({slug:d.slug,expected_revision:rename.body.comp.updatedAt,duration:3});assert.equal(typeof result.revision,"number");assert.equal((await readComp(d.slug)).duration,3);
});
test("only completed output reaches clips; failure/cancel remain hidden; explicit retry works",async()=>{
  const d=await createComp("render route",{duration:1,fps:2});await updateComp(d.slug,x=>{x.layers=[blankLayer(x,"solid")];});
  const a=await call({action:"render",slug:d.slug});const b=await call({action:"render",slug:d.slug});
  assert.equal(a.status,200);assert.equal(b.status,200);await until(()=>started===1);
  assert.equal((await readdir(clips)).filter(x=>x.endsWith(".mp4")).length,0);
  await pending.shift()();await until(()=>started===2);
  assert.equal((await readdir(clips)).filter(x=>x.endsWith(".mp4")).length,1);
  await pending.shift()(true);
  await until(async()=>{const r=await call(null,`/api/vfx/comp/${d.slug}`,"GET");return r.body.renders.find(x=>x.id===b.body.jobId)?.finishedAt;});
  assert.equal((await readdir(clips)).filter(x=>x.endsWith(".mp4")).length,1);
  const retry=await call({action:"render_retry",jobId:b.body.jobId});assert.equal(retry.status,200);assert.notEqual(retry.body.jobId,b.body.jobId);
  await until(()=>started===3);const cancel=await call({action:"render_cancel",jobId:retry.body.jobId});assert.equal(cancel.body.cancelled,true);
  await until(async()=>{const r=await call(null,`/api/vfx/comp/${d.slug}`,"GET");return r.body.renders.find(x=>x.id===retry.body.jobId)?.status==="cancelled";});
  assert.equal((await readdir(clips)).filter(x=>x.endsWith(".mp4")).length,1);
  await until(async()=>(await readdir(clips)).filter(x=>x.startsWith(".vfx-render-")).length===0);
});
test("nested analysis targets are revision guarded for REST and MCP, including edits during CPU work",async()=>{
  await writeFile(path.join(clips,"analysis.wav"),"synthetic fixture, never decoded");
  await writeFile(path.join(clips,"analysis.mp4"),"synthetic fixture, never decoded");
  const tools=vfxTools(async(method,url,body)=>(await call(body,url,method)).body,x=>x);
  for(const action of ["audio_keys","track_motion"]){
    const d=await createComp(`nested ${action}`,{duration:2});
    const doc=await updateComp(d.slug,x=>{x.layers=[blankLayer(x,"solid")];});
    const input=action==="audio_keys"?{audio:"analysis.wav"}:{clip:"analysis.mp4",rect:[0,0,4,4]};
    const apply={slug:d.slug,layerId:doc.layers[0].id,path:action==="audio_keys"?"transform.opacity":"transform.position"};
    const count=analysisStarted;
    const stale=await call({action,...input,apply,expectedRevision:d.updatedAt});
    assert.equal(stale.status,409);assert.equal(analysisStarted,count);
    const mismatch=await call({action,...input,slug:"different-comp",apply,expectedRevision:doc.updatedAt});
    assert.equal(mismatch.status,400);assert.match(mismatch.body.error,/same composition/);assert.equal(analysisStarted,count);
    const tool=tools.find(t=>t.name===(action==="audio_keys"?"vfx_audio_keys":"vfx_track_motion"));
    assert.ok(tool.inputSchema.properties.expected_revision);
    await assert.rejects(tool.run({...input,apply,expected_revision:d.updatedAt}),{code:"comp_conflict"});
    await assert.rejects(tool.run({...input,slug:"different-comp",apply,expected_revision:doc.updatedAt}),/same composition/);
    assert.equal(analysisStarted,count);
    // The editor remains writable during analysis; the post-analysis CAS must
    // reject instead of overwriting that new human edit.
    const running=call({action,...input,apply,expectedRevision:doc.updatedAt});
    await until(()=>analyses.length>0);
    const human=await updateComp(d.slug,x=>{x.name="edited during analysis";});
    analyses.shift()();const conflict=await running;assert.equal(conflict.status,409);
    assert.equal((await readComp(d.slug)).name,"edited during analysis");
    // A current nested MCP edit succeeds and returns the target's new revision.
    const success=tool.run({...input,apply,expected_revision:human.updatedAt});
    await until(()=>analyses.length>0);analyses.shift()();
    const result=await success;assert.equal(typeof result.revision,"number");
    const saved=await readComp(d.slug);assert.equal(result.revision,saved.updatedAt);
    const prop=action==="audio_keys"?saved.layers[0].transform.opacity:saved.layers[0].transform.position;
    assert.equal(prop.keys.length,2);
  }
});
