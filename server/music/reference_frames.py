"""Make a bounded, timestamped video contact sheet. No model or network access."""
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageOps


def build(directory, timestamps):
    if not isinstance(timestamps, list) or not 1 <= len(timestamps) <= 6:
        raise ValueError("one to six timestamps required")
    columns = min(3, len(timestamps))
    rows = (len(timestamps) + columns - 1) // columns
    sheet = Image.new("RGB", (384 * columns, 244 * rows), "#171b22")
    draw = ImageDraw.Draw(sheet)
    for i, timestamp in enumerate(timestamps):
        if not isinstance(timestamp, (int, float)) or not 0 <= timestamp <= 86520:
            raise ValueError("invalid timestamp")
        with Image.open(Path(directory) / f"frame_{i}.png") as source:
            thumb = ImageOps.contain(source.convert("RGB"), (384, 216))
            x, y = (i % columns) * 384, (i // columns) * 244
            sheet.paste(thumb, (x + (384 - thumb.width) // 2, y + (216 - thumb.height) // 2))
            draw.text((x + 10, y + 223), f"Frame {i + 1} | source {timestamp:.3f} s", fill="white")
    target = Path(directory) / "contact.jpg"
    sheet.save(target, quality=88)
    return {"ok": True, "width": sheet.width, "height": sheet.height}


if __name__ == "__main__":
    print(json.dumps(build(sys.argv[1], json.loads(sys.argv[2]))))
