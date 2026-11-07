import { db } from './db';

const like = (q: string) => '%' + q.replace(/[\%_]/g, '\$&') + '%';
const utc = (d: Date) => d.toISOString();

/**
 * Ids of bookable trips, in departure order, for one page of a search. Matching runs on each trip's frozen stop
 * timeline inside the query, so pagination counts real matches: a boarding stop must come before the drop-off
 * stop, and a later route edit never changes which trips a place finds. An empty place means the trip's own end.
 */
export async function searchTripIds(q: { origin: string; destination: string; from: Date; to?: Date; page: number; size: number }) {
  const origin = q.origin.trim(),
    destination = q.destination.trim(),
    now = new Date();
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM "Trip" t
    JOIN "Route" r ON r."id" = t."routeId"
    JOIN "Vehicle" v ON v."id" = t."vehicleId"
    JOIN "PaymentQR" p ON p."id" = t."paymentQRId"
    WHERE t."status" = 'SCHEDULED' AND t."bookingOpen" AND r."active" AND v."active" AND p."active"
      AND t."departure" >= (CAST(${utc(q.from)}::text AS timestamptz) AT TIME ZONE 'UTC')
      AND (${q.to ? utc(q.to) : null}::text IS NULL OR t."departure" < (CAST(${q.to ? utc(q.to) : null}::text AS timestamptz) AT TIME ZONE 'UTC'))
      AND (t."bookingOpensAt" IS NULL OR t."bookingOpensAt" <= (CAST(${utc(now)}::text AS timestamptz) AT TIME ZONE 'UTC'))
      AND (t."bookingClosesAt" IS NULL OR t."bookingClosesAt" > (CAST(${utc(now)}::text AS timestamptz) AT TIME ZONE 'UTC'))
      AND EXISTS (
        SELECT 1 FROM "TripDriverAssignment" a JOIN "Driver" d ON d."id" = a."driverId"
        WHERE a."tripId" = t."id" AND a."endedAt" IS NULL AND d."active" AND d."status" = 'ACTIVE')
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(t."stopSnapshot") WITH ORDINALITY AS board(stop, i)
        JOIN jsonb_array_elements(t."stopSnapshot") WITH ORDINALITY AS leave(stop, j) ON board.i < leave.j
        WHERE (board.stop->>'allowBoarding')::boolean AND (leave.stop->>'allowDropoff')::boolean
          AND (CASE WHEN ${origin}::text = '' THEN board.i = 1 ELSE board.stop->>'name' ILIKE ${like(origin)}::text END)
          AND (CASE WHEN ${destination}::text = '' THEN leave.j = jsonb_array_length(t."stopSnapshot") ELSE leave.stop->>'name' ILIKE ${like(destination)}::text END))
    ORDER BY t."departure" ASC, t."id" ASC
    LIMIT ${q.size + 1} OFFSET ${(q.page - 1) * q.size}`;
  const ids = rows.map((r) => r.id);
  return { ids: ids.slice(0, q.size), nextPage: ids.length > q.size ? q.page + 1 : null };
}
