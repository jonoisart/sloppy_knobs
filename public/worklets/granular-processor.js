/**
 * granular-processor
 *
 * A grain-cloud sample player. The whole decoded sample lives inside the audio
 * thread, so scrubbing / freezing / smearing happens at audio rate instead of
 * being quantised to whatever the main thread manages to schedule.
 *
 * The playhead is a floating point position in samples. Grains are sprayed
 * around it; each grain is an independent little windowed reader with its own
 * rate, direction and stereo placement.
 */

const MAX_GRAINS = 96;
const TWO_PI = Math.PI * 2;

function pv(arr, i) {
  return arr.length > 1 ? arr[i] : arr[0];
}

class GranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Manual playhead, 0..1 through the sample. Only obeyed while scrubbing.
      { name: 'position', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Playhead advance multiplier. 0 freezes, negatives run backwards.
      { name: 'speed', defaultValue: 1, minValue: -4, maxValue: 4, automationRate: 'k-rate' },
      { name: 'grainMs', defaultValue: 120, minValue: 2, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'density', defaultValue: 22, minValue: 0.2, maxValue: 200, automationRate: 'k-rate' },
      // Transposition in semitones, plus a random per-grain wobble.
      { name: 'pitch', defaultValue: 0, minValue: -36, maxValue: 36, automationRate: 'k-rate' },
      { name: 'jitter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // How far around the playhead grains may land, in seconds.
      { name: 'spray', defaultValue: 0.02, minValue: 0, maxValue: 10, automationRate: 'k-rate' },
      { name: 'reverse', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'spread', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0.8, minValue: 0, maxValue: 4, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    /** @type {Float32Array[]} */
    this.channels = [];
    this.frames = 0;
    this.playing = false;
    this.scrubbing = false;
    this.head = 0;
    this.loopStart = 0;
    this.loopEnd = 1;
    this.grainPhase = 0;
    this.reportCounter = 0;

    // Grain pool. Flat arrays instead of objects so we are not allocating in
    // the audio thread on every trigger.
    this.gActive = new Uint8Array(MAX_GRAINS);
    this.gPos = new Float64Array(MAX_GRAINS);
    this.gRate = new Float64Array(MAX_GRAINS);
    this.gAge = new Float64Array(MAX_GRAINS);
    this.gLen = new Float64Array(MAX_GRAINS);
    this.gL = new Float32Array(MAX_GRAINS);
    this.gR = new Float32Array(MAX_GRAINS);

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'load':
        this.channels = msg.channels.map((c) => new Float32Array(c));
        this.frames = this.channels[0] ? this.channels[0].length : 0;
        this.head = this.loopStart * this.frames;
        this.killGrains();
        break;
      case 'play':
        if (this.frames === 0) break;
        if (typeof msg.from === 'number') this.head = msg.from * this.frames;
        this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        this.killGrains();
        break;
      case 'seek':
        this.head = Math.max(0, Math.min(1, msg.position)) * this.frames;
        break;
      case 'scrub':
        this.scrubbing = !!msg.on;
        break;
      case 'loop':
        this.loopStart = Math.max(0, Math.min(1, msg.start));
        this.loopEnd = Math.max(this.loopStart + 0.0005, Math.min(1, msg.end));
        if (this.head < this.loopStart * this.frames || this.head > this.loopEnd * this.frames) {
          this.head = this.loopStart * this.frames;
        }
        break;
    }
  }

  killGrains() {
    this.gActive.fill(0);
    this.grainPhase = 0;
  }

  spawn(headPos, params, i) {
    let slot = -1;
    for (let g = 0; g < MAX_GRAINS; g++) {
      if (!this.gActive[g]) {
        slot = g;
        break;
      }
    }
    if (slot < 0) return;

    const spray = pv(params.spray, i) * sampleRate;
    const semis = pv(params.pitch, i) + (Math.random() * 2 - 1) * pv(params.jitter, i) * 12;
    const lo = this.loopStart * this.frames;
    const hi = this.loopEnd * this.frames;
    const span = Math.max(1, hi - lo);

    let pos = headPos + (Math.random() * 2 - 1) * spray;
    // Wrap into the active loop window rather than clamping, so a wide spray
    // keeps sounding instead of piling up on the edges.
    pos = lo + (((pos - lo) % span) + span) % span;

    const back = Math.random() < pv(params.reverse, i);
    const rate = Math.pow(2, semis / 12) * (back ? -1 : 1);
    const len = Math.max(32, (pv(params.grainMs, i) / 1000) * sampleRate);

    const spread = pv(params.spread, i);
    const pan = (Math.random() * 2 - 1) * spread;
    const angle = ((pan + 1) / 2) * (Math.PI / 2);

    this.gActive[slot] = 1;
    this.gPos[slot] = pos;
    this.gRate[slot] = rate;
    this.gAge[slot] = 0;
    this.gLen[slot] = len;
    this.gL[slot] = Math.cos(angle);
    this.gR[slot] = Math.sin(angle);
  }

  read(ch, pos) {
    const data = this.channels[ch] || this.channels[0];
    if (!data) return 0;
    const n = data.length;
    let p = pos;
    if (p < 0 || p >= n) {
      p = ((p % n) + n) % n;
    }
    const i0 = p | 0;
    const i1 = i0 + 1 >= n ? 0 : i0 + 1;
    const frac = p - i0;
    return data[i0] * (1 - frac) + data[i1] * frac;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;

    if (!this.frames) {
      outL.fill(0);
      if (out[1]) outR.fill(0);
      return true;
    }

    const stereoSource = this.channels.length > 1;
    const lo = this.loopStart * this.frames;
    const hi = this.loopEnd * this.frames;
    const span = Math.max(1, hi - lo);

    for (let i = 0; i < n; i++) {
      const speed = this.scrubbing ? 0 : pv(params.speed, i);

      if (this.scrubbing) {
        // Follow the finger. Smoothed so a jumpy touch does not click.
        const target = lo + pv(params.position, i) * span;
        this.head += (target - this.head) * 0.002;
      } else if (this.playing) {
        this.head += speed;
        if (this.head >= hi) this.head = lo + ((this.head - lo) % span);
        if (this.head < lo) this.head = hi - (((lo - this.head) % span) || 0);
      }

      if (this.playing || this.scrubbing) {
        this.grainPhase += pv(params.density, i) / sampleRate;
        while (this.grainPhase >= 1) {
          this.grainPhase -= 1;
          this.spawn(this.head, params, i);
        }
      }

      let l = 0;
      let r = 0;
      for (let g = 0; g < MAX_GRAINS; g++) {
        if (!this.gActive[g]) continue;
        const len = this.gLen[g];
        const age = this.gAge[g];
        if (age >= len) {
          this.gActive[g] = 0;
          continue;
        }
        // Hann window: no clicks at either end of the grain.
        const w = 0.5 - 0.5 * Math.cos(TWO_PI * (age / len));
        const p = this.gPos[g];
        const sl = this.read(0, p);
        const sr = stereoSource ? this.read(1, p) : sl;
        l += sl * w * this.gL[g];
        r += sr * w * this.gR[g];
        this.gPos[g] = p + this.gRate[g];
        this.gAge[g] = age + 1;
      }

      // Grain clouds sum incoherently; normalise a little by density so the
      // level does not explode when the user cranks it.
      const norm = 1 / Math.sqrt(Math.max(1, (pv(params.density, i) * pv(params.grainMs, i)) / 1000));
      const gain = pv(params.gain, i) * norm * 1.6;
      outL[i] = l * gain;
      outR[i] = r * gain;
    }

    this.reportCounter += n;
    if (this.reportCounter >= sampleRate / 20) {
      this.reportCounter = 0;
      this.port.postMessage({ type: 'pos', position: this.head / this.frames });
    }

    return true;
  }
}

registerProcessor('granular-processor', GranularProcessor);
