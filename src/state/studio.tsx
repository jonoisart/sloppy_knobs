/**
 * Studio state: the single place source text, the running graph and the sample
 * library are kept in step.
 *
 * The source text is the truth. Knobs do not hold values — they read them out
 * of the compiled program and write changes back into the text, which re-parses
 * and patches the graph. That is why turning a knob updates the code pane, and
 * why editing the code pane moves the knobs.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { engine, type EngineState } from '../audio/engine';
import { LiveGraph } from '../audio/graph';
import { fromKnob } from '../audio/fx';
import { StudioContext, type LibraryEntry, type StudioValue } from './context';
import { downloadBlob, timestampName } from '../audio/wav';
import {
  appendStatement,
  compile,
  diff,
  evaluate,
  parse,
  renderValue,
  STARTER_PATCH,
  upsertParam,
  type CompiledProgram,
} from '../lang';
import * as idb from '../lib/idb';

export function StudioProvider({ children }: { children: ReactNode }) {
  const [source, setSourceRaw] = useState(STARTER_PATCH);
  const [engineState, setEngineState] = useState<EngineState>('idle');
  const [bootError, setBootError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [solo, setSolo] = useState<string | null>(null);
  const [masterGain, setMasterGainState] = useState(0.9);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // Decoded buffers live in the engine, not in React. This counter is what
  // tells the waveforms and the library that the set of decoded samples moved.
  const [sampleVersion, setSampleVersion] = useState(0);

  const graphRef = useRef<LiveGraph | null>(null);
  const appliedRef = useRef<CompiledProgram | null>(null);
  const saveTimer = useRef<number | null>(null);

  const bumpSamples = useCallback(() => setSampleVersion((v) => v + 1), []);

  const knownSamples = useMemo(() => library.map((s) => s.name), [library]);
  const evaluated = useMemo(() => evaluate(source, { knownSamples }), [source, knownSamples]);

  // ------------------------------------------------------ persistence

  useEffect(() => {
    // Restore the last session. Samples are only decoded once audio starts,
    // since decoding needs a context and a context needs a gesture.
    let cancelled = false;
    (async () => {
      try {
        const [patch, samples] = await Promise.all([idb.loadPatch(), idb.allSamples()]);
        if (cancelled) return;
        if (patch) setSourceRaw(patch);
        setLibrary(
          samples
            .map((s) => ({
              name: s.name,
              duration: s.duration ?? 0,
              origin: s.origin,
              addedAt: s.addedAt,
            }))
            .sort((a, b) => b.addedAt - a.addedAt),
        );
      } catch {
        // Private browsing or a blocked database: the app still works, it just
        // will not remember anything between visits.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      idb.savePatch(source).catch(() => undefined);
    }, 600);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [source]);

  // ------------------------------------------------------------- audio

  const boot = useCallback(async () => {
    setBootError(null);
    setEngineState('starting');
    try {
      await engine.start();

      const stored = await idb.allSamples();
      for (const sample of stored) {
        try {
          // decodeAudioData detaches what it is given, so hand it a copy and
          // keep the original bytes for the next reload.
          await engine.addSample(sample.name, sample.data.slice(0));
        } catch {
          // A file the browser cannot decode stays in the library greyed out
          // rather than taking the whole boot down with it.
        }
      }

      const graph = new LiveGraph(engine);
      graphRef.current = graph;
      appliedRef.current = null;
      engine.setMasterGain(masterGain);

      // Both of these must land after the graph exists and the samples are
      // decoded. The build effect keys off `engineState`, so flipping it early
      // would run the effect against a null graph and never run it again.
      bumpSamples();
      setEngineState('ready');
    } catch (err) {
      setEngineState('failed');
      setBootError(err instanceof Error ? err.message : String(err));
    }
  }, [bumpSamples, masterGain]);

  // Build or patch the graph whenever the compiled program changes.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || engineState !== 'ready') return;

    const next = evaluated.compiled;
    const delta = diff(appliedRef.current, next);
    if (delta.rebuild) {
      graph.build(next);
      for (const deck of next.decks) {
        graph.onPosition(deck.name, (p) =>
          setPositions((prev) => (Math.abs((prev[deck.name] ?? 0) - p) < 0.001 ? prev : { ...prev, [deck.name]: p })),
        );
      }
    } else {
      graph.applyDiff(delta);
    }
    appliedRef.current = next;
  }, [evaluated.compiled, engineState]);

  const setSource = useCallback((next: string) => setSourceRaw(next), []);

  const togglePlay = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    if (graph.isPlaying) {
      graph.stop();
      setPlaying(false);
    } else {
      void engine.resume();
      graph.play();
      setPlaying(true);
    }
  }, []);

  const setMasterGain = useCallback((value: number) => {
    setMasterGainState(value);
    engine.setMasterGain(value);
  }, []);

  const toggleSolo = useCallback((deck: string) => {
    setSolo((prev) => {
      const next = prev === deck ? null : deck;
      graphRef.current?.setSolo(next);
      return next;
    });
  }, []);

  // ----------------------------------------------------------- library

  const refreshLibrary = useCallback(async () => {
    const stored = await idb.allSamples();
    setLibrary(
      stored
        .map((s) => ({ name: s.name, duration: s.duration ?? 0, origin: s.origin, addedAt: s.addedAt }))
        .sort((a, b) => b.addedAt - a.addedAt),
    );
  }, []);

  const addFiles = useCallback(
    async (files: File[], origin: 'upload' | 'recording' = 'upload') => {
      if (files.length === 0) return;
      if (!engine.ready) {
        setNotice('Tap “wake up” first — the browser will not decode audio before that.');
        return;
      }
      for (const file of files) {
        setBusy(`Reading ${file.name}…`);
        try {
          const bytes = await file.arrayBuffer();
          const name = idb.uniqueName(idb.toSampleName(file.name), engine.sampleNames);
          const buffer = await engine.addSample(name, bytes.slice(0));
          await idb.putSample({
            name,
            data: bytes,
            type: file.type || 'audio/*',
            addedAt: Date.now(),
            duration: buffer.duration,
            origin,
          });
          // A deck already referring to this name picks it up immediately.
          graphRef.current?.refreshSample(name, evaluated.compiled);
        } catch (err) {
          setNotice(`Could not read ${file.name}: ${err instanceof Error ? err.message : 'unsupported format'}`);
        }
      }
      setBusy(null);
      bumpSamples();
      await refreshLibrary();
    },
    [bumpSamples, evaluated.compiled, refreshLibrary],
  );

  const removeSample = useCallback(
    async (name: string) => {
      await idb.deleteSample(name);
      engine.removeSample(name);
      bumpSamples();
      await refreshLibrary();
    },
    [bumpSamples, refreshLibrary],
  );

  // ---------------------------------------------------------- recording

  const toggleRecord = useCallback(async () => {
    if (!engine.ready) return;
    if (!engine.isRecording) {
      engine.startRecording();
      setRecording(true);
      return;
    }
    const blob = await engine.stopRecording();
    setRecording(false);
    if (blob.size > 44) {
      downloadBlob(blob, timestampName());
      setNotice('Mix exported as a WAV.');
    } else {
      setNotice('Nothing was recorded — was anything playing?');
    }
  }, []);

  // ------------------------------------------------- editing the source

  /**
   * Rewrite a param in the source text.
   *
   * The previous source is re-parsed inside the state updater rather than
   * closed over, because a knob drag fires far faster than React commits and a
   * stale closure would drop every intermediate move.
   */
  const setNodeParam = useCallback((nodeId: string, deckName: string, param: string, value: number) => {
    setSourceRaw((prev) => {
      const { program } = parse(prev);
      for (const deck of program.decks) {
        const stmt = deck.stmts.find((s) => s.id === nodeId);
        if (stmt) {
          const written = stmt.params.find((p) => p.name === param)?.value;
          return upsertParam(prev, stmt, param, renderValue(value, written));
        }
      }
      // No statement to edit: the node is running on registry defaults, which
      // only happens for an implicit `out`. Write one into the deck.
      const deck = program.decks.find((d) => d.name === deckName);
      if (deck) return appendStatement(prev, deck, `out ${param}=${renderValue(value)}`);
      return prev;
    });
  }, []);

  const setNodeMode = useCallback((nodeId: string, mode: string) => {
    setSourceRaw((prev) => {
      const { program } = parse(prev);
      for (const deck of program.decks) {
        const stmt = deck.stmts.find((s) => s.id === nodeId);
        if (!stmt) continue;
        if (stmt.modeSpan) {
          return prev.slice(0, stmt.modeSpan.start) + mode + prev.slice(stmt.modeSpan.end);
        }
        // No mode written yet: insert one right after the node name.
        return prev.slice(0, stmt.nodeSpan.end) + ` ${mode}` + prev.slice(stmt.nodeSpan.end);
      }
      return prev;
    });
  }, []);

  /**
   * Randomise the patch by rewriting its text, so whatever it lands on stays
   * readable and editable rather than being hidden runtime state.
   */
  const chaos = useCallback((deckName?: string) => {
    setSourceRaw((prev) => {
      const targets: { id: string; param: string; value: number }[] = [];
      const { program } = parse(prev);
      const compiled = compile(program);

      for (const deck of compiled.decks) {
        if (deckName && deck.name !== deckName) continue;
        for (const node of [...(deck.source ? [deck.source] : []), ...deck.fx]) {
          for (const spec of node.spec.params) {
            // Leave levels and mix alone, or every roll of the dice is silent.
            if (spec.name === 'gain' || spec.name === 'mix') continue;
            if (Math.random() > 0.55) continue;
            targets.push({ id: node.id, param: spec.name, value: fromKnob(Math.random(), spec) });
          }
        }
      }

      // Applying one edit at a time and re-parsing keeps every span valid;
      // batching would invalidate later spans as earlier ones shift the text.
      let next = prev;
      for (const target of targets) {
        const { program: current } = parse(next);
        for (const deck of current.decks) {
          const stmt = deck.stmts.find((s) => s.id === target.id);
          if (!stmt) continue;
          const written = stmt.params.find((p) => p.name === target.param)?.value;
          next = upsertParam(next, stmt, target.param, renderValue(target.value, written));
          break;
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const value: StudioValue = {
    source,
    setSource,
    evaluated,
    engineState,
    ready: engineState === 'ready',
    boot,
    bootError,
    playing,
    togglePlay,
    library,
    addFiles,
    removeSample,
    busy,
    recording,
    toggleRecord,
    solo,
    toggleSolo,
    masterGain,
    setMasterGain,
    positions,
    sampleVersion,
    graph: graphRef.current,
    setNodeParam,
    setNodeMode,
    chaos,
    notice,
  };

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
