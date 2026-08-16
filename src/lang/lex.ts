/**
 * Tokenizer for `slop`.
 *
 * Whitespace-insensitive: statements are delimited by the next keyword or a
 * closing brace rather than by newlines, so the user can lay a patch out
 * however they like without the parser caring.
 */

import type { Span } from './ast';
import type { Unit } from '../audio/fx';

export type TokenType = 'word' | 'number' | 'ratio' | 'string' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  /** Exact source text. */
  raw: string;
  span: Span;
  /** word/punct: the text. string: contents without quotes. */
  value: string;
  /** number/ratio only. */
  num?: number;
  unit?: Unit;
  ratio?: [number, number];
}

export const KEYWORDS = new Set(['deck', 'tempo', 'src', 'fx', 'out']);

/** Longest-first so `khz` wins over `hz` and `ms` over `s`. */
const UNITS: Unit[] = ['khz', 'hz', 'ms', 'db', 'st', 's', '%'];

const isDigit = (c: string) => c >= '0' && c <= '9';
const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_\-]/.test(c);

export interface LexResult {
  tokens: Token[];
  errors: { message: string; span: Span }[];
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const errors: { message: string; span: Span }[] = [];
  let i = 0;
  const n = source.length;

  const push = (t: Token) => tokens.push(t);

  while (i < n) {
    const c = source[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    // Comments: `#` or `//` to end of line
    if (c === '#' || (c === '/' && source[i + 1] === '/')) {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Strings
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i++;
      let str = '';
      let closed = false;
      while (i < n) {
        if (source[i] === '\\' && i + 1 < n) {
          str += source[i + 1];
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          closed = true;
          break;
        }
        if (source[i] === '\n') break;
        str += source[i];
        i++;
      }
      const span = { start, end: i };
      if (!closed) errors.push({ message: 'Unterminated string', span });
      push({ type: 'string', raw: source.slice(start, i), span, value: str });
      continue;
    }

    // Numbers, ratios, and negative numbers
    if (isDigit(c) || (c === '-' && isDigit(source[i + 1])) || (c === '.' && isDigit(source[i + 1]))) {
      const start = i;
      if (source[i] === '-') i++;
      while (i < n && isDigit(source[i])) i++;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i++;
        while (i < n && isDigit(source[i])) i++;
      }
      const headText = source.slice(start, i);
      const head = parseFloat(headText);

      // Ratio: `3/8`, tempo-relative. Only when both sides are bare integers.
      if (source[i] === '/' && isDigit(source[i + 1])) {
        const slash = i;
        i++;
        while (i < n && isDigit(source[i])) i++;
        const den = parseFloat(source.slice(slash + 1, i));
        const span = { start, end: i };
        if (den === 0) {
          errors.push({ message: 'Ratio cannot divide by zero', span });
        }
        push({
          type: 'ratio',
          raw: source.slice(start, i),
          span,
          value: source.slice(start, i),
          num: den === 0 ? 0 : head / den,
          ratio: [head, den],
        });
        continue;
      }

      // Unit suffix, only when glued directly to the digits.
      let unit: Unit = '';
      for (const u of UNITS) {
        if (source.startsWith(u, i)) {
          // `0.5s` is a unit; `0.5 speed` is not. Reject if more word
          // characters follow, which means we are looking at an identifier.
          const after = source[i + u.length];
          if (u === '%' || !after || !isWordChar(after)) {
            unit = u;
            i += u.length;
            break;
          }
        }
      }

      const span = { start, end: i };
      push({ type: 'number', raw: source.slice(start, i), span, value: headText, num: head, unit });
      continue;
    }

    // Identifiers and keywords
    if (isWordStart(c)) {
      const start = i;
      while (i < n && isWordChar(source[i])) i++;
      const raw = source.slice(start, i);
      push({ type: 'word', raw, span: { start, end: i }, value: raw });
      continue;
    }

    // Punctuation
    if (c === '{' || c === '}' || c === '=') {
      push({ type: 'punct', raw: c, span: { start: i, end: i + 1 }, value: c });
      i++;
      continue;
    }

    errors.push({ message: `Unexpected character ${JSON.stringify(c)}`, span: { start: i, end: i + 1 } });
    i++;
  }

  push({ type: 'eof', raw: '', span: { start: n, end: n }, value: '' });
  return { tokens, errors };
}
