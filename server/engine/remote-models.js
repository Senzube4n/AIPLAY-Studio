/** Remote inventories come only from this worker's loader schemas. */
import { inputChoices } from './remote-common.js';
const names = (info, node, input) => inputChoices(info?.[node]?.input?.required?.[input]) || [];
export function remoteAceShelf(info, selectedLm) {
  const dits = names(info, 'UNETLoader', 'unet_name').filter(n => /^acestep[_-]?v?1\.?5.*\.(safetensors|sft)$/i.test(n.split('/').pop()));
  const encoders = names(info, 'DualCLIPLoader', 'clip_name2');
  const vae = names(info, 'VAELoader', 'vae_name').includes('ace_1.5_vae.safetensors');
  const enc = names(info, 'DualCLIPLoader', 'clip_name1').includes('qwen_0.6b_ace15.safetensors');
  const lms = ['qwen_4b_ace15.safetensors', 'qwen_1.7b_ace15.safetensors'].filter(n => encoders.includes(n));
  const lm = lms.includes(selectedLm) ? selectedLm : lms[0] || null;
  const missing = [!vae && 'ACE VAE', !enc && 'lyric encoder', !lm && 'planner'].filter(Boolean);
  return { dits, vae, enc, lms, lm, ready: vae && enc && !!lm, missing: missing.length ? `RunPod needs ${missing.join(', ')}` : null };
}
export function remoteYueCheckpoints(info) {
  return names(info, 'CheckpointLoaderSimple', 'ckpt_name').filter(n => /yue2?/i.test(n) && /\.(safetensors|sft)$/i.test(n));
}
