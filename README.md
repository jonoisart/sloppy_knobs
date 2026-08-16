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
| `npm run build:pages` | production build at the GitHub Pages base path, then checks it |
| `npm run e2e:built` | drives the *built* app (needs `vite preview` — see below) |
| `npm run icons` | regenerates the PWA icons from the SVG |

Nothing you load leaves the device. Samples and the current patch are kept in
IndexedDB, so a reload picks up where you left off, and the whole thing deploys
as a static site.

## On your phone

Open the deployed URL in Safari or Chrome, then **Share → Add to Home Screen**.
It installs as a standalone app — no browser chrome — and works offline, since
everything it needs is cached and everything it stores is already local.

Three platform rules shape how it behaves on a phone, all handled in
`src/audio/session.ts`:

- **The silent switch.** iOS treats web audio as "ambient" by default, which
  means the physical ring/silent switch mutes it. The app claims a `playback`
  audio session so that no longer applies. Your volume buttons still do.
- **Interruptions.** A call, a notification or locking the phone suspends the
  audio context, and the browser will not resume it. The app resumes on its own
  when you come back.
- **Sleep.** The screen is kept awake while the transport is running, and
  released when you stop.

The microphone needs HTTPS, which any of the deploy targets below provide. It
will not work over plain `http://` from another machine on your network.

## Deploying

Set up once:

1. Merge to `main` — the workflow deploys from there.
2. **Settings → General → Change visibility → Public.** GitHub Pages only
   serves private repos on a paid plan.
3. **Settings → Pages → Source: GitHub Actions.**

After that every push to `main` runs lint, tests and a build, and republishes.
The site lands at `https://<user>.github.io/sloppy_knobs/`.

The base path is the one thing that differs between local and Pages, so it
comes from `VITE_BASE` (`vite.config.ts`) and the workflow sets it from the
repo name. `npm run check:dist` fails the build if anything in the output would
404 under that path — including the worklets, which are fetched at runtime and
so cannot be caught by the bundler. That failure mode is a page that loads fine
and makes no sound, which is worth a CI check.

To test the deployable artifact exactly as it will be served:

```sh
npm run build:pages
VITE_BASE=/sloppy_knobs/ npx vite preview --port 4173
E2E_URL=http://localhost:4173/sloppy_knobs/ npm run e2e:built
```

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

`npm run e2e` drives the app in Chromium with a fake audio device and asserts on
audio that actually came out — that the worklets load, a file decodes and draws,
the graph produces a non-silent master signal that stays finite, a knob rewrites
the source without disturbing the rest of it, editing the source moves the knob,
and the exported WAV is a valid, audible file.

`npm run e2e:built` runs the same suite against a production build served from
its real base path, and adds the deployment-specific checks: the manifest
installs as a standalone app, the service worker activates, and after the
network is cut the app still loads *and* can still reach its worklets.

Not covered by any of it: the iOS silent switch and the home-screen icon.
Emulated Chromium cannot reproduce either, so those need a real phone.
