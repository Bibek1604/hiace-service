import type { Prisma } from '@prisma/client';
import { HTML_MARK } from './mail-format';
import { timeAtStop, type TripStop } from './inventory';

export type TicketEmailInput = {
  reference: string;
  name: string;
  seats: string[];
  from: string;
  to: string;
  departsAt: Date;
  arrivesAt: Date;
  vehicle: string;
  amount: number;
};

const npt = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d) + ' NPT';
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain-text and HTML bodies for a confirmed-ticket email. */
export function ticketEmail(t: TicketEmailInput) {
  const rows: [string, string][] = [
    ['Booking number', t.reference],
    ['Passenger', t.name],
    ['Seat(s)', t.seats.join(', ')],
    ['From', t.from],
    ['To', t.to],
    ['Departure', npt(t.departsAt)],
    ['Arrival', npt(t.arrivesAt)],
    ['Vehicle', t.vehicle],
    ['Amount paid', 'NPR ' + t.amount.toLocaleString('en-US')],
  ];
  const subject = `Booking confirmed ${t.reference}: ${t.from} to ${t.to}`;
  const text =
    'Your Sajilo Yatra booking is confirmed.\n\n' +
    rows.map(([k, v]) => k + ': ' + v).join('\n') +
    '\n\nKeep your booking number for check-in. Reach the boarding point 15 minutes before departure.';
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:520px"><h2>Your booking is confirmed</h2><table cellpadding="6" style="border-collapse:collapse;width:100%">' +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="color:#555;border-bottom:1px solid #eee">${esc(k)}</td><td style="border-bottom:1px solid #eee"><b>${esc(v)}</b></td></tr>`,
      )
      .join('') +
    '</table><p style="color:#555">Keep your booking number for check-in. Reach the boarding point 15 minutes before departure.</p></div>';
  return { subject, text, html };
}

/**
 * Queues the confirmation email inside the confirming transaction. Delivery happens later, outside it,
 * so a mail outage can never roll back or delay a confirmed seat. Bookings without an email do nothing.
 */
export async function queueTicketEmail(tx: Prisma.TransactionClient, bookingId: string) {
  const b = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: true,
      passengers: true,
      trip: { include: { vehicle: { select: { name: true, registration: true } } } },
    },
  });
  if (!b?.customer.email) return false;
  const stops = b.trip.stopSnapshot as unknown as TripStop[];
  const mail = ticketEmail({
    reference: b.reference,
    name: b.customer.name,
    seats: b.passengers.map((p) => p.seatLabel).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })),
    from: stops[b.fromIdx]?.name ?? b.trip.boardingPoint,
    to: stops[b.toIdx]?.name ?? b.trip.dropPoint,
    departsAt: stops[b.fromIdx] ? timeAtStop(b.trip.departure, stops, b.fromIdx) : b.trip.departure,
    arrivesAt: stops[b.toIdx] ? timeAtStop(b.trip.departure, stops, b.toIdx) : b.trip.arrival,
    vehicle: b.trip.vehicle.name + ' (' + b.trip.vehicle.registration + ')',
    amount: b.amount,
  });
  await tx.notificationOutbox.upsert({
    where: { dedupeKey: 'TICKET_EMAIL:' + b.id },
    create: {
      bookingId: b.id,
      dedupeKey: 'TICKET_EMAIL:' + b.id,
      channel: 'EMAIL',
      recipient: b.customer.email,
      subject: mail.subject,
      message: mail.text + HTML_MARK + mail.html,
      expectedStatus: 'CONFIRMED',
    },
    update: {},
  });
  return true;
}
