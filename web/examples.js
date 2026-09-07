/**
 * Starter examples.
 *
 * The single biggest quality lever on this model is not a slider, it is the
 * shape of the caption. MiniMax documents a three-part "Structured Caption" —
 * Global Metadata, Vocal Details, Arrangement — and captions written that way
 * outperform a comma-separated tag list by a wide margin. Nobody discovers that
 * from an empty textarea, so the examples teach it by being loadable.
 *
 * These are written for AIPLAY Studio rather than copied from MiniMax's demo
 * page: that page carries no licence or reuse statement, and the transferable
 * part is the STRUCTURE, not the prose. A link out to their demos sits next to
 * the picker for anyone who wants to hear the reference renders.
 *
 * Lyrics are a FULL STRUCTURE — two verses, two choruses, a bridge, an outro —
 * because song length follows lyric length far more than it follows the duration
 * slider, and the short versions these used to carry rendered as sketches: 80
 * seconds for Mirror, 38 for Stay On. A 38-second track is a loop, not a song,
 * and it is the first thing a new user hears.
 *
 * ⚠ There is a real ceiling on the other side of this. A genuinely long lyric
 * renders for a genuinely long time, and the AR stage is roughly 40% of it — so
 * the trade here is deliberate rather than "more is better". Two to three
 * minutes is the target.
 *
 * The instrumental examples are not affected: they have no lyrics to lengthen,
 * and the only lever there is a caption that describes a longer arc.
 */
export const EXAMPLES = [
  {
    id: "soulrock",
    label: "Pop rock / soul — “Mirror”",
    genre: "Pop Rock / Soul",
    title: "Mirror",
    caption:
      "Global Metadata. BPM is 88. Key is Bb, scale is major. Pop rock crossed with " +
      "classic soul. Emotional progression: opens reflective and intimate, close and " +
      "small; widens into a supportive mid-tempo rock lift as the perspective turns " +
      "outward; a nostalgic dip in the bridge before a final empowering chorus, ending " +
      "warm and lingering. Scenario: a coming-of-age film montage, late-afternoon " +
      "kitchen light. Production: intimate soundstage that opens into a wide stereo " +
      "field on the choruses, analog-leaning low-mid warmth, high-end clarity that " +
      "keeps the vocal breath-close. " +
      "Vocal Details. Female, seasoned warm alto with a soft empathetic rasp, velvety " +
      "and organic. Conversational and back-phrased in the verses, locking to the grid " +
      "in the choruses. Soft vocal fry on low entries, falsetto flips on the reaching " +
      "phrases. Three-part soul harmonies from the second chorus, wide stereo spread, " +
      "creamy ooh textures. Tight room reverb in the verses moving to a shimmering " +
      "hall in the big sections. " +
      "Arrangement. Primary: clean fingerpicked electric guitar with a glassy chorus- " +
      "modulated tone; melodic fretless bass underneath. Secondary: vintage Rhodes " +
      "from the first pre-chorus; overdriven rhythm guitar for chorus grit; " +
      "glockenspiel shimmer and a countermelodic cello in the bridge. Groove: " +
      "ghost-note snare and laid-back soul pocket, expanding to a driving rock " +
      "backbeat with eighth-note hats. Shaker and tambourine thicken the second half.",
    lyrics:
      "[Verse]\nYour face is still in the hallway light\nYou packed the rest and left it there\n" +
      "The kettle's on, the radio's low\nAnd nobody's coming down the stair\n\n" +
      "[Pre-Chorus]\nYou look in the mirror\nYou don't like what you see\n\n" +
      "[Chorus]\nYou can't leave home without it\nYou're beautiful, I'm telling you\n" +
      "But you don't believe me anyway\n\n" +
      "[Verse 2]\nYou learned to make yourself small in rooms\nWhere nobody asked you to\n" +
      "You carry it out to the car each day\nAnd carry it home with you\n\n" +
      "[Pre-Chorus]\nYou look in the mirror\nAnd you're already gone\n\n" +
      "[Chorus]\nYou can't leave home without it\nYou're beautiful, I'm telling you\n" +
      "But you don't believe me anyway\n\n" +
      "[Bridge]\nIn that way you're just like me\nWhen I was so much younger\n" +
      "Nobody told me either\nSo I'm telling you now\n\n" +
      "[Chorus]\nWe are all beautiful on the inside\nThat essence needs to be seen\n" +
      "You can't leave home without it\nSo take it with you when you go\n\n" +
      "[Outro]\nTake it with you when you go\nTake it with you",
  },
  {
    id: "liquiddnb",
    label: "Liquid drum & bass — “Stay On”",
    genre: "Liquid DnB / Afro house",
    title: "Stay On",
    caption:
      "Global Metadata. BPM is 174. Key is F, scale is minor. Liquid drum and bass " +
      "crossed with afro house. Emotional progression: relentless and collective from " +
      "the first bar, never fully breaking down, building by accumulation rather than " +
      "by contrast. Scenario: a packed room at 2am, hands up, no pause. Production: " +
      "tape saturation on the bus, wide but centred low end, driving and forward. " +
      "Vocal Details. Male, shouted chant landing on every beat, dry and close with " +
      "minimal reverb so it reads as a crowd rather than a soloist. Layered group " +
      "vocals grow across the track, doubled an octave up in the last third. " +
      "Arrangement. Primary: rolling two-step break with ghost snares; deep detuned " +
      "Reese sub; melodic log-drum bassline running continuously. Secondary: swung " +
      "shaker and conga under a straight kick and snare; balafon counter-line; warm " +
      "supersaw lead doubled by balafon. No crashes and no full breakdown — the " +
      "arrangement is continuous by design.",
    lyrics:
      "[Intro]\n(spoken)\nNobody's first\nThen somebody is\n\n" +
      "[Verse]\nBeen at the bank two days\nWater's high and moving\n" +
      "Everybody's counting\nNobody's going\n\n" +
      "[Chorus]\nSTAY ON\nSTAY ON\nNOBODY WENT FIRST\n\n" +
      "[Verse 2]\nSomebody drops a shoulder in\nAnd the whole bank follows\n" +
      "It was never about the water\nIt was about the waiting\n\n" +
      "[Chorus]\nSTAY ON\nSTAY ON\nNOBODY WENT FIRST\n\n" +
      "[Bridge]\nHold it, hold it\nDon't look down at your feet\n" +
      "Hold it, hold it\nThe far side comes to meet you\n\n" +
      "[Chorus]\nSTAY ON\nSTAY ON\nSOMEBODY WENT FIRST\n\n" +
      "[Outro]\n(spoken)\nSame river next year\nSame again",
  },
  {
    id: "orchestral",
    label: "Orchestral — instrumental",
    genre: "Orchestral / cinematic",
    instrumental: true,
    structure: "orchestral",
    sections: 10,
    title: "The Long Field",
    caption:
      "Global Metadata. BPM is 72. Key is D, scale is minor. Late-romantic orchestral " +
      "score, no vocals anywhere. Emotional progression: a single questioning phrase " +
      "that is answered, doubted, and finally affirmed by the full orchestra before " +
      "receding. Scenario: a wide aerial shot over farmland at first light. " +
      "Production: real hall ambience, natural depth staging with strings forward and " +
      "brass set back, no compression on the tutti so the dynamic range survives. " +
      "Arrangement. Primary: divisi strings carry the theme; solo cor anglais states " +
      "it first. Secondary: low brass counter-theme; solo violin in the development; " +
      "timpani and cymbal roll under the climax; harp arpeggios through transitions. " +
      "Groove: rubato and unmetred at the opening, settling into a slow three, " +
      "broadening for the final statement. Textures: sul tasto strings in the quiet " +
      "passages, full bow pressure at the climax.",
  },
  {
    id: "lofi",
    label: "Lo-fi beats — instrumental",
    genre: "Lo-fi / instrumental",
    instrumental: true,
    structure: "lofi",
    sections: 7,
    title: "Second Coffee",
    caption:
      "Global Metadata. BPM is 82. Key is Eb, scale is major with borrowed minor " +
      "sevenths. Lo-fi hip hop, instrumental. Emotional progression: unhurried " +
      "throughout, one small lift halfway and a gentle settle at the end. Scenario: " +
      "rain on a window, an afternoon that is not going anywhere. Production: " +
      "deliberate vinyl crackle and surface noise, low-pass filtered highs, gentle " +
      "wow and flutter, mono-leaning bass. " +
      "Arrangement. Primary: dusty Rhodes chords with a soft attack; upright bass " +
      "sampled and slightly detuned. Secondary: brushed drum loop with a lazy swung " +
      "hat and a snare behind the beat; muted trumpet fragment as an occasional " +
      "motif; tape hiss as a constant bed. Groove: heavily swung, drums drop out " +
      "entirely for one section, then return with an added shaker.",
  },
  {
    id: "country",
    label: "Country — “Needle North”",
    genre: "Country",
    title: "Needle North",
    caption:
      "Global Metadata. BPM is 96. Key is G, scale is major. Modern country with " +
      "outlaw leanings. Emotional progression: weary and plainspoken in the verses, " +
      "opening into resolve on each chorus, one quiet confessional bridge. Scenario: " +
      "a long drive with the radio low. Production: dry and forward, minimal reverb, " +
      "acoustic instruments recorded close with real room bleed. " +
      "Vocal Details. Male, warm baritone with a slight break at the top of the " +
      "range, plainspoken and unornamented. Sparse two-part harmony on the chorus " +
      "line only, a fifth above. Short plate reverb, no doubling. " +
      "Arrangement. Primary: strummed acoustic guitar; pedal steel answering the " +
      "vocal phrase-ends. Secondary: telecaster fills with light spring reverb; " +
      "upright bass; fiddle entering only in the final chorus. Groove: brushed " +
      "train-beat snare, kick on one and three, tambourine from the second chorus.",
    lyrics:
      "[Verse]\nSodium light on the ring road again\nSame four exits, same wrong turn\n\n" +
      "[Chorus]\nThe needle's pointing north\nAnd I'm not arguing tonight\n\n" +
      "[Verse]\nCoffee gone cold in the cup holder\nRadio talking to nobody\n\n" +
      "[Bridge]\nI told you I'd call when I got there\nI never said when\n\n" +
      "[Chorus]\nThe needle's pointing north\nAnd I'm not arguing tonight",
  },
  {
    id: "bossa",
    label: "Bossa nova — “Behind Glass”",
    genre: "Bossa nova",
    title: "Behind Glass",
    caption:
      "Global Metadata. BPM is 128 felt in half time. Key is A, scale is minor with " +
      "major-seventh colouring. Bossa nova with a light jazz-pop finish. Emotional " +
      "progression: poised and restrained throughout, warmth increasing gradually, " +
      "never resolving to anything triumphant. Scenario: a hotel bar with the door " +
      "open to the street. Production: close, dry, and small; almost no reverb; " +
      "instruments panned as though on a real stage. " +
      "Vocal Details. Female, breathy mezzo, very close to the microphone, almost " +
      "spoken at the ends of phrases. No belting anywhere. Slight lag behind the beat. " +
      "One unison double on the final chorus, no stacked harmony. " +
      "Arrangement. Primary: nylon-string guitar playing the bossa pattern " +
      "throughout; upright bass on roots and fifths. Secondary: brushes on a snare " +
      "with the hi-hat pedal on two and four; Rhodes comping sparse chords; a single " +
      "flute line in the middle section. Groove: steady and unvarying — the interest " +
      "is harmonic, not rhythmic.",
    lyrics:
      "[Verse]\nYou order for us both again\nI let you, I always do\n\n" +
      "[Chorus]\nBehind glass, the evening moves\nWithout asking either of us\n\n" +
      "[Verse]\nThe ice goes down before the drink does\nSomeone laughs two tables over\n\n" +
      "[Outro]\nBehind glass\nStill behind glass",
  },
  {
    id: "synthwave",
    label: "Dark synthwave — instrumental",
    genre: "Synthwave / electronic",
    instrumental: true,
    structure: "electronic",
    sections: 9,
    title: "Night Terminal",
    caption:
      "Global Metadata. BPM is 110. Key is C, scale is minor. Dark synthwave, " +
      "instrumental, no vocals. Emotional progression: cold and mechanical at the " +
      "start, warming slightly through the middle, ending unresolved. Scenario: an " +
      "empty airport concourse after the last flight. Production: heavy analog " +
      "saturation, gated reverb on the snare, wide chorused pads, deliberate " +
      "eighties mix balance with the drums loud and the bass narrow. " +
      "Arrangement. Primary: detuned sawtooth bass arpeggio running sixteenths; " +
      "wide analog pad underneath. Secondary: FM bell motif in the upper register; " +
      "a single distorted lead in the last third; noise sweeps into each section. " +
      "Groove: LinnDrum-style kit, heavy gated snare on two and four, no fills " +
      "except at section boundaries.",
  },
  {
    id: "rnb",
    label: "R&B — “Relation”",
    genre: "R&B",
    title: "Relation",
    caption:
      "Global Metadata. BPM is 74. Key is Db, scale is major. Contemporary R&B with " +
      "neo-soul harmony. Emotional progression: guarded and quiet at the opening, " +
      "increasingly direct, one moment of real vulnerability in the bridge, then a " +
      "restrained close rather than a big finish. Scenario: a conversation that has " +
      "been postponed twice. Production: deep sub-bass, crisp transient detail on the " +
      "drums, vocal very close with visible breath, wide but uncluttered. " +
      "Vocal Details. Female, light soprano with controlled runs used sparingly. " +
      "Melismatic only at phrase-ends. Whispered ad-libs low in the mix. Stacked " +
      "five-part harmony on the hook, tight and jazz-voiced with ninths and " +
      "elevenths. Short slap delay, no obvious pitch correction. " +
      "Arrangement. Primary: electric piano with lush extended chords; sub bass " +
      "following the kick. Secondary: muted guitar skank on offbeats; string pad in " +
      "the bridge; finger snaps instead of a clap. Groove: laid-back with the snare " +
      "noticeably behind the grid, sparse kick, hi-hat rolls as the only busy element.",
    lyrics:
      "[Verse]\nYou text me like it's nothing\nI answer like it's nothing too\n\n" +
      "[Pre-Chorus]\nBut nothing takes this long to type\n\n" +
      "[Chorus]\nWhat are we, then\nIf we're not saying it\n\n" +
      "[Bridge]\nI'd rather hear it badly\nThan keep guessing well\n\n" +
      "[Chorus]\nWhat are we, then\nIf we're not saying it",
  },
];
