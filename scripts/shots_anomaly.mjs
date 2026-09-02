/* Shot prompts for "The Quiet" — the sci-fi short. Treatment in
 * docs/SHORTFILM_ANOMALY.md.
 *
 * WHY THIS IS A DATA FILE AND NOT PROSE. Sixty shots get rendered, reviewed,
 * and some of them re-rolled. A prompt that lives in a chat message cannot be
 * re-run; one that lives here can be diffed, re-rendered with the same seed, and
 * corrected in place. The seeds are fixed for exactly that reason.
 *
 * HOUSE STYLE FOR EVERY PROMPT, applied throughout:
 *  - Camera move is stated FIRST, in plain film language, because the model
 *    weights early tokens more and the move is what makes a shot cut together.
 *  - Lens and light are stated explicitly. "Cinematic" on its own is noise.
 *  - Nothing describes what a character FEELS, only what the camera SEES. A
 *    model cannot render "he is afraid"; it can render a face lit from below,
 *    holding still, not blinking.
 *  - No dialogue anywhere. This film has none, which is also why LTX is the
 *    engine: no lip-sync to serve, and it is 5.5x faster than H3.
 *  - DESCRIBE A FROZEN MOMENT, NOT AN EVENT. Learned from the first full pass,
 *    where nine shots came back wrong in the same way. A prompt that names a
 *    PROCESS renders as the state before it: "a cable parting and the jib
 *    bending" gave a static crane in fog; "pinning markers one after another"
 *    gave a hand resting on a map; "pull back to reveal hundreds of pins" gave
 *    a floor with no map in it at all. The model renders a moment, so pick the
 *    single most telling moment and describe it as already true — "the instant
 *    the cable HAS snapped, the severed end whipping in a loose arc, the jib
 *    already bent down, crew already flat on the deck". Verbs of change are the
 *    tell; if a prompt contains one, rewrite it in the perfect tense.
 *
 *    Note this does NOT mean avoid camera movement. A camera move is a fact
 *    about the lens and it renders fine; it is SUBJECT change over the span of
 *    a clip that does not.
 *
 * THE ALIEN IS NEVER IN FOCUS. Partly tone, mostly honesty: out-of-focus mass at
 * the edge of a light cone is something this pipeline renders convincingly, and
 * a clearly-shown creature is not. Shots 50 and 54 are written to obey that.
 */

export const LOOK = [
  "cold desaturated blue-grey palette, sodium-vapour practicals",
  "heavy atmosphere, condensation on steel, sonar-green screen glow",
  "anamorphic, shallow depth of field, fine 35mm grain",
  "no text, no subtitles, no watermark",
].join(", ");

export const NEGATIVE = [
  "cartoon, anime, illustration, video game, CGI render, plastic skin",
  "text, subtitles, watermark, logo, timestamp",
  "warm orange teal grade, lens flare, oversaturated",
  "clearly visible monster, rubber creature suit, tentacle close-up",
].join(", ");

/* The marker's own description, reused verbatim wherever it appears, because
 * consistency across shots is what makes an object read as ONE object. The
 * script is described in words rather than modelled — three attempts to build
 * the depressions as geometry are documented in the Blender toolkit, and a
 * reference image supplies silhouette and proportion far better than detail. */
export const MARKER =
  "an enormous nine-sided flat-topped stone mass sixty metres across, "
  + "faceted like a cut gem but battered and mineral-crusted, half-buried in "
  + "seabed sediment, one perfectly straight machined seam running its full "
  + "width, a grid of shallow geometric depressions across its upper face like "
  + "a script worn almost smooth";

export const SHOTS = [
  // ── I. THE SOUND ────────────────────────────────────────────────────────
  { id: 1,  t: "I", p: "Slow push in on an oscilloscope screen in a dark room, green trace on black, a single repeating spike crawling across the phosphor, 1997 analogue equipment, macro lens, the only light source in frame" },
  { id: 2,  t: "I", p: "Static close-up of reel-to-reel tape spooling, dust turning in a sodium desk lamp beam, worn metal, shallow focus on the tape head" },
  { id: 3,  t: "I", p: "Slow pan across hands adjusting a rack-mounted audio filter, headphones hanging on a hook, cigarette smoke drifting through lamplight, 1990s laboratory equipment" },
  { id: 4,  t: "I", p: "Wide static exterior at night, a low concrete listening station in pine forest, one window lit yellow, snow on the ground, no people" },
  { id: 5,  t: "I", p: "Macro static shot of a paper chart recorder, a stylus scratching an identical waveform over and over onto rolling graph paper" },
  { id: 6,  t: "I", p: "Slow push in on a technician's face lit from below by a green screen, headphones on, listening, unimpressed, middle-aged, tired eyes" },
  { id: 7,  t: "I", p: "Overhead static insert of a manila folder on a desk stamped UNIDENTIFIED, a date typed beneath, coffee ring on the cardboard" },
  { id: 8,  t: "I", p: "Static close-up of an open metal filing drawer packed edge to edge with hundreds of buff manila folders, one folder half-lifted by a hand, fluorescent light from above, 1990s office" },
  { id: 9,  t: "I", p: "Static macro of a green metal filing cabinet drawer front with a typed paper label in a chrome holder, dust visible in a shaft of light, the drawer very slightly ajar" },
  { id: 10, t: "I", p: "Static wide of an empty listening room at night, all equipment powered on, nobody in the chair, green traces moving on three screens" },

  // ── II. THE LIFT ────────────────────────────────────────────────────────
  { id: 11, t: "II", p: "High aerial descending slowly toward a rust-streaked salvage vessel alone on flat grey water at dawn, no land in any direction, low cloud" },
  { id: 12, t: "II", p: "Slow tracking shot along a working deck, orange crane, A-frame gantry, coiled umbilical cable, crew in orange survival suits moving with purpose" },
  { id: 13, t: "II", p: "Low static shot as a yellow ROV is lowered past a ship's rail, camera dome catching the light, grey sea closing over the lens" },
  { id: 14, t: "II", p: "Descending underwater POV, particulate streaming upward past two hard light cones, deep blue darkening to black, depth gauge overlay" },
  { id: 15, t: "II", p: "Static close-up of a side-scan sonar display, a shape resolving out of seabed noise, too regular to be rock, green on black" },
  { id: 16, t: "II", p: `Slow underwater dolly, ROV lights sweeping across ${MARKER}, only a curved edge and a shadow visible, silt hanging in the beams` },
  { id: 17, t: "II", p: `Wide underwater establishing shot of ${MARKER}, lit by three converging floodlight cones from a tiny ROV, sense of enormous scale, black water beyond` },
  { id: 18, t: "II", p: "Extreme close-up underwater of a perfectly straight machined seam in encrusted stone, running past the edge of the light, sediment drifting" },
  { id: 19, t: "II", p: "Underwater close-up of a robotic arm brushing sediment from a stone surface, revealing shallow geometric depressions arranged like a worn script" },
  { id: 20, t: "II", p: "Static interior of a ship's lab, three faces watching a monitor showing the ROV feed, blue screen light, nobody speaking, coffee going cold" },
  { id: 21, t: "II", p: "Slow push in on a sonar operator's face in headphones, brow tightening at something in the audio, red instrument light" },
  { id: 22, t: "II", p: "Static macro insert of a spectrogram display, a clean repeating pulse pattern scrolling steadily, twenty-two second period, green on black" },
  { id: 23, t: "II", p: "Underwater wide of divers rigging heavy lifting strops around an enormous stone edge, floodlit, silt rolling up around them" },
  { id: 24, t: "II", p: "Static close-up of a winch drum turning under load, steel cable coming up taut and shedding seawater, deck floodlights" },
  { id: 25, t: "II", p: "Wide underwater shot of an enormous stone mass breaking free of the seabed in a slow shrug of sediment, an expanding cloud of silt" },
  { id: 26, t: "II", p: "Low angle from a ship deck, a heavy orange crane at full extension with a steel cable stretched bar-taut down into the sea, the deck visibly tilted, crew in orange bracing against the rail, floodlights, spray" },

  // ── III. THE SILENCE ────────────────────────────────────────────────────
  { id: 27, t: "III", p: "Static macro on a spectrogram display as a repeating pulse stops mid-period and the trace goes flat, green on black" },
  { id: 28, t: "III", p: "Close-up of a sonar operator pulling one headphone off his ear, looking at it, putting it back on, red light" },
  { id: 29, t: "III", p: "Slow dolly across a ship's lab where everyone has stopped moving at once, faces lit by screens, nobody yet knows why" },
  { id: 30, t: "III", p: `Low angle on deck, ${MARKER} clearing the water on a crane, seawater sheeting off it, floodlit against a grey dawn sky, enormous and wrong` },
  { id: 31, t: "III", p: "Slow tilt across a wet stone surface as water sheets away, revealing a grid of shallow geometric depressions arranged unmistakably like writing, raking floodlight" },
  { id: 32, t: "III", p: "Wide static of a grey sky above a ship as every seabird banks away hard and leaves frame in the same direction" },
  { id: 33, t: "III", p: "Static wide underwater of an empty rectangular excavation in the seabed, sediment settling, absolutely nothing else in frame" },
  { id: 34, t: "III", p: "Close-up of hands turning a hydrophone gain dial steadily up, needle climbing, then further, then to the stop" },
  { id: 35, t: "III", p: "Static on a crew member's face in headphones realising he is hearing nothing at all, not quiet, empty, blue screen light" },
  { id: 36, t: "III", p: "Slow push in on a ship captain's face listening to an absence, side-lit, holding very still" },
  { id: 37, t: "III", p: "High aerial pulling back from a salvage vessel on water gone completely glassy and still, no wake, no wind, grey" },
  { id: 38, t: "III", p: "Static macro of a cold blue-green sonar depth display, a horizontal boundary layer across the middle, and one large indistinct mass below that line, monochrome green on black, no orange" },
  { id: 39, t: "III", p: "Close-up of a hand reaching very slowly for a fathometer switch, red light, tension in the fingers" },
  { id: 40, t: "III", p: "Static macro of a fathometer readout where the seabed depth is not where it was, numbers climbing steadily" },

  // ── IV. THE ANSWER ──────────────────────────────────────────────────────
  { id: 41, t: "IV", p: "Low tracking shot of a grey naval destroyer cutting hard through swell at speed, bow wave breaking white, overcast" },
  { id: 42, t: "IV", p: "Slow dolly through a warship combat information centre in red light, faces lit by radar scopes, controlled urgency" },
  { id: 43, t: "IV", p: "Static macro of a sonar display filling with contact returns, three, then eleven, then too many to plot, green on black" },
  { id: 44, t: "IV", p: "Close-up of an operator's hand hesitating above a switch guard, red light, not yet moving" },
  { id: 45, t: "IV", p: "Handheld tracking shot following crew running down a narrow warship passageway, hatches being dogged shut behind them, alarm lighting" },
  { id: 46, t: "IV", p: "Low angle on a naval gun mount training out over an empty grey sea, nothing to aim at, overcast sky" },
  { id: 47, t: "IV", p: "POV through binoculars across a flat empty horizon, no wake, no fin, absolutely nothing, slight handheld drift" },
  { id: 48, t: "IV", p: "Static macro on a sonar plot where dozens of contacts are converging not on the ship but on a single point far behind it" },
  { id: 49, t: "IV", p: "Wide from a ship's rail looking down at seawater visibly doming upward in a slow smooth mound, crew silhouettes at the rail" },
  { id: 50, t: "IV", p: "Underwater wide of an empty excavation lit by failing ROV lights, something enormous and out of focus moving at the very edge of the beam, scale impossible to read, never resolved" },
  { id: 51, t: "IV", p: "Close-up of a ship's compass spinning freely and a depth gauge showing nonsense, brass and glass, shaking slightly" },
  { id: 52, t: "IV", p: "Slow push in on a face in sodium light at the exact moment of understanding, no dialogue, eyes moving first" },
  { id: 53, t: "IV", p: "Low angle on a ship deck at the instant a steel lifting cable has snapped, the severed cable whipping in a loose arc through the air, the crane jib bent down toward the water, crew flat on the deck, floodlights, spray" },
  { id: 54, t: "IV", p: `Wide underwater of ${MARKER} settling back into its excavation precisely, like a lid closing, sediment blooming, lights failing one by one` },

  // ── V. THE MAP ──────────────────────────────────────────────────────────
  { id: 55, t: "V", p: "Static macro on a black spectrogram display as a single pulse spike returns, then the period resumes, green on black" },
  { id: 56, t: "V", p: "Static macro of a sonar display as every contact drops off at once, leaving empty ocean, green on black" },
  { id: 57, t: "V", p: "Overhead static of a paper nautical chart of the Baltic Sea on a wooden desk under a single lamp, brass dividers and a pencil laid across it, one red pin pushed into the paper, warm lamplight on white paper" },
  { id: 58, t: "V", p: "Overhead static of a large paper world map of the oceans on a desk, about twenty red pins already pushed into it across the Pacific and Atlantic, a hand placing one more, single desk lamp, paper texture visible" },
  { id: 59, t: "V", p: "Overhead wide of a large paper world ocean map on a desk completely covered with hundreds of small red pins in a strikingly even grid across every ocean, single desk lamp, dark room, the pins casting tiny shadows" },
  { id: 60, t: "V", p: "Overhead flat-on view filling frame of a paper world ocean map studded with hundreds of red pins spaced in a regular lattice around the continents like a fence, single hard lamp, deep shadows, slow push in" },
];

/* Fixed per-shot seeds. Deterministic from the id so a re-roll of shot 37 does
 * not disturb shot 38, and so this file plus a git hash reproduces the film. */
export const seedFor = (id) => 700000 + id * 7919;

export const build = (shot) => ({
  prompt: `${shot.p}. ${LOOK}`,
  negative: NEGATIVE,
  seed: seedFor(shot.id),
});

export default SHOTS;
