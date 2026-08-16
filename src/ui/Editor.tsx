/**
 * The code pane.
 *
 * A transparent textarea sits over a highlighted <pre> holding identical text,
 * which keeps real editing behaviour — selection, undo, autocorrect, the mobile
 * keyboard — while still colouring the syntax.
 */

import { useEffect, useMemo, useRef } from 'react';
import { KEYWORDS } from '../lang/lex';
import { useStudio } from '../state/context';

interface Segment {
  text: string;
  cls: string;
}

const TOKEN =
  /(#[^\n]*|\/\/[^\n]*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(-?\d+(?:\.\d+)?(?:\/\d+)?(?:khz|hz|ms|db|st|s|%)?)|([A-Za-z_][A-Za-z0-9_-]*)|([{}=])/g;

function highlight(source: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  let previousWord = '';

  for (let m = TOKEN.exec(source); m; m = TOKEN.exec(source)) {
    if (m.index > last) segments.push({ text: source.slice(last, m.index), cls: '' });
    const [raw, comment, string, number, word, punct] = m;

    if (comment) {
      segments.push({ text: raw, cls: 'tok-comment' });
    } else if (string) {
      segments.push({ text: raw, cls: 'tok-string' });
    } else if (number) {
      segments.push({ text: raw, cls: 'tok-number' });
    } else if (word) {
      let cls = 'tok-word';
      if (KEYWORDS.has(word)) cls = 'tok-keyword';
      else if (previousWord === 'src' || previousWord === 'fx') cls = 'tok-node';
      else if (source[m.index + raw.length] === '=') cls = 'tok-param';
      segments.push({ text: raw, cls });
      previousWord = word;
    } else if (punct) {
      segments.push({ text: raw, cls: 'tok-punct' });
    }

    last = m.index + raw.length;
  }

  if (last < source.length) segments.push({ text: source.slice(last), cls: '' });
  // A trailing newline needs a character after it or the <pre> loses the line.
  segments.push({ text: '\n', cls: '' });
  return segments;
}

export function Editor() {
  const { source, setSource, evaluated } = useStudio();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const segments = useMemo(() => highlight(source), [source]);

  // Keep the highlight layer aligned when the textarea scrolls, including when
  // a knob edit changes the text while the pane is scrolled.
  const syncScroll = () => {
    const ta = textareaRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };
  useEffect(syncScroll, [source]);

  const jumpTo = (offset: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(offset, offset);
    // Scroll the caret roughly into view.
    const before = source.slice(0, offset).split('\n').length - 1;
    ta.scrollTop = Math.max(0, before * 20 - ta.clientHeight / 2);
    syncScroll();
  };

  const errors = evaluated.diagnostics.filter((d) => d.severity === 'error');
  const warnings = evaluated.diagnostics.filter((d) => d.severity === 'warning');

  return (
    <div className="editor">
      <div className="editor-surface">
        <pre ref={preRef} aria-hidden="true" className="editor-highlight">
          {segments.map((segment, i) => (
            <span key={i} className={segment.cls}>
              {segment.text}
            </span>
          ))}
        </pre>
        <textarea
          ref={textareaRef}
          className="editor-input"
          value={source}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Patch source"
          onChange={(e) => setSource(e.target.value)}
          onScroll={syncScroll}
        />
      </div>

      <div className="diagnostics" role="status" aria-live="polite">
        {evaluated.diagnostics.length === 0 ? (
          <p className="diag-clean">no complaints</p>
        ) : (
          <>
            <p className="diag-summary">
              {errors.length > 0 && <span className="is-error">{errors.length} error{errors.length === 1 ? '' : 's'}</span>}
              {errors.length > 0 && warnings.length > 0 && ' · '}
              {warnings.length > 0 && <span className="is-warning">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
            </p>
            <ul>
              {evaluated.diagnostics.slice(0, 12).map((d, i) => (
                <li key={i} className={d.severity === 'error' ? 'is-error' : 'is-warning'}>
                  <button type="button" onClick={() => jumpTo(d.span.start)}>
                    <span className="diag-pos">
                      {d.line}:{d.col}
                    </span>
                    {d.message}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
