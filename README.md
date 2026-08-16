# sloppy_knobs

An experimental audio app: drop in voice notes, found sound or anything you
recorded on your phone, then mangle it into something weird and keep the
result.

Underneath it is a small audio coding language called **slop**. The visual rack
is a view over that language rather than a thing beside it — turning a knob
rewrites one number in the patch, and editing the patch moves the knobs.

```
tempo 92

deck vox {
  src grain "voice-note" speed=0.25 grain=180ms dens=30 pitch=-5 spray=0.4
  fx  svf lp cutoff=900 res=0.55 drive=2
  fx  shift st=-12 win=90ms fb=0.35 mix=0.4
  fx  delay time=3/8 fb=0.6 wobble=0.3 mix=0.35
  fx  verb size=0.8 decay=6s mix=0.45
  out gain=0.9 pan=-0.2
}
```

## Running it

```sh
npm install
npm run dev
```

Then open the page and tap **wake up** — browsers refuse to start audio outside
a user gesture, so the app waits for one instead of silently making no sound.

| command | what it does |
| --- | --- |
| `npm run dev` | dev server |
| `npm run build` | typecheck and production build |
| `npm test` | language unit tests |
| `npm run lint` | oxlint |
| `npm run e2e` | drives the real app in Chromium (needs `npm run dev` running) |

Nothing you load leaves the device. Samples and the current patch are kept in
IndexedDB, so a reload picks up where you left off, and the whole thing deploys
as a static site.

## Why not SuperCollider

SuperCollider's engine, `scsynth`, is a native binary. It cannot run in a
browser or on a phone, so building on it would mean a hosted backend and an
upload → render → download round trip for every change — no live knobs, and
everyone's voice memos sitting on someone's server.

So the DSP is written directly as Web Audio `AudioWorklet` processors: real
sample-by-sample code running on the audio thread, client-side, responsive on
mobile. Vendoring an existing browser audio language was the other option —
[Glicol](https://glicol.js.org) (MIT, ~2.2 MB of self-contained wasm) is the
strongest of them — but each one owns its own audio graph, which is exactly
what makes two-way knob↔code binding awkward. Owning the language means owning
the AST, and owning the AST is what makes the knobs work.

## The language

A patch is a tempo and some decks. A deck is one source, any number of effects
in order, and an output.

```
tempo 92                      # bar-relative ratios like 3/8 resolve against this

deck <name> {
  src <source> "<sample>" param=value ...
  fx  <effect> [mode] param=value ...
  out gain=1 pan=0
}
```

Values can carry units — `180ms`, `0.18s`, `6khz`, `-6db`, `70%`, `-12st` — and
are converted to whatever the parameter is declared in. Times also accept bar
ratios: `time=3/8`. Toggles accept `on` and `off`. Comments are `#` or `//`.

**Sources.** `grain` is the interesting one: a cloud of overlapping windowed
grains around a floating playhead. `speed=0` freezes it mid-sound, negative
speeds run it backwards, and pitch is independent of speed, so you can stretch
without chipmunking. `play` is plain playback for a bed underneath.

**Effects.** `crush` `fold` `ring` `svf` `glitch` for destruction; `shift`
`freeze` `delay` `verb` `flange` `trem` for space and motion. `svf` takes a
mode — `lp`, `bp`, `hp`, `notch`.

Every parameter has a declared range, unit and default in one registry
(`src/audio/fx.ts`) that the checker, the compiler and the UI all read, so an
effect is described exactly once.

Anything the checker cannot make sense of is reported with a line, a column and
usually a suggestion — and only that statement is dropped. A typo in one effect
silences that effect, not the whole piece.

## How it fits together

```
source text ──parse──> AST (every node keeps its source span)
                        │
                   check │ diagnostics ──> editor gutter
                        │
                  compile ──> program ──diff──> patch live params
                                             └─> or rebuild the graph
```

The spans are the trick. A knob writes back by splicing one byte range, so
comments, alignment and blank lines survive being twiddled at. And because a
value change only patches AudioParams, sliding a filter does not tear down the
graph and drop every delay and reverb tail in the piece — only a change to the
*shape* of a chain does that.

| | |
| --- | --- |
| `src/lang/` | lexer, parser, checker, compiler, and the source-splicing helpers |
| `src/audio/fx.ts` | the node registry — the single description of every node |
| `src/audio/graph.ts` | builds and patches the live Web Audio graph |
| `src/audio/engine.ts` | context lifecycle, master bus, limiter, recorder tap |
| `public/worklets/` | the DSP itself, as AudioWorklet processors |
| `src/ui/` | knobs bound to source spans, code pane, waveforms, mixer |

## Recording and export

The **record** button in the transport captures the master bus — everything you
hear, including whatever you do to the knobs while it runs — and hands back a
16-bit WAV. The **record** button in the sample panel is the other direction:
it captures from the microphone straight into the library.

## Tests

`npm test` covers the language: unit-vs-identifier disambiguation, keyword
recovery, byte-exact edit round trips, diagnostics landing on the right line,
and the patch-vs-rebuild diff.

`npm run e2e` drives the built app in Chromium with a fake audio device and
asserts on audio that actually came out — that the worklets load, a file
decodes and draws, the graph produces a non-silent master signal that stays
finite, a knob rewrites the source without disturbing the rest of it, editing
the source moves the knob, and the exported WAV is a valid, audible file.
