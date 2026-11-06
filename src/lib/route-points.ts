import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { ApiError } from './errors';
import { buildSequence, checkPoint, pointInput, type Stop } from './route-stops';
import type { Scope } from './admin';

const own = (scope: Scope) => (scope ? { operatorId: scope } : {});

async function loadRoute(scope: Scope, routeId: string) {
  const route = await db.route.findFirst({
    where: { id: routeId, ...own(scope) },
    include: {
      origin: true,
      destination: true,
      stops: { orderBy: { position: 'asc' }, include: { location: true } },
      points: { orderBy: [{ kind: 'asc' }, { name: 'asc' }], include: { location: true } },
    },
  });
  // Another operator's route is reported as missing.
  if (!route) throw new ApiError(404, 'Route not found.');
  return route;
}

export const sequenceOf = (route: Awaited<ReturnType<typeof loadRoute>>): Stop[] =>
  buildSequence(route, route.stops);

/** The ordered stops with their timing, plus all boarding and drop-off points of one route. */
export async function routeDetail(scope: Scope, routeId: string) {
  const route = await loadRoute(scope, routeId);
  const names = new Map<string, string>([
    [route.originId, route.origin.name],
    [route.destinationId, route.destination.name],
    ...route.stops.map((s) => [s.locationId, s.location.name] as [string, string]),
  ]);
  return {
    id: route.id,
    route: {
      id: route.id,
      originId: route.originId,
      destinationId: route.destinationId,
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
      baseFare: route.baseFare,
      active: route.active,
    },
    sequence: sequenceOf(route).map((s, i) => ({ ...s, index: i, name: names.get(s.locationId)! })),
    points: route.points.map((p) => ({
      id: p.id,
      locationId: p.locationId,
      locationName: p.location.name,
      kind: p.kind,
      name: p.name,
      landmark: p.landmark,
      extraMinutes: p.extraMinutes,
      active: p.active,
    })),
  };
}

const pointSave = pointInput.extend({ id: z.string().optional(), routeId: z.string().min(1) });

export async function savePoint(scope: Scope, actorId: string, raw: unknown) {
  const { id, routeId, ...data } = pointSave.parse(raw);
  const route = await loadRoute(scope, routeId);
  const problem = checkPoint(sequenceOf(route), data);
  if (problem) throw new ApiError(400, problem);
  try {
    return await db.$transaction(async (t) => {
      if (id && !route.points.some((p) => p.id === id)) throw new ApiError(404, 'Point not found.');
      const row = id
        ? await t.boardingPoint.update({ where: { id }, data })
        : await t.boardingPoint.create({ data: { ...data, routeId } });
      await t.auditLog.create({
        data: {
          actorId,
          operatorId: route.operatorId,
          action: id ? 'UPDATE_ROUTE_POINT' : 'CREATE_ROUTE_POINT',
          targetId: row.id,
          details: { routeId, kind: data.kind, name: data.name, active: data.active },
        },
      });
      return row;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new ApiError(409, 'That point already exists on this route.');
    throw e;
  }
}

/** Removes a boarding or drop-off point. Existing bookings keep their printed point names. */
export async function deletePoint(scope: Scope, actorId: string, pointId: string) {
  const point = await db.boardingPoint.findFirst({
    where: { id: pointId, route: own(scope) },
    include: { route: { select: { id: true, operatorId: true } } },
  });
  // Another operator's point is reported as missing.
  if (!point) throw new ApiError(404, 'Point not found.');
  await db.$transaction(async (t) => {
    await t.boardingPoint.delete({ where: { id: point.id } });
    await t.auditLog.create({
      data: {
        actorId,
        operatorId: point.route.operatorId,
        action: 'DELETE_ROUTE_POINT',
        targetId: point.id,
        details: { routeId: point.route.id, kind: point.kind, name: point.name },
      },
    });
  });
  return { ok: true, id: point.id };
}
