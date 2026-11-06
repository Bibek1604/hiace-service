import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { list, remove, save } from '../src/lib/admin';
import { createLayout, deleteLayout, publishLayout } from '../src/lib/layouts';
import { deletePoint, routeDetail, savePoint } from '../src/lib/route-points';
import { reserve } from '../src/lib/bookings';
import { login } from '../src/lib/auth';
import { makeDriver, makeTenant } from './helpers';

const enabled = process.env.RUN_DB_TESTS === '1';
const status = (n: number) => (e: unknown) => (e as { status?: number }).status === n;

// Requires an isolated, disposable database. Fixtures that are not deleted by the test remain for debugging.
test('every admin module supports create, read, update and a guarded delete', { skip: !enabled }, async () => {
  const db = new PrismaClient();
  const id = randomUUID().slice(0, 8);
  try {
    const admin = await db.adminUser.create({ data: { email: id + '@crud.test', name: 'Platform', passwordHash: 'unused' } });
    const driver = await makeDriver(db, admin.id, 'crud');
    const op = { id: driver.operatorId };
    const other = await makeTenant(db, 'other');

    // Locations (platform-wide): create, update, list, delete; a location on a route cannot go.
    const [a, b, c, spare] = await Promise.all(
      ['A', 'B', 'C', 'Spare'].map((n) => save('locations', { name: `${n}-${id}` }, admin.id, false)),
    );
    await save('locations', { id: spare.id, name: `Spare-renamed-${id}` }, admin.id, true);
    assert.equal((await db.location.findUniqueOrThrow({ where: { id: spare.id } })).name, `Spare-renamed-${id}`, 'the location was renamed');
    const page = await list('locations', 1);
    assert.ok(page.length <= 26 && page.every((l) => typeof (l as { name: string }).name === 'string'), 'locations are listed in pages');
    assert.deepEqual(await remove('locations', spare.id, admin.id), { ok: true, id: spare.id });
    await assert.rejects(remove('locations', spare.id, admin.id), status(404), 'deleting twice is a clean 404');
    await assert.rejects(remove('locations', a.id, admin.id, op.id), status(403), 'a tenant scope cannot delete locations');

    const route = await save(
      'routes',
      {
        originId: a.id, destinationId: c.id, distanceKm: 200, durationMinutes: 300, baseFare: 1000,
        stops: [{ locationId: b.id, offsetMinutes: 120, kmFromOrigin: 90, allowBoarding: true, allowDropoff: true }],
      },
      admin.id, false, op.id,
    );
    await assert.rejects(remove('locations', a.id, admin.id), status(409), 'a route origin cannot be deleted');
    await assert.rejects(remove('locations', b.id, admin.id), status(409), 'an intermediate stop cannot be deleted');

    // Route points: create, toggle, delete; another tenant cannot see or delete them.
    const point = await savePoint(op.id, admin.id, { routeId: route.id, locationId: a.id, kind: 'BOARDING', name: 'Gate 1' });
    await savePoint(op.id, admin.id, { id: point.id, routeId: route.id, locationId: a.id, kind: 'BOARDING', name: 'Gate 1', active: false });
    assert.equal((await routeDetail(op.id, route.id)).points[0].active, false);
    await assert.rejects(deletePoint(other.id, admin.id, point.id), status(404));
    assert.deepEqual(await deletePoint(op.id, admin.id, point.id), { ok: true, id: point.id });
    assert.equal((await routeDetail(op.id, route.id)).points.length, 0);

    // Fares: create, update, delete, tenant-guarded.
    const fare = await save('fares', { routeId: route.id, vehicleType: 'Bus', fare: 1200 }, admin.id, false, op.id);
    await save('fares', { id: fare.id, routeId: route.id, vehicleType: 'Bus', fare: 1300 }, admin.id, true, op.id);
    assert.equal((await db.routeFare.findUniqueOrThrow({ where: { id: fare.id } })).fare, 1300);
    await assert.rejects(remove('fares', fare.id, admin.id, other.id), status(404));
    await remove('fares', fare.id, admin.id, op.id);
    assert.equal(await db.routeFare.count({ where: { id: fare.id } }), 0);

    // Seat layouts: a draft can be deleted, a published one only archived.
    const draft = await createLayout(op.id, admin.id, { name: 'Draft ' + id, vehicleType: 'Bus', template: 'coach_2x2_40' });
    await assert.rejects(deleteLayout(other.id, admin.id, draft.id), status(404));
    await deleteLayout(op.id, admin.id, draft.id);
    assert.equal(await db.seatLayout.count({ where: { id: draft.id } }), 0);
    const layout = await createLayout(op.id, admin.id, { name: 'Pub ' + id, vehicleType: 'Hiace', template: 'hiace_17' });
    const version = await publishLayout(op.id, admin.id, layout.id);
    await assert.rejects(deleteLayout(op.id, admin.id, layout.id), status(409));

    // Vehicles, QR, trips.
    const vehicle = await save(
      'vehicles',
      { name: 'V', registration: 'V-' + id, type: 'Hiace', operator: 'CRUD', operatorContact: '9800000000', emergencyContact: '9800000000', layoutVersionId: version.id },
      admin.id, false, op.id,
    );
    assert.equal(await db.vehicleSeat.count({ where: { vehicleId: vehicle.id } }), 17);
    const throwaway = await save(
      'vehicles',
      { name: 'T', registration: 'T-' + id, type: 'Bus', operator: 'CRUD', operatorContact: '9800000000', emergencyContact: '9800000000', seatLabels: ['A1', 'A2'] },
      admin.id, false, op.id,
    );
    await save('vehicles', { id: throwaway.id, name: 'T2', registration: 'T-' + id, type: 'Bus', operator: 'CRUD', operatorContact: '9800000000', emergencyContact: '9800000000', seatLabels: ['A1', 'A2'] }, admin.id, true, op.id);
    await assert.rejects(remove('vehicles', throwaway.id, admin.id, other.id), status(404), 'foreign vehicle looks missing');
    await remove('vehicles', throwaway.id, admin.id, op.id);
    assert.equal(await db.vehicle.count({ where: { id: throwaway.id } }), 0);
    assert.equal(await db.vehicleSeat.count({ where: { vehicleId: throwaway.id } }), 0);

    const qrImage = await db.storedObject.create({ data: { id: 'qr-' + id, mime: 'image/webp', bytes: 10, purpose: 'qr', ownerId: admin.id } });
    const qr = await save('payment-qr', { label: 'Bank', imageKey: qrImage.id, accountName: 'CRUD', instructions: 'Pay' }, admin.id, false, op.id);
    const spareQr = await save('payment-qr', { label: 'Spare', imageKey: qrImage.id, accountName: 'CRUD', instructions: 'Pay' }, admin.id, false, op.id);
    await remove('payment-qr', spareQr.id, admin.id, op.id);

    const dep = new Date(Date.now() + 864e5);
    const tripInput = {
      vehicleId: vehicle.id, routeId: route.id, driverId: driver.id, paymentQRId: qr.id,
      departure: dep.toISOString(), arrival: new Date(dep.getTime() + 5 * 36e5).toISOString(),
      boardingPoint: 'A', dropPoint: 'C', fare: 1000,
    };
    const trip = await save('trips', tripInput, admin.id, false, op.id);
    await assert.rejects(remove('vehicles', vehicle.id, admin.id, op.id), status(409), 'a vehicle with trips stays');
    await assert.rejects(remove('drivers', driver.id, admin.id, op.id), status(409), 'an assigned driver stays');
    await assert.rejects(remove('routes', route.id, admin.id, op.id), status(409), 'a route with trips stays');
    await assert.rejects(remove('payment-qr', qr.id, admin.id, op.id), status(409), 'a QR used by a trip stays');
    await assert.rejects(remove('vehicles', vehicle.id, admin.id, other.id), status(404));

    // A trip with a booking cannot be deleted; an empty one can, after which its vehicle can go too.
    const seat = (await db.tripSeat.findFirstOrThrow({ where: { tripId: trip.id } })).id;
    await reserve({ tripId: trip.id, seats: [seat], name: 'Guest', phone: '+9779800000000', idempotencyKey: randomUUID() });
    await assert.rejects(remove('trips', trip.id, admin.id, op.id), status(409));
    const trip2 = await save('trips', { ...tripInput, departure: new Date(dep.getTime() + 864e5).toISOString(), arrival: new Date(dep.getTime() + 864e5 + 5 * 36e5).toISOString() }, admin.id, false, op.id);
    await save('trips', { ...tripInput, id: trip2.id, departure: new Date(dep.getTime() + 864e5).toISOString(), arrival: new Date(dep.getTime() + 864e5 + 5 * 36e5).toISOString(), bookingOpen: false }, admin.id, true, op.id);
    assert.equal((await db.trip.findUniqueOrThrow({ where: { id: trip2.id } })).bookingOpen, false);
    await remove('trips', trip2.id, admin.id, op.id);
    assert.equal(await db.tripSeat.count({ where: { tripId: trip2.id } }), 0);
    assert.ok((await db.auditLog.findMany({ where: { operatorId: op.id, action: { startsWith: 'DELETE_' } } })).length >= 6, 'every deletion is audited');

    // A driver and their private operator leave together, sessions included.
    const leaver = await makeDriver(db, admin.id, 'spare');
    await login('DRIVER', leaver.email, leaver.password);
    await assert.rejects(remove('drivers', leaver.id, admin.id, other.id), status(404), 'a foreign driver looks missing');
    await remove('drivers', leaver.id, admin.id);
    assert.equal(await db.driver.count({ where: { id: leaver.id } }), 0);
    assert.equal(await db.session.count({ where: { driverId: leaver.id } }), 0, 'driver sessions go with the account');
    assert.equal(await db.operator.count({ where: { id: leaver.operatorId } }), 0, 'the private operator goes with its driver');
    assert.equal(await db.auditLog.count({ where: { targetId: leaver.id, action: 'DELETE_drivers' } }), 1);

    // While a driver owns anything the account stays; once it is gone, the account can go.
    const owner = await makeDriver(db, admin.id, 'owner');
    const scope = owner.operatorId;
    const held: [string, () => Promise<{ id: string }>, (id: string) => Promise<unknown>][] = [
      [
        'vehicle',
        () => save('vehicles', { name: 'K', registration: 'K-' + id, type: 'Bus', operator: 'CRUD', operatorContact: '9800000000', emergencyContact: '9800000000', seatLabels: ['A1'] }, admin.id, false, scope),
        (x) => remove('vehicles', x, admin.id, scope),
      ],
      [
        'route',
        () => save('routes', { originId: a.id, destinationId: c.id, distanceKm: 10, durationMinutes: 10, baseFare: 10 }, admin.id, false, scope),
        (x) => remove('routes', x, admin.id, scope),
      ],
      [
        'QR account',
        () => save('payment-qr', { label: 'Kept', imageKey: qrImage.id, accountName: 'CRUD', instructions: 'Pay' }, admin.id, false, scope),
        (x) => remove('payment-qr', x, admin.id, scope),
      ],
      [
        'seat layout',
        () => createLayout(scope, admin.id, { name: 'Kept ' + id, vehicleType: 'Bus', template: 'coach_2x2_40' }),
        (x) => deleteLayout(scope, admin.id, x),
      ],
    ];
    for (const [what, make, drop] of held) {
      const record = await make();
      await assert.rejects(remove('drivers', owner.id, admin.id), status(409), 'a driver with a ' + what + ' stays');
      await drop(record.id);
    }
    await remove('drivers', owner.id, admin.id);
    assert.equal(await db.operator.count({ where: { id: scope } }), 0);

    // Deactivation signs the driver out and closes sales on their scheduled trips; reactivating reopens neither.
    assert.equal((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).bookingOpen, true);
    await login('DRIVER', driver.email, driver.password);
    await save('drivers', { ...driver, active: false }, admin.id, true);
    assert.equal(await db.session.count({ where: { driverId: driver.id } }), 0, 'deactivation ends sessions');
    assert.equal((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).bookingOpen, false, 'sales are closed');
    await assert.rejects(login('DRIVER', driver.email, driver.password), status(401));
    await save('drivers', { ...driver, active: true }, admin.id, true);
    await login('DRIVER', driver.email, driver.password);
    assert.equal((await db.trip.findUniqueOrThrow({ where: { id: trip.id } })).bookingOpen, false, 'sales stay closed until reopened on purpose');
  } finally {
    await db.$disconnect();
  }
});
