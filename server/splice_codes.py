#!/usr/bin/env python3
"""Concatenate two AR trajectories so a joined track can be extended again.

    splice_codes.py PRIOR.npz NEW.npz KEEP_FRAMES OUT.npz

The joined audio is the first KEEP_FRAMES of the original followed by the whole
extension, so its trajectory has to be the matching splice. Without this, a
second extension would resume from the last section alone and the model would
have forgotten the song it belongs to -- every extension drifting further from
the original.

Frame counts are stored, never assumed: the lead between code rows and emitted
audio frames is 1 or 2 depending on how the sampling loop exited.
"""
import sys

import numpy as np


def main() -> int:
    prior_p, new_p, keep_s, out_p = sys.argv[1:5]
    keep = int(keep_s)

    prior = np.load(prior_p)["codes"]
    new_z = np.load(new_p)
    new = new_z["codes"]

    if keep <= 0 or keep > len(prior):
        keep = len(prior)
    merged = np.concatenate([prior[:keep], new], axis=0)

    np.savez_compressed(
        out_p,
        codes=merged.astype(np.int32),
        # The joined audio emits one frame per row less the same lead the
        # extension reported, so carry that through rather than recomputing it.
        hidden_frames=np.int32(len(merged) - int(new_z.get("lead_rows", 1))),
        lead_rows=np.int32(new_z.get("lead_rows", 1)),
        frames_per_second=np.int32(new_z.get("frames_per_second", 25)),
        schema=np.int32(1),
        spliced_at=np.int32(keep),
    )
    print(f"spliced {keep} + {len(new)} = {len(merged)} rows -> {out_p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
