/**
 * The audio context, the master bus, and the sample store.
 *
 * Browsers will not start audio without a user gesture — on iOS especially —
 * so nothing here happens until `start()` is called from a real tap. Everything
 * else in the app treats `ready` as the gate.
 */

import { claimPlaybackSession } from './session';
import { concatChunks, encodeWav } from './wav';

const WORKLET_MODULES = ['granular-processor.js', 'fx-processors.js'];

export type EngineState = 'idle' | 'starting' | 'ready' | 'failed';

export interface Levels {
  peak: number;
  rms: number;
}

export class Engine {
  ctx: AudioContext | null = null;
  state: EngineState = 'idle';
  error: string | null = null;

  /** Everything a deck produces is summed here. */
  masterIn: GainNode | null = null;
  analyser: AnalyserNode | null = null;

  private limiter: AudioWorkletNode | null = null;
  private recorder: AudioWorkletNode | null = null;
  private samples = new Map<string, AudioBuffer>();

  private recording = false;
  private recChunks: Float32Array[][] = [];
  private recStartedAt = 0;
  private onRecordingDone: ((blob: Blob) => void) | null = null;

  // Explicitly backed by an ArrayBuffer: the analyser API will not accept the
  // SharedArrayBuffer-compatible default that a bare Float32Array widens to.
  private meterBuffer: Float32Array<ArrayBuffer> | null = null;
  private startPromise: Promise<void> | null = null;

  get ready(): boolean {
    return this.state === 'ready';
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Idempotent, and safe to call again after a failure. */
  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.startPromise) return this.startPromise;

    this.state = 'starting';
    this.error = null;
    this.startPromise = this.boot().catch((err) => {
      this.state = 'failed';
      this.error = err instanceof Error ? err.message : String(err);
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private async boot(): Promise<void> {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('This browser has no Web Audio support.');

    // Before the context exists, so the session type applies to it from the
    // start. Without this an iPhone's silent switch mutes everything.
    claimPlaybackSession();

    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    const base = import.meta.env.BASE_URL || '/';
    for (const module of WORKLET_MODULES) {
      await ctx.audioWorklet.addModule(`${base}worklets/${module}`);
    }

    this.masterIn = new GainNode(ctx, { gain: 0.9 });
    this.limiter = new AudioWorkletNode(ctx, 'limiter-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.recorder = new AudioWorkletNode(ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.7 });
    this.meterBuffer = new Float32Array(this.analyser.fftSize);

    this.recorder.port.onmessage = (e) => this.onRecorderMessage(e.data);

    this.masterIn.connect(this.limiter);
    this.limiter.connect(this.recorder);
    this.recorder.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Autoplay policy: a context created outside a gesture starts suspended.
    if (ctx.state === 'suspended') await ctx.resume();

    this.state = 'ready';
  }

  async resume(): Promise<void> {
    // iOS also reports a non-standard 'interrupted' state after a call.
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
  }

  setMasterGain(value: number): void {
    if (!this.masterIn || !this.ctx) return;
    this.masterIn.gain.setTargetAtTime(Math.max(0, value), this.ctx.currentTime, 0.01);
  }

  // ------------------------------------------------------------- samples

  /**
   * Decode and register a sample under `name`.
   *
   * `decodeAudioData` detaches the ArrayBuffer it is given, so callers who also
   * want to persist the original bytes must hand over a copy.
   */
  async addSample(name: string, data: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.ctx) throw new Error('Audio is not running yet.');
    const buffer = await this.ctx.decodeAudioData(data);
    this.samples.set(name, buffer);
    return buffer;
  }

  putSample(name: string, buffer: AudioBuffer): void {
    this.samples.set(name, buffer);
  }

  getSample(name: string): AudioBuffer | undefined {
    return this.samples.get(name);
  }

  removeSample(name: string): void {
    this.samples.delete(name);
  }

  renameSample(from: string, to: string): void {
    const buffer = this.samples.get(from);
    if (!buffer) return;
    this.samples.delete(from);
    this.samples.set(to, buffer);
  }

  get sampleNames(): string[] {
    return [...this.samples.keys()];
  }

  // ----------------------------------------------------------- recording

  get isRecording(): boolean {
    return this.recording;
  }

  get recordedSeconds(): number {
    if (!this.recording || !this.ctx) return 0;
    return this.ctx.currentTime - this.recStartedAt;
  }

  startRecording(): void {
    if (!this.recorder || !this.ctx || this.recording) return;
    this.recChunks = [];
    this.recording = true;
    this.recStartedAt = this.ctx.currentTime;
    this.recorder.port.postMessage({ type: 'start' });
  }

  /** Resolves once the worklet has flushed its last partial chunk. */
  stopRecording(): Promise<Blob> {
    if (!this.recorder || !this.recording) return Promise.resolve(new Blob());
    return new Promise((resolve) => {
      this.onRecordingDone = resolve;
      this.recorder!.port.postMessage({ type: 'stop' });
    });
  }

  private onRecorderMessage(msg: { type: string; channels?: ArrayBuffer[] }): void {
    if (msg.type === 'chunk' && msg.channels) {
      this.recChunks.push(msg.channels.map((b) => new Float32Array(b)));
      return;
    }
    if (msg.type === 'done') {
      this.recording = false;
      const nCh = this.recChunks[0]?.length ?? 2;
      const merged = concatChunks(this.recChunks, nCh);
      this.recChunks = [];
      const blob = encodeWav(merged, this.sampleRate, 16);
      this.onRecordingDone?.(blob);
      this.onRecordingDone = null;
    }
  }

  // ------------------------------------------------------------- metering

  levels(): Levels {
    if (!this.analyser || !this.meterBuffer) return { peak: 0, rms: 0 };
    this.analyser.getFloatTimeDomainData(this.meterBuffer);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < this.meterBuffer.length; i++) {
      const v = this.meterBuffer[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / this.meterBuffer.length) };
  }

  /** Fills `target` with time-domain data for the scope. */
  scope(target: Float32Array<ArrayBuffer>): void {
    this.analyser?.getFloatTimeDomainData(target);
  }

  async dispose(): Promise<void> {
    this.samples.clear();
    await this.ctx?.close();
    this.ctx = null;
    this.state = 'idle';
    this.startPromise = null;
  }
}

export const engine = new Engine();
