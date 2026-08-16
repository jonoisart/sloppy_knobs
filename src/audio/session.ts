/**
 * The mobile-only things that stand between a working audio graph and actually
 * hearing it.
 *
 * None of this is needed on a desktop browser. All of it is needed on a phone,
 * and each failure looks like a bug in the app rather than a platform rule:
 * silent output, audio that never comes back after a notification, a screen
 * that sleeps mid-jam.
 */

type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

interface AudioSession {
  type: AudioSessionType;
}

function audioSession(): AudioSession | undefined {
  return (navigator as Navigator & { audioSession?: AudioSession }).audioSession;
}

/**
 * Claim a playback session.
 *
 * By default iOS treats web audio as "ambient", which means the physical ring/
 * silent switch mutes it — the single most common reason a working web audio
 * app appears broken on an iPhone. Safari 16.4+ exposes the Audio Session API
 * to opt out of that.
 */
export function claimPlaybackSession(): void {
  const session = audioSession();
  if (session) {
    session.type = 'playback';
    return;
  }
  installSilentAudioFallback();
}

/**
 * While the microphone is capturing, the session has to allow recording. The
 * playback-only type would either fail to record or drop output entirely.
 */
export function claimRecordingSession(): void {
  const session = audioSession();
  if (session) session.type = 'play-and-record';
}

export function releaseRecordingSession(): void {
  const session = audioSession();
  if (session) session.type = 'playback';
}

/**
 * Pre-16.4 fallback: a silently looping <audio> element promotes the page's
 * audio session out of "ambient", which is enough to survive the mute switch.
 * Crude, but it is the only lever older Safari gives.
 */
let silentElement: HTMLAudioElement | null = null;

function installSilentAudioFallback(): void {
  if (silentElement || typeof document === 'undefined') return;
  // A minimal silent WAV, inline so there is nothing extra to fetch.
  const silence =
    'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAAAA';
  const el = document.createElement('audio');
  el.src = silence;
  el.loop = true;
  el.volume = 0.001;
  el.setAttribute('playsinline', '');
  el.style.display = 'none';
  document.body.appendChild(el);
  void el.play().catch(() => undefined);
  silentElement = el;
}

// ------------------------------------------------------------- wake lock

interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> };
}

let sentinel: WakeLockSentinel | null = null;
let wanted = false;

/** Keep the screen awake while the transport is running. */
export async function holdWakeLock(): Promise<void> {
  wanted = true;
  const api = (navigator as Navigator & WakeLockNavigator).wakeLock;
  if (!api || sentinel) return;
  try {
    sentinel = await api.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // Denied, unsupported, or the document was hidden. Not worth surfacing —
    // the only cost is that the screen dims as usual.
  }
}

export async function releaseWakeLock(): Promise<void> {
  wanted = false;
  const held = sentinel;
  sentinel = null;
  await held?.release().catch(() => undefined);
}

/**
 * Watch for the app coming back to the foreground.
 *
 * A phone call, a notification or a lock suspends the AudioContext, and the
 * browser does not resume it — so without this the app comes back silent and
 * looks dead. The wake lock is dropped on hide too, and has to be re-acquired.
 *
 * @param resume called when the page becomes visible again
 * @returns an unsubscribe function
 */
export function watchInterruptions(resume: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    resume();
    if (wanted) void holdWakeLock();
  };

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('pageshow', onVisible);

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    window.removeEventListener('pageshow', onVisible);
  };
}
