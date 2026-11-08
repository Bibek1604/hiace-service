'use client';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, Badge, Empty, ErrorBox, Skeleton, onForm, useAsk } from './common';
import { saveImage } from '@/lib/image-client';
import { SeatGridEditor } from './layouts';
import { CopyTripLink } from './share-link';
import { Button } from './ui/button';
import { PasswordInput } from './ui/password-input';
import { money, travelHours } from '@/lib/utils';
import { validateLayout, type Grid } from '@/lib/seat-layout';

type Submission = {
  id: string;
  kind: 'vehicles' | 'routes' | 'payment-qr';
  targetId: string | null;
  payload: Record<string, unknown>;
  status: string;
  reviewNote: string;
  createdAt: string;
};
type Vehicle = {
  id: string;
  name: string;
  registration: string;
  type: string;
  description: string;
  amenities: string[];
  emergencyContact: string;
  maintenanceNote: string;
  active: boolean;
  images: { key: string }[];
  _count: { seats: number };
};
type RouteRow = {
  id: string;
  distanceKm: number;
  durationMinutes: number;
  baseFare: number;
  active: boolean;
  originId: string;
  destinationId: string;
  origin: { name: string };
  destination: { name: string };
  stops: { locationId: string; offsetMinutes: number; kmFromOrigin: number; allowBoarding: boolean; allowDropoff: boolean; location: { name: string } }[];
  segmentFares: { vehicleType: string; fromLocationId: string; toLocationId: string; amount: number }[];
};
type Qr = { id: string; label: string; accountName: string; accountNumber: string | null; imageKey: string; instructions: string; active: boolean; isDefault: boolean };
type Fleet = {
  vehicles: Vehicle[];
  routes: RouteRow[];
  qrs: Qr[];
  submissions: Submission[];
  locations: string[];
  vehicleTypes: string[];
  templates: { id: string; name: string; vehicleType: string; grid: Grid }[];
};
type Profile = {
  name: string;
  email: string;
  mobile: string;
  address: string;
  emergencyContact: string;
  photoKey: string | null;
  licenseNumber: string;
  licenseExpiry: string;
};
type StopRow = { name: string; offsetMinutes: string; kmFromOrigin: string; allowBoarding: boolean; allowDropoff: boolean };

const nepal = (s: string) => new Date(s).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' });
const send = (body: unknown) => api('/api/driver/resources', { method: 'POST', body: JSON.stringify(body) });
const useFleet = () => useQuery({ queryKey: ['driver-fleet'], queryFn: () => api<Fleet>('/api/driver/fleet') });
const pendingFor = (f: Fleet | undefined, kind: Submission['kind'], id: string) =>
  f?.submissions.find((s) => s.kind === kind && s.targetId === id && s.status === 'PENDING');

async function uploadImage(file: File, purpose: 'driver' | 'vehicle' | 'qr') {
  const form = new FormData();
  form.set('image', file);
  form.set('purpose', purpose);
  return (await api<{ id: string }>('/api/driver/uploads', { method: 'POST', body: form })).id;
}

function Thumb({ id, onRemove, save }: { id: string; onRemove?: () => void; save?: string }) {
  const [error, setError] = useState<unknown>(null);
  return (
    <div>
      <img src={'/api/images/' + id} alt="Uploaded" style={{ width: 90, height: 90, objectFit: 'contain' }} />
      {save && (
        <Button type="button" variant="outline" onClick={() => saveImage(id, save).catch(setError)}>
          Save
        </Button>
      )}
      {!!error && <ErrorBox error={error} />}
      {onRemove && (
        <Button type="button" variant="outline" onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  );
}

function ApprovalNote() {
  return <p className="notice">Changes save directly to your operational workspace. Existing trips and bookings keep their historical vehicle, route, fare, and payment snapshots.</p>;
}

export function DriverProfile() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['driver-profile'], queryFn: () => api<Profile>('/api/driver/profile') });
  const [photo, setPhoto] = useState<string | null | undefined>(undefined),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  if (q.isLoading) return <Skeleton />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const p = q.data,
    shown = photo === undefined ? p.photoKey : photo;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await fn();
      setNotice(done);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="eyebrow">YOUR ACCOUNT</p>
      <h1>My profile</h1>
      {notice && <p className="notice success" role="status">{notice}</p>}
      <ErrorBox error={error} />
      <form
        className="card stack"
        onSubmit={onForm((f) =>
          run(async () => {
            await api('/api/driver/profile', {
              method: 'PATCH',
              body: JSON.stringify({
                name: f.get('name'),
                mobile: f.get('mobile'),
                emergencyContact: f.get('emergencyContact'),
                address: f.get('address'),
                photoKey: shown ?? null,
              }),
            });
            await client.invalidateQueries({ queryKey: ['driver-profile'] });
          }, 'Your profile was saved.'),
        )}
      >
        <h2>My details</h2>
        <div className="grid-2">
          <label>
            Full name *
            <input name="name" required defaultValue={p.name} />
          </label>
          <label>
            Mobile *
            <input name="mobile" type="tel" required defaultValue={p.mobile} />
          </label>
          <label>
            Emergency contact *
            <input name="emergencyContact" type="tel" required defaultValue={p.emergencyContact} />
          </label>
          <label>
            Address
            <input name="address" maxLength={500} defaultValue={p.address} />
          </label>
        </div>
        <label>
          Profile photo
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void run(async () => setPhoto(await uploadImage(file, 'driver')), 'Photo uploaded. Save to keep it.');
            }}
          />
        </label>
        {shown && <Thumb id={shown} onRemove={() => setPhoto(null)} />}
        <dl className="definition">
          <div>
            <dt>Sign-in email</dt>
            <dd>{p.email}</dd>
          </div>
          <div>
            <dt>Licence number</dt>
            <dd>{p.licenseNumber}</dd>
          </div>
          <div>
            <dt>Licence expiry</dt>
            <dd>{new Date(p.licenseExpiry).toLocaleDateString('en-GB', { timeZone: 'Asia/Kathmandu' })}</dd>
          </div>
        </dl>
        <p className="muted">Ask the admin to change your email or licence details.</p>
        <Button disabled={busy}>{busy ? 'Saving…' : 'Save my details'}</Button>
      </form>
      <form
        className="card stack"
        onSubmit={onForm(async (f, form) => {
          if (f.get('next') !== f.get('again')) {
            setError(new Error('The two new passwords do not match.'));
            return;
          }
          const ok = await run(
            () => api('/api/driver/password', { method: 'POST', body: JSON.stringify({ current: f.get('current'), next: f.get('next') }) }),
            'Your password was changed. Other devices were signed out.',
          );
          if (ok) form.reset();
        })}
      >
        <h2>Change password</h2>
        <div className="grid-2">
          <label>
            Current password *
            <PasswordInput name="current" required autoComplete="current-password" />
          </label>
          <label>
            New password (12+ characters) *
            <PasswordInput name="next" required minLength={12} maxLength={128} autoComplete="new-password" />
          </label>
          <label>
            Repeat new password *
            <PasswordInput name="again" required minLength={12} maxLength={128} autoComplete="new-password" />
          </label>
        </div>
        <Button disabled={busy}>Change password</Button>
      </form>
    </>
  );
}

function VehicleForm({ fleet, vehicle, onDone }: { fleet: Fleet; vehicle?: Vehicle; onDone: () => void }) {
  const [images, setImages] = useState<string[]>(vehicle?.images.map((i) => i.key) ?? []),
    [grid, setGrid] = useState<Grid | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const issues = useMemo(() => (grid ? validateLayout(grid) : []), [grid]);
  return (
    <form
      className="card stack"
      onSubmit={onForm(async (f) => {
        setError(null);
        if (!vehicle && !grid) {
          setError(new Error('Choose a seat plan for this vehicle.'));
          return;
        }
        setBusy(true);
        try {
          await send({
            kind: 'vehicles',
            ...(vehicle ? { targetId: vehicle.id } : {}),
            payload: {
              name: f.get('name'),
              registration: f.get('registration'),
              type: f.get('type'),
              emergencyContact: f.get('emergencyContact'),
              description: f.get('description'),
              maintenanceNote: f.get('maintenanceNote'),
              amenities: String(f.get('amenities') || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              imageKeys: images,
              ...(vehicle ? {} : { grid }),
            },
          });
          onDone();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      })}
    >
      <h2>{vehicle ? 'Change vehicle details' : 'Add a vehicle'}</h2>
      <div className="grid-2">
        <label>
          Vehicle name *
          <input name="name" required defaultValue={vehicle?.name} placeholder="Sajilo Deluxe" />
        </label>
        <label>
          Vehicle number *
          <input name="registration" required defaultValue={vehicle?.registration} placeholder="BA 1 KHA 1234" />
        </label>
        <label>
          Vehicle type *
          <select name="type" required defaultValue={vehicle?.type ?? fleet.vehicleTypes[0]}>
            {fleet.vehicleTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Emergency contact *
          <input name="emergencyContact" type="tel" required defaultValue={vehicle?.emergencyContact} />
        </label>
      </div>
      <label>
        Amenities (comma separated)
        <input name="amenities" defaultValue={vehicle?.amenities.join(', ')} placeholder="AC, Wi-Fi, Charging" />
      </label>
      <label>
        Description
        <textarea name="description" maxLength={5000} defaultValue={vehicle?.description} />
      </label>
      <label>
        Maintenance / availability notes
        <textarea name="maintenanceNote" maxLength={1000} defaultValue={vehicle?.maintenanceNote} />
      </label>
      <label>
        Vehicle photos
        <input
          type="file"
          multiple
          accept="image/*"
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            setBusy(true);
            setError(null);
            try {
              for (const file of files) {
                const id = await uploadImage(file, 'vehicle');
                setImages((old) => [...old, id]);
              }
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      <div className="row">
        {images.map((id) => (
          <Thumb key={id} id={id} onRemove={() => setImages((old) => old.filter((x) => x !== id))} />
        ))}
      </div>
      {vehicle ? (
        <p className="muted">
          This vehicle has {vehicle._count.seats} seats. The seat plan cannot change after registration, because bookings depend on it.
        </p>
      ) : (
        <>
          <label>
            Seat plan *
            <select
              defaultValue=""
              onChange={(e) => {
                const t = fleet.templates.find((x) => x.id === e.target.value);
                setGrid(t ? t.grid : e.target.value === 'blank' ? { rows: 6, cols: 5, decks: 1, cells: [] } : null);
              }}
            >
              <option value="">Choose a starting plan</option>
              {fleet.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value="blank">Start from an empty grid</option>
            </select>
          </label>
          {grid && (
            <>
              <SeatGridEditor grid={grid} edit={(change) => setGrid((g) => g && change(g))} header={<h2>Place the seats</h2>} />
              {issues.length > 0 && (
                <ul className="notice">
                  {issues.map((i, n) => (
                    <li key={n}>{i.message}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
      <ErrorBox error={error} />
      <div className="row">
        <Button disabled={busy || issues.length > 0}>{busy ? 'Working…' : vehicle ? 'Save vehicle' : 'Add vehicle'}</Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function DriverVehicles() {
  const client = useQueryClient();
  const q = useFleet();
  const [form, setForm] = useState<{ vehicle?: Vehicle } | null>(null);
  const done = async () => {
    setForm(null);
    await client.invalidateQueries({ queryKey: ['driver-fleet'] });
  };
  const [problem, setProblem] = useState<unknown>(null);
  const removeVehicle = async (id: string) => {
    if (!window.confirm('Delete this unused vehicle? Vehicles used by trips are kept as history.')) return;
    setProblem(null);
    try {
      await api('/api/driver/resources/vehicles/' + id, { method: 'DELETE' });
      await client.invalidateQueries({ queryKey: ['driver-fleet'] });
    } catch (e) {
      setProblem(e);
    }
  };
  if (q.isLoading) return <Skeleton />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const waiting = q.data.submissions.filter((s) => s.kind === 'vehicles' && s.status === 'PENDING' && !s.targetId);
  return (
    <>
      <p className="eyebrow">YOUR FLEET</p>
      <div className="spread">
        <h1>My vehicles</h1>
        {!form && (
          <Button onClick={() => setForm({})}>
            <Plus size={16} />
            Add vehicle
          </Button>
        )}
      </div>
      <ApprovalNote />
      <ErrorBox error={problem} />
      {form && <VehicleForm key={form.vehicle?.id ?? 'new'} fleet={q.data} vehicle={form.vehicle} onDone={done} />}
      <div className="trip-grid">
        {q.data.vehicles.map((v) => (
          <div className="card" key={v.id}>
            <div className="spread">
              <h2>{v.name}</h2>
              <Badge status={v.active ? 'ACTIVE' : 'INACTIVE'} />
            </div>
            <p>
              {v.registration} · {v.type} · {v._count.seats} seats
            </p>
            {pendingFor(q.data, 'vehicles', v.id) ? (
              <p className="muted">A change is waiting for approval.</p>
            ) : (
              <div className="row">
                <Button variant="outline" onClick={() => setForm({ vehicle: v })}>Change details</Button>
                <Button variant="outline" onClick={() => void removeVehicle(v.id)}>Delete</Button>
              </div>
            )}
          </div>
        ))}
        {waiting.map((s) => (
          <div className="card" key={s.id}>
            <div className="spread">
              <h2>{String(s.payload.name)}</h2>
              <Badge status="PENDING" />
            </div>
            <p>{String(s.payload.registration)}</p>
          </div>
        ))}
        {!q.data.vehicles.length && !waiting.length && !form && <Empty text="Add your first vehicle" />}
      </div>
    </>
  );
}

function RouteForm({ fleet, route, onDone }: { fleet: Fleet; route?: RouteRow; onDone: () => void }) {
  const firstType = fleet.vehicles[0]?.type ?? fleet.vehicleTypes[0];
  /** Saved leg prices of one vehicle type, keyed the way the form shows them. */
  const savedLegs = (vehicleType: string): Record<string, string> => {
    if (!route) return {};
    const names = new Map([
      [route.originId, route.origin.name],
      [route.destinationId, route.destination.name],
      ...route.stops.map((s) => [s.locationId, s.location.name] as [string, string]),
    ]);
    return Object.fromEntries(
      route.segmentFares
        .filter((f) => f.vehicleType === vehicleType)
        .map((f) => [`${names.get(f.fromLocationId)}>${names.get(f.toLocationId)}`, String(f.amount)]),
    );
  };
  const [type, setType] = useState(firstType),
    [origin, setOrigin] = useState(route?.origin.name ?? ''),
    [destination, setDestination] = useState(route?.destination.name ?? ''),
    [stops, setStops] = useState<StopRow[]>(
      route?.stops.map((s) => ({
        name: s.location.name,
        offsetMinutes: String(s.offsetMinutes),
        kmFromOrigin: String(s.kmFromOrigin),
        allowBoarding: s.allowBoarding,
        allowDropoff: s.allowDropoff,
      })) ?? [],
    ),
    [legs, setLegs] = useState<Record<string, string>>(() => savedLegs(firstType)),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const patch = (i: number, change: Partial<StopRow>) => setStops((old) => old.map((s, n) => (n === i ? { ...s, ...change } : s)));
  const pairs = useMemo(() => {
    const line = [
      { name: origin, on: true, off: false },
      ...stops.map((s) => ({ name: s.name, on: s.allowBoarding, off: s.allowDropoff })),
      { name: destination, on: false, off: true },
    ];
    const out: [string, string][] = [];
    line.forEach((a, i) =>
      line.slice(i + 1).forEach((b, n) => {
        const full = i === 0 && i + 1 + n === line.length - 1;
        if (a.name.trim() && b.name.trim() && a.on && b.off && !full) out.push([a.name.trim(), b.name.trim()]);
      }),
    );
    return out;
  }, [origin, destination, stops]);
  return (
    <form
      className="card stack"
      onSubmit={onForm(async (f) => {
        setBusy(true);
        setError(null);
        try {
          await send({
            kind: 'routes',
            ...(route ? { targetId: route.id } : {}),
            payload: {
              origin,
              destination,
              distanceKm: Number(f.get('distanceKm')),
              durationMinutes: Math.round(Number(f.get('durationHours')) * 60),
              baseFare: Number(f.get('baseFare')),
              vehicleType: type,
              stops: stops.map((s) => ({ ...s, offsetMinutes: Number(s.offsetMinutes), kmFromOrigin: Number(s.kmFromOrigin) })),
              legFares: pairs
                .filter(([a, b]) => Number(legs[`${a}>${b}`]) > 0)
                .map(([from, to]) => ({ from, to, amount: Number(legs[`${from}>${to}`]) })),
            },
          });
          onDone();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      })}
    >
      <h2>{route ? 'Change route' : 'Add a route'}</h2>
      <datalist id="driver-places">
        {fleet.locations.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <div className="grid-2">
        <label>
          Starting point *
          <input list="driver-places" required value={origin} onChange={(e) => setOrigin(e.target.value)} />
        </label>
        <label>
          Ending point *
          <input list="driver-places" required value={destination} onChange={(e) => setDestination(e.target.value)} />
        </label>
        <label>
          Distance (km) *
          <input name="distanceKm" type="number" min={1} required defaultValue={route?.distanceKm} />
        </label>
        <label>
          Travel time (hours) *
          <input name="durationHours" type="number" min={0.01} step={0.01} required defaultValue={route ? route.durationMinutes / 60 : undefined} />
        </label>
        <label>
          Price, start to end (NPR) *
          <input name="baseFare" type="number" min={1} required defaultValue={route?.baseFare} />
        </label>
      </div>
      <h3>Stops in between</h3>
      <p className="muted">Add them in travel order. New places are added to your route immediately after validation.</p>
      {stops.map((s, i) => (
        <div className="card stack" key={i}>
          <div className="grid-2">
            <label>
              Stop {i + 1} *
              <input list="driver-places" required value={s.name} onChange={(e) => patch(i, { name: e.target.value })} />
            </label>
            <label>
              Minutes after start *
              <input type="number" min={1} required value={s.offsetMinutes} onChange={(e) => patch(i, { offsetMinutes: e.target.value })} />
            </label>
            <label>
              Km from start *
              <input type="number" min={1} required value={s.kmFromOrigin} onChange={(e) => patch(i, { kmFromOrigin: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <label>
              <input type="checkbox" checked={s.allowBoarding} onChange={(e) => patch(i, { allowBoarding: e.target.checked })} /> Passengers can get on
            </label>
            <label>
              <input type="checkbox" checked={s.allowDropoff} onChange={(e) => patch(i, { allowDropoff: e.target.checked })} /> Passengers can get off
            </label>
            <Button type="button" variant="outline" aria-label={'Remove stop ' + (i + 1)} onClick={() => setStops((old) => old.filter((_, n) => n !== i))}>
              <Trash2 size={16} />
              Remove
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={stops.length >= 20}
        onClick={() => setStops((old) => [...old, { name: '', offsetMinutes: '', kmFromOrigin: '', allowBoarding: true, allowDropoff: true }])}
      >
        <Plus size={16} />
        Add stop
      </Button>
      {pairs.length > 0 && (
        <>
          <h3>Prices between stops</h3>
          <p className="muted">Leave a price empty to work it out from the distance.</p>
          <label>
            These prices apply to
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setLegs(savedLegs(e.target.value));
              }}
            >
              {fleet.vehicleTypes.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <div className="grid-2">
            {pairs.map(([a, b]) => (
              <label key={a + b}>
                {a} → {b} (NPR)
                <input
                  type="number"
                  min={1}
                  value={legs[`${a}>${b}`] ?? ''}
                  onChange={(e) => setLegs((old) => ({ ...old, [`${a}>${b}`]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        </>
      )}
      <ErrorBox error={error} />
      <div className="row">
        <Button disabled={busy}>{busy ? 'Saving…' : route ? 'Save route' : 'Add route'}</Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function DriverRoutes() {
  const client = useQueryClient();
  const q = useFleet();
  const [form, setForm] = useState<{ route?: RouteRow } | null>(null);
  const done = async () => {
    setForm(null);
    await client.invalidateQueries({ queryKey: ['driver-fleet'] });
  };
  const [problem, setProblem] = useState<unknown>(null);
  const removeRoute = async (id: string) => {
    if (!window.confirm('Delete this unused route? Routes used by trips are kept as history.')) return;
    setProblem(null);
    try {
      await api('/api/driver/resources/routes/' + id, { method: 'DELETE' });
      await client.invalidateQueries({ queryKey: ['driver-fleet'] });
    } catch (e) {
      setProblem(e);
    }
  };
  if (q.isLoading) return <Skeleton />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const waiting = q.data.submissions.filter((s) => s.kind === 'routes' && s.status === 'PENDING' && !s.targetId);
  return (
    <>
      <p className="eyebrow">WHERE YOU DRIVE</p>
      <div className="spread">
        <h1>My routes and prices</h1>
        {!form && (
          <Button onClick={() => setForm({})}>
            <Plus size={16} />
            Add route
          </Button>
        )}
      </div>
      <ApprovalNote />
      <ErrorBox error={problem} />
      {form && <RouteForm key={form.route?.id ?? 'new'} fleet={q.data} route={form.route} onDone={done} />}
      <div className="trip-grid">
        {q.data.routes.map((r) => (
          <div className="card" key={r.id}>
            <h2>
              {r.origin.name} → {r.destination.name}
            </h2>
            <p>
              {money(r.baseFare)} · {r.distanceKm} km · {travelHours(r.durationMinutes)}
            </p>
            {r.stops.length > 0 && <p className="muted">Via {r.stops.map((s) => s.location.name).join(', ')}</p>}
            {pendingFor(q.data, 'routes', r.id) ? (
              <p className="muted">A change is waiting for approval.</p>
            ) : (
              <div className="row">
                <Button variant="outline" onClick={() => setForm({ route: r })}>Change route or price</Button>
                <Button variant="outline" onClick={() => void removeRoute(r.id)}>Delete</Button>
              </div>
            )}
          </div>
        ))}
        {waiting.map((s) => (
          <div className="card" key={s.id}>
            <div className="spread">
              <h2>
                {String(s.payload.origin)} → {String(s.payload.destination)}
              </h2>
              <Badge status="PENDING" />
            </div>
            <p>{money(Number(s.payload.baseFare))}</p>
          </div>
        ))}
        {!q.data.routes.length && !waiting.length && !form && <Empty text="Add your first route" />}
      </div>
    </>
  );
}

function PaymentForm({ qr, onDone }: { qr?: Qr; onDone: () => void }) {
  const [image, setImage] = useState(qr?.imageKey ?? ''),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card stack"
      onSubmit={onForm(async (f) => {
        setError(null);
        if (!image) {
          setError(new Error('Upload your payment QR.'));
          return;
        }
        setBusy(true);
        try {
          const accountNumber = String(f.get('accountNumber') || '').trim();
          await send({
            kind: 'payment-qr',
            ...(qr ? { targetId: qr.id } : {}),
            payload: {
              label: f.get('label'),
              accountName: f.get('accountName'),
              ...(accountNumber ? { accountNumber } : {}),
              imageKey: image,
              instructions: f.get('instructions'),
              isDefault: f.get('isDefault') === 'on',
            },
          });
          onDone();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      })}
    >
      <h2>{qr ? 'Change payment account' : 'Add a payment account'}</h2>
      <div className="grid-2">
        <label>
          Bank or wallet name *
          <input name="label" required defaultValue={qr?.label} placeholder="eSewa" />
        </label>
        <label>
          Account holder *
          <input name="accountName" required defaultValue={qr?.accountName} />
        </label>
        <label>
          Account number
          <input name="accountNumber" maxLength={100} defaultValue={qr?.accountNumber ?? ''} />
        </label>
      </div>
      <label>
        Payment instructions for passengers *
        <textarea name="instructions" required maxLength={3000} defaultValue={qr?.instructions} placeholder="Scan the QR and enter your booking reference as the remark." />
      </label>
      <label>
        Payment QR image *
        <input
          type="file"
          accept="image/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              setImage(await uploadImage(file, 'qr'));
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      <label>
        <input name="isDefault" type="checkbox" defaultChecked={qr?.isDefault} /> Use as my default QR for new trips
      </label>
      {image && <Thumb id={image} save="payment-qr.png" />}
      <ErrorBox error={error} />
      <div className="row">
        <Button disabled={busy}>{busy ? 'Working…' : qr ? 'Save account' : 'Add account'}</Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function DriverPayment() {
  const client = useQueryClient();
  const q = useFleet();
  const [form, setForm] = useState<{ qr?: Qr } | null>(null);
  const done = async () => {
    setForm(null);
    await client.invalidateQueries({ queryKey: ['driver-fleet'] });
  };
  const [problem, setProblem] = useState<unknown>(null);
  const removeQr = async (id: string) => {
    if (!window.confirm('Delete this unused payment account? Accounts attached to past trips are kept as history.')) return;
    setProblem(null);
    try {
      await api('/api/driver/resources/payment-qr/' + id, { method: 'DELETE' });
      await client.invalidateQueries({ queryKey: ['driver-fleet'] });
    } catch (e) {
      setProblem(e);
    }
  };
  if (q.isLoading) return <Skeleton />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const waiting = q.data.submissions.filter((s) => s.kind === 'payment-qr' && s.status === 'PENDING' && !s.targetId);
  return (
    <>
      <p className="eyebrow">GETTING PAID</p>
      <div className="spread">
        <h1>My payment account</h1>
        {!form && (
          <Button onClick={() => setForm({})}>
            <Plus size={16} />
            Add account
          </Button>
        )}
      </div>
      <p className="notice">Choose a default QR for new trips, or select a different active QR on a specific trip. Existing payment records keep their original QR snapshot.</p>
      <ErrorBox error={problem} />
      {form && <PaymentForm key={form.qr?.id ?? 'new'} qr={form.qr} onDone={done} />}
      <div className="trip-grid">
        {q.data.qrs.map((r) => (
          <div className="card" key={r.id}>
            <h2>{r.label}</h2>
            <p>
              {r.accountName}
              {r.accountNumber ? ' · ' + r.accountNumber : ''}
            </p>
            <Thumb id={r.imageKey} save={'payment-qr-' + r.label.replace(/[^a-z0-9]+/gi, '-') + '.png'} />
            {pendingFor(q.data, 'payment-qr', r.id) ? (
              <p className="muted">A change is waiting for approval.</p>
            ) : (
              <div className="row">
                <Button variant="outline" onClick={() => setForm({ qr: r })}>Change account</Button>
                <Button variant="outline" onClick={() => void removeQr(r.id)}>Delete</Button>
              </div>
            )}
          </div>
        ))}
        {waiting.map((s) => (
          <div className="card" key={s.id}>
            <div className="spread">
              <h2>{String(s.payload.label)}</h2>
              <Badge status="PENDING" />
            </div>
          </div>
        ))}
        {!q.data.qrs.length && !waiting.length && !form && <Empty text="Add your payment account" />}
      </div>
    </>
  );
}

type OwnTrip = {
  id: string;
  departure: string;
  arrival: string;
  bookingOpensAt: string | null;
  bookingClosesAt: string | null;
  status: string;
  fare: number;
  vehicle: { name: string; registration: string };
  route: { origin: { name: string }; destination: { name: string } };
  confirmedPassengers: number;
};
type PublishedSchedule = {
  id: string;
  batchId: string;
  startsOn: string;
  endsOn: string;
  departureMinutes: number;
  fare: number;
  status: 'DRAFT' | 'PUBLISHED' | 'PAUSED' | 'CANCELLED' | 'COMPLETED';
  route: { origin: { name: string }; destination: { name: string } };
  vehicle: { name: string; registration: string };
  trips: { id: string; departure: string; status: string; bookings: { id: string }[] }[];
};
type SchedulePlan = { routeId: string; vehicleId: string; paymentQRId: string; departureTime: string; fare: string };
const nepalDate = (offset = 0) => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kathmandu' }));
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const clockLabel = (hour: number) => {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const shown = hour % 12 || 12;
  return `${shown}:00 ${suffix}`;
};

export function DriverSchedule() {
  const client = useQueryClient();
  const q = useFleet();
  const trips = useQuery({ queryKey: ['driver-trips'], queryFn: () => api<{ items: OwnTrip[] }>('/api/driver/trips?days=90') });
  const { ask, dialog } = useAsk();
  const schedules = useQuery({ queryKey: ['driver-schedules'], queryFn: () => api<{ items: PublishedSchedule[] }>('/api/driver/schedules') });
  const [routeId, setRouteId] = useState(''),
    [departureTimes, setDepartureTimes] = useState(['']),
    [publishMode, setPublishMode] = useState<'single' | 'double'>('single'),
    [amHour, setAmHour] = useState(6),
    [pmHour, setPmHour] = useState(16),
    [startsOn, setStartsOn] = useState(nepalDate(1)),
    [endsOn, setEndsOn] = useState(nepalDate(7)),
    [plans, setPlans] = useState<SchedulePlan[]>([{ routeId: '', vehicleId: '', paymentQRId: '', departureTime: '06:00', fare: '' }]),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const edit = async (t: OwnTrip, f: FormData) => {
    setBusy(true); setError(null);
    try {
      await api('/api/driver/trips/' + t.id, { method: 'PATCH', body: JSON.stringify({
        departure: new Date(String(f.get('departure')) + ':00+05:45').toISOString(),
        arrival: new Date(String(f.get('arrival')) + ':00+05:45').toISOString(),
        bookingOpensAt: f.get('bookingOpensAt') ? new Date(String(f.get('bookingOpensAt')) + ':00+05:45').toISOString() : null,
        bookingClosesAt: f.get('bookingClosesAt') ? new Date(String(f.get('bookingClosesAt')) + ':00+05:45').toISOString() : null,
      }) });
      setNotice('Trip schedule updated.'); await client.invalidateQueries({ queryKey: ['driver-trips'] });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  if (q.isLoading) return <Skeleton />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const vehicles = q.data.vehicles.filter((v) => v.active),
    routes = q.data.routes.filter((r) => r.active),
    qrs = q.data.qrs.filter((r) => r.active),
    route = routes.find((r) => r.id === routeId);
  const missing = [!vehicles.length && 'a vehicle', !routes.length && 'a route', !qrs.length && 'a payment account'].filter(Boolean);
  const upcoming = trips.data?.items.filter((t) => t.status === 'SCHEDULED' && new Date(t.departure) > new Date()) ?? [];
  async function cancel(t: OwnTrip) {
    const answer = await ask({
      title: 'Cancel this trip',
      description: 'A trip with bookings must have them cancelled first, so passengers are told and refunded.',
      confirm: 'Cancel trip',
      destructive: true,
      fields: [{ name: 'reason', label: 'Why are you cancelling this trip?', type: 'textarea', required: true, minLength: 3, maxLength: 500 }],
    });
    if (!answer) return;
    const reason = answer.reason;
    setError(null);
    setNotice('');
    try {
      await api('/api/driver/trips/' + t.id + '/cancel', { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      setNotice('The trip was cancelled.');
      await client.invalidateQueries({ queryKey: ['driver-trips'] });
    } catch (e) {
      setError(e);
    }
  }
  const updatePlan = (index: number, patch: Partial<SchedulePlan>) => setPlans((old) => old.map((plan, i) => i === index ? { ...plan, ...patch } : plan));
  const chooseDoubleTrip = () => {
    setPublishMode('double');
    setPlans((old) => {
      const next = [...old];
      while (next.length < 2) next.push({ routeId: '', vehicleId: '', paymentQRId: '', departureTime: '16:00', fare: '' });
      next[0] = { ...next[0], departureTime: `${String(amHour).padStart(2, '0')}:00` };
      next[1] = { ...next[1], departureTime: `${String(pmHour).padStart(2, '0')}:00` };
      return next;
    });
  };
  const changeTripHour = (index: 0 | 1, hour: number) => {
    if (index === 0) setAmHour(hour); else setPmHour(hour);
    updatePlan(index, { departureTime: `${String(hour).padStart(2, '0')}:00` });
  };
  const dates = startsOn && endsOn && startsOn <= endsOn ? Math.floor((Date.parse(endsOn + 'T00:00:00Z') - Date.parse(startsOn + 'T00:00:00Z')) / 86400000) + 1 : 0;
  const refreshSchedules = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ['driver-schedules'] }), client.invalidateQueries({ queryKey: ['driver-trips'] })]);
  };
  const controlSchedule = async (id: string, action: 'pause' | 'resume' | 'cancel' | 'extend') => {
    const answer =
      action === 'extend'
        ? await ask({ title: 'Extend this schedule', description: 'A trip is added for every new day. Existing trips do not change.', confirm: 'Extend schedule', fields: [{ name: 'endsOn', label: 'New end date', type: 'date', required: true, min: nepalDate(1), defaultValue: endsOn }] })
        : action === 'cancel'
          ? await ask({ title: 'Cancel future trips', description: 'Every future trip of this schedule is cancelled. This is refused while any of them has a booking.', confirm: 'Cancel future trips', destructive: true, fields: [] })
          : {};
    if (!answer) return;
    const nextEnd = answer.endsOn;
    setBusy(true); setError(null); setNotice('');
    try {
      await api('/api/driver/schedules/' + id, { method: 'PATCH', body: JSON.stringify(action === 'extend' ? { action, endsOn: nextEnd } : { action }) });
      setNotice(`Schedule ${action === 'cancel' ? 'cancelled' : action === 'extend' ? 'extended' : action + 'd'}.`);
      await refreshSchedules();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      {dialog}
      <p className="eyebrow">DEPARTURES</p>
      <h1>Publish route</h1>
      {notice && <p className="notice success" role="status">{notice}</p>}
      <ErrorBox error={error || trips.error} />
      <section className="card stack">
        <div role="tablist" aria-label="Trip publishing mode" className="row">
          <Button type="button" role="tab" aria-selected={publishMode === 'single'} variant={publishMode === 'single' ? 'default' : 'outline'} onClick={() => setPublishMode('single')}>Single trip</Button>
          <Button type="button" role="tab" aria-selected={publishMode === 'double'} variant={publishMode === 'double' ? 'default' : 'outline'} onClick={chooseDoubleTrip}>Double trip</Button>
        </div>
        <p className="muted">{publishMode === 'single' ? 'Publish one or more individual departures.' : 'Publish outbound and return routes across a range of dates. Each is its own schedule, and each date becomes its own bookable trip.'}</p>
      </section>
      {missing.length > 0 ? (
        <p className="notice">Before you can publish a route, you need an active {missing.join(', ')}.</p>
      ) : (
        <>
        {publishMode === 'double' && <>
        <section className="card stack">
          <div className="spread"><div><h2>Long-term trip publishing</h2><p className="muted">Publish one or more existing routes across consecutive dates. Each date becomes its own bookable trip.</p></div></div>
          <div className="grid-2">
            <label>
              Morning departure: <strong>{clockLabel(amHour)}</strong>
              <input aria-label="Morning departure time" type="range" min={0} max={11} step={1} value={amHour} onChange={(e) => changeTripHour(0, Number(e.target.value))} />
            </label>
            <label>
              Afternoon/evening return: <strong>{clockLabel(pmHour)}</strong>
              <input aria-label="Return departure time" type="range" min={12} max={23} step={1} value={pmHour} onChange={(e) => changeTripHour(1, Number(e.target.value))} />
            </label>
          </div>
          <p className="muted">The AM slider controls route schedule 1; the PM slider controls route schedule 2. Add more schedules if needed.</p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {[7, 14, 30].map((days) => <Button key={days} type="button" variant="outline" onClick={() => { setStartsOn(nepalDate(1)); setEndsOn(nepalDate(days)); }}>{days} days</Button>)}
          </div>
          <div className="grid-2">
            <label>Start date *<input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
            <label>End date *<input type="date" required value={endsOn} min={startsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
          </div>
          {plans.map((plan, index) => (
            <div className="card stack" key={index}>
              <div className="spread"><h3>Route schedule {index + 1}</h3>{plans.length > 1 && <Button type="button" variant="outline" onClick={() => setPlans((old) => old.filter((_, i) => i !== index))}>Remove</Button>}</div>
              <div className="grid-2">
                <label>Route *<select required value={plan.routeId} onChange={(e) => updatePlan(index, { routeId: e.target.value })}><option value="">Choose a route</option>{routes.map((r) => <option key={r.id} value={r.id}>{r.origin.name} → {r.destination.name}</option>)}</select></label>
                <label>Vehicle *<select required value={plan.vehicleId} onChange={(e) => updatePlan(index, { vehicleId: e.target.value })}><option value="">Choose a vehicle</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.registration}</option>)}</select></label>
                <label>Payment account *<select required value={plan.paymentQRId} onChange={(e) => updatePlan(index, { paymentQRId: e.target.value })}><option value="">Choose an account</option>{qrs.map((r) => <option key={r.id} value={r.id}>{r.label} · {r.accountName}</option>)}</select></label>
                <label>Departure time *<input type="time" required value={plan.departureTime} onChange={(e) => updatePlan(index, { departureTime: e.target.value })} /></label>
                <label>Fare per seat (NPR)<input type="number" min={1} placeholder="Route fare" value={plan.fare} onChange={(e) => updatePlan(index, { fare: e.target.value })} /></label>
              </div>
            </div>
          ))}
          <div className="row"><Button type="button" variant="outline" onClick={() => setPlans((old) => [...old, { routeId: '', vehicleId: '', paymentQRId: '', departureTime: '06:00', fare: '' }])}>Add another route</Button><span className="muted">Preview: {dates > 0 ? dates * plans.length : 0} separate trips, in date order.</span></div>
          <Button disabled={busy || !dates || plans.some((p) => !p.routeId || !p.vehicleId || !p.paymentQRId)} onClick={async () => { setBusy(true); setError(null); setNotice(''); try { const result = await api<{ created: number }>('/api/driver/schedules', { method: 'POST', body: JSON.stringify({ startsOn, endsOn, plans: plans.map((p) => ({ ...p, fare: p.fare ? Number(p.fare) : undefined })) }) }); setNotice(`${result.created} trips published across ${dates} days.`); await refreshSchedules(); } catch (e) { setError(e); } finally { setBusy(false); } }}>{busy ? 'Publishing…' : 'Publish schedule'}</Button>
        </section>
        <section className="stack">
          <h2>Published schedules</h2>
          {schedules.data?.items.map((schedule) => <article className="card" key={schedule.id}><div className="spread"><div><h3>{schedule.route.origin.name} → {schedule.route.destination.name}</h3><p>{schedule.vehicle.name} · {schedule.vehicle.registration} · {String(Math.floor(schedule.departureMinutes / 60)).padStart(2, '0')}:{String(schedule.departureMinutes % 60).padStart(2, '0')}</p><p className="muted">{schedule.startsOn.slice(0, 10)} to {schedule.endsOn.slice(0, 10)} · {schedule.trips.length} future trips · {schedule.trips.reduce((n, trip) => n + trip.bookings.length, 0)} active bookings</p></div><Badge status={schedule.status} /></div><div className="row"><Button variant="outline" disabled={busy || schedule.status !== 'PUBLISHED'} onClick={() => controlSchedule(schedule.id, 'pause')}>Pause</Button><Button variant="outline" disabled={busy || schedule.status !== 'PAUSED'} onClick={() => controlSchedule(schedule.id, 'resume')}>Resume</Button><Button variant="outline" disabled={busy || ['CANCELLED', 'COMPLETED'].includes(schedule.status)} onClick={() => controlSchedule(schedule.id, 'extend')}>Extend</Button><Button variant="destructive" disabled={busy || ['CANCELLED', 'COMPLETED'].includes(schedule.status)} onClick={() => controlSchedule(schedule.id, 'cancel')}>Cancel future</Button></div></article>)}
          {!schedules.data?.items.length && <Empty text="No long-term schedules yet." />}
        </section>
        </>}
        {publishMode === 'single' && <>
        <h2>One-off departures</h2>
        <form
          className="card stack"
          onSubmit={onForm(async (f, form) => {
            setBusy(true);
            setError(null);
            setNotice('');
            try {
              const published = departureTimes.filter(Boolean).length;
              await api('/api/driver/trips', {
                method: 'POST',
                body: JSON.stringify({
                  vehicleId: f.get('vehicleId'),
                  routeId,
                  paymentQRId: f.get('paymentQRId'),
                  departures: departureTimes.filter(Boolean).map((value) => new Date(value + ':00+05:45').toISOString()),
                  boardingPoint: f.get('boardingPoint'),
                  dropPoint: f.get('dropPoint'),
                }),
              });
              form.reset();
              setRouteId('');
              setDepartureTimes(['']);
              setNotice(published === 1 ? 'The departure is published and open for booking.' : published + ' departures are published and open for booking.');
              await client.invalidateQueries({ queryKey: ['driver-trips'] });
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          })}
        >
          <div className="grid-2">
            <label>
              Vehicle *
              <select name="vehicleId" required defaultValue="">
                <option value="">Choose a vehicle</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.registration}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Route *
              <select required value={routeId} onChange={(e) => setRouteId(e.target.value)}>
                <option value="">Choose a route</option>
                {routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.origin.name} → {r.destination.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Payment account *
              <select name="paymentQRId" required defaultValue="">
                <option value="">Choose an account</option>
                {qrs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {r.accountName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Pickup place
              <input name="boardingPoint" maxLength={250} placeholder={route?.origin.name} />
            </label>
            <label>
              Drop-off place
              <input name="dropPoint" maxLength={250} placeholder={route?.destination.name} />
            </label>
          </div>
          <div className="stack">
            <div className="spread"><h2>Departure dates and times</h2><Button type="button" variant="outline" onClick={() => setDepartureTimes((times) => [...times, ''])}>Add departure</Button></div>
            {departureTimes.map((value, index) => (
              <div className="row" key={index}>
                <label style={{ flex: 1 }}>Departure {index + 1} (Nepal time) *<input type="datetime-local" required value={value} onChange={(e) => setDepartureTimes((times) => times.map((time, i) => i === index ? e.target.value : time))} /></label>
                {departureTimes.length > 1 && <Button type="button" variant="outline" onClick={() => setDepartureTimes((times) => times.filter((_, i) => i !== index))}>Remove</Button>}
              </div>
            ))}
          </div>
          {route && (
            <p className="muted">
              Price per seat: {money(route.baseFare)}, from your route. Travel time: {travelHours(route.durationMinutes)}.
            </p>
          )}
          <Button disabled={busy}>{busy ? 'Publishing…' : 'Publish selected departures'}</Button>
        </form>
        </>}
        </>
      )}
      <h2>Upcoming trips</h2>
      <div className="trip-grid">
        {upcoming.map((t) => (
          <div className="card" key={t.id}>
            <h2>
              {t.route.origin.name} → {t.route.destination.name}
            </h2>
            <p>
              {t.vehicle.name} · {t.vehicle.registration}
              <br />
              Starts: {nepal(t.departure)}
              <br />Ends: {nepal(t.arrival)}
            </p>
            <p>
              {money(t.fare)} · {t.confirmedPassengers} confirmed
            </p>
            <div className="row">
              <a className="button" href={'/driver/bookings?tripId=' + t.id + '&manual=1'}>Add passenger booking</a>
              <a className="button outline" href={'/driver/bookings?tripId=' + t.id}>View bookings</a>
              <Button variant="outline" onClick={() => cancel(t)}>Cancel trip</Button>
            </div>
            <div className="row">
              <CopyTripLink tripId={t.id} title={t.route.origin.name + ' → ' + t.route.destination.name + ' · ' + nepal(t.departure)} />
            </div>
            <details>
              <summary>Edit schedule and booking window</summary>
              <form className="stack" onSubmit={onForm((f) => edit(t, f))}>
                <label>Departure<input name="departure" type="datetime-local" required defaultValue={new Date(t.departure).toLocaleString('sv-SE', { timeZone: 'Asia/Kathmandu' }).replace(' ', 'T').slice(0, 16)} /></label>
                <label>Arrival<input name="arrival" type="datetime-local" required defaultValue={new Date(t.arrival).toLocaleString('sv-SE', { timeZone: 'Asia/Kathmandu' }).replace(' ', 'T').slice(0, 16)} /></label>
                <label>Booking opens<input name="bookingOpensAt" type="datetime-local" defaultValue={t.bookingOpensAt ? new Date(t.bookingOpensAt).toLocaleString('sv-SE', { timeZone: 'Asia/Kathmandu' }).replace(' ', 'T').slice(0, 16) : ''} /></label>
                <label>Booking closes<input name="bookingClosesAt" type="datetime-local" defaultValue={t.bookingClosesAt ? new Date(t.bookingClosesAt).toLocaleString('sv-SE', { timeZone: 'Asia/Kathmandu' }).replace(' ', 'T').slice(0, 16) : ''} /></label>
                <Button disabled={busy}>{busy ? 'Saving…' : 'Save schedule'}</Button>
              </form>
            </details>
          </div>
        ))}
        {!upcoming.length && <Empty text="No upcoming trips" />}
      </div>
    </>
  );
}

