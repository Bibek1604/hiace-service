'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Clock3, Route as RouteIcon } from 'lucide-react';
import { api } from './common';
import { TripResults } from './customer';
import { nepalTime } from '@/lib/utils';
import type { TripView } from '@/lib/types';

type Page = { items: TripView[]; nextPage: number | null };
type RouteChoice = { origin: string; destination: string };

/** YYYY-MM-DD plus whole days, computed on the calendar date so time zones cannot shift it. */
const addDays = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const dayName = (date: string) => new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

function filtersFor(date: string, route: RouteChoice | null) {
  const q = new URLSearchParams({ date });
  if (route) {
    q.set('origin', route.origin);
    q.set('destination', route.destination);
  }
  return q.toString();
}
// Same key and request as TripResults' first page, so the day counts and the list share one fetch.
const tripsQuery = (filters: string) => ({
  queryKey: ['trips', filters, 1],
  queryFn: () => api<Page>('/api/trips?' + filters + '&page=1'),
  refetchInterval: 30000,
});

function countdown(ms: number) {
  if (ms <= 60000) return 'leaving now';
  const minutes = Math.floor(ms / 60000),
    days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    mins = minutes % 60;
  if (days) return `leaves in ${days}d ${hours}h`;
  return hours ? `leaves in ${hours}h ${mins}m` : `leaves in ${mins} min`;
}

/** The next departure from now, with a live countdown and a one-tap way into its seat map. */
function NextDeparture({ trip }: { trip: TripView }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const from = trip.stops[trip.journey.from],
    to = trip.stops[trip.journey.to];
  return (
    <div className="next-departure" role="status">
      <span className="icon-tile">
        <Clock3 size={22} />
      </span>
      <div>
        <span className="eyebrow">NEXT HIACE</span>
        <strong>
          {from.name} → {to.name} · {nepalTime(trip.boardsAt)}
        </strong>
        <span className="muted">
          {now === null ? '' : countdown(Date.parse(trip.boardsAt) - now) + ' · '}
          {trip.available ?? 0} seats left
        </span>
      </div>
      <Link className="button" href={'/trips/' + trip.id}>
        Book now <ArrowRight size={15} />
      </Link>
    </div>
  );
}

function DayTab({ date, label, route, active, onPick }: { date: string; label: string; route: RouteChoice | null; active: boolean; onPick: () => void }) {
  const q = useQuery(tripsQuery(filtersFor(date, route)));
  const count = q.data?.items.length;
  return (
    <button type="button" role="tab" aria-selected={active} className={'day-tab' + (active ? ' active' : '')} onClick={onPick}>
      <strong>{label}</strong>
      <span>{dayName(date)}</span>
      <em>{count === undefined ? '…' : count === 0 ? 'No rides' : count + (q.data?.nextPage ? '+' : '') + (count === 1 ? ' ride' : ' rides')}</em>
    </button>
  );
}

export function HomeDepartures({ today }: { today: string }) {
  const days = [
    { date: today, label: 'Today' },
    { date: addDays(today, 1), label: 'Tomorrow' },
    { date: addDays(today, 2), label: 'Day after' },
  ];
  const [date, setDate] = useState(today),
    [route, setRoute] = useState<RouteChoice | null>(null);
  // Upcoming trips (no date) give the next departure and the routes people can pick from.
  const upcoming = useQuery({
    queryKey: ['trips', 'upcoming', 1],
    queryFn: () => api<Page>('/api/trips?page=1'),
    refetchInterval: 30000,
  });
  const routes = useMemo(() => {
    const seen = new Map<string, RouteChoice>();
    for (const t of upcoming.data?.items ?? []) {
      const r = { origin: t.route.origin.name, destination: t.route.destination.name };
      seen.set(r.origin + '→' + r.destination, r);
    }
    return [...seen.values()].slice(0, 8);
  }, [upcoming.data]);
  const next = upcoming.data?.items[0];
  const day = days.find((d) => d.date === date)!;
  const searchAll = '/search?' + new URLSearchParams({ origin: route?.origin ?? '', destination: route?.destination ?? '', date });
  return (
    <div className="stack home-departures">
      {next && <NextDeparture trip={next} />}
      <div className="day-tabs" role="tablist" aria-label="Travel day">
        {days.map((d) => (
          <DayTab key={d.date} date={d.date} label={d.label} route={route} active={d.date === date} onPick={() => setDate(d.date)} />
        ))}
      </div>
      {routes.length > 1 && (
        <div className="route-chips" aria-label="Filter by route">
          <RouteIcon size={16} className="muted" aria-hidden="true" />
          <button type="button" className={'chip' + (route ? '' : ' active')} aria-pressed={!route} onClick={() => setRoute(null)}>
            All routes
          </button>
          {routes.map((r) => {
            const on = route?.origin === r.origin && route.destination === r.destination;
            return (
              <button key={r.origin + r.destination} type="button" className={'chip' + (on ? ' active' : '')} aria-pressed={on} onClick={() => setRoute(on ? null : r)}>
                {r.origin} → {r.destination}
              </button>
            );
          })}
        </div>
      )}
      <TripResults
        home
        filters={filtersFor(date, route)}
        emptyText={
          (route ? `No ${route.origin} → ${route.destination} Hiace ` : 'No more Hiace departures ') +
          (day.label === 'Today' ? 'today.' : day.label === 'Tomorrow' ? 'tomorrow.' : 'on ' + dayName(date) + '.') +
          ' Try another day or see all upcoming rides.'
        }
      />
      <Link href={searchAll} className="blue row" style={{ justifyContent: 'center' }}>
        More dates and routes <ArrowRight size={16} />
      </Link>
    </div>
  );
}
