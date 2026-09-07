"""Narration synthesis - model-agnostic TTS runner.

Usage: python tts.py <job.json>

Job: { "model": "kokoro", "voice": "bm_george", "pauseMs": 650,
       "chunks": [ { "text": "...", "pause": false, "out": "c0000.wav" } ] }

Prints one JSON line: { ok, files: [{file, seconds}], totalSeconds }.

Runs as a SUBPROCESS (the lrc.py/beats.py precedent) so its VRAM/RAM is
returned to the system the moment it exits - the render queues never share an
address space with it. Chunks synthesize sequentially; a chunk marked "pause"
emits silence instead (scene breaks, chapter breathing room).

Models:
  kokoro - Kokoro-82M (Apache-2.0). ~50 named voice personas, 24 kHz.
           Small enough to run alongside nothing and finish fast; the
           storytelling registers that read best in testing are the British
           male 'bm_george' / 'bm_fable' and warm US 'af_heart'.
Add further models as new branches; the caller only ever names (model, voice).
"""
import json
import sys

import numpy as np


def write_wav(path, audio, rate):
    import wave
    x = np.clip(audio, -1.0, 1.0)
    w = wave.open(path, "w")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes((x * 32767.0).astype("<i2").tobytes())
    w.close()


def synth_kokoro(job):
    from kokoro import KPipeline
    default = job.get("voice") or "bm_george"
    # A chunk may carry its own voice (dialogue casting). Pipelines are per
    # LANGUAGE, so cache one per lang code and pick by the chunk's persona.
    pipes = {}

    def pipe_for(voice):
        lang = "b" if voice.startswith(("bf_", "bm_")) else "a"
        if lang not in pipes:
            pipes[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
        return pipes[lang]

    rate = 24000
    pause = np.zeros(int(rate * (job.get("pauseMs", 650) / 1000.0)), dtype=np.float32)

    files = []
    total = 0.0
    for ch in job["chunks"]:
        voice = ch.get("voice") or default
        if ch.get("pause") or not ch["text"].strip():
            audio = pause
        else:
            parts = []
            # KPipeline yields per-sentence segments; keep them in order with a
            # short inter-segment gap so long paragraphs breathe naturally.
            gap = np.zeros(int(rate * 0.22), dtype=np.float32)
            for _, _, seg in pipe_for(voice)(ch["text"], voice=voice, speed=float(ch.get("speed") or 1.0)):
                arr = seg.detach().cpu().numpy() if hasattr(seg, "detach") else np.asarray(seg)
                parts.append(arr.astype(np.float32))
                parts.append(gap)
            audio = np.concatenate(parts) if parts else pause
        write_wav(ch["out"], audio, rate)
        secs = round(len(audio) / rate, 3)
        files.append({"file": ch["out"], "seconds": secs})
        total += secs
    return files, total


def synth_qwen3(job):
    """Qwen3-TTS CustomVoice - preset speakers plus a style instruction.

    The `instruct` line is what buys the STORYTELLING register the narrator
    needs; without it the presets read like an announcer. Runs in the sidecar
    venv (this script is launched with config.tts.python when model=qwen3).
    """
    import torch
    from qwen_tts import Qwen3TTSModel

    voice = job.get("voice") or "Ryan"
    instruct = job.get("instruct") or (
        "Warm, unhurried audiobook narrator. Clear storytelling cadence, "
        "gentle dynamics, natural pauses at sentence ends."
    )
    model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        device_map="cuda:0", dtype=torch.bfloat16,
    )
    files = []
    total = 0.0
    rate = 24000
    pause = None
    for ch in job["chunks"]:
        speaker = ch.get("voice") or voice          # dialogue casting
        if ch.get("pause") or not ch["text"].strip():
            if pause is None:
                pause = np.zeros(int(rate * (job.get("pauseMs", 650) / 1000.0)), dtype=np.float32)
            audio = pause
        else:
            line_instruct = ch.get("instruct") or instruct   # emotion-aware delivery
            wavs, rate = model.generate_custom_voice(
                text=ch["text"], speaker=speaker, language="English", instruct=line_instruct)
            audio = np.asarray(wavs[0], dtype=np.float32)
            if pause is None or len(pause) != int(rate * (job.get("pauseMs", 650) / 1000.0)):
                pause = np.zeros(int(rate * (job.get("pauseMs", 650) / 1000.0)), dtype=np.float32)
            # QA: a chunk that comes back absurdly short or long for its text is
            # a hallucination - retry once, then let the caller's fallback act.
            cps = len(ch["text"]) / max(len(audio) / rate, 0.1)
            if cps < 4 or cps > 40:
                wavs, rate = model.generate_custom_voice(
                    text=ch["text"], speaker=speaker, language="English", instruct=line_instruct)
                audio = np.asarray(wavs[0], dtype=np.float32)
        write_wav(ch["out"], audio, rate)
        secs = round(len(audio) / rate, 3)
        files.append({"file": ch["out"], "seconds": secs})
        total += secs
    return files, total


def main():
    job = json.loads(open(sys.argv[1], encoding="utf-8").read())
    model = job.get("model", "kokoro")
    if model == "kokoro":
        files, total = synth_kokoro(job)
    elif model == "qwen3":
        files, total = synth_qwen3(job)
    else:
        print(json.dumps({"ok": False, "error": f"unknown tts model: {model} (have: kokoro, qwen3)"}))
        return
    print(json.dumps({"ok": True, "files": files, "totalSeconds": round(total, 2)}))


if __name__ == "__main__":
    main()
