/**
 * Procedurally grown reverb impulses.
 *
 * Nothing is fetched — an impulse is noise under a decay envelope with a
 * handful of early reflections scattered on top, which is enough to read as a
 * room and costs nothing to ship.
 */

export interface ImpulseOptions {
  /** 0..1. Larger rooms decay later and scatter reflections wider. */
  size: number;
  /** Seconds of tail. */
  decay: number;
  reverse: boolean;
}

/** Impulses are only regenerated when these rounded values actually change. */
export function impulseKey(o: ImpulseOptions): string {
  return `${o.size.toFixed(2)}|${o.decay.toFixed(2)}|${o.reverse ? 1 : 0}`;
}

export function makeImpulse(ctx: BaseAudioContext, options: ImpulseOptions): AudioBuffer {
  const size = Math.min(1, Math.max(0, options.size));
  const decay = Math.min(12, Math.max(0.05, options.decay));
  const sr = ctx.sampleRate;
  const frames = Math.max(1, Math.floor(sr * decay));
  const buffer = ctx.createBuffer(2, frames, sr);

  // A bigger room holds its energy longer before falling away.
  const curve = 2 + (1 - size) * 5;

  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, curve);
    }

    // Early reflections: sparse, louder taps in the first stretch of the tail.
    // They are what stop the noise burst sounding like a cymbal.
    const reflections = 6 + Math.floor(size * 10);
    const window = Math.floor(frames * (0.02 + size * 0.12));
    for (let r = 0; r < reflections; r++) {
      const at = Math.floor(Math.random() * window);
      if (at < frames) data[at] += (Math.random() * 2 - 1) * 0.5 * (1 - at / window);
    }

    // A short fade in stops the impulse starting with a click.
    const fade = Math.min(64, frames);
    for (let i = 0; i < fade; i++) data[i] *= i / fade;

    if (options.reverse) data.reverse();
  }

  return buffer;
}
