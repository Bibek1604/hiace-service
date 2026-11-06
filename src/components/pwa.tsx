'use client';
import { useEffect, useState } from 'react';
import { Download, Share } from 'lucide-react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

/** Registers the service worker (production only, so development hot reload is never cached). */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator)
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
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
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone);
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
