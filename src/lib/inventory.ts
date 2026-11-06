import { journeysOverlap, resolveJourney, type Journey, type Stop } from './route-stops';

/** A trip freezes its stop timeline when it is created, so later route edits never move live bookings. */
export type TripStop = Stop & { name: string };

export type FareRow = { fromIdx: number; toIdx: number; amount: number };

/** Fares for every legal boarding -> drop-off pair, proportional to distance unless an override exists. */
export function buildFareMatrix(
  seq: TripStop[],
  fullFare: number,
  overrides: Map<string, number> = new Map(),
): FareRow[] {
  const last = seq.length - 1;
  const total = seq[last].kmFromOrigin;
  const rows: FareRow[] = [];
  for (let i = 0; i < last; i++) {
    if (!seq[i].allowBoarding) continue;
    for (let j = i + 1; j <= last; j++) {
      if (!seq[j].allowDropoff) continue;
      const key = `${seq[i].locationId}>${seq[j].locationId}`;
      const share = Math.round((fullFare * (seq[j].kmFromOrigin - seq[i].kmFromOrigin)) / total);
      const amount = i === 0 && j === last ? fullFare : (overrides.get(key) ?? Math.max(1, share));
      rows.push({ fromIdx: i, toIdx: j, amount });
    }
  }
  return rows;
}

export function priceJourney(matrix: FareRow[], j: Pick<Journey, 'from' | 'to'>): number {
  const row = matrix.find((r) => r.fromIdx === j.from && r.toIdx === j.to);
  if (!row) throw new RangeError('No fare is defined for this journey.');
  return row.amount;
}

export type Claim = {
  status: string;
  expiresAt: Date | string;
  fromIdx: number;
  toIdx: number;
};
export type SeatView = 'AVAILABLE' | 'HELD' | 'BOOKED' | 'BLOCKED';

/**
 * State of one seat for a specific journey. Only claims that share a segment with the journey matter,
 * so a seat sold for another leg of the route still shows as available.
 */
export function seatStateFor(
  blocked: boolean,
  claims: Claim[],
  journey: Pick<Journey, 'from' | 'to'>,
  now = Date.now(),
): SeatView {
  if (blocked) return 'BLOCKED';
  let held = false;
  for (const c of claims) {
    if (!journeysOverlap({ ...journey, segments: [] }, { from: c.fromIdx, to: c.toIdx, segments: [] })) continue;
    if (c.status === 'CONFIRMED') return 'BOOKED';
    if (new Date(c.expiresAt).getTime() > now) held = true;
  }
  return held ? 'HELD' : 'AVAILABLE';
}

/** Local clock time (as an instant) at which the vehicle reaches a stop. */
export const timeAtStop = (departure: Date, seq: Pick<Stop, 'offsetMinutes'>[], idx: number) =>
  new Date(departure.getTime() + seq[idx].offsetMinutes * 60000);

/**
 * Finds the first boarding/drop-off pair on a trip whose place names contain the search words.
 * Empty words mean the trip's own origin or destination.
 */
export function matchJourney(seq: TripStop[], origin: string, destination: string): Journey | null {
  const has = (s: TripStop, q: string) => s.name.toLowerCase().includes(q.trim().toLowerCase());
  const last = seq.length - 1;
  for (let i = 0; i < last; i++) {
    if (!seq[i].allowBoarding || (origin.trim() && !has(seq[i], origin))) continue;
    if (!origin.trim() && i !== 0) break;
    for (let j = i + 1; j <= last; j++) {
      if (!seq[j].allowDropoff) continue;
      if (destination.trim() ? has(seq[j], destination) : j === last) return resolveJourney(seq, seq[i].locationId, seq[j].locationId);
    }
  }
  return null;
}
