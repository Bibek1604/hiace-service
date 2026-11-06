'use client';
import { TicketCheck } from './bookings';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Phone, CheckCircle2, BusFront } from 'lucide-react';
import { api, Badge, ErrorBox, Skeleton, Empty, onForm } from './common';
import { Button } from './ui/button';
type DriverTrip = {
  id: string;
  departure: string;
  arrival: string;
  boardingPoint: string;
  dropPoint: string;
  status: string;
  bookingOpen: boolean;
  vehicle: { name: string; registration: string };
  route: { origin: { name: string }; destination: { name: string } };
  seats: { id: string }[];
  confirmedPassengers: number;
  remainingSeats: number;
};
type Passenger = {
  id: string;
  name: string;
  phone: string;
  seatLabel: string;
  boardingPoint: string;
  destination: string;
  checkIn: { status: string } | null;
  booking: { reference: string; status: string; payment: { status: string } | null };
};
type BookingRow = {
  id: string; reference: string; status: string; amount: number; expiresAt: string; createdAt: string;
  customer: { name: string; phone: string; email: string | null };
  trip: { id: string; departure: string; vehicle: { name: string; registration: string }; route: { origin: { name: string }; destination: { name: string } } };
  seats: { tripSeat: { vehicleSeat: { label: string } } }[];
  passengers: { name: string; seatLabel: string; boardingPoint: string; destination: string }[];
  payment: { id: string; status: string; claimedAmount: number | null; transactionRef: string | null; note: string; proofs: { id: string; imageKey: string; remarks: string; createdAt: string }[] } | null;
};
type Availability = { stops: { locationId: string; name: string }[]; seats: { id: string; label: string; blocked: boolean; legs: { state: string }[] }[] };
export function DriverTrips() {
  const [days, setDays] = useState(1);
  const dashboard = useQuery({ queryKey: ['driver-dashboard', days], queryFn: () => api<{ trips: number; upcoming: number; bookings: number; occupiedSeats: number; availableSeats: number; pendingPayments: number; revenue: number }>('/api/driver/dashboard?days=' + days), refetchInterval: 15000 });
  const q = useQuery({
    queryKey: ['driver-trips', days],
    queryFn: () => api<{ items: DriverTrip[] }>('/api/driver/trips?days=' + days),
    refetchInterval: 15000,
  });
  return (
    <>
      <p className="eyebrow">YOUR ROAD AHEAD</p>
      <h1>Assigned trips</h1>
      <p className="muted">Only trips assigned to your driver account appear here.</p>
      <div className="row">{[1, 7, 30].map(value => <Button key={value} variant={days === value ? 'default' : 'outline'} onClick={() => setDays(value)}>{value === 1 ? 'Today' : value + ' days'}</Button>)}</div>
      {dashboard.data && <div className="stats"><div className="stat"><span>Trips</span><strong>{dashboard.data.trips}</strong></div><div className="stat"><span>Upcoming</span><strong>{dashboard.data.upcoming}</strong></div><div className="stat"><span>Bookings</span><strong>{dashboard.data.bookings}</strong></div><div className="stat"><span>Occupied seats</span><strong>{dashboard.data.occupiedSeats}</strong></div><div className="stat"><span>Available seats</span><strong>{dashboard.data.availableSeats}</strong></div><div className="stat"><span>Pending payments</span><strong>{dashboard.data.pendingPayments}</strong></div><div className="stat"><span>Revenue</span><strong>NPR {dashboard.data.revenue.toLocaleString()}</strong></div></div>}
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Skeleton />
      ) : (
        <div className="trip-grid">
          {q.data?.items.map((t) => (
            <div className="card" key={t.id}>
              <div className="spread">
                <BusFront className="blue" />
                <Badge status={t.status} />
              </div>
              <h2>
                {t.route.origin.name} → {t.route.destination.name}
              </h2>
              <p>
                {t.vehicle.name} · {t.vehicle.registration}
              </p>
              <p>{new Date(t.departure).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</p>
              <p className="muted">Arrives {new Date(t.arrival).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</p>
              <dl className="definition">
                <div>
                  <dt>Pickup</dt>
                  <dd>{t.boardingPoint}</dd>
                </div>
                <div>
                  <dt>Drop-off</dt>
                  <dd>{t.dropPoint}</dd>
                </div>
                <div>
                  <dt>Confirmed passengers</dt>
                  <dd>
                    {t.confirmedPassengers} / {t.seats.length}
                  </dd>
                </div>
                <div>
                  <dt>Seats not confirmed</dt>
                  <dd>{t.remainingSeats}</dd>
                </div>
              </dl>
              <Link className="button" href={'/driver/trips/' + t.id}>
                Open passenger manifest →
              </Link>
            </div>
          ))}
          {!q.data?.items.length && <Empty text="No assigned trips" />}
        </div>
      )}
    </>
  );
}
export function DriverBookings() {
  const client = useQueryClient();
  const search = useSearchParams();
  const [tripId, setTripId] = useState(() => search.get('tripId') || ''), [status, setStatus] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState<unknown>(null), [message, setMessage] = useState(''), [manual, setManual] = useState(() => search.get('manual') === '1');
  const trips = useQuery({ queryKey: ['driver-trips'], queryFn: () => api<{ items: DriverTrip[] }>('/api/driver/trips'), refetchInterval: 15000 });
  const bookings = useQuery({
    queryKey: ['driver-bookings', tripId, status],
    queryFn: () => api<BookingRow[]>('/api/driver/bookings?' + new URLSearchParams({ ...(tripId ? { tripId } : {}), ...(status ? { status } : {}) })),
    refetchInterval: 10000,
  });
  const availability = useQuery({ queryKey: ['driver-availability', tripId], enabled: !!tripId, queryFn: () => api<Availability>('/api/driver/trips/' + tripId + '/availability'), refetchInterval: 10000 });
  async function decide(b: BookingRow, action: 'verify' | 'reject' | 'clarify') {
    if (!b.payment) return;
    const note = window.prompt(action === 'verify' ? 'Bank/wallet verification note' : action === 'reject' ? 'Reason for rejection' : 'Question for the passenger');
    if (!note || note.trim().length < 3) return;
    const amount = action === 'verify' ? Number(window.prompt('Verified amount (NPR)', String(b.amount))) : undefined;
    if (action === 'verify' && (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < b.amount)) { setError(new Error('Verified amount must cover the full fare.')); return; }
    setBusy(b.id); setError(null); setMessage('');
    try {
      await api('/api/driver/payments/' + b.payment.id, { method: 'POST', body: JSON.stringify({ action, note: note.trim(), ...(action === 'verify' ? { verifiedAmount: amount, confirm: true, bankEvidence: note.trim() } : {}) }) });
      setMessage(action === 'verify' ? 'Payment verified and seats confirmed.' : action === 'reject' ? 'Booking rejected and reserved seats released.' : 'Clarification request sent.');
      await Promise.all([client.invalidateQueries({ queryKey: ['driver-bookings'] }), client.invalidateQueries({ queryKey: ['driver-availability'] }), client.invalidateQueries({ queryKey: ['driver-trips'] })]);
    } catch (e) { setError(e); } finally { setBusy(''); }
  }
  async function control(t: DriverTrip, patch: Record<string, unknown>) {
    setBusy(t.id); setError(null);
    try { await api('/api/driver/trips/' + t.id, { method: 'PATCH', body: JSON.stringify(patch) }); await client.invalidateQueries({ queryKey: ['driver-trips'] }); }
    catch (e) { setError(e); } finally { setBusy(''); }
  }
  return <>
    <p className="eyebrow">BOOKING CONTROL</p><h1>Bookings and payments</h1>
    <p className="muted">Review bookings only for trips assigned to you. Seat holds, confirmed seats, and released seats update automatically.</p>
    {message && <p className="notice success" role="status">{message}</p>}<ErrorBox error={error || bookings.error || availability.error} />
    <div className="grid-2 card"><label>Trip<select value={tripId} onChange={(e) => setTripId(e.target.value)}><option value="">All assigned trips</option>{trips.data?.items.map(t => <option key={t.id} value={t.id}>{t.route.origin.name} → {t.route.destination.name} · {new Date(t.departure).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</option>)}</select></label><label>Booking status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['HELD','PAYMENT_REVIEW','CONFIRMED','REJECTED','CANCELLED','EXPIRED','PAYMENT_RECONCILIATION_REQUIRED'].map(s => <option key={s}>{s}</option>)}</select></label></div>
    {tripId && <div className="card"><div className="spread"><h2>Live seat availability</h2><Button variant="outline" onClick={() => setManual(v => !v)}>Add offline booking</Button></div><p className="muted">Available seat legs: {availability.data?.seats.reduce((total, seat) => total + seat.legs.filter(leg => leg.state === 'AVAILABLE').length, 0) ?? '…'} · held: {availability.data?.seats.reduce((total, seat) => total + seat.legs.filter(leg => leg.state === 'HELD').length, 0) ?? '…'} · booked: {availability.data?.seats.reduce((total, seat) => total + seat.legs.filter(leg => leg.state === 'BOOKED').length, 0) ?? '…'}</p><p className="muted">{availability.data?.stops.map(s => s.name).join(' → ')}</p>{manual && <form className="stack" onSubmit={onForm(async (f, form) => { setError(null); setBusy('manual'); try { const paid = f.get('paid') === 'on'; const result = await api<{ reference: string; status: string }>('/api/driver/manual-bookings', { method: 'POST', body: JSON.stringify({ tripId, seats: f.getAll('seats'), name: f.get('name'), phone: f.get('phone'), email: f.get('email') || undefined, fromLocationId: f.get('fromLocationId'), toLocationId: f.get('toLocationId'), paid, ...(paid ? { amount: Number(f.get('amount')), method: f.get('method'), note: f.get('note') } : {}) }) }); form.reset(); setMessage('Offline booking ' + result.reference + ' is ' + result.status.toLowerCase() + '.'); setManual(false); await Promise.all([client.invalidateQueries({ queryKey: ['driver-bookings'] }), client.invalidateQueries({ queryKey: ['driver-availability'] }), client.invalidateQueries({ queryKey: ['driver-trips'] })]); } catch (e) { setError(e); } finally { setBusy(''); } })}><h3>Phone / WhatsApp / counter booking</h3><div className="grid-2"><label>Passenger name<input name="name" required minLength={2} /></label><label>Phone<input name="phone" required placeholder="+97798…" /></label><label>Boarding<select name="fromLocationId" required defaultValue="">{availability.data?.stops.slice(0, -1).map(s => <option key={s.locationId} value={s.locationId}>{s.name}</option>)}</select></label><label>Destination<select name="toLocationId" required defaultValue="">{availability.data?.stops.slice(1).map(s => <option key={s.locationId} value={s.locationId}>{s.name}</option>)}</select></label><label>Seats<select name="seats" multiple required size={5}>{availability.data?.seats.filter(s => !s.blocked).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label><label><input name="paid" type="checkbox" /> Payment received offline</label><label>Amount if paid<input name="amount" type="number" min={1} /></label><label>Method<input name="method" defaultValue="CASH" /></label></div><label>Payment / booking note<textarea name="note" maxLength={1000} /></label><Button disabled={busy === 'manual'}>{busy === 'manual' ? 'Saving…' : 'Create offline booking'}</Button></form>}</div>}
    <div className="trip-grid">{trips.data?.items.filter(t => !tripId || t.id === tripId).map(t => <div className="card" key={t.id}><div className="spread"><h2>{t.route.origin.name} → {t.route.destination.name}</h2><Badge status={t.status} /></div><p>{t.confirmedPassengers} confirmed · {t.remainingSeats} not confirmed</p><div className="row"><Button variant="outline" disabled={busy === t.id || t.status !== 'SCHEDULED'} onClick={() => control(t, { bookingOpen: !t.bookingOpen })}>{t.bookingOpen ? 'Close booking' : 'Open booking'}</Button><Button variant="outline" disabled={busy === t.id || t.status !== 'SCHEDULED'} onClick={() => control(t, { status: 'BOARDING' })}>Start boarding</Button><Button variant="outline" disabled={busy === t.id || t.status !== 'BOARDING'} onClick={() => control(t, { status: 'DEPARTED', bookingOpen: false })}>Depart</Button></div></div>)}</div>
    {bookings.isLoading ? <Skeleton /> : <div className="stack">{bookings.data?.map(b => <article className="card" key={b.id}><div className="spread"><div><small className="muted">{b.reference} · {new Date(b.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</small><h2>{b.customer.name} · NPR {b.amount.toLocaleString()}</h2></div><div className="row"><Badge status={b.status} />{b.payment && <Badge status={b.payment.status} />}</div></div><p>{b.trip.route.origin.name} → {b.trip.route.destination.name} · seats {b.seats.map(s => s.tripSeat.vehicleSeat.label).join(', ') || 'released'}</p>{b.passengers.map(p => <p className="muted" key={p.seatLabel}>{p.seatLabel}: {p.boardingPoint} → {p.destination}</p>)}<p><a href={'tel:' + b.customer.phone}>{b.customer.phone}</a>{b.customer.email ? ' · ' + b.customer.email : ''}</p>{b.payment?.proofs.map(p => <a className="button outline" key={p.id} href={'/api/images/' + p.imageKey} target="_blank">View payment proof</a>)}{b.payment && ['SUBMITTED', 'UNDER_REVIEW'].includes(b.payment.status) && <div className="row"><Button disabled={busy === b.id} onClick={() => decide(b, 'verify')}>Approve payment</Button><Button variant="outline" disabled={busy === b.id} onClick={() => decide(b, 'reject')}>Reject & release seats</Button><Button variant="outline" disabled={busy === b.id} onClick={() => decide(b, 'clarify')}>Ask clarification</Button></div>}</article>)}{!bookings.data?.length && <Empty text="No bookings match these filters" />}</div>}
  </>;
}

type HistoryTrip = {
  id: string;
  departure: string;
  arrival: string;
  status: string;
  vehicle: { name: string; registration: string };
  route: { origin: { name: string }; destination: { name: string } };
  bookings: { id: string; passengers: { id: string }[] }[];
};

export function DriverHistory() {
  const q = useQuery({ queryKey: ['driver-history'], queryFn: () => api<{ items: HistoryTrip[] }>('/api/driver/history') });
  return (
    <>
      <p className="eyebrow">PAST OPERATIONS</p>
      <h1>Trip, booking and passenger history</h1>
      <p className="muted">Completed, departed, cancelled, and past departures remain available here for your records.</p>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Skeleton /> : (
        <div className="trip-grid">
          {q.data?.items.map((trip) => {
            const passengers = trip.bookings.reduce((total, booking) => total + booking.passengers.length, 0);
            return (
              <article className="card" key={trip.id}>
                <div className="spread"><h2>{trip.route.origin.name} → {trip.route.destination.name}</h2><Badge status={trip.status} /></div>
                <p>{trip.vehicle.name} · {trip.vehicle.registration}</p>
                <p>{new Date(trip.departure).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</p>
                <p className="muted">{trip.bookings.length} bookings · {passengers} passengers</p>
                <div className="row">
                  <Link className="button outline" href={'/driver/bookings?tripId=' + trip.id}>Booking history</Link>
                  <Link className="button outline" href={'/driver/passengers?tripId=' + trip.id}>Passenger history</Link>
                </div>
              </article>
            );
          })}
          {!q.data?.items.length && <Empty text="No past trips yet" />}
        </div>
      )}
    </>
  );
}
export function DriverManifest({ tripId }: { tripId?: string }) {
  const [search, setSearch] = useState(''),
    [pending, setPending] = useState(''),
    [error, setError] = useState<unknown>(null),
    [issue, setIssue] = useState(false),
    [message, setMessage] = useState('');
  const client = useQueryClient();
  const trips = useQuery({
    queryKey: ['driver-trips'],
    queryFn: () => api<{ items: DriverTrip[] }>('/api/driver/trips'),
  });
  const params = useSearchParams();
  const [chosen, setChosen] = useState(tripId || params.get('tripId') || '');
  const q = useQuery({
    queryKey: ['manifest', chosen],
    enabled: !!chosen,
    queryFn: () =>
      api<{ items: Passenger[] }>('/api/driver/passengers?tripId=' + encodeURIComponent(chosen)),
    refetchInterval: 15000,
  });
  const t = trips.data?.items.find((t) => t.id === chosen);
  async function check(p: Passenger, status: string) {
    setPending(p.id);
    setError(null);
    try {
      await api('/api/driver/check-in', {
        method: 'POST',
        body: JSON.stringify({ passengerId: p.id, status }),
      });
      await client.invalidateQueries({ queryKey: ['manifest', chosen] });
    } catch (e) {
      setError(e);
    } finally {
      setPending('');
    }
  }
  return (
    <>
      <p className="eyebrow">PASSENGER OPERATIONS</p>
      <h1>Passenger manifest</h1>
      <details className="card">
        <summary>Check a passenger’s ticket</summary>
        <TicketCheck endpoint="/api/driver/validate-ticket" />
      </details>
      {!tripId && (
        <label>
          Assigned trip
          <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">Choose your trip</option>
            {trips.data?.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.route.origin.name} → {t.route.destination.name} ·{' '}
                {new Date(t.departure).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}
              </option>
            ))}
          </select>
        </label>
      )}
      {t && (
        <div className="card">
          <h2>
            {t.route.origin.name} → {t.route.destination.name}
          </h2>
          <p>
            {t.vehicle.name} · {t.vehicle.registration}
            <br />
            {new Date(t.departure).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}
          </p>
          <p>
            {t.boardingPoint} → {t.dropPoint}
          </p>
          <Badge status={t.status} />
        </div>
      )}
      <div className="notice">
        Only confirmed, verified passengers appear on this manifest. Drivers cannot change payment
        verification.
      </div>
      <label>
        Search passengers
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name, seat number, or booking reference"
        />
      </label>
      <ErrorBox error={error || q.error || trips.error} />
      {q.isLoading ? (
        <Skeleton />
      ) : (
        q.data?.items
          .filter((p) =>
            (p.name + p.seatLabel + p.booking.reference)
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((p) => (
            <div className="card" key={p.id}>
              <div className="spread">
                <h2>{p.name}</h2>
                <span className="price">{p.seatLabel}</span>
              </div>
              <div className="row">
                <Badge
                  status={
                    p.booking.payment?.status === 'VERIFIED'
                      ? 'VERIFIED / PAID'
                      : 'PENDING VERIFICATION'
                  }
                />
                <Badge status={p.checkIn?.status || 'EXPECTED'} />
              </div>
              <p>
                {p.boardingPoint} → {p.destination}
                <br />
                <small className="muted">{p.booking.reference}</small>
              </p>
              <div className="row">
                <a className="button outline" href={'tel:' + p.phone}>
                  <Phone size={16} />
                  {p.phone}
                </a>
                <Button
                  variant="outline"
                  disabled={pending === p.id || !!p.checkIn}
                  onClick={() => check(p, 'CHECKED_IN')}
                >
                  Check in
                </Button>
                <Button
                  disabled={pending === p.id || p.checkIn?.status === 'BOARDED'}
                  onClick={() => check(p, 'BOARDED')}
                >
                  <CheckCircle2 size={16} />
                  {pending === p.id ? 'Saving…' : 'Boarded'}
                </Button>
              </div>
            </div>
          ))
      )}
      {chosen && !q.isLoading && !q.data?.items.length && !q.error && (
        <Empty text="No confirmed passengers yet" />
      )}
      {chosen && (
        <>
          <Button variant="outline" onClick={() => setIssue((o) => !o)}>
            Report a booking issue
          </Button>
          {issue && (
            <form
              className="card stack"
              onSubmit={onForm(async (f) => {
                setError(null);
                try {
                  await api('/api/driver/issues', {
                    method: 'POST',
                    body: JSON.stringify({ tripId: chosen, note: f.get('note') }),
                  });
                  setIssue(false);
                  setMessage('Issue recorded for the admin.');
                } catch (e) {
                  setError(e);
                }
              })}
            >
              <label>
                What happened?
                <textarea name="note" minLength={3} maxLength={2000} required />
              </label>
              <Button>Send issue to admin</Button>
            </form>
          )}
          {message && <p className="notice">{message}</p>}
        </>
      )}
    </>
  );
}
