import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { reserve, review, submitProof } from '../src/lib/bookings';
import { auditLog, list, reportSummary, save } from '../src/lib/admin';
import { handle } from '../src/lib/http';
import {
  cancelOwnBooking,
  cancelOwnTrip,
  controlOwnSchedule,
  createOfflineBooking,
  createOwnSchedules,
  createOwnTrip,
  ownBookings,
  ownTrips,
  setOwnSeatBlocked,
  submit,
  updateOwnTrip,
} from '../src/lib/driver-portal';
import { TEMPLATES } from '../src/lib/seat-layout';
import { makeDriver } from './helpers';

/**
 * One test per confirmed defect from the system audit. Each asserts the correct behaviour, so it failed before
 * its fix. Requires an isolated, disposable database (RUN_DB_TESTS=1).
 */
const enabled = process.env.RUN_DB_TESTS === '1';
const db = new PrismaClient();
const status = (n: number) => (e: unknown) => (e as { status?: number }).status === n;
const hours = (n: number) => new Date(Date.now() + n * 3600000).toISOString();
const dayIn = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function setup(label = 'audit') {
  const id = randomUUID().slice(0, 8);
  const admin = await db.adminUser.create({ data: { email: `${label}-${id}@audit.test`, name: 'Admin', passwordHash: 'unused' } });
  const driver = await makeDriver(db, admin.id, label);
  const vehicle = await submit(driver.id, {
    kind: 'vehicles',
    payload: { name: 'Van ' + id, registration: 'AUD ' + id, type: 'Hiace', emergencyContact: '9822222222', amenities: [], maintenanceNote: 'SECRET-NOTE', grid: TEMPLATES.hiace_17.build() },
  });
  const names = { a: 'Audit Start ' + id, b: 'Audit Middle ' + id, c: 'Audit End ' + id };
  const route = await submit(driver.id, {
    kind: 'routes',
    payload: { origin: names.a, destination: names.c, distanceKm: 100, durationMinutes: 180, baseFare: 900, vehicleType: 'Hiace', stops: [{ name: names.b, offsetMinutes: 90, kmFromOrigin: 50, allowBoarding: true, allowDropoff: true }], legFares: [] },
  });
  const image = await db.storedObject.create({ data: { id: randomUUID(), mime: 'image/webp', bytes: 1, purpose: 'qr', ownerId: driver.id } });
  const qr = await submit(driver.id, { kind: 'payment-qr', payload: { label: 'Wallet', accountName: 'Owner', imageKey: image.id, instructions: 'Pay.', isDefault: true } });
  return { id, admin, driver, vehicle, route, qr, names };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const plan = (c: Ctx, departureTime: string) => ({ routeId: c.route.id, vehicleId: c.vehicle.id, paymentQRId: c.qr.id, departureTime });
const seatOf = async (tripId: string, n = 0) => (await db.tripSeat.findMany({ where: { tripId }, orderBy: { id: 'asc' } }))[n];
const key = () => randomUUID() + randomUUID();
const book = async (tripId: string, n = 0) => reserve({ tripId, seats: [(await seatOf(tripId, n)).id], name: 'Passenger', phone: '+9779841234567', idempotencyKey: key() });
const proof = () => ({ id: randomUUID(), mime: 'image/webp', bytes: 1 });
const search = async (query: string) =>
  (await (await handle(new Request('http://app.test/api/trips?' + query), ['trips'])).json()) as { items: { id: string; fare: number }[]; nextPage: number | null };
const detail = async (id: string) => (await (await handle(new Request('http://app.test/api/trips/' + id), ['trips', id])).json()) as Record<string, unknown>;

test('search filters before it paginates, so matches are never lost behind reversed trips', { skip: !enabled }, async () => {
  const c = await setup('paging');
  // Two opposite routes share both places, so the reversed trips pass any filter that ignores travel order.
  const stop = (name: string, at: number) => ({ name, offsetMinutes: at, kmFromOrigin: at, allowBoarding: true, allowDropoff: true });
  const route = (origin: string, destination: string, stops: ReturnType<typeof stop>[]) =>
    submit(c.driver.id, { kind: 'routes', payload: { origin, destination, distanceKm: 100, durationMinutes: 60, baseFare: 500, vehicleType: 'Hiace', stops, legFares: [] } });
  const x = 'Paging X ' + c.id,
    y = 'Paging Y ' + c.id;
  const forward = await route(c.names.a, c.names.c, [stop(x, 20), stop(y, 40)]),
    reverse = await route(c.names.c, c.names.a, [stop(y, 20), stop(x, 40)]);
  const departures = Array.from({ length: 30 }, (_, i) => hours(24 + i * 2));
  await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: reverse.id, departures });
  const wanted = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: forward.id, departure: hours(24 * 10) });
  const found = await search(new URLSearchParams({ origin: x, destination: y }).toString());
  assert.deepEqual(found.items.map((t) => t.id), [wanted.id]);
  assert.equal(found.nextPage, null);
});

test('search and trip detail hide trips that cannot be booked and internal fields', { skip: !enabled }, async () => {
  const c = await setup('public');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  const query = new URLSearchParams({ origin: c.names.a, destination: c.names.c }).toString();
  const found = await search(query);
  assert.equal(found.items.length, 1);
  const text = JSON.stringify(found) + JSON.stringify(await detail(trip.id));
  assert.ok(!text.includes('SECRET-NOTE'), 'maintenance notes stay private');
  assert.ok(!text.includes('emergencyContact'), 'emergency contacts stay private');
  assert.ok(!text.includes('paymentQRId'), 'payment account ids stay private');

  await db.paymentQR.update({ where: { id: c.qr.id }, data: { active: false } });
  assert.equal((await search(query)).items.length, 0, 'a trip with no active payment account cannot be booked');
  assert.equal((await detail(trip.id)).bookingOpen, false, 'the seat page agrees that booking is closed');
  await db.paymentQR.update({ where: { id: c.qr.id }, data: { active: true } });

  await db.route.update({ where: { id: c.route.id }, data: { active: false } });
  await assert.rejects(book(trip.id), status(409), 'a deactivated route cannot be sold through a direct link');
});

test('a trip stays searchable by its frozen stops after the route is edited', { skip: !enabled }, async () => {
  const c = await setup('snapshot');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  await submit(c.driver.id, { kind: 'routes', targetId: c.route.id, payload: { origin: c.names.a, destination: c.names.c, distanceKm: 100, durationMinutes: 180, baseFare: 900, vehicleType: 'Hiace', stops: [], legFares: [] } });
  const found = await search(new URLSearchParams({ origin: c.names.b, destination: c.names.c }).toString());
  assert.deepEqual(found.items.map((t) => t.id), [trip.id]);
  assert.equal(found.items[0].fare, 450, 'the leg keeps its frozen fare');
});

test('a closed payment decision cannot be reopened', { skip: !enabled }, async () => {
  const c = await setup('review');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  const { booking } = await book(trip.id);
  await submitProof(booking.id, proof(), { claimedAmount: 900, method: 'Wallet' });
  const payment = await db.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
  await review(payment.id, c.driver.id, { action: 'reject', note: 'No such transaction.' });
  await assert.rejects(review(payment.id, c.driver.id, { action: 'verify', note: 'changed my mind', bankEvidence: 'x', verifiedAmount: 900, confirm: true }), status(409));
  await assert.rejects(review(payment.id, c.driver.id, { action: 'clarify', note: 'one more question' }), status(409));
  assert.equal((await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).status, 'REJECTED');
});

test('schedule controls leave individually managed trips and finished schedules alone', { skip: !enabled }, async () => {
  const c = await setup('control');
  const { schedules } = await createOwnSchedules(c.driver.id, { startsOn: dayIn(3), endsOn: dayIn(5), plans: [plan(c, '09:00')] });
  const id = schedules[0].id;
  const trips = await db.trip.findMany({ where: { scheduleId: id }, orderBy: { departure: 'asc' } });
  await updateOwnTrip(c.driver.id, trips[1].id, { bookingOpen: false });
  await controlOwnSchedule(c.driver.id, id, { action: 'pause' });
  await controlOwnSchedule(c.driver.id, id, { action: 'resume' });
  const after = await db.trip.findMany({ where: { scheduleId: id }, orderBy: { departure: 'asc' } });
  assert.deepEqual(after.map((t) => t.bookingOpen), [true, false, true], 'the trip the driver closed stays closed');

  await controlOwnSchedule(c.driver.id, id, { action: 'extend', endsOn: dayIn(6) });
  assert.equal(await db.trip.count({ where: { scheduleId: id } }), 4, 'extending adds exactly the new day');

  await controlOwnSchedule(c.driver.id, id, { action: 'cancel' });
  await assert.rejects(controlOwnSchedule(c.driver.id, id, { action: 'extend', endsOn: dayIn(9) }), status(409));
  assert.equal(await db.trip.count({ where: { scheduleId: id, status: { not: 'CANCELLED' } } }), 0, 'a cancelled schedule publishes nothing');
});

test('publishing is all-or-nothing and generates departures in date order', { skip: !enabled }, async () => {
  const c = await setup('publish');
  // The second plan overlaps the first: the route takes three hours and leaves one hour later.
  await assert.rejects(createOwnSchedules(c.driver.id, { startsOn: dayIn(3), endsOn: dayIn(5), plans: [plan(c, '08:00'), plan(c, '09:00')] }), status(409));
  assert.equal(await db.tripSchedule.count({ where: { driverId: c.driver.id } }), 0, 'no schedule survives a refused publish');
  assert.equal(await db.trip.count({ where: { operatorId: c.driver.operatorId } }), 0, 'no orphan trips survive a refused publish');

  await assert.rejects(createOwnSchedules(c.driver.id, { startsOn: dayIn(-5), endsOn: dayIn(-2), plans: [plan(c, '08:00')] }), status(400), 'a range entirely in the past publishes nothing');
  assert.equal(await db.tripSchedule.count({ where: { driverId: c.driver.id } }), 0);

  await assert.rejects(createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departures: [hours(48), hours(49)] }), status(409));
  assert.equal(await db.trip.count({ where: { operatorId: c.driver.operatorId } }), 0, 'one-off departures publish together or not at all');

  const result = await createOwnSchedules(c.driver.id, { startsOn: dayIn(3), endsOn: dayIn(9), plans: [plan(c, '06:00'), plan(c, '14:00')] });
  assert.equal(result.created, 14, 'outbound and return each create a trip per day');
  const made = await db.trip.findMany({ where: { operatorId: c.driver.operatorId }, orderBy: { departure: 'asc' } });
  assert.equal(new Set(made.map((t) => t.departure.getTime())).size, 14);
  await assert.rejects(createOwnSchedules(c.driver.id, { startsOn: dayIn(3), endsOn: dayIn(9), plans: [plan(c, '06:00')] }), status(409), 'publishing the same week twice is refused');
  assert.equal(await db.trip.count({ where: { operatorId: c.driver.operatorId } }), 14);
});

test('changing a trip keeps its window valid and never touches bookings or sibling trips', { skip: !enabled }, async () => {
  const c = await setup('edit');
  await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departures: [hours(48), hours(72)] });
  const [first, second] = await db.trip.findMany({ where: { operatorId: c.driver.operatorId }, orderBy: { departure: 'asc' } });
  await book(first.id);

  // Booking-window edits resend the unchanged times; that is not a reschedule.
  const closes = hours(40);
  const edited = await updateOwnTrip(c.driver.id, first.id, { departure: first.departure.toISOString(), arrival: first.arrival.toISOString(), bookingClosesAt: closes });
  assert.equal(edited.bookingClosesAt?.toISOString(), closes);
  await assert.rejects(updateOwnTrip(c.driver.id, first.id, { departure: hours(50) }), status(409), 'a trip with bookings keeps its time');
  await assert.rejects(updateOwnTrip(c.driver.id, first.id, { bookingClosesAt: hours(60) }), status(400), 'booking cannot close after departure');
  await assert.rejects(updateOwnTrip(c.driver.id, first.id, { bookingOpensAt: hours(45), bookingClosesAt: hours(30) }), status(400), 'booking must open before it closes');

  // Moving a trip carries its arrival and closing time, and an overlap is a clear refusal.
  const later = hours(80);
  const moved = await updateOwnTrip(c.driver.id, second.id, { departure: later });
  assert.equal(moved.arrival.getTime() - moved.departure.getTime(), second.arrival.getTime() - second.departure.getTime());
  assert.equal(moved.bookingClosesAt?.toISOString(), later);
  await assert.rejects(updateOwnTrip(c.driver.id, second.id, { departure: first.departure.toISOString() }), status(409), 'overlapping another trip is a conflict, not a server fault');
  assert.equal((await db.trip.findUniqueOrThrow({ where: { id: first.id } })).departure.getTime(), first.departure.getTime());
});

test('a trip with a case under reconciliation explains who can cancel it', { skip: !enabled }, async () => {
  const c = await setup('cancel');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  const { booking } = await book(trip.id);
  await db.booking.update({ where: { id: booking.id }, data: { status: 'PAYMENT_RECONCILIATION_REQUIRED' } });
  await assert.rejects(cancelOwnTrip(c.driver.id, trip.id, { reason: 'Vehicle broke down' }), (e: Error) => /admin/i.test(e.message) && !/permission/i.test(e.message));
});

test('offline bookings use the same phone format as the public site, so tracking finds them', { skip: !enabled }, async () => {
  const c = await setup('offline');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  const stops = (await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).stopSnapshot as { locationId: string }[];
  const made = await createOfflineBooking(c.driver.id, { tripId: trip.id, seats: [(await seatOf(trip.id)).id], name: 'Walk in', phone: '9841234567', fromLocationId: stops[0].locationId, toLocationId: stops[2].locationId });
  const row = await db.booking.findUniqueOrThrow({ where: { id: made.id }, include: { customer: true } });
  assert.equal(row.customer.phone, '+9779841234567');
});

test('the driver booking list exposes a duplicate reference so it can be acknowledged', { skip: !enabled }, async () => {
  const c = await setup('dupe');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  for (const n of [0, 1]) {
    const { booking } = await book(trip.id, n);
    await submitProof(booking.id, proof(), { claimedAmount: 900, method: 'Wallet', transactionRef: 'TXN-' + c.id });
  }
  const rows = await ownBookings(c.driver.id, {});
  assert.deepEqual(rows.map((b) => (b.payment as { duplicateReference?: boolean } | null)?.duplicateReference), [true, true]);
});

test('admin edits keep what the admin form does not show', { skip: !enabled }, async () => {
  const c = await setup('admin');
  const opens = hours(1),
    closes = hours(30);
  const { id: tripId } = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48), bookingOpensAt: opens, bookingClosesAt: closes });
  const trip = await db.trip.findUniqueOrThrow({ where: { id: tripId } });
  await save('trips', { id: trip.id, vehicleId: c.vehicle.id, routeId: c.route.id, driverId: c.driver.id, paymentQRId: c.qr.id, departure: trip.departure.toISOString(), arrival: trip.arrival.toISOString(), boardingPoint: 'Gate 2', dropPoint: trip.dropPoint, fare: trip.fare }, c.admin.id, true);
  const after = await db.trip.findUniqueOrThrow({ where: { id: trip.id } });
  assert.equal(after.boardingPoint, 'Gate 2');
  assert.equal(after.bookingOpensAt?.toISOString(), opens);
  assert.equal(after.bookingClosesAt?.toISOString(), closes);

  // The admin route form resends the stop ids in order; that must not respace the driver's real timings.
  const route = await db.route.findUniqueOrThrow({ where: { id: c.route.id }, include: { stops: { orderBy: { position: 'asc' } } } });
  await db.routeStop.updateMany({ where: { routeId: route.id }, data: { offsetMinutes: 70, kmFromOrigin: 33, allowDropoff: false } });
  await save('routes', { id: route.id, originId: route.originId, destinationId: route.destinationId, distanceKm: 100, durationMinutes: 200, baseFare: 950, stopIds: route.stops.map((s) => s.locationId) }, c.admin.id, true);
  const stop = await db.routeStop.findFirstOrThrow({ where: { routeId: route.id } });
  assert.deepEqual([stop.offsetMinutes, stop.kmFromOrigin, stop.allowDropoff], [70, 33, false]);
});

test('the admin driver list reports the account status, so editing a suspended driver keeps it', { skip: !enabled }, async () => {
  const c = await setup('status');
  const row = await db.driver.findUniqueOrThrow({ where: { id: c.driver.id } });
  await save('drivers', { id: row.id, name: row.name, email: row.email, mobile: row.mobile, licenseNumber: row.licenseNumber, licenseExpiry: row.licenseExpiry.toISOString(), emergencyContact: row.emergencyContact, status: 'SUSPENDED' }, c.admin.id, true, row.operatorId);
  const listed = (await list('drivers', 1, null, { q: row.email })) as unknown as { status: string }[];
  assert.equal(listed[0].status, 'SUSPENDED');
});

test('a driver cancels a booking on their own trip only, and any refund stays on record', { skip: !enabled }, async () => {
  const c = await setup('dcancel');
  const other = await setup('dcancel2');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  const { booking } = await book(trip.id);
  await submitProof(booking.id, proof(), { claimedAmount: 900, method: 'Wallet' });
  const payment = await db.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
  await review(payment.id, c.driver.id, { action: 'verify', note: 'Seen in wallet.', bankEvidence: 'REF1', verifiedAmount: 900, confirm: true });

  await assert.rejects(cancelOwnBooking(other.driver.id, booking.id, { reason: 'Not my booking' }), status(404), "another driver's booking looks missing");
  const done = await cancelOwnBooking(c.driver.id, booking.id, { reason: 'Passenger phoned to cancel' });
  assert.equal(done.status, 'CANCELLED');
  assert.equal(done.seatsReleased, 1);
  assert.equal(done.cancellation.refundStatus, 'PENDING', 'money already verified becomes a refund to settle');
  await assert.rejects(cancelOwnBooking(c.driver.id, booking.id, { reason: 'Twice' }), status(409));
  assert.ok((await book(trip.id)).booking.id, 'the released seat can be sold again');
});

test('a driver blocks a free seat for one departure, never a sold one', { skip: !enabled }, async () => {
  const c = await setup('block');
  const other = await setup('block2');
  await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departures: [hours(48), hours(72)] });
  const [trip, sibling] = await db.trip.findMany({ where: { operatorId: c.driver.operatorId }, orderBy: { departure: 'asc' } });
  await book(trip.id, 0);
  const sold = await seatOf(trip.id, 0),
    free = await seatOf(trip.id, 1);
  await assert.rejects(setOwnSeatBlocked(c.driver.id, sold.id, { blocked: true, note: 'broken seat' }), status(409));
  await assert.rejects(setOwnSeatBlocked(other.driver.id, free.id, { blocked: true, note: 'not mine' }), status(404));
  await setOwnSeatBlocked(c.driver.id, free.id, { blocked: true, note: 'broken seat' });
  await assert.rejects(reserve({ tripId: trip.id, seats: [free.id], name: 'Passenger', phone: '+9779841234567', idempotencyKey: key() }), status(409));
  assert.equal(await db.tripSeat.count({ where: { tripId: sibling.id, blocked: true } }), 0, 'other departures are untouched');
});

test('a trip on the road stays on the driver list after its departure time, until it is completed', { skip: !enabled }, async () => {
  const c = await setup('road');
  const made = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(24 * 40) });
  await updateOwnTrip(c.driver.id, made.id, { status: 'BOARDING' });
  await updateOwnTrip(c.driver.id, made.id, { status: 'DEPARTED', bookingOpen: false });
  assert.deepEqual((await ownTrips(c.driver.id, undefined, '1')).map((t) => t.id), [made.id], 'still visible outside the date window');
  await updateOwnTrip(c.driver.id, made.id, { status: 'COMPLETED' });
  assert.equal((await ownTrips(c.driver.id, undefined, '1')).length, 0);
});

test('reports keep old work queues in view, and the audit trail names who acted', { skip: !enabled }, async () => {
  const c = await setup('report');
  const trip = await createOwnTrip(c.driver.id, { vehicleId: c.vehicle.id, routeId: c.route.id, departure: hours(48) });
  const { booking } = await book(trip.id);
  await submitProof(booking.id, proof(), { claimedAmount: 900, method: 'Wallet' });
  const before = await reportSummary(1);
  // The proof is now nine days old; it is still waiting for a decision.
  await db.booking.update({ where: { id: booking.id }, data: { createdAt: new Date(Date.now() - 9 * 86400000) } });
  const after = await reportSummary(1);
  assert.equal(after.pending, before.pending, 'an old proof still counts as waiting');
  assert.equal(after.bookings, before.bookings - 1, 'the booking itself left the one-day window');

  const trail = await auditLog(1, { action: 'PROOF_SUBMITTED' });
  assert.equal(trail.items.find((row) => row.targetId === booking.id)?.actor, 'Passenger');
  const created = await auditLog(1, { q: c.vehicle.id });
  assert.ok(created.items.some((row) => row.actor.startsWith('Driver: ')), 'the driver who acted is named');
});

test.after(() => db.$disconnect());
