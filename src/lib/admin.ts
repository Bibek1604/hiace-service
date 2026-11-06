import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { hashPassword as passwordHash } from './password';
import { db } from './db';
import { serial, expire } from './bookings';
import { ApiError } from './security';
import { seatsForVehicle } from './layouts';
import { buildFareMatrix, type TripStop } from './inventory';
import { tripTransitionAllowed } from './cancellations';
import { buildSequence, checkPoint, stopInput, validateSequence, type StopInput } from './route-stops';
const text = z.string().trim().min(1).max(250),
  phone = z.string().regex(/^\+?\d{7,15}$/),
  positive = z.coerce.number().int().positive();
const shapes = {
  vehicles: z.object({
    id: z.string().optional(),
    name: text,
    registration: text,
    type: text,
    operator: text,
    operatorContact: phone,
    emergencyContact: phone,
    description: z.string().max(5000).default(''),
    amenities: z.array(text).default([]),
    active: z.boolean().default(true),
    maintenanceNote: z.string().max(1000).default(''),
    seatLabels: z.array(text).max(100).optional(),
    layoutVersionId: z.string().optional(),
    imageKeys: z.array(text).max(12).default([]),
  }),
  drivers: z.object({
    id: z.string().optional(),
    name: text,
    email: z.email().transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128).optional(),
    mobile: phone,
    licenseNumber: text,
    licenseExpiry: z.iso.datetime(),
    emergencyContact: phone,
    address: z.string().max(500).optional(),
    photoKey: z.string().optional(),
    active: z.boolean().default(true),
    status: z.enum(['ACTIVE', 'DEACTIVATED', 'SUSPENDED']).optional(),
  }),
  locations: z.object({ id: z.string().optional(), name: text }),
  routes: z.object({
    id: z.string().optional(),
    originId: text,
    destinationId: text,
    distanceKm: positive,
    durationMinutes: positive,
    baseFare: positive,
    active: z.boolean().default(true),
    stopIds: z.array(text).optional(),
    stops: z.array(stopInput).max(20).optional(),
  }),
  fares: z.object({ id: z.string().optional(), routeId: text, vehicleType: text, fare: positive }),
  trips: z.object({
    id: z.string().optional(),
    vehicleId: text,
    routeId: text,
    driverId: text,
    paymentQRId: text,
    departure: z.iso.datetime(),
    arrival: z.iso.datetime(),
    boardingPoint: text,
    dropPoint: text,
    fare: positive,
    bookingOpen: z.boolean().default(true),
    bookingOpensAt: z.iso.datetime().optional(),
    bookingClosesAt: z.iso.datetime().optional(),
    recurringRule: z.string().trim().max(300).optional(),
    status: z
      .enum(['SCHEDULED', 'BOARDING', 'DEPARTED', 'COMPLETED', 'CANCELLED'])
      .default('SCHEDULED'),
  }),
  'payment-qr': z.object({
    id: z.string().optional(),
    label: text,
    imageKey: text,
    accountName: text,
    accountNumber: z.string().max(100).optional(),
    operator: z.string().max(250).optional(),
    instructions: z.string().min(1).max(3000),
    active: z.boolean().default(true),
    isDefault: z.boolean().default(false),
  }),
  settings: z.object({
    holdMinutes: z.coerce.number().int().min(1).max(60),
    reviewMinutes: z.coerce.number().int().min(1).max(120),
  }),
};
/** Tenant scope: null means platform-wide (super admin); a string pins every query to that operator. */
export type Scope = string | null;
const tenantOnly = new Set(['vehicles', 'routes', 'payment-qr', 'trips', 'fares', 'drivers']);
const own = (scope: Scope) => (scope ? { operatorId: scope } : {});
async function assertOwned(
  tx: Pick<typeof db, 'vehicle' | 'route' | 'paymentQR' | 'trip' | 'routeFare' | 'driver'>,
  resource: string,
  id: string,
  scope: Scope,
) {
  if (!scope) return;
  const where = { id, operatorId: scope };
  const found =
    resource === 'vehicles'
      ? await tx.vehicle.findFirst({ where, select: { id: true } })
      : resource === 'routes'
        ? await tx.route.findFirst({ where, select: { id: true } })
        : resource === 'payment-qr'
          ? await tx.paymentQR.findFirst({ where, select: { id: true } })
          : resource === 'trips'
            ? await tx.trip.findFirst({ where, select: { id: true } })
            : resource === 'drivers'
              ? await tx.driver.findFirst({ where, select: { id: true } })
            : await tx.routeFare.findFirst({
                where: { id, route: { operatorId: scope } },
                select: { id: true },
              });
  // Same response as a missing record so IDs of other tenants cannot be probed.
  if (!found) throw new ApiError(404, 'Record not found.');
}
/** Freezes a route's current stops and the fares for every legal journey on it. */
async function timeline(
  tx: Pick<typeof db, 'route'>,
  routeId: string,
  vehicleType: string,
  fullFare: number,
) {
  const r = await tx.route.findUniqueOrThrow({
    where: { id: routeId },
    include: {
      origin: true,
      destination: true,
      stops: { orderBy: { position: 'asc' }, include: { location: true } },
      segmentFares: { where: { vehicleType } },
    },
  });
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
  const problems = validateSequence(seq);
  if (problems.length) throw new ApiError(409, 'Fix the route stops first: ' + problems.join(' '));
  const overrides = new Map(r.segmentFares.map((f) => [`${f.fromLocationId}>${f.toLocationId}`, f.amount]));
  return { seq, matrix: buildFareMatrix(seq, fullFare, overrides) };
}
export async function catalog(scope: Scope = null) {
  const [vehicles, drivers, locations, routes, qrs, layoutVersions] = await Promise.all([
    db.vehicle.findMany({
      select: { id: true, name: true, registration: true, type: true },
      where: { active: true, ...own(scope) },
    }),
    db.driver.findMany({ select: { id: true, name: true }, where: { active: true, ...own(scope) } }),
    db.location.findMany(),
    db.route.findMany({
      where: own(scope),
      include: { origin: true, destination: true, fares: true },
    }),
    db.paymentQR.findMany({ where: { active: true, ...own(scope) } }),
    db.seatLayoutVersion.findMany({
      where: { status: 'PUBLISHED', layout: { archived: false, ...own(scope) } },
      select: { id: true, version: true, seatCount: true, layout: { select: { name: true, operatorId: true } } },
      orderBy: { publishedAt: 'desc' },
    }),
  ]);
  const layouts = layoutVersions.map((v) => ({
    id: v.id,
    operatorId: v.layout.operatorId,
    name: `${v.layout.name} v${v.version} (${v.seatCount} seats)`,
  }));
  return { vehicles, drivers, locations, routes, qrs, layouts };
}
export async function save(
  resource: string,
  raw: unknown,
  actorId: string,
  patch: boolean,
  scope: Scope = null,
) {
  if (!(resource in shapes)) throw new ApiError(404, 'Unknown module.');
  // Platform-wide records and settings are super-admin only.
  if (scope && !tenantOnly.has(resource)) throw new ApiError(403, 'Access denied.');
  const asked = (raw as { operatorId?: unknown } | null)?.operatorId;
  if (scope && typeof asked === 'string' && asked !== scope)
    throw new ApiError(404, 'Record not found.');
  const tenant = scope ?? (typeof asked === 'string' ? asked : null);
  if (!patch && tenantOnly.has(resource) && resource !== 'fares' && !tenant)
    throw new ApiError(400, 'operatorId is required.');
  const checked = shapes[resource as keyof typeof shapes].parse(raw);
  if (patch && resource !== 'settings' && !('id' in checked && checked.id))
    throw new ApiError(400, 'Record ID required.');
  return serial(async (tx) => {
    let result: { id: string };
    if (resource === 'vehicles') {
      const d = shapes.vehicles.parse(raw),
        { id, seatLabels, layoutVersionId, imageKeys, ...data } = d;
      if (id) await assertOwned(tx, resource, id, scope);
      if (!id && !seatLabels?.length && !layoutVersionId)
        throw new ApiError(400, 'Choose a seat layout.');
      if (seatLabels && new Set(seatLabels).size !== seatLabels.length)
        throw new ApiError(400, 'Duplicate seat labels.');
      for (const key of imageKeys)
        if (!(await tx.storedObject.findFirst({ where: { id: key, purpose: 'vehicle' } })))
          throw new ApiError(400, 'Upload vehicle images first.');
      if (id) {
        const old = await tx.vehicleSeat.findMany({
          where: { vehicleId: id },
          orderBy: [{ row: 'asc' }, { column: 'asc' }],
        });
        const current = await tx.vehicle.findUniqueOrThrow({
          where: { id },
          select: { layoutVersionId: true },
        });
        if (layoutVersionId && layoutVersionId !== current.layoutVersionId)
          throw new ApiError(409, 'A vehicle keeps the seat layout it was registered with.');
        if (
          !layoutVersionId &&
          seatLabels &&
          old.map((s) => s.label).join(',') !== seatLabels.join(',')
        )
          throw new ApiError(
            409,
            'Seat layouts cannot change after registration. Register a new vehicle layout.',
          );
        result = await tx.vehicle.update({ where: { id }, data });
        await tx.vehicleImage.deleteMany({ where: { vehicleId: id } });
        await tx.vehicleImage.createMany({
          data: imageKeys.map((key, position) => ({ vehicleId: id, key, position })),
        });
      } else {
        const planned = layoutVersionId
          ? await seatsForVehicle(tx, tenant!, layoutVersionId)
          : seatLabels!.map((label, i) => ({
              label,
              row: Math.floor(i / 4),
              column: i % 4,
              deck: 0,
              category: 'STANDARD',
            }));
        result = await tx.vehicle.create({
          data: {
            ...data,
            operatorId: tenant!,
            layoutVersionId: layoutVersionId ?? null,
            seats: { create: planned },
            images: { create: imageKeys.map((key, position) => ({ key, position })) },
          },
        });
      }
    } else if (resource === 'drivers') {
      const { id, password, status, ...data } = shapes.drivers.parse(raw);
      if (!id && !password) throw new ApiError(400, 'A driver password is required.');
      if (
        data.photoKey &&
        !(await tx.storedObject.findFirst({ where: { id: data.photoKey, purpose: 'driver' } }))
      )
        throw new ApiError(400, 'Upload the driver photo first.');
      if (id) await assertOwned(tx, resource, id, scope);
      const secret = password ? { passwordHash: await passwordHash(password) } : {};
      // A password reset ends every sign-in made with the old one.
      if (id && password) await tx.session.deleteMany({ where: { driverId: id } });
      const nextStatus = status ?? (data.active ? 'ACTIVE' : 'DEACTIVATED');
      const driverData = { ...data, active: nextStatus === 'ACTIVE', status: nextStatus };
      result = id
        ? await tx.driver.update({
            where: { id },
            data: { ...driverData, ...secret, licenseExpiry: new Date(data.licenseExpiry), suspendedReason: nextStatus === 'SUSPENDED' ? 'Suspended by admin.' : null },
          })
        : await tx.driver.create({
            data: {
              ...driverData,
              operatorId: tenant!,
              licenseExpiry: new Date(data.licenseExpiry),
              passwordHash: secret.passwordHash!,
            },
          });
      // A deactivated driver is signed out and passengers can no longer book their departures.
      if (id && nextStatus !== 'ACTIVE') {
        const { operatorId } = await tx.driver.findUniqueOrThrow({ where: { id }, select: { operatorId: true } });
        await tx.session.deleteMany({ where: { driverId: id } });
        await tx.trip.updateMany({ where: { operatorId, status: 'SCHEDULED', bookingOpen: true }, data: { bookingOpen: false } });
      }
    } else if (resource === 'locations') {
      const { id, ...data } = shapes.locations.parse(raw);
      result = id
        ? await tx.location.update({ where: { id }, data })
        : await tx.location.create({ data });
    } else if (resource === 'routes') {
      const { id, stopIds, stops, ...data } = shapes.routes.parse(raw);
      if (data.originId === data.destinationId)
        throw new ApiError(400, 'Choose different locations.');
      if (id) await assertOwned(tx, resource, id, scope);
      result = id
        ? await tx.route.update({ where: { id }, data })
        : await tx.route.create({ data: { ...data, operatorId: tenant! } });
      // Legacy callers send only location ids; spread them evenly so the sequence stays valid.
      const middle: StopInput[] | undefined =
        stops ??
        stopIds?.map((locationId, i) => ({
          locationId,
          offsetMinutes: Math.max(1, Math.floor((data.durationMinutes * (i + 1)) / (stopIds.length + 1))),
          kmFromOrigin: Math.max(1, Math.floor((data.distanceKm * (i + 1)) / (stopIds.length + 1))),
          allowBoarding: true,
          allowDropoff: true,
        }));
      if (middle) {
        const sequence = buildSequence(data, middle);
        const problems = validateSequence(sequence);
        if (problems.length) throw new ApiError(400, problems.join(' '));
        await tx.routeStop.deleteMany({ where: { routeId: result.id } });
        await tx.routeStop.createMany({
          data: middle.map((s, position) => ({ ...s, routeId: result.id, position })),
        });
        // Points whose stop moved, vanished or stopped allowing that movement are removed with it.
        const points = await tx.boardingPoint.findMany({ where: { routeId: result.id } });
        const stale = points.filter((p) => checkPoint(sequence, p) !== null).map((p) => p.id);
        if (stale.length) await tx.boardingPoint.deleteMany({ where: { id: { in: stale } } });
      }
    } else if (resource === 'fares') {
      const { id, ...data } = shapes.fares.parse(raw);
      if (id) await assertOwned(tx, resource, id, scope);
      if (scope && !(await tx.route.findFirst({ where: { id: data.routeId, operatorId: scope } })))
        throw new ApiError(404, 'Record not found.');
      result = id
        ? await tx.routeFare.update({ where: { id }, data })
        : await tx.routeFare.create({ data });
    } else if (resource === 'payment-qr') {
      const { id, ...data } = shapes['payment-qr'].parse(raw);
      if (!(await tx.storedObject.findFirst({ where: { id: data.imageKey, purpose: 'qr' } })))
        throw new ApiError(400, 'Upload the payment QR first.');
      if (id) await assertOwned(tx, resource, id, scope);
      result = id
        ? await tx.paymentQR.update({ where: { id }, data })
        : await tx.paymentQR.create({ data: { ...data, operatorId: tenant! } });
    } else if (resource === 'settings') {
      const data = shapes.settings.parse(raw);
      result = await tx.settings.upsert({
        where: { id: 'global' },
        create: { id: 'global', ...data },
        update: data,
      });
    } else {
      const { id, driverId, ...data } = shapes.trips.parse(raw),
        departure = new Date(data.departure),
        arrival = new Date(data.arrival);
      if (arrival <= departure) throw new ApiError(400, 'Arrival must follow departure.');
      const bookingOpensAt = data.bookingOpensAt ? new Date(data.bookingOpensAt) : null,
        bookingClosesAt = data.bookingClosesAt ? new Date(data.bookingClosesAt) : null;
      if ((bookingOpensAt && bookingClosesAt && bookingOpensAt >= bookingClosesAt) || (bookingClosesAt && bookingClosesAt > departure))
        throw new ApiError(400, 'Booking must open before it closes, and close no later than departure.');
      const [v, d, r, q] = await Promise.all([
        tx.vehicle.findUnique({ where: { id: data.vehicleId }, include: { seats: true } }),
        tx.driver.findUnique({ where: { id: driverId } }),
        tx.route.findUnique({ where: { id: data.routeId } }),
        tx.paymentQR.findUnique({ where: { id: data.paymentQRId } }),
      ]);
      if (id) await assertOwned(tx, resource, id, scope);
      if (
        !v ||
        !r ||
        !q ||
        v.operatorId !== r.operatorId ||
        v.operatorId !== q.operatorId ||
        (scope && v.operatorId !== scope)
      )
        throw new ApiError(400, 'Vehicle, route and payment QR must belong to the same operator.');
      if (d && d.operatorId !== v.operatorId)
        throw new ApiError(400, 'The driver belongs to a different operator.');
      if (!v?.active || !d?.active || !r?.active || !q?.active || d.licenseExpiry < arrival)
        throw new ApiError(
          400,
          'Choose active vehicle, route, QR, and a driver licensed through arrival.',
        );
      if (q.operator && q.operator !== v.operator)
        throw new ApiError(400, 'QR account belongs to a different operator.');
      if (id) {
        await expire(tx, id);
        const old = await tx.trip.findUnique({
          where: { id },
          include: { assignments: { where: { endedAt: null } } },
        });
        if (!old) throw new ApiError(404, 'Trip not found.');
        if (
          old.vehicleId !== data.vehicleId ||
          old.routeId !== data.routeId ||
          old.departure.getTime() !== departure.getTime() ||
          old.arrival.getTime() !== arrival.getTime()
        )
          throw new ApiError(
            409,
            'Vehicle, route and times are immutable. Create a replacement trip.',
          );
        if (!tripTransitionAllowed(old.status, data.status))
          throw new ApiError(409, 'A trip cannot move from ' + old.status.toLowerCase() + ' to ' + data.status.toLowerCase() + '.');
        if (
          data.status === 'CANCELLED' &&
          (await tx.booking.count({
            where: { tripId: id, status: { in: ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED'] } },
          }))
        )
          throw new ApiError(409, 'This trip has active bookings. Use “Cancel trip” to cancel it together with its bookings.');
        if (old.fare !== data.fare) {
          if (await tx.booking.count({ where: { tripId: id } }))
            throw new ApiError(409, 'The fare is fixed once a trip has bookings.');
          // Rebuild the fare snapshot from the frozen stop timeline.
          const seq = old.stopSnapshot as unknown as TripStop[];
          await tx.tripFare.deleteMany({ where: { tripId: id } });
          await tx.tripFare.createMany({
            data: buildFareMatrix(seq, data.fare).map((f) => ({ ...f, tripId: id })),
          });
        }
        result = await tx.trip.update({ where: { id }, data: { ...data, departure, arrival, bookingOpensAt, bookingClosesAt } });
        if (data.status === 'CANCELLED') {
          await tx.tripDriverAssignment.updateMany({
            where: { tripId: id, endedAt: null },
            data: { endedAt: new Date() },
          });
        } else if (old.assignments[0]?.driverId !== driverId) {
          await tx.tripDriverAssignment.updateMany({
            where: { tripId: id, endedAt: null },
            data: { endedAt: new Date() },
          });
          await tx.tripDriverAssignment.create({
            data: { tripId: id, driverId, startsAt: departure, endsAt: arrival },
          });
        }
      } else {
        if (data.status !== 'SCHEDULED')
          throw new ApiError(400, 'New trips must start as SCHEDULED.');
        if (departure <= new Date()) throw new ApiError(400, 'Schedule a future departure.');
        const { seq, matrix } = await timeline(tx, r.id, v.type, data.fare);
        result = await tx.trip.create({
          data: {
            ...data,
            operatorId: v.operatorId,
            departure,
            arrival,
            bookingOpensAt,
            bookingClosesAt,
            stopSnapshot: seq as unknown as Prisma.InputJsonValue,
            segmentCount: seq.length - 1,
            tripFares: { create: matrix },
            seats: { create: v.seats.map((s) => ({ vehicleSeatId: s.id })) },
            assignments: { create: { driverId, startsAt: departure, endsAt: arrival } },
          },
        });
      }
    }
    await tx.auditLog.create({
      data: {
        actorId,
        action: (patch ? 'UPDATE_' : 'CREATE_') + resource,
        targetId: result.id,
        operatorId: tenant,
        details: { resource },
      },
    });
    return result;
  });
}
const BOOKING_STATUSES = ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'PAYMENT_RECONCILIATION_REQUIRED'] as const;
const TRIP_STATUSES = ['SCHEDULED', 'BOARDING', 'DEPARTED', 'COMPLETED', 'CANCELLED'] as const;
const pick = <T extends string>(all: readonly T[], v?: string) => (all as readonly string[]).includes(v ?? '') ? (v as T) : undefined;
const like = (q: string) => ({ contains: q, mode: 'insensitive' as const });
export async function list(resource: string, page: number, scope: Scope = null, filters: { q?: string; status?: string } = {}) {
  const q = filters.q;
  if (
    scope &&
    !tenantOnly.has(resource) &&
    !['bookings', 'payments', 'locations'].includes(resource)
  )
    throw new ApiError(403, 'Access denied.');
  const args = { skip: (page - 1) * 25, take: 26 };
  const t = own(scope);
  switch (resource) {
    case 'vehicles':
      return db.vehicle.findMany({
        ...args,
        where: { ...t, ...(q ? { OR: [{ name: like(q) }, { registration: like(q) }, { type: like(q) }] } : {}) },
        include: { seats: { orderBy: [{ row: 'asc' }, { column: 'asc' }] }, images: true },
      });
    case 'drivers':
      return db.driver.findMany({
        ...args,
        where: { ...t, ...(q ? { OR: [{ name: like(q) }, { email: like(q) }, { mobile: { contains: q } }, { licenseNumber: like(q) }] } : {}) },
        select: {
          id: true,
          name: true,
          email: true,
          mobile: true,
          licenseNumber: true,
          licenseExpiry: true,
          active: true,
          emergencyContact: true,
          address: true,
          photoKey: true,
        },
      });
    case 'locations':
      return db.location.findMany({ ...args, where: q ? { name: like(q) } : {}, orderBy: { name: 'asc' } });
    case 'routes':
      return db.route.findMany({
        ...args,
        where: { ...t, ...(q ? { OR: [{ origin: { name: like(q) } }, { destination: { name: like(q) } }] } : {}) },
        include: { origin: true, destination: true, stops: true },
      });
    case 'fares':
      return db.routeFare.findMany({
        ...args,
        where: scope ? { route: t } : {},
        include: { route: { include: { origin: true, destination: true } } },
      });
    case 'trips':
      return db.trip.findMany({
        ...args,
        where: {
          ...t,
          status: pick(TRIP_STATUSES, filters.status),
          ...(q ? { OR: [{ vehicle: { name: like(q) } }, { vehicle: { registration: like(q) } }, { route: { origin: { name: like(q) } } }, { route: { destination: { name: like(q) } } }] } : {}),
        },
        orderBy: { departure: 'desc' },
        include: {
          vehicle: true,
          route: { include: { origin: true, destination: true } },
          assignments: {
            where: { endedAt: null },
            select: { driverId: true, driver: { select: { name: true } } },
          },
        },
      });
    case 'payment-qr':
      return db.paymentQR.findMany({ ...args, where: t });
    case 'settings':
      return [await db.settings.upsert({ where: { id: 'global' }, create: {}, update: {} })];
    case 'bookings':
      return db.booking.findMany({
        ...args,
        where: {
          ...t,
          status: pick(BOOKING_STATUSES, filters.status),
          ...(q ? { OR: [{ reference: like(q) }, { customer: { name: like(q) } }, { customer: { phone: { contains: q } } }] } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          reference: true,
          status: true,
          amount: true,
          expiresAt: true,
          customer: true,
          payment: true,
          cancellation: { select: { refundStatus: true } },
          trip: {
            include: { vehicle: true, route: { include: { origin: true, destination: true } } },
          },
          seats: { include: { tripSeat: { include: { vehicleSeat: true } } } },
        },
      });
    case 'payments':
      return db.payment.findMany({
        ...args,
        where: scope ? { booking: t } : {},
        orderBy: { booking: { createdAt: 'desc' } },
        include: {
          proofs: true,
          booking: {
            select: {
              id: true,
              reference: true,
              amount: true,
              status: true,
              expiresAt: true,
              customer: true,
              trip: {
                include: { vehicle: true, route: { include: { origin: true, destination: true } } },
              },
              seats: { include: { tripSeat: { include: { vehicleSeat: true } } } },
            },
          },
        },
      });
    default:
      throw new ApiError(404, 'Unknown module.');
  }
}
const LABEL: Record<string, string> = {
  vehicles: 'vehicle',
  drivers: 'driver',
  locations: 'location',
  routes: 'route',
  fares: 'fare',
  'payment-qr': 'payment account',
  trips: 'trip',
};
/**
 * Deletes a record that nothing depends on. Anything referenced by trips, bookings or payments is
 * refused with a 409 so history stays intact; mark those inactive instead. Every deletion is audited.
 */
export async function remove(resource: string, id: string, actorId: string, scope: Scope = null) {
  if (!(resource in LABEL)) throw new ApiError(404, 'Unknown module.');
  if (scope && !tenantOnly.has(resource)) throw new ApiError(403, 'Access denied.');
  const gone = () => new ApiError(404, 'Record not found.');
  const inUse = (what: string) =>
    new ApiError(409, `This ${LABEL[resource]} is still used by ${what}. Mark it inactive instead of deleting it.`);
  return serial(async (tx) => {
    let operatorId: string | null = null;
    if (resource === 'vehicles') {
      const v = await tx.vehicle.findFirst({ where: { id, ...own(scope) }, include: { _count: { select: { trips: true } } } });
      if (!v) throw gone();
      if (v._count.trips) throw inUse('trips');
      await tx.vehicleImage.deleteMany({ where: { vehicleId: id } });
      await tx.vehicleSeat.deleteMany({ where: { vehicleId: id } });
      await tx.vehicle.delete({ where: { id } });
      operatorId = v.operatorId;
    } else if (resource === 'drivers') {
      const d = await tx.driver.findFirst({
        where: { id, ...own(scope) },
        include: {
          _count: { select: { assignments: true, checkIns: true } },
          tenant: { include: { _count: { select: { vehicles: true, routes: true, trips: true, bookings: true, drivers: true, paymentQRs: true, seatLayouts: true } } } },
        },
      });
      if (!d) throw gone();
      if (d._count.assignments || d._count.checkIns) throw inUse('trip assignments');
      const held = d.tenant._count;
      if (held.drivers === 1 && (held.vehicles || held.routes || held.trips || held.paymentQRs || held.seatLayouts || held.bookings))
        throw inUse('vehicles, routes or payment accounts');
      await tx.session.deleteMany({ where: { driverId: id } });
      await tx.driver.delete({ where: { id } });
      // The private internal record goes with its only driver.
      if (held.drivers === 1) {
        await tx.operatorSettings.deleteMany({ where: { operatorId: d.operatorId } });
        await tx.operator.delete({ where: { id: d.operatorId } });
      } else operatorId = d.operatorId;
    } else if (resource === 'locations') {
      const l = await tx.location.findUnique({
        where: { id },
        include: { _count: { select: { origins: true, destinations: true, stops: true, points: true } } },
      });
      if (!l) throw gone();
      const c = l._count;
      if (c.origins || c.destinations || c.stops || c.points) throw inUse('routes');
      await tx.location.delete({ where: { id } });
    } else if (resource === 'routes') {
      const r = await tx.route.findFirst({ where: { id, ...own(scope) }, include: { _count: { select: { trips: true } } } });
      if (!r) throw gone();
      if (r._count.trips) throw inUse('trips');
      await tx.routeStop.deleteMany({ where: { routeId: id } });
      await tx.boardingPoint.deleteMany({ where: { routeId: id } });
      await tx.routeSegmentFare.deleteMany({ where: { routeId: id } });
      await tx.routeFare.deleteMany({ where: { routeId: id } });
      await tx.route.delete({ where: { id } });
      operatorId = r.operatorId;
    } else if (resource === 'fares') {
      const f = await tx.routeFare.findFirst({
        where: { id, ...(scope ? { route: { operatorId: scope } } : {}) },
        include: { route: { select: { operatorId: true } } },
      });
      if (!f) throw gone();
      await tx.routeFare.delete({ where: { id } });
      operatorId = f.route.operatorId;
    } else if (resource === 'payment-qr') {
      const q = await tx.paymentQR.findFirst({
        where: { id, ...own(scope) },
        include: { _count: { select: { trips: true, payments: true } } },
      });
      if (!q) throw gone();
      if (q._count.trips || q._count.payments) throw inUse('trips or payments');
      await tx.paymentQR.delete({ where: { id } });
      operatorId = q.operatorId;
    } else {
      const t = await tx.trip.findFirst({ where: { id, ...own(scope) }, include: { _count: { select: { bookings: true } } } });
      if (!t) throw gone();
      if (t._count.bookings) throw new ApiError(409, 'A trip with bookings cannot be deleted. Cancel it instead.');
      await tx.tripDriverAssignment.deleteMany({ where: { tripId: id } });
      await tx.tripSeat.deleteMany({ where: { tripId: id } });
      await tx.tripFare.deleteMany({ where: { tripId: id } });
      await tx.trip.delete({ where: { id } });
      operatorId = t.operatorId;
    }
    await tx.auditLog.create({
      data: { actorId, action: 'DELETE_' + resource, targetId: id, operatorId, details: { resource } },
    });
    return { ok: true, id };
  });
}
