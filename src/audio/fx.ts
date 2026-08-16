/**
 * The node registry.
 *
 * This is the one place a node is described. The language checker validates
 * against it, the compiler reads defaults and ranges from it, and the UI builds
 * its knobs from it. Adding an effect here makes it exist everywhere at once.
 */

export type Unit = '' | 'ms' | 's' | 'hz' | 'khz' | 'db' | '%' | 'st';
export type Curve = 'lin' | 'exp';

export interface ParamSpec {
  /** Name as written in source, e.g. `cutoff`. */
  name: string;
  label: string;
  min: number;
  max: number;
  def: number;
  /** Canonical unit. Values written with a compatible unit are converted to it. */
  unit: Unit;
  curve?: Curve;
  /** Knob feel for linear params: t ** skew. >1 gives finer control down low. */
  skew?: number;
  /** Renders as a switch rather than a knob. */
  toggle?: boolean;
  hint?: string;
}

export interface NodeSpec {
  id: string;
  kind: 'src' | 'fx' | 'out';
  label: string;
  blurb: string;
  params: ParamSpec[];
  /** Bare-word modifier written after the node name, e.g. `svf lp`. */
  modes?: string[];
  /** This node takes a quoted sample name, e.g. `src grain "voice-note"`. */
  takesSample?: boolean;
  /** Worklet processor name, when the node is implemented as a worklet. */
  processor?: string;
}

const p = (
  name: string,
  label: string,
  min: number,
  max: number,
  def: number,
  unit: Unit = '',
  extra: Partial<ParamSpec> = {},
): ParamSpec => ({ name, label, min, max, def, unit, ...extra });

const MIX = p('mix', 'Mix', 0, 1, 1, '', { hint: 'dry → wet' });

export const NODES: NodeSpec[] = [
  // ---------------------------------------------------------------- sources
  {
    id: 'grain',
    kind: 'src',
    label: 'Grain Cloud',
    blurb: 'Sprays overlapping windowed grains around a floating playhead. Freeze it, stretch it, run it backwards.',
    takesSample: true,
    processor: 'granular-processor',
    params: [
      p('speed', 'Speed', -4, 4, 1, '', { hint: '0 freezes, negative reverses' }),
      p('grain', 'Grain', 2, 2000, 120, 'ms', { curve: 'exp' }),
      p('dens', 'Density', 0.2, 200, 22, 'hz', { curve: 'exp', hint: 'grains per second' }),
      p('pitch', 'Pitch', -36, 36, 0, 'st'),
      p('jitter', 'Jitter', 0, 1, 0, '', { hint: 'random pitch per grain' }),
      p('spray', 'Spray', 0, 10, 0.02, 's', { skew: 3, hint: 'position scatter' }),
      p('rev', 'Reverse', 0, 1, 0, '', { hint: 'chance a grain plays backwards' }),
      p('spread', 'Spread', 0, 1, 0.6, '', { hint: 'stereo scatter' }),
      p('gain', 'Gain', 0, 4, 0.8, ''),
    ],
  },
  {
    id: 'play',
    kind: 'src',
    label: 'Straight Play',
    blurb: 'Plain buffer playback. Cheap, clean, and useful as a bed under the mangled decks.',
    takesSample: true,
    params: [
      p('speed', 'Speed', -4, 4, 1, '', { hint: 'negative plays backwards' }),
      p('gain', 'Gain', 0, 4, 1, ''),
      p('loop', 'Loop', 0, 1, 1, '', { toggle: true }),
    ],
  },

  // ---------------------------------------------------------------- destroy
  {
    id: 'crush',
    kind: 'fx',
    label: 'Bitcrush',
    blurb: 'Quantises amplitude and holds samples. Low bits gritty, low rate aliased and metallic.',
    processor: 'bitcrush-processor',
    params: [
      p('bits', 'Bits', 1, 16, 8, '', { skew: 0.6 }),
      p('rate', 'Decimate', 1, 64, 1, '', { curve: 'exp', hint: 'sample-and-hold length' }),
      MIX,
    ],
  },
  {
    id: 'fold',
    kind: 'fx',
    label: 'Wavefolder',
    blurb: 'Folds the waveform back on itself instead of clipping it. Adds harmonics that track the input.',
    processor: 'wavefold-processor',
    params: [
      p('drive', 'Drive', 0.1, 20, 2, '', { curve: 'exp' }),
      p('bias', 'Bias', -1, 1, 0, '', { hint: 'asymmetry → even harmonics' }),
      p('post', 'Output', 0, 2, 1, ''),
      MIX,
    ],
  },
  {
    id: 'ring',
    kind: 'fx',
    label: 'Ring Mod',
    blurb: 'Multiplies against a carrier. Sum and difference tones only — inharmonic and bell-like.',
    processor: 'ringmod-processor',
    params: [
      p('freq', 'Freq', 0.1, 5000, 220, 'hz', { curve: 'exp' }),
      p('shape', 'Shape', 0, 1, 0, '', { hint: 'sine → square carrier' }),
      p('depth', 'Depth', 0, 1, 1, ''),
      MIX,
    ],
  },
  {
    id: 'svf',
    kind: 'fx',
    label: 'Filter',
    blurb: 'State-variable filter with a driven feedback path. Will self-oscillate if you push resonance.',
    processor: 'svf-processor',
    modes: ['lp', 'bp', 'hp', 'notch'],
    params: [
      p('cutoff', 'Cutoff', 20, 18000, 1200, 'hz', { curve: 'exp' }),
      p('res', 'Resonance', 0, 1, 0.2, ''),
      p('drive', 'Drive', 1, 10, 1, ''),
      p('lfo', 'LFO Rate', 0, 20, 0, 'hz', { curve: 'exp', hint: '0 disables sweep' }),
      p('sweep', 'LFO Depth', 0, 1, 0, ''),
    ],
  },
  {
    id: 'glitch',
    kind: 'fx',
    label: 'Stutter',
    blurb: 'Captures slices and probabilistically repeats, reverses or retunes them.',
    processor: 'glitch-processor',
    params: [
      p('slice', 'Slice', 10, 1000, 120, 'ms', { curve: 'exp' }),
      p('chance', 'Chance', 0, 1, 0.3, ''),
      p('rev', 'Reverse', 0, 1, 0.2, ''),
      p('warp', 'Warp', 0, 1, 0, '', { hint: 'chance a repeat is retuned' }),
      MIX,
    ],
  },

  // ------------------------------------------------------------------ space
  {
    id: 'shift',
    kind: 'fx',
    label: 'Pitch Warp',
    blurb: 'Delay-line pitch shifter with crossfaded taps. Feed it back for endless falling stairs.',
    processor: 'pitchshift-processor',
    params: [
      p('st', 'Pitch', -24, 24, -12, 'st'),
      p('win', 'Window', 10, 200, 80, 'ms', { hint: 'short warbles, long smears' }),
      p('fb', 'Feedback', 0, 0.95, 0, ''),
      MIX,
    ],
  },
  {
    id: 'freeze',
    kind: 'fx',
    label: 'Freezer',
    blurb: 'Grabs the last moment and loops it under a crossfade. Drift makes the loop wander.',
    processor: 'freezer-processor',
    params: [
      p('on', 'Freeze', 0, 1, 0, '', { toggle: true }),
      p('size', 'Size', 20, 2000, 500, 'ms', { curve: 'exp' }),
      p('drift', 'Drift', 0, 1, 0, ''),
      MIX,
    ],
  },
  {
    id: 'delay',
    kind: 'fx',
    label: 'Tape Delay',
    blurb: 'Feedback delay with a filtered loop and a wobbling read head. Accepts bar ratios like 3/8.',
    params: [
      p('time', 'Time', 0.001, 4, 0.375, 's', { curve: 'exp' }),
      p('fb', 'Feedback', 0, 0.98, 0.45, ''),
      p('tone', 'Tone', 200, 12000, 3500, 'hz', { curve: 'exp', hint: 'darkens each repeat' }),
      p('wobble', 'Wobble', 0, 1, 0.15, '', { hint: 'tape flutter' }),
      MIX,
    ],
  },
  {
    id: 'verb',
    kind: 'fx',
    label: 'Reverb',
    blurb: 'Convolution against a procedurally grown impulse. Reverse it for the classic swell.',
    params: [
      p('size', 'Size', 0, 1, 0.6, ''),
      p('decay', 'Decay', 0.1, 12, 3, 's', { curve: 'exp' }),
      p('rev', 'Reverse', 0, 1, 0, '', { toggle: true }),
      p('tone', 'Tone', 200, 16000, 6000, 'hz', { curve: 'exp' }),
      p('mix', 'Mix', 0, 1, 0.35, ''),
    ],
  },
  {
    id: 'flange',
    kind: 'fx',
    label: 'Flanger',
    blurb: 'Short modulated delay against the dry signal. Negative feedback gives the hollow jet.',
    params: [
      p('rate', 'Rate', 0.01, 10, 0.3, 'hz', { curve: 'exp' }),
      p('depth', 'Depth', 0, 1, 0.5, ''),
      p('fb', 'Feedback', -0.95, 0.95, 0.3, ''),
      p('mix', 'Mix', 0, 1, 0.5, ''),
    ],
  },
  {
    id: 'trem',
    kind: 'fx',
    label: 'Chopper',
    blurb: 'Amplitude modulation from a gentle sway to a hard square gate.',
    params: [
      p('rate', 'Rate', 0.05, 40, 5, 'hz', { curve: 'exp' }),
      p('depth', 'Depth', 0, 1, 0.7, ''),
      p('shape', 'Shape', 0, 1, 0, '', { hint: 'sine → square' }),
      p('stereo', 'Stereo', 0, 1, 0, '', { hint: 'phase offset between channels' }),
    ],
  },

  // ------------------------------------------------------------------- out
  {
    id: 'out',
    kind: 'out',
    label: 'Output',
    blurb: 'Where the deck lands in the mix.',
    params: [
      p('gain', 'Gain', 0, 4, 1, ''),
      p('pan', 'Pan', -1, 1, 0, ''),
      p('mute', 'Mute', 0, 1, 0, '', { toggle: true }),
    ],
  },
];

const BY_ID = new Map(NODES.map((n) => [n.id, n]));

export function getNode(id: string): NodeSpec | undefined {
  return BY_ID.get(id);
}

export function getParam(nodeId: string, param: string): ParamSpec | undefined {
  return BY_ID.get(nodeId)?.params.find((x) => x.name === param);
}

export const SOURCES = NODES.filter((n) => n.kind === 'src');
export const EFFECTS = NODES.filter((n) => n.kind === 'fx');

/** Processor names that must be registered before any graph is built. */
export const WORKLET_PROCESSORS = NODES.map((n) => n.processor).filter(
  (x): x is string => !!x,
);

// ---------------------------------------------------------------- units

const TO_SECONDS: Record<string, number> = { ms: 0.001, s: 1 };
const TO_HZ: Record<string, number> = { hz: 1, khz: 1000 };

/**
 * Convert a source-written value into the param's canonical unit.
 *
 * `grain=180ms` and `grain=0.18s` both land on 180, because `grain` is declared
 * in milliseconds. Returns null when the unit makes no sense for the param, so
 * the checker can report it rather than silently producing nonsense.
 */
export function toCanonical(value: number, unit: Unit, spec: ParamSpec): number | null {
  if (!unit || unit === spec.unit) return value;

  // Percent is only meaningful for ratio params.
  if (unit === '%') return spec.unit === '' ? value / 100 : null;

  // Decibels only convert into a linear gain.
  if (unit === 'db') return spec.unit === '' ? Math.pow(10, value / 20) : null;

  if (unit in TO_SECONDS && spec.unit in TO_SECONDS) {
    return (value * TO_SECONDS[unit]) / TO_SECONDS[spec.unit];
  }
  if (unit in TO_HZ && spec.unit in TO_HZ) {
    return (value * TO_HZ[unit]) / TO_HZ[spec.unit];
  }
  return null;
}

export function clampToSpec(value: number, spec: ParamSpec): number {
  return Math.min(spec.max, Math.max(spec.min, value));
}

// ------------------------------------------------- knob position <-> value

/** Knob travel (0..1) to a real value, honouring the param's curve. */
export function fromKnob(t: number, spec: ParamSpec): number {
  const c = Math.min(1, Math.max(0, t));
  if (spec.curve === 'exp' && spec.min > 0) {
    return spec.min * Math.pow(spec.max / spec.min, c);
  }
  const shaped = spec.skew && spec.skew !== 1 ? Math.pow(c, spec.skew) : c;
  return spec.min + shaped * (spec.max - spec.min);
}

/** Inverse of {@link fromKnob}. */
export function toKnob(value: number, spec: ParamSpec): number {
  const v = clampToSpec(value, spec);
  if (spec.curve === 'exp' && spec.min > 0) {
    return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  }
  const t = (v - spec.min) / (spec.max - spec.min || 1);
  return spec.skew && spec.skew !== 1 ? Math.pow(t, 1 / spec.skew) : t;
}

/** Round to something that reads well in source text and in the UI. */
export function formatValue(value: number, spec: ParamSpec): string {
  const span = Math.abs(spec.max - spec.min);
  const decimals = span >= 500 ? 0 : span >= 20 ? 1 : span >= 2 ? 2 : 3;
  const fixed = value.toFixed(decimals);
  // Trim trailing zeros but keep at least one digit: 0.500 -> 0.5, 3.00 -> 3
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}
