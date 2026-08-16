/**
 * A knob bound to a span of source text.
 *
 * It holds no value of its own — it renders whatever the compiled program says
 * and reports changes upward, where they are written back into the patch. Drag
 * vertically; hold shift for fine control; arrow keys work too.
 */

import { useCallback, useId, useRef, useState } from 'react';
import { formatValue, fromKnob, toKnob, type ParamSpec } from '../audio/fx';

export interface KnobProps {
  spec: ParamSpec;
  value: number;
  onChange: (value: number) => void;
  /** Written explicitly in the patch, rather than running on its default. */
  written?: boolean;
  size?: number;
}

const START_ANGLE = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, degrees: number) {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const start = polar(cx, cy, r, from);
  const end = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

export function Knob({ spec, value, onChange, written = false, size = 54 }: KnobProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ y: 0, t: 0 });
  const labelId = useId();

  const t = toKnob(value, spec);
  const angle = START_ANGLE + t * SWEEP;
  const r = size / 2 - 6;
  const c = size / 2;

  const commit = useCallback(
    (next: number) => onChange(Math.min(spec.max, Math.max(spec.min, next))),
    [onChange, spec.max, spec.min],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, t };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging) return;
    // A full sweep takes 200px of travel, or 800px with shift held.
    const travel = e.shiftKey ? 800 : 200;
    const next = drag.current.t + (drag.current.y - e.clientY) / travel;
    commit(fromKnob(Math.min(1, Math.max(0, next)), spec));
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.002 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      commit(fromKnob(Math.min(1, t + step), spec));
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      commit(fromKnob(Math.max(0, t - step), spec));
    } else if (e.key === 'Home') {
      commit(spec.def);
    } else {
      return;
    }
    e.preventDefault();
  };

  const readout = `${formatValue(value, spec)}${spec.unit === '%' ? '%' : spec.unit}`;

  return (
    <div className={`knob ${written ? 'is-written' : ''} ${dragging ? 'is-dragging' : ''}`}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="slider"
        tabIndex={0}
        aria-labelledby={labelId}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={Number(value.toFixed(4))}
        aria-valuetext={`${spec.label} ${readout}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(spec.def)}
      >
        <path className="knob-track" d={arcPath(c, c, r, START_ANGLE, START_ANGLE + SWEEP)} />
        <path className="knob-fill" d={arcPath(c, c, r, START_ANGLE, Math.max(START_ANGLE + 0.01, angle))} />
        <line
          className="knob-pointer"
          x1={c}
          y1={c}
          x2={polar(c, c, r - 3, angle).x}
          y2={polar(c, c, r - 3, angle).y}
        />
        <circle className="knob-hub" cx={c} cy={c} r={3} />
      </svg>
      <span className="knob-label" id={labelId} title={spec.hint}>
        {spec.label}
      </span>
      <span className="knob-value">{readout}</span>
    </div>
  );
}

export interface SwitchProps {
  spec: ParamSpec;
  value: number;
  onChange: (value: number) => void;
  written?: boolean;
}

/** Toggle params get a switch instead of a knob — a knob with two positions is a lie. */
export function Switch({ spec, value, onChange, written = false }: SwitchProps) {
  const on = value >= 0.5;
  return (
    <div className={`knob knob-switch ${written ? 'is-written' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`switch ${on ? 'is-on' : ''}`}
        onClick={() => onChange(on ? spec.min : spec.max)}
        title={spec.hint}
      >
        <span className="switch-dot" />
      </button>
      <span className="knob-label">{spec.label}</span>
      <span className="knob-value">{on ? 'on' : 'off'}</span>
    </div>
  );
}
