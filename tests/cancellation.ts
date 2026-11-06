import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { save } from '../src/lib/admin';
import { reserve, review, submitProof } from '../src/lib/bookings';
import { cancelBooking, cancelTrip, updateRefund } from '../src/lib/cancellations';
import { tripManifest } from '../src/lib/manifest';
import { signTicket, verifyTicket } from '../src/lib/tickets';
import { makeDriver, makeTenant } from './helpers';

const enabled = process.env.RUN_DB_TESTS === '1';
const status = (n: number) => (e: unknown) => (e as { status?: number }).status === n;

// Requires an isolated, disposable database.
test('bookings cancel through an audited state machine and refunds are tracked separately', { skip: !enabled }, async () => {
  process.env.SESSION_SECRET ||= 'test-secret-'.padEnd(40, 'x');
  const db = new PrismaClient();
  const id = randomUUID().slice(0, 8);
  try {
    const admin = await db.adminUser.create({ data: { email: id + '@cancel.test', name: 'Platform', passwordHash: 'unused' } });
    const driver = await makeDriver(db, admin.id, 'cancel');
    const op = { id: driver.operatorId };
    const other = await makeTenant(db, 'cother');
    const [a, c] = await Promise.all(['A', 'C'].map((n) => save('locations', { name: `${n}-c-${id}` }, admin.id, false)));
    const route = await save('routes', { originId: a.id, destinationId: c.id, distanceKm: 100, durationMinutes: 120, baseFare: 1000 }, admin.id, false, op.id);
    const vehicle = await save(
      'vehicles',
      { name: 'V', registration: 'CV-' + id, type: 'Bus', operator: 'Cancel', operatorContact: '9800000000', emergencyContact: '9800000000', seatLabels: ['A1', 'A2', 'A10', 'B1'] },
      admin.id, false, op.id,
    );
    const img = await db.storedObject.create({ data: { id: 'cqr-' + id, mime: 'image/webp', bytes: 10, purpose: 'qr', ownerId: admin.id } });
    const qr = await save('payment-qr', { label: 'Bank', imageKey: img.id, accountName: 'C', instructions: 'Pay' }, admin.id, false, op.id);
    const dep = new Date(Date.now() + 2 * 864e5);
    const trip = await save(
      'trips',
      { vehicleId: vehicle.id, routeId: route.id, driverId: driver.id, paymentQRId: qr.id, departure: dep.toISOString(), arrival: new Date(dep.getTime() + 2 * 36e5).toISOString(), boardingPoint: 'A', dropPoint: 'C', fare: 1000 },
      admin.id, false, op.id,
    );
    const seats = await db.tripSeat.findMany({ where: { tripId: trip.id }, include: { vehicleSeat: true } });
    const seat = (label: string) => seats.find((s) => s.vehicleSeat.label === label)!.id;
    const book = (label: string, name = 'Guest') =>
      reserve({ tripId: trip.id, seats: [seat(label)], name, phone: '+9779800000000', idempotencyKey: randomUUID() }).then((r) => r.booking);
    const pay = async (bookingId: string) => {
      await submitProof(bookingId, { id: 'proof-' + randomUUID(), mime: 'image/webp', bytes: 10 }, { claimedAmount: 1000, method: 'Bank' });
      return (await db.payment.findUniqueOrThrow({ where: { bookingId } })).id;
    };

    // 1. An unpaid hold: cancelled, no refund owed, and the seat can be sold again at once.
    const held = await book('A1');
    await assert.rejects(cancelBooking(held.id, admin.id, { reason: 'x' }, op.id), (e) => e instanceof Error, 'a reason is required');
    await assert.rejects(cancelBooking(held.id, admin.id, { reason: 'Customer asked' }, other.id), status(404), 'another tenant sees nothing');
    const r1 = await cancelBooking(held.id, admin.id, { reason: 'Customer asked' }, op.id);
    assert.equal(r1.status, 'CANCELLED');
    assert.equal(r1.cancellation.refundStatus, 'NOT_REQUIRED');
    assert.equal(r1.seatsReleased, 1);
    await assert.rejects(cancelBooking(held.id, admin.id, { reason: 'Again please' }, op.id), status(409), 'no double cancellation');
    await book('A1');

    // 2. A confirmed, paid booking: ticket and manifest work; after cancelling, both stop and a refund is pending.
    const paid = await book('A2', '=HYPERLINK("http://evil")');
    const paymentId = await pay(paid.id);
    await review(paymentId, admin.id, { action: 'verify', note: 'Bank ok', bankEvidence: 'stmt 1', verifiedAmount: 1000, confirm: true }, op.id);
    const confirmed = await db.booking.findUniqueOrThrow({ where: { id: paid.id }, include: { payment: true, trip: true } });
    assert.equal(confirmed.status, 'CONFIRMED');
    const ticket = await signTicket(confirmed);
    assert.equal((await verifyTicket(ticket)).reference, paid.reference);
    const manifest = await tripManifest(trip.id, op.id);
    assert.equal(manifest.count, 1);
    assert.ok(manifest.body.startsWith('﻿"Trip ID"'), 'UTF-8 BOM and header');
    assert.ok(manifest.body.includes('"\'=HYPERLINK(""http://evil"")"'), 'formula cells are defused and quotes escaped');
    assert.ok(!manifest.body.includes('proof-'), 'no payment evidence in the manifest');
    await assert.rejects(tripManifest(trip.id, other.id), status(404), 'manifests are tenant-scoped');

    const r2 = await cancelBooking(paid.id, admin.id, { reason: 'Customer asked for refund' }, op.id);
    assert.equal(r2.cancellation.refundStatus, 'PENDING');
    assert.equal(r2.cancellation.paidAmount, 1000);
    assert.equal(await db.bookingSeat.count({ where: { bookingId: paid.id, active: true } }), 0, 'seat released');
    await assert.rejects(verifyTicket(ticket), status(409), 'a cancelled ticket no longer validates');
    assert.equal((await tripManifest(trip.id, op.id)).count, 0, 'cancelled passengers leave the manifest');
    await assert.rejects(review(paymentId, admin.id, { action: 'reject', note: 'Too late now' }, op.id), status(409));
    await assert.rejects(updateRefund(paid.id, admin.id, { action: 'complete', note: 'paid back', reference: 'R1' }, op.id), status(409), 'approve before completing');
    await assert.rejects(updateRefund(paid.id, admin.id, { action: 'approve', note: 'too much', amount: 1001 }, op.id), status(400), 'never more than was paid');
    await assert.rejects(updateRefund(paid.id, admin.id, { action: 'approve', note: 'Looks fine' }, other.id), status(404));
    assert.equal((await updateRefund(paid.id, admin.id, { action: 'approve', note: 'Policy: 10% fee', amount: 900 }, op.id)).refundStatus, 'APPROVED');
    await assert.rejects(updateRefund(paid.id, admin.id, { action: 'complete', note: 'sent' }, op.id), status(400), 'completion needs a reference');
    const done = await updateRefund(paid.id, admin.id, { action: 'complete', note: 'Sent by eSewa', reference: 'ES-1' }, op.id);
    assert.equal(done.refundStatus, 'COMPLETED');
    assert.equal(done.refundAmount, 900);
    const trail = (await db.auditLog.findMany({ where: { targetId: paid.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.action);
    assert.deepEqual(trail.slice(-3), ['BOOKING_CANCELLED', 'REFUND_APPROVE', 'REFUND_COMPLETE']);

    // 3. Trips only move forward.
    await assert.rejects(
      save('trips', { ...{ vehicleId: vehicle.id, routeId: route.id, driverId: driver.id, paymentQRId: qr.id, departure: dep.toISOString(), arrival: new Date(dep.getTime() + 2 * 36e5).toISOString(), boardingPoint: 'A', dropPoint: 'C', fare: 1000 }, id: trip.id, status: 'COMPLETED' }, admin.id, true, op.id),
      status(409),
      'a scheduled trip cannot jump to completed',
    );

    // 4. Cancelling the trip resolves every remaining passenger in one step.
    const review2 = await book('A10');
    await pay(review2.id);
    await assert.rejects(cancelTrip(trip.id, admin.id, { reason: 'Bus breakdown' }, op.id, false), status(403), 'needs bookings.cancel when passengers exist');
    const tc = await cancelTrip(trip.id, admin.id, { reason: 'Bus breakdown' }, op.id, true);
    assert.equal(tc.bookingsCancelled, 2, 'the re-sold A1 hold and the A10 proof under review');
    assert.equal(tc.refundsToReview, 1);
    const t = await db.trip.findUniqueOrThrow({ where: { id: trip.id }, include: { assignments: { where: { endedAt: null } } } });
    assert.equal(t.status, 'CANCELLED');
    assert.equal(t.bookingOpen, false);
    assert.equal(t.assignments.length, 0, 'driver released');
    const c3 = await db.bookingCancellation.findUniqueOrThrow({ where: { bookingId: review2.id } });
    assert.equal(c3.refundStatus, 'REVIEW_REQUIRED');
    assert.equal((await updateRefund(review2.id, admin.id, { action: 'received', note: 'Seen on statement', amount: 1000 }, op.id)).refundStatus, 'PENDING');
    await assert.rejects(cancelTrip(trip.id, admin.id, { reason: 'Again' }, op.id, true), status(409));
  } finally {
    await db.$disconnect();
  }
});
