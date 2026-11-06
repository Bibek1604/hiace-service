import { z } from 'zod';

/** One place on a route in travel order. Index 0 is the origin and the last index is the destination. */
export type Stop = {
  locationId: string;
  offsetMinutes: number;
  kmFromOrigin: number;
  allowBoarding: boolean;
  allowDropoff: boolean;
};

export const stopInput = z.object({
  locationId: z.string().min(1),
  offsetMinutes: z.number().int().min(1),
  kmFromOrigin: z.number().int().min(1),
  allowBoarding: z.boolean().default(true),
  allowDropoff: z.boolean().default(true),
});
export type StopInput = z.infer<typeof stopInput>;

export const pointInput = z.object({
  locationId: z.string().min(1),
  kind: z.enum(['BOARDING', 'DROPOFF']),
  name: z.string().trim().min(1).max(120),
  landmark: z.string().trim().max(250).default(''),
  /** Minutes after the stop's scheduled time that the vehicle waits here. May be negative for an earlier pickup. */
  extraMinutes: z.number().int().min(-60).max(120).default(0),
  active: z.boolean().default(true),
});
export type PointInput = z.infer<typeof pointInput>;

/** Origin, intermediate stops, destination, with endpoints taking the route's totals. */
export function buildSequence(
  route: { originId: string; destinationId: string; durationMinutes: number; distanceKm: number },
  middle: StopInput[],
): Stop[] {
  return [
    { locationId: route.originId, offsetMinutes: 0, kmFromOrigin: 0, allowBoarding: true, allowDropoff: false },
    ...middle.map((s) => ({ ...s })),
    {
      locationId: route.destinationId,
      offsetMinutes: route.durationMinutes,
      kmFromOrigin: route.distanceKm,
      allowBoarding: false,
      allowDropoff: true,
    },
  ];
}

/** Problems with a stop sequence; empty array means the sequence is usable for segment-aware inventory. */
export function validateSequence(seq: Stop[]): string[] {
  const out: string[] = [];
  if (seq.length < 2) return ['A route needs an origin and a destination.'];
  const seen = new Set<string>();
  for (const s of seq) {
    if (seen.has(s.locationId)) out.push('A location can appear on a route only once.');
    seen.add(s.locationId);
  }
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].offsetMinutes <= seq[i - 1].offsetMinutes)
      out.push('Stops must be in increasing time order after departure.');
    if (seq[i].kmFromOrigin <= seq[i - 1].kmFromOrigin)
      out.push('Stops must be in increasing distance from the origin.');
  }
  if (!seq.slice(1, -1).every((s) => s.allowBoarding || s.allowDropoff))
    out.push('An intermediate stop must allow boarding or drop-off, or be removed.');
  return [...new Set(out)];
}

/** Segment i is the leg between stops i and i+1; a journey from stop a to b occupies segments a..b-1. */
export const segmentCount = (seq: Stop[]) => seq.length - 1;

export type Journey = { from: number; to: number; segments: number[] };

/** Resolves a passenger's boarding and drop-off locations into the segments they occupy. */
export function resolveJourney(seq: Stop[], fromId: string, toId: string): Journey {
  const from = seq.findIndex((s) => s.locationId === fromId);
  const to = seq.findIndex((s) => s.locationId === toId);
  if (from < 0 || to < 0) throw new RangeError('Location is not on this route.');
  if (from >= to) throw new RangeError('Drop-off must come after boarding.');
  if (!seq[from].allowBoarding) throw new RangeError('Boarding is not allowed at this stop.');
  if (!seq[to].allowDropoff) throw new RangeError('Drop-off is not allowed at this stop.');
  return { from, to, segments: Array.from({ length: to - from }, (_, i) => from + i) };
}

/** Two journeys on the same seat conflict exactly when they share a segment. */
export const journeysOverlap = (a: Journey, b: Journey) => a.from < b.to && b.from < a.to;

/** Boarding points must sit on a stop that allows their kind. Returns an error message or null. */
export function checkPoint(seq: Stop[], p: PointInput): string | null {
  const stop = seq.find((s) => s.locationId === p.locationId);
  if (!stop) return 'That location is not on the route.';
  if (p.kind === 'BOARDING' && !stop.allowBoarding) return 'Boarding is not allowed at this stop.';
  if (p.kind === 'DROPOFF' && !stop.allowDropoff) return 'Drop-off is not allowed at this stop.';
  return null;
}
