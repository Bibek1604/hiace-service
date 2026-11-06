'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Badge, Empty, ErrorBox, Skeleton } from './common';
import { Button } from './ui/button';
import { money, travelHours } from '@/lib/utils';
import { countSeats, isBookableSeat, type Cell, type Grid } from '@/lib/seat-layout';

type Fields = Record<string, unknown>;
type Request = {
  id: string;
  kind: 'vehicles' | 'routes' | 'payment-qr';
  targetId: string | null;
  payload: Fields;
  current: (Fields & { active?: boolean }) | null;
  status: string;
  reviewNote: string;
  createdAt: string;
  driver: { name: string; email: string; mobile: string };
};
type Stop = { name: string; offsetMinutes: number; kmFromOrigin: number; allowBoarding: boolean; allowDropoff: boolean };
type Leg = { from: string; to: string; amount: number };

const KIND = { vehicles: 'Vehicle', routes: 'Route and price', 'payment-qr': 'Payment account' };
const LABELS: Record<string, string> = {
  name: 'Vehicle name',
  registration: 'Vehicle number',
  type: 'Vehicle type',
  description: 'Description',
  amenities: 'Amenities',
  emergencyContact: 'Emergency contact',
  maintenanceNote: 'Maintenance notes',
  imageKeys: 'Photos',
  origin: 'Starting point',
  destination: 'Ending point',
  distanceKm: 'Distance (km)',
  durationMinutes: 'Travel time (hours)',
  baseFare: 'Price, start to end',
  stops: 'Stops in between',
  vehicleType: 'Stop prices apply to',
  legFares: 'Prices between stops',
  label: 'Bank or wallet',
  accountName: 'Account holder',
  accountNumber: 'Account number',
  imageKey: 'Payment QR',
  instructions: 'Instructions for passengers',
};
const stopText = (s: Stop) =>
  `${s.name} (${s.offsetMinutes} min, ${s.kmFromOrigin} km${s.allowBoarding ? ', get on' : ''}${s.allowDropoff ? ', get off' : ''})`;

function Value({ name, value }: { name: string; value: unknown }) {
  if (name === 'imageKeys' || name === 'imageKey') {
    const ids = (Array.isArray(value) ? value : value ? [value] : []) as string[];
    if (!ids.length) return <>None</>;
    return (
      <span className="row">
        {ids.map((id) => (
          <a key={id} href={'/api/images/' + id} target="_blank" rel="noreferrer">
            <img src={'/api/images/' + id} alt={LABELS[name]} style={{ width: 110, height: 110, objectFit: 'contain' }} />
          </a>
        ))}
      </span>
    );
  }
  if (name === 'baseFare') return <>{money(Number(value))}</>;
  if (name === 'durationMinutes') return <>{travelHours(Number(value))}</>;
  if (name === 'stops') return <>{(value as Stop[]).map(stopText).join(' → ') || 'None'}</>;
  if (name === 'legFares')
    return <>{(value as Leg[]).map((l) => `${l.from} → ${l.to}: ${money(l.amount)}`).join('; ') || 'Worked out from distance'}</>;
  if (Array.isArray(value)) return <>{value.join(', ') || 'None'}</>;
  return <>{value === undefined || value === null || value === '' ? 'None' : String(value)}</>;
}

/** Read-only picture of the proposed seats, so the reviewer sees what passengers will book. */
function SeatPreview({ grid }: { grid: Grid }) {
  const decks = Array.from({ length: grid.decks }, (_, d) => d);
  const at = new Map(grid.cells.map((c: Cell) => [`${c.deck}:${c.row}:${c.col}`, c]));
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      {decks.map((d) => (
        <div key={d}>
          {grid.decks > 1 && <small>{d === 0 ? 'Lower deck' : 'Upper deck'}</small>}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${grid.cols}, 34px)`, gap: 3, width: 'max-content' }}>
            {Array.from({ length: grid.rows * grid.cols }, (_, i) => {
              const c = at.get(`${d}:${Math.floor(i / grid.cols)}:${i % grid.cols}`);
              return (
                <span
                  key={i}
                  title={c?.kind}
                  style={{
                    height: 34,
                    borderRadius: 6,
                    fontSize: 10,
                    display: 'grid',
                    placeItems: 'center',
                    background: !c ? 'transparent' : isBookableSeat(c) ? (c.kind === 'door-seat' ? '#fef3c7' : '#dcfce7') : '#e2e8f0',
                    color: '#0f172a',
                  }}
                >
                  {c ? (isBookableSeat(c) ? c.kind === 'door-seat' ? `Door ${c.label}` : c.label : c.kind.slice(0, 3)) : ''}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DriverRequests() {
  const client = useQueryClient();
  const [status, setStatus] = useState('PENDING'),
    [notes, setNotes] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(''),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const q = useQuery({
    queryKey: ['driver-requests', status],
    queryFn: () => api<{ items: Request[] }>('/api/admin/driver-submissions?status=' + status),
    refetchInterval: 15000,
  });
  async function decide(r: Request, action: 'approve' | 'reject' | 'activate' | 'deactivate') {
    setBusy(r.id);
    setError(null);
    setNotice('');
    try {
      await api('/api/admin/driver-submissions/' + r.id, {
        method: 'POST',
        body: JSON.stringify({ action, note: notes[r.id] ?? '' }),
      });
      setNotice(
        action === 'approve' || action === 'activate'
          ? 'Approved and active.'
          : action === 'reject'
            ? 'Rejected and deactivated. The driver can see your reason.'
            : 'Deactivated. You can activate it again at any time.',
      );
      await client.invalidateQueries({ queryKey: ['driver-requests'] });
      await client.invalidateQueries({ queryKey: ['reports'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <p className="eyebrow">DRIVER SELF-SERVICE</p>
      <h1>Driver requests</h1>
      <p className="muted">Driver changes are approved and active as soon as they are posted. You can still approve, reject, deactivate, or reactivate each item here.</p>
      <div className="row" role="tablist">
        {['PENDING', 'APPROVED', 'REJECTED'].map((s) => (
          <Button key={s} role="tab" aria-selected={status === s} variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>
            {s[0] + s.slice(1).toLowerCase()}
          </Button>
        ))}
      </div>
      {notice && <p className="notice success" role="status">{notice}</p>}
      <ErrorBox error={error || q.error} />
      {q.isLoading ? (
        <Skeleton />
      ) : (
        <div className="stack">
          {q.data?.items.map((r) => {
            const { grid, ...fields } = r.payload;
            const rows = Object.entries(fields).filter(([k]) => LABELS[k]);
            return (
              <article className="card stack" key={r.id}>
                <div className="spread">
                  <div>
                    <small className="muted">
                      {KIND[r.kind]} · {r.current ? 'Change to existing' : 'New'} ·{' '}
                      {new Date(r.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}
                    </small>
                    <h2>
                      {r.driver.name} <small className="muted">{r.driver.mobile} · {r.driver.email}</small>
                    </h2>
                  </div>
                  <Badge status={r.status} />
                </div>
                <dl className="definition">
                  {rows.map(([k, v]) => {
                    const changed = r.current && k in r.current && JSON.stringify(r.current[k]) !== JSON.stringify(v);
                    return (
                      <div key={k}>
                        <dt>{LABELS[k]}</dt>
                        <dd>
                          {changed ? <strong><Value name={k} value={v} /></strong> : <Value name={k} value={v} />}
                          {changed && (
                            <small className="muted">
                              {' '}
                              (was <Value name={k} value={r.current![k]} />)
                            </small>
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                {grid ? (
                  <>
                    <h3>Seat plan: {countSeats(grid as Grid)} seats</h3>
                    <SeatPreview grid={grid as Grid} />
                  </>
                ) : null}
                {r.reviewNote && <p className="notice">Your note: {r.reviewNote}</p>}
                {(r.status === 'PENDING' || r.status === 'REJECTED') && (
                  <>
                    <label>
                      Note to the driver (needed to reject)
                      <textarea
                        maxLength={1000}
                        value={notes[r.id] ?? ''}
                        onChange={(e) => setNotes((old) => ({ ...old, [r.id]: e.target.value }))}
                      />
                    </label>
                    <div className="row">
                      <Button disabled={busy === r.id} onClick={() => decide(r, 'approve')}>
                        {busy === r.id ? 'Working…' : r.status === 'REJECTED' ? 'Approve & activate' : 'Approve'}
                      </Button>
                      {r.status === 'PENDING' && <Button variant="outline" disabled={busy === r.id} onClick={() => decide(r, 'reject')}>
                        Reject
                      </Button>}
                    </div>
                  </>
                )}
                {r.status === 'APPROVED' && r.current && (
                  <>
                    {r.current.active && (
                      <label>
                        Rejection reason (required only to reject)
                        <textarea
                          maxLength={1000}
                          value={notes[r.id] ?? ''}
                          onChange={(e) => setNotes((old) => ({ ...old, [r.id]: e.target.value }))}
                        />
                      </label>
                    )}
                    <div className="row">
                      {r.current.active ? (
                        <>
                        <Button variant="outline" disabled={busy === r.id} onClick={() => decide(r, 'deactivate')}>
                          {busy === r.id ? 'Working…' : 'Deactivate'}
                        </Button>
                        <Button variant="outline" disabled={busy === r.id} onClick={() => decide(r, 'reject')}>
                          Reject
                        </Button>
                        </>
                      ) : (
                      <Button disabled={busy === r.id} onClick={() => decide(r, 'activate')}>
                        {busy === r.id ? 'Working…' : 'Activate'}
                      </Button>
                      )}
                    </div>
                  </>
                )}
              </article>
            );
          })}
          {!q.data?.items.length && <Empty text="Nothing here" />}
        </div>
      )}
    </>
  );
}
