/**
 * Turning a written value into the number the audio graph wants.
 *
 * Shared by the checker (which reports why a value is wrong) and the compiler
 * (which needs the number), so the two can never disagree about what a piece of
 * source means.
 */

import { toCanonical, type ParamSpec } from '../audio/fx';
import type { ValueNode } from './ast';

export type Resolved = { ok: true; value: number } | { ok: false; reason: string };

const TRUTHY = new Set(['on', 'true', 'yes']);
const FALSY = new Set(['off', 'false', 'no']);

/** Beats per bar assumed by ratio values like `3/8`. */
const BEATS_PER_BAR = 4;

export function secondsPerBar(tempo: number): number {
  return (BEATS_PER_BAR * 60) / Math.max(1, tempo);
}

export function resolveValue(node: ValueNode, spec: ParamSpec, tempo: number): Resolved {
  switch (node.kind) {
    case 'word': {
      const w = (node.word ?? '').toLowerCase();
      if (TRUTHY.has(w)) return { ok: true, value: spec.toggle ? 1 : spec.max };
      if (FALSY.has(w)) return { ok: true, value: spec.toggle ? 0 : spec.min };
      return { ok: false, reason: `\`${node.raw}\` is not a value for \`${spec.name}\`` };
    }

    case 'string':
      return { ok: false, reason: `\`${spec.name}\` takes a number, not text` };

    case 'ratio': {
      // Only meaningful for durations, where it means a fraction of a bar.
      if (spec.unit !== 's' && spec.unit !== 'ms') {
        return { ok: false, reason: `\`${spec.name}\` is not a time, so \`${node.raw}\` has no meaning here` };
      }
      const seconds = (node.num ?? 0) * secondsPerBar(tempo);
      return { ok: true, value: spec.unit === 'ms' ? seconds * 1000 : seconds };
    }

    case 'number': {
      const converted = toCanonical(node.num ?? 0, node.unit ?? '', spec);
      if (converted === null) {
        return {
          ok: false,
          reason: `\`${node.unit}\` does not apply to \`${spec.name}\`${spec.unit ? ` (expects ${spec.unit})` : ''}`,
        };
      }
      return { ok: true, value: converted };
    }
  }
}
