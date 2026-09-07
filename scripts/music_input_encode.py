"""CPU-only optional HOT-Step preparation for Studio's shared music-input route."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time

# This helper never competes with the Studio GPU queue.
os.environ['CUDA_VISIBLE_DEVICES'] = ''
os.environ.setdefault('HF_HUB_OFFLINE', '1')

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--source')
    parser.add_argument('--output')
    parser.add_argument('--start', type=float, default=0)
    parser.add_argument('--seconds', type=float, default=7.5)
    args = parser.parse_args()
    runtime = json.loads(Path(args.runtime).read_text(encoding='utf-8-sig'))
    paths = ('adapter', 'rvq_config', 'rvq_weights', 'dav_weights')
    missing = [key for key in paths if not Path(runtime.get(key, '')).is_file()]
    packages = ('numpy', 'torch', 'soundfile', 'safetensors', 'torchaudio')
    missing += [name for name in packages if importlib.util.find_spec(name) is None]
    if args.probe:
        print(json.dumps({'ok': not missing, 'missing': missing, 'device': 'cpu'}))
        return
    if missing:
        raise ValueError('Missing optional runtime dependencies: ' + ', '.join(missing))
    if not args.source or not args.output:
        raise ValueError('source and output are required')
    if not math.isfinite(args.start) or args.start < 0:
        raise ValueError('start must be finite and nonnegative')
    if not math.isfinite(args.seconds) or not .25 <= args.seconds <= 15:
        raise ValueError('seconds must be between 0.25 and 15')
    import numpy as np
    import soundfile as sf
    import torch
    from safetensors.torch import load_file
    torch.set_num_threads(4)
    torch.manual_seed(0)
    begun = time.perf_counter()
    with sf.SoundFile(args.source) as f:
        if f.channels not in (1, 2) or not 8000 <= f.samplerate <= 192000:
            raise ValueError('Use mono or stereo WAV/FLAC, sampled at 8–192 kHz')
        sr, original_frames = f.samplerate, len(f)
        first = round(args.start * sr)
        if first >= original_frames:
            raise ValueError('Selected start is beyond the source audio')
        f.seek(first)
        wave = f.read(min(round(args.seconds * sr), original_frames-first),
                      dtype='float32', always_2d=True)
    if len(wave) < math.ceil(.25 * sr):
        raise ValueError('The selected source contains less than 0.25 seconds')
    if not np.isfinite(wave).all():
        raise ValueError('Audio contains NaN or infinite samples')
    if not np.any(np.abs(wave) > 1e-8):
        raise ValueError('The selected source is silent')
    if wave.shape[1] == 1:
        wave = np.repeat(wave, 2, axis=1)
    spec = importlib.util.spec_from_file_location('studio_music_reference_adapter', runtime['adapter'])
    adapter_module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = adapter_module
    spec.loader.exec_module(adapter_module)
    cfg = adapter_module.RVQEncoderConfig.from_dict(json.loads(Path(runtime['rvq_config']).read_text()))
    rvq = adapter_module.MiniMaxMusicRVQEncoder(cfg)
    rvq.load_state_dict(load_file(runtime['rvq_weights']), strict=True)
    dav = adapter_module.DAVEncoderOnly()
    state = load_file(runtime['dav_weights'])
    dav.load_state_dict({k: v for k, v in state.items()
                         if k.startswith(('encoder.', 'mean_proj.'))}, strict=True)
    del state
    adapter = adapter_module.MiniMaxMusic3ReferenceAdapter(dav, rvq)
    with torch.inference_mode():
        codes = adapter.predict_codes(torch.from_numpy(wave.T.copy()), sr,
                                      device='cpu', encoder_dtype=torch.float32).cpu().numpy()
    if codes.ndim != 2 or codes.shape[1] != 8 or len(codes) < 1:
        raise ValueError('Encoder produced an invalid eight-codebook trajectory')
    if not ((codes[:, 0] >= 0).all() and (codes[:, 0] < 16384).all()
            and (codes[:, 1:] >= 0).all() and (codes[:, 1:] < 1024).all()):
        raise ValueError('Encoder produced out-of-range RVQ codes')
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output, codes=codes)
    report = {
        'ok': True, 'device': 'cpu', 'encoder_dtype': 'float32',
        'source_sha256': digest(args.source), 'source_sample_rate': sr,
        'source_total_frames': original_frames, 'selected_start_sample': first,
        'selected_frames': len(wave), 'selected_seconds': len(wave)/sr,
        'frames': len(codes), 'codebooks': 8, 'prefix_seconds': len(codes)/25,
        'output_sha256': digest(output),
        'encoder': runtime.get('encoder_repo', 'unidentified-local-encoder'),
        'revision': runtime.get('encoder_revision'),
        'dependency_sha256': {key: digest(runtime[key]) for key in paths},
        'versions': {'torch': torch.__version__, 'numpy': np.__version__},
        'elapsed_seconds': time.perf_counter()-begun,
        'provenance': 'Approximate RVQ encoding of external audio; not a native Music3 capture; no synthesized priming row',
    }
    output.with_suffix('.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}), flush=True)
        raise SystemExit(1)
