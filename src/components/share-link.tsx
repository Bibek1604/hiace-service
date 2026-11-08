'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Link2, Share2 } from 'lucide-react';
import { Button } from './ui/button';

/** The public booking page for one trip: one vehicle at one departure time, optionally on part of its route. */
export function tripBookingUrl(tripId: string, journey?: { from: string; to: string }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const query = journey?.from && journey.to ? '?' + new URLSearchParams(journey) : '';
  return origin + '/trips/' + encodeURIComponent(tripId) + query;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older phone browsers and non-https pages have no clipboard API.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    area.remove();
    return ok;
  }
}

/**
 * Copies the booking link of one trip so a driver, operator or passenger can send it
 * (WhatsApp, Viber, SMS). Where the phone has a share sheet, a second button opens it.
 */
export function CopyTripLink({
  tripId,
  journey,
  title,
  variant = 'outline',
  label = 'Copy booking link',
}: {
  tripId: string;
  journey?: { from: string; to: string };
  /** Shown in the share sheet, e.g. "Kathmandu → Pokhara · 9 Nov, 06:00". */
  title?: string;
  variant?: 'outline' | 'default' | 'secondary';
  label?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle'),
    [canShare, setCanShare] = useState(false),
    [link, setLink] = useState(''),
    timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    return () => clearTimeout(timer.current);
  }, []);
  const url = () => tripBookingUrl(tripId, journey);
  async function copy() {
    const value = url();
    const ok = await copyText(value);
    setLink(ok ? '' : value);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    if (ok) timer.current = setTimeout(() => setState('idle'), 2500);
  }
  async function share() {
    try {
      await navigator.share({ title: title || 'Book your seat', text: title ? 'Book your seat: ' + title : undefined, url: url() });
    } catch (e) {
      // Closing the share sheet is not an error; anything else falls back to copying.
      if (!(e instanceof DOMException && e.name === 'AbortError')) await copy();
    }
  }
  return (
    <>
      <Button type="button" variant={variant} onClick={copy} aria-live="polite">
        {state === 'copied' ? <Check size={15} /> : <Link2 size={15} />}
        {state === 'copied' ? 'Link copied' : label}
      </Button>
      {canShare && (
        <Button type="button" variant="outline" onClick={share} aria-label={'Share booking link' + (title ? ' for ' + title : '')}>
          <Share2 size={15} /> Share
        </Button>
      )}
      {state === 'failed' && (
        <label className="stack" style={{ width: '100%' }}>
          <span className="muted">Copying is blocked here. Press and hold the link to copy it:</span>
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Booking link" />
        </label>
      )}
    </>
  );
}
