import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deployStudioNodes, MARKER, STUDIO_NODES_DIR} from './comfy_nodes.js';

const pack='aiplay_h3_control';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aiplay-h3-deploy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('fresh engines receive control nodes, licence and source manifest without optional cache',t=>{
 const dir=fixture(t), first=deployStudioNodes(dir),dest=path.join(dir,pack);
 const names=fs.readdirSync(path.join(STUDIO_NODES_DIR,pack)).filter(n=>!n.startsWith('__pycache__'));
 for(const name of names)assert.ok(fs.readFileSync(path.join(dest,name)).equals(fs.readFileSync(path.join(STUDIO_NODES_DIR,pack,name))),name);
 const marker=JSON.parse(fs.readFileSync(path.join(dest,MARKER),'utf8'));
 for(const name of ['LICENSE','NOTICE','SOURCES.json','__init__.py','nodes.py'])assert.ok(marker.files[name],name);
 assert.ok(first.copied.includes(pack+'/nodes.py'));
 assert.equal(fs.existsSync(path.join(dir,'comfyui-minimax-h3-blockcache-T8')),false);
 assert.equal(deployStudioNodes(dir).copied.length,0);
 assert.equal(deployStudioNodes(dir,undefined,{want:{[pack]:false}}).removed.length,0,'bundled nodes have no removal switch');
});
test('local control node patches and foreign installations are preserved as a whole',t=>{
 const dir=fixture(t);deployStudioNodes(dir);const dest=path.join(dir,pack);
 fs.writeFileSync(path.join(dest,'nodes.py'),'# local patch\n');
 fs.unlinkSync(path.join(dest,'depth_mlp.py'));
 const changed=deployStudioNodes(dir);
 assert.ok(changed.foreign.includes(pack));assert.equal(fs.readFileSync(path.join(dest,'nodes.py'),'utf8'),'# local patch\n');
 assert.equal(fs.existsSync(path.join(dest,'depth_mlp.py')),false,'do not partially update a patched package');
 fs.unlinkSync(path.join(dest,MARKER));fs.writeFileSync(path.join(dest,'custom.py'),'# owner\n');
 assert.ok(deployStudioNodes(dir).foreign.includes(pack));
 assert.equal(fs.readFileSync(path.join(dest,'custom.py'),'utf8'),'# owner\n');
});
