'use client';
import { SignedTicket, Clarification } from './booking-tools';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BusFront,
  ArrowRight,
  ArrowLeft,
  Clock3,
  Armchair,
  CircleGauge,
  Download,
  Upload,
  CheckCircle2,
  Phone,
  Ticket,
} from 'lucide-react';
import { api, ErrorBox, Skeleton, Badge, Sheet, Empty, Unavailable, onForm } from './common';
import { useSite } from './site-context';
import { Button } from './ui/button';
import { money, nepalTime } from '@/lib/utils';
import type { BookingView, TripView } from '@/lib/types';
const dateLabel = (d: string) =>
  new Date(d).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Kathmandu',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
export function SearchForm({ initial = {} }: { initial?: Record<string, string> }) {
  const copy = useSite().copy;
  const [origin, setOrigin] = useState(initial.origin || ''),
    [destination, setDestination] = useState(initial.destination || ''),
    [date, setDate] = useState(initial.date || '');
  const router = useRouter();
  const locations = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ id: string; name: string }[]>('/api/locations'),
  });
  return (
    <>
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new URLSearchParams({ origin, destination, date });
          router.push('/search?' + q);
        }}
      >
        <label className="search-from">
          FROM
          <input
            aria-label="From"
            list="search-locations"
            value={origin}
            placeholder={copy.search.from}
            onChange={(e) => setOrigin(e.target.value)}
          />
        </label>
        <label className="search-to">
          TO
          <input
            aria-label="To"
            list="search-locations"
            value={destination}
            placeholder={copy.search.to}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <label>
          TRAVEL DATE
          <input
            aria-label="Travel date"
            type="date"
            value={date}
            min={new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' })}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <Button type="submit">
          {copy.search.button} <ArrowRight size={17} />
        </Button>
      </form>
      <datalist id="search-locations">
        {locations.data?.map((location) => <option key={location.id} value={location.name} />)}
      </datalist>
      <ErrorBox error={locations.error} />
    </>
  );
}
export function TripCard({ trip: t }: { trip: TripView }) {
  const copy = useSite().copy;
  return (
    <article className="trip-card">
      {t.vehicle.images[0] ? (
        <img
          className="trip-photo"
          src={'/api/images/' + t.vehicle.images[0].key}
          alt={t.vehicle.name}
          loading="lazy"
        />
      ) : (
        <div className="vehicle-placeholder">
          <BusFront size={56} strokeWidth={1.25} />
        </div>
      )}
      <div className="trip-body">
        <div className="trip-top">
          <div>
            <h3>{t.vehicle.name}</h3>
            <span className="muted" style={{ fontSize: 11 }}>
              {t.vehicle.operator} · {t.vehicle.type}
            </span>
          </div>
          <Badge
            status={t.available === 0 ? 'SOLD OUT' : String(t.available ?? 0) + ' seats left'}
          />
        </div>
        <div className="trip-route">
          {t.route.origin.name} <span className="blue">→</span> {t.route.destination.name}
        </div>
        <div className="times">
          <div>
            <strong>{nepalTime(t.departure)}</strong>
            <div className="muted" style={{ fontSize: 10 }}>
              {dateLabel(t.departure)}
            </div>
          </div>
          <span className="line" />
          <Clock3 size={15} className="muted" />
          <span className="muted" style={{ fontSize: 11 }}>
            {Math.floor(t.route.durationMinutes / 60)}h {t.route.durationMinutes % 60}m
          </span>
          <span className="line" />
          <strong>{nepalTime(t.arrival)}</strong>
        </div>
        <div className="trip-meta">
          {t.vehicle.amenities.map((a) => (
            <span key={a}>✓ {a}</span>
          ))}
        </div>
        <div className="trip-footer">
          <span className="price">
            {money(t.fare)} <small>{copy.search.perSeat}</small>
          </span>
          <Link href={'/trips/' + t.id} className="button">
            Choose seats <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </article>
  );
}
export function TripResults({ filters = '', home = false }: { filters?: string; home?: boolean }) {
  const copy = useSite().copy;
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['trips', filters, page],
    queryFn: () =>
      api<{ items: TripView[]; nextPage: number | null }>(
        '/api/trips?' + filters + '&page=' + page,
      ),
  });
  return (
    <>
      <div className="trip-grid">
        {q.isLoading ? (
          <>
            <Skeleton />
            <Skeleton />
          </>
        ) : q.data?.items.length ? (
          (home ? q.data.items.slice(0, 4) : q.data.items).map((t) => (
            <TripCard key={t.id} trip={t} />
          ))
        ) : q.error ? (
          <Unavailable error={q.error} retry={() => q.refetch()} text={copy.search.errorTitle} detail={copy.search.errorText} />
        ) : (
          <Empty
            text={copy.search.emptyTitle}
            detail={
              home
                ? copy.search.emptyHome
                : copy.search.emptySearch
            }
          >
            {!home && (
              <Link href="/search" className="button">
                Clear search
              </Link>
            )}
            <Link href="/track-booking" className="button outline">
              Track a booking
            </Link>
          </Empty>
        )}
      </div>
      {!home && (
        <div className="pagination">
          <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>Page {page}</span>
          <Button
            variant="outline"
            disabled={!q.data?.nextPage}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}
export function TripDetail({ id }: { id: string }) {
  const copy = useSite().copy;
  const q = useQuery({
    queryKey: ['trip', id],
    queryFn: () => api<TripView>('/api/trips/' + id),
    refetchInterval: 5000,
  });
  const [selected, setSelected] = useState<string[]>([]),
    [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const router = useRouter();
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('seats_' + id) || '[]');
      if (Array.isArray(saved)) setSelected(saved.filter((x) => typeof x === 'string'));
    } catch {}
  }, [id]);
  const t = q.data,
    valid = selected.filter((s) => t?.seats.some((x) => x.id === s && x.state === 'AVAILABLE'));
  async function book(form: FormData) {
    setPending(true);
    setError(null);
    try {
      let key = sessionStorage.getItem('reserve_' + id);
      const fingerprint = JSON.stringify({
        seats: valid,
        name: form.get('name'),
        phone: form.get('phone'),
        email: form.get('email'),
      });
      if (sessionStorage.getItem('reserve_data_' + id) !== fingerprint || !key) {
        key = crypto.randomUUID();
        sessionStorage.setItem('reserve_' + id, key);
        sessionStorage.setItem('reserve_data_' + id, fingerprint);
      }
      const b = await api<{ id: string }>('/api/bookings', {
        method: 'POST',
        body: JSON.stringify({
          tripId: id,
          seats: valid,
          name: form.get('name'),
          phone: form.get('phone'),
          email: form.get('email'),
          idempotencyKey: key,
        }),
      });
      localStorage.removeItem('seats_' + id);
      router.push('/booking/' + b.id);
    } catch (e) {
      setError(e);
      await q.refetch();
    } finally {
      setPending(false);
    }
  }
  if (q.isLoading)
    return (
      <main className="container narrow">
        <Skeleton />
      </main>
    );
  if (!t)
    return (
      <main className="container narrow">
        <Unavailable error={q.error} retry={() => q.refetch()} />
      </main>
    );
  const labels = valid.map((s) => t.seats.find((x) => x.id === s)!.label);
  return (
    <main className="container narrow">
      <Link href="/search" className="muted row">
        <ArrowLeft size={16} /> Back to rides
      </Link>
      <p className="eyebrow" style={{ marginTop: 25 }}>
        CHOOSE YOUR JOURNEY
      </p>
      <h1 style={{ fontSize: 32 }}>
        {t.route.origin.name} <span className="blue">→</span> {t.route.destination.name}
      </h1>
      <div className="row">
        <Badge status={t.vehicle.type} />
        <span className="muted">
          {dateLabel(t.departure)} · {nepalTime(t.departure)}
        </span>
      </div>
      <div className="card">
        <h2>{t.vehicle.name}</h2>
        {t.vehicle.images.length > 0 && (
          <div className="row" style={{ overflowX: 'auto', flexWrap: 'nowrap' }}>
            {t.vehicle.images.map((i) => (
              <img
                key={i.key}
                alt={t.vehicle.name}
                src={'/api/images/' + i.key}
                style={{ width: 240, height: 150, objectFit: 'cover', borderRadius: 12 }}
              />
            ))}
          </div>
        )}
        <dl className="definition">
          <div>
            <dt>Vehicle number</dt>
            <dd>{t.vehicle.registration}</dd>
          </div>
          <div>
            <dt>Driver</dt>
            <dd>{t.assignments[0]?.driver.name || copy.trip.driverPending}</dd>
          </div>
          <div>
            <dt>Pickup</dt>
            <dd>{t.boardingPoint}</dd>
          </div>
          <div>
            <dt>Drop-off</dt>
            <dd>{t.dropPoint}</dd>
          </div>
          <div>
            <dt>Estimated arrival</dt>
            <dd>
              {dateLabel(t.arrival)} · {nepalTime(t.arrival)}
            </dd>
          </div>
          <div>
            <dt>Driver contact</dt>
            <dd>
              <a href={'tel:' + t.vehicle.operatorContact}>{t.vehicle.operatorContact}</a>
            </dd>
          </div>
        </dl>
        <p className="muted">{t.vehicle.description}</p>
        <div className="row">
          {t.vehicle.amenities.map((a) => (
            <Badge key={a} status={a} />
          ))}
        </div>
        {t.route.stops.length > 0 && (
          <p>Via {t.route.stops.map((s) => s.location.name).join(' · ')}</p>
        )}
      </div>
      <div className="card">
        <div className="spread">
          <div>
            <h2>{copy.trip.seatHeading}</h2>
            <p className="muted">Live availability · Up to 8 seats</p>
          </div>
          <Armchair className="blue" />
        </div>
        <div className="legend">
          {[
            ['Available', '#6bbf92'],
            ['Selected', '#2563eb'],
            ['Held', '#e5c65b'],
            ['Paid', '#de7f76'],
            ['Blocked', '#bcc5d0'],
          ].map(([name, color]) => (
            <span key={name}>
              <i style={{ background: color }} />
              {name}
            </span>
          ))}
        </div>
        <div className="seat-map">
          <div className="seat-front">
            <span>{copy.trip.front}</span>
            <CircleGauge size={27} />
          </div>
          <div className="seat-grid">
            {t.seats
              .sort((a, b) => a.row - b.row || a.column - b.column)
              .map((s) => (
                <button
                  key={s.id}
                  aria-label={
                    'Seat ' +
                    s.label +
                    ', ' +
                    (valid.includes(s.id) ? 'selected' : s.state.toLowerCase())
                  }
                  aria-pressed={valid.includes(s.id)}
                  className={'seat ' + (valid.includes(s.id) ? 'selected' : s.state.toLowerCase())}
                  style={{
                    gridColumn: s.column >= 2 ? s.column + 2 : s.column + 1,
                    gridRow: s.row + 1,
                  }}
                  disabled={s.state !== 'AVAILABLE' || !t.bookingOpen || t.status !== 'SCHEDULED'}
                  onClick={() => {
                    const next = valid.includes(s.id)
                      ? valid.filter((v) => v !== s.id)
                      : valid.length < 8
                        ? [...valid, s.id]
                        : valid;
                    setSelected(next);
                    localStorage.setItem('seats_' + id, JSON.stringify(next));
                  }}
                >
                  {s.label}
                </button>
              ))}
          </div>
        </div>
        <p className="muted" style={{ textAlign: 'center', fontSize: 11 }}>
          Seats are held only after you submit contact details.
        </p>
      </div>
      <ErrorBox error={q.error} />
      <div className="sticky-action">
        <div>
          <small className="muted">
            {labels.length ? 'Seats ' + labels.join(', ') : copy.trip.selectSeats}
          </small>
          <div className="price">{money(valid.length * t.fare)}</div>
        </div>
        <Button
          disabled={!valid.length || !t.bookingOpen || t.status !== 'SCHEDULED'}
          onClick={() => setOpen(true)}
        >
          Continue <ArrowRight size={17} />
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen} title={copy.trip.travellerSheet}>
        <p className="notice">
          Seats {labels.join(', ')} · {money(valid.length * t.fare)}
          <br />
          No account needed. Your seats will be held while you pay.
        </p>
        <form onSubmit={onForm(book)} className="stack">
          <label>
            Passenger name
            <input
              name="name"
              required
              minLength={2}
              maxLength={100}
              autoComplete="name"
              placeholder="Full name"
            />
          </label>
          <label>
            Mobile number
            <input
              name="phone"
              required
              type="tel"
              autoComplete="tel"
              pattern="(\+977)?[0-9]{10}"
              placeholder="98XXXXXXXX"
            />
          </label>
          <label>
            Email (optional)
            <input
              name="email"
              type="email"
              maxLength={254}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </label>
          <p className="muted" style={{ fontSize: 11 }}>
            This contact will be used for all selected seats. Add an email to receive your booking
            number, seats, route and time once payment is confirmed, and to recover your booking later.
          </p>
          <ErrorBox error={error} />
          <Button type="submit" disabled={pending || !valid.length}>
            {pending ? copy.trip.holding : copy.trip.holdButton}
          </Button>
        </form>
      </Sheet>
    </main>
  );
}
function Deadline({ value }: { value: string }) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const run = () => setLeft(Math.max(0, new Date(value).getTime() - Date.now()));
    run();
    const timer = setInterval(run, 1000);
    return () => clearInterval(timer);
  }, [value]);
  return (
    <strong>
      {Math.floor(left / 60000)}:{String(Math.floor(left / 1000) % 60).padStart(2, '0')}
    </strong>
  );
}
export function BookingPage({ id, statusPage = false }: { id: string; statusPage?: boolean }) {
  const copy = useSite().copy;
  const q = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api<BookingView>('/api/bookings/' + id),
    refetchInterval: 8000,
  });
  const history = useQuery({
    queryKey: ['booking-history', id],
    queryFn: () => api<{ items: { action: string; createdAt: string }[] }>('/api/bookings/' + id + '/history'),
    enabled: !!q.data,
  });
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const router = useRouter();
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  async function submit(form: FormData) {
    if (!file) return;
    setPending(true);
    setError(null);
    form.set('image', file);
    try {
      await api('/api/bookings/' + id + '/proof', { method: 'POST', body: form });
      await q.refetch();
      router.push('/booking/' + id + '/status');
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  const b = q.data;
  if (q.isLoading)
    return (
      <main className="container narrow">
        <Skeleton />
      </main>
    );
  if (!b)
    return (
      <main className="container narrow">
        <h1>{copy.booking.accessTitle}</h1>
        <ErrorBox error={q.error} />
        <Link className="button" href="/track-booking">
          {copy.booking.accessButton}
        </Link>
      </main>
    );
  const held = b.status === 'HELD' && new Date(b.expiresAt) > new Date(),
    confirmed = b.status === 'CONFIRMED' && b.payment?.status === 'VERIFIED';
  return (
    <main className="container narrow">
      <p className="eyebrow">{copy.booking.eyebrow}</p>
      <h1 style={{ fontSize: 32 }}>
        {confirmed
          ? copy.booking.readyTitle
          : statusPage
            ? copy.booking.statusTitle
            : copy.booking.completeTitle}
      </h1>
      <div className="row">
        <Badge status={b.status} />
        <Badge status={b.payment?.status || 'UNPAID'} />
      </div>
      <div className="card">
        <div className="spread">
          <div>
            <small className="muted">Booking reference</small>
            <h2 style={{ letterSpacing: 1, margin: '6px 0' }}>{b.reference}</h2>
          </div>
          <Ticket className="blue" size={30} />
        </div>
        <h3>
          {b.trip.route.origin.name} → {b.trip.route.destination.name}
        </h3>
        <dl className="definition">
          <div>
            <dt>Passenger</dt>
            <dd>{b.customer.name}</dd>
          </div>
          <div>
            <dt>Contact</dt>
            <dd>{b.customer.phone}</dd>
          </div>
          <div>
            <dt>Departure</dt>
            <dd>
              {dateLabel(b.trip.departure)}
              <br />
              {nepalTime(b.trip.departure)}
            </dd>
          </div>
          <div>
            <dt>Vehicle</dt>
            <dd>
              {b.trip.vehicle.name}
              <br />
              {b.trip.vehicle.registration}
            </dd>
          </div>
          <div>
            <dt>Your seats</dt>
            <dd>{b.seats.map((s) => s.tripSeat.vehicleSeat.label).join(', ')}</dd>
          </div>
          <div>
            <dt>Total payable</dt>
            <dd className="price">{money(b.amount)}</dd>
          </div>
          <div>
            <dt>Boarding point</dt>
            <dd>{b.trip.boardingPoint}</dd>
          </div>
          <div>
            <dt>Drop-off point</dt>
            <dd>{b.trip.dropPoint}</dd>
          </div>
        </dl>
      </div>
      {b.status === 'PAYMENT_REVIEW' && (
        <div className="notice">
          <strong>{copy.booking.proofSubmitted}</strong>
          <p>
            An admin will check the actual bank or wallet transaction. Seat review window:{' '}
            <Deadline value={b.expiresAt} />. Uploading a screenshot does not confirm payment.
          </p>
        </div>
      )}
      {b.status === 'PAYMENT_RECONCILIATION_REQUIRED' && (
        <div className="notice">
          <strong>Seats are no longer guaranteed.</strong>
          <p>
            {b.payment?.status === 'VERIFIED'
              ? 'Your payment is verified, but the original seats are unavailable.'
              : 'Your proof is preserved and verification is pending.'}{' '}
            Contact the driver to arrange an alternative seat, trip, or refund.
          </p>
          <a href={'tel:' + b.trip.vehicle.operatorContact} className="button outline">
            <Phone size={16} />
            Contact driver
          </a>
        </div>
      )}
      {b.status === 'EXPIRED' && (
        <div className="notice">
          Your payment deadline passed and seats have been released. If you already paid, contact
          the driver before booking again.
        </div>
      )}
      {b.status === 'REJECTED' && (
        <div className="error">
          Payment proof was rejected and seats were released. {b.payment?.note} Contact the driver
          if you paid.
        </div>
      )}
      {confirmed && (
        <div className="ticket">
          <CheckCircle2 className="blue" size={36} />
          <h2>{copy.booking.ticketHeading}</h2>
          <p className="ticket-code">{b.reference}</p>
          <p>
            Seats {b.seats.map((s) => s.tripSeat.vehicleSeat.label).join(', ')} · VERIFIED / PAID
          </p>
          <p className="muted">
            Show this ticket to your driver. Please arrive 20 minutes before departure.
          </p>
          <Button variant="outline" onClick={() => window.print()}>
            <Download size={16} />
            Save / print ticket
          </Button>
          <SignedTicket id={id} />
        </div>
      )}
      {held && (
        <>
          <div className="card">
            <div className="spread">
              <h2>{copy.booking.payHeading}</h2>
              <Badge status="AWAITING PAYMENT" />
            </div>
            <div className="notice">
              Payment deadline <Deadline value={b.expiresAt} />
              <br />
              <small>
                {new Date(b.expiresAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}{' '}
                Nepal time
              </small>
            </div>
            <p className="muted">
              Save this QR to your phone, then open your banking or wallet app and select it from
              your gallery.
            </p>
            <img
              src={'/api/images/' + b.qrSnapshot.imageKey}
              className="qr-image"
              alt={'Payment QR for ' + b.qrSnapshot.label}
            />
            <div style={{ textAlign: 'center' }}>
              <strong>{b.qrSnapshot.label}</strong>
              <p>
                {b.qrSnapshot.accountName}
                {b.qrSnapshot.accountNumber && (
                  <>
                    <br />
                    {b.qrSnapshot.accountNumber}
                  </>
                )}
              </p>
              <a
                className="button outline"
                href={'/api/images/' + b.qrSnapshot.imageKey + '?download=1'}
                download
              >
                <Download size={16} />
                Save QR image
              </a>
            </div>
            <p className="notice">{b.qrSnapshot.instructions}</p>
            <p>
              Pay exactly <strong>{money(b.amount)}</strong>. Use <strong>{b.reference}</strong> as
              your remarks when possible.
            </p>
          </div>
          <div className="card">
            <h2>{copy.booking.proofHeading}</h2>
            <p className="muted">
              Pay first, then upload a clear screenshot with transaction details. Admin verification
              is required.
            </p>
            <form onSubmit={onForm(submit)} className="stack">
              <label>
                Payment screenshot (JPEG, PNG, WebP · max 5 MB)
                <input
                  type="file"
                  name="image"
                  accept="image/jpeg,image/png,image/webp"
                  required
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f && f.size > 5 * 1024 * 1024) {
                      setError(new Error('Choose a screenshot under 5 MB.'));
                      e.target.value = '';
                      setFile(null);
                    } else {
                      setFile(f || null);
                      setError(null);
                    }
                  }}
                />
              </label>
              {preview && (
                <img className="proof-preview" src={preview} alt="Payment screenshot preview" />
              )}
              <div className="grid-2">
                <label>
                  Amount paid (NPR)
                  <input
                    name="claimedAmount"
                    type="number"
                    min="1"
                    step="1"
                    required
                    defaultValue={b.amount}
                  />
                </label>
                <label>
                  Bank / wallet used
                  <input name="method" required maxLength={80} placeholder="Bank or wallet name" />
                </label>
              </div>
              <label>
                Transaction reference (if available)
                <input name="transactionRef" maxLength={100} autoComplete="off" />
              </label>
              <label>
                Remarks (optional)
                <textarea name="remarks" maxLength={1000} />
              </label>
              <ErrorBox error={error} />
              <Button type="submit" disabled={pending || !file}>
                <Upload size={17} />
                {pending ? 'Uploading payment proof…' : copy.booking.proofButton}
              </Button>
            </form>
          </div>
        </>
      )}
      {['PAYMENT_REVIEW', 'PAYMENT_RECONCILIATION_REQUIRED'].includes(b.status) && (
        <Clarification id={id} />
      )}
      {b.payment?.note && b.status !== 'REJECTED' && (
        <div className="notice">
          <strong>Message from the driver</strong>
          <p>{b.payment.note}</p>
        </div>
      )}
      <div className="card">
        <h2>Booking history</h2>
        {history.isLoading ? (
          <p className="muted">Loading history…</p>
        ) : history.data?.items.length ? (
          <ol className="history">
            {history.data.items.map((item, index) => (
              <li key={item.createdAt + index}>
                <strong>{item.action.replaceAll('_', ' ').toLowerCase()}</strong>
                <small className="muted"> · {new Date(item.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Your booking updates will appear here.</p>
        )}
      </div>
      <p className="muted">
        Keep your booking reference. On another device, use{' '}
        <Link href="/track-booking" className="blue">
          booking tracking
        </Link>{' '}
        with phone verification.
      </p>
      <ErrorBox error={q.error} />
    </main>
  );
}
export function TrackBooking() {
  const copy = useSite().copy;
  const [challenge, setChallenge] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const router = useRouter();
  async function submit(form: FormData) {
    setPending(true);
    setError(null);
    try {
      if (!challenge) {
        const r = await api<{ challengeId: string }>('/api/track/request', {
          method: 'POST',
          body: JSON.stringify(Object.fromEntries(form)),
        });
        setChallenge(r.challengeId);
      } else {
        const r = await api<{ id: string }>('/api/track/verify', {
          method: 'POST',
          body: JSON.stringify({ challengeId: challenge, code: form.get('code') }),
        });
        router.push('/booking/' + r.id + '/status');
      }
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="container narrow">
      <p className="eyebrow">{copy.track.eyebrow}</p>
      <h1>{copy.track.title}</h1>
      <p className="muted">{copy.track.intro}</p>
      <div className="card">
        <form onSubmit={onForm(submit)} className="stack">
          {!challenge ? (
            <>
              <label>
                Booking reference
                <input
                  name="reference"
                  required
                  placeholder="SY-XXXXXXXXXXXX"
                  maxLength={40}
                  autoCapitalize="characters"
                />
              </label>
              <label>
                Booking phone number
                <input
                  type="tel"
                  name="phone"
                  required
                  autoComplete="tel"
                  placeholder="98XXXXXXXX"
                />
              </label>
            </>
          ) : (
            <>
              <div className="notice">
                If these details match a booking, a six-digit code has been sent to your booking email or phone.
              </div>
              <label>
                Verification code
                <input
                  name="code"
                  required
                  pattern="[0-9]{6}"
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </label>
            </>
          )}
          <ErrorBox error={error} />
          <Button disabled={pending}>
            {pending
              ? 'Please wait…'
              : challenge
                ? copy.track.verify
                : copy.track.sendCode}
          </Button>
          {challenge && (
            <Button type="button" variant="outline" onClick={() => setChallenge('')}>
              Use different booking details
            </Button>
          )}
        </form>
      </div>
    </main>
  );
}
