# "Measure Twice" — rap track + music video plan

Written 2026-09-02 overnight. The song is the prerequisite: `make_song` renders it,
then the video is cut to its beat grid.

---

## The track

**Why this subject.** A rap song needs a point of view, not a mood. This one has
one that is actually earned tonight: the whole session was about refusing to call
something proven until a number said so — a gate that came back NO RESULT and had
to be rebuilt before it could say anything, a bleed hypothesis that turned out
backwards, an instrument I wrote that hid the signal it was built to find. That is
a real posture and it raps well, because the genre already loves receipts.

**Consonant density is a production constraint, not a style choice.** The video's
whole ask is lip-sync, and a mouth reads on plosives and fricatives — p, b, t, d,
k, f, s. The lyric below is deliberately front-loaded with hard consonants on the
downbeats and avoids long open vowels on stressed syllables, because "ooooh" gives
a lip-sync model almost nothing to hit.

### Caption (the single biggest quality lever)

> **Global Metadata.** 88 BPM, F minor, boom-bap rap with a modern low-end —
> dusty sampled drums under a clean sub. Emotional progression: cold and
> methodical through the verses, opening to something almost triumphant on the
> last chorus, then stripped back to a single filtered loop at the end.
> Production is close and dry, minimal reverb on the vocal, tape saturation on
> the drum bus, sidechained sub.
>
> **Vocal Details.** One male rapper, mid-range, unhurried and conversational —
> confident rather than aggressive, sitting slightly behind the beat. Doubled on
> the last line of each chorus only. No ad-libs crowding the pocket.
>
> **Arrangement.** Primary: dusty break loop, upright bass sub, a two-note
> Rhodes stab. Secondary: vinyl crackle, a distant filtered string swell that
> only appears in the chorus, a hi-hat that drops out entirely under the third
> verse so the vocal is naked. Leave space — the beat should feel like a room
> with the lights off.

### Lyrics

```
[Verse 1]
Woke up to a number that I didn't like,
kept the number, dropped the story, that's the discipline.
Everybody's got a theory and a microphone,
I got a stopwatch and a script that tells me when I'm wrong.
Ran it twice. Ran it cold. Ran it blind.
Same result or it never happened, that's the bottom line.
Talk is cheap and confidence is cheaper still,
I don't trust a thing that never had to pass a drill.

[Chorus]
Measure twice. Cut once. Check the tape.
If it don't hold up in daylight then it don't hold up.
Measure twice. Cut once. Check the tape.
Show me where the number came from — or don't show up.

[Verse 2]
Had a hunch, wrote it down, went and proved it backwards,
turns out the thing I called the cause was actually the cure.
That's the job. That's the whole entire job.
Not being right the first time — being right before you ship.
Built a ruler, ran the ruler, ruler had a flaw,
it was hiding the exact thing I built the ruler for.
Fixed the ruler. Didn't fix the number to be kind.
A tool that flatters you is worse than being blind.

[Chorus]
Measure twice. Cut once. Check the tape.
If it don't hold up in daylight then it don't hold up.
Measure twice. Cut once. Check the tape.
Show me where the number came from — or don't show up.

[Verse 3]
So the answer came back negative and clean,
and a negative that's honest beats a maybe that ain't.
Saved a month of building on a floor that wasn't there,
that's a win, don't let nobody tell you different.
Put it in the ledger. Put the seed in. Put the date.
Somebody's gonna read this back and check my work — good.
Let 'em. I'd rather get corrected than get quoted,
'cause the point was never me, the point was that it's known.

[Chorus - doubled]
Measure twice. Cut once. Check the tape.
If it don't hold up in daylight then it don't hold up.
Measure twice. Cut once. Check the tape.
Show me where the number came from — or don't show up.

[Outro]
Show me where the number came from.
Show me where the number came from.
...or don't show up.
```

---

## Video plan

**Look.** A single performer in a dark room full of instrumentation — oscilloscopes,
chart recorders, a wall of small screens. Cold blue-green key from the screens,
one warm sodium practical behind. Everything in the room is a thing that *measures*.
It should read like a control room that someone moved a microphone into.

**Camera.** This is where the new VFX camera work pays off. The moves the plumbing
just unlocked are exactly the vocabulary this needs:

| section | move | why |
|---|---|---|
| V1 | **offset-follow** — aim at a null beside and behind the subject | the shot that stops feeling robotic; keeps him off-centre while the room slides past |
| Chorus | **orbit**, elliptical, half arc | the room becomes the subject on the hook |
| V2 | **push-in** with focal animating 28→58mm | a real push, compresses the background as it tightens |
| V3 | locked off, **handheld** layer only | the hi-hat drops out; the camera should get nervous, not busy |
| Last chorus | **crane** up into a plan view | the only wide in the film, saved for the payoff |
| Outro | **rack focus** to a single screen | ends on an instrument, not a face |

**Resolution.** Decided by the sweep running now, not guessed. The constraint the
owner named is real: a mid-distance face cannot be recovered by upscaling, so the
native render has to carry it. The sweep measures face pixels and mouth pixels
against render cost and picks the largest size a full-length video can afford.

**Cutting to the beat.** `get_beats` returns the grid; `build_music_video` writes
the project. Cuts land on bar lines, and the crane in the last chorus starts on the
downbeat of the section, not on a shot boundary.

**Reference-bleed caveat.** If any shot is H3 with reference images, its first ~10
frames may be the reference almost verbatim (`docs/H3_REFERENCE_BLEED.md`). Either
trim each clip head by ~12 frames in the edit, or cut into shots late by design.
Worth knowing before 36 clips get rendered, not after.
