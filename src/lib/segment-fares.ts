import { z } from 'zod';
import { db } from './db';
import { ApiError } from './errors';
import { buildFareMatrix, type TripStop } from './inventory';
import type { Scope } from './admin';

async function load(scope: Scope, routeId: string) {
  const r = await db.route.findFirst({
    where: { id: routeId, ...(scope ? { operatorId: scope } : {}) },
    include: {
      origin: true,
      destination: true,
      stops: { orderBy: { position: 'asc' }, include: { location: true } },
    },
  });
  // Another operator's route is reported as missing.
  if (!r) throw new ApiError(404, 'Route not found.');
  const seq: TripStop[] = [
    { locationId: r.originId, name: r.origin.name, offsetMinutes: 0, kmFromOrigin: 0, allowBoarding: true, allowDropoff: false },
    ...r.stops.map((s) => ({
      locationId: s.locationId,
      name: s.location.name,
      offsetMinutes: s.offsetMinutes,
      kmFromOrigin: s.kmFromOrigin,
      allowBoarding: s.allowBoarding,
      allowDropoff: s.allowDropoff,
    })),
    { locationId: r.destinationId, name: r.destination.name, offsetMinutes: r.durationMinutes, kmFromOrigin: r.distanceKm, allowBoarding: false, allowDropoff: true },
  ];
  return { route: r, seq };
}

/** Every legal leg of a route with the distance-based price and any operator override for a vehicle type. */
export async function segmentFares(scope: Scope, routeId: string, vehicleType: string) {
  const { route, seq } = await load(scope, routeId);
  const saved = await db.routeSegmentFare.findMany({ where: { routeId, vehicleType } });
  const overrides = new Map(saved.map((f) => [`${f.fromLocationId}>${f.toLocationId}`, f.amount]));
  const base = (await db.routeFare.findFirst({ where: { routeId, vehicleType } }))?.fare ?? route.baseFare;
  const computed = buildFareMatrix(seq, base);
  return {
    vehicleType,
    fullFare: base,
    rows: computed.map((m) => {
      const from = seq[m.fromIdx],
        to = seq[m.toIdx];
      const override = overrides.get(`${from.locationId}>${to.locationId}`) ?? null;
      return {
        fromLocationId: from.locationId,
        toLocationId: to.locationId,
        fromName: from.name,
        toName: to.name,
        suggested: m.amount,
        override,
        amount: override ?? m.amount,
        locked: m.fromIdx === 0 && m.toIdx === seq.length - 1,
      };
    }),
  };
}

const input = z.object({
  routeId: z.string().min(1),
  vehicleType: z.string().trim().min(1).max(60),
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  /** null removes the override and returns the leg to distance-based pricing. */
  amount: z.number().int().min(1).max(10_000_000).nullable(),
});

export async function saveSegmentFare(scope: Scope, actorId: string, raw: unknown) {
  const d = input.parse(raw);
  const { route, seq } = await load(scope, d.routeId);
  const a = seq.findIndex((s) => s.locationId === d.fromLocationId),
    b = seq.findIndex((s) => s.locationId === d.toLocationId);
  if (a < 0 || b <= a || !seq[a].allowBoarding || !seq[b].allowDropoff)
    throw new ApiError(400, 'That leg is not part of this route.');
  if (a === 0 && b === seq.length - 1)
    throw new ApiError(400, 'The full-route fare is set on the trip or the route fare.');
  const key = { routeId: d.routeId, vehicleType: d.vehicleType, fromLocationId: d.fromLocationId, toLocationId: d.toLocationId };
  await db.$transaction(async (t) => {
    if (d.amount === null) await t.routeSegmentFare.deleteMany({ where: key });
    else
      await t.routeSegmentFare.upsert({
        where: { routeId_vehicleType_fromLocationId_toLocationId: key },
        create: { ...key, amount: d.amount },
        update: { amount: d.amount },
      });
    await t.auditLog.create({
      data: {
        actorId,
        operatorId: route.operatorId,
        action: 'SET_SEGMENT_FARE',
        targetId: d.routeId,
        details: { ...key, amount: d.amount },
      },
    });
  });
  return segmentFares(scope, d.routeId, d.vehicleType);
}
