import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {config} from '../config.js';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

test('BF16 native factors and missing fused slots preserve the intended delta',t=>{
 const cwd=path.dirname(fileURLToPath(import.meta.url));
 const probe=spawnSync(config.python,['-c','import torch,numpy,safetensors'],{windowsHide:true,encoding:'utf8'});
 if(probe.status!==0){t.skip('Optional export Python with torch/numpy/safetensors is not installed.');return;}
 const script=`
import tempfile
from pathlib import Path
import numpy as np
import torch
from safetensors.torch import save_file
from native_adapter_export import convert,factors,fuse
w=np.arange(6,dtype=np.float32).reshape(2,3)
a=np.array([[2.,1.],[1.,3.]],dtype=np.float32)
b=np.array([[1.,2.],[3.,4.]],dtype=np.float32)
up,down=factors({'lokr_w1':w,'lokr_w2_a':a,'lokr_w2_b':b},{'alpha':'4','lokr_dim':'2'})
np.testing.assert_allclose(up@down,np.kron(w,a@b)*2)
up2,down2=fuse([((up,down),4),(None,2)])
np.testing.assert_allclose((up2@down2)[:4],up@down)
assert not np.any((up2@down2)[4:])
with tempfile.TemporaryDirectory() as temp:
 file=Path(temp)/'native.safetensors'
 A=torch.tensor([[1.,2.],[3.,4.]],dtype=torch.bfloat16)
 B=torch.tensor([[2.,1.],[1.,2.],[3.,1.]],dtype=torch.bfloat16)
 save_file({'yue2.blk.0.nar_attn_output.lora_A':A,'yue2.blk.0.nar_attn_output.lora_B':B},str(file),metadata={'alpha':'4'})
 result=convert(str(file),'diffusion_model.model.layers')
 u=result['diffusion_model.model.layers.0.self_attn.o_proj.lora_up.weight']
 d=result['diffusion_model.model.layers.0.self_attn.o_proj.lora_down.weight']
 np.testing.assert_allclose(u@d,(B.float()@A.float()).numpy()*2)
`;
 const result=spawnSync(config.python,['-c',script],{cwd,windowsHide:true,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
