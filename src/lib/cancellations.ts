import { z } from 'zod';
import type { BookingStatus, PaymentStatus, Prisma, RefundStatus } from '@prisma/client';
import { serial } from './bookings';
import { ApiError } from './security';

/** Bookings in these states still hold or claim something and may be cancelled; the rest are already closed. */
export const CANCELLABLE: readonly BookingStatus[] = ['HELD', 'PAYMENT_REVIEW', 'CONFIRMED', 'PAYMENT_RECONCILIATION_REQUIRED'];

/**
 * What a cancellation owes the customer. Only money the operator verified is refundable; a proof that was
 * submitted but never verified needs the operator to check their bank first. No fee is deducted here:
 * the reviewer approves the amount (never above what was paid) when acting on the refund.
 */
export function refundFor(payment: { status: PaymentStatus; verifiedAmount: number | null } | null, amount: number) {
  if (payment?.status === 'VERIFIED') return { refundStatus: 'PENDING' as RefundStatus, paidAmount: payment.verifiedAmount ?? amount };
  if (payment && ['SUBMITTED', 'UNDER_REVIEW'].includes(payment.status))
    return { refundStatus: 'REVIEW_REQUIRED' as RefundStatus, paidAmount: 0 };
  return { refundStatus: 'NOT_REQUIRED' as RefundStatus, paidAmount: 0 };
}

/** Allowed refund moves. Cancelling never marks money as returned; completion needs its own reference. */
export const REFUND_STEPS: Record<string, { from: readonly RefundStatus[]; to: RefundStatus }> = {
  received: { from: ['REVIEW_REQUIRED'], to: 'PENDING' },
  'not-received': { from: ['REVIEW_REQUIRED'], to: 'NOT_REQUIRED' },
  approve: { from: ['PENDING'], to: 'APPROVED' },
  complete: { from: ['APPROVED'], to: 'COMPLETED' },
  decline: { from: ['PENDING', 'APPROVED'], to: 'DECLINED' },
};

const cancelInput = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const refundInput = z
  .object({
    action: z.enum(['received', 'not-received', 'approve', 'complete', 'decline']),
    note: z.string().trim().min(3).max(1000),
    amount: z.coerce.number().int().positive().max(10000000).optional(),
    reference: z.string().trim().min(2).max(100).optional(),
  })
  .strict();

export async function cancelBooking(id: string, actorId: string, raw: unknown, scope: string | null) {
  const d = cancelInput.parse(raw);
  return serial((tx) => cancelInTx(tx, id, actorId, d.reason, scope));
}

/** One booking's cancellation inside the caller's transaction, so a trip can resolve all its passengers atomically. */
async function cancelInTx(tx: Prisma.TransactionClient, id: string, actorId: string, reason: string, scope: string | null) {
  const b = await tx.booking.findFirst({
    where: { id, ...(scope ? { operatorId: scope } : {}) },
    include: { trip: true, payment: true, cancellation: true, customer: true },
  });
  if (!b) throw new ApiError(404, 'Booking not found.');
  if (b.cancellation || b.status === 'CANCELLED') throw new ApiError(409, 'This booking is already cancelled.');
  if (!CANCELLABLE.includes(b.status))
    throw new ApiError(409, 'A ' + b.status.toLowerCase() + ' booking holds no seats and cannot be cancelled.');
  // A cancelled trip is exactly when its passengers must be resolved, whatever the clock says.
  if (b.trip.status !== 'CANCELLED' && (['DEPARTED', 'COMPLETED'].includes(b.trip.status) || b.trip.departure <= new Date()))
    throw new ApiError(409, 'The trip has already departed. Record the outcome as a reconciliation note instead.');
  const { refundStatus, paidAmount } = refundFor(b.payment, b.amount);
  const cancellation = await tx.bookingCancellation.create({
    data: { bookingId: b.id, operatorId: b.operatorId, actorId, reason, previousStatus: b.status, paidAmount, refundStatus },
  });
  // Status first: the seat trigger refuses to release seats of a booking that is still CONFIRMED.
  const booking = await tx.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  const released = await tx.bookingSeat.updateMany({ where: { bookingId: b.id, active: true }, data: { active: false } });
  await tx.seatHold.updateMany({ where: { bookingId: b.id, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
  await tx.auditLog.create({
    data: {
      actorId,
      operatorId: b.operatorId,
      action: 'BOOKING_CANCELLED',
      targetId: b.id,
      details: { reason, previousStatus: b.status, paymentStatus: b.payment?.status ?? null, paidAmount, refundStatus, seatsReleased: released.count },
    },
  });
  const message =
    'Sajilo Yatra ' + b.reference + ': your booking was cancelled by the driver. Reason: ' + reason +
    (refundStatus === 'NOT_REQUIRED' ? '' : ' Any payment you made will be reviewed for a refund; the driver will contact you.');
  await tx.notificationOutbox.create({
    data: {
      bookingId: b.id,
      dedupeKey: 'BOOKING_CANCELLED:' + b.id,
      ...(b.customer.email
        ? { channel: 'EMAIL', recipient: b.customer.email, subject: 'Sajilo Yatra ' + b.reference + ': booking cancelled' }
        : { recipient: b.customer.phone }),
      message,
      expectedStatus: 'CANCELLED',
    },
  });
  return { id: booking.id, reference: booking.reference, status: booking.status, cancellation, seatsReleased: released.count };
}

const NEXT_TRIP_STATUS: Record<string, readonly string[]> = {
  SCHEDULED: ['BOARDING', 'DEPARTED', 'CANCELLED'],
  BOARDING: ['DEPARTED', 'CANCELLED'],
  DEPARTED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};
/** Trips only move forward; a cancelled or completed trip is final. */
export const tripTransitionAllowed = (from: string, to: string) => from === to || (NEXT_TRIP_STATUS[from] ?? []).includes(to);

/**
 * Cancels a trip and every booking still on it, in one transaction. Paid passengers get a pending refund record
 * each; nothing is marked as refunded. `canCancelBookings` is false when the caller may not cancel bookings.
 */
export async function cancelTrip(id: string, actorId: string, raw: unknown, scope: string | null, canCancelBookings: boolean) {
  const d = cancelInput.parse(raw);
  return serial(async (tx) => {
    const trip = await tx.trip.findFirst({ where: { id, ...(scope ? { operatorId: scope } : {}) } });
    if (!trip) throw new ApiError(404, 'Trip not found.');
    if (!tripTransitionAllowed(trip.status, 'CANCELLED') || trip.status === 'CANCELLED')
      throw new ApiError(409, 'A ' + trip.status.toLowerCase() + ' trip cannot be cancelled.');
    const active = await tx.booking.findMany({ where: { tripId: id, status: { in: [...CANCELLABLE] } }, select: { id: true } });
    if (active.length && !canCancelBookings)
      throw new ApiError(403, 'This trip has ' + active.length + ' active booking(s); cancelling them needs the bookings.cancel permission.');
    await tx.trip.update({ where: { id }, data: { status: 'CANCELLED', bookingOpen: false } });
    await tx.tripDriverAssignment.updateMany({ where: { tripId: id, endedAt: null }, data: { endedAt: new Date() } });
    const results = [];
    for (const b of active) results.push(await cancelInTx(tx, b.id, actorId, 'Trip cancelled: ' + d.reason, scope));
    await tx.auditLog.create({
      data: { actorId, operatorId: trip.operatorId, action: 'TRIP_CANCELLED', targetId: id, details: { reason: d.reason, bookingsCancelled: results.length } },
    });
    return {
      id,
      status: 'CANCELLED',
      bookingsCancelled: results.length,
      refundsToReview: results.filter((r) => r.cancellation.refundStatus !== 'NOT_REQUIRED').length,
    };
  });
}

export async function updateRefund(id: string, actorId: string, raw: unknown, scope: string | null) {
  const d = refundInput.parse(raw);
  return serial(async (tx) => {
    const c = await tx.bookingCancellation.findFirst({
      where: { bookingId: id, ...(scope ? { operatorId: scope } : {}) },
      include: { booking: { include: { payment: true } } },
    });
    if (!c) throw new ApiError(404, 'Cancelled booking not found.');
    const step = REFUND_STEPS[d.action];
    if (!step.from.includes(c.refundStatus))
      throw new ApiError(409, 'A refund that is ' + c.refundStatus.toLowerCase().replace('_', ' ') + ' cannot be moved that way.');
    const data: Record<string, unknown> = { refundStatus: step.to, refundNote: d.note, refundUpdatedById: actorId, refundUpdatedAt: new Date() };
    if (d.action === 'received') {
      // The amount is what the bank shows arrived, capped by what the customer claimed to have sent.
      const claimed = c.booking.payment?.claimedAmount ?? 0;
      if (!d.amount || d.amount > Math.max(claimed, c.booking.amount))
        throw new ApiError(400, 'Enter the amount your bank or wallet shows as received (at most the amount claimed).');
      data.paidAmount = d.amount;
    }
    if (d.action === 'approve') {
      const amount = d.amount ?? c.paidAmount;
      if (amount < 1 || amount > c.paidAmount) throw new ApiError(400, 'A refund cannot exceed the ' + c.paidAmount + ' that was paid.');
      data.refundAmount = amount;
    }
    if (d.action === 'complete') {
      if (!d.reference) throw new ApiError(400, 'Record the bank or wallet reference of the refund.');
      data.refundReference = d.reference;
    }
    const updated = await tx.bookingCancellation.update({ where: { id: c.id }, data });
    await tx.auditLog.create({
      data: {
        actorId,
        operatorId: c.operatorId,
        action: 'REFUND_' + d.action.toUpperCase().replace('-', '_'),
        targetId: c.bookingId,
        details: { from: c.refundStatus, to: step.to, note: d.note, amount: (data.refundAmount ?? data.paidAmount ?? null) as number | null, reference: d.reference ?? null },
      },
    });
    return updated;
  });
}
