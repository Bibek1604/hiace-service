import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { save } from '../src/lib/admin';
import { reserve } from '../src/lib/bookings';
import { makeDriver } from './helpers';

const enabled = process.env.RUN_DB_TESTS === '1';
const phone = '+9779800000000';

// Requires an isolated, disposable database. Records intentionally remain for debugging.
test('segment inventory: overlapping legs race to one winner, adjacent legs both sell', { skip: !enabled }, async () => {
  const db = new PrismaClient();
  const id = randomUUID().slice(0, 8);
  try {
    const admin = await db.adminUser.create({ data: { email: id + '@seg.test', name: 'P', passwordHash: 'x' } });
    const driver = await makeDriver(db, admin.id, 'seg');
    const op = { id: driver.operatorId };
    const [ktm, mug, pkr] = await Promise.all(['Kathmandu', 'Mugling', 'Pokhara'].map((n) => db.location.create({ data: { name: `${n}-${id}` } })));
    const route = await save('routes', {
      originId: ktm.id, destinationId: pkr.id, distanceKm: 200, durationMinutes: 400, baseFare: 1000,
      stops: [{ locationId: mug.id, offsetMinutes: 150, kmFromOrigin: 80, allowBoarding: true, allowDropoff: true }],
    }, admin.id, false, op.id);
    const vehicle = await save('vehicles', {
      name: 'Bus', registration: 'S-' + id, type: 'Bus', operator: 'S', operatorContact: '9800000000',
      emergencyContact: '9800000000', seatLabels: ['A1', 'A2'],
    }, admin.id, false, op.id);
    const qr = await db.paymentQR.create({ data: { operatorId: op.id, label: 'q', imageKey: 'k', accountName: 'n', instructions: 'i' } });
    const dep = new Date(Date.now() + 864e5);
    const trip = await save('trips', {
      vehicleId: vehicle.id, routeId: route.id, driverId: driver.id, paymentQRId: qr.id,
      departure: dep.toISOString(), arrival: new Date(dep.getTime() + 8 * 36e5).toISOString(),
      boardingPoint: 'Kathmandu', dropPoint: 'Pokhara', fare: 1000,
    }, admin.id, false, op.id);

    const stored = await db.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { tripFares: true, seats: true } });
    assert.equal(stored.segmentCount, 2);
    const price = (f: number, t: number) => stored.tripFares.find((x) => x.fromIdx === f && x.toIdx === t)?.amount;
    assert.deepEqual([price(0, 2), price(0, 1), price(1, 2)], [1000, 400, 600]);

    const seatA = stored.seats[0].id;
    const go = (seat: string, from: string, to: string) =>
      reserve({ tripId: trip.id, seats: [seat], name: 'Guest', phone, idempotencyKey: randomUUID(), fromLocationId: from, toLocationId: to });

    // Two guests want the same seat for overlapping legs at once: exactly one succeeds.
    const raced = await Promise.allSettled([go(seatA, ktm.id, pkr.id), go(seatA, mug.id, pkr.id), go(seatA, ktm.id, mug.id)]);
    // KTM-PKR overlaps both others; the two short legs do not overlap each other.
    const won = raced.filter((r) => r.status === 'fulfilled').length;
    assert.ok(won === 1 || won === 2, `unexpected winner count ${won}`);
    if (won === 2) {
      assert.equal(raced[0].status, 'rejected', 'the full route cannot coexist with a shorter leg');
    }
    for (const r of raced) if (r.status === 'rejected') assert.equal((r.reason as { status?: number }).status, 409);

    // The price is the snapshot for the leg actually booked.
    for (const r of raced)
      if (r.status === 'fulfilled') {
        const b = r.value.booking;
        assert.equal(b.amount, price(b.fromIdx, b.toIdx));
      }

    // Walking the second seat through the legs one after another sells it twice without conflict.
    const seatB = stored.seats.find((s) => s.id !== seatA)!.id;
    const first = await go(seatB, ktm.id, mug.id);
    const second = await go(seatB, mug.id, pkr.id);
    assert.equal(first.booking.amount + second.booking.amount, 1000);
    await assert.rejects(go(seatB, ktm.id, pkr.id), (e: unknown) => (e as { status?: number }).status === 409);
    await assert.rejects(go(seatB, pkr.id, ktm.id), (e: unknown) => (e as { status?: number }).status === 400);
  } finally {
    await db.$disconnect();
  }
});
