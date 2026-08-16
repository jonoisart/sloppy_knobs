/**
 * fx-processors
 *
 * Every effect in the rack, plus the two master-bus utilities (limiter and
 * recorder). One module so the engine only needs a single addModule() call.
 *
 * Param names and units match the registry in src/audio/fx.ts exactly, so the
 * compiler can copy a canonical value straight onto the AudioParam.
 */

const TWO_PI = Math.PI * 2;

/** Read an a-rate or k-rate param uniformly. */
function pv(arr, i) {
  return arr.length > 1 ? arr[i] : arr[0];
}

/** Kill denormals in feedback paths — they cost real CPU on some hardware. */
function flush(v) {
  return Math.abs(v) < 1e-18 ? 0 : v;
}

function safe(v) {
  return Number.isFinite(v) ? Math.max(-8, Math.min(8, v)) : 0;
}

/**
 * Base class handling the parts every effect repeats: channel bookkeeping,
 * silent passthrough when nothing is connected, and dry/wet blending.
 *
 * Subclasses implement `tick(x, ch, i, params)` returning the wet sample.
 */
class FxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage() {}

  /** Called once per channel-count change so subclasses can size buffers. */
  allocate() {}

  /** Whether this effect should keep running with no input connected. */
  get tailsOut() {
    return false;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const nCh = output.length;
    const n = output[0].length;

    if (nCh !== this.channels) {
      this.channels = nCh;
      this.allocate(nCh);
    }

    const hasInput = input && input.length > 0 && input[0] && input[0].length > 0;
    if (!hasInput && !this.tailsOut) {
      for (let c = 0; c < nCh; c++) output[c].fill(0);
      return true;
    }

    const hasMix = 'mix' in params;

    // Frame-outer, channel-inner. Effects with per-frame state (carrier phase,
    // write heads, slice counters) advance it on a chosen channel index, which
    // is only correct if every channel of a frame is visited together.
    for (let i = 0; i < n; i++) {
      const m = hasMix ? pv(params.mix, i) : 1;
      for (let c = 0; c < nCh; c++) {
        const src = hasInput ? input[Math.min(c, input.length - 1)] : null;
        const x = src ? src[i] : 0;
        const wet = this.tick(x, c, i, params);
        output[c][i] = hasMix ? safe(x * (1 - m) + wet * m) : safe(wet);
      }
    }
    return true;
  }
}

// --------------------------------------------------------------- bitcrush

class BitcrushProcessor extends FxProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  allocate(n) {
    this.held = new Float32Array(n);
    this.acc = new Float32Array(n);
  }

  tick(x, c, i, params) {
    // Sample-and-hold. `rate` is a fractional hold length in samples.
    this.acc[c] += 1;
    const hold = pv(params.rate, i);
    if (this.acc[c] >= hold) {
      this.acc[c] -= hold;
      const levels = Math.pow(2, pv(params.bits, i)) / 2;
      this.held[c] = Math.round(x * levels) / levels;
    }
    return this.held[c];
  }
}

// --------------------------------------------------------------- wavefold

class WavefoldProcessor extends FxProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 2, minValue: 0.1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'bias', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'post', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  tick(x, _c, i, params) {
    let v = x * pv(params.drive, i) + pv(params.bias, i);
    // Reflect back inside [-1, 1] instead of clipping. Bounded iterations so a
    // huge drive cannot stall the audio thread.
    for (let k = 0; k < 8; k++) {
      if (v > 1) v = 2 - v;
      else if (v < -1) v = -2 - v;
      else break;
    }
    return Math.tanh(v) * pv(params.post, i);
  }
}

// ---------------------------------------------------------------- ringmod

class RingmodProcessor extends FxProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 220, minValue: 0.1, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
  }

  tick(x, c, i, params) {
    // Advance the carrier once per frame, on the first channel only, so both
    // channels are modulated by the same carrier value.
    if (c === 0) {
      this.phase += (TWO_PI * pv(params.freq, i)) / sampleRate;
      if (this.phase > TWO_PI) this.phase -= TWO_PI;
    }
    const s = Math.sin(this.phase);
    const shape = pv(params.shape, i);
    const carrier = s * (1 - shape) + Math.tanh(s * 10) * shape;
    const depth = pv(params.depth, i);
    return x * (1 - depth + depth * carrier);
  }
}

// -------------------------------------------------------------------- svf

/**
 * Cytomic-style topology-preserving state variable filter. Stable under
 * modulation, self-oscillates cleanly at high resonance.
 */
class SvfProcessor extends FxProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff', defaultValue: 1200, minValue: 20, maxValue: 18000, automationRate: 'k-rate' },
      { name: 'res', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 1, minValue: 1, maxValue: 10, automationRate: 'k-rate' },
      { name: 'lfo', defaultValue: 0, minValue: 0, maxValue: 20, automationRate: 'k-rate' },
      { name: 'sweep', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.mode = (options && options.processorOptions && options.processorOptions.mode) || 'lp';
    this.lfoPhase = 0;
  }

  onMessage(msg) {
    // Mode is a bare word in source, not a param — swapping it must not force a
    // node rebuild, so it arrives over the port.
    if (msg && msg.type === 'mode') this.mode = msg.mode;
  }

  allocate(n) {
    this.ic1 = new Float32Array(n);
    this.ic2 = new Float32Array(n);
  }

  tick(x, c, i, params) {
    if (c === 0) {
      this.lfoPhase += (TWO_PI * pv(params.lfo, i)) / sampleRate;
      if (this.lfoPhase > TWO_PI) this.lfoPhase -= TWO_PI;
    }

    const sweep = pv(params.sweep, i);
    const mod = pv(params.lfo, i) > 0 ? Math.sin(this.lfoPhase) * sweep * 2 : 0;
    const fc = Math.min(
      sampleRate * 0.45,
      Math.max(20, pv(params.cutoff, i) * Math.pow(2, mod)),
    );

    const drive = pv(params.drive, i);
    const v0 = drive > 1 ? Math.tanh(x * drive) / Math.sqrt(drive) : x;

    const g = Math.tan((Math.PI * fc) / sampleRate);
    // res 0..1 maps to k 2..0.02; k is 1/Q, so small k is high resonance.
    const k = 2 - 1.98 * pv(params.res, i);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;

    const ic1 = this.ic1[c];
    const ic2 = this.ic2[c];
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    this.ic1[c] = flush(2 * v1 - ic1);
    this.ic2[c] = flush(2 * v2 - ic2);

    switch (this.mode) {
      case 'hp':
        return v0 - k * v1 - v2;
      case 'bp':
        return v1;
      case 'notch':
        return v0 - k * v1;
      default:
        return v2;
    }
  }
}

// ------------------------------------------------------------- pitchshift

/**
 * Two-tap delay-line shifter. The taps sit half a window apart and are
 * Hann-crossfaded; the two windows sum to exactly 1, so steady input keeps a
 * steady level across the splice.
 */
class PitchshiftProcessor extends FxProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'st', defaultValue: -12, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'win', defaultValue: 80, minValue: 10, maxValue: 200, automationRate: 'k-rate' },
      { name: 'fb', defaultValue: 0, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
  }

  get tailsOut() {
    return true;
  }

  allocate(n) {
    this.size = Math.ceil(sampleRate); // 1s: comfortably over 2x the max window
    this.buf = [];
    this.w = new Int32Array(n);
    for (let c = 0; c < n; c++) this.buf.push(new Float32Array(this.size));
  }

  read(c, delay) {
    const L = this.size;
    let p = this.w[c] - delay;
    p = ((p % L) + L) % L;
    const i0 = p | 0;
    const i1 = (i0 + 1) % L;
    const f = p - i0;
    const b = this.buf[c];
    return b[i0] * (1 - f) + b[i1] * f;
  }

  tick(x, c, i, params) {
    const W = Math.max(64, (pv(params.win, i) / 1000) * sampleRate);
    const ratio = Math.pow(2, pv(params.st, i) / 12);

    if (c === 0) {
      this.phase += 1 - ratio;
      this.phase = ((this.phase % W) + W) % W;
    }
    const d1 = this.phase % W;
    const d2 = (d1 + W / 2) % W;

    const g1 = 0.5 - 0.5 * Math.cos(TWO_PI * (d1 / W));
    const g2 = 0.5 - 0.5 * Math.cos(TWO_PI * (d2 / W));

    const y = this.read(c, d1) * g1 + this.read(c, d2) * g2;

    this.buf[c][this.w[c]] = flush(x + y * pv(params.fb, i));
    this.w[c] = (this.w[c] + 1) % this.size;

    return y;
  }
}

// ---------------------------------------------------------------- freezer

class FreezerProcessor extends FxProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'on', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'size', defaultValue: 500, minValue: 20, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'drift', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.frozen = false;
    this.start = 0;
    this.len = 0;
    this.pos = 0;
    this.driftPhase = 0;
  }

  get tailsOut() {
    return true;
  }

  allocate(n) {
    this.size = Math.ceil(sampleRate * 2.5);
    this.buf = [];
    this.w = 0;
    for (let c = 0; c < n; c++) this.buf.push(new Float32Array(this.size));
  }

  at(c, idx) {
    // `start` drifts by fractional amounts, so this has to interpolate.
    const L = this.size;
    const p = ((idx % L) + L) % L;
    const i0 = p | 0;
    const i1 = (i0 + 1) % L;
    const f = p - i0;
    return this.buf[c][i0] * (1 - f) + this.buf[c][i1] * f;
  }

  tick(x, c, i, params) {
    const on = pv(params.on, i) >= 0.5;

    if (c === 0) {
      if (on && !this.frozen) {
        // Latch the moment that just passed.
        this.len = Math.max(256, (pv(params.size, i) / 1000) * sampleRate) | 0;
        this.start = this.w - this.len;
        this.pos = 0;
        this.frozen = true;
      } else if (!on && this.frozen) {
        this.frozen = false;
      }
    }

    this.buf[c][((this.w % this.size) + this.size) % this.size] = x;
    if (c === this.channels - 1) this.w = (this.w + 1) % this.size;

    if (!this.frozen) return x;

    const N = this.len;
    const xf = Math.min(N * 0.15, 0.02 * sampleRate);
    let out = this.at(c, this.start + this.pos);
    if (this.pos > N - xf) {
      // Crossfade the loop seam back to the head so it does not click.
      const t = (this.pos - (N - xf)) / xf;
      out = out * (1 - t) + this.at(c, this.start + this.pos - N) * t;
    }

    if (c === this.channels - 1) {
      this.pos += 1;
      if (this.pos >= N) this.pos -= N;
      const drift = pv(params.drift, i);
      if (drift > 0) {
        this.driftPhase += 0.07 / sampleRate;
        this.start += Math.sin(this.driftPhase * TWO_PI) * drift * 0.5;
      }
    }
    return out;
  }
}

// ----------------------------------------------------------------- glitch

class GlitchProcessor extends FxProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'slice', defaultValue: 120, minValue: 10, maxValue: 1000, automationRate: 'k-rate' },
      { name: 'chance', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'rev', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'warp', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.counter = 0;
    this.repeating = false;
    this.repeatsLeft = 0;
    this.sliceStart = 0;
    this.sliceLen = 0;
    this.playPos = 0;
    this.rate = 1;
    this.backwards = false;
  }

  get tailsOut() {
    return true;
  }

  allocate(n) {
    this.size = Math.ceil(sampleRate * 4);
    this.buf = [];
    this.w = 0;
    for (let c = 0; c < n; c++) this.buf.push(new Float32Array(this.size));
  }

  at(c, pos) {
    const L = this.size;
    let p = ((pos % L) + L) % L;
    const i0 = p | 0;
    const i1 = (i0 + 1) % L;
    const f = p - i0;
    return this.buf[c][i0] * (1 - f) + this.buf[c][i1] * f;
  }

  advance(params, i) {
    const sliceSamples = Math.max(64, (pv(params.slice, i) / 1000) * sampleRate);

    if (this.repeating) {
      this.playPos += this.rate;
      if (this.playPos >= this.sliceLen) {
        this.playPos -= this.sliceLen;
        if (--this.repeatsLeft <= 0) this.repeating = false;
      }
      return;
    }

    this.counter += 1;
    if (this.counter >= sliceSamples) {
      this.counter = 0;
      if (Math.random() < pv(params.chance, i)) {
        this.sliceLen = sliceSamples;
        this.sliceStart = this.w - sliceSamples;
        this.playPos = 0;
        this.repeatsLeft = 1 + ((Math.random() * 4) | 0);
        this.backwards = Math.random() < pv(params.rev, i);
        this.rate =
          Math.random() < pv(params.warp, i)
            ? [0.5, 0.5, 2, 1.5][(Math.random() * 4) | 0]
            : 1;
        this.repeating = true;
      }
    }
  }

  tick(x, c, i, params) {
    this.buf[c][this.w] = x;

    let out = x;
    if (this.repeating) {
      const p = this.backwards ? this.sliceLen - this.playPos : this.playPos;
      out = this.at(c, this.sliceStart + p);
      // Short fades at both ends of the slice kill the edge clicks.
      const fade = Math.min(this.sliceLen * 0.1, 0.003 * sampleRate);
      const from = Math.min(this.playPos, this.sliceLen - this.playPos);
      if (from < fade) out *= from / fade;
    }

    if (c === this.channels - 1) {
      this.w = (this.w + 1) % this.size;
      this.advance(params, i);
    }
    return out;
  }
}

// ---------------------------------------------------------------- limiter

/** Master-bus safety net. Fast attack, slow release, soft knee via tanh. */
class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: 0.95, minValue: 0.1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.25, minValue: 0.01, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.env = 0;
    this.reduction = 1;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;
    if (!input || !input.length) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }

    const ceiling = params.ceiling[0];
    const relCoef = Math.exp(-1 / (params.release[0] * sampleRate));
    const attCoef = Math.exp(-1 / (0.0005 * sampleRate));

    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const a = Math.abs(input[c][i]);
        if (a > peak) peak = a;
      }
      const coef = peak > this.env ? attCoef : relCoef;
      this.env = flush(peak + coef * (this.env - peak));

      const want = this.env > ceiling ? ceiling / this.env : 1;
      // Only the release side is smoothed; gain reduction must be immediate.
      this.reduction = want < this.reduction ? want : want + relCoef * (this.reduction - want);

      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)][i];
        output[c][i] = Math.tanh(src * this.reduction * 1.02) * ceiling;
      }
    }

    return true;
  }
}

// --------------------------------------------------------------- recorder

/**
 * Taps the master bus and ships raw frames to the main thread, which encodes
 * them as WAV. Passes audio through unchanged so it can sit inline.
 */
const CHUNK = 8192;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunks = null;
    this.fill = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'start') {
        this.recording = true;
        this.fill = 0;
        this.chunks = null;
      } else if (msg.type === 'stop') {
        this.flushChunk();
        this.recording = false;
        this.port.postMessage({ type: 'done' });
      }
    };
  }

  ensure(nCh) {
    if (!this.chunks || this.chunks.length !== nCh) {
      this.chunks = [];
      for (let c = 0; c < nCh; c++) this.chunks.push(new Float32Array(CHUNK));
      this.fill = 0;
    }
  }

  flushChunk() {
    if (!this.chunks || this.fill === 0) return;
    const payload = this.chunks.map((c) => c.slice(0, this.fill).buffer);
    this.port.postMessage({ type: 'chunk', channels: payload, frames: this.fill }, payload);
    this.chunks = null;
    this.fill = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0].length;

    if (!input || !input.length) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }

    for (let c = 0; c < output.length; c++) {
      output[c].set(input[Math.min(c, input.length - 1)]);
    }

    if (this.recording) {
      const nCh = input.length;
      this.ensure(nCh);
      let done = 0;
      while (done < n) {
        const room = CHUNK - this.fill;
        const take = Math.min(room, n - done);
        for (let c = 0; c < nCh; c++) {
          this.chunks[c].set(input[c].subarray(done, done + take), this.fill);
        }
        this.fill += take;
        done += take;
        if (this.fill >= CHUNK) {
          this.flushChunk();
          this.ensure(nCh);
        }
      }
    }

    return true;
  }
}

registerProcessor('bitcrush-processor', BitcrushProcessor);
registerProcessor('wavefold-processor', WavefoldProcessor);
registerProcessor('ringmod-processor', RingmodProcessor);
registerProcessor('svf-processor', SvfProcessor);
registerProcessor('pitchshift-processor', PitchshiftProcessor);
registerProcessor('freezer-processor', FreezerProcessor);
registerProcessor('glitch-processor', GlitchProcessor);
registerProcessor('limiter-processor', LimiterProcessor);
registerProcessor('recorder-processor', RecorderProcessor);
