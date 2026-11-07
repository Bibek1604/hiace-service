import { archiveLayout, createLayout, deleteLayout, getLayout, listLayouts, publishLayout, saveDraft } from './layouts';
import { deletePoint, routeDetail, savePoint } from './route-points';
import { saveSegmentFare, segmentFares } from './segment-fares';
import { classifyError, describeError } from './api-error';
import { dispatchNotifications } from './notifications';
import { getSiteContent, saveSiteContent } from './site-content-db';
import { queueTicketEmail } from './booking-email';
import { emailConfigured, sendEmail } from './mailer';
import { signTicket, ticketSummary, verifyTicket } from './tickets';
import { tripManifest } from './manifest';
import { cancelBooking, cancelTrip, updateRefund } from './cancellations';
import { randomUUID, randomInt } from 'node:crypto';
import { login } from './auth';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from './db';
import {
  ApiError,
  hash,
  token,
  same,
  staff,
  guest,
  guestCookie,
  originGuard,
  limit,
  clientKey,
} from './security';
import { serial, expire, reserve, submitProof, review } from './bookings';
import { upload, readObject, multipart } from './storage';
import { auditLog, catalog, list, remove, reportSummary, save } from './admin';
import { matchJourney, seatStateFor, timeAtStop, type TripStop } from './inventory';
import { resolveJourney } from './route-stops';
import { searchTripIds } from './trip-search';
import { NEPAL_MOBILE, NEPAL_MOBILE_MESSAGE, normalizePhone } from './phone';
import {
  cancelOwnTrip,
  controlOwnSchedule,
  changePassword,
  createOfflineBooking,
  createOwnerDriver,
  deleteOwnResource,
  createOwnTrip,
  createOwnSchedules,
  cancelOwnBooking,
  fleet,
  getProfile,
  driverDashboard,
  driverHistory,
  listSubmissions,
  ownBookings,
  ownSchedules,
  ownTrips,
  ownTripAvailability,
  reviewOwnPayment,
  setOwnSeatBlocked,
  reviewSubmission,
  submit,
  updateOwnTrip,
  updateProfile,
} from './driver-portal';
const phone = z.string().trim().regex(NEPAL_MOBILE, NEPAL_MOBILE_MESSAGE).transform(normalizePhone);
const reservation = z.object({
  tripId: z.string().min(1),
  seats: z.array(z.string().min(1)).min(1).max(8),
  name: z.string().trim().min(2).max(100),
  phone,
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toLowerCase().email().max(254).optional()),
  idempotencyKey: z.string().min(32).max(128),
  fromLocationId: z.string().min(1).optional(),
  toLocationId: z.string().min(1).optional(),
  boardingPointId: z.string().min(1).optional(),
  dropPointId: z.string().min(1).optional(),
});
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function body(req: Request) {
  const text = await bounded(req, 65536);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Invalid JSON.');
  }
}
async function bounded(req: Request, max: number) {
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, 'Body required.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new ApiError(413, 'Request too large.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function pagination(url: URL) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(url.searchParams.get('page') || 1);
}
/** What the public may see of a vehicle: no internal notes, emergency contacts or owner ids. */
const publicVehicle = {
  select: {
    id: true,
    name: true,
    registration: true,
    type: true,
    operator: true,
    operatorContact: true,
    description: true,
    amenities: true,
    active: true,
    images: { orderBy: { position: 'asc' as const } },
  },
};
const publicAssignments = {
  where: { endedAt: null },
  select: { driver: { select: { name: true, photoKey: true, active: true, status: true } } },
};
/** Search only needs seat counts, so it skips seat geometry and route stops. */
const listInclude = {
  vehicle: publicVehicle,
  route: { include: { origin: true, destination: true } },
  assignments: publicAssignments,
  seats: {
    select: {
      id: true,
      blocked: true,
      bookings: {
        where: { active: true },
        select: { fromIdx: true, toIdx: true, booking: { select: { status: true, expiresAt: true } } },
      },
    },
  },
  tripFares: true,
};
const tripInclude = {
  vehicle: publicVehicle,
  paymentQR: { select: { active: true } },
  route: {
    include: {
      origin: true,
      destination: true,
      stops: { include: { location: true }, orderBy: { position: 'asc' as const } },
    },
  },
  assignments: publicAssignments,
  seats: {
    include: {
      vehicleSeat: true,
      bookings: {
        where: { active: true },
        select: {
          fromIdx: true,
          toIdx: true,
          booking: { select: { status: true, expiresAt: true } },
        },
      },
    },
  },
};
/** The trip fields shown to anyone; ownership, schedule and payment-account ids stay on the server. */
function publicTrip<T extends { vehicle: { active: boolean }; assignments: { driver: { name: string; photoKey: string | null } }[] }>(t: T) {
  const { operatorId, paymentQRId, scheduleId, recurringRule, stopSnapshot, segmentCount, ...rest } = t as T & Record<string, unknown>;
  void [operatorId, paymentQRId, scheduleId, recurringRule, stopSnapshot, segmentCount];
  const { active, ...vehicle } = t.vehicle;
  void active;
  return { ...rest, vehicle, assignments: t.assignments.map(({ driver }) => ({ driver: { name: driver.name, photoKey: driver.photoKey } })) };
}
/** Whether a passenger can book this trip right now. Mirrors the checks in reserve(). */
function bookableNow(t: {
  status: string;
  bookingOpen: boolean;
  bookingOpensAt: Date | null;
  bookingClosesAt: Date | null;
  departure: Date;
  vehicle: { active: boolean };
  route: { active: boolean };
  paymentQR: { active: boolean };
  assignments: { driver: { active: boolean; status: string } }[];
}) {
  const now = new Date();
  return (
    t.status === 'SCHEDULED' &&
    t.bookingOpen &&
    t.departure > now &&
    t.vehicle.active &&
    t.route.active &&
    t.paymentQR.active &&
    t.assignments.some(({ driver }) => driver.active && driver.status === 'ACTIVE') &&
    (!t.bookingOpensAt || t.bookingOpensAt <= now) &&
    (!t.bookingClosesAt || t.bookingClosesAt > now)
  );
}
async function assigned(tripId: string, driverId: string) {
  const a = await db.tripDriverAssignment.findFirst({
    where: { tripId, driverId, endedAt: null },
    include: { trip: { select: { operatorId: true } } },
  });
  if (!a) throw new ApiError(404, 'Assigned trip not found.');
  return a;
}
export async function handle(req: Request, path: string[]) {
  const url = new URL(req.url),
    method = req.method,
    key = path.join('/');
  try {
    if (method !== 'GET' && key !== 'jobs/expire') originGuard(req);
    if (key === 'locations' && method === 'GET')
      return json(
        await db.location.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      );
    if (key === 'health' && method === 'GET') {
      try {
        // A connection-only probe can pass while the deployed database is missing migrations.
        // Check a stable application table as well, without reading customer data.
        await db.location.findFirst({ select: { id: true } });
        return json({ status: 'ready', database: 'up', schema: 'up' });
      } catch (e) {
        console.error(JSON.stringify({ route: 'health', error: describeError(e) }));
        return json({ status: 'degraded', database: 'down', error: 'The database or its schema is not ready.' }, 503);
      }
    }
    if (key === 'auth/login' && method === 'POST') {
      await limit('login:' + clientKey(req), 30);
      const d = z
        .object({
          role: z.enum(['ADMIN', 'DRIVER']),
          email: z.email().transform((v) => v.toLowerCase()),
          password: z.string().min(1).max(128),
        })
        .parse(await body(req));
      await limit('login-account:' + hash(d.email), 10);
      const secret = await login(d.role, d.email, d.password);
      (await cookies()).set('staff_session', secret, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 43200,
      });
      return json({ role: d.role });
    }
    if (key === 'auth/logout' && method === 'POST') {
      const jar = await cookies(),
        s = jar.get('staff_session')?.value;
      if (s) await db.session.deleteMany({ where: { id: hash(s) } });
      jar.delete('staff_session');
      return json({ ok: true });
    }
    if (path[0] === 'trips' && method === 'GET') {
      if (path[1]) {
        await serial((tx) => expire(tx, path[1]));
        const t = await db.trip.findUnique({ where: { id: path[1] }, include: tripInclude });
        if (!t) throw new ApiError(404, 'Trip not found.');
        const stops = t.stopSnapshot as unknown as TripStop[];
        let journey;
        try {
          journey = resolveJourney(
            stops,
            url.searchParams.get('from') ?? stops[0].locationId,
            url.searchParams.get('to') ?? stops[stops.length - 1].locationId,
          );
        } catch (e) {
          throw new ApiError(400, e instanceof RangeError ? e.message : 'Invalid journey.');
        }
        const [fares, points] = await Promise.all([
          db.tripFare.findMany({ where: { tripId: t.id } }),
          db.boardingPoint.findMany({
            where: { routeId: t.routeId, active: true },
            select: { id: true, locationId: true, kind: true, name: true, landmark: true, extraMinutes: true },
          }),
        ]);
        const { paymentQR, ...visible } = publicTrip(t);
        void paymentQR;
        return json({
          ...visible,
          bookingOpen: bookableNow(t),
          stops,
          journey: { from: journey.from, to: journey.to },
          fare: fares.find((f) => f.fromIdx === journey.from && f.toIdx === journey.to)?.amount ?? null,
          fares,
          points,
          boardsAt: timeAtStop(t.departure, stops, journey.from),
          dropsAt: timeAtStop(t.departure, stops, journey.to),
          seats: t.seats.map((s) => ({
            id: s.id,
            label: s.vehicleSeat.label,
            row: s.vehicleSeat.row,
            column: s.vehicleSeat.column,
            deck: s.vehicleSeat.deck,
            category: s.vehicleSeat.category,
            state: seatStateFor(
              s.blocked,
              s.bookings.map((b) => ({ ...b.booking, fromIdx: b.fromIdx, toIdx: b.toIdx })),
              journey,
            ),
          })),
        });
      }
      const page = pagination(url),
        date = url.searchParams.get('date');
      let range: Prisma.DateTimeFilter = { gte: new Date() };
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'Invalid date.');
        const start = new Date(date + 'T00:00:00+05:45');
        if (Number.isNaN(start.getTime())) throw new ApiError(400, 'Invalid date.');
        range = {
          gte: new Date(Math.max(start.getTime(), Date.now())),
          lt: new Date(start.getTime() + 86400000),
        };
      }
      const wantFrom = url.searchParams.get('origin')?.slice(0, 120) ?? '',
        wantTo = url.searchParams.get('destination')?.slice(0, 120) ?? '';
      const found = await searchTripIds({ origin: wantFrom, destination: wantTo, from: range.gte as Date, to: range.lt as Date | undefined, page, size: 25 });
      const rows = await db.trip.findMany({ where: { id: { in: found.ids } }, include: listInclude });
      const trips = found.ids.flatMap((id) => rows.filter((t) => t.id === id));
      // A trip matches when the searched places appear on it in travel order, not only at its two ends.
      const items = trips.flatMap((t) => {
        const stops = t.stopSnapshot as unknown as TripStop[];
        const journey = matchJourney(stops, wantFrom, wantTo);
        if (!journey) return [];
        const claimsOf = (s: (typeof t.seats)[number]) =>
          s.bookings.map((b) => ({ ...b.booking, fromIdx: b.fromIdx, toIdx: b.toIdx }));
        return [
          {
            ...publicTrip(t),
            seats: undefined,
            tripFares: undefined,
            stops,
            journey: { from: journey.from, to: journey.to },
            fare: t.tripFares.find((f) => f.fromIdx === journey.from && f.toIdx === journey.to)?.amount ?? null,
            boardsAt: timeAtStop(t.departure, stops, journey.from),
            dropsAt: timeAtStop(t.departure, stops, journey.to),
            available: t.seats.filter((s) => seatStateFor(s.blocked, claimsOf(s), journey) === 'AVAILABLE').length,
          },
        ];
      });
      return json({ items, nextPage: found.nextPage });
    }
    if (key === 'bookings' && method === 'POST') {
      await limit('book:' + clientKey(req), 50);
      const d = reservation.parse(await body(req));
      await limit('book-phone:' + hash(d.phone), 15);
      const { booking, access } = await reserve(d);
      await guestCookie(booking.id, access);
      return json({ id: booking.id, reference: booking.reference }, 201);
    }
    if (path[0] === 'bookings' && path[1]) {
      const b = await guest(path[1]);
      if (method === 'GET' && path.length === 2) {
        await serial((tx) => expire(tx, b.tripId));
        const current = await guest(b.id);
        const stops = current.trip.stopSnapshot as unknown as TripStop[],
          { active, maintenanceNote, emergencyContact, operatorId, layoutVersionId, ...vehicle } = current.trip.vehicle;
        void [active, maintenanceNote, emergencyContact, operatorId, layoutVersionId];
        return json({
          ...current,
          accessHash: undefined,
          idempotencyKey: undefined,
          requestHash: undefined,
          operatorId: undefined,
          trip: { ...current.trip, vehicle, operatorId: undefined, paymentQRId: undefined, scheduleId: undefined, recurringRule: undefined, stopSnapshot: undefined },
          // Times and places of this passenger's own journey, which may be only part of the route.
          journey: {
            from: stops[current.fromIdx]?.name ?? current.trip.route.origin.name,
            to: stops[current.toIdx]?.name ?? current.trip.route.destination.name,
            boardsAt: stops[current.fromIdx] ? timeAtStop(current.trip.departure, stops, current.fromIdx) : current.trip.departure,
            dropsAt: stops[current.toIdx] ? timeAtStop(current.trip.departure, stops, current.toIdx) : current.trip.arrival,
            boardingPoint: current.passengers[0]?.boardingPoint ?? current.trip.boardingPoint,
            dropPoint: current.passengers[0]?.destination ?? current.trip.dropPoint,
          },
          payment: current.payment ? { ...current.payment, reviewedById: undefined } : null,
        });
      }
      if (method === 'GET' && path[2] === 'history') {
        const items = await db.auditLog.findMany({
          where: { targetId: b.id },
          orderBy: { createdAt: 'asc' },
          take: 100,
          select: { action: true, createdAt: true },
        });
        return json({ items });
      }
      if (method === 'GET' && path[2] === 'ticket') {
        return json({ ticket: await signTicket(b) });
      }
      if (method === 'POST' && path[2] === 'clarification') {
        const d = z.object({ message: z.string().trim().min(3).max(2000) }).parse(await body(req));
        if (!['PAYMENT_REVIEW', 'PAYMENT_RECONCILIATION_REQUIRED'].includes(b.status))
          throw new ApiError(409, 'This booking is not awaiting clarification.');
        await limit('clarification:' + b.id, 10);
        await db.auditLog.create({
          data: {
            actorId: 'GUEST',
            operatorId: b.operatorId,
            action: 'CUSTOMER_CLARIFICATION',
            targetId: b.id,
            details: { message: d.message },
          },
        });
        return json({ message: 'Your message was recorded.' });
      }
      if (method === 'POST' && path[2] === 'proof') {
        await limit('proof:' + b.id, 8);
        const f = await multipart(req),
          file = f.get('image');
        if (!(file instanceof File)) throw new ApiError(400, 'Payment image required.');
        const data = z
          .object({
            claimedAmount: z.coerce.number().int().positive().max(10000000),
            method: z.string().min(1).max(80),
            transactionRef: z.string().max(100).optional(),
            remarks: z.string().max(1000).optional(),
          })
          .parse(Object.fromEntries([...f].filter(([k]) => k !== 'image')));
        if (b.status !== 'HELD' || b.expiresAt <= new Date())
          throw new ApiError(409, 'The hold has expired. Contact the driver if you paid.');
        const proof = await upload(file, 'proof', b.id);
        await submitProof(b.id, proof, data);
        return json(
          { message: 'Payment proof submitted. Your booking is awaiting verification.' },
          201,
        );
      }
    }
    if (key === 'track/request' && method === 'POST') {
      await limit('track:' + clientKey(req), 20);
      const d = z
        .object({ reference: z.string().trim().toUpperCase().min(5).max(40), phone })
        .parse(await body(req));
      await limit('otp-phone:' + hash(d.phone), 5);
      const smsOn = !!(process.env.SMS_HTTP_URL && process.env.SMS_HTTP_TOKEN),
        mailOn = emailConfigured(),
        // With no delivery channel, development prints the code to the server console instead of failing.
        consoleOn = !smsOn && !mailOn && (process.env.NODE_ENV !== 'production' || process.env.OTP_CONSOLE === 'on');
      if (!smsOn && !mailOn && !consoleOn)
        throw new ApiError(503, 'Booking verification is temporarily unavailable. Contact the driver.');
      const b = await db.booking.findFirst({
        where: { reference: d.reference, customer: { phone: d.phone } },
        include: { customer: true },
      });
      const code = String(randomInt(100000, 1000000)),
        salt = token();
      const challenge = await db.phoneChallenge.create({
        data: {
          reference: d.reference,
          phoneHash: hash(d.phone),
          codeHash: hash(salt + code),
          expiresAt: new Date(Date.now() + 300000),
        },
      });
      if (b) {
        const message =
          'Your Sajilo Yatra booking access code is ' + code + '. It expires in 5 minutes.';
        // The code goes to the email given at booking when there is one; otherwise to the phone by SMS.
        if (consoleOn) {
          console.warn('[dev] booking access code for ' + d.reference + ': ' + code + ' (configure SMTP or SMS for real delivery)');
        } else if (b.customer.email && mailOn) {
          try {
            await sendEmail({
              to: b.customer.email,
              subject: 'Your Sajilo Yatra access code',
              text: message,
            });
          } catch {
            throw new ApiError(503, 'Unable to send the verification code. Try later.');
          }
        } else if (smsOn) {
          const endpoint = new URL(process.env.SMS_HTTP_URL!);
          if (endpoint.protocol !== 'https:' && process.env.NODE_ENV === 'production')
            throw new ApiError(503, 'SMS gateway must use HTTPS.');
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + process.env.SMS_HTTP_TOKEN,
            },
            body: JSON.stringify({ to: d.phone, message }),
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok)
            throw new ApiError(503, 'Unable to send the verification code. Try later.');
        } else if (process.env.NODE_ENV !== 'production') {
          console.warn('[dev] booking access code for ' + d.reference + ': ' + code + ' (no channel can reach this booking)');
        }
      }
      (await cookies()).set('otp_' + challenge.id, salt, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 300,
      });
      return json({
        challengeId: challenge.id,
        message: 'If your details match a booking, a code has been sent to the email or phone used for the booking.',
      });
    }
    if (key === 'track/verify' && method === 'POST') {
      await limit('otp-verify:' + clientKey(req), 40);
      const d = z
          .object({ challengeId: z.string().max(100), code: z.string().regex(/^\d{6}$/) })
          .parse(await body(req)),
        salt = (await cookies()).get('otp_' + d.challengeId)?.value;
      const access = token();
      const id = await serial(async (tx) => {
        const changed = await tx.phoneChallenge.updateMany({
          where: {
            id: d.challengeId,
            usedAt: null,
            expiresAt: { gt: new Date() },
            attempts: { lt: 5 },
          },
          data: { attempts: { increment: 1 } },
        });
        if (!changed.count) return null;
        const c = (await tx.phoneChallenge.findUnique({ where: { id: d.challengeId } }))!;
        if (!salt || !same(hash(salt + d.code), c.codeHash)) return null;
        const b = await tx.booking.findUnique({
          where: { reference: c.reference },
          include: { customer: true },
        });
        if (!b || hash(b.customer.phone) !== c.phoneHash) return null;
        await tx.phoneChallenge.update({ where: { id: c.id }, data: { usedAt: new Date() } });
        await tx.booking.update({ where: { id: b.id }, data: { accessHash: hash(access) } });
        return b.id;
      });
      if (!id) throw new ApiError(400, 'Invalid or expired code.');
      await guestCookie(id, access);
      (await cookies()).delete('otp_' + d.challengeId);
      return json({ id });
    }
    if (path[0] === 'admin') {
      const admin = await staff('ADMIN'),
        resource = path[1];

      if (method === 'DELETE') {
        if (!path[2]) throw new ApiError(400, 'Record ID required.');
        if (resource === 'seat-layouts') return json(await deleteLayout(null, admin.id, path[2]));
        if (resource === 'route-points') return json(await deletePoint(null, admin.id, path[2]));
        return json(await remove(resource, path[2], admin.id, null));
      }
      if (resource === 'seat-layouts') {
        if (method === 'GET') return json(path[2] ? await getLayout(null, path[2]) : await listLayouts(null));
        if (method === 'PATCH') return json(await saveDraft(null, admin.id, await body(req)));
        if (path[2] && path[3] === 'publish') return json(await publishLayout(null, admin.id, path[2]));
        if (path[2] && path[3] === 'archive') return json(await archiveLayout(null, admin.id, path[2]));
        return json(await createLayout(null, admin.id, await body(req)), 201);
      }
      if (resource === 'segment-fares') {
        if (method === 'GET' && path[2])
          return json(await segmentFares(null, path[2], url.searchParams.get('vehicleType') ?? 'Bus'));
        if (method !== 'GET') return json(await saveSegmentFare(null, admin.id, await body(req)));
        throw new ApiError(404, 'Not found.');
      }
      if (resource === 'route-points') {
        if (method === 'GET' && path[2]) return json(await routeDetail(null, path[2]));
        if (method !== 'GET') return json(await savePoint(null, admin.id, await body(req)), method === 'POST' ? 201 : 200);
        throw new ApiError(404, 'Not found.');
      }

      if (resource === 'bookings' && path[2]) {
        const id = path[2];
        if (path[3] === 'cancel' && method === 'POST') {
          const result = await cancelBooking(id, admin.id, await body(req), null);
          void dispatchNotifications().catch(() => undefined);
          return json(result);
        }
        if (path[3] === 'refund' && method === 'POST') return json(await updateRefund(id, admin.id, await body(req), null));
        if (path[3] === 'ticket' && method === 'GET') {
          const b = await db.booking.findFirst({
            where: { id,  },
            include: {
              payment: { select: { status: true } },
              customer: { select: { name: true, phone: true } },
              passengers: { select: { name: true, seatLabel: true, boardingPoint: true, destination: true } },
              trip: { include: { vehicle: { select: { name: true, registration: true } }, route: { include: { origin: true, destination: true } } } },
            },
          });
          if (!b) throw new ApiError(404, 'Booking not found.');
          return json({
            ticket: await signTicket(b),
            reference: b.reference,
            amount: b.amount,
            customer: b.customer,
            passengers: b.passengers,
            trip: { departure: b.trip.departure, arrival: b.trip.arrival, vehicle: b.trip.vehicle, route: b.trip.route.origin.name + ' → ' + b.trip.route.destination.name },
          });
        }
        if (!path[3] && method === 'GET') {
          const b = await db.booking.findFirst({
            where: { id,  },
            select: {
              id: true, reference: true, status: true, amount: true, fareSnapshot: true, expiresAt: true, createdAt: true,
              customer: true,
              cancellation: true,
              passengers: { select: { id: true, name: true, phone: true, seatLabel: true, boardingPoint: true, destination: true, checkIn: { select: { status: true } } } },
              payment: { select: { id: true, status: true, method: true, claimedAmount: true, verifiedAmount: true, transactionRef: true, duplicateReference: true, reviewedAt: true, note: true } },
              trip: { select: { id: true, departure: true, arrival: true, status: true, vehicle: { select: { name: true, registration: true } }, route: { select: { origin: { select: { name: true } }, destination: { select: { name: true } } } } } },
            },
          });
          if (!b) throw new ApiError(404, 'Booking not found.');
          const history = await db.auditLog.findMany({ where: { targetId: b.id }, orderBy: { createdAt: 'asc' }, take: 100 });
          return json({ ...b, history });
        }
        if (method === 'GET') throw new ApiError(404, 'Not found.');
      }
      if (resource === 'trips' && path[2] && path[3] === 'cancel' && method === 'POST') {
        const result = await cancelTrip(path[2], admin.id, await body(req), null, true);
        void dispatchNotifications().catch(() => undefined);
        return json(result);
      }
      if (resource === 'trips' && path[2] && path[3] === 'manifest' && method === 'GET') {
        const m = await tripManifest(path[2], null);
        await db.auditLog.create({
          data: { actorId: admin.id, operatorId: null, action: 'MANIFEST_DOWNLOADED', targetId: path[2], details: { passengers: m.count } },
        });
        return new Response(m.body, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="' + m.filename + '"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (resource === 'validate-ticket' && method === 'POST') {
        const d = z.object({ ticket: z.string().min(10).max(5000) }).parse(await body(req));
        const b = await verifyTicket(d.ticket);
        await db.auditLog.create({
          data: { actorId: admin.id, operatorId: b.trip.operatorId, action: 'TICKET_VALIDATED', targetId: b.id, details: { tripId: b.tripId } },
        });
        return json(ticketSummary(b));
      }
      if (resource === 'trip-seats' && method === 'PATCH') {
        const d = z
          .object({
            tripSeatId: z.string(),
            blocked: z.boolean(),
            note: z.string().min(3).max(1000),
          })
          .parse(await body(req));
        return json(
          await serial(async (tx) => {
            await expire(tx);
            const s = await tx.tripSeat.findFirst({
              where: { id: d.tripSeatId,  },
              include: { bookings: { where: { active: true } } },
            });
            if (!s) throw new ApiError(404, 'Seat not found.');
            if (d.blocked && s.bookings.length)
              throw new ApiError(409, 'A reserved seat cannot be blocked.');
            const result = await tx.tripSeat.update({
              where: { id: s.id },
              data: { blocked: d.blocked },
            });
            await tx.auditLog.create({
              data: {
                actorId: admin.id,
                operatorId: null,
                action: d.blocked ? 'BLOCK_SEAT' : 'UNBLOCK_SEAT',
                targetId: s.tripId,
                details: { seatId: s.id, note: d.note },
              },
            });
            return result;
          }),
        );
      }
      if (resource === 'reconciliation' && method === 'POST') {
        const d = z
          .object({
            bookingId: z.string(),
            outcome: z.string().min(3).max(100),
            note: z.string().min(3).max(2000),
          })
          .parse(await body(req));
        return json(
          await serial(async (tx) => {
            const b = await tx.booking.findFirst({
              where: { id: d.bookingId,  },
            });
            if (!b || b.status !== 'PAYMENT_RECONCILIATION_REQUIRED')
              throw new ApiError(409, 'Booking does not require reconciliation.');
            await tx.payment.update({
              where: { bookingId: b.id },
              data: { note: d.outcome + ': ' + d.note },
            });
            return tx.auditLog.create({
              data: {
                actorId: admin.id,
                operatorId: null,
                action: 'RECONCILIATION_NOTE',
                targetId: b.id,
                details: { outcome: d.outcome, note: d.note },
              },
            });
          }),
        );
      }
      if (resource === 'owners' && method === 'GET')
        return json({ items: await db.operator.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 1000 } ) });
      if (resource === 'drivers' && method === 'POST') return json(await createOwnerDriver(await body(req), admin.id), 201);
      if (resource === 'driver-submissions') {
        if (method === 'GET' && !path[2])
          return json(await listSubmissions(url.searchParams.get('status') ?? undefined, pagination(url)));
        if (method === 'POST' && path[2] && !path[3]) return json(await reviewSubmission(path[2], admin.id, await body(req)));
        throw new ApiError(404, 'Not found.');
      }
      if (resource === 'catalog' && method === 'GET') return json(await catalog(null));
      if (resource === 'site-content') {
        if (method === 'GET') return json(await getSiteContent());
        if (method === 'PATCH' || method === 'POST')
          return json(await saveSiteContent(await body(req), admin.id));
      }
      if (resource === 'uploads' && method === 'POST') {
        await limit('admin-upload:' + admin.id, 100);
        const form = await multipart(req),
          file = form.get('image'),
          purpose = z.enum(['qr', 'vehicle', 'driver', 'site']).parse(form.get('purpose'));
        if (!(file instanceof File)) throw new ApiError(400, 'Choose an image.');
        return json(await upload(file, purpose, admin.id), 201);
      }
      if (resource === 'payments' && path[2] && method === 'POST') {
        const data = z
          .object({
            action: z.enum(['verify', 'reject', 'clarify']),
            note: z.string().trim().min(3).max(2000),
            bankEvidence: z.string().max(1000).optional(),
            verifiedAmount: z.coerce.number().int().positive().max(10000000).optional(),
            confirm: z.boolean().optional(),
            acknowledgeDuplicate: z.boolean().optional(),
          })
          .parse(await body(req));
        const reviewed = await review(path[2], admin.id, data, null);
        // Best effort: the worker retries anything that does not go out now.
        void dispatchNotifications().catch(() => undefined);
        return json(reviewed);
      }
      if (resource === 'manual-bookings' && method === 'POST') {
        const data = z
          .object({
            ...reservation.shape,
            method: z.enum(['CASH', 'QR', 'UNPAID']),
            confirm: z.boolean().default(false),
            note: z.string().min(3).max(1000),
            bankEvidence: z.string().max(1000).optional(),
          })
          .parse(await body(req));
        if (data.method !== 'UNPAID' && (!data.confirm || !data.bankEvidence))
          throw new ApiError(400, 'Confirm receipt and record cash or bank evidence.');
        const { booking } = await reserve(reservation.parse(data));
        await serial(async (tx) => {
          const b = await tx.booking.findUnique({
            where: { id: booking.id },
            include: { payment: true, seats: true },
          });
          if (!b || b.status !== 'HELD' || b.expiresAt <= new Date())
            throw new ApiError(409, 'Manual booking is no longer held.');
          if (data.method !== 'UNPAID') {
            await tx.payment.update({
              where: { bookingId: b.id },
              data: {
                status: 'VERIFIED',
                method: data.method,
                claimedAmount: b.amount,
                verifiedAmount: b.amount,
                reviewedById: admin.id,
                reviewedAt: new Date(),
                note: data.note,
              },
            });
            await tx.booking.update({ where: { id: b.id }, data: { status: 'CONFIRMED' } });
            await tx.seatHold.update({ where: { bookingId: b.id }, data: { status: 'CONVERTED' } });
            await queueTicketEmail(tx, b.id);
          }
          await tx.auditLog.create({
            data: {
              actorId: admin.id,
              operatorId: b.operatorId,
              action: 'MANUAL_BOOKING',
              targetId: b.id,
              details: {
                method: data.method,
                note: data.note,
                evidence: data.bankEvidence || null,
              },
            },
          });
        });
        return json({ id: booking.id, reference: booking.reference }, 201);
      }
      if (resource === 'vehicle-profile' && path[2] && method === 'GET') {
        const v = await db.vehicle.findFirst({
          where: { id: path[2],  },
          include: {
            images: true,
            seats: true,
            trips: {
              take: 50,
              orderBy: { departure: 'desc' },
              include: {
                route: { include: { origin: true, destination: true } },
                assignments: { include: { driver: { select: { id: true, name: true } } } },
                bookings: { select: { id: true, reference: true, status: true, amount: true } },
              },
            },
          },
        });
        if (!v) throw new ApiError(404, 'Vehicle not found.');
        return json(v);
      }
      if (resource === 'audit-log' && method === 'GET')
        return json(
          await auditLog(pagination(url), {
            q: url.searchParams.get('q')?.trim().slice(0, 100) || undefined,
            action: url.searchParams.get('action')?.trim().slice(0, 80) || undefined,
          }),
        );
      if (resource === 'audit' && method === 'GET')
        return json(
          await db.auditLog.findMany({
            where: {
              targetId: url.searchParams.get('targetId') || undefined,
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
          }),
        );
      if (resource === 'reports' && method === 'GET') {
        const days = z.coerce.number().int().refine((value) => [1, 7, 30].includes(value), 'Choose 1, 7, or 30 days.').parse(url.searchParams.get('days') || '1');
        return json(await reportSummary(days));
      }
      if (method === 'GET') {
        const page = pagination(url),
          rows = await list(resource, page, null, {
            q: url.searchParams.get('q')?.trim().slice(0, 100) || undefined,
            status: url.searchParams.get('status') || undefined,
            upcoming: url.searchParams.get('upcoming') === '1',
          });
        return json({ items: rows.slice(0, 25), nextPage: rows.length > 25 ? page + 1 : null });
      }
      if (method === 'POST' || method === 'PATCH')
        return json(
          await save(resource, await body(req), admin.id, method === 'PATCH', null),
          method === 'POST' ? 201 : 200,
        );
    }
    if (path[0] === 'driver') {
      const driver = await staff('DRIVER');
      if (path[1] === 'dashboard' && method === 'GET')
        return json(await driverDashboard(driver.id, url.searchParams.get('days') || '1'));
      if (path[1] === 'history' && method === 'GET') return json({ items: await driverHistory(driver.id) });
      if (path[1] === 'profile') {
        if (method === 'GET') return json(await getProfile(driver.id));
        if (method === 'PATCH') return json(await updateProfile(driver.id, await body(req)));
      }
      if (path[1] === 'password' && method === 'POST') return json(await changePassword(driver.id, await body(req)));
      if (path[1] === 'fleet' && method === 'GET') return json(await fleet(driver.id));
      if (path[1] === 'schedules') {
        if (method === 'GET' && !path[2]) return json({ items: await ownSchedules(driver.id) });
        if (method === 'POST' && !path[2]) return json(await createOwnSchedules(driver.id, await body(req)), 201);
        if (method === 'PATCH' && path[2]) return json({ items: await controlOwnSchedule(driver.id, path[2], await body(req)) });
      }
      if (path[1] === 'submissions') throw new ApiError(404, 'Driver approval requests are no longer used.');
      if (path[1] === 'resources' && method === 'POST')
        return json(await submit(driver.id, await body(req)), 201);
      if (path[1] === 'resources' && path[2] && path[3] && method === 'DELETE')
        return json(await deleteOwnResource(driver.id, z.enum(['vehicles', 'routes', 'payment-qr']).parse(path[2]), path[3]));
      if (path[1] === 'trips' && method === 'POST') {
        if (!path[2]) return json(await createOwnTrip(driver.id, await body(req)), 201);
        if (path[3] === 'cancel') return json(await cancelOwnTrip(driver.id, path[2], await body(req)));
      }
      if (path[1] === 'trips' && path[2] && method === 'PATCH')
        return json(await updateOwnTrip(driver.id, path[2], await body(req)));
      if (path[1] === 'trips' && path[2] && path[3] === 'availability' && method === 'GET')
        return json(await ownTripAvailability(driver.id, path[2]));
      if (path[1] === 'trip-seats' && path[2] && method === 'PATCH')
        return json(await setOwnSeatBlocked(driver.id, path[2], await body(req)));
      if (path[1] === 'bookings' && path[2] && path[3] === 'cancel' && method === 'POST') {
        const cancelled = await cancelOwnBooking(driver.id, path[2], await body(req));
        void dispatchNotifications().catch(() => undefined);
        return json(cancelled);
      }
      if (path[1] === 'bookings' && method === 'GET')
        return json(await ownBookings(driver.id, { tripId: url.searchParams.get('tripId') || undefined, status: url.searchParams.get('status') || undefined }));
      if (path[1] === 'manual-bookings' && method === 'POST')
        return json(await createOfflineBooking(driver.id, await body(req)), 201);
      if (path[1] === 'payments' && path[2] && method === 'POST') {
        const reviewed = await reviewOwnPayment(driver.id, path[2], await body(req));
        void dispatchNotifications().catch(() => undefined);
        return json(reviewed);
      }
      if (path[1] === 'uploads' && method === 'POST') {
        await limit('driver-upload:' + driver.id, 100);
        const form = await multipart(req),
          file = form.get('image'),
          purpose = z.enum(['driver', 'vehicle', 'qr']).parse(form.get('purpose'));
        if (!(file instanceof File)) throw new ApiError(400, 'Choose an image.');
        return json(await upload(file, purpose, driver.id), 201);
      }
      if (path[1] === 'validate-ticket' && method === 'POST') {
        const d = z.object({ ticket: z.string().max(5000) }).parse(await body(req));
        const b = await verifyTicket(d.ticket);
        await assigned(b.tripId, driver.id);
        return json(ticketSummary(b));
      }
      if (path[1] === 'trips' && method === 'GET') {
        if (path[2]) await assigned(path[2], driver.id);
        return json({ items: await ownTrips(driver.id, path[2], url.searchParams.get('days') || '30') });
      }
      if (path[1] === 'passengers' && method === 'GET') {
        const id = url.searchParams.get('tripId');
        if (!id) throw new ApiError(400, 'Choose a trip.');
        await assigned(id, driver.id);
        return json({
          items: await db.passenger.findMany({
            where: { booking: { tripId: id, status: 'CONFIRMED' } },
            include: {
              checkIn: true,
              booking: {
                select: { reference: true, status: true, payment: { select: { status: true } } },
              },
            },
            orderBy: { seatLabel: 'asc' },
          }),
        });
      }
      if (path[1] === 'check-in' && method === 'POST') {
        const d = z
          .object({ passengerId: z.string(), status: z.enum(['CHECKED_IN', 'BOARDED']) })
          .parse(await body(req));
        return json(
          await serial(async (tx) => {
            const p = await tx.passenger.findUnique({
              where: { id: d.passengerId },
              include: { booking: true },
            });
            if (
              !p ||
              p.booking.status !== 'CONFIRMED' ||
              !(await tx.tripDriverAssignment.findFirst({
                where: { driverId: driver.id, tripId: p.booking.tripId, endedAt: null },
              }))
            )
              throw new ApiError(403, 'Passenger is not on your confirmed manifest.');
            const old = await tx.driverCheckIn.findUnique({ where: { passengerId: p.id } });
            if (old?.status === 'BOARDED' && d.status === 'CHECKED_IN')
              throw new ApiError(409, 'Passenger is already boarded.');
            const row = await tx.driverCheckIn.upsert({
              where: { passengerId: p.id },
              create: { ...d, driverId: driver.id },
              update: { status: d.status, driverId: driver.id },
            });
            await tx.auditLog.create({
              data: {
                actorId: driver.id,
                operatorId: p.booking.operatorId,
                action: d.status,
                targetId: p.id,
                details: { tripId: p.booking.tripId },
              },
            });
            return row;
          }),
        );
      }
      if (path[1] === 'issues' && method === 'POST') {
        const d = z
          .object({ tripId: z.string(), note: z.string().trim().min(3).max(2000) })
          .parse(await body(req));
        const assignment = await assigned(d.tripId, driver.id);
        return json(
          await db.auditLog.create({
            data: {
              actorId: driver.id,
              operatorId: assignment.trip.operatorId,
              action: 'DRIVER_ISSUE',
              targetId: d.tripId,
              details: { note: d.note },
            },
          }),
          201,
        );
      }
    }
    if (key === 'site-content' && method === 'GET') return json(await getSiteContent());
    if (path[0] === 'images' && path[1] && method === 'GET') {
      const object = await db.storedObject.findUnique({ where: { id: path[1] } });
      if (!object) throw new ApiError(404, 'Image not found.');
      if (object.purpose === 'proof') {
        let allowed = false;
        try {
          await staff('ADMIN');
          allowed = true;
        } catch {}
        if (!allowed) {
          try {
            const driver = await staff('DRIVER');
            allowed = !!(await db.paymentProof.findFirst({
              where: { imageKey: object.id, payment: { booking: { trip: { assignments: { some: { driverId: driver.id, endedAt: null } } } } } },
              select: { id: true },
            }));
          } catch {}
        }
        if (!allowed) await guest(object.ownerId);
      }
      const buffer = await readObject(object);
      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': object.mime,
          'Content-Length': String(buffer.length),
          'Cache-Control':
            object.purpose === 'proof' ? 'private, no-store' : 'public, max-age=3600',
          'Content-Disposition':
            (url.searchParams.has('download') ? 'attachment' : 'inline') +
            '; filename="sajilo-yatra.webp"',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (key === 'jobs/expire' && method === 'POST') {
      const secret = process.env.CRON_SECRET;
      if (
        !secret ||
        secret.length < 32 ||
        !same(req.headers.get('authorization') || '', 'Bearer ' + secret)
      )
        throw new ApiError(401, 'Unauthorized.');
      return json({
        expired: await serial((tx) => expire(tx)),
        notifications: await dispatchNotifications(),
      });
    }
    throw new ApiError(404, 'Endpoint not found.');
  } catch (error) {
    const requestId = randomUUID();
    const c = classifyError(error);
    if (c.log)
      console.error(
        JSON.stringify({ requestId, method, route: '/' + path.join('/'), error: describeError(error) }),
      );
    return Response.json(
      { error: c.message, requestId },
      {
        status: c.status,
        headers: {
          'Cache-Control': 'no-store',
          ...(c.retryAfter ? { 'Retry-After': String(c.retryAfter) } : {}),
        },
      },
    );
  }
}
