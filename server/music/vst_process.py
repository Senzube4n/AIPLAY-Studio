"""Optional, offline VST3 chain. The original recording is never overwritten."""
import json
import sys
from pathlib import Path

def main():
    from pedalboard import Pedalboard, load_plugin
    from pedalboard.io import AudioFile
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    chain = []
    for slot in job["plugins"]:
        plugin = load_plugin(slot["path"])
        for name, value in slot.get("parameters", {}).items():
            if name not in plugin.parameters:
                raise ValueError("Unknown plugin parameter: " + name)
            setattr(plugin, name, value)
        chain.append(plugin)
    board = Pedalboard(chain)
    with AudioFile(job["input"]) as source:
        with AudioFile(job["output"], "w", source.samplerate, source.num_channels) as target:
            while source.tell() < source.frames:
                audio = source.read(int(source.samplerate * 10))
                target.write(board(audio, source.samplerate, reset=False))
    print(json.dumps({"ok": True, "plugins": len(chain)}))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(1)
