import { createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { cookies } from 'next/headers';
import { db } from './db';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
import { ApiError } from './errors';
export { ApiError } from './errors';

export function same(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function capability(key: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new ApiError(503, 'Secure sign-in and booking links aren’t available right now. Please try again shortly.');
  return createHmac('sha256', secret).update(key).digest('base64url');
}
export type StaffRole = 'ADMIN' | 'DRIVER';
export async function staff(role?: StaffRole) {
  const c = (await cookies()).get('staff_session')?.value;
  const s = c
    ? await db.session.findUnique({
        where: { id: hash(c) },
        include: { admin: true, driver: true },
      })
    : null;
  const live = !!s?.admin?.active || !!(s?.driver?.active && s.driver.status === 'ACTIVE');
  if (!s || s.expiresAt <= new Date() || !live) throw new ApiError(401, 'Your session has ended. Please sign in again.');
  const actual: StaffRole = s.admin ? 'ADMIN' : 'DRIVER';
  if (role && role !== actual) throw new ApiError(403, 'Access denied.');
  return { id: (s.adminId || s.driverId)!, role: actual, name: s.admin?.name || s.driver!.name };
}
export async function guest(id: string) {
  const access = (await cookies()).get('booking_' + id)?.value;
  const b = await db.booking.findUnique({
    where: { id },
    include: {
      customer: true,
      trip: { include: { vehicle: true, route: { include: { origin: true, destination: true } } } },
      seats: { include: { tripSeat: { include: { vehicleSeat: true } } } },
      passengers: true,
      payment: { include: { proofs: true } },
    },
  });
  if (!b || !access || !same(hash(access), b.accessHash))
    throw new ApiError(404, 'Use booking tracking to access this booking.');
  return b;
}
export async function guestCookie(id: string, access: string) {
  (await cookies()).set('booking_' + id, access, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 86400 * 90,
  });
}
export function originGuard(request: Request) {
  const expected = process.env.APP_ORIGIN;
  if (!expected || request.headers.get('origin') !== new URL(expected).origin)
    throw new ApiError(403, 'Invalid request origin.');
}
/** Request throttling is opt-in (RATE_LIMITS=on). By default repeated attempts are never blocked. */
export const rateLimitsEnabled = () => process.env.RATE_LIMITS === "on";
export async function limit(key: string, maximum = 10) {
  if (!rateLimitsEnabled()) return;
  const now = new Date(),
    reset = new Date(Date.now() + 900000);
  const rows = await db.$queryRaw<
    { count: number }[]
  >`INSERT INTO "RateLimit" ("key","count","resetAt") VALUES (${key},1,${reset}) ON CONFLICT ("key") DO UPDATE SET "count"=CASE WHEN "RateLimit"."resetAt"<${now} THEN 1 ELSE "RateLimit"."count"+1 END,"resetAt"=CASE WHEN "RateLimit"."resetAt"<${now} THEN ${reset} ELSE "RateLimit"."resetAt" END RETURNING "count"`;
  if (rows[0].count > maximum)
    throw new ApiError(429, 'Too many attempts. Try again in 15 minutes.');
}
export function clientKey(req: Request) {
  return process.env.TRUST_PROXY === 'true' ? req.headers.get('x-real-ip') || 'shared' : 'shared';
}
