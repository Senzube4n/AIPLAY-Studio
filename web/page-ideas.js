/* What a My pages page could be: cards on the Chat screen (web/chat.js) that
 * open My pages with the idea in the request box (web/pages.js startIdea).
 * A module of its own, with no DOM work, so chat.js can import it anywhere. */
export const PAGE_IDEAS = [
  { t: "An equalizer", s: "Play your songs through sliders and presets.", ask: "An equalizer for my songs, with a few presets and a slider per band." },
  { t: "A picture gallery", s: "Your pictures in a grid, prompts on hover.", ask: "A gallery of my pictures in a grid, with each picture's prompt on hover and a big view on click." },
  { t: "A waveform viewer", s: "See a song and where it is playing.", ask: "A waveform viewer: pick a song, see its waveform, and a line that follows where it is playing." },
  { t: "A metronome", s: "Tap tempo, accents, a big beat light.", ask: "A metronome with tap tempo, an accent on beat one and a big light that flashes on each beat." },
];
