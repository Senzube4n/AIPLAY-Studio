# My pages

Open **More tools → My pages** to build a small tool inside Studio, such as a
metronome, song equalizer, picture gallery or waveform viewer.

1. Press **New page** and choose a model. Connected cloud providers and local
   Studio models appear in the menu; **Another model or API key** also connects
   an OpenAI-compatible server such as LM Studio or Ollama.
2. Describe the tool and press **Build**. Cloud providers use your own key and
   tokens. A local Studio model needs the engine to be idle. The model menu
   warns when a small local model may make more mistakes.
3. Try the page, then describe changes. Every successful build and manual code
   save creates a version; choose an older version to go back. Studio can make
   one automatic repair when a newly built page reports an error while opening.
4. Use **Export** to save a page file, or **Import** to open one someone shared.
   The export dialog asks you to confirm that you have the right to share the
   code under Apache-2.0.

The microphone button records a request for up to two minutes. Studio's local
Whisper setup transcribes it and adds the words to the request box for you to
review. It does not press Build or send a Chat message automatically.

Pages and their versions are stored in Studio's app-data folder under
`pages/<id>/`. Each page can also keep up to 1 MB of its own JSON data. Export
contains the page code, not your song library, picture library or API keys.

Pages run in an isolated frame. They can ask the Studio bridge for song and
picture metadata and media bytes, and for their own saved data. They cannot
call other Studio APIs, access API keys or load external scripts. Use inline
JavaScript and CSS; external libraries and module imports are unavailable.
Scripts run after the page markup is parsed. Parser-time `document.write`
and scripts inserted dynamically are unsupported; ordinary event listeners,
inline handlers, canvas and Web Audio work.
Cloud generation sends the current page code, your request and reported page
errors to the provider you select. Using a local model keeps that generation
on your computer.

For page code, `studio.songs()` and `studio.images()` list media;
`studio.audio(file)` and `studio.image(name)` provide blob URLs that work with
Web Audio and canvas. `studio.audioData(file)` returns audio bytes.
`studio.get(key)` and `studio.set(key, value)` read and write only this page's
saved data. These calls return promises; show errors in the page when they fail.
