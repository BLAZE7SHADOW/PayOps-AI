import { useEffect, useState } from 'react';

const SHOW_AFTER_MS = 2_000;
const GIVE_UP_MS = 120_000;

type Phase = 'checking' | 'waking' | 'ready' | 'failed';

/**
 * The free API host sleeps after 15 minutes idle and takes 20 to 50 seconds to wake. This pings the
 * health endpoint as soon as any page opens (which also starts the wake-up while a visitor reads the
 * landing page) and, only if the server is slow, explains what is happening with a running timer.
 */
export function ServerWakeNotice() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const started = Date.now();
    const slow = setTimeout(() => !cancelled && setPhase((p) => (p === 'checking' ? 'waking' : p)), SHOW_AFTER_MS);
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);

    const attempt = async () => {
      while (!cancelled && Date.now() - started < GIVE_UP_MS) {
        try {
          const res = await fetch('/api/health', { signal: AbortSignal.timeout(25_000), cache: 'no-store' });
          // A sleeping host answers with an error page (502/503/504) until it is up.
          if (res.ok) return !cancelled && setPhase('ready');
        } catch {
          // Timed out or unreachable: keep trying.
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      if (!cancelled) setPhase('failed');
    };
    void attempt();

    return () => {
      cancelled = true;
      clearTimeout(slow);
      clearInterval(tick);
    };
  }, []);

  if (phase === 'checking' || phase === 'ready') return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 border-b border-rule bg-surface px-4 py-2 text-center text-13 text-ink"
    >
      {phase === 'waking' ? (
        <>
          Waking up the demo server. It runs on a free host that sleeps when idle, so the first visit takes
          20 to 50 seconds. <span className="tabular font-mono text-ink-2">{seconds}s</span>
        </>
      ) : (
        <>
          The demo server did not respond.{' '}
          <button type="button" className="link" onClick={() => window.location.reload()}>
            Reload to try again
          </button>
        </>
      )}
    </div>
  );
}
