"""One-off: derive 256px thumbnails from covers drawn before the thumb branch
existed. New covers get theirs from the graph itself (ImageScale), so this is
only ever needed for the backlog."""
import os, sys
from PIL import Image
d = sys.argv[1] if len(sys.argv) > 1 else r"D:\AI\aiplay-studio-bench\ComfyUI\output\covers"
size = 256
made = skipped = 0
for n in sorted(os.listdir(d)):
    if not n.endswith(".png") or n.endswith("_t.png"):
        continue
    thumb = n[:-4] + "_t.png"
    if os.path.exists(os.path.join(d, thumb)):
        skipped += 1
        continue
    im = Image.open(os.path.join(d, n)).convert("RGB")
    im = im.resize((size, size), Image.LANCZOS)
    im.save(os.path.join(d, thumb), "PNG", optimize=True)
    made += 1
print(f"made {made}, already had {skipped}")
tot = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d) if f.endswith("_t.png"))
full = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d) if f.endswith(".png") and not f.endswith("_t.png"))
print(f"thumbs {tot/1e6:.1f} MB vs full {full/1e6:.1f} MB  ({tot/full*100:.1f}%)")
