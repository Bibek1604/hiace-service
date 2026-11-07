import { Prisma } from '@prisma/client';
import { db } from './db';
import { ApiError, hash, capability } from './security';
import { expirationStatus, normalizeReference } from './policy';
import { journeysOverlap, resolveJourney } from './route-stops';
import { timeAtStop, type TripStop } from './inventory';
import { queueTicketEmail } from './booking-email';
export async function serial<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const attempts = 6;
  for (let n = 0; n < attempts; n++) {
    try {
      return await db.$transaction(fn, { isolationLevel: 'Serializable', timeout: 15000 });
    } catch (e) {
      const conflict =
        (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') ||
        (e instanceof Error && /deadlock|could not serialize/i.test(e.message));
      if (conflict) {
        // Serialization failures are expected when many guests race for one seat: back off briefly, then retry.
        if (n < attempts - 1) {
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * (n + 1)));
          continue;
        }
        throw new ApiError(409, 'Concurrent change. Please retry.');
      }
      // Exclusion constraints and CHECKs reach Prisma only as raw errors that name the constraint.
      if (e instanceof Error && /vehicle_schedule_conflict|driver_schedule_conflict/.test(e.message))
        throw new ApiError(409, 'This vehicle or driver already has an overlapping trip.');
      if (e instanceof Error && e.message.includes('trip_booking_window_order'))
        throw new ApiError(400, 'Booking must open before it closes.');
      // P2002 is a unique violation; the segment exclusion constraint surfaces only by name in the message.
      if (
        (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') ||
        (e instanceof Error && e.message.includes('one_active_claim_per_seat'))
      )
        throw new ApiError(409, 'This seat or record is already reserved. Refresh and try again.');
      throw e;
    }
  }
  throw new ApiError(409, 'Concurrent change. Please retry.');
}
export async function expire(tx: Prisma.TransactionClient, tripId?: string) {
  const list = await tx.booking.findMany({
    where: {
      tripId,
      status: { in: ['HELD', 'PAYMENT_REVIEW'] },
      expiresAt: { lte: new Date() },
      payment: { is: { status: { not: 'VERIFIED' } } },
    },
    take: 200,
    orderBy: { expiresAt: 'asc' },
    include: { customer: true },
  });
  for (const b of list) {
    if (b.status === 'PAYMENT_REVIEW')
      await tx.notificationOutbox.upsert({
        where: { dedupeKey: 'HOLD_EXPIRED:' + b.id },
        create: {
          bookingId: b.id,
          dedupeKey: 'HOLD_EXPIRED:' + b.id,
          ...(b.customer.email
            ? { channel: 'EMAIL', recipient: b.customer.email, subject: 'Sajilo Yatra ' + b.reference + ': seats no longer guaranteed' }
            : { recipient: b.customer.phone }),
          message:
            'Sajilo Yatra ' +
            b.reference +
            ': your seat review hold has expired. Seats are no longer guaranteed. Your payment evidence is preserved for reconciliation. Check booking status or contact the driver.',
          expectedStatus: 'PAYMENT_RECONCILIATION_REQUIRED',
        },
        update: {},
      });

    await tx.bookingSeat.updateMany({
      where: { bookingId: b.id, active: true },
      data: { active: false },
    });
    await tx.seatHold.updateMany({
      where: { bookingId: b.id, status: 'ACTIVE' },
      data: { status: 'RELEASED' },
    });
    await tx.booking.update({
      where: { id: b.id },
      data: { status: expirationStatus(b.status) as 'EXPIRED' | 'PAYMENT_RECONCILIATION_REQUIRED' },
    });
    await tx.auditLog.create({
      data: {
        actorId: 'SYSTEM',
        operatorId: b.operatorId,
        action: 'HOLD_EXPIRED',
        targetId: b.id,
        details: { previousStatus: b.status, evidencePreserved: true },
      },
    });
  }
  return list.length;
}
export type ReserveInput = {
  tripId: string;
  name: string;
  phone: string;
  email?: string;
  seats: string[];
  idempotencyKey: string;
  /** Stops the passenger rides between; default is the whole route. */
  fromLocationId?: string;
  toLocationId?: string;
  boardingPointId?: string;
  dropPointId?: string;
};
export async function reserve(input: ReserveInput) {
  const access = capability(input.idempotencyKey),
    requestHash = hash(JSON.stringify({ ...input, seats: [...input.seats].sort() }));
  const booking = await serial(async (tx) => {
    const replay = await tx.booking.findUnique({
      where: { idempotencyKey: hash(input.idempotencyKey) },
    });
    if (replay) {
      if (replay.requestHash !== requestHash)
        throw new ApiError(409, 'Reservation request changed. Start a new reservation.');
      return replay;
    }
    await expire(tx, input.tripId);
    const trip = await tx.trip.findUnique({
      where: { id: input.tripId },
      include: {
        vehicle: true,
        route: { include: { destination: true } },
        tripFares: true,
        paymentQR: true,
        assignments: { where: { endedAt: null }, include: { driver: { select: { active: true, status: true } } } },
        seats: { include: { vehicleSeat: true, bookings: { where: { active: true } } } },
      },
    });
    if (
      !trip ||
      !trip.bookingOpen ||
      trip.status !== 'SCHEDULED' ||
      !trip.vehicle.active ||
      !trip.route.active ||
      !trip.paymentQR.active ||
      !trip.assignments.some((assignment) => assignment.driver.active && assignment.driver.status === 'ACTIVE') ||
      trip.departure <= new Date() ||
      (trip.bookingOpensAt !== null && trip.bookingOpensAt > new Date()) ||
      (trip.bookingClosesAt !== null && trip.bookingClosesAt <= new Date())
    )
      throw new ApiError(409, 'This trip is unavailable because its booking window is closed.');
    if (
      !input.seats.length ||
      input.seats.length > 8 ||
      new Set(input.seats).size !== input.seats.length
    )
      throw new ApiError(400, 'Select between one and eight unique seats.');
    const stops = trip.stopSnapshot as unknown as TripStop[];
    let journey;
    try {
      journey = resolveJourney(
        stops,
        input.fromLocationId ?? stops[0].locationId,
        input.toLocationId ?? stops[stops.length - 1].locationId,
      );
    } catch (e) {
      throw new ApiError(400, e instanceof RangeError ? e.message : 'Invalid journey.');
    }
    if (timeAtStop(trip.departure, stops, journey.from) <= new Date())
      throw new ApiError(409, 'The vehicle has already left that stop.');
    const fare = trip.tripFares.find((f) => f.fromIdx === journey.from && f.toIdx === journey.to);
    if (!fare) throw new ApiError(409, 'No fare is defined for this journey.');
    const points = await tx.boardingPoint.findMany({
      where: { id: { in: [input.boardingPointId, input.dropPointId].filter((x): x is string => !!x) } },
    });
    const pick = (id: string | undefined, kind: 'BOARDING' | 'DROPOFF', stop: TripStop) => {
      if (!id) return null;
      const p = points.find((x) => x.id === id);
      if (!p || p.routeId !== trip.routeId || p.kind !== kind || !p.active || p.locationId !== stop.locationId)
        throw new ApiError(400, 'That boarding or drop-off point is not available for this journey.');
      return p;
    };
    const boardAt = pick(input.boardingPointId, 'BOARDING', stops[journey.from]),
      dropAt = pick(input.dropPointId, 'DROPOFF', stops[journey.to]);
    const seats = trip.seats.filter((s) => input.seats.includes(s.id));
    // Only claims that share a segment with this journey block a seat; other legs stay sellable.
    const taken = (s: (typeof seats)[number]) =>
      s.bookings.some((c) => journeysOverlap(journey, { from: c.fromIdx, to: c.toIdx, segments: [] }));
    if (seats.length !== input.seats.length || seats.some((s) => s.blocked || taken(s)))
      throw new ApiError(409, 'A selected seat is unavailable. Refresh the seat map.');
    const settings = await tx.settings.upsert({ where: { id: 'global' }, create: {}, update: {} });
    const expiresAt = new Date(
      Math.min(Date.now() + settings.holdMinutes * 60000, trip.departure.getTime()),
    );
    const b = await tx.booking.create({
      data: {
        reference: 'SY-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase(),
        accessHash: hash(access),
        idempotencyKey: hash(input.idempotencyKey),
        requestHash,
        trip: { connect: { id: trip.id } },
        tenant: { connect: { id: trip.operatorId } },
        customer: { create: { name: input.name, phone: input.phone, email: input.email ?? null } },
        amount: fare.amount * seats.length,
        fareSnapshot: fare.amount,
        fromIdx: journey.from,
        toIdx: journey.to,
        ...(boardAt ? { boardingPoint: { connect: { id: boardAt.id } } } : {}),
        ...(dropAt ? { dropPoint: { connect: { id: dropAt.id } } } : {}),
        qrSnapshot: {
          label: trip.paymentQR.label,
          imageKey: trip.paymentQR.imageKey,
          accountName: trip.paymentQR.accountName,
          accountNumber: trip.paymentQR.accountNumber,
          instructions: trip.paymentQR.instructions,
        },
        expiresAt,
        seats: { create: seats.map((s) => ({ tripSeatId: s.id, fromIdx: journey.from, toIdx: journey.to })) },
        passengers: {
          create: seats.map((s) => ({
            name: input.name,
            phone: input.phone,
            seatLabel: s.vehicleSeat.label,
            boardingPoint: boardAt?.name ?? (journey.from === 0 ? trip.boardingPoint : stops[journey.from].name),
            destination: dropAt?.name ?? stops[journey.to].name,
          })),
        },
        payment: { create: { paymentQRId: trip.paymentQR.id } },
        hold: { create: { expiresAt } },
      },
    });
    return b;
  });
  return { booking, access };
}
export async function submitProof(
  id: string,
  proof: { id: string; mime: string; bytes: number },
  data: { claimedAmount: number; method: string; transactionRef?: string; remarks?: string },
) {
  return serial(async (tx) => {
    const b = await tx.booking.findUnique({
      where: { id },
      include: { payment: true, trip: true },
    });
    if (!b || b.status !== 'HELD' || b.expiresAt <= new Date() || !b.payment)
      throw new ApiError(409, 'The payment deadline passed. Contact the driver if you paid.');
    const config = await tx.settings.findUnique({ where: { id: 'global' } });
    const expiresAt = new Date(
      Math.min(Date.now() + (config?.reviewMinutes || 15) * 60000, b.trip.departure.getTime()),
    );
    if (expiresAt <= new Date())
      throw new ApiError(409, 'This trip has departed. Contact the driver.');
    const ref = data.transactionRef ? normalizeReference(data.transactionRef) : null;
    const duplicates = ref
      ? await tx.payment.findMany({
          where: { transactionRef: ref, id: { not: b.payment.id } },
          select: { id: true },
        })
      : [];
    if (duplicates.length)
      await tx.payment.updateMany({
        where: { id: { in: duplicates.map((p) => p.id) } },
        data: { duplicateReference: true },
      });
    await tx.payment.update({
      where: { id: b.payment.id },
      data: {
        status: 'SUBMITTED',
        claimedAmount: data.claimedAmount,
        method: data.method,
        transactionRef: ref,
        duplicateReference: duplicates.length > 0,
        proofs: {
          create: {
            imageKey: proof.id,
            mime: proof.mime,
            bytes: proof.bytes,
            remarks: data.remarks || '',
          },
        },
      },
    });
    await tx.seatHold.update({ where: { bookingId: id }, data: { expiresAt } });
    await tx.auditLog.create({
      data: {
        actorId: 'GUEST',
        operatorId: b.operatorId,
        action: 'PROOF_SUBMITTED',
        targetId: id,
        details: { proofId: proof.id, duplicateReference: duplicates.length > 0 },
      },
    });
    return tx.booking.update({ where: { id }, data: { status: 'PAYMENT_REVIEW', expiresAt } });
  });
}
export async function review(
  paymentId: string,
  actorId: string,
  input: {
    action: 'verify' | 'reject' | 'clarify';
    note: string;
    bankEvidence?: string;
    verifiedAmount?: number;
    confirm?: boolean;
    acknowledgeDuplicate?: boolean;
  },
  scope: string | null = null,
) {
  return serial(async (tx) => {
    await expire(tx);
    const p = await tx.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: { include: { seats: { include: { tripSeat: true } }, trip: true } },
        proofs: true,
      },
    });
    // A payment of another operator is reported as missing, never as forbidden.
    if (!p || (scope && p.booking.operatorId !== scope))
      throw new ApiError(404, 'Payment not found.');
    if (p.status === 'VERIFIED') throw new ApiError(409, 'Payment has already been verified.');
    if (!p.proofs.length) throw new ApiError(409, 'Payment proof is required.');
    const b = p.booking;
    if (b.status === 'CANCELLED')
      throw new ApiError(409, 'This booking was cancelled. Settle the payment through its refund record instead.');
    // A rejected booking has released its seats, which may already be resold; a decision is final.
    if (p.status === 'REJECTED' || !['PAYMENT_REVIEW', 'PAYMENT_RECONCILIATION_REQUIRED'].includes(b.status))
      throw new ApiError(409, 'This payment was already decided. Ask the passenger to make a new booking.');
    if (
      input.action === 'verify' &&
      (!Number.isSafeInteger(input.verifiedAmount) || input.verifiedAmount! < b.amount)
    )
      throw new ApiError(
        400,
        'Record the actual received amount; full fare is required for confirmation.',
      );
    if (input.action === 'verify' && (!input.confirm || !input.bankEvidence?.trim()))
      throw new ApiError(400, 'Confirm verification against bank or wallet evidence.');
    if (input.action === 'verify' && p.duplicateReference && !input.acknowledgeDuplicate)
      throw new ApiError(409, 'Investigate the duplicate reference and explicitly acknowledge it.');
    let next = b.status;
    if (input.action === 'verify') {
      // Another booking only conflicts when it holds the same seat on an overlapping leg.
      const occupied = await tx.bookingSeat.count({
        where: {
          tripSeatId: { in: b.seats.map((s) => s.tripSeatId) },
          active: true,
          bookingId: { not: b.id },
          fromIdx: { lt: b.toIdx },
          toIdx: { gt: b.fromIdx },
        },
      });
      const possible =
        !occupied &&
        !b.seats.some((s) => s.tripSeat.blocked) &&
        b.trip.departure > new Date() &&
        b.trip.status === 'SCHEDULED';
      if (possible) {
        await tx.bookingSeat.updateMany({ where: { bookingId: b.id }, data: { active: true } });
        next = 'CONFIRMED';
        await tx.seatHold.update({ where: { bookingId: b.id }, data: { status: 'CONVERTED' } });
      } else {
        next = 'PAYMENT_RECONCILIATION_REQUIRED';
        await tx.bookingSeat.updateMany({ where: { bookingId: b.id }, data: { active: false } });
        await tx.seatHold.update({ where: { bookingId: b.id }, data: { status: 'RELEASED' } });
      }
    } else if (input.action === 'reject') {
      await tx.bookingSeat.updateMany({ where: { bookingId: b.id }, data: { active: false } });
      await tx.seatHold.update({ where: { bookingId: b.id }, data: { status: 'RELEASED' } });
      next = 'REJECTED';
    }
    await tx.payment.update({
      where: { id: p.id },
      data: {
        status:
          input.action === 'verify'
            ? 'VERIFIED'
            : input.action === 'reject'
              ? 'REJECTED'
              : 'UNDER_REVIEW',
        reviewedById: actorId,
        reviewedAt: new Date(),
        note: input.note,
        ...(input.action === 'verify' ? { verifiedAmount: input.verifiedAmount } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        operatorId: b.operatorId,
        action: 'PAYMENT_' + input.action.toUpperCase(),
        targetId: b.id,
        details: {
          paymentId: p.id,
          note: input.note,
          bankEvidence: input.bankEvidence || null,
          verifiedAmount: input.verifiedAmount || null,
          duplicateAcknowledged: !!input.acknowledgeDuplicate,
          result: next,
        },
      },
    });
    const updated = await tx.booking.update({ where: { id: b.id }, data: { status: next } });
    if (next === 'CONFIRMED') await queueTicketEmail(tx, b.id);
    return updated;
  });
}
