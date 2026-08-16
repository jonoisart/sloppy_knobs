import { describe, expect, it } from 'vitest';
import {
  appendStatement,
  evaluate,
  parse,
  patchValue,
  removeParam,
  renderValue,
  STARTER_PATCH,
  upsertParam,
} from './index';
import { getParam } from '../audio/fx';
import { secondsPerBar } from './value';

const findStmt = (source: string, node: string) => {
  const { program } = parse(source);
  for (const deck of program.decks) {
    const stmt = deck.stmts.find((s) => s.node === node);
    if (stmt) return stmt;
  }
  throw new Error(`no statement for ${node}`);
};

describe('lexing values', () => {
  it('reads units glued to numbers but not identifiers that merely start with one', () => {
    const { program } = parse('deck d { src grain "x" grain=180ms spray=0.4 }');
    const stmt = program.decks[0].stmts[0];
    expect(stmt.params[0].value.unit).toBe('ms');
    expect(stmt.params[0].value.num).toBe(180);
    // `spray` begins with `s`, which must not be eaten as a seconds suffix.
    expect(stmt.params[1].name).toBe('spray');
    expect(stmt.params[1].value.unit).toBe('');
  });

  it('reads negative numbers and ratios', () => {
    const stmt = findStmt('deck d { fx delay time=3/8 } ', 'delay');
    expect(stmt.params[0].value.kind).toBe('ratio');
    expect(stmt.params[0].value.ratio).toEqual([3, 8]);

    const grain = findStmt('deck d { src grain "x" pitch=-5 }', 'grain');
    expect(grain.params[0].value.num).toBe(-5);
  });

  it('ignores comments in both styles', () => {
    const { diagnostics } = evaluate('# hi\n// there\ndeck d { src grain "x" }');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('parsing structure', () => {
  it('reads modes and samples in either order', () => {
    const a = findStmt('deck d { fx svf lp cutoff=800 }', 'svf');
    expect(a.mode).toBe('lp');
    expect(a.params[0].name).toBe('cutoff');

    const b = findStmt('deck d { src grain "vox" speed=1 }', 'grain');
    expect(b.sample?.str).toBe('vox');
  });

  it('does not mistake the next statement keyword for a mode', () => {
    // `fx freeze` has no params, so the parser must not swallow the following
    // `fx` as this statement's bare-word mode.
    const { program } = parse('deck d { fx freeze fx delay time=1 }');
    const stmts = program.decks[0].stmts;
    expect(stmts).toHaveLength(2);
    expect(stmts[0].node).toBe('freeze');
    expect(stmts[0].mode).toBeUndefined();
    expect(stmts[1].node).toBe('delay');
  });

  it('recovers from a bad statement instead of losing the rest of the deck', () => {
    const { program, diagnostics } = parse('deck d { !!! fx crush bits=4 }');
    expect(diagnostics.some((x) => x.severity === 'error')).toBe(true);
    expect(program.decks[0].stmts.map((s) => s.node)).toContain('crush');
  });

  it('never throws on truncated or garbage input', () => {
    const inputs = ['deck', 'deck d {', 'deck d { fx', 'fx crush bits=', '}}}{{{', 'tempo', '"'];
    for (const input of inputs) {
      expect(() => evaluate(input)).not.toThrow();
    }
  });
});

describe('checking', () => {
  it('flags unknown nodes and params with a suggestion', () => {
    const { diagnostics } = evaluate('deck d { src grain "x" fx crsh bits=4 }');
    const msg = diagnostics.find((x) => x.message.includes('crsh'))?.message ?? '';
    expect(msg).toContain('crush');

    const p = evaluate('deck d { src grain "x" fx crush bts=4 }');
    expect(p.diagnostics.find((x) => x.message.includes('bts'))?.message).toContain('bits');
  });

  it('rejects units that do not apply and accepts ones that do', () => {
    expect(evaluate('deck d { src grain "x" fx svf cutoff=6db }').hasErrors).toBe(true);
    expect(evaluate('deck d { src grain "x" fx svf cutoff=6khz }').hasErrors).toBe(false);
  });

  it('reports position on the right line', () => {
    const { diagnostics } = evaluate('deck d {\n  src grain "x"\n  fx nope\n}');
    const d = diagnostics.find((x) => x.message.includes('nope'));
    expect(d?.line).toBe(3);
  });

  it('warns rather than errors when a value is out of range', () => {
    const { diagnostics, hasErrors } = evaluate('deck d { src grain "x" fx crush bits=999 }');
    expect(hasErrors).toBe(false);
    expect(diagnostics.some((x) => x.severity === 'warning' && x.message.includes('clamped'))).toBe(true);
  });

  it('warns about a sample the library does not have', () => {
    const { diagnostics } = evaluate('deck d { src grain "ghost" }', { knownSamples: ['ghosts'] });
    expect(diagnostics.find((x) => x.message.includes('ghost'))?.message).toContain('ghosts');
  });
});

describe('compiling', () => {
  it('fills defaults and converts to canonical units', () => {
    const { compiled } = evaluate('deck d { src grain "x" fx svf cutoff=2khz }');
    const svf = compiled.decks[0].fx[0];
    expect(svf.params.cutoff).toBe(2000);
    expect(svf.params.res).toBe(getParam('svf', 'res')!.def);
  });

  it('resolves bar ratios against the tempo', () => {
    const { compiled } = evaluate('tempo 120\ndeck d { src grain "x" fx delay time=3/8 }');
    expect(compiled.decks[0].fx[0].params.time).toBeCloseTo(0.375 * secondsPerBar(120), 6);
  });

  it('skips statements the checker rejected instead of dropping the deck', () => {
    const { compiled } = evaluate('deck d { src grain "x" fx nope a=1 fx crush bits=4 }');
    expect(compiled.decks[0].fx.map((f) => f.node)).toEqual(['crush']);
  });

  it('drops a second source rather than building an ambiguous chain', () => {
    const { compiled } = evaluate('deck d { src grain "a" src play "b" }');
    expect(compiled.decks[0].source?.sample).toBe('a');
  });
});

describe('editing source through spans', () => {
  it('rewrites one value and leaves everything else byte-identical', () => {
    const source = 'deck d {\n  # keep me\n  fx svf lp    cutoff=800   res=0.5\n}';
    const stmt = findStmt(source, 'svf');
    const cutoff = stmt.params.find((p) => p.name === 'cutoff')!;
    const out = patchValue(source, cutoff.value.span, '1200');

    expect(out).toBe('deck d {\n  # keep me\n  fx svf lp    cutoff=1200   res=0.5\n}');
    expect(out).toContain('# keep me');
  });

  it('preserves the unit the user wrote', () => {
    const source = 'deck d { src grain "x" grain=180ms }';
    const stmt = findStmt(source, 'grain');
    const p = stmt.params[0];
    const out = patchValue(source, p.value.span, renderValue(240, p.value));
    expect(out).toContain('grain=240ms');
  });

  it('appends a param that was running on its default', () => {
    const source = 'deck d {\n  fx crush bits=4\n}';
    const stmt = findStmt(source, 'crush');
    const out = upsertParam(source, stmt, 'mix', '0.5');
    expect(out).toContain('fx crush bits=4 mix=0.5');
    // And is idempotent: a second turn of the same knob rewrites in place.
    const stmt2 = findStmt(out, 'crush');
    expect(upsertParam(out, stmt2, 'mix', '0.7')).toContain('bits=4 mix=0.7');
  });

  it('removes a param along with its leading whitespace', () => {
    const source = 'deck d {\n  fx crush bits=4 mix=0.5\n}';
    const out = removeParam(source, findStmt(source, 'crush'), 'mix');
    expect(out).toBe('deck d {\n  fx crush bits=4\n}');
  });

  it('appends a statement using the deck’s own indentation', () => {
    const source = 'deck d {\n    src grain "x"\n}';
    const { program } = parse(source);
    const out = appendStatement(source, program.decks[0], 'out gain=0.8');
    expect(out).toBe('deck d {\n    src grain "x"\n    out gain=0.8\n}');
  });

  it('survives a full edit round trip on the starter patch', () => {
    let source = STARTER_PATCH;
    for (let i = 0; i < 40; i++) {
      const stmt = findStmt(source, 'svf');
      const cutoff = stmt.params.find((p) => p.name === 'cutoff')!;
      source = patchValue(source, cutoff.value.span, String(400 + i * 20));
      expect(evaluate(source).hasErrors).toBe(false);
    }
    expect(evaluate(source).compiled.decks[0].fx[0].params.cutoff).toBe(1180);
    expect(source).toContain('# sloppy_knobs');
  });
});

describe('diffing for live patching', () => {
  it('patches a param change without a rebuild', async () => {
    const { diff } = await import('./compile');
    const a = evaluate('deck d { src grain "x" fx svf cutoff=800 }').compiled;
    const b = evaluate('deck d { src grain "x" fx svf cutoff=900 }').compiled;
    const d = diff(a, b);
    expect(d.rebuild).toBe(false);
    expect(d.params).toContainEqual({ nodeId: 'd#1:svf', param: 'cutoff', value: 900 });
  });

  it('rebuilds when the chain changes shape', async () => {
    const { diff } = await import('./compile');
    const a = evaluate('deck d { src grain "x" fx svf cutoff=800 }').compiled;
    const b = evaluate('deck d { src grain "x" fx crush bits=4 fx svf cutoff=800 }').compiled;
    expect(diff(a, b).rebuild).toBe(true);
  });

  it('treats a mode swap as a patch, not a rebuild', async () => {
    const { diff } = await import('./compile');
    const a = evaluate('deck d { src grain "x" fx svf lp cutoff=800 }').compiled;
    const b = evaluate('deck d { src grain "x" fx svf hp cutoff=800 }').compiled;
    const d = diff(a, b);
    expect(d.rebuild).toBe(false);
    expect(d.modes).toContainEqual({ nodeId: 'd#1:svf', mode: 'hp' });
  });
});
