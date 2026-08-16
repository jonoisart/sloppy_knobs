/**
 * Waveform peak extraction.
 *
 * Drawing every sample of a three-minute recording is pointless and slow, so
 * the buffer is reduced to one min/max pair per horizontal pixel once, and the
 * result is cached against the buffer.
 */

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  buckets: number;
}

const cache = new WeakMap<AudioBuffer, Map<number, Peaks>>();

export function computePeaks(buffer: AudioBuffer, buckets: number): Peaks {
  const b = Math.max(1, Math.floor(buckets));
  let perBuffer = cache.get(buffer);
  if (!perBuffer) {
    perBuffer = new Map();
    cache.set(buffer, perBuffer);
  }
  const hit = perBuffer.get(b);
  if (hit) return hit;

  const min = new Float32Array(b);
  const max = new Float32Array(b);
  const frames = buffer.length;
  const step = frames / b;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < b; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(frames, Math.floor((i + 1) * step));
    let lo = 0;
    let hi = 0;
    for (let j = start; j < end; j++) {
      // Peak across channels, so a hard-panned transient still shows up.
      for (let c = 0; c < channels.length; c++) {
        const v = channels[c][j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[i] = lo;
    max[i] = hi;
  }

  const peaks = { min, max, buckets: b };
  perBuffer.set(b, peaks);
  return peaks;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
