'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorBox, onForm } from './common';
import { useSite } from './site-context';
import { Button } from './ui/button';
import { Download, Printer } from 'lucide-react';
import { money, nepalTime } from '@/lib/utils';
import type { BookingView } from '@/lib/types';

const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const ticketDate = (value: string) =>
  new Date(value).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Kathmandu',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

/** Downloads a self-contained, printable ticket only after payment has been verified. */
export function DownloadTicket({ booking }: { booking: BookingView }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const download = async () => {
    setPending(true);
    setError(null);
    try {
      const { ticket } = await api<{ ticket: string }>('/api/bookings/' + booking.id + '/ticket');
      const seats = booking.seats.map((seat) => seat.tripSeat.vehicleSeat.label).join(', ');
      const route = `${booking.journey.from} → ${booking.journey.to}`;
      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sajilo Yatra ticket ${escapeHtml(booking.reference)}</title>
<style>
  * { box-sizing: border-box; } body { margin: 0; padding: 28px; color: #16324a; font: 15px/1.5 Arial, sans-serif; background: #f3f8f6; }
  .ticket { max-width: 720px; margin: auto; overflow: hidden; border: 1px solid #bfe4cf; border-radius: 20px; background: #fff; box-shadow: 0 12px 34px #164a2a18; }
  header { padding: 25px 28px; color: #fff; background: linear-gradient(135deg, #087a43, #14a765); } header small { display: block; letter-spacing: .12em; text-transform: uppercase; opacity: .82; } h1 { margin: 4px 0 0; font-size: 28px; } main { padding: 26px 28px; } .verified { display: inline-block; padding: 5px 10px; border-radius: 999px; background: #e1f8ea; color: #087a43; font-size: 12px; font-weight: 700; } .reference { margin: 18px 0 0; color: #60758b; font-size: 12px; text-transform: uppercase; letter-spacing: .1em; } .reference strong { display: block; color: #16324a; font-size: 22px; letter-spacing: .06em; } .route { margin: 24px 0 18px; font-size: 24px; font-weight: 700; } dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 0; } dt { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; } dd { margin: 3px 0 0; font-weight: 600; } .code { margin-top: 25px; padding: 15px; overflow-wrap: anywhere; border: 1px dashed #8abca1; border-radius: 12px; background: #f2fbf5; color: #31576c; font: 10px/1.45 ui-monospace, monospace; } footer { padding: 16px 28px; color: #597087; border-top: 1px solid #e5edf0; font-size: 12px; } @media print { body { padding: 0; background: #fff; } .ticket { border: 0; box-shadow: none; } }
</style></head><body><article class="ticket"><header><small>Sajilo Yatra · travel ticket</small><h1>Your journey is confirmed</h1></header><main>
<span class="verified">✓ PAYMENT VERIFIED · PAID</span><p class="reference">Booking reference<strong>${escapeHtml(booking.reference)}</strong></p>
<p class="route">${escapeHtml(route)}</p><dl>
<div><dt>Passenger</dt><dd>${escapeHtml(booking.customer.name)}</dd></div><div><dt>Contact</dt><dd>${escapeHtml(booking.customer.phone)}</dd></div>
<div><dt>Boards at</dt><dd>${escapeHtml(ticketDate(booking.journey.boardsAt))}<br>${escapeHtml(nepalTime(booking.journey.boardsAt))} Nepal time</dd></div><div><dt>Vehicle</dt><dd>${escapeHtml(booking.trip.vehicle.name)}<br>${escapeHtml(booking.trip.vehicle.registration)}</dd></div>
<div><dt>Seats</dt><dd>${escapeHtml(seats)}</dd></div><div><dt>Total paid</dt><dd>${escapeHtml(money(booking.amount))}</dd></div>
<div><dt>Boarding point</dt><dd>${escapeHtml(booking.journey.boardingPoint)}</dd></div><div><dt>Drop-off point</dt><dd>${escapeHtml(booking.journey.dropPoint)}</dd></div><div><dt>Driver contact</dt><dd>${escapeHtml(booking.trip.vehicle.operatorContact)}</dd></div></dl>
<p class="code"><strong>Secure verification code</strong><br>${escapeHtml(ticket)}</p></main><footer>Show this ticket to your driver and arrive at least 20 minutes before departure. Keep this file available until your journey is complete.</footer></article></body></html>`;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `sajilo-yatra-ticket-${booking.reference}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="stack ticket-actions no-print">
      <div className="row">
        <Button onClick={download} disabled={pending}>
          <Download size={16} /> {pending ? 'Preparing ticket…' : 'Download ticket'}
        </Button>
        <Button type="button" variant="outline" onClick={() => window.print()}>
          <Printer size={16} /> Print / save PDF
        </Button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
export function SignedTicket({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api<{ ticket: string }>('/api/bookings/' + id + '/ticket'),
  });
  return (
    <details>
      <summary>Secure ticket verification code</summary>
      <p className="muted">Your driver can paste this signed code into the manifest validator.</p>
      <textarea readOnly aria-label="Signed ticket code" value={q.data?.ticket || ''} />
      <ErrorBox error={q.error} />
    </details>
  );
}
export function Clarification({ id }: { id: string }) {
  const copy = useSite().copy;
  const [error, setError] = useState<unknown>(null),
    [sent, setSent] = useState(false),
    [pending, setPending] = useState(false);
  return (
    <form
      className="card stack no-print"
      onSubmit={onForm(async (f, form) => {
        setPending(true);
        setError(null);
        try {
          await api('/api/bookings/' + id + '/clarification', {
            method: 'POST',
            body: JSON.stringify({ message: f.get('message') }),
          });
          setSent(true);
          form.reset();
        } catch (e) {
          setError(e);
        } finally {
          setPending(false);
        }
      })}
    >
      <h2>{copy.booking.messageHeading}</h2>
      <label>
        Clarification or reconciliation details
        <textarea name="message" required minLength={3} maxLength={2000} />
      </label>
      <ErrorBox error={error} />
      {sent && <p className="notice">Your message was recorded.</p>}
      <Button disabled={pending}>{pending ? 'Sending…' : 'Send clarification'}</Button>
    </form>
  );
}
