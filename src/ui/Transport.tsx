/**
 * Transport, master level and the oscilloscope.
 *
 * The record button captures the master bus — everything you hear, including
 * whatever you do to the knobs while it runs — and hands back a WAV.
 */

import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { formatDuration } from '../audio/peaks';
import { useStudio } from '../state/context';

function Scope() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { ready } = useStudio();

  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = new Float32Array(1024);
    let frame = 0;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 240;
      const height = canvas.clientHeight || 48;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      engine.scope(data);

      ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--wave').trim() || '#7de3c3';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const step = data.length / width;
      for (let x = 0; x < width; x++) {
        const v = data[Math.floor(x * step)] ?? 0;
        const y = height / 2 - v * (height / 2) * 0.9;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  return <canvas className="scope" ref={canvasRef} aria-hidden="true" />;
}

function Meter() {
  const [level, setLevel] = useState({ peak: 0, rms: 0 });
  const { ready } = useStudio();

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const tick = () => {
      setLevel(engine.levels());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  return (
    <div className="meter" title="master level">
      <div className="meter-rms" style={{ width: `${Math.min(100, level.rms * 160)}%` }} />
      <div className={`meter-peak ${level.peak > 0.99 ? 'is-clipping' : ''}`} style={{ left: `${Math.min(100, level.peak * 100)}%` }} />
    </div>
  );
}

export function Transport() {
  const { ready, playing, togglePlay, recording, toggleRecord, masterGain, setMasterGain, chaos, evaluated } =
    useStudio();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const id = window.setInterval(() => setElapsed(engine.recordedSeconds), 200);
    return () => window.clearInterval(id);
  }, [recording]);

  const deckCount = evaluated.compiled.decks.length;

  return (
    <div className="transport">
      <button
        type="button"
        className={`transport-play ${playing ? 'is-playing' : ''}`}
        onClick={togglePlay}
        disabled={!ready || deckCount === 0}
      >
        {playing ? '■ stop' : '▶ play'}
      </button>

      <button
        type="button"
        className={`transport-record ${recording ? 'is-recording' : ''}`}
        onClick={() => void toggleRecord()}
        disabled={!ready}
        title="Record the master bus to a WAV"
      >
        {recording ? `● ${formatDuration(elapsed)}` : '● record'}
      </button>

      <button type="button" onClick={() => chaos()} disabled={deckCount === 0} title="Randomise every deck">
        chaos
      </button>

      <label className="master">
        <span>master</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={masterGain}
          onChange={(e) => setMasterGain(Number(e.target.value))}
          aria-label="Master gain"
        />
      </label>

      <Meter />
      <Scope />
    </div>
  );
}
