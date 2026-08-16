/**
 * Builds the live audio graph from a compiled program, and patches it in place
 * when the source changes.
 *
 * Rebuilding is the expensive path: it drops the tails of every delay and
 * reverb in the piece. So a value change is applied straight to the running
 * AudioParams, and only a change in the *shape* of a chain forces a rebuild.
 */

import type { CompiledDeck, CompiledNode, CompiledProgram, GraphDiff } from '../lang/compile';
import type { NodeSpec, ParamSpec } from './fx';
import type { Engine } from './engine';
import { impulseKey, makeImpulse } from './impulse';

/** How fast a param glides to a new value. Short enough to feel immediate. */
const GLIDE = 0.02;

export interface LiveNode {
  id: string;
  node: string;
  input: AudioNode | null;
  output: AudioNode;
  setParam(name: string, value: number): void;
  setMode?(mode: string): void;
  setSample?(buffer: AudioBuffer | undefined): void;
  dispose(): void;
}

export interface LiveSource extends LiveNode {
  play(): void;
  halt(): void;
  seek(position: number): void;
  scrub(on: boolean): void;
  /** Where the finger is, while scrubbing. Not part of the patch. */
  setScrubPosition(position: number): void;
  onPosition?: (position: number) => void;
}

// ---------------------------------------------------------------- helpers

function setAudioParam(param: AudioParam, value: number, ctx: BaseAudioContext, spec?: ParamSpec) {
  const v = Number.isFinite(value) ? value : 0;
  if (spec?.toggle) {
    param.setValueAtTime(v, ctx.currentTime);
  } else {
    param.setTargetAtTime(v, ctx.currentTime, GLIDE);
  }
}

function specFor(spec: NodeSpec, name: string): ParamSpec | undefined {
  return spec.params.find((p) => p.name === name);
}

/** Copy channel data so transferring it cannot detach the source AudioBuffer. */
function copyChannels(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.push(new Float32Array(buffer.getChannelData(c)));
  }
  return out;
}

function reversedBuffer(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0, j = src.length - 1; i < src.length; i++, j--) dst[i] = src[j];
  }
  return out;
}

// ---------------------------------------------------------------- sources

function buildGrain(ctx: AudioContext, compiled: CompiledNode): LiveSource {
  const node = new AudioWorkletNode(ctx, 'granular-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const live: LiveSource = {
    id: compiled.id,
    node: compiled.node,
    input: null,
    output: node,
    setParam(name, value) {
      const param = node.parameters.get(name);
      if (param) setAudioParam(param, value, ctx, specFor(compiled.spec, name));
    },
    setSample(buffer) {
      if (!buffer) return;
      const channels = copyChannels(buffer);
      node.port.postMessage(
        { type: 'load', channels: channels.map((c) => c.buffer) },
        channels.map((c) => c.buffer),
      );
    },
    play() {
      node.port.postMessage({ type: 'play' });
    },
    halt() {
      node.port.postMessage({ type: 'stop' });
    },
    seek(position) {
      node.port.postMessage({ type: 'seek', position });
    },
    scrub(on) {
      node.port.postMessage({ type: 'scrub', on });
    },
    setScrubPosition(position) {
      // The worklet smooths towards this, so a jumpy touch does not click.
      node.parameters.get('position')?.setValueAtTime(position, ctx.currentTime);
    },
    dispose() {
      node.port.onmessage = null;
      node.port.postMessage({ type: 'stop' });
      node.disconnect();
    },
  };

  node.port.onmessage = (e) => {
    if (e.data?.type === 'pos') live.onPosition?.(e.data.position);
  };

  return live;
}

/**
 * Plain buffer playback. An AudioBufferSourceNode is single-use and cannot run
 * backwards, so this keeps a reversed copy and mints a fresh node per start.
 */
function buildPlay(ctx: AudioContext, compiled: CompiledNode): LiveSource {
  const out = new GainNode(ctx, { gain: compiled.params.gain ?? 1 });
  let buffer: AudioBuffer | undefined;
  let reversed: AudioBuffer | undefined;
  let source: AudioBufferSourceNode | null = null;
  let playing = false;
  let speed = compiled.params.speed ?? 1;
  let loop = (compiled.params.loop ?? 1) >= 0.5;
  let startedAt = 0;
  let offset = 0;
  let raf = 0;

  const live: LiveSource = {
    id: compiled.id,
    node: compiled.node,
    input: null,
    output: out,
    setParam(name, value) {
      if (name === 'gain') {
        setAudioParam(out.gain, value, ctx);
      } else if (name === 'speed') {
        const wasBackwards = speed < 0;
        speed = value;
        // Direction change means a different buffer, so the node is restarted.
        if (source && wasBackwards !== value < 0) restart();
        else if (source) source.playbackRate.setTargetAtTime(Math.abs(value) || 0.0001, ctx.currentTime, GLIDE);
      } else if (name === 'loop') {
        loop = value >= 0.5;
        if (source) source.loop = loop;
      }
    },
    setSample(next) {
      buffer = next;
      reversed = undefined;
      if (playing) restart();
    },
    play() {
      playing = true;
      offset = 0;
      restart();
    },
    halt() {
      playing = false;
      stopSource();
    },
    seek(position) {
      offset = position * (buffer?.duration ?? 0);
      if (playing) restart();
    },
    scrub() {},
    setScrubPosition(position) {
      // No grain cloud to steer, so scrubbing is just a seek.
      live.seek(position);
    },
    dispose() {
      cancelAnimationFrame(raf);
      stopSource();
      out.disconnect();
    },
  };

  function stopSource() {
    if (source) {
      try {
        source.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      source.disconnect();
      source = null;
    }
  }

  function restart() {
    stopSource();
    if (!buffer || !playing) return;
    const backwards = speed < 0;
    if (backwards && !reversed) reversed = reversedBuffer(ctx, buffer);
    const active = backwards ? reversed! : buffer;

    source = new AudioBufferSourceNode(ctx, {
      buffer: active,
      loop,
      playbackRate: Math.abs(speed) || 0.0001,
    });
    source.connect(out);
    const from = backwards ? Math.max(0, active.duration - offset) : offset;
    source.start(0, Math.min(from, Math.max(0, active.duration - 0.001)));
    startedAt = ctx.currentTime;
  }

  // Report the playhead so the waveform can draw it, same as the grain source.
  const tick = () => {
    if (playing && buffer && live.onPosition) {
      const elapsed = (ctx.currentTime - startedAt) * Math.abs(speed) + offset;
      const p = buffer.duration > 0 ? (elapsed / buffer.duration) % 1 : 0;
      live.onPosition(speed < 0 ? 1 - p : p);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return live;
}

// ------------------------------------------------------- worklet effects

function buildWorkletFx(ctx: AudioContext, compiled: CompiledNode): LiveNode {
  const node = new AudioWorkletNode(ctx, compiled.spec.processor!, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { mode: compiled.mode },
  });

  return {
    id: compiled.id,
    node: compiled.node,
    input: node,
    output: node,
    setParam(name, value) {
      const param = node.parameters.get(name);
      if (param) setAudioParam(param, value, ctx, specFor(compiled.spec, name));
    },
    setMode(mode) {
      node.port.postMessage({ type: 'mode', mode });
    },
    dispose() {
      node.disconnect();
    },
  };
}

// -------------------------------------------------------- native effects

function buildDelay(ctx: AudioContext, compiled: CompiledNode): LiveNode {
  const input = new GainNode(ctx);
  const out = new GainNode(ctx);
  const dry = new GainNode(ctx, { gain: 1 });
  const wet = new GainNode(ctx, { gain: 0 });
  const delay = new DelayNode(ctx, { maxDelayTime: 5, delayTime: compiled.params.time ?? 0.375 });
  const feedback = new GainNode(ctx, { gain: 0 });
  const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3500 });
  const lfo = new OscillatorNode(ctx, { frequency: 0.6 });
  const lfoAmount = new GainNode(ctx, { gain: 0 });

  input.connect(dry).connect(out);
  input.connect(delay);
  // Filter inside the feedback loop, so each repeat is darker than the last.
  delay.connect(tone).connect(feedback).connect(delay);
  delay.connect(wet).connect(out);
  lfo.connect(lfoAmount).connect(delay.delayTime);
  lfo.start();

  return {
    id: compiled.id,
    node: compiled.node,
    input,
    output: out,
    setParam(name, value) {
      switch (name) {
        case 'time':
          delay.delayTime.setTargetAtTime(Math.min(4.9, Math.max(0.001, value)), ctx.currentTime, 0.05);
          break;
        case 'fb':
          setAudioParam(feedback.gain, value, ctx);
          break;
        case 'tone':
          setAudioParam(tone.frequency, value, ctx);
          break;
        case 'wobble':
          // A few milliseconds of flutter is plenty; more sounds broken.
          setAudioParam(lfoAmount.gain, value * 0.004, ctx);
          break;
        case 'mix':
          setAudioParam(dry.gain, 1 - value, ctx);
          setAudioParam(wet.gain, value, ctx);
          break;
      }
    },
    dispose() {
      try {
        lfo.stop();
      } catch {
        // Already stopped.
      }
      [input, out, dry, wet, delay, feedback, tone, lfo, lfoAmount].forEach((n) => n.disconnect());
    },
  };
}

function buildVerb(ctx: AudioContext, compiled: CompiledNode): LiveNode {
  const input = new GainNode(ctx);
  const out = new GainNode(ctx);
  const dry = new GainNode(ctx, { gain: 1 });
  const wet = new GainNode(ctx, { gain: 0 });
  const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000 });
  const convolver = new ConvolverNode(ctx, { disableNormalization: false });

  input.connect(dry).connect(out);
  input.connect(tone).connect(convolver).connect(wet).connect(out);

  let size = compiled.params.size ?? 0.6;
  let decay = compiled.params.decay ?? 3;
  let reverse = (compiled.params.rev ?? 0) >= 0.5;
  let currentKey = '';

  const refresh = () => {
    const options = { size, decay, reverse };
    const key = impulseKey(options);
    // Growing an impulse is not cheap, so only do it when the rounded shape
    // actually changed — dragging the mix knob must not rebuild the room.
    if (key === currentKey) return;
    currentKey = key;
    convolver.buffer = makeImpulse(ctx, options);
  };
  refresh();

  return {
    id: compiled.id,
    node: compiled.node,
    input,
    output: out,
    setParam(name, value) {
      switch (name) {
        case 'size':
          size = value;
          refresh();
          break;
        case 'decay':
          decay = value;
          refresh();
          break;
        case 'rev':
          reverse = value >= 0.5;
          refresh();
          break;
        case 'tone':
          setAudioParam(tone.frequency, value, ctx);
          break;
        case 'mix':
          setAudioParam(dry.gain, 1 - value, ctx);
          setAudioParam(wet.gain, value, ctx);
          break;
      }
    },
    dispose() {
      [input, out, dry, wet, tone, convolver].forEach((n) => n.disconnect());
    },
  };
}

function buildFlange(ctx: AudioContext, compiled: CompiledNode): LiveNode {
  const input = new GainNode(ctx);
  const out = new GainNode(ctx);
  const dry = new GainNode(ctx, { gain: 0.5 });
  const wet = new GainNode(ctx, { gain: 0.5 });
  const delay = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: 0.002 });
  const feedback = new GainNode(ctx, { gain: 0 });
  const lfo = new OscillatorNode(ctx, { frequency: 0.3 });
  const lfoAmount = new GainNode(ctx, { gain: 0 });

  input.connect(dry).connect(out);
  input.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(out);
  lfo.connect(lfoAmount).connect(delay.delayTime);
  lfo.start();

  return {
    id: compiled.id,
    node: compiled.node,
    input,
    output: out,
    setParam(name, value) {
      switch (name) {
        case 'rate':
          setAudioParam(lfo.frequency, value, ctx);
          break;
        case 'depth':
          setAudioParam(lfoAmount.gain, value * 0.004, ctx);
          break;
        case 'fb':
          // Negative feedback is the hollow, notchy flange.
          setAudioParam(feedback.gain, Math.max(-0.95, Math.min(0.95, value)), ctx);
          break;
        case 'mix':
          setAudioParam(dry.gain, 1 - value, ctx);
          setAudioParam(wet.gain, value, ctx);
          break;
      }
    },
    dispose() {
      try {
        lfo.stop();
      } catch {
        // Already stopped.
      }
      [input, out, dry, wet, delay, feedback, lfo, lfoAmount].forEach((n) => n.disconnect());
    },
  };
}

/** Sine-to-square morph curve for the chopper's LFO. */
function morphCurve(shape: number): Float32Array<ArrayBuffer> {
  const n = 257;
  const curve = new Float32Array(n);
  const k = 1 + shape * 40;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return curve;
}

function buildTrem(ctx: AudioContext, compiled: CompiledNode): LiveNode {
  const input = new GainNode(ctx);
  const out = new GainNode(ctx);
  const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  // Gain values sit at 0; the modulation and its DC offset arrive as signals.
  const gainL = new GainNode(ctx, { gain: 0 });
  const gainR = new GainNode(ctx, { gain: 0 });

  const lfo = new OscillatorNode(ctx, { frequency: compiled.params.rate ?? 5 });
  const shaper = new WaveShaperNode(ctx, { curve: morphCurve(compiled.params.shape ?? 0) });
  const depthGain = new GainNode(ctx, { gain: 0.35 });
  const offset = new ConstantSourceNode(ctx, { offset: 0.65 });
  // Delaying the control signal is what offsets the right channel's phase, and
  // unlike a second oscillator it stays adjustable while running.
  const phase = new DelayNode(ctx, { maxDelayTime: 10, delayTime: 0 });

  input.connect(splitter);
  splitter.connect(gainL, 0);
  splitter.connect(gainR, 1);
  gainL.connect(merger, 0, 0);
  gainR.connect(merger, 0, 1);
  merger.connect(out);

  lfo.connect(shaper).connect(depthGain);
  depthGain.connect(gainL.gain);
  offset.connect(gainL.gain);
  depthGain.connect(phase);
  phase.connect(gainR.gain);
  offset.connect(gainR.gain);

  lfo.start();
  offset.start();

  let rate = compiled.params.rate ?? 5;
  let stereo = compiled.params.stereo ?? 0;
  const applyPhase = () => {
    // Half a cycle at full stereo puts the channels in opposition.
    phase.delayTime.setTargetAtTime(Math.min(9.9, (stereo * 0.5) / Math.max(0.05, rate)), ctx.currentTime, 0.05);
  };
  applyPhase();

  return {
    id: compiled.id,
    node: compiled.node,
    input,
    output: out,
    setParam(name, value) {
      switch (name) {
        case 'rate':
          rate = value;
          setAudioParam(lfo.frequency, value, ctx);
          applyPhase();
          break;
        case 'depth':
          setAudioParam(depthGain.gain, value / 2, ctx);
          setAudioParam(offset.offset, 1 - value / 2, ctx);
          break;
        case 'shape':
          shaper.curve = morphCurve(value);
          break;
        case 'stereo':
          stereo = value;
          applyPhase();
          break;
      }
    },
    dispose() {
      try {
        lfo.stop();
        offset.stop();
      } catch {
        // Already stopped.
      }
      [input, out, splitter, merger, gainL, gainR, lfo, shaper, depthGain, offset, phase].forEach((n) =>
        n.disconnect(),
      );
    },
  };
}

// -------------------------------------------------------------- deck out

interface LiveOut extends LiveNode {
  /** Runtime-only gain for solo, deliberately not written back to source. */
  setRuntimeGain(value: number): void;
}

function buildOut(ctx: AudioContext, compiled: CompiledNode): LiveOut {
  const gain = new GainNode(ctx, { gain: compiled.params.gain ?? 1 });
  const runtime = new GainNode(ctx, { gain: 1 });
  const panner = new StereoPannerNode(ctx, { pan: compiled.params.pan ?? 0 });
  gain.connect(runtime).connect(panner);

  let level = compiled.params.gain ?? 1;
  let muted = (compiled.params.mute ?? 0) >= 0.5;
  const apply = () => setAudioParam(gain.gain, muted ? 0 : level, ctx);

  return {
    id: compiled.id,
    node: 'out',
    input: gain,
    output: panner,
    setParam(name, value) {
      switch (name) {
        case 'gain':
          level = value;
          apply();
          break;
        case 'pan':
          setAudioParam(panner.pan, Math.max(-1, Math.min(1, value)), ctx);
          break;
        case 'mute':
          muted = value >= 0.5;
          apply();
          break;
      }
    },
    setRuntimeGain(value) {
      setAudioParam(runtime.gain, value, ctx);
    },
    dispose() {
      [gain, runtime, panner].forEach((n) => n.disconnect());
    },
  };
}

// -------------------------------------------------------------- the graph

const BUILDERS: Record<string, (ctx: AudioContext, node: CompiledNode) => LiveNode> = {
  delay: buildDelay,
  verb: buildVerb,
  flange: buildFlange,
  trem: buildTrem,
};

export interface LiveDeck {
  name: string;
  source?: LiveSource;
  chain: LiveNode[];
  out: LiveOut;
}

export class LiveGraph {
  decks: LiveDeck[] = [];
  private byId = new Map<string, LiveNode>();
  private playing = false;
  private solo: string | null = null;
  private engine: Engine;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  build(compiled: CompiledProgram): void {
    const ctx = this.engine.ctx;
    const master = this.engine.masterIn;
    if (!ctx || !master) return;

    const wasPlaying = this.playing;
    this.teardown();

    for (const deck of compiled.decks) {
      const live = this.buildDeck(ctx, deck);
      live.out.output.connect(master);
      this.decks.push(live);
    }

    this.applySolo();
    if (wasPlaying) this.play();
  }

  private buildDeck(ctx: AudioContext, deck: CompiledDeck): LiveDeck {
    let source: LiveSource | undefined;
    if (deck.source) {
      source = deck.source.node === 'play' ? buildPlay(ctx, deck.source) : buildGrain(ctx, deck.source);
      this.register(source, deck.source);
    }

    const chain: LiveNode[] = [];
    for (const fx of deck.fx) {
      const builder = BUILDERS[fx.node];
      const live = builder ? builder(ctx, fx) : buildWorkletFx(ctx, fx);
      this.register(live, fx);
      chain.push(live);
    }

    const out = buildOut(ctx, deck.out);
    this.register(out, deck.out);

    // Wire source → effects → out, skipping any node that has no input.
    let cursor: AudioNode | undefined = source?.output;
    for (const link of chain) {
      if (link.input) {
        cursor?.connect(link.input);
        cursor = link.output;
      }
    }
    cursor?.connect(out.input!);

    return { name: deck.name, source, chain, out };
  }

  /** Push the compiled values onto a freshly built node. */
  private register(live: LiveNode, compiled: CompiledNode): void {
    this.byId.set(live.id, live);
    for (const [name, value] of Object.entries(compiled.params)) {
      live.setParam(name, value);
    }
    if (compiled.mode) live.setMode?.(compiled.mode);
    if (compiled.sample) live.setSample?.(this.engine.getSample(compiled.sample));
  }

  applyDiff(d: GraphDiff): void {
    for (const patch of d.params) this.byId.get(patch.nodeId)?.setParam(patch.param, patch.value);
    for (const patch of d.modes) this.byId.get(patch.nodeId)?.setMode?.(patch.mode);
    for (const patch of d.samples) {
      const node = this.byId.get(patch.nodeId);
      node?.setSample?.(patch.sample ? this.engine.getSample(patch.sample) : undefined);
    }
  }

  /** Re-push a sample that has just finished decoding. */
  refreshSample(name: string, compiled: CompiledProgram): void {
    const buffer = this.engine.getSample(name);
    if (!buffer) return;
    for (const deck of compiled.decks) {
      if (deck.source?.sample === name) {
        this.byId.get(deck.source.id)?.setSample?.(buffer);
      }
    }
  }

  play(): void {
    this.playing = true;
    for (const deck of this.decks) deck.source?.play();
  }

  stop(): void {
    this.playing = false;
    for (const deck of this.decks) deck.source?.halt();
  }

  seek(deckName: string, position: number): void {
    this.deck(deckName)?.source?.seek(position);
  }

  scrub(deckName: string, on: boolean): void {
    this.deck(deckName)?.source?.scrub(on);
  }

  scrubTo(deckName: string, position: number): void {
    this.deck(deckName)?.source?.setScrubPosition(position);
  }

  deck(name: string): LiveDeck | undefined {
    return this.decks.find((d) => d.name === name);
  }

  onPosition(deckName: string, callback: (p: number) => void): void {
    const source = this.deck(deckName)?.source;
    if (source) source.onPosition = callback;
  }

  setSolo(deckName: string | null): void {
    this.solo = deckName;
    this.applySolo();
  }

  get soloed(): string | null {
    return this.solo;
  }

  private applySolo(): void {
    for (const deck of this.decks) {
      deck.out.setRuntimeGain(!this.solo || this.solo === deck.name ? 1 : 0);
    }
  }

  private teardown(): void {
    for (const deck of this.decks) {
      deck.source?.dispose();
      for (const node of deck.chain) node.dispose();
      deck.out.dispose();
    }
    this.decks = [];
    this.byId.clear();
  }

  dispose(): void {
    this.stop();
    this.teardown();
  }
}
