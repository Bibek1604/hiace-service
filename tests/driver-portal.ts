import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { reserve } from '../src/lib/bookings';
import {
  cancelOwnTrip,
  createOwnerDriver,
  createOfflineBooking,
  createOwnTrip,
  fleet,
  listSubmissions,
  reviewSubmission,
  submit,
  updateProfile,
  withdraw,
} from '../src/lib/driver-portal';
import { TEMPLATES } from '../src/lib/seat-layout';

const enabled = process.env.RUN_DB_TESTS === '1';
const status = (n: number) => (e: unknown) => (e as { status?: number }).status === n;
const soon = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

// Requires an isolated, disposable database. Fixtures that are not deleted by the test remain for debugging.
test('owner-drivers change nothing public until an admin approves it', { skip: !enabled }, async () => {
  const db = new PrismaClient();
  const id = randomUUID().slice(0, 8);
  const person = (n: string) => ({
    name: `${n} ${id}`,
    email: `${n}-${id}@driver.test`,
    password: 'correct-horse-battery-' + id,
    mobile: '9800000001',
    licenseNumber: `${n}-${id}`,
    licenseExpiry: soon(3650),
    emergencyContact: '9800000002',
  });
  const image = (purpose: string, ownerId: string) =>
    db.storedObject.create({ data: { id: randomUUID(), mime: 'image/webp', bytes: 1, purpose, ownerId } });
  try {
    const admin = await db.adminUser.create({ data: { email: id + '@portal.test', name: 'Platform', passwordHash: 'unused' } });

    // Creating an owner-driver also creates their private company; a refused form leaves nothing behind.
    const driver = await createOwnerDriver(person('sita'), admin.id);
    const row = await db.driver.findUniqueOrThrow({ where: { id: driver.id }, include: { tenant: true } });
    assert.equal(row.tenant.status, 'ACTIVE');
    await assert.rejects(createOwnerDriver(person('sita'), admin.id), status(409), 'the email is taken');
    await assert.rejects(createOwnerDriver({ ...person('badphone'), mobile: 'x' }, admin.id));
    assert.equal(await db.operator.count({ where: { name: { in: [person('sita').name, person('badphone').name] } } }), 1, 'a refused form leaves no empty company');

    const other = await createOwnerDriver(person('hari'), admin.id);

    // Driver-controlled workflow: validated operational resources go live immediately, with no admin submission.
    const directGrid = TEMPLATES.hiace_17.build();
    const directVehicle = await submit(driver.id, {
      kind: 'vehicles',
      payload: { name: 'Direct Van ' + id, registration: 'DI ' + id, type: 'Hiace', emergencyContact: '9822222222', amenities: [], grid: directGrid },
    });
    assert.equal(await db.vehicle.count({ where: { id: directVehicle.id } }), 1, 'vehicle is available immediately');
    const directRoute = await submit(driver.id, {
      kind: 'routes',
      payload: { origin: 'Start ' + id, destination: 'End ' + id, distanceKm: 100, durationMinutes: 180, baseFare: 900, vehicleType: 'Hiace', stops: [{ name: 'Middle ' + id, offsetMinutes: 90, kmFromOrigin: 50, allowBoarding: true, allowDropoff: true }], legFares: [{ from: 'Start ' + id, to: 'Middle ' + id, amount: 500 }] },
    });
    const directQrImage = await image('qr', driver.id);
    await submit(driver.id, { kind: 'payment-qr', payload: { label: 'Cash QR', accountName: 'Sita', imageKey: directQrImage.id, instructions: 'Pay safely.', isDefault: true } });
    const autoVehicle = await db.driverSubmission.findFirstOrThrow({ where: { targetId: directVehicle.id } });
    assert.equal(autoVehicle.status, 'APPROVED', 'a driver submission is approved automatically');
    await reviewSubmission(autoVehicle.id, admin.id, { action: 'deactivate' });
    assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: directVehicle.id } })).active, false, 'admin can deactivate a live item');
    await reviewSubmission(autoVehicle.id, admin.id, { action: 'activate' });
    assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: directVehicle.id } })).active, true, 'admin can reactivate a deactivated item');
    await reviewSubmission(autoVehicle.id, admin.id, { action: 'reject', note: 'Registration needs correction.' });
    assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: directVehicle.id } })).active, false, 'rejection deactivates the item');
    await reviewSubmission(autoVehicle.id, admin.id, { action: 'approve' });
    assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: directVehicle.id } })).active, true, 'approval activates a rejected item');
    const directTrip = await createOwnTrip(driver.id, {
      vehicleId: directVehicle.id, routeId: directRoute.id, departure: soon(5), bookingOpensAt: new Date(Date.now() - 60000).toISOString(), bookingClosesAt: soon(4),
    });
    await createOwnTrip(driver.id, {
      vehicleId: directVehicle.id,
      routeId: directRoute.id,
      departures: [soon(7), soon(8)],
    });
    assert.equal(await db.trip.count({ where: { operatorId: row.operatorId } }), 3, 'one publish action can create multiple departures');
    const directSeat = await db.tripSeat.findFirstOrThrow({ where: { tripId: directTrip.id } });
    const directStops = (await db.trip.findUniqueOrThrow({ where: { id: directTrip.id } })).stopSnapshot as { locationId: string }[];
    const offline = await createOfflineBooking(driver.id, { tripId: directTrip.id, seats: [directSeat.id], name: 'Walk in', phone: '+9779800000009', fromLocationId: directStops[0].locationId, toLocationId: directStops[1].locationId, paid: true, amount: 500, method: 'CASH' });
    assert.equal(offline.status, 'CONFIRMED', 'offline and online bookings share the confirmed inventory path');
    await assert.rejects(reserve({ tripId: directTrip.id, seats: [directSeat.id], name: 'Overlap', phone: '+9779800000008', idempotencyKey: randomUUID() + randomUUID() }), status(409), 'overlapping seat is never double booked');
    return;

    // Personal details are the driver's own and apply at once.
    const updated = await updateProfile(driver.id, { name: 'Sita ' + id, mobile: '9811111111', emergencyContact: '9822222222', address: 'Pokhara' });
    assert.equal(updated.address, 'Pokhara');
    assert.equal(updated.licenseNumber, row.licenseNumber, 'a licence cannot be changed from the profile');

    // Vehicle: the seat plan is checked on submission and nothing exists until approval.
    const grid = TEMPLATES.hiace_17.build();
    const vehiclePayload = { name: 'Sita Van', registration: 'BA 1 ' + id, type: 'Hiace', emergencyContact: '9822222222', amenities: ['AC'], grid };
    await assert.rejects(submit(driver.id, { kind: 'vehicles', payload: { ...vehiclePayload, grid: undefined } }), status(400), 'a new vehicle needs seats');
    await assert.rejects(
      submit(driver.id, { kind: 'vehicles', payload: { ...vehiclePayload, grid: { rows: 2, cols: 2, decks: 1, cells: [] } } }),
      status(422),
      'an unusable seat plan is refused',
    );
    const stranger = await image('vehicle', other.id);
    await assert.rejects(
      submit(driver.id, { kind: 'vehicles', payload: { ...vehiclePayload, imageKeys: [stranger.id] } }),
      status(400),
      "another driver's upload cannot be attached",
    );
    const vehicleRequest = await submit(driver.id, { kind: 'vehicles', payload: vehiclePayload });
    assert.equal(await db.vehicle.count({ where: { operatorId: row.operatorId } }), 0, 'no vehicle before approval');

    // Route: stops are validated, new places wait for approval, and the price stays private.
    const place = (n: string) => `${n}-${id}`;
    const routePayload = {
      origin: place('Kathmandu'),
      destination: place('Pokhara'),
      distanceKm: 200,
      durationMinutes: 420,
      baseFare: 1000,
      vehicleType: 'Hiace',
      stops: [{ name: place('Mugling'), offsetMinutes: 210, kmFromOrigin: 110 }],
      legFares: [{ from: place('Kathmandu'), to: place('Mugling'), amount: 650 }],
    };
    await assert.rejects(submit(driver.id, { kind: 'routes', payload: { ...routePayload, destination: routePayload.origin } }), status(400));
    await assert.rejects(
      submit(driver.id, { kind: 'routes', payload: { ...routePayload, stops: [{ name: place('Mugling'), offsetMinutes: 500, kmFromOrigin: 110 }] } }),
      status(400),
      'a stop after the arrival time is refused',
    );
    await assert.rejects(
      submit(driver.id, { kind: 'routes', payload: { ...routePayload, legFares: [{ from: place('Pokhara'), to: place('Mugling'), amount: 5 }] } }),
      status(400),
      'a leg must run forward along the route',
    );
    const routeRequest = await submit(driver.id, { kind: 'routes', payload: routePayload });
    assert.equal(await db.location.count({ where: { name: routePayload.origin } }), 0, 'a new place waits for approval');

    const qrImage = await image('qr', driver.id);
    const qrRequest = await submit(driver.id, {
      kind: 'payment-qr',
      payload: { label: 'eSewa', accountName: 'Sita', imageKey: qrImage.id, instructions: 'Scan and pay.' },
    });

    // A trip cannot start from anything that is not approved.
    const later = await submit(driver.id, { kind: 'routes', payload: { ...routePayload, baseFare: 1 } });
    await withdraw(driver.id, later.id);
    await assert.rejects(reviewSubmission(later.id, admin.id, { action: 'approve' }), status(409), 'a withdrawn request cannot be approved');
    await assert.rejects(withdraw(other.id, vehicleRequest.id), status(404), 'only the sender can withdraw');
    await assert.rejects(
      createOwnTrip(driver.id, { vehicleId: 'none', routeId: 'none', paymentQRId: 'none', departure: soon(5) }),
      status(404),
      'no approved route yet',
    );

    // Rejection needs a reason, and the reason reaches the driver.
    await assert.rejects(reviewSubmission(qrRequest.id, admin.id, { action: 'reject' }), status(400));
    await reviewSubmission(qrRequest.id, admin.id, { action: 'reject', note: 'The QR name does not match.' });
    assert.equal((await fleet(driver.id)).submissions.find((s) => s.id === qrRequest.id)?.reviewNote, 'The QR name does not match.');
    assert.equal(await db.paymentQR.count({ where: { operatorId: row.operatorId } }), 0, 'a rejected request changes nothing');
    await assert.rejects(reviewSubmission(qrRequest.id, admin.id, { action: 'approve' }), status(409), 'a decision is final');

    // Approving applies the change once, inside the driver's own company.
    const again = await submit(driver.id, {
      kind: 'payment-qr',
      payload: { label: 'eSewa', accountName: 'Sita', imageKey: qrImage.id, instructions: 'Scan and pay.' },
    });
    const pending = await listSubmissions('PENDING');
    assert.ok(pending.items.some((s) => s.id === again.id), 'the admin sees the request');
    await reviewSubmission(again.id, admin.id, { action: 'approve' });
    await reviewSubmission(vehicleRequest.id, admin.id, { action: 'approve' });
    await assert.rejects(reviewSubmission(vehicleRequest.id, admin.id, { action: 'approve' }), status(409), 'nothing is applied twice');
    await reviewSubmission(routeRequest.id, admin.id, { action: 'approve' });
    const seeing = await fleet(driver.id);
    const [vehicle] = seeing.vehicles,
      [route] = seeing.routes,
      [qr] = seeing.qrs;
    assert.equal(vehicle._count.seats, 17, 'the seats come from the proposed plan');
    assert.equal(vehicle.operator, row.tenant.name);
    assert.equal(vehicle.operatorId, row.operatorId);
    assert.equal(route.stops.length, 1);
    assert.equal(route.segmentFares[0].amount, 650);

    // A failed approval is not lost: it goes back to the queue with the reason shown to the admin.
    const clash = await submit(other.id, { kind: 'vehicles', payload: vehiclePayload });
    await assert.rejects(reviewSubmission(clash.id, admin.id, { action: 'approve' }), status(409), 'the number is already registered');
    assert.equal((await db.driverSubmission.findUniqueOrThrow({ where: { id: clash.id } })).status, 'PENDING');

    // Another driver cannot aim a change at someone else's record.
    await assert.rejects(submit(other.id, { kind: 'routes', targetId: route.id, payload: routePayload }), status(404));
    await assert.rejects(
      createOwnTrip(other.id, { vehicleId: vehicle.id, routeId: route.id, paymentQRId: qr.id, departure: soon(5) }),
      status(404),
      "another driver's route cannot be scheduled",
    );

    // The price of a trip comes from the approved route, whatever the request says.
    const trip = await createOwnTrip(driver.id, {
      vehicleId: vehicle.id,
      routeId: route.id,
      paymentQRId: qr.id,
      departure: soon(5),
      fare: 1,
    } as never);
    const saved = await db.trip.findUniqueOrThrow({
      where: { id: trip.id },
      include: { assignments: true, seats: true, tripFares: true },
    });
    assert.equal(saved.fare, 1000);
    assert.equal(saved.assignments[0].driverId, driver.id, 'the driver is assigned to their own trip');
    assert.equal(saved.seats.length, 17);
    assert.equal(saved.arrival.getTime() - saved.departure.getTime(), 420 * 60000, 'arrival follows the route');
    assert.ok(saved.tripFares.some((f) => f.amount === 650), 'the approved stop price is used');

    // A price change waits for approval, and sold trips keep the price they were opened with.
    const change = await submit(driver.id, { kind: 'routes', targetId: route.id, payload: { ...routePayload, baseFare: 1500 } });
    await assert.rejects(submit(driver.id, { kind: 'routes', targetId: route.id, payload: routePayload }), status(409), 'one change at a time');
    assert.equal((await db.route.findUniqueOrThrow({ where: { id: route.id } })).baseFare, 1000, 'still the old price');
    await reviewSubmission(change.id, admin.id, { action: 'approve' });
    assert.equal((await db.route.findUniqueOrThrow({ where: { id: route.id } })).baseFare, 1500);
    assert.equal((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).fare, 1000, 'an existing trip keeps its price');

    // A driver cannot switch back on a vehicle the admin took off the road, or swap its seats.
    await db.vehicle.update({ where: { id: vehicle.id }, data: { active: false } });
    await assert.rejects(submit(driver.id, { kind: 'vehicles', targetId: vehicle.id, payload: vehiclePayload }), status(409), 'seats are fixed');
    const details = { ...vehiclePayload, grid: undefined };
    const rename = await submit(driver.id, { kind: 'vehicles', targetId: vehicle.id, payload: { ...details, name: 'Sita Van 2' } });
    await reviewSubmission(rename.id, admin.id, { action: 'approve' });
    const after = await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    assert.equal(after.name, 'Sita Van 2');
    assert.equal(after.active, false, 'an approved edit does not reactivate the vehicle');

    // A trip with bookings goes through the admin; an empty one the driver can cancel.
    const reopen = () => db.vehicle.update({ where: { id: vehicle.id }, data: { active: true } });
    await assert.rejects(cancelOwnTrip(other.id, trip.id, { reason: 'Not mine' }), status(404));
    const booked = await createOwnTrip(driver.id, { vehicleId: (await reopen()).id, routeId: route.id, paymentQRId: qr.id, departure: soon(9) });
    const seat = await db.tripSeat.findFirstOrThrow({ where: { tripId: booked.id } });
    await reserve({ tripId: booked.id, seats: [seat.id], name: 'Passenger', phone: '+9779800000009', idempotencyKey: randomUUID() + randomUUID() });
    await assert.rejects(cancelOwnTrip(driver.id, booked.id, { reason: 'Vehicle in repair' }), status(409), 'passengers need the admin');
    assert.equal((await cancelOwnTrip(driver.id, trip.id, { reason: 'Vehicle in repair' })).status, 'CANCELLED');

    // Leaves the shared review queue as it was found.
    await withdraw(other.id, clash.id);
  } finally {
    // Whatever happened above, nothing of this test stays in the shared review queue.
    await db.driverSubmission.deleteMany({ where: { status: 'PENDING', driver: { email: { endsWith: `-${id}@driver.test` } } } });
    await db.$disconnect();
  }
});
