import { db } from './db';
import { ApiError } from './security';
import { nepalDateString } from './nepal-time';

/** Quotes a CSV cell and defuses spreadsheet formulas (a leading =, +, -, @, tab or CR would execute). */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(',');

/** Natural seat order: A2 before A10. */
export const seatOrder = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

const kathmandu = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', dateStyle: 'medium', timeStyle: 'short' }).format(d);

export const MANIFEST_HEADER = [
  'Trip ID', 'Vehicle', 'Registration', 'Route', 'Departure (NPT)', 'Driver', 'Driver mobile',
  'Seat', 'Passenger', 'Contact', 'Boarding point', 'Drop-off point', 'Booking reference', 'Check-in status',
];

/**
 * Passenger manifest for one trip. Same rule as the driver's on-screen manifest: confirmed bookings only.
 * Contains no payment evidence, tokens or data about other trips.
 */
export async function tripManifest(tripId: string, scope: string | null) {
  const trip = await db.trip.findFirst({
    where: { id: tripId, ...(scope ? { operatorId: scope } : {}) },
    include: {
      vehicle: { select: { name: true, registration: true } },
      route: { include: { origin: true, destination: true } },
      assignments: { where: { endedAt: null }, select: { driver: { select: { name: true, mobile: true } } } },
    },
  });
  if (!trip) throw new ApiError(404, 'Trip not found.');
  const passengers = await db.passenger.findMany({
    where: { booking: { tripId, status: 'CONFIRMED' } },
    select: { name: true, phone: true, seatLabel: true, boardingPoint: true, destination: true, checkIn: { select: { status: true } }, booking: { select: { reference: true } } },
  });
  passengers.sort((a, b) => seatOrder(a.seatLabel, b.seatLabel));
  const driver = trip.assignments[0]?.driver;
  const fixed = [
    trip.id, trip.vehicle.name, trip.vehicle.registration, trip.route.origin.name + ' → ' + trip.route.destination.name,
    kathmandu(trip.departure), driver?.name ?? 'Unassigned', driver?.mobile ?? '',
  ];
  const lines = [csvRow(MANIFEST_HEADER)];
  for (const p of passengers)
    lines.push(csvRow([...fixed, p.seatLabel, p.name, p.phone, p.boardingPoint, p.destination, p.booking.reference, p.checkIn?.status ?? 'PENDING']));
  if (!passengers.length) lines.push(csvRow([...fixed, '', 'No confirmed passengers', '', '', '', '', '']));
  const date = nepalDateString(trip.departure);
  // A UTF-8 byte-order mark lets Excel read Nepali names correctly.
  return {
    body: '﻿' + lines.join('\r\n') + '\r\n',
    filename: 'manifest-' + trip.vehicle.registration.replace(/[^\w-]+/g, '') + '-' + date + '.csv',
    count: passengers.length,
  };
}
