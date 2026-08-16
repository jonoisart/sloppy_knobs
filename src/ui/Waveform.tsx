/**
 * Waveform display with finger scrubbing.
 *
 * Dragging across it puts the deck's grain cloud into scrub mode, so the
 * playhead follows the finger and the sample is smeared rather than seeked —
 * which is the whole point of a grain cloud.
 */

import { useEffect, useRef, useState } from 'react';
import { computePeaks, formatDuration } from '../audio/peaks';
import { engine } from '../audio/engine';
import { useStudio } from '../state/context';

export interface WaveformProps {
  deckName: string;
  sample?: string;
  height?: number;
}

export function Waveform({ deckName, sample, height = 72 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const { positions, graph } = useStudio();
  const position = positions[deckName] ?? 0;
  const buffer = sample ? engine.getSample(sample) : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 300;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(canvas);
    const wave = styles.getPropertyValue('--wave').trim() || '#7de3c3';
    const head = styles.getPropertyValue('--playhead').trim() || '#ff5f6d';

    const mid = height / 2;

    if (!buffer) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(width, mid);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const peaks = computePeaks(buffer, Math.floor(width));
    ctx.fillStyle = wave;
    for (let x = 0; x < peaks.buckets; x++) {
      const top = mid - peaks.max[x] * mid * 0.95;
      const bottom = mid - peaks.min[x] * mid * 0.95;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }

    ctx.strokeStyle = head;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const px = Math.round(position * width);
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  }, [buffer, height, position]);

  const positionFrom = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!graph) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrubbing(true);
    graph.scrub(deckName, true);
    graph.scrubTo(deckName, positionFrom(e));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing || !graph) return;
    graph.scrubTo(deckName, positionFrom(e));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing || !graph) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setScrubbing(false);
    graph.scrub(deckName, false);
  };

  return (
    <div
      className={`waveform ${scrubbing ? 'is-scrubbing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={buffer ? 'Drag to scrub' : undefined}
    >
      <canvas ref={canvasRef} style={{ height }} />
      <div className="waveform-meta">
        <span>{sample ?? 'no sample'}</span>
        {buffer && <span>{formatDuration(buffer.duration)}</span>}
      </div>
    </div>
  );
}
