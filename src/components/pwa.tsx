'use client';
import { useEffect, useRef, useState } from 'react';
import { Download, Share } from 'lucide-react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/**
 * Registers the service worker (production only, so development hot reload is never cached) and offers
 * new versions. A waiting version only takes over when the person accepts, so a booking in progress is
 * never reloaded from under them.
 */
export function PwaRegister() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const accepted = useRef(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    const worker = navigator.serviceWorker;
    let registration: ServiceWorkerRegistration | undefined;
    const check = () => {
      if (document.visibilityState === 'visible') registration?.update().catch(() => undefined);
    };
    const reload = () => {
      if (accepted.current) location.reload();
    };
    worker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((r) => {
        registration = r;
        if (r.waiting && worker.controller) setWaiting(r.waiting);
        r.addEventListener('updatefound', () => {
          const next = r.installing;
          next?.addEventListener('statechange', () => {
            if (next.state === 'installed' && worker.controller) setWaiting(next);
          });
        });
      })
      .catch(() => undefined);
    worker.addEventListener('controllerchange', reload);
    document.addEventListener('visibilitychange', check);
    return () => {
      worker.removeEventListener('controllerchange', reload);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  if (!waiting) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version of the app is ready.</span>
      <button
        type="button"
        className="button"
        onClick={() => {
          accepted.current = true;
          waiting.postMessage('SKIP_WAITING');
        }}
      >
        Update
      </button>
      <button type="button" className="button outline" onClick={() => setWaiting(null)}>
        Later
      </button>
    </div>
  );
}

/**
 * "Install app" button. Chrome/Edge/Android offer a real install prompt; iPhone Safari has none, so it
 * shows the Add to Home Screen steps. Hidden once the app is installed or already running standalone.
 */
export function InstallApp({ className = '' }: { className?: string }) {
  const [evt, setEvt] = useState<InstallEvent | null>(null),
    [ios, setIos] = useState(false),
    [hint, setHint] = useState(false),
    [installed, setInstalled] = useState(true);
  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    // iPads report themselves as Macs, so touch support tells them apart.
    const apple = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setIos(apple && !standalone);
    const before = (e: Event) => {
      e.preventDefault();
      setEvt(e as InstallEvent);
    };
    const done = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', before);
    window.addEventListener('appinstalled', done);
    return () => {
      window.removeEventListener('beforeinstallprompt', before);
      window.removeEventListener('appinstalled', done);
    };
  }, []);
  if (installed || (!evt && !ios)) return null;
  return (
    <span className={'install-app ' + className}>
      <button
        type="button"
        className="install-btn"
        onClick={async () => {
          if (evt) {
            await evt.prompt();
            await evt.userChoice.catch(() => undefined);
            setEvt(null);
          } else setHint((h) => !h);
        }}
      >
        <Download size={15} /> Install app
      </button>
      {hint && (
        <span className="install-hint" role="status">
          Tap <Share size={13} style={{ verticalAlign: 'middle' }} /> Share, then “Add to Home Screen”.
        </span>
      )}
    </span>
  );
}
