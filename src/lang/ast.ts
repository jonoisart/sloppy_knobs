/**
 * AST for `slop`, plus the source-splicing helpers the UI edits through.
 *
 * Every node carries the exact byte range it came from. That is what lets a
 * knob rewrite one number in place instead of re-printing the document, so a
 * user's comments, alignment and blank lines survive being twiddled at.
 */

import type { Unit } from '../audio/fx';

export interface Span {
  start: number;
  end: number;
}

export type ValueKind = 'number' | 'string' | 'ratio' | 'word';

export interface ValueNode {
  kind: ValueKind;
  /** Exact source text, e.g. `180ms` or `3/8`. */
  raw: string;
  span: Span;
  /** number: the written magnitude. ratio: numerator/denominator resolved. */
  num?: number;
  unit?: Unit;
  /** ratio only, kept for re-rendering. */
  ratio?: [number, number];
  /** string only, with quotes removed. */
  str?: string;
  /** word only, e.g. `on`. */
  word?: string;
}

export interface ParamNode {
  name: string;
  nameSpan: Span;
  value: ValueNode;
  /** Covers `name=value` as a unit, so a param can be deleted cleanly. */
  span: Span;
}

export type StmtKind = 'src' | 'fx' | 'out';

export interface StmtNode {
  kind: StmtKind;
  /** Registry node id: `grain`, `crush`, `out`. */
  node: string;
  nodeSpan: Span;
  mode?: string;
  modeSpan?: Span;
  sample?: ValueNode;
  params: ParamNode[];
  span: Span;
  /** Stable within one parse; used to bind UI elements and diff the graph. */
  id: string;
}

export interface DeckNode {
  name: string;
  nameSpan: Span;
  stmts: StmtNode[];
  /** Whole `deck x { ... }` block. */
  span: Span;
  /** Interior of the braces, for appending statements. */
  bodySpan: Span;
}

export interface Program {
  tempo: number;
  tempoSpan?: Span;
  decks: DeckNode[];
  source: string;
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  message: string;
  span: Span;
  line: number;
  col: number;
}

// ------------------------------------------------------------ positions

export function lineColAt(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') {
      line++;
      last = i + 1;
    }
  }
  return { line, col: offset - last + 1 };
}

export function makeDiagnostic(
  source: string,
  severity: Severity,
  message: string,
  span: Span,
): Diagnostic {
  const { line, col } = lineColAt(source, span.start);
  return { severity, message, span, line, col };
}

// --------------------------------------------------------------- editing

/** Replace exactly one span. The whole point of tracking spans. */
export function patchValue(source: string, span: Span, text: string): string {
  return source.slice(0, span.start) + text + source.slice(span.end);
}

/**
 * Set a param on a statement, whether or not it is currently written.
 *
 * Present: rewrite just the value. Absent (running on its registry default):
 * append `name=value` to the end of the statement, matching the spacing the
 * statement already uses.
 */
export function upsertParam(
  source: string,
  stmt: StmtNode,
  name: string,
  text: string,
): string {
  const existing = stmt.params.find((p) => p.name === name);
  if (existing) return patchValue(source, existing.value.span, text);

  const insertAt = stmt.span.end;
  const before = source.slice(0, insertAt);
  // Reuse the separator already in play so appended params line up with the
  // hand-written ones rather than always falling back to a single space.
  const sep = /\n[ \t]*$/.test(before) ? '' : ' ';
  return patchValue(source, { start: insertAt, end: insertAt }, `${sep}${name}=${text}`);
}

/** Remove `name=value` and the whitespace that preceded it. */
export function removeParam(source: string, stmt: StmtNode, name: string): string {
  const existing = stmt.params.find((p) => p.name === name);
  if (!existing) return source;
  let start = existing.span.start;
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start--;
  return patchValue(source, { start, end: existing.span.end }, '');
}

/**
 * Append a statement inside a deck's braces, matching the indentation the deck
 * already uses. Needed when the UI edits something the source never mentioned —
 * dragging a fader on a deck that has no `out` line, for instance.
 */
export function appendStatement(source: string, deck: DeckNode, text: string): string {
  const body = source.slice(deck.bodySpan.start, deck.bodySpan.end);
  const indent = body.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
  const trailing = body.match(/\n[ \t]*$/) ? '' : '\n';
  const at = deck.bodySpan.end;
  return patchValue(source, { start: at, end: at }, `${trailing}${indent}${text}\n`);
}

/** Render a value back to source text, preserving the unit the user wrote. */
export function renderValue(value: number, previous?: ValueNode): string {
  if (previous?.kind === 'number' && previous.unit) {
    return `${trimNumber(value)}${previous.unit}`;
  }
  return trimNumber(value);
}

export function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed === '' || trimmed === '-' || trimmed === '-0' ? '0' : trimmed;
}
