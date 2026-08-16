/**
 * The whole front end in one call: text in, diagnostics and a graph description
 * out. The app never runs these stages separately, so this is the only entry
 * point the UI needs to know about.
 */

import { check, type CheckOptions } from './check';
import { compile, type CompiledProgram } from './compile';
import { parse } from './parse';
import type { Diagnostic, Program } from './ast';

export * from './ast';
export * from './compile';
export { parse } from './parse';
export { check } from './check';
export { secondsPerBar } from './value';

export interface EvalResult {
  program: Program;
  compiled: CompiledProgram;
  diagnostics: Diagnostic[];
  /** Errors block nothing, but the UI dims the transport when any are present. */
  hasErrors: boolean;
}

export function evaluate(source: string, options: CheckOptions = {}): EvalResult {
  const { program, diagnostics: parseErrors } = parse(source);
  const semantic = check(program, options);
  const diagnostics = [...parseErrors, ...semantic].sort((a, b) => a.span.start - b.span.start);
  return {
    program,
    compiled: compile(program),
    diagnostics,
    hasErrors: diagnostics.some((d) => d.severity === 'error'),
  };
}

export const STARTER_PATCH = `# sloppy_knobs — everything here is live. Turn a knob, the text changes.
tempo 92

deck vox {
  src grain "voice-note" speed=0.25 grain=180ms dens=30 pitch=-5 spray=0.4
  fx  svf lp cutoff=900 res=0.55 drive=2
  fx  shift st=-12 win=90ms fb=0.35 mix=0.4
  fx  delay time=3/8 fb=0.6 wobble=0.3 mix=0.35
  fx  verb size=0.8 decay=6s mix=0.45
  out gain=0.9 pan=-0.2
}

deck grit {
  src grain "voice-note" speed=-0.4 grain=40ms dens=60 rev=0.5 spray=1.2
  fx  crush bits=5 rate=6 mix=0.8
  fx  fold drive=4 bias=0.2 mix=0.6
  fx  glitch slice=90ms chance=0.4 rev=0.3
  out gain=0.5 pan=0.4
}
`;
