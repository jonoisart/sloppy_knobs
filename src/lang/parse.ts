/**
 * Recursive-descent parser for `slop`.
 *
 * Never throws. A patch is re-parsed on every keystroke while audio is running,
 * so a half-typed line has to degrade into diagnostics plus whatever statements
 * did parse — not an exception that takes the graph down with it.
 */

import { KEYWORDS, lex, type Token } from './lex';
import {
  makeDiagnostic,
  type DeckNode,
  type Diagnostic,
  type ParamNode,
  type Program,
  type Span,
  type StmtKind,
  type StmtNode,
  type ValueNode,
} from './ast';

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
}

const STMT_KEYWORDS = new Set<StmtKind>(['src', 'fx', 'out']);

export function parse(source: string): ParseResult {
  const { tokens, errors } = lex(source);
  const diagnostics: Diagnostic[] = errors.map((e) =>
    makeDiagnostic(source, 'error', e.message, e.span),
  );

  let pos = 0;
  const peek = (offset = 0): Token => tokens[Math.min(pos + offset, tokens.length - 1)];
  const at = (value: string) => peek().type !== 'eof' && peek().value === value;
  const done = () => peek().type === 'eof';
  const next = (): Token => tokens[pos++];

  const err = (message: string, span: Span) =>
    diagnostics.push(makeDiagnostic(source, 'error', message, span));

  const warn = (message: string, span: Span) =>
    diagnostics.push(makeDiagnostic(source, 'warning', message, span));

  function parseValue(): ValueNode | null {
    const t = peek();
    switch (t.type) {
      case 'number':
        next();
        return { kind: 'number', raw: t.raw, span: t.span, num: t.num, unit: t.unit };
      case 'ratio':
        next();
        return { kind: 'ratio', raw: t.raw, span: t.span, num: t.num, ratio: t.ratio };
      case 'string':
        next();
        return { kind: 'string', raw: t.raw, span: t.span, str: t.value };
      case 'word':
        next();
        return { kind: 'word', raw: t.raw, span: t.span, word: t.value };
      default:
        err('Expected a value', t.span);
        return null;
    }
  }

  /** A `name=` pair ahead? Used to tell params from bare words. */
  const looksLikeParam = () =>
    peek().type === 'word' && !KEYWORDS.has(peek().value) && peek(1).value === '=';

  function parseStmt(deckName: string, index: number): StmtNode | null {
    const keyword = next();
    const kind = keyword.value as StmtKind;
    const start = keyword.span.start;

    let node = 'out';
    let nodeSpan = keyword.span;

    if (kind !== 'out') {
      if (peek().type !== 'word' || KEYWORDS.has(peek().value)) {
        err(`\`${kind}\` needs a node name, e.g. \`${kind} ${kind === 'src' ? 'grain' : 'crush'}\``, keyword.span);
        return null;
      }
      const nameTok = next();
      node = nameTok.value;
      nodeSpan = nameTok.span;
    }

    let mode: string | undefined;
    let modeSpan: Span | undefined;
    let sample: ValueNode | undefined;

    // Optional bare-word mode and quoted sample, in either order.
    for (;;) {
      if (peek().type === 'string' && !sample) {
        const t = next();
        sample = { kind: 'string', raw: t.raw, span: t.span, str: t.value };
        continue;
      }
      if (peek().type === 'word' && !KEYWORDS.has(peek().value) && peek(1).value !== '=' && !mode) {
        const t = next();
        mode = t.value;
        modeSpan = t.span;
        continue;
      }
      break;
    }

    const params: ParamNode[] = [];
    const seen = new Set<string>();
    while (looksLikeParam()) {
      const nameTok = next();
      next(); // `=`
      const value = parseValue();
      if (!value) break;
      if (seen.has(nameTok.value)) {
        warn(`Duplicate \`${nameTok.value}\`; the last one wins`, nameTok.span);
      }
      seen.add(nameTok.value);
      params.push({
        name: nameTok.value,
        nameSpan: nameTok.span,
        value,
        span: { start: nameTok.span.start, end: value.span.end },
      });
    }

    const end = params.length
      ? params[params.length - 1].span.end
      : sample
        ? sample.span.end
        : (modeSpan ?? nodeSpan).end;

    return {
      kind,
      node,
      nodeSpan,
      mode,
      modeSpan,
      sample,
      params,
      span: { start, end },
      id: `${deckName}#${index}:${node}`,
    };
  }

  function parseDeck(): DeckNode | null {
    const keyword = next(); // `deck`
    if (peek().type !== 'word' && peek().type !== 'string') {
      err('Expected a deck name, e.g. `deck vox { ... }`', keyword.span);
      return null;
    }
    const nameTok = next();

    if (!at('{')) {
      err(`Expected \`{\` after deck \`${nameTok.value}\``, peek().span);
      return null;
    }
    const open = next();

    const stmts: StmtNode[] = [];
    while (!done() && !at('}')) {
      if (peek().type === 'word' && STMT_KEYWORDS.has(peek().value as StmtKind)) {
        const stmt = parseStmt(nameTok.value, stmts.length);
        if (stmt) stmts.push(stmt);
        else resyncInDeck();
      } else {
        err('Expected `src`, `fx` or `out`', peek().span);
        resyncInDeck();
      }
    }

    if (done()) {
      err(`Deck \`${nameTok.value}\` is missing its closing \`}\``, peek().span);
    }
    const close = at('}') ? next() : peek();

    return {
      name: nameTok.value,
      nameSpan: nameTok.span,
      stmts,
      span: { start: keyword.span.start, end: close.span.end },
      bodySpan: { start: open.span.end, end: close.span.start },
    };
  }

  /** Skip junk until something we can start a statement from. */
  function resyncInDeck() {
    while (!done() && !at('}')) {
      if (peek().type === 'word' && STMT_KEYWORDS.has(peek().value as StmtKind)) return;
      next();
    }
  }

  const decks: DeckNode[] = [];
  let tempo = 120;
  let tempoSpan: Span | undefined;

  while (!done()) {
    if (at('tempo')) {
      next();
      if (peek().type === 'number') {
        const t = next();
        tempo = t.num ?? 120;
        tempoSpan = t.span;
        if (tempo < 20 || tempo > 400) {
          warn('Tempo outside 20–400 BPM', t.span);
          tempo = Math.min(400, Math.max(20, tempo));
        }
      } else {
        err('`tempo` needs a number, e.g. `tempo 92`', peek().span);
      }
      continue;
    }

    if (at('deck')) {
      const deck = parseDeck();
      if (deck) {
        if (decks.some((d) => d.name === deck.name)) {
          err(`Duplicate deck \`${deck.name}\``, deck.nameSpan);
        }
        decks.push(deck);
      }
      continue;
    }

    err('Expected `deck` or `tempo`', peek().span);
    // Resync at the next top-level keyword so one stray token does not cascade.
    while (!done() && !at('deck') && !at('tempo')) next();
  }

  return { program: { tempo, tempoSpan, decks, source }, diagnostics };
}
