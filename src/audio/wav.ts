/**
 * WAV encoding for the recorder.
 *
 * The recorder worklet hands back raw float frames; this turns them into a
 * file the user can keep. 16-bit PCM by default because it opens everywhere.
 */

export type BitDepth = 16 | 32;

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: BitDepth = 16,
): Blob {
  const nCh = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = nCh * bytesPerSample;
  const dataBytes = frames * blockAlign;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  // 1 = integer PCM, 3 = IEEE float
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, nCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  if (bitDepth === 32) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        view.setFloat32(offset, channels[c][i] ?? 0, true);
        offset += 4;
      }
    }
  } else {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
        // Asymmetric scaling: the negative side has one more step than the
        // positive, and using 32768 on both would clip full-scale peaks.
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/** Join the recorder's per-chunk frames into one array per channel. */
export function concatChunks(chunks: Float32Array[][], nCh: number): Float32Array[] {
  const total = chunks.reduce((sum, chunk) => sum + (chunk[0]?.length ?? 0), 0);
  const out: Float32Array[] = [];
  for (let c = 0; c < nCh; c++) {
    const merged = new Float32Array(total);
    let at = 0;
    for (const chunk of chunks) {
      const data = chunk[Math.min(c, chunk.length - 1)];
      if (data) {
        merged.set(data, at);
        at += data.length;
      }
    }
    out.push(merged);
  }
  return out;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function timestampName(prefix = 'sloppy'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.wav`;
}
