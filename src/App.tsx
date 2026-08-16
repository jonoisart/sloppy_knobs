import { useState } from 'react';
import { StudioProvider } from './state/studio';
import { useStudio } from './state/context';
import { Editor } from './ui/Editor';
import { Library } from './ui/Library';
import { Rack } from './ui/Rack';
import { Transport } from './ui/Transport';

/**
 * Browsers refuse to start audio outside a user gesture, so the app opens
 * behind this gate rather than silently failing to make any sound.
 */
function WakeGate() {
  const { engineState, boot, bootError } = useStudio();
  if (engineState === 'ready') return null;

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>sloppy_knobs</h1>
        <p>
          An audio coding language with knobs on. Drop in voice notes and found sound, then mangle them with a
          patch you can read.
        </p>
        <button type="button" onClick={() => void boot()} disabled={engineState === 'starting'}>
          {engineState === 'starting' ? 'waking…' : 'wake up'}
        </button>
        {bootError && <p className="warn">{bootError}</p>}
        <p className="dim">Nothing you load leaves this device.</p>
      </div>
    </div>
  );
}

type View = 'rack' | 'code';

function Studio() {
  const { ready } = useStudio();
  const [view, setView] = useState<View>('rack');

  return (
    <div className="app">
      <WakeGate />

      <header className="topbar">
        <h1>
          sloppy<span>_</span>knobs
        </h1>
        <nav className="view-switch" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'rack'}
            className={view === 'rack' ? 'is-active' : ''}
            onClick={() => setView('rack')}
          >
            rack
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'code'}
            className={view === 'code' ? 'is-active' : ''}
            onClick={() => setView('code')}
          >
            code
          </button>
        </nav>
      </header>

      {ready && <Transport />}

      <main className={`layout view-${view}`}>
        <div className="pane pane-code">
          <Editor />
        </div>
        <div className="pane pane-rack">
          <Rack />
        </div>
        <div className="pane pane-library">
          <Library />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <StudioProvider>
      <Studio />
    </StudioProvider>
  );
}
