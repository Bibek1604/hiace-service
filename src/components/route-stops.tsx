'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, api, Badge, ErrorBox, Skeleton, StaffLink as Link } from './common';
import { Button } from './ui/button';
import { buildSequence, validateSequence, type StopInput } from '@/lib/route-stops';

type Detail = {
  id: string;
  route: { id: string; originId: string; destinationId: string; distanceKm: number; durationMinutes: number; baseFare: number; active: boolean };
  sequence: { locationId: string; name: string; index: number; offsetMinutes: number; kmFromOrigin: number; allowBoarding: boolean; allowDropoff: boolean }[];
  points: { id: string; locationId: string; locationName: string; kind: 'BOARDING' | 'DROPOFF'; name: string; landmark: string; extraMinutes: number; active: boolean }[];
};
type Catalog = { locations: { id: string; name: string }[] };

const json = (v: unknown) => JSON.stringify(v);
const hhmm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

type FareMatrix = {
  fullFare: number;
  rows: { fromLocationId: string; toLocationId: string; fromName: string; toName: string; suggested: number; override: number | null; amount: number; locked: boolean }[];
};

function SegmentFares({ routeId }: { routeId: string }) {
  const client = useQueryClient();
  const [type, setType] = useState('Bus'),
    [draft, setDraft] = useState<Record<string, string>>({}),
    [error, setError] = useState<unknown>(null);
  const q = useQuery({
    queryKey: ['segment-fares', routeId, type],
    queryFn: () => api<FareMatrix>(adminApi(`segment-fares/${routeId}?vehicleType=${encodeURIComponent(type)}`)),
  });
  const save = useMutation({
    mutationFn: (b: { fromLocationId: string; toLocationId: string; amount: number | null }) =>
      api(adminApi('segment-fares'), { method: 'PATCH', body: json({ routeId, vehicleType: type, ...b }) }),
    onSuccess: () => {
      setDraft({});
      return client.invalidateQueries({ queryKey: ['segment-fares', routeId] });
    },
    onError: setError,
  });
  return (
    <section className="card">
      <h2>Fares between stops</h2>
      <p className="muted">
        Each trip copies these prices when it is created, so later changes never affect trips already on sale. Unset legs are priced by distance.
      </p>
      <label>
        Vehicle type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {['Bus', 'Deluxe Bus', 'Hiace', 'Jeep', 'Car'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <ErrorBox error={error} />
      {q.isLoading ? (
        <Skeleton />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Distance price</th>
                <th>Fare (NPR)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data?.rows.map((r) => {
                const k = r.fromLocationId + '>' + r.toLocationId;
                return (
                  <tr key={k}>
                    <td>{r.fromName}</td>
                    <td>{r.toName}</td>
                    <td>{r.suggested}</td>
                    <td>
                      {r.locked ? (
                        <>{r.amount} (trip fare)</>
                      ) : (
                        <input
                          aria-label={`Fare ${r.fromName} to ${r.toName}`}
                          type="number"
                          min={1}
                          value={draft[k] ?? String(r.amount)}
                          onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                        />
                      )}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {!r.locked && (
                        <>
                          <Button type="button" variant="secondary" disabled={draft[k] === undefined || !Number(draft[k]) || save.isPending} onClick={() => (setError(null), save.mutate({ fromLocationId: r.fromLocationId, toLocationId: r.toLocationId, amount: Number(draft[k]) }))}>
                            Save
                          </Button>{' '}
                          {r.override !== null && (
                            <Button type="button" variant="outline" onClick={() => (setError(null), save.mutate({ fromLocationId: r.fromLocationId, toLocationId: r.toLocationId, amount: null }))}>
                              Reset
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function RouteStops({ id }: { id: string }) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ['route-detail', id], queryFn: () => api<Detail>(adminApi('route-points/' + id)) });
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>(adminApi('catalog')) });
  const [stops, setStops] = useState<StopInput[] | null>(null),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const [point, setPoint] = useState({ locationId: '', kind: 'BOARDING' as 'BOARDING' | 'DROPOFF', name: '', landmark: '', extraMinutes: 0 });

  const d = detail.data;
  const middle: StopInput[] | null = stops ?? (d ? d.sequence.slice(1, -1).map(({ locationId, offsetMinutes, kmFromOrigin, allowBoarding, allowDropoff }) => ({ locationId, offsetMinutes, kmFromOrigin, allowBoarding, allowDropoff })) : null);
  const names = new Map(catalog.data?.locations.map((l) => [l.id, l.name]));
  const problems = d && middle ? validateSequence(buildSequence(d.route, middle)) : [];

  const saveStops = useMutation({
    mutationFn: () => api(adminApi('routes'), { method: 'PATCH', body: json({ ...d!.route, stops: middle }) }),
    onSuccess: async () => {
      setStops(null);
      setNotice('Stops saved. Points on removed or restricted stops were dropped.');
      await client.invalidateQueries({ queryKey: ['route-detail', id] });
    },
    onError: setError,
  });
  const savePoint = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(adminApi('route-points'), { method: body.id ? 'PATCH' : 'POST', body: json({ routeId: id, ...body }) }),
    onSuccess: async () => {
      setPoint((p) => ({ ...p, name: '', landmark: '' }));
      await client.invalidateQueries({ queryKey: ['route-detail', id] });
    },
    onError: setError,
  });
  const removePoint = useMutation({
    mutationFn: (pointId: string) => api(adminApi('route-points/' + pointId), { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['route-detail', id] }),
    onError: setError,
  });

  if (detail.isLoading || !d || !middle) return detail.error ? <ErrorBox error={detail.error} /> : <Skeleton />;
  const edit = (i: number, patch: Partial<StopInput>) => setStops(middle.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: number) => {
    const next = [...middle];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    // swap only the places; times and distances stay attached to their position in the journey
    setStops(next.map((s, n) => ({ ...s, offsetMinutes: middle[n].offsetMinutes, kmFromOrigin: middle[n].kmFromOrigin })));
  };
  const first = d.sequence[0],
    last = d.sequence[d.sequence.length - 1];
  const usable = d.sequence.filter((s) => (point.kind === 'BOARDING' ? s.allowBoarding : s.allowDropoff));

  return (
    <div className="stack">
      <section className="card">
        <h2>
          {first.name} → {last.name}
        </h2>
        <p className="muted">
          {d.route.distanceKm} km, {hhmm(d.route.durationMinutes)}. Passengers can ride any part of the route between two allowed stops, and a seat can be sold again on the legs left over.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Place</th>
                <th>Minutes after departure</th>
                <th>Km from origin</th>
                <th>Board</th>
                <th>Drop</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>1</td>
                <td>{first.name} (origin)</td>
                <td>0</td>
                <td>0</td>
                <td>Yes</td>
                <td>No</td>
                <td />
              </tr>
              {middle.map((s, i) => (
                <tr key={i}>
                  <td>{i + 2}</td>
                  <td>
                    <select aria-label={`Stop ${i + 2} place`} value={s.locationId} onChange={(e) => edit(i, { locationId: e.target.value })}>
                      <option value="">Select place</option>
                      {catalog.data?.locations
                        .filter((l) => l.id !== d.route.originId && l.id !== d.route.destinationId)
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>
                    <input aria-label={`Stop ${i + 2} minutes`} type="number" min={1} value={s.offsetMinutes} onChange={(e) => edit(i, { offsetMinutes: +e.target.value })} />
                  </td>
                  <td>
                    <input aria-label={`Stop ${i + 2} kilometres`} type="number" min={1} value={s.kmFromOrigin} onChange={(e) => edit(i, { kmFromOrigin: +e.target.value })} />
                  </td>
                  <td>
                    <input aria-label={`Stop ${i + 2} allows boarding`} type="checkbox" checked={s.allowBoarding} onChange={(e) => edit(i, { allowBoarding: e.target.checked })} />
                  </td>
                  <td>
                    <input aria-label={`Stop ${i + 2} allows drop-off`} type="checkbox" checked={s.allowDropoff} onChange={(e) => edit(i, { allowDropoff: e.target.checked })} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Button type="button" variant="outline" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>{' '}
                    <Button type="button" variant="outline" aria-label="Move down" disabled={i === middle.length - 1} onClick={() => move(i, 1)}>↓</Button>{' '}
                    <Button type="button" variant="destructive" aria-label="Remove stop" onClick={() => setStops(middle.filter((_, n) => n !== i))}>Remove</Button>
                  </td>
                </tr>
              ))}
              <tr>
                <td>{middle.length + 2}</td>
                <td>{last.name} (destination)</td>
                <td>{d.route.durationMinutes}</td>
                <td>{d.route.distanceKm}</td>
                <td>No</td>
                <td>Yes</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        {problems.length > 0 && (
          <ul role="alert" className="error">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <ErrorBox error={error} />
        {notice && <p role="status">{notice}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            type="button"
            variant="outline"
            disabled={middle.length >= 20}
            onClick={() => {
              const prev = middle.at(-1);
              setStops([...middle, { locationId: '', offsetMinutes: (prev?.offsetMinutes ?? 0) + 30, kmFromOrigin: (prev?.kmFromOrigin ?? 0) + 10, allowBoarding: true, allowDropoff: true }]);
            }}
          >
            Add stop
          </Button>
          <Button type="button" disabled={!stops || problems.length > 0 || middle.some((s) => !s.locationId) || saveStops.isPending} onClick={() => (setError(null), setNotice(''), saveStops.mutate())}>
            Save stops
          </Button>
          <Link href="/admin/routes">Back to routes</Link>
        </div>
      </section>
      <section className="card">
        <h2>Boarding and drop-off points</h2>
        {d.points.length === 0 ? (
          <p className="muted">No named points yet. Customers will see the stop names until you add some.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stop</th>
                  <th>Kind</th>
                  <th>Point</th>
                  <th>Landmark</th>
                  <th>Timing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.points.map((p) => (
                  <tr key={p.id}>
                    <td>{p.locationName}</td>
                    <td>{p.kind === 'BOARDING' ? 'Boarding' : 'Drop-off'}</td>
                    <td>{p.name}</td>
                    <td>{p.landmark}</td>
                    <td>{p.extraMinutes ? `${p.extraMinutes > 0 ? '+' : ''}${p.extraMinutes} min` : 'On time'}</td>
                    <td>
                      <Badge status={p.active ? 'ACTIVE' : 'INACTIVE'} />{' '}
                      <Button type="button" variant="outline" onClick={() => savePoint.mutate({ id: p.id, locationId: p.locationId, kind: p.kind, name: p.name, landmark: p.landmark, extraMinutes: p.extraMinutes, active: !p.active })}>
                        {p.active ? 'Deactivate' : 'Activate'}
                      </Button>{' '}
                      <Button type="button" variant="destructive" aria-label={`Delete point ${p.name}`} onClick={() => window.confirm(`Delete the point "${p.name}"?`) && (setError(null), removePoint.mutate(p.id))}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            savePoint.mutate({ ...point, active: true });
          }}
        >
          <div className="grid-2">
            <label>
              Kind
              <select value={point.kind} onChange={(e) => setPoint({ ...point, kind: e.target.value as 'BOARDING' | 'DROPOFF', locationId: '' })}>
                <option value="BOARDING">Boarding</option>
                <option value="DROPOFF">Drop-off</option>
              </select>
            </label>
            <label>
              Stop *
              <select required value={point.locationId} onChange={(e) => setPoint({ ...point, locationId: e.target.value })}>
                <option value="">Select stop</option>
                {usable.map((s) => (
                  <option key={s.locationId} value={s.locationId}>
                    {names.get(s.locationId) ?? s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Point name *
              <input required maxLength={120} value={point.name} onChange={(e) => setPoint({ ...point, name: e.target.value })} />
            </label>
            <label>
              Landmark
              <input maxLength={250} value={point.landmark} onChange={(e) => setPoint({ ...point, landmark: e.target.value })} />
            </label>
            <label>
              Minutes after the stop time (−60 to 120)
              <input type="number" min={-60} max={120} value={point.extraMinutes} onChange={(e) => setPoint({ ...point, extraMinutes: +e.target.value })} />
            </label>
          </div>
          <Button disabled={savePoint.isPending}>Add point</Button>
        </form>
      </section>
      <SegmentFares routeId={id} />
    </div>
  );
}
