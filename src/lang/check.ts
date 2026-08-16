/**
 * Semantic checks against the node registry.
 *
 * Everything here is advisory: the compiler will still build a graph from a
 * program with errors, dropping only the statements it cannot make sense of.
 * A typo in one effect should not silence the whole piece.
 */

import { clampToSpec, getNode, type NodeSpec } from '../audio/fx';
import { makeDiagnostic, type Diagnostic, type Program, type StmtNode } from './ast';
import { resolveValue } from './value';

export interface CheckOptions {
  /** Sample names currently in the library, for "no such sample" warnings. */
  knownSamples?: string[];
}

export function check(program: Program, options: CheckOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const src = program.source;

  const error = (message: string, span: { start: number; end: number }) =>
    diagnostics.push(makeDiagnostic(src, 'error', message, span));
  const warn = (message: string, span: { start: number; end: number }) =>
    diagnostics.push(makeDiagnostic(src, 'warning', message, span));

  if (program.decks.length === 0) {
    warn('Nothing to play yet — add a `deck`', { start: 0, end: Math.min(1, src.length) });
  }

  for (const deck of program.decks) {
    let sources = 0;
    let sawOut = false;

    for (const stmt of deck.stmts) {
      const spec = getNode(stmt.node);

      if (!spec) {
        const suggestion = suggest(stmt.node, stmt.kind);
        error(
          `Unknown ${stmt.kind === 'src' ? 'source' : 'effect'} \`${stmt.node}\`` +
            (suggestion ? `. Did you mean \`${suggestion}\`?` : ''),
          stmt.nodeSpan,
        );
        continue;
      }

      if (spec.kind !== stmt.kind) {
        error(`\`${spec.id}\` is a \`${spec.kind}\`, not a \`${stmt.kind}\``, stmt.nodeSpan);
        continue;
      }

      if (stmt.kind === 'src') {
        sources++;
        if (sources > 1) {
          error('A deck can only have one source; move this to its own deck', stmt.nodeSpan);
        }
      }

      if (sawOut) {
        warn('This runs after `out`, which is the end of the chain', stmt.nodeSpan);
      }
      if (stmt.kind === 'out') sawOut = true;

      checkMode(stmt, spec);
      checkSample(stmt, spec);
      checkParams(stmt, spec);
    }

    if (sources === 0) {
      warn(`Deck \`${deck.name}\` has no \`src\`, so it makes no sound`, deck.nameSpan);
    }
  }

  return diagnostics;

  // ------------------------------------------------------------- helpers

  function checkMode(stmt: StmtNode, spec: NodeSpec) {
    if (!stmt.mode || !stmt.modeSpan) return;
    if (!spec.modes || spec.modes.length === 0) {
      error(`\`${spec.id}\` has no modes, so \`${stmt.mode}\` means nothing here`, stmt.modeSpan);
      return;
    }
    if (!spec.modes.includes(stmt.mode)) {
      error(
        `\`${stmt.mode}\` is not a mode for \`${spec.id}\`. Try ${spec.modes.map((m) => `\`${m}\``).join(', ')}`,
        stmt.modeSpan,
      );
    }
  }

  function checkSample(stmt: StmtNode, spec: NodeSpec) {
    if (!spec.takesSample) {
      if (stmt.sample) {
        error(`\`${spec.id}\` does not take a sample name`, stmt.sample.span);
      }
      return;
    }
    if (!stmt.sample) {
      warn(`\`${spec.id}\` needs a sample name, e.g. \`${stmt.kind} ${spec.id} "my-recording"\``, stmt.nodeSpan);
      return;
    }
    const known = options.knownSamples;
    const name = stmt.sample.str ?? '';
    if (known && known.length > 0 && !known.includes(name)) {
      const near = nearest(name, known);
      warn(
        `No sample called \`${name}\` in the library` + (near ? `. Did you mean \`${near}\`?` : ''),
        stmt.sample.span,
      );
    }
  }

  function checkParams(stmt: StmtNode, spec: NodeSpec) {
    for (const param of stmt.params) {
      const pspec = spec.params.find((x) => x.name === param.name);
      if (!pspec) {
        const near = nearest(
          param.name,
          spec.params.map((x) => x.name),
        );
        error(
          `\`${spec.id}\` has no \`${param.name}\`` + (near ? `. Did you mean \`${near}\`?` : ''),
          param.nameSpan,
        );
        continue;
      }

      const resolved = resolveValue(param.value, pspec, program.tempo);
      if (!resolved.ok) {
        error(resolved.reason, param.value.span);
        continue;
      }

      const clamped = clampToSpec(resolved.value, pspec);
      if (clamped !== resolved.value) {
        warn(
          `\`${param.name}\` clamped to ${clamped}${pspec.unit} (range ${pspec.min}–${pspec.max}${pspec.unit})`,
          param.value.span,
        );
      }
    }
  }
}

// ------------------------------------------------------- did-you-mean

function suggest(name: string, kind: string): string | null {
  const candidates: string[] = [];
  for (const id of ['grain', 'play', 'crush', 'fold', 'ring', 'svf', 'glitch', 'shift', 'freeze', 'delay', 'verb', 'flange', 'trem']) {
    const spec = getNode(id);
    if (spec && spec.kind === kind) candidates.push(id);
  }
  return nearest(name, candidates);
}

function nearest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(name.toLowerCase(), c.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  // Only suggest when it is plausibly a typo rather than a different word.
  const limit = Math.max(2, Math.floor(name.length / 3));
  return best && bestScore <= limit ? best : null;
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
