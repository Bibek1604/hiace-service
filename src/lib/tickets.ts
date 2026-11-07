import { SignJWT, jwtVerify } from 'jose';
import { db } from './db';
import { ApiError } from './security';

const key = (min = 32) => {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < min) throw new ApiError(503, 'Tickets can’t be prepared right now. Your booking is safe, so please try again shortly.');
  return new TextEncoder().encode(secret);
};

/** Signed ticket code for a confirmed, paid booking; valid until a day after departure. */
export async function signTicket(b: { id: string; reference: string; tripId: string; status: string; payment: { status: string } | null; trip: { departure: Date } }) {
  if (b.status !== 'CONFIRMED' || b.payment?.status !== 'VERIFIED')
    throw new ApiError(409, 'Only confirmed paid bookings have tickets.');
  return new SignJWT({ reference: b.reference, tripId: b.tripId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(b.id)
    .setIssuer('sajilo-yatra')
    .setAudience('driver-manifest')
    .setIssuedAt()
    .setExpirationTime(Math.floor((b.trip.departure.getTime() + 86400000) / 1000))
    .sign(key());
}

/** Verifies a ticket code and returns the booking it names, which must still be confirmed and paid. */
export async function verifyTicket(ticket: string) {
  let sub: string | undefined;
  try {
    sub = (await jwtVerify(ticket.trim(), key(1), { issuer: 'sajilo-yatra', audience: 'driver-manifest', algorithms: ['HS256'] })).payload.sub;
  } catch {
    throw new ApiError(400, 'Invalid or expired ticket.');
  }
  const b = await db.booking.findUnique({
    where: { id: sub || '' },
    include: {
      payment: { select: { status: true } },
      passengers: { select: { id: true, name: true, seatLabel: true, boardingPoint: true, destination: true, checkIn: { select: { status: true } } } },
      trip: { select: { id: true, operatorId: true, departure: true, status: true, vehicle: { select: { name: true, registration: true } }, route: { select: { origin: { select: { name: true } }, destination: { select: { name: true } } } } } },
    },
  });
  if (!b || b.status !== 'CONFIRMED' || b.payment?.status !== 'VERIFIED')
    throw new ApiError(409, 'Ticket is not a confirmed paid booking.');
  return b;
}

/** What a checker may see about a verified ticket: no phone numbers, payment details or tokens. */
export const ticketSummary = (b: Awaited<ReturnType<typeof verifyTicket>>) => ({
  verified: true,
  reference: b.reference,
  tripId: b.tripId,
  trip: {
    departure: b.trip.departure,
    status: b.trip.status,
    vehicle: b.trip.vehicle.name + ' · ' + b.trip.vehicle.registration,
    route: b.trip.route.origin.name + ' → ' + b.trip.route.destination.name,
  },
  passengers: b.passengers.map((p) => ({ name: p.name, seat: p.seatLabel, boarding: p.boardingPoint, destination: p.destination, checkIn: p.checkIn?.status ?? 'PENDING' })),
});
