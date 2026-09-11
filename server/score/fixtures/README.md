# server/score/fixtures

Two real artifacts out of one real render, kept so the tests assert measured
numbers rather than numbers somebody typed.

| file | what it is |
|---|---|
| `yue2_score.abc` | the score YuE2 wrote, 2,253 bytes, byte-identical to the render's own artifact — its sha256 is `03c1d109…4392db`, which is exactly what `yue2_result.json` states for `score.abc` |
| `yue2_result.json` | that render's receipt, 3,012 bytes, verbatim: the `identity` hash over request + config + weights, the per-file sha256 map for all 10 artifacts, the weight hashes, and the full timing breakdown |

They come from the same folder, so the pair is self-consistent and
`server/score/store.js`'s receipt verification can be tested against a real
receipt rather than a mock of one.

**`yue2_score.abc` carries the defect on purpose.** Its header says `M:4/4` and
its bars carry 2 quarter notes each — the header was hand-edited from `M:2/4`
without re-barring the 122 bars of content. MEASURED consequences, which
`abc_test.js` pins:

| basis | total |
|---|---|
| header-derived | 325.333 s |
| content-derived | 162.667 s |
| the render's real audio (`audio_seconds`) | 167.039 s |

So the header is out by a factor of 1.9476 against the audio and the content is
out by 2.69%. Do not "fix" this fixture — it is the regression test for
`invariants()[0]`, and the vendor's own parser
(`skills/yue2-music/scripts/abc_tools.py:154`) cannot even open it.

**What is deliberately NOT here:** the other 9 artifacts the receipt hashes.
`audio.flac` alone is 33,549,285 bytes. `store_test.js` therefore builds a
complete, self-consistent run folder at test time, and uses this real receipt
for the opposite case — a folder that does not match its own receipt must be
refused by name.
