import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketEmail } from '../src/lib/booking-email';

test('ticket email carries booking number, seats, route and Nepal-time departure', () => {
  const m = ticketEmail({
    reference: 'SY-ABC123',
    name: 'Sita <script>',
    seats: ['A1', 'A2'],
    from: 'Kathmandu',
    to: 'Narayanghat',
    departsAt: new Date('2030-01-01T01:00:00Z'),
    arrivesAt: new Date('2030-01-01T06:00:00Z'),
    vehicle: 'Deluxe (BA 1 KHA 1234)',
    amount: 1500,
  });
  assert.match(m.subject, /SY-ABC123.*Kathmandu to Narayanghat/);
  for (const part of ['SY-ABC123', 'A1, A2', 'Kathmandu', 'Narayanghat', '06:45 am NPT', 'NPR 1,500'])
    assert.ok(m.text.includes(part), part);
  assert.ok(!m.html.includes('<script>'));
});
