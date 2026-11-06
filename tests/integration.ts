import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { reserve, serial, expire, submitProof, review } from '../src/lib/bookings';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_DB_TESTS === '1';
test(
  'PostgreSQL booking safety: concurrency, evidence, review expiry, late verification, scheduling and immutable audit',
  { skip: !enabled },
  async () => {
    const db = new PrismaClient();
    const suffix = randomUUID(),
      now = Date.now(),
      future = new Date(now + 86400000),
      arrival = new Date(now + 90000000);
    // Use an isolated disposable database. Records intentionally remain for debugging.
    const admin = await db.adminUser.create({
      data: { email: suffix + '@test.local', name: 'Test admin', passwordHash: 'not-used' },
    });
    const op = await db.operator.create({
      data: { name: 'Test operator ' + suffix, slug: 'test-' + suffix.slice(0, 8), status: 'ACTIVE' },
    });
    const driver = await db.driver.create({
      data: {
        operatorId: op.id,
        email: suffix + 'driver@test.local',
        name: 'Driver',
        passwordHash: 'not-used',
        mobile: '9800000000',
        licenseNumber: suffix,
        licenseExpiry: new Date(now + 1e11),
        emergencyContact: '9800000000',
      },
    });
    const vehicle = await db.vehicle.create({
      data: {
        operatorId: op.id,
        name: suffix,
        registration: suffix,
        type: 'Bus',
        operator: 'Test',
        operatorContact: '9800000000',
        emergencyContact: '9800000000',
        amenities: [],
        seats: {
          create: [
            { label: 'A1', row: 0, column: 0 },
            { label: 'A2', row: 0, column: 1 },
          ],
        },
      },
      include: { seats: true },
    });
    const origin = await db.location.create({ data: { name: 'origin-' + suffix } }),
      destination = await db.location.create({ data: { name: 'destination-' + suffix } });
    const route = await db.route.create({
      data: {
        operatorId: op.id,
        originId: origin.id,
        destinationId: destination.id,
        baseFare: 1000,
        distanceKm: 100,
        durationMinutes: 60,
      },
    });
    const qr = await db.paymentQR.create({
      data: {
        operatorId: op.id,
        label: 'Test bank',
        imageKey: 'fixture-private-qr',
        accountName: 'Test operator',
        instructions: 'Test only',
      },
    });
    const trip = await db.trip.create({
      data: {
        operatorId: op.id,
        vehicleId: vehicle.id,
        routeId: route.id,
        paymentQRId: qr.id,
        departure: future,
        arrival,
        fare: 1000,
        boardingPoint: 'Origin',
        dropPoint: 'Destination',
        tripFares: { create: [{ fromIdx: 0, toIdx: 1, amount: 1000 }] },
        seats: { create: vehicle.seats.map((s) => ({ vehicleSeatId: s.id })) },
        assignments: { create: { driverId: driver.id, startsAt: future, endsAt: arrival } },
      },
      include: { seats: true },
    });
    const make = (seat: string, name: string) =>
      reserve({
        tripId: trip.id,
        name,
        phone: '+9779800000000',
        seats: [seat],
        idempotencyKey: randomUUID(),
      });
    try {
      const race = await Promise.allSettled([
        make(trip.seats[0].id, 'One'),
        make(trip.seats[0].id, 'Two'),
      ]);
      assert.equal(
        race.filter((r) => r.status === 'fulfilled').length,
        1,
        'exactly one concurrent claim wins',
      );
      const winning = race.find((r) => r.status === 'fulfilled');
      assert.ok(winning && winning.status === 'fulfilled');
      const first = winning.value.booking;
      assert.equal(
        await db.bookingSeat.count({ where: { tripSeatId: trip.seats[0].id, active: true } }),
        1,
      );
      await submitProof(
        first.id,
        { id: 'fixture-proof', mime: 'image/webp', bytes: 1000 },
        { claimedAmount: 1000, method: 'BANK', transactionRef: 'DUP-' + suffix },
      );
      assert.equal(
        (await db.payment.findUnique({ where: { bookingId: first.id } }))?.status,
        'SUBMITTED',
        'screenshot never auto-verifies',
      );
      await db.booking.update({ where: { id: first.id }, data: { expiresAt: new Date(0) } });
      await serial((tx) => expire(tx, trip.id));
      assert.equal(
        (await db.booking.findUnique({ where: { id: first.id } }))?.status,
        'PAYMENT_RECONCILIATION_REQUIRED',
      );
      assert.equal(
        await db.paymentProof.count({ where: { payment: { bookingId: first.id } } }),
        1,
        'expired review retains evidence',
      );
      const replacement = await make(trip.seats[0].id, 'Replacement');
      await submitProof(
        replacement.booking.id,
        { id: 'fixture-proof-2', mime: 'image/webp', bytes: 1000 },
        { claimedAmount: 1000, method: 'BANK', transactionRef: 'DUP-' + suffix },
      );
      const payment = await db.payment.findUniqueOrThrow({ where: { bookingId: first.id } });
      assert.equal(payment.duplicateReference, true);
      const late = await review(payment.id, admin.id, {
        action: 'verify',
        verifiedAmount: 1000,
        note: 'Actual bank evidence checked',
        bankEvidence: 'ledger-' + suffix,
        confirm: true,
        acknowledgeDuplicate: true,
      });
      assert.equal(late.status, 'PAYMENT_RECONCILIATION_REQUIRED');
      assert.equal(
        (await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status,
        'VERIFIED',
      );
      const p2 = await db.payment.findUniqueOrThrow({
        where: { bookingId: replacement.booking.id },
      });
      await review(p2.id, admin.id, {
        action: 'verify',
        verifiedAmount: 1000,
        note: 'Distinct actual transfer checked',
        bankEvidence: 'second ledger',
        confirm: true,
        acknowledgeDuplicate: true,
      });
      await db.booking.update({
        where: { id: replacement.booking.id },
        data: { expiresAt: new Date(0) },
      });
      await serial((tx) => expire(tx, trip.id));
      assert.equal(
        (await db.booking.findUniqueOrThrow({ where: { id: replacement.booking.id } })).status,
        'CONFIRMED',
      );
      await assert.rejects(
        () =>
          db.bookingSeat.updateMany({
            where: { bookingId: replacement.booking.id },
            data: { active: false },
          }),
        'DB prevents release of confirmed seats',
      );
      await assert.rejects(
        () =>
          db.trip.create({
            data: {
              operatorId: op.id,
              vehicleId: vehicle.id,
              routeId: route.id,
              paymentQRId: qr.id,
              departure: future,
              arrival,
              fare: 1000,
              boardingPoint: 'Origin',
              dropPoint: 'Destination',
            },
          }),
        'overlapping vehicle schedule rejected',
      );
      const audit = await db.auditLog.findFirstOrThrow({ where: { targetId: first.id } });
      await assert.rejects(
        () => db.auditLog.update({ where: { id: audit.id }, data: { action: 'TAMPER' } }),
        'audit cannot be altered',
      );
      const rejected = await make(trip.seats[1].id, 'Rejected proof');
      await submitProof(
        rejected.booking.id,
        { id: 'rejected-proof', mime: 'image/webp', bytes: 1000 },
        { claimedAmount: 1000, method: 'BANK' },
      );
      const rejectedPayment = await db.payment.findUniqueOrThrow({
        where: { bookingId: rejected.booking.id },
      });
      await review(rejectedPayment.id, admin.id, {
        action: 'reject',
        note: 'Transfer not present in actual bank records',
      });
      assert.equal(
        (await db.booking.findUniqueOrThrow({ where: { id: rejected.booking.id } })).status,
        'REJECTED',
      );
      assert.equal(
        await db.bookingSeat.count({ where: { bookingId: rejected.booking.id, active: true } }),
        0,
        'rejected proof releases the seat',
      );
      const unpaid = await make(trip.seats[1].id, 'Abandoned');
      await db.booking.update({
        where: { id: unpaid.booking.id },
        data: { expiresAt: new Date(0) },
      });
      await assert.rejects(
        () =>
          submitProof(
            unpaid.booking.id,
            { id: 'too-late', mime: 'image/webp', bytes: 1000 },
            { claimedAmount: 1000, method: 'BANK' },
          ),
        'proof after the hold deadline is rejected',
      );
      await serial((tx) => expire(tx, trip.id));
      assert.equal(
        (await db.booking.findUniqueOrThrow({ where: { id: unpaid.booking.id } })).status,
        'EXPIRED',
      );
    } finally {
      await db.$disconnect();
    }
  },
);
