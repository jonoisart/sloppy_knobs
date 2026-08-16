/**
 * The sample library: drop files in, record straight from the mic, and drop a
 * name into the patch.
 *
 * On a phone the file input opens the photo/voice-memo picker; the separate
 * record button is the fast path for capturing something on the spot.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../audio/peaks';
import { engine } from '../audio/engine';
import { useStudio } from '../state/context';

function useMicRecorder(onDone: (file: File) => void) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  const stop = useCallback(() => {
    recorder.current?.stop();
    setRecording(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const mr = new MediaRecorder(stream);
      chunks.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' });
        const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
        onDone(new File([blob], `take-${stamp}.webm`, { type: blob.type }));
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      recorder.current = mr;
      setRecording(true);
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : 'No microphone available.',
      );
    }
  }, [onDone]);

  useEffect(() => () => recorder.current?.stream?.getTracks().forEach((t) => t.stop()), []);

  return { recording, error, start, stop };
}

export function Library() {
  const { library, addFiles, removeSample, busy, ready, source, setSource, notice } = useStudio();
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const mic = useMicRecorder(useCallback((file: File) => void addFiles([file], 'recording'), [addFiles]));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|ogg|flac|webm|aac|opus)$/i.test(f.name));
    if (files.length) void addFiles(files);
  };

  /** Drop a `deck` referencing this sample at the end of the patch. */
  const addDeckFor = (name: string) => {
    const deckName = name.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'deck';
    const unique = source.includes(`deck ${deckName}`) ? `${deckName}${library.length}` : deckName;
    setSource(
      `${source.replace(/\s*$/, '')}\n\ndeck ${unique} {\n  src grain "${name}" speed=0.5 grain=120ms dens=25 spray=0.3\n  fx  svf lp cutoff=2000 res=0.3\n  out gain=0.8\n}\n`,
    );
  };

  return (
    <section className="library">
      <header className="panel-head">
        <h2>samples</h2>
        <div className="library-actions">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={!ready}>
            add files
          </button>
          <button
            type="button"
            className={mic.recording ? 'is-recording' : ''}
            onClick={() => (mic.recording ? mic.stop() : void mic.start())}
            disabled={!ready}
          >
            {mic.recording ? 'stop' : 'record'}
          </button>
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles([...e.target.files]);
          e.target.value = '';
        }}
      />

      <div
        className={`dropzone ${dragOver ? 'is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {busy ?? 'drop audio here — voice notes, found sound, anything'}
      </div>

      {mic.error && <p className="warn">{mic.error}</p>}
      {notice && <p className="warn">{notice}</p>}

      <ul className="sample-list">
        {library.length === 0 && <li className="dim">nothing loaded yet</li>}
        {library.map((sample) => {
          const decoded = !!engine.getSample(sample.name);
          return (
            <li key={sample.name} className={decoded ? '' : 'is-undecoded'}>
              <button
                type="button"
                className="sample-name"
                onClick={() => addDeckFor(sample.name)}
                title="Add a deck using this sample"
              >
                {sample.name}
              </button>
              <span className="sample-meta">
                {sample.origin === 'recording' ? '●' : ''} {formatDuration(sample.duration)}
              </span>
              <button
                type="button"
                className="sample-remove"
                aria-label={`Remove ${sample.name}`}
                onClick={() => void removeSample(sample.name)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
