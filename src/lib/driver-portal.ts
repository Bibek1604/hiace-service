import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { cookies } from 'next/headers';
import { db } from './db';
import { ApiError, hash } from './security';
import { hashPassword, verifyPassword } from './password';
import { remove, save } from './admin';
import { cancelTrip, tripTransitionAllowed } from './cancellations';
import { reserve, review, serial } from './bookings';
import { seatStateFor, type TripStop } from './inventory';
import { archiveLayout, createLayout, publishLayout } from './layouts';
import { buildSequence, validateSequence } from './route-stops';
import { saveSegmentFare } from './segment-fares';
import { gridSchema, TEMPLATES, validateLayout, type Grid } from './seat-layout';

const text = z.string().trim().min(1).max(250),
  phone = z.string().trim().regex(/^\+?\d{7,15}$/, 'Enter a phone number of 7 to 15 digits.'),
  count = z.coerce.number().int().positive().max(100000),
  place = z.string().trim().min(1).max(120);

export const VEHICLE_TYPES = ['Bus', 'Deluxe Bus', 'Hiace', 'Jeep', 'Car'] as const;
const newPassword = z.string().min(12, 'Use at least 12 characters.').max(128);

const vehicleInput = z.object({
  name: text,
  registration: text,
  type: z.enum(VEHICLE_TYPES),
  description: z.string().trim().max(5000).default(''),
  amenities: z.array(text).max(30).default([]),
  emergencyContact: phone,
  maintenanceNote: z.string().trim().max(1000).default(''),
  imageKeys: z.array(text).max(12).default([]),
  /** Seat plan of a new vehicle. A registered vehicle keeps its seats, because bookings refer to them. */
  grid: gridSchema.optional(),
});
const routeInput = z.object({
  origin: place,
  destination: place,
  distanceKm: count,
  durationMinutes: count,
  baseFare: z.coerce.number().int().positive().max(10_000_000),
  vehicleType: z.enum(VEHICLE_TYPES).default('Bus'),
  stops: z
    .array(
      z.object({
        name: place,
        offsetMinutes: count,
        kmFromOrigin: count,
        allowBoarding: z.boolean().default(true),
        allowDropoff: z.boolean().default(true),
      }),
    )
    .max(20)
    .default([]),
  /** Prices for part of the route. A leg left out is priced by distance. */
  legFares: z
    .array(z.object({ from: place, to: place, amount: z.coerce.number().int().positive().max(10_000_000) }))
    .max(200)
    .default([]),
});
const qrInput = z.object({
  label: text,
  accountName: text,
  accountNumber: z.string().trim().max(100).optional(),
  imageKey: text,
  instructions: z.string().trim().min(1).max(3000),
  isDefault: z.boolean().default(false),
});
const submission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vehicles'), targetId: z.string().min(1).optional(), payload: vehicleInput }),
  z.object({ kind: z.literal('routes'), targetId: z.string().min(1).optional(), payload: routeInput }),
  z.object({ kind: z.literal('payment-qr'), targetId: z.string().min(1).optional(), payload: qrInput }),
]);
type VehiclePayload = z.infer<typeof vehicleInput>;
type RoutePayload = z.infer<typeof routeInput>;
type QrPayload = z.infer<typeof qrInput>;

const key = (name: string) => name.trim().toLowerCase();
const slugPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'driver';

/** Every driver gets a private internal operator that owns their vehicles, routes and bookings. */
export async function createOwnerDriver(raw: unknown, actorId: string) {
  const name = text.parse((raw as { name?: unknown } | null)?.name);
  const email = z.email().parse((raw as { email?: unknown } | null)?.email).toLowerCase();
  if (await db.driver.findUnique({ where: { email } })) throw new ApiError(409, 'That driver email is already in use.');
  const op = await db.operator.create({
    data: {
      name,
      slug: `${slugPart(name)}-${crypto.randomUUID().slice(0, 8)}`,
      contactName: name,
      contactEmail: email,
      status: 'ACTIVE',
      settings: { create: {} },
    },
  });
  try {
    return await save('drivers', raw, actorId, false, op.id);
  } catch (e) {
    // The company exists only for this driver, so it must not outlive a refused form.
    await db.operatorSettings.deleteMany({ where: { operatorId: op.id } });
    await db.operator.delete({ where: { id: op.id } });
    throw e;
  }
}

async function me(driverId: string) {
  const d = await db.driver.findUnique({ where: { id: driverId }, include: { tenant: true } });
  if (!d) throw new ApiError(401, 'Please sign in.');
  return d;
}
export async function getProfile(driverId: string) {
  const d = await me(driverId);
  return {
    name: d.name,
    email: d.email,
    mobile: d.mobile,
    address: d.address ?? '',
    emergencyContact: d.emergencyContact,
    photoKey: d.photoKey,
    licenseNumber: d.licenseNumber,
    licenseExpiry: d.licenseExpiry,
  };
}

const profileInput = z.object({
  name: text,
  mobile: phone,
  emergencyContact: phone,
  address: z.string().trim().max(500).default(''),
  photoKey: z.string().min(1).nullable().optional(),
});
export async function updateProfile(driverId: string, raw: unknown) {
  const d = profileInput.parse(raw);
  const current = await me(driverId);
  if (d.photoKey && d.photoKey !== current.photoKey) await assertUpload(d.photoKey, 'driver', driverId);
  await db.driver.update({ where: { id: driverId }, data: d });
  await db.auditLog.create({
    data: { actorId: driverId, operatorId: current.operatorId, action: 'DRIVER_UPDATED_PROFILE', targetId: driverId, details: {} },
  });
  return getProfile(driverId);
}

/** Ends every other session, so a stolen sign-in stops working once the password changes. */
export async function changePassword(driverId: string, raw: unknown) {
  const d = z.object({ current: z.string().min(1).max(128), next: newPassword }).parse(raw);
  const user = await me(driverId);
  if (!(await verifyPassword(d.current, user.passwordHash)).ok)
    throw new ApiError(400, 'Your current password is not correct.');
  const passwordHash = await hashPassword(d.next);
  const secret = (await cookies()).get('staff_session')?.value;
  await db.$transaction([
    db.driver.update({ where: { id: driverId }, data: { passwordHash } }),
    db.session.deleteMany({ where: { driverId, id: { not: hash(secret ?? '') } } }),
    db.auditLog.create({
      data: { actorId: driverId, operatorId: user.operatorId, action: 'DRIVER_CHANGED_PASSWORD', targetId: driverId, details: {} },
    }),
  ]);
  return { ok: true };
}

/** A driver may only attach images they uploaded themselves. */
async function assertUpload(id: string, purpose: string, driverId: string) {
  if (!(await db.storedObject.findFirst({ where: { id, purpose, ownerId: driverId }, select: { id: true } })))
    throw new ApiError(400, 'Upload the image first.');
}

export async function fleet(driverId: string) {
  const d = await me(driverId);
  const where = { operatorId: d.operatorId };
  const [vehicles, routes, qrs, submissions, locations] = await Promise.all([
    db.vehicle.findMany({
      where,
      include: { images: { orderBy: { position: 'asc' } }, _count: { select: { seats: true } } },
      orderBy: { name: 'asc' },
    }),
    db.route.findMany({
      where,
      include: {
        origin: true,
        destination: true,
        stops: { orderBy: { position: 'asc' }, include: { location: true } },
        segmentFares: true,
      },
    }),
    db.paymentQR.findMany({ where, orderBy: [{ isDefault: 'desc' }, { label: 'asc' }] }),
    db.driverSubmission.findMany({ where: { driverId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.location.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
  ]);
  return {
    vehicles,
    routes,
    qrs,
    // Legacy submissions are retained in the database for audit history only and are never shown to drivers.
    submissions: submissions.filter(() => false),
    locations: locations.map((l) => l.name),
    vehicleTypes: VEHICLE_TYPES,
    templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, vehicleType: t.vehicleType, grid: t.build() })),
  };
}

async function owns(kind: string, id: string, operatorId: string) {
  const where = { id, operatorId };
  const found =
    kind === 'vehicles'
      ? await db.vehicle.findFirst({ where, select: { id: true } })
      : kind === 'routes'
        ? await db.route.findFirst({ where, select: { id: true } })
        : await db.paymentQR.findFirst({ where, select: { id: true } });
  if (!found) throw new ApiError(404, 'Record not found.');
}

function checkRoute(p: RoutePayload) {
  if (key(p.origin) === key(p.destination)) throw new ApiError(400, 'The start and end must be different places.');
  const problems = validateSequence(
    buildSequence(
      { originId: key(p.origin), destinationId: key(p.destination), durationMinutes: p.durationMinutes, distanceKm: p.distanceKm },
      p.stops.map(({ name, ...s }) => ({ ...s, locationId: key(name) })),
    ),
  );
  if (problems.length) throw new ApiError(400, problems.join(' '));
  const order = [p.origin, ...p.stops.map((s) => s.name), p.destination].map(key);
  for (const leg of p.legFares) {
    const a = order.indexOf(key(leg.from)),
      b = order.indexOf(key(leg.to));
    if (a < 0 || b <= a) throw new ApiError(400, `${leg.from} to ${leg.to} is not part of this route.`);
    if (a === 0 && b === order.length - 1) throw new ApiError(400, 'The full-route price is the route price.');
  }
}

export async function submit(driverId: string, raw: unknown) {
  const d = await me(driverId);
  const s = submission.parse(raw);
  if (s.targetId) await owns(s.kind, s.targetId, d.operatorId);
  if (s.kind === 'vehicles') {
    if (s.targetId && s.payload.grid) throw new ApiError(409, 'A registered vehicle keeps its seat layout.');
    if (!s.targetId) {
      if (!s.payload.grid) throw new ApiError(400, 'Set up the seats of this vehicle.');
      const issues = validateLayout(s.payload.grid as Grid);
      if (issues.length) throw new ApiError(422, issues.map((i) => i.message).join(' '));
    }
    const saved = s.targetId
      ? (await db.vehicleImage.findMany({ where: { vehicleId: s.targetId }, select: { key: true } })).map((i) => i.key)
      : [];
    for (const image of s.payload.imageKeys) if (!saved.includes(image)) await assertUpload(image, 'vehicle', driverId);
  } else if (s.kind === 'routes') checkRoute(s.payload);
  else {
    const old = s.targetId ? await db.paymentQR.findUnique({ where: { id: s.targetId } }) : null;
    if (s.payload.imageKey !== old?.imageKey) await assertUpload(s.payload.imageKey, 'qr', driverId);
  }
  // Driver changes are live straight away, but retain an auditable submission that an admin can
  // later deactivate, reject, or reactivate from the driver-requests screen.
  const claim: Claimed = { id: crypto.randomUUID(), driverId, operatorId: d.operatorId, kind: s.kind, targetId: s.targetId ?? null };
  const applied =
    s.kind === 'vehicles'
      ? await applyVehicle(claim, s.payload, driverId)
      : s.kind === 'routes'
        ? await applyRoute(claim, s.payload, driverId)
        : await applyQr(claim, s.payload, driverId);
  await db.driverSubmission.create({
    data: {
      id: claim.id,
      driverId,
      operatorId: d.operatorId,
      kind: s.kind,
      targetId: applied.id,
      payload: s.payload,
      status: 'APPROVED',
      reviewNote: 'Automatically approved when submitted.',
      reviewedAt: new Date(),
    },
  });
  return applied;
}

export async function withdraw(driverId: string, id: string) {
  const { count: removed } = await db.driverSubmission.deleteMany({ where: { id, driverId, status: 'PENDING' } });
  if (!removed) throw new ApiError(404, 'Request not found.');
  return { ok: true, id };
}

/** Deletes only an unused record in the driver's operator scope; referenced history is never removed. */
export async function deleteOwnResource(driverId: string, kind: 'vehicles' | 'routes' | 'payment-qr', id: string) {
  const d = await me(driverId);
  return remove(kind, id, driverId, d.operatorId);
}

const tripInput = z.object({
  vehicleId: z.string().min(1),
  routeId: z.string().min(1),
  paymentQRId: z.string().min(1).optional(),
  /** `departure` is retained for existing callers; publishing can submit several dated departures. */
  departure: z.iso.datetime().optional(),
  departures: z.array(z.iso.datetime()).min(1).max(100).optional(),
  arrival: z.iso.datetime().optional(),
  bookingOpensAt: z.iso.datetime().optional(),
  bookingClosesAt: z.iso.datetime().optional(),
  /** Repeats are measured in whole hours; each occurrence is an independent, auditable trip. */
  recurringEveryHours: z.coerce.number().int().min(1).max(24 * 31).optional(),
  recurringOccurrences: z.coerce.number().int().min(2).max(100).optional(),
  boardingPoint: z.string().trim().max(250).optional(),
  dropPoint: z.string().trim().max(250).optional(),
}).refine((value) => !!value.departure || !!value.departures?.length, 'Choose at least one departure date and time.');

const schedulePlan = z.object({
  routeId: z.string().min(1),
  vehicleId: z.string().min(1),
  paymentQRId: z.string().min(1),
  departureTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour departure time.'),
  fare: z.coerce.number().int().positive().max(10_000_000).optional(),
  boardingPoint: z.string().trim().max(250).optional(),
  dropPoint: z.string().trim().max(250).optional(),
});
const scheduleInput = z.object({
  startsOn: z.string().date(),
  endsOn: z.string().date(),
  plans: z.array(schedulePlan).min(1).max(12),
}).refine((value) => value.endsOn >= value.startsOn, 'End date must be on or after the start date.');
const scheduleControl = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('extend'), endsOn: z.string().date() }),
]);

const activeTripStatuses = ['SCHEDULED', 'BOARDING', 'DEPARTED'] as const;
const dateRange = (startsOn: Date, endsOn: Date) => {
  const out: string[] = [];
  for (let cursor = new Date(startsOn.getTime()); cursor <= endsOn; cursor.setUTCDate(cursor.getUTCDate() + 1))
    out.push(cursor.toISOString().slice(0, 10));
  return out;
};
const nepalDeparture = (date: string, minutes: number) => {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return new Date(`${date}T${hour}:${minute}:00+05:45`);
};
const dayValue = (date: string) => new Date(`${date}T00:00:00.000Z`);

async function assertTripWindowFree(driverId: string, vehicleId: string, departure: Date, arrival: Date) {
  const clash = await db.trip.findFirst({
    where: {
      status: { in: [...activeTripStatuses] },
      departure: { lt: arrival },
      arrival: { gt: departure },
      OR: [{ vehicleId }, { assignments: { some: { driverId, endedAt: null } } }],
    },
    select: { id: true },
  });
  if (clash) throw new ApiError(409, 'This vehicle or driver already has an overlapping trip.');
}

async function scheduleTrips(driverId: string, scheduleId: string, onlyAfter?: Date) {
  const schedule = await db.tripSchedule.findUnique({
    where: { id: scheduleId },
    include: { route: { include: { origin: true, destination: true } } },
  });
  if (!schedule) throw new ApiError(404, 'Schedule not found.');
  const dates = dateRange(schedule.startsOn, schedule.endsOn).filter((date) => {
    const departure = nepalDeparture(date, schedule.departureMinutes);
    return departure > new Date() && (!onlyAfter || departure > onlyAfter);
  });
  const candidates = dates.map((date) => {
    const departure = nepalDeparture(date, schedule.departureMinutes);
    return { date, departure, arrival: new Date(departure.getTime() + schedule.route.durationMinutes * 60000) };
  });
  for (const candidate of candidates)
    await assertTripWindowFree(driverId, schedule.vehicleId, candidate.departure, candidate.arrival);
  const created = [];
  for (const { date, departure, arrival } of candidates) {
    const existing = await db.trip.findFirst({ where: { scheduleId, departure }, select: { id: true } });
    if (existing) continue;
    created.push(
      await save('trips', {
        vehicleId: schedule.vehicleId,
        routeId: schedule.routeId,
        paymentQRId: schedule.paymentQRId,
        driverId,
        departure: departure.toISOString(),
        arrival: arrival.toISOString(),
        boardingPoint: schedule.boardingPoint || schedule.route.origin.name,
        dropPoint: schedule.dropPoint || schedule.route.destination.name,
        fare: schedule.fare,
        bookingOpen: schedule.status === 'PUBLISHED',
        bookingOpensAt: new Date().toISOString(),
        bookingClosesAt: departure.toISOString(),
        scheduleId,
        recurringRule: JSON.stringify({ scheduleId, date }),
        status: 'SCHEDULED',
      }, driverId, false, schedule.operatorId),
    );
  }
  return created;
}

/** Publish selected existing routes as independent daily trips without duplicating route records. */
export async function createOwnSchedules(driverId: string, raw: unknown) {
  const driver = await me(driverId);
  const input = scheduleInput.parse(raw);
  const startsOn = dayValue(input.startsOn), endsOn = dayValue(input.endsOn);
  if (dateRange(startsOn, endsOn).length > 366) throw new ApiError(400, 'A schedule can cover at most 366 days.');
  const batchId = crypto.randomUUID();
  const schedules = [];
  for (const plan of input.plans) {
    const [route, vehicle, qr] = await Promise.all([
      db.route.findFirst({ where: { id: plan.routeId, operatorId: driver.operatorId, active: true }, include: { origin: true, destination: true } }),
      db.vehicle.findFirst({ where: { id: plan.vehicleId, operatorId: driver.operatorId, active: true } }),
      db.paymentQR.findFirst({ where: { id: plan.paymentQRId, operatorId: driver.operatorId, active: true } }),
    ]);
    if (!route || !vehicle || !qr) throw new ApiError(400, 'Choose active routes, vehicles, and payment accounts that belong to you.');
    const [hours, minutes] = plan.departureTime.split(':').map(Number);
    const departureMinutes = hours * 60 + minutes;
    const candidateDeparture = nepalDeparture(input.startsOn, departureMinutes);
    const candidateArrival = new Date(candidateDeparture.getTime() + route.durationMinutes * 60000);
    await assertTripWindowFree(driverId, vehicle.id, candidateDeparture, candidateArrival);
    const schedule = await db.tripSchedule.create({
      data: {
        batchId,
        operatorId: driver.operatorId,
        driverId,
        vehicleId: vehicle.id,
        routeId: route.id,
        paymentQRId: qr.id,
        fare: plan.fare ?? route.baseFare,
        departureMinutes,
        startsOn,
        endsOn,
        boardingPoint: plan.boardingPoint || route.origin.name,
        dropPoint: plan.dropPoint || route.destination.name,
        status: 'PUBLISHED',
      },
    });
    try {
      const trips = await scheduleTrips(driverId, schedule.id);
      schedules.push({ ...schedule, created: trips.length });
    } catch (error) {
      await db.tripSchedule.delete({ where: { id: schedule.id } });
      throw error;
    }
  }
  await db.auditLog.create({ data: { actorId: driverId, operatorId: driver.operatorId, action: 'PUBLISH_TRIP_SCHEDULES', targetId: batchId, details: { schedules: schedules.length, startsOn: input.startsOn, endsOn: input.endsOn } } });
  return { batchId, schedules, created: schedules.reduce((total, schedule) => total + schedule.created, 0) };
}

export async function ownSchedules(driverId: string) {
  const driver = await me(driverId);
  return db.tripSchedule.findMany({
    where: { driverId, operatorId: driver.operatorId },
    include: { route: { include: { origin: true, destination: true } }, vehicle: { select: { name: true, registration: true } }, trips: { where: { departure: { gte: new Date() } }, select: { id: true, departure: true, status: true, bookings: { where: { status: { in: ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED'] } }, select: { id: true } } }, orderBy: { departure: 'asc' } } },
    orderBy: { startsOn: 'asc' },
    take: 100,
  });
}

export async function controlOwnSchedule(driverId: string, scheduleId: string, raw: unknown) {
  const driver = await me(driverId);
  const input = scheduleControl.parse(raw);
  const schedule = await db.tripSchedule.findFirst({ where: { id: scheduleId, driverId, operatorId: driver.operatorId } });
  if (!schedule) throw new ApiError(404, 'Schedule not found.');
  const future = { scheduleId, departure: { gt: new Date() }, status: 'SCHEDULED' as const };
  if (input.action === 'pause') {
    if (schedule.status !== 'PUBLISHED') throw new ApiError(409, 'Only published schedules can be paused.');
    await db.$transaction([db.tripSchedule.update({ where: { id: scheduleId }, data: { status: 'PAUSED' } }), db.trip.updateMany({ where: future, data: { bookingOpen: false } })]);
  } else if (input.action === 'resume') {
    if (schedule.status !== 'PAUSED') throw new ApiError(409, 'Only paused schedules can be resumed.');
    await db.$transaction([db.tripSchedule.update({ where: { id: scheduleId }, data: { status: 'PUBLISHED' } }), db.trip.updateMany({ where: future, data: { bookingOpen: true } })]);
  } else if (input.action === 'extend') {
    const endsOn = dayValue(input.endsOn);
    if (endsOn <= schedule.endsOn) throw new ApiError(400, 'Choose a later end date.');
    if (dateRange(schedule.startsOn, endsOn).length > 366) throw new ApiError(400, 'A schedule can cover at most 366 days.');
    await db.tripSchedule.update({ where: { id: scheduleId }, data: { endsOn } });
    try { await scheduleTrips(driverId, scheduleId, schedule.endsOn); } catch (error) { await db.tripSchedule.update({ where: { id: scheduleId }, data: { endsOn: schedule.endsOn } }); throw error; }
  } else {
    if (schedule.status === 'CANCELLED') throw new ApiError(409, 'This schedule is already cancelled.');
    const booked = await db.trip.findFirst({ where: { ...future, bookings: { some: { status: { in: ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED'] } } } }, select: { id: true } });
    if (booked) throw new ApiError(409, 'A future trip has bookings. Cancel it individually through admin so passengers are protected.');
    await db.$transaction([db.tripSchedule.update({ where: { id: scheduleId }, data: { status: 'CANCELLED' } }), db.trip.updateMany({ where: future, data: { status: 'CANCELLED', bookingOpen: false } })]);
  }
  await db.auditLog.create({ data: { actorId: driverId, operatorId: driver.operatorId, action: 'DRIVER_' + input.action.toUpperCase() + '_SCHEDULE', targetId: scheduleId, details: input } });
  return ownSchedules(driverId);
}
/** A driver creates departures using their own approved-in-the-safety-sense (validated) resources. */
export async function createOwnTrip(driverId: string, raw: unknown) {
  const d = await me(driverId);
  const t = tripInput.parse(raw);
  const route = await db.route.findFirst({
    where: { id: t.routeId, operatorId: d.operatorId },
    include: { origin: true, destination: true },
  });
  if (!route) throw new ApiError(404, 'Route not found.');
  const qr = t.paymentQRId
    ? await db.paymentQR.findFirst({ where: { id: t.paymentQRId, operatorId: d.operatorId, active: true } })
    : await db.paymentQR.findFirst({ where: { operatorId: d.operatorId, active: true, isDefault: true } });
  if (!qr) throw new ApiError(400, 'Choose an active payment QR or mark one as the default.');
  if ((t.recurringEveryHours && !t.recurringOccurrences) || (!t.recurringEveryHours && t.recurringOccurrences))
    throw new ApiError(400, 'Choose both a repeat interval in hours and a number of departures.');
  if (t.departures && t.recurringEveryHours)
    throw new ApiError(400, 'Choose individual departures or a repeating interval, not both.');
  const repeat = t.recurringEveryHours ? { everyHours: t.recurringEveryHours, occurrences: t.recurringOccurrences! } : null;
  const departures = t.departures ?? [t.departure!];
  const dates = repeat
    ? Array.from({ length: repeat.occurrences }, (_, occurrence) => new Date(new Date(departures[0]).getTime() + occurrence * repeat.everyHours * 3600000))
    : departures.map((value) => new Date(value));
  const createAt = async (departure: Date) => {
    const arrival = t.arrival && dates.length === 1 ? new Date(t.arrival) : new Date(departure.getTime() + route.durationMinutes * 60000);
    if (arrival <= departure) throw new ApiError(400, 'Arrival must follow departure.');
    const opens = t.bookingOpensAt && dates.length === 1 ? new Date(t.bookingOpensAt) : new Date();
    const closes = t.bookingClosesAt && dates.length === 1 ? new Date(t.bookingClosesAt) : departure;
    if (opens >= closes || closes > departure) throw new ApiError(400, 'Booking must open before it closes, and close no later than departure.');
    return save('trips', {
      vehicleId: t.vehicleId,
      routeId: route.id,
      paymentQRId: qr.id,
      driverId,
      departure: departure.toISOString(),
      arrival: arrival.toISOString(),
      boardingPoint: t.boardingPoint || route.origin.name,
      dropPoint: t.dropPoint || route.destination.name,
      fare: route.baseFare,
      bookingOpen: true,
      bookingOpensAt: opens.toISOString(),
      bookingClosesAt: closes.toISOString(),
      ...(repeat ? { recurringRule: JSON.stringify(repeat) } : {}),
      status: 'SCHEDULED',
    }, driverId, false, d.operatorId);
  };
  const items = [];
  for (const departure of dates) items.push(await createAt(departure));
  return items.length > 1 ? { ...items[0], published: { created: items.length }, items } : items[0];
}

/** Passengers with money at stake go through the admin, who also handles any refunds. */
export async function cancelOwnTrip(driverId: string, tripId: string, raw: unknown) {
  const d = await me(driverId);
  const trip = await db.trip.findFirst({
    where: { id: tripId, operatorId: d.operatorId, assignments: { some: { driverId, endedAt: null } } },
    select: { id: true },
  });
  if (!trip) throw new ApiError(404, 'Trip not found.');
  const active = await db.booking.count({ where: { tripId, status: { in: ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED'] } } });
  if (active) throw new ApiError(409, 'This trip has bookings. Ask the admin to cancel it so passengers can be refunded.');
  return cancelTrip(tripId, driverId, raw, d.operatorId, false);
}

/** Booking operations are deliberately limited to trips currently assigned to this driver. */
async function ownAssignment(driverId: string, tripId: string) {
  const assignment = await db.tripDriverAssignment.findFirst({
    where: { driverId, tripId, endedAt: null },
    include: { trip: { select: { id: true, operatorId: true, status: true, bookingOpen: true, departure: true } } },
  });
  if (!assignment) throw new ApiError(404, 'Assigned trip not found.');
  return assignment;
}

const bookingFilter = z.object({
  tripId: z.string().min(1).optional(),
  status: z.enum(['HELD', 'PAYMENT_REVIEW', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'PAYMENT_RECONCILIATION_REQUIRED']).optional(),
});

/** Driver-facing booking history, including pending payment evidence, never crosses trip assignments. */
export async function ownBookings(driverId: string, raw: unknown) {
  const filter = bookingFilter.parse(raw);
  const d = await me(driverId);
  return db.booking.findMany({
    where: {
      operatorId: d.operatorId,
      ...(filter.tripId ? { tripId: filter.tripId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      trip: { assignments: { some: { driverId, endedAt: null } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, reference: true, status: true, amount: true, fareSnapshot: true, expiresAt: true, createdAt: true,
      fromIdx: true, toIdx: true,
      customer: { select: { name: true, phone: true, email: true } },
      trip: { select: { id: true, departure: true, status: true, vehicle: { select: { name: true, registration: true } }, route: { select: { origin: true, destination: true } } } },
      seats: { where: { active: true }, select: { tripSeat: { select: { vehicleSeat: { select: { label: true } } } } } },
      passengers: { select: { name: true, seatLabel: true, boardingPoint: true, destination: true } },
      payment: { select: { id: true, status: true, claimedAmount: true, transactionRef: true, note: true, proofs: { select: { id: true, imageKey: true, remarks: true, createdAt: true } } } },
    },
  });
}

/** Completed and past departures stay available to their assigned driver for operational history. */
export async function driverHistory(driverId: string) {
  const d = await me(driverId);
  const now = new Date();
  return db.trip.findMany({
    where: {
      operatorId: d.operatorId,
      assignments: { some: { driverId, endedAt: null } },
      OR: [{ departure: { lte: now } }, { status: { in: ['DEPARTED', 'COMPLETED', 'CANCELLED'] } }],
    },
    include: {
      vehicle: { select: { name: true, registration: true } },
      route: { select: { origin: { select: { name: true } }, destination: { select: { name: true } } } },
      bookings: { select: { id: true, passengers: { select: { id: true } } } },
    },
    orderBy: { departure: 'desc' },
    take: 200,
  });
}

const paymentDecision = z.object({
  action: z.enum(['verify', 'reject', 'clarify']),
  note: z.string().trim().min(3).max(2000),
  bankEvidence: z.string().trim().max(1000).optional(),
  verifiedAmount: z.coerce.number().int().positive().max(10_000_000).optional(),
  confirm: z.boolean().optional(),
  acknowledgeDuplicate: z.boolean().optional(),
});

/** A driver may decide payment only for a booking on one of their assigned trips. */
export async function reviewOwnPayment(driverId: string, paymentId: string, raw: unknown) {
  const d = await me(driverId);
  const input = paymentDecision.parse(raw);
  const payment = await db.payment.findFirst({
    where: { id: paymentId, booking: { operatorId: d.operatorId, trip: { assignments: { some: { driverId, endedAt: null } } } } },
    select: { id: true },
  });
  if (!payment) throw new ApiError(404, 'Payment not found.');
  return review(payment.id, driverId, input, d.operatorId);
}

const tripControl = z.object({
  bookingOpen: z.boolean().optional(),
  status: z.enum(['SCHEDULED', 'BOARDING', 'DEPARTED', 'COMPLETED']).optional(),
  departure: z.iso.datetime().optional(),
  arrival: z.iso.datetime().optional(),
  bookingOpensAt: z.iso.datetime().nullable().optional(),
  bookingClosesAt: z.iso.datetime().nullable().optional(),
}).refine((value) => value.bookingOpen !== undefined || value.status !== undefined || value.departure !== undefined || value.arrival !== undefined || value.bookingOpensAt !== undefined || value.bookingClosesAt !== undefined, 'Choose a trip setting to update.');

/** Changes only operational state; schedules, vehicles, routes and fare snapshots remain immutable. */
export async function updateOwnTrip(driverId: string, tripId: string, raw: unknown) {
  const input = tripControl.parse(raw);
  const assignment = await ownAssignment(driverId, tripId);
  if (assignment.trip.status === 'CANCELLED') throw new ApiError(409, 'A cancelled trip cannot be changed.');
  if (input.status && !tripTransitionAllowed(assignment.trip.status, input.status))
    throw new ApiError(409, `A trip cannot move from ${assignment.trip.status.toLowerCase()} to ${input.status.toLowerCase()}.`);
  if (input.bookingOpen && (assignment.trip.departure <= new Date() || input.status === 'DEPARTED' || input.status === 'COMPLETED'))
    throw new ApiError(409, 'Booking can only be opened before departure.');
  const rescheduling = input.departure !== undefined || input.arrival !== undefined;
  if (rescheduling) {
    if (assignment.trip.status !== 'SCHEDULED') throw new ApiError(409, 'Only scheduled trips can be rescheduled.');
    const activeBookings = await db.booking.count({ where: { tripId, status: { in: ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED'] } } });
    if (activeBookings) throw new ApiError(409, 'Create a replacement trip for passengers who already hold or confirmed seats.');
    const departure = input.departure ? new Date(input.departure) : assignment.trip.departure;
    const arrival = input.arrival ? new Date(input.arrival) : null;
    if (departure <= new Date() || (arrival && arrival <= departure)) throw new ApiError(400, 'Use a future departure and an arrival after departure.');
  }
  return serial(async (tx) => {
    const data = { ...input, ...(input.departure ? { departure: new Date(input.departure) } : {}), ...(input.arrival ? { arrival: new Date(input.arrival) } : {}), ...(input.bookingOpensAt !== undefined ? { bookingOpensAt: input.bookingOpensAt ? new Date(input.bookingOpensAt) : null } : {}), ...(input.bookingClosesAt !== undefined ? { bookingClosesAt: input.bookingClosesAt ? new Date(input.bookingClosesAt) : null } : {}) };
    const updated = await tx.trip.update({ where: { id: tripId }, data });
    if (rescheduling) await tx.tripDriverAssignment.updateMany({ where: { tripId, endedAt: null }, data: { startsAt: updated.departure, endsAt: updated.arrival } });
    await tx.auditLog.create({
      data: { actorId: driverId, operatorId: assignment.trip.operatorId, action: 'DRIVER_UPDATED_TRIP_OPERATIONS', targetId: tripId, details: input },
    });
    return updated;
  });
}

/** Segment-aware availability allows a driver to see actual inventory at every route leg. */
export async function ownTripAvailability(driverId: string, tripId: string) {
  await ownAssignment(driverId, tripId);
  const trip = await db.trip.findUniqueOrThrow({
    where: { id: tripId },
    include: { seats: { include: { vehicleSeat: true, bookings: { where: { active: true }, include: { booking: { select: { status: true, expiresAt: true } } } } } } },
  });
  const stops = trip.stopSnapshot as unknown as TripStop[];
  return {
    stops,
    seats: trip.seats.map((seat) => ({
      id: seat.id,
      label: seat.vehicleSeat.label,
      blocked: seat.blocked,
      legs: Array.from({ length: stops.length - 1 }, (_, from) => ({
        from, to: from + 1,
        state: seatStateFor(seat.blocked, seat.bookings.map((b) => ({ ...b.booking, fromIdx: b.fromIdx, toIdx: b.toIdx })), { from, to: from + 1 }),
      })),
    })),
  };
}

/** Small, indexed operational summary for today, the next week, or the next month. */
export async function driverDashboard(driverId: string, daysRaw: unknown) {
  const days = z.coerce.number().int().refine((v) => [1, 7, 30].includes(v), 'Choose 1, 7, or 30 days.').parse(daysRaw);
  const start = new Date(), end = new Date(start.getTime() + days * 86400000);
  const trips = await db.trip.findMany({
    where: { assignments: { some: { driverId, endedAt: null } }, departure: { gte: start, lt: end } },
    include: { seats: { select: { id: true } }, bookings: { where: { status: { in: ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED'] } }, include: { seats: { where: { active: true }, select: { id: true } }, payment: { select: { status: true, verifiedAmount: true } } } } },
  });
  const bookings = trips.flatMap((trip) => trip.bookings);
  return {
    days,
    trips: trips.length,
    upcoming: trips.filter((trip) => trip.departure > new Date() && trip.status === 'SCHEDULED').length,
    bookings: bookings.length,
    occupiedSeats: bookings.reduce((n, booking) => n + booking.seats.length, 0),
    availableSeats: trips.reduce((n, trip) => n + trip.seats.length, 0) - bookings.reduce((n, booking) => n + booking.seats.length, 0),
    pendingPayments: bookings.filter((booking) => booking.payment?.status === 'SUBMITTED' || booking.payment?.status === 'UNDER_REVIEW').length,
    revenue: bookings.reduce((n, booking) => n + (booking.payment?.status === 'VERIFIED' ? booking.payment.verifiedAmount ?? 0 : 0), 0),
  };
}

const offlineBookingInput = z.object({
  tripId: z.string().min(1),
  seats: z.array(z.string().min(1)).min(1).max(8),
  name: text,
  phone,
  email: z.string().trim().email().max(254).optional(),
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  boardingPointId: z.string().min(1).optional(),
  dropPointId: z.string().min(1).optional(),
  paid: z.boolean().default(false),
  amount: z.coerce.number().int().positive().max(10_000_000).optional(),
  method: z.string().trim().min(1).max(80).default('OFFLINE'),
  note: z.string().trim().max(1000).default(''),
});

/** Phone, WhatsApp and counter bookings reserve through the identical serial inventory path as the public site. */
export async function createOfflineBooking(driverId: string, raw: unknown) {
  const input = offlineBookingInput.parse(raw);
  await ownAssignment(driverId, input.tripId);
  const { booking } = await reserve({
    ...input,
    email: input.email || undefined,
    idempotencyKey: crypto.randomUUID(),
  });
  if (!input.paid) return { id: booking.id, reference: booking.reference, status: booking.status };
  return serial(async (tx) => {
    const b = await tx.booking.findUnique({ where: { id: booking.id }, include: { payment: true } });
    if (!b?.payment || b.status !== 'HELD') throw new ApiError(409, 'The offline booking is no longer available.');
    const amount = input.amount ?? b.amount;
    if (amount < b.amount) throw new ApiError(400, 'Record at least the full fare before confirming seats.');
    await tx.payment.update({
      where: { id: b.payment.id },
      data: { status: 'VERIFIED', claimedAmount: amount, verifiedAmount: amount, method: input.method, reviewedById: driverId, reviewedAt: new Date(), note: input.note || 'Offline payment confirmed by driver.' },
    });
    await tx.seatHold.update({ where: { bookingId: b.id }, data: { status: 'CONVERTED' } });
    const confirmed = await tx.booking.update({ where: { id: b.id }, data: { status: 'CONFIRMED' } });
    await tx.auditLog.create({
      data: { actorId: driverId, operatorId: b.operatorId, action: 'DRIVER_OFFLINE_BOOKING_CONFIRMED', targetId: b.id, details: { method: input.method, amount, note: input.note } },
    });
    return { id: confirmed.id, reference: confirmed.reference, status: confirmed.status };
  });
}

export async function listSubmissions(status?: string, page = 1) {
  const wanted = (['PENDING', 'APPROVED', 'REJECTED'] as const).find((s) => s === status);
  const rows = await db.driverSubmission.findMany({
    where: { status: wanted },
    include: { driver: { select: { name: true, email: true, mobile: true } } },
    orderBy: { createdAt: wanted === 'PENDING' ? 'asc' : 'desc' },
    skip: (page - 1) * 25,
    take: 26,
  });
  const items = await Promise.all(
    rows.slice(0, 25).map(async (r) => ({ ...r, current: r.targetId ? await current(r.kind, r.targetId) : null })),
  );
  return { items, nextPage: rows.length > 25 ? page + 1 : null };
}

/** What the record looks like today, in the same shape as a payload, so a reviewer can compare the two. */
async function current(kind: string, id: string) {
  if (kind === 'vehicles') {
    const v = await db.vehicle.findUnique({ where: { id }, include: { images: { orderBy: { position: 'asc' } } } });
    return (
      v && {
        name: v.name,
        registration: v.registration,
        type: v.type,
        description: v.description,
        amenities: v.amenities,
        emergencyContact: v.emergencyContact,
        maintenanceNote: v.maintenanceNote,
        imageKeys: v.images.map((i) => i.key),
        active: v.active,
      }
    );
  }
  if (kind === 'routes') {
    const r = await db.route.findUnique({
      where: { id },
      include: { origin: true, destination: true, stops: { orderBy: { position: 'asc' }, include: { location: true } } },
    });
    return (
      r && {
        origin: r.origin.name,
        destination: r.destination.name,
        distanceKm: r.distanceKm,
        durationMinutes: r.durationMinutes,
        baseFare: r.baseFare,
        stops: r.stops.map((s) => ({
          name: s.location.name,
          offsetMinutes: s.offsetMinutes,
          kmFromOrigin: s.kmFromOrigin,
          allowBoarding: s.allowBoarding,
          allowDropoff: s.allowDropoff,
        })),
        active: r.active,
      }
    );
  }
  const q = await db.paymentQR.findUnique({ where: { id } });
  return q && { label: q.label, accountName: q.accountName, accountNumber: q.accountNumber, imageKey: q.imageKey, instructions: q.instructions, active: q.active };
}

async function locationId(name: string) {
  const found = await db.location.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' } } });
  return (found ?? (await db.location.create({ data: { name: name.trim() } }))).id;
}

type Claimed = { id: string; driverId: string; operatorId: string; kind: string; targetId: string | null };

async function applyVehicle(s: Claimed, p: VehiclePayload, adminId: string) {
  const d = await db.driver.findUniqueOrThrow({ where: { id: s.driverId }, include: { tenant: true } });
  const { grid, ...fields } = p;
  const common = { ...fields, operator: d.tenant.name, operatorContact: d.mobile };
  if (s.targetId) {
    const old = await db.vehicle.findUnique({ where: { id: s.targetId } });
    if (!old) throw new ApiError(404, 'The vehicle no longer exists.');
    return save('vehicles', { ...common, id: s.targetId, active: old.active }, adminId, true, s.operatorId);
  }
  if (await db.vehicle.findUnique({ where: { registration: p.registration } }))
    throw new ApiError(409, 'Another vehicle already has registration number ' + p.registration + '.');
  const layout = await createLayout(s.operatorId, adminId, {
    name: `${p.registration} seats ${s.id.slice(-6)}`,
    vehicleType: p.type,
    grid,
  });
  const published = await publishLayout(s.operatorId, adminId, layout.id);
  try {
    return await save('vehicles', { ...common, layoutVersionId: published.id, active: true }, adminId, false, s.operatorId);
  } catch (e) {
    await archiveLayout(s.operatorId, adminId, layout.id);
    throw e;
  }
}

async function applyRoute(s: Claimed, p: RoutePayload, adminId: string) {
  const old = s.targetId ? await db.route.findUnique({ where: { id: s.targetId } }) : null;
  if (s.targetId && !old) throw new ApiError(404, 'The route no longer exists.');
  const [originId, destinationId] = [await locationId(p.origin), await locationId(p.destination)];
  const stops = [];
  for (const { name, ...stop } of p.stops) stops.push({ ...stop, locationId: await locationId(name) });
  const saved = await save(
    'routes',
    {
      ...(s.targetId ? { id: s.targetId } : {}),
      originId,
      destinationId,
      distanceKm: p.distanceKm,
      durationMinutes: p.durationMinutes,
      baseFare: p.baseFare,
      active: old?.active ?? true,
      stops,
    },
    adminId,
    !!s.targetId,
    s.operatorId,
  );
  await db.routeSegmentFare.deleteMany({ where: { routeId: saved.id, vehicleType: p.vehicleType } });
  for (const leg of p.legFares)
    await saveSegmentFare(s.operatorId, adminId, {
      routeId: saved.id,
      vehicleType: p.vehicleType,
      fromLocationId: await locationId(leg.from),
      toLocationId: await locationId(leg.to),
      amount: leg.amount,
    });
  return saved;
}

async function applyQr(s: Claimed, p: QrPayload, adminId: string) {
  const old = s.targetId ? await db.paymentQR.findUnique({ where: { id: s.targetId } }) : null;
  if (s.targetId && !old) throw new ApiError(404, 'The payment account no longer exists.');
  // Keep prior snapshots intact: only future trip selection changes when a default changes.
  if (p.isDefault) await db.paymentQR.updateMany({ where: { operatorId: s.operatorId, isDefault: true, ...(s.targetId ? { id: { not: s.targetId } } : {}) }, data: { isDefault: false } });
  return save(
    'payment-qr',
    { ...p, ...(s.targetId ? { id: s.targetId } : {}), active: old?.active ?? true },
    adminId,
    !!s.targetId,
    s.operatorId,
  );
}

const decision = z.object({ action: z.enum(['approve', 'reject', 'activate', 'deactivate']), note: z.string().trim().max(1000).default('') });

async function setSubmissionTargetActive(tx: Prisma.TransactionClient, s: Claimed, active: boolean) {
  if (!s.targetId) throw new ApiError(409, 'This request has no live item to update.');
  const where = { id: s.targetId, operatorId: s.operatorId };
  const changed =
    s.kind === 'vehicles'
      ? await tx.vehicle.updateMany({ where, data: { active } })
      : s.kind === 'routes'
        ? await tx.route.updateMany({ where, data: { active } })
        : await tx.paymentQR.updateMany({ where, data: { active } });
  if (!changed.count) throw new ApiError(404, 'The submitted item no longer exists.');
}

/** Legacy pending requests can still be reviewed; automatically-approved changes can be toggled at any time. */
export async function reviewSubmission(id: string, adminId: string, raw: unknown) {
  const d = decision.parse(raw);
  if (d.action === 'reject' && d.note.length < 3) throw new ApiError(400, 'Tell the driver why this was rejected.');
  if ((d.action === 'activate' || d.action === 'deactivate') && d.note) throw new ApiError(400, 'Use a note only when rejecting a change.');
  const existing = await db.driverSubmission.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Request not found.');

  if (existing.status !== 'PENDING') {
    if (d.action === 'deactivate' || d.action === 'reject') {
      await serial(async (tx) => {
        await setSubmissionTargetActive(tx, existing, false);
        await tx.driverSubmission.update({ where: { id }, data: { status: d.action === 'reject' ? 'REJECTED' : existing.status, reviewNote: d.note, reviewedById: adminId, reviewedAt: new Date() } });
        await tx.auditLog.create({ data: { actorId: adminId, operatorId: existing.operatorId, action: d.action === 'reject' ? 'REJECT_DRIVER_CHANGE' : 'DEACTIVATE_DRIVER_CHANGE', targetId: existing.targetId ?? id, details: { kind: existing.kind, submissionId: id, note: d.note } } });
      });
      return { id, status: d.action === 'reject' ? 'REJECTED' : existing.status, active: false };
    }
    await serial(async (tx) => {
      await setSubmissionTargetActive(tx, existing, true);
      await tx.driverSubmission.update({ where: { id }, data: { status: 'APPROVED', reviewNote: d.note || 'Approved by admin.', reviewedById: adminId, reviewedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: adminId, operatorId: existing.operatorId, action: d.action === 'approve' ? 'APPROVE_DRIVER_CHANGE' : 'ACTIVATE_DRIVER_CHANGE', targetId: existing.targetId ?? id, details: { kind: existing.kind, submissionId: id } } });
    });
    return { id, status: 'APPROVED', active: true };
  }
  if (d.action === 'activate' || d.action === 'deactivate') throw new ApiError(409, 'Review this pending request first.');
  const status = d.action === 'approve' ? 'APPROVED' : 'REJECTED';
  // Claiming the row first means two admins can never apply the same change twice.
  const { count: claimed } = await db.driverSubmission.updateMany({
    where: { id, status: 'PENDING' },
    data: { status, reviewNote: d.note, reviewedById: adminId, reviewedAt: new Date() },
  });
  if (!claimed) throw new ApiError(409, 'This request was already reviewed or withdrawn.');
  const s = await db.driverSubmission.findUniqueOrThrow({ where: { id } });
  let targetId = s.targetId;
  if (d.action === 'approve')
    try {
      const applied =
        s.kind === 'vehicles'
          ? await applyVehicle(s, vehicleInput.parse(s.payload), adminId)
          : s.kind === 'routes'
            ? await applyRoute(s, routeInput.parse(s.payload), adminId)
            : await applyQr(s, qrInput.parse(s.payload), adminId);
      targetId = applied.id;
      await db.driverSubmission.update({ where: { id }, data: { targetId } });
    } catch (e) {
      await db.driverSubmission.update({
        where: { id },
        data: { status: 'PENDING', reviewNote: '', reviewedById: null, reviewedAt: null },
      });
      throw e;
    }
  await db.auditLog.create({
    data: {
      actorId: adminId,
      operatorId: s.operatorId,
      action: d.action === 'approve' ? 'APPROVE_DRIVER_CHANGE' : 'REJECT_DRIVER_CHANGE',
      targetId: targetId ?? s.id,
      details: { kind: s.kind, submissionId: s.id, note: d.note },
    },
  });
  return { id, status };
}
