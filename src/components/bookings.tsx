'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Printer, Undo2 } from 'lucide-react';
import { adminApi, api, Badge, ErrorBox, Skeleton } from './common';
import { Button } from './ui/button';
import { money } from '@/lib/utils';

const npt = (d: string) => new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short' });
const words = (s: string) => s.replaceAll('_', ' ').toLowerCase();

type Detail = {
  id: string;
  reference: string;
  status: string;
  amount: number;
  createdAt: string;
  expiresAt: string;
  customer: { name: string; phone: string; email: string | null };
  passengers: { id: string; name: string; seatLabel: string; boardingPoint: string; destination: string; checkIn: { status: string } | null }[];
  payment: { status: string; method: string; claimedAmount: number | null; verifiedAmount: number | null; transactionRef: string | null; duplicateReference: boolean; note: string } | null;
  cancellation: { reason: string; previousStatus: string; paidAmount: number; refundStatus: string; refundAmount: number | null; refundReference: string | null; refundNote: string; createdAt: string } | null;
  trip: { id: string; departure: string; status: string; vehicle: { name: string; registration: string }; route: { origin: { name: string }; destination: { name: string } } };
  history: { id: string; action: string; actorId: string; createdAt: string; details: Record<string, unknown> }[];
};

/** Refund moves offered for each refund state; the server enforces the same table. */
const REFUND_ACTIONS: Record<string, { action: string; label: string; amount?: boolean; reference?: boolean }[]> = {
  REVIEW_REQUIRED: [
    { action: 'received', label: 'Money arrived — owe a refund', amount: true },
    { action: 'not-received', label: 'Nothing arrived — no refund' },
  ],
  PENDING: [
    { action: 'approve', label: 'Approve refund', amount: true },
    { action: 'decline', label: 'Decline refund' },
  ],
  APPROVED: [
    { action: 'complete', label: 'Mark refund sent', reference: true },
    { action: 'decline', label: 'Decline refund' },
  ],
};

export function BookingDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const     client = useQueryClient();
  const q = useQuery({ queryKey: ['booking', id], queryFn: () => api<Detail>(adminApi('bookings/' + id)) });
  const [mode, setMode] = useState<'' | 'cancel' | 'ticket' | string>(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [done, setDone] = useState('');
  const b = q.data;
  if (!b) return q.isLoading ? <Skeleton /> : <ErrorBox error={q.error} />;
  const refresh = async (message: string) => {
    setMode('');
    setDone(message);
    await client.invalidateQueries({ queryKey: ['booking', id] });
    await client.invalidateQueries({ queryKey: ['reports'] });
    onChanged();
  };
  async function send(path: string, data: Record<string, unknown>, message: string) {
    setPending(true);
    setError(null);
    try {
      await api(adminApi('bookings/' + id + '/' + path), { method: 'POST', body: JSON.stringify(data) });
      await refresh(message);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  const cancellable = ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED', 'PAYMENT_RECONCILIATION_REQUIRED'].includes(b.status);
  const refundActions = b.cancellation ? REFUND_ACTIONS[b.cancellation.refundStatus] ?? [] : [];
  const step = refundActions.find((a) => a.action === mode);
  return (
    <div className="stack booking-detail">
      <div className="spread">
        <div>
          <strong className="mono">{b.reference}</strong>
          <p className="muted" style={{ margin: 0 }}>Booked {npt(b.createdAt)}</p>
        </div>
        <Badge status={b.status} />
      </div>
      {done && <p className="notice success" role="status">{done}</p>}
      <dl className="detail-list">
        <dt>Trip</dt>
        <dd>
          {b.trip.route.origin.name} → {b.trip.route.destination.name} · {npt(b.trip.departure)} <Badge status={b.trip.status} />
        </dd>
        <dt>Vehicle</dt>
        <dd>{b.trip.vehicle.name} · {b.trip.vehicle.registration}</dd>
        <dt>Customer</dt>
        <dd>{b.customer.name} · {b.customer.phone}{b.customer.email ? ' · ' + b.customer.email : ''}</dd>
        <dt>Amount</dt>
        <dd>{money(b.amount)}</dd>
        <dt>Payment</dt>
        <dd>
          {b.payment ? (
            <>
              <Badge status={b.payment.status} /> {b.payment.method}
              {b.payment.claimedAmount ? ' · claimed ' + money(b.payment.claimedAmount) : ''}
              {b.payment.verifiedAmount ? ' · verified ' + money(b.payment.verifiedAmount) : ''}
              {b.payment.transactionRef ? ' · ref ' + b.payment.transactionRef : ''}
              {b.payment.duplicateReference && <strong className="danger-text"> · duplicate reference</strong>}
            </>
          ) : (
            'None'
          )}
        </dd>
      </dl>
      <div className="table-wrap" style={{ margin: 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Seat</th>
              <th>Passenger</th>
              <th>Boarding → drop-off</th>
              <th>Check-in</th>
            </tr>
          </thead>
          <tbody>
            {b.passengers.map((p) => (
              <tr key={p.id}>
                <td>{p.seatLabel}</td>
                <td>{p.name}</td>
                <td>{p.boardingPoint} → {p.destination}</td>
                <td><Badge status={p.checkIn?.status || 'PENDING'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {b.cancellation && (
        <section className="card stack">
          <div className="spread">
            <h3 style={{ margin: 0 }}>Cancellation and refund</h3>
            <Badge status={'REFUND_' + b.cancellation.refundStatus} />
          </div>
          <p style={{ margin: 0 }}>
            Cancelled {npt(b.cancellation.createdAt)} (was {words(b.cancellation.previousStatus)}). Reason: {b.cancellation.reason}
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Paid and verified: {money(b.cancellation.paidAmount)}
            {b.cancellation.refundAmount ? ' · refund approved: ' + money(b.cancellation.refundAmount) : ''}
            {b.cancellation.refundReference ? ' · refund reference ' + b.cancellation.refundReference : ''}
            {b.cancellation.refundNote ? ' · ' + b.cancellation.refundNote : ''}
          </p>
          {b.cancellation.refundStatus === 'REVIEW_REQUIRED' && (
            <p className="notice">The customer uploaded payment proof that was never verified. Check your bank or wallet before deciding.</p>
          )}
          {refundActions.length > 0 && !step && (
            <div className="row">
              {refundActions.map((a) => (
                <Button key={a.action} variant="outline" onClick={() => { setError(null); setMode(a.action); }}>
                  <Undo2 size={15} /> {a.label}
                </Button>
              ))}
            </div>
          )}
          {step && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                send('refund', {
                  action: step.action,
                  note: f.get('note'),
                  ...(step.amount && f.get('amount') ? { amount: Number(f.get('amount')) } : {}),
                  ...(step.reference ? { reference: f.get('reference') } : {}),
                }, 'Refund updated.');
              }}
            >
              <strong>{step.label}</strong>
              {step.amount && (
                <label>
                  {step.action === 'received' ? 'Amount received (NPR) *' : 'Refund amount (NPR) *'}
                  <input
                    name="amount"
                    type="number"
                    min={1}
                    required
                    max={step.action === 'approve' ? b.cancellation!.paidAmount : undefined}
                    defaultValue={step.action === 'approve' ? b.cancellation!.paidAmount : b.payment?.claimedAmount ?? undefined}
                  />
                  {step.action === 'approve' && <small className="muted">At most {money(b.cancellation!.paidAmount)}. Deduct any fee your cancellation policy allows and say why below.</small>}
                </label>
              )}
              {step.reference && (
                <label>
                  Bank or wallet reference of the refund *
                  <input name="reference" required minLength={2} maxLength={100} />
                </label>
              )}
              <label>
                Note for the audit trail *
                <textarea name="note" required minLength={3} maxLength={1000} />
              </label>
              <ErrorBox error={error} />
              <div className="row">
                <Button disabled={pending}>{pending ? 'Saving…' : 'Confirm'}</Button>
                <Button type="button" variant="outline" onClick={() => setMode('')}>Back</Button>
              </div>
            </form>
          )}
        </section>
      )}

      {mode === 'cancel' && (
        <form
          className="card stack danger-zone"
          onSubmit={(e) => {
            e.preventDefault();
            send('cancel', { reason: new FormData(e.currentTarget).get('reason') }, 'Booking cancelled. Its seats are available again.');
          }}
        >
          <strong>Cancel booking {b.reference}?</strong>
          <p className="muted" style={{ margin: 0 }}>
            The seats are released and the customer is notified.
            {b.payment?.status === 'VERIFIED'
              ? ' The verified payment becomes a pending refund for a payment reviewer to approve — nothing is marked as refunded yet.'
              : b.payment && ['SUBMITTED', 'UNDER_REVIEW'].includes(b.payment.status)
                ? ' The uploaded payment proof stays on record for a bank check.'
                : ''}
          </p>
          <label>
            Reason *
            <textarea name="reason" required minLength={3} maxLength={500} placeholder="e.g. Customer requested cancellation by phone" />
          </label>
          <ErrorBox error={error} />
          <div className="row">
            <Button variant="destructive" disabled={pending}>{pending ? 'Cancelling…' : 'Cancel booking'}</Button>
            <Button type="button" variant="outline" onClick={() => setMode('')}>Keep booking</Button>
          </div>
        </form>
      )}
      {mode === 'ticket' && <PrintableTicket id={id} />}

      {!mode && (
        <div className="row">
          {b.status === 'CONFIRMED' && (
            <Button variant="outline" onClick={() => setMode('ticket')}>
              <Printer size={15} /> Print ticket
            </Button>
          )}
          {cancellable && (
            <Button variant="destructive" onClick={() => { setError(null); setDone(''); setMode('cancel'); }}>
              <Ban size={15} /> Cancel booking
            </Button>
          )}
        </div>
      )}
      {!mode && <ErrorBox error={error} />}

      <details>
        <summary>History ({b.history.length})</summary>
        <ol className="history">
          {b.history.map((h) => (
            <li key={h.id}>
              <strong>{words(h.action)}</strong> · {npt(h.createdAt)} · {h.actorId === 'GUEST' ? 'customer' : h.actorId === 'SYSTEM' ? 'system' : 'staff'}
              {typeof h.details?.note === 'string' && <> — {h.details.note}</>}
              {typeof h.details?.reason === 'string' && <> — {h.details.reason}</>}
              {typeof h.details?.message === 'string' && <> — “{h.details.message}”</>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

type Ticket = {
  ticket: string;
  reference: string;
  amount: number;
  customer: { name: string; phone: string };
  passengers: { name: string; seatLabel: string; boardingPoint: string; destination: string }[];
  trip: { departure: string; arrival: string; route: string; vehicle: { name: string; registration: string } };
};
function PrintableTicket({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api<Ticket>(adminApi('bookings/' + id + '/ticket')) });
  const t = q.data;
  if (!t) return q.isLoading ? <Skeleton /> : <ErrorBox error={q.error} />;
  return (
    <div className="stack">
      <div className="ticket print-area">
        <div className="spread">
          <strong>{t.trip.route}</strong>
          <span className="mono">{t.reference}</span>
        </div>
        <p>
          Departs {npt(t.trip.departure)} · {t.trip.vehicle.name} ({t.trip.vehicle.registration})
        </p>
        <p>
          {t.customer.name} · {t.customer.phone} · {money(t.amount)} paid
        </p>
        <ul>
          {t.passengers.map((p) => (
            <li key={p.seatLabel}>
              Seat {p.seatLabel}: {p.name} — {p.boardingPoint} → {p.destination}
            </li>
          ))}
        </ul>
        <p className="muted" style={{ fontSize: 10, wordBreak: 'break-all' }}>Verification code: {t.ticket}</p>
      </div>
      <Button onClick={() => window.print()}>
        <Printer size={15} /> Print
      </Button>
    </div>
  );
}

/** Trip-level cancellation: cancels the trip and every booking on it in one step. */
export function TripCancel({ trip, onDone }: { trip: { id: string; label: string }; onDone: (message: string) => void }) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          const r = await api<{ bookingsCancelled: number; refundsToReview: number }>(adminApi('trips/' + trip.id + '/cancel'), {
            method: 'POST',
            body: JSON.stringify({ reason: new FormData(e.currentTarget).get('reason') }),
          });
          onDone(
            'Trip cancelled. ' + r.bookingsCancelled + ' booking(s) cancelled' +
              (r.refundsToReview ? ', ' + r.refundsToReview + ' refund(s) to review under Bookings.' : '.'),
          );
        } catch (err) {
          setError(err);
        } finally {
          setPending(false);
        }
      }}
    >
      <p style={{ margin: 0 }}>
        <strong>{trip.label}</strong>
      </p>
      <p className="muted" style={{ margin: 0 }}>
        Sales close, the driver is released, and every booking on this trip is cancelled with the reason below. Customers are
        notified. Paid bookings become pending refunds; nothing is marked as refunded automatically.
      </p>
      <label>
        Reason *
        <textarea name="reason" required minLength={3} maxLength={500} placeholder="e.g. Vehicle breakdown" />
      </label>
      <ErrorBox error={error} />
      <Button variant="destructive" disabled={pending}>{pending ? 'Cancelling…' : 'Cancel trip and its bookings'}</Button>
    </form>
  );
}

type Checked = {
  reference: string;
  trip: { departure: string; status: string; vehicle: string; route: string };
  passengers: { name: string; seat: string; boarding: string; destination: string; checkIn: string }[];
};
/** Ticket check for the driver (assigned trips) or the admin. */
export function TicketCheck({ endpoint }: { endpoint: string }) {
  const [result, setResult] = useState<Checked | null>(null),
    [error, setError] = useState<unknown>(null),
    [pending, setPending] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        setError(null);
        setResult(null);
        setPending(true);
        try {
          setResult(await api<Checked>(endpoint, { method: 'POST', body: JSON.stringify({ ticket: new FormData(form).get('ticket') }) }));
          form.reset();
        } catch (err) {
          setError(err);
        } finally {
          setPending(false);
        }
      }}
    >
      <label>
        Ticket verification code *
        <textarea name="ticket" required minLength={10} maxLength={5000} placeholder="Paste or scan the code from the passenger’s ticket" />
      </label>
      <Button disabled={pending}>{pending ? 'Checking…' : 'Check ticket'}</Button>
      <ErrorBox error={error} />
      {result && (
        <div className="notice success" role="status">
          <strong>Valid paid ticket {result.reference}</strong>
          <p style={{ margin: '4px 0' }}>
            {result.trip.route} · {npt(result.trip.departure)} · {result.trip.vehicle}
          </p>
          <ul style={{ margin: 0 }}>
            {result.passengers.map((p) => (
              <li key={p.seat}>
                Seat {p.seat}: {p.name} ({p.boarding} → {p.destination}) · {words(p.checkIn)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
