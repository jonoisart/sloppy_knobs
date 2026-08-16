/**
 * The visual view of the patch.
 *
 * Every unit here is generated from the compiled program plus the node
 * registry: the rack has no idea what a bitcrusher is, it just renders the
 * params the registry declares and writes changes back into the source.
 */

import type { CompiledDeck, CompiledNode } from '../lang';
import { useStudio } from '../state/context';
import { Knob, Switch } from './Knob';
import { Waveform } from './Waveform';

function Unit({ node, deck }: { node: CompiledNode; deck: CompiledDeck }) {
  const { setNodeParam, setNodeMode } = useStudio();

  return (
    <div className="unit" data-node={node.node}>
      <div className="unit-head">
        <h4 title={node.spec.blurb}>{node.spec.label}</h4>
        {node.spec.modes && (
          <div className="modes" role="group" aria-label={`${node.spec.label} mode`}>
            {node.spec.modes.map((mode) => (
              <button
                key={mode}
                type="button"
                className={node.mode === mode ? 'is-active' : ''}
                onClick={() => setNodeMode(node.id, mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="knobs">
        {node.spec.params.map((spec) => {
          const value = node.params[spec.name];
          const written = spec.name in node.spans;
          const onChange = (next: number) => setNodeParam(node.id, deck.name, spec.name, next);
          return spec.toggle ? (
            <Switch key={spec.name} spec={spec} value={value} onChange={onChange} written={written} />
          ) : (
            <Knob key={spec.name} spec={spec} value={value} onChange={onChange} written={written} />
          );
        })}
      </div>
    </div>
  );
}

function DeckStrip({ deck }: { deck: CompiledDeck }) {
  const { solo, toggleSolo, setNodeParam, chaos } = useStudio();
  const out = deck.out;
  const muted = (out.params.mute ?? 0) >= 0.5;

  return (
    <section className="deck">
      <header className="deck-head">
        <h3>{deck.name}</h3>
        <div className="deck-actions">
          <button
            type="button"
            className={muted ? 'is-active' : ''}
            aria-pressed={muted}
            onClick={() => setNodeParam(out.id, deck.name, 'mute', muted ? 0 : 1)}
          >
            mute
          </button>
          <button
            type="button"
            className={solo === deck.name ? 'is-active' : ''}
            aria-pressed={solo === deck.name}
            onClick={() => toggleSolo(deck.name)}
          >
            solo
          </button>
          <button type="button" onClick={() => chaos(deck.name)} title="Randomise this deck">
            chaos
          </button>
        </div>
      </header>

      <Waveform deckName={deck.name} sample={deck.source?.sample} />

      <div className="units">
        {deck.source && <Unit node={deck.source} deck={deck} />}
        {deck.fx.map((fx) => (
          <Unit key={fx.id} node={fx} deck={deck} />
        ))}
        <Unit node={out} deck={deck} />
      </div>
    </section>
  );
}

export function Rack() {
  const { evaluated } = useStudio();
  const decks = evaluated.compiled.decks;

  if (decks.length === 0) {
    return (
      <div className="empty">
        <p>No decks yet.</p>
        <p className="dim">Write one in the code pane, or load a sample and start from the example.</p>
      </div>
    );
  }

  return (
    <div className="rack">
      {decks.map((deck) => (
        <DeckStrip key={deck.name} deck={deck} />
      ))}
    </div>
  );
}
