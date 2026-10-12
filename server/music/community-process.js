import {spawn} from 'node:child_process';
import {killMeshProcessTree} from '../mesh/runner.js';

// A bounded log and child-close barrier apply to every optional native tool.
export function runTool(cli, args, {signal, onLine=()=>{}, env=process.env, timeoutMs=3600000}={}) {
  return new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    let log='', failure;
    const child=spawn(cli,args,{windowsHide:true,env,stdio:['ignore','pipe','pipe']});
    const stop=()=>{ failure=signal?.reason || new Error('Stopped'); killMeshProcessTree(child.pid).catch(()=>{}); };
    const timer=setTimeout(()=>{failure=new Error('The tool exceeded its time limit'); killMeshProcessTree(child.pid).catch(()=>{});},timeoutMs);
    signal?.addEventListener('abort',stop,{once:true});
    child.on('error',e=>{failure=e});
    const emit=line=>{try{onLine(line);}catch(error){failure=error;killMeshProcessTree(child.pid).catch(()=>{});}};
    const collector=()=>{let pending='';return {flush:()=>{if(pending)emit(pending);},collect:chunk=>{
      const text=chunk.toString(); log=(log+text).slice(-32768); pending+=text;
      const lines=pending.split(/\r?\n|\r/); pending=lines.pop().slice(-32768);
      for(const line of lines) emit(line);
    }};};
    const stdout=collector(),stderr=collector();
    child.stdout.on('data',stdout.collect); child.stderr.on('data',stderr.collect);
    child.on('close',code=>{
      clearTimeout(timer); signal?.removeEventListener('abort',stop);
      stdout.flush();stderr.flush();
      if(failure) reject(failure);
      else if(code!==0) reject(new Error(`Tool exited (${code}): ${log.slice(-3000) || 'Check its runtime dependencies.'}`));
      else resolve({log});
    });
  });
}
