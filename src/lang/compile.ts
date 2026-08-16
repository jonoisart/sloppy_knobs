/**
 * AST → a description the audio graph can build, plus the diff that decides
 * whether an edit can be patched into the running graph or needs a rebuild.
 *
 * Patching matters: retyping a digit in `cutoff=1200` should slide the filter,
 * not tear down and re-create every node in the deck and drop the audio.
 */

import { clampToSpec, getNode, type NodeSpec } from '../audio/fx';
import type { DeckNode, Program, Span, StmtKind, StmtNode } from './ast';
import { resolveValue } from './value';

export interface CompiledNode {
  id: string;
  node: string;
  kind: StmtKind;
  spec: NodeSpec;
  mode?: string;
  sample?: string;
  /** Every param the node has, in canonical units, defaults filled in. */
  params: Record<string, number>;
  /** Value spans for params actually written, so knobs know where to write. */
  spans: Record<string, Span>;
  stmt?: StmtNode;
}

export interface CompiledDeck {
  name: string;
  source?: CompiledNode;
  fx: CompiledNode[];
  out: CompiledNode;
  deck: DeckNode;
}

export interface CompiledProgram {
  tempo: number;
  decks: CompiledDeck[];
  /** Structural fingerprint; equal signatures mean the graph can be patched. */
  signature: string;
}

export function compile(program: Program): CompiledProgram {
  const decks: CompiledDeck[] = [];

  for (const deck of program.decks) {
    let source: CompiledNode | undefined;
    const fx: CompiledNode[] = [];
    let out: CompiledNode | undefined;

    for (const stmt of deck.stmts) {
      const spec = getNode(stmt.node);
      // Statements the checker already flagged are skipped rather than guessed
      // at, so a typo silences one effect instead of the whole deck.
      if (!spec || spec.kind !== stmt.kind) continue;

      const node = compileStmt(stmt, spec, program.tempo);
      if (stmt.kind === 'src') {
        if (!source) source = node;
      } else if (stmt.kind === 'fx') {
        fx.push(node);
      } else {
        out = node;
      }
    }

    decks.push({
      name: deck.name,
      source,
      fx,
      out: out ?? defaultOut(deck.name),
      deck,
    });
  }

  return { tempo: program.tempo, decks, signature: signatureOf(decks) };
}

function compileStmt(stmt: StmtNode, spec: NodeSpec, tempo: number): CompiledNode {
  const params: Record<string, number> = {};
  const spans: Record<string, Span> = {};

  for (const p of spec.params) params[p.name] = p.def;

  for (const written of stmt.params) {
    const pspec = spec.params.find((x) => x.name === written.name);
    if (!pspec) continue;
    const resolved = resolveValue(written.value, pspec, tempo);
    if (!resolved.ok) continue;
    params[written.name] = clampToSpec(resolved.value, pspec);
    spans[written.name] = written.value.span;
  }

  return {
    id: stmt.id,
    node: stmt.node,
    kind: stmt.kind,
    spec,
    mode: stmt.mode && spec.modes?.includes(stmt.mode) ? stmt.mode : spec.modes?.[0],
    sample: stmt.sample?.str,
    params,
    spans,
    stmt,
  };
}

/** A deck with no `out` line still needs somewhere to land. */
function defaultOut(deckName: string): CompiledNode {
  const spec = getNode('out')!;
  const params: Record<string, number> = {};
  for (const p of spec.params) params[p.name] = p.def;
  return {
    id: `${deckName}#out:implicit`,
    node: 'out',
    kind: 'out',
    spec,
    params,
    spans: {},
  };
}

function signatureOf(decks: CompiledDeck[]): string {
  return decks
    .map((d) => {
      const chain = [d.source?.node ?? '-', ...d.fx.map((f) => f.node)].join('>');
      return `${d.name}[${chain}]`;
    })
    .join('|');
}

// -------------------------------------------------------------------- diff

export interface ParamPatch {
  nodeId: string;
  param: string;
  value: number;
}

export interface ModePatch {
  nodeId: string;
  mode: string;
}

export interface SamplePatch {
  nodeId: string;
  sample: string | undefined;
}

export interface GraphDiff {
  rebuild: boolean;
  params: ParamPatch[];
  modes: ModePatch[];
  samples: SamplePatch[];
}

const REBUILD: GraphDiff = { rebuild: true, params: [], modes: [], samples: [] };

export function diff(prev: CompiledProgram | null, next: CompiledProgram): GraphDiff {
  if (!prev || prev.signature !== next.signature) return REBUILD;

  const params: ParamPatch[] = [];
  const modes: ModePatch[] = [];
  const samples: SamplePatch[] = [];

  const prevNodes = new Map<string, CompiledNode>();
  for (const node of allNodes(prev)) prevNodes.set(node.id, node);

  for (const node of allNodes(next)) {
    const before = prevNodes.get(node.id);
    if (!before) return REBUILD;

    for (const [name, value] of Object.entries(node.params)) {
      if (before.params[name] !== value) params.push({ nodeId: node.id, param: name, value });
    }
    if (before.mode !== node.mode && node.mode) modes.push({ nodeId: node.id, mode: node.mode });
    if (before.sample !== node.sample) samples.push({ nodeId: node.id, sample: node.sample });
  }

  return { rebuild: false, params, modes, samples };
}

export function* allNodes(program: CompiledProgram): Generator<CompiledNode> {
  for (const deck of program.decks) {
    if (deck.source) yield deck.source;
    for (const fx of deck.fx) yield fx;
    yield deck.out;
  }
}

/** Every sample name the program refers to, for preloading. */
export function referencedSamples(program: CompiledProgram): string[] {
  const names = new Set<string>();
  for (const node of allNodes(program)) {
    if (node.sample) names.add(node.sample);
  }
  return [...names];
}
