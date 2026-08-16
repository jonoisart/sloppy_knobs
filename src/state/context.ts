/**
 * The studio context and its hook.
 *
 * Kept apart from the provider so that module exports only components on one
 * side and only plain values on the other, which is what fast refresh needs to
 * hot-swap the UI without restarting audio.
 */

import { createContext, useContext } from 'react';
import type { LiveGraph } from '../audio/graph';
import type { EngineState } from '../audio/engine';
import type { EvalResult } from '../lang';

export interface LibraryEntry {
  name: string;
  duration: number;
  origin: 'upload' | 'recording';
  addedAt: number;
}

export interface StudioValue {
  source: string;
  setSource: (next: string) => void;
  evaluated: EvalResult;

  engineState: EngineState;
  ready: boolean;
  boot: () => Promise<void>;
  bootError: string | null;

  playing: boolean;
  togglePlay: () => void;

  library: LibraryEntry[];
  addFiles: (files: File[], origin?: 'upload' | 'recording') => Promise<void>;
  removeSample: (name: string) => Promise<void>;
  busy: string | null;

  recording: boolean;
  toggleRecord: () => Promise<void>;

  solo: string | null;
  toggleSolo: (deck: string) => void;

  masterGain: number;
  setMasterGain: (value: number) => void;

  positions: Record<string, number>;
  /** Bumped whenever the set of decoded samples changes, to force a redraw. */
  sampleVersion: number;
  graph: LiveGraph | null;

  /** Write a param change back into the source text. */
  setNodeParam: (nodeId: string, deckName: string, param: string, value: number) => void;
  setNodeMode: (nodeId: string, mode: string) => void;
  chaos: (deckName?: string) => void;
  notice: string | null;
}

export const StudioContext = createContext<StudioValue | null>(null);

export function useStudio(): StudioValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error('useStudio must be used inside <StudioProvider>');
  return value;
}
