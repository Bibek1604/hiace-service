'use client';
import { SeatControls } from './seat-controls';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, Download, Search, X } from 'lucide-react';
import { adminApi, api, Badge, ErrorBox, Sheet, Skeleton, StaffLink as Link, onForm } from './common';
import { BookingDetail, TicketCheck, TripCancel } from './bookings';
import { Button } from './ui/button';
import { fields } from '@/lib/form-fields';
import { money } from '@/lib/utils';
import type { TripView } from '@/lib/types';
type Row = Record<string, unknown> & { id: string };
type Choice = {
  id: string;
  name?: string;
  label?: string;
  registration?: string;
  type?: string;
  operatorId?: string;
  baseFare?: number;
  fares?: { vehicleType: string; fare: number }[];
  origin?: { name: string };
  destination?: { name: string };
};
const str = (v: unknown) =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const nepalInput = (s: string) => {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(s));
  return parts.replace(' ', 'T');
};
const METRICS: [string, string][] = [
  ['vehicles', 'Vehicles'],
  ['drivers', 'Drivers'],
  ['routes', 'Routes'],
  ['scheduledTrips', 'Scheduled trips'],
  ['completedTrips', 'Completed trips'],
  ['cancelledTrips', 'Cancelled trips'],
  ['bookings', 'Total bookings'],
  ['confirmed', 'Confirmed bookings'],
  ['cancelledBookings', 'Cancelled bookings'],
  ['pending', 'Payments awaiting review'],
  ['reconciliation', 'Reconciliation cases'],
  ['openRefunds', 'Open refunds'],
  ['revenue', 'Verified revenue'],
];
export function AdminDashboard({ reports = false }: { reports?: boolean }) {
  const [days, setDays] = useState(1);
  const q = useQuery({
    queryKey: ['reports', days],
    queryFn: () => api<Record<string, number>>(adminApi('reports?days=' + days)),
    refetchInterval: 15000,
  });
  function csv() {
    const rows = METRICS.map(([k, label]) => '"' + label + '",' + (q.data?.[k] ?? 0));
    const b = new Blob(['﻿metric,value\r\n' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(b),
      a = document.createElement('a');
    a.href = url;
    a.download = 'sajilo-yatra-report-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <p className="eyebrow">OPERATIONS OVERVIEW</p>
      <div className="spread">
        <h1>{reports ? 'Reports' : 'Dashboard'}</h1>
        {q.data && (
          <Button variant="outline" onClick={csv}>
            <Download size={16} />
            Export CSV
          </Button>
        )}
      </div>
      <p className="muted">Live figures from your records. They refresh every 15 seconds and after every change you make.</p>
      <div className="row">{[1, 7, 30].map(value => <Button key={value} variant={days === value ? 'default' : 'outline'} onClick={() => setDays(value)}>{value === 1 ? 'Today' : value + ' days'}</Button>)}</div>
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Skeleton />
      ) : q.data ? (
        <div className="stats">
          {METRICS.map(([k, label]) => (
            <div className="stat" key={k}>
              <span>{label}</span>
              <strong>{k === 'revenue' ? money(q.data[k] ?? 0) : (q.data[k] ?? 0)}</strong>
            </div>
          ))}
        </div>
      ) : null}
      <div className="grid-2">
        {(
          <Link href="/admin/payments" className="card">
            <CheckCircle2 className="blue" />
            <h2>Review payment proofs</h2>
            <p className="muted">Verify against actual bank or wallet evidence.</p>
            <span className="blue">Open payment queue →</span>
          </Link>
        )}
        {(
          <Link href="/admin/trips/new" className="card">
            <Plus className="blue" />
            <h2>Schedule a departure</h2>
            <p className="muted">Assign a vehicle, route, and available driver.</p>
            <span className="blue">Create a trip →</span>
          </Link>
        )}
      </div>
      {!!(q.data?.reconciliation || q.data?.openRefunds) && (
        <div className="notice">
          {q.data.reconciliation ? q.data.reconciliation + ' booking(s) need reconciliation (paid, but seats could not be confirmed). ' : ''}
          {q.data.openRefunds ? q.data.openRefunds + ' refund(s) are waiting for a decision or payout. ' : ''}
          Open the booking under Bookings to resolve it.
        </div>
      )}
    </>
  );
}
export function ResourceForm({
  resource,
  record,
  onDone,
}: {
  resource: string;
  record?: Row;
  onDone: (saved?: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v = { ...record };
    if (resource === 'vehicles' && record) {
      v.seatLabels = (record.seats as { label: string }[])?.map((s) => s.label) || [];
      v.imageKeys = (record.images as { key: string }[])?.map((i) => i.key) || [];
    }
    if (resource === 'routes' && record)
      v.stopIds = (record.stops as { locationId: string }[])?.map((s) => s.locationId) || [];
    if (resource === 'trips' && record)
      v.driverId = (record.assignments as { driverId: string }[])?.[0]?.driverId;
    for (const f of fields[resource] || []) {
      if (v[f.key] === undefined) v[f.key] = f.default ?? (f.type === 'checkbox' ? false : '');
      if (f.type === 'datetime-local' && v[f.key]) v[f.key] = nepalInput(String(v[f.key]));
      if (f.type === 'list' && Array.isArray(v[f.key])) v[f.key] = (v[f.key] as string[]).join(',');
    }
    return v;
  });
  const [pending, setPending] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState<unknown>(null);
  const tenantOwned = ['vehicles', 'routes', 'payment-qr', 'trips'].includes(resource);
  const [operatorId, setOperatorId] = useState('');
  const operators = useQuery({
    queryKey: ['owners'],
    enabled: tenantOwned && !record,
    queryFn: () => api<{ items: { id: string; name: string }[] }>(adminApi('owners')),
  });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Record<string, Choice[]>>(adminApi('catalog')),
  });
  function change(k: string, v: unknown) {
    setValues((old) => {
      const next = { ...old, [k]: v };
      if (resource === 'trips' && !record && ['vehicleId', 'routeId'].includes(k)) {
        const route = catalog.data?.routes.find((r) => r.id === next.routeId),
          vehicle = catalog.data?.vehicles.find((v) => v.id === next.vehicleId);
        if (route)
          next.fare =
            route.fares?.find((f) => f.vehicleType === vehicle?.type)?.fare ||
            route.baseFare ||
            next.fare;
      }
      return next;
    });
  }
  async function image(key: string, files: FileList | null, multiple: boolean) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      const ids: string[] = [];
      for (const f of Array.from(files)) {
        const form = new FormData();
        form.set('image', f);
        form.set(
          'purpose',
          resource === 'payment-qr' ? 'qr' : resource === 'vehicles' ? 'vehicle' : 'driver',
        );
        const obj = await api<{ id: string }>(adminApi('uploads'), { method: 'POST', body: form });
        ids.push(obj.id);
      }
      change(
        key,
        multiple
          ? [...(Array.isArray(values[key]) ? (values[key] as string[]) : []), ...ids]
          : ids[0],
      );
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const data: Record<string, unknown> = {};
      for (const f of fields[resource]) {
        let value = values[f.key];
        if (f.type === 'list')
          value = String(value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (f.type === 'images') value = Array.isArray(value) ? value : [];
        if (f.type === 'datetime-local' && value)
          value = new Date(String(value) + ':00+05:45').toISOString();
        if (f.type === 'number') value = Number(value);
        if (value === '' && !f.required) continue;
        data[f.key] = value;
      }
      if (record?.id) data.id = record.id;
      else if (tenantOwned) {
        if (!operatorId) throw new Error('Choose the driver this belongs to.');
        data.operatorId = operatorId;
      }
      await api(adminApi('') + resource, {
        method: record ? 'PATCH' : 'POST',
        body: JSON.stringify(data),
      });
      onDone(true);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="admin-form stack" onSubmit={submit}>
      <h2>
        {record ? 'Edit' : 'Add'} {resource.replaceAll('-', ' ')}
      </h2>
      {resource === 'trips' && (
        <p className="notice">
          Times use Nepal time. Vehicle, route, departure, and arrival cannot be changed after
          creation. Trip fares can override the route’s configured fare.
        </p>
      )}
      {tenantOwned && !record && (
        <label>
          Driver *
          <select required value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
            <option value="">Select driver</option>
            {operators.data?.items.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <div className="grid-2">
        {fields[resource]?.map((f) => (
          <label
            key={f.key}
            style={
              ['textarea', 'images', 'list'].includes(f.type || '')
                ? { gridColumn: '1/-1' }
                : undefined
            }
          >
            {f.label}
            {f.required ? ' *' : ''}
            {f.type === 'checkbox' ? (
              <input
                type="checkbox"
                checked={!!values[f.key]}
                onChange={(e) => change(f.key, e.target.checked)}
              />
            ) : f.type === 'textarea' ? (
              <textarea
                required={f.required}
                value={str(values[f.key])}
                onChange={(e) => change(f.key, e.target.value)}
              />
            ) : f.type === 'select' ? (
              <select
                required={f.required}
                value={str(values[f.key])}
                onChange={(e) => change(f.key, e.target.value)}
              >
                <option value="">Select {f.label.toLowerCase()}</option>
                {f.options?.map((o) => (
                  <option key={o}>{o}</option>
                ))}
                {f.source &&
                  catalog.data?.[f.source]
                    ?.filter((o) => f.source !== 'layouts' || !operatorId || o.operatorId === operatorId)
                    .map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.origin ? o.origin.name + ' → ' + o.destination?.name : o.name || o.label}
                      {o.registration ? ' · ' + o.registration : ''}
                    </option>
                  ))}
              </select>
            ) : f.type === 'image' || f.type === 'images' ? (
              <>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple={f.type === 'images'}
                  onChange={(e) => image(f.key, e.target.files, f.type === 'images')}
                />
                <div className="row">
                  {(Array.isArray(values[f.key])
                    ? (values[f.key] as string[])
                    : values[f.key]
                      ? [String(values[f.key])]
                      : []
                  ).map((id) => (
                    <div key={id}>
                      <img
                        src={'/api/images/' + id}
                        alt="Uploaded image"
                        style={{ width: 90, height: 90, objectFit: 'contain' }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          change(
                            f.key,
                            f.type === 'images'
                              ? (values[f.key] as string[]).filter((v) => v !== id)
                              : '',
                          )
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <input
                type={f.type === 'list' ? 'text' : f.type || 'text'}
                required={f.required}
                min={f.type === 'number' ? 1 : undefined}
                value={str(values[f.key])}
                autoComplete={f.type === 'password' ? 'new-password' : undefined}
                onChange={(e) => change(f.key, e.target.value)}
              />
            )}
          </label>
        ))}
      </div>
      <ErrorBox error={error || catalog.error} />
      <div className="row">
        <Button disabled={pending || uploading}>
          {uploading ? 'Uploading…' : pending ? 'Saving…' : record ? 'Save changes' : 'Create'}
        </Button>
        <Button type="button" variant="outline" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
const DESCRIPTIONS: Record<string, string> = {
  vehicles: 'Buses, microbuses and jeeps, with photos, amenities and seat layout.',
  drivers: 'Driver accounts and licences. Deactivate a driver to keep their trip history.',
  locations: 'Cities and stops shared by every driver.',
  routes: 'Origin, destination and the stops in between.',
  fares: 'Fare per vehicle type for each route.',
  trips: 'Scheduled departures. Download the passenger manifest, or cancel a trip together with its bookings.',
  bookings: 'Online and walk-in bookings. Open one to see its history, print its ticket, cancel it or settle a refund.',
  'payment-qr': 'Bank and wallet accounts customers pay into.',
  settings: 'Seat hold and payment review times.',
};
const SEARCHABLE = ['vehicles', 'drivers', 'locations', 'routes', 'trips', 'bookings'];
const SEARCH_HINT: Record<string, string> = {
  bookings: 'Reference, name or phone',
  trips: 'Vehicle, registration or place',
  vehicles: 'Name, registration or type',
  drivers: 'Name, email, mobile or licence',
  routes: 'Origin or destination',
  locations: 'Place name',
};
const STATUS_FILTERS: Record<string, string[]> = {
  bookings: ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED', 'PAYMENT_RECONCILIATION_REQUIRED', 'CANCELLED', 'REJECTED', 'EXPIRED'],
  trips: ['SCHEDULED', 'BOARDING', 'DEPARTED', 'COMPLETED', 'CANCELLED'],
};
export function AdminResource({
  resource,
  create = false,
}: {
  resource: string;
  create?: boolean;
}) {
  const [page, setPage] = useState(1),
    [editing, setEditing] = useState<Row | undefined>(),
    [show, setShow] = useState(create),
    [manual, setManual] = useState(false),
    [opened, setOpened] = useState<string | null>(null),
    [cancelling, setCancelling] = useState<{ id: string; label: string } | null>(null),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState(''),
    [notice, setNotice] = useState(''),
    [error, setError] = useState<unknown>(null);
  const client = useQueryClient();
  const deletable = !['bookings', 'settings'].includes(resource);
  const writable = true;
  const refreshAll = () => {
    client.invalidateQueries({ queryKey: ['admin', resource] });
    client.invalidateQueries({ queryKey: ['catalog'] });
    client.invalidateQueries({ queryKey: ['reports'] });
  };
  async function remove(row: Row) {
    const what = resource.replaceAll('-', ' ').replace(/s$/, '');
    if (!window.confirm(`Delete this ${what}? Records still used by trips or bookings are refused — deactivate those instead.`)) return;
    setError(null);
    setNotice('');
    try {
      await api(adminApi('') + resource + '/' + row.id, { method: 'DELETE' });
      if (editing?.id === row.id) setShow(false);
      setNotice('Deleted.');
      refreshAll();
    } catch (e) {
      setError(e);
    }
  }
  const filters = new URLSearchParams({ page: String(page), ...(search ? { q: search } : {}), ...(status ? { status } : {}) });
  const q = useQuery({
    queryKey: ['admin', resource, page, search, status],
    queryFn: () => api<{ items: Row[]; nextPage: number | null }>(adminApi('') + resource + '?' + filters),
    refetchInterval: 20000,
  });
  const title = resource.replaceAll('-', ' ');
  const searchable = SEARCHABLE.includes(resource),
    statuses = STATUS_FILTERS[resource];
  const columns: Record<string, string[]> = {
    vehicles: ['name', 'registration', 'type', 'operator', 'active'],
    drivers: ['name', 'email', 'mobile', 'licenseExpiry', 'active'],
    locations: ['name', 'id'],
    routes: ['origin', 'destination', 'distanceKm', 'durationMinutes', 'baseFare', 'active'],
    fares: ['route', 'vehicleType', 'fare'],
    trips: ['vehicle', 'route', 'departure', 'fare', 'status', 'bookingOpen'],
    bookings: ['reference', 'customer', 'trip', 'amount', 'status', 'createdAt'],
    settings: ['holdMinutes', 'reviewMinutes'],
    'payment-qr': ['label', 'accountName', 'operator', 'active'],
  };
  const display = (value: unknown) => {
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (v.origin)
        return (
          str((v.origin as { name: string }).name) +
          ' → ' +
          str((v.destination as { name: string }).name)
        );
      if (v.route) return display(v.route);
      return str(v.name || v.registration || v.label || '');
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    return str(value);
  };
  return (
    <>
      <p className="eyebrow">ADMINISTRATION</p>
      <div className="spread">
        <div>
          <h1 style={{ textTransform: 'capitalize' }}>{title}</h1>
          {DESCRIPTIONS[resource] && <p className="muted" style={{ margin: 0 }}>{DESCRIPTIONS[resource]}</p>}
        </div>
        <div className="row">
          {resource === 'routes' && (
            <Link href="/admin/locations" className="button outline">
              Locations
            </Link>
          )}
          {!writable ? null : resource === 'bookings' ? (
            <Button onClick={() => setManual(true)}>
              <Plus size={16} />
              Walk-in booking
            </Button>
          ) : (
            <Button
              onClick={() => {
                setEditing(undefined);
                setShow(true);
              }}
            >
              <Plus size={16} />
              {resource === 'settings' ? 'Configure' : 'Add new'}
            </Button>
          )}
        </div>
      </div>
      {(searchable || statuses) && (
        <form
          className="toolbar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setSearch(String(new FormData(e.currentTarget).get('q') || '').trim());
          }}
        >
          {searchable && (
            <label className="toolbar-search">
              <Search size={16} aria-hidden="true" />
              <input name="q" key={search} defaultValue={search} placeholder={SEARCH_HINT[resource] || 'Search'} aria-label={'Search ' + title} />
            </label>
          )}
          {statuses && (
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => {
                setPage(1);
                setStatus(e.target.value);
              }}
            >
              <option value="">All statuses</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll('_', ' ').toLowerCase()}
                </option>
              ))}
            </select>
          )}
          {searchable && <Button variant="outline">Search</Button>}
          {(search || status) && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSearch('');
                setStatus('');
                setPage(1);
              }}
            >
              <X size={15} /> Clear
            </Button>
          )}
        </form>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      <ErrorBox error={error || q.error} />
      {show && (
        <ResourceForm
          key={editing?.id || 'new'}
          resource={resource}
          record={editing}
          onDone={(saved) => {
            setShow(false);
            if (saved) setNotice(editing ? 'Changes saved.' : 'Created.');
            refreshAll();
          }}
        />
      )}
      {resource === 'trips' && editing && show && <SeatControls tripId={editing.id} />}
      {manual && (
        <ManualBooking
          onClose={(reference) => {
            setManual(false);
            if (reference) setNotice('Walk-in booking ' + reference + ' created.');
            refreshAll();
          }}
        />
      )}
      <Sheet open={!!opened} onOpenChange={(o) => !o && setOpened(null)} title="Booking details" description="Customer, seats, payment and everything that happened to this booking.">
        {opened && <BookingDetail id={opened} onChanged={refreshAll} />}
      </Sheet>
      <Sheet open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)} title="Cancel trip">
        {cancelling && (
          <TripCancel
            trip={cancelling}
            onDone={(message) => {
              setCancelling(null);
              setNotice(message);
              refreshAll();
            }}
          />
        )}
      </Sheet>
      {q.isLoading ? (
        <Skeleton />
      ) : (
        <div className="table-wrap">
          <table className="data-table responsive">
            <thead>
              <tr>
                {(columns[resource] || []).map((c) => (
                  <th key={c}>{c.replace(/([A-Z])/g, ' $1')}</th>
                ))}
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((row) => (
                <tr key={row.id}>
                  {(columns[resource] || []).map((c) => (
                    <td key={c} data-label={c.replace(/([A-Z])/g, ' $1')}>
                      {c === 'status' ? (
                        <>
                          <Badge status={str(row[c])} />
                          {refundOf(row) && <Badge status={'REFUND_' + refundOf(row)} />}
                        </>
                      ) : ['departure', 'licenseExpiry', 'expiresAt', 'createdAt'].includes(c) ? (
                        new Date(str(row[c])).toLocaleString('en-GB', {
                          timeZone: 'Asia/Kathmandu',
                        })
                      ) : (
                        display(row[c])
                      )}
                    </td>
                  ))}
                  <td className="row-actions" data-label="Actions">
                    {resource === 'bookings' ? (
                      <Button variant="outline" onClick={() => setOpened(row.id)}>
                        Open
                      </Button>
                    ) : !writable ? null : (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setEditing(row);
                            setShow(true);
                          }}
                        >
                          Edit
                        </Button>
                        {deletable && (
                          <Button
                            variant="destructive"
                            aria-label={'Delete ' + display(row.name ?? row.label ?? row.registration ?? row.id)}
                            onClick={() => remove(row)}
                          >
                            Delete
                          </Button>
                        )}
                      </>
                    )}
                    {resource === 'vehicles' && (
                      <Link className="blue" href={'/admin/vehicles/' + row.id}>
                        {' '}
                        Profile →
                      </Link>
                    )}
                    {resource === 'routes' && (
                      <Link className="blue" href={'/admin/routes/' + row.id}>
                        {' '}
                        Stops →
                      </Link>
                    )}
                    {resource === 'trips' && (
                      <a className="button outline" href={adminApi('trips/' + row.id + '/manifest')} download>
                        <Download size={15} /> Manifest
                      </a>
                    )}
                    {resource === 'trips' && writable && ['SCHEDULED', 'BOARDING'].includes(str(row.status)) && (
                      <Button
                        variant="destructive"
                        onClick={() =>
                          setCancelling({
                            id: row.id,
                            label: display(row.route) + ' · ' + new Date(str(row.departure)).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' }),
                          })
                        }
                      >
                        Cancel trip
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {!q.data?.items.length && (
                <tr>
                  <td colSpan={(columns[resource]?.length || 1) + 1}>
                    {search || status
                      ? 'Nothing matches these filters.'
                      : writable && resource !== 'bookings'
                        ? `No ${title} yet. Use “Add new” to create the first one.`
                        : `No ${title} yet.`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <Button variant="outline" onClick={() => setPage((p) => p - 1)} disabled={page === 1}>
          Previous
        </Button>
        <span>{page}</span>
        <Button
          variant="outline"
          onClick={() => setPage((p) => p + 1)}
          disabled={!q.data?.nextPage}
        >
          Next
        </Button>
      </div>
    </>
  );
}
const refundOf = (row: Row) => {
  const r = (row.cancellation as { refundStatus?: string } | null | undefined)?.refundStatus;
  return r && r !== 'NOT_REQUIRED' ? r : '';
};
function ManualBooking({ onClose }: { onClose: (reference?: string) => void }) {
  const [tripId, setTripId] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [key] = useState(() => crypto.randomUUID());
  const catalog = useQuery({
    queryKey: ['manual-trips'],
    queryFn: () => api<{ items: Row[] }>(adminApi('trips?status=SCHEDULED')),
  });
  const trip = useQuery({
    queryKey: ['trip', tripId],
    enabled: !!tripId,
    queryFn: () => api<TripView>('/api/trips/' + tripId),
  });
  async function submit(form: FormData) {
    setPending(true);
    setError(null);
    try {
      const data = {
        ...Object.fromEntries(form),
        tripId,
        seats: selected,
        idempotencyKey: key,
        confirm: form.get('confirm') === 'on',
      };
      const r = await api<{ reference: string }>(adminApi('manual-bookings'), {
        method: 'POST',
        body: JSON.stringify(data),
      });
      onClose(r.reference);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <form onSubmit={onForm(submit)} className="admin-form stack">
      <h2>Walk-in booking</h2>
      <label>
        Trip
        <select
          required
          value={tripId}
          onChange={(e) => {
            setTripId(e.target.value);
            setSelected([]);
          }}
        >
          <option value="">Choose trip</option>
          {catalog.data?.items.map((t) => (
            <option key={t.id} value={t.id}>
              {str((t.vehicle as Row).name)} ·{' '}
              {new Date(str(t.departure)).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        {trip.data?.seats
          .filter((s) => s.state === 'AVAILABLE')
          .map((s) => (
            <label key={s.id}>
              <input
                type="checkbox"
                checked={selected.includes(s.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, s.id] : selected.filter((v) => v !== s.id),
                  )
                }
              />
              {s.label}
            </label>
          ))}
      </div>
      <label>
        Passenger name
        <input name="name" required />
      </label>
      <label>
        Phone
        <input name="phone" type="tel" required />
      </label>
      <label>
        Payment method
        <select name="method">
          <option value="UNPAID">Awaiting payment (expires normally)</option>
          <option value="CASH">Cash received</option>
          <option value="QR">QR payment independently verified</option>
        </select>
      </label>
      <label>
        Receipt / bank evidence
        <input name="bankEvidence" />
      </label>
      <label>
        Reservation notes
        <textarea name="note" required minLength={3} />
      </label>
      <label className="row">
        <input type="checkbox" name="confirm" />I confirm actual receipt for a paid booking.
      </label>
      <ErrorBox error={error || trip.error} />
      <div className="row">
        <Button disabled={pending || !selected.length}>
          {pending ? 'Saving…' : 'Create booking'}
        </Button>
        <Button type="button" variant="outline" onClick={() => onClose()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
export function TicketCheckPage() {
  return (
    <>
      <p className="eyebrow">BOARDING</p>
      <h1>Check tickets</h1>
      <p className="muted">
        Paste the verification code from a passenger’s ticket. Only confirmed, paid tickets for your own trips pass.
      </p>
      <div className="card" style={{ maxWidth: 640 }}>
        <TicketCheck endpoint={adminApi('validate-ticket')} />
      </div>
    </>
  );
}
export function VehicleProfile({ id }: { id: string }) {
  type Profile = {
    id: string;
    name: string;
    registration: string;
    operator: string;
    type: string;
    description: string;
    active: boolean;
    maintenanceNote: string;
    amenities: string[];
    images: { key: string }[];
    seats: { label: string }[];
    trips: {
      id: string;
      departure: string;
      arrival: string;
      status: string;
      route: { origin: { name: string }; destination: { name: string } };
      assignments: { endedAt: string | null; driver: { name: string } }[];
      bookings: { id: string; reference: string; status: string; amount: number }[];
    }[];
  };
  const q = useQuery({
    queryKey: ['vehicle', id],
    queryFn: () => api<Profile>(adminApi('vehicle-profile/') + id),
  });
  const v = q.data;
  if (!v)
    return (
      <>
        <ErrorBox error={q.error} />
        {q.isLoading && <Skeleton />}
      </>
    );
  return (
    <>
      <Link href="/admin/vehicles" className="blue">
        ← All vehicles
      </Link>
      <h1 style={{ marginTop: 20 }}>{v.name}</h1>
      <p>
        {v.registration} · {v.type} · {v.operator}
      </p>
      <div className="row">
        {v.images.map((i) => (
          <img
            alt={v.name}
            key={i.key}
            src={'/api/images/' + i.key}
            style={{ width: 260, height: 170, objectFit: 'cover', borderRadius: 12 }}
          />
        ))}
      </div>
      <div className="card">
        <h2>Vehicle profile</h2>
        <p>{v.description}</p>
        <p>
          Status: {v.active ? 'Operational' : 'Unavailable'} · {v.seats.length} passenger seats
        </p>
        <p>Amenities: {v.amenities.join(', ') || 'None listed'}</p>
        <p>Maintenance: {v.maintenanceNote || 'No maintenance notes'}</p>
        <h3>Seat layout</h3>
        <div className="row">
          {v.seats.map((s) => (
            <Badge key={s.label} status={s.label} />
          ))}
        </div>
      </div>
      <h2>Trips, drivers, and booking history</h2>
      <p className="muted">
        Latest 50 trips. Driver assignment history is preserved for each trip.
      </p>
      {v.trips.map((t) => (
        <div className="card" key={t.id}>
          <div className="spread">
            <h3>
              {t.route.origin.name} → {t.route.destination.name}
            </h3>
            <Badge status={t.status} />
          </div>
          <p>{new Date(t.departure).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</p>
          <p>
            Driver assignments:{' '}
            {t.assignments
              .map((a) => a.driver.name + (a.endedAt ? ' (previous)' : ' (current)'))
              .join(', ')}
          </p>
          {t.bookings.map((b) => (
            <p key={b.id}>
              {b.reference} · <Badge status={b.status} /> · {money(b.amount)}
            </p>
          ))}
        </div>
      ))}
    </>
  );
}
