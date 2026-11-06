import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendEmail } from '../src/lib/mailer';
import { ticketEmail } from '../src/lib/booking-email';

// Minimal SMTP sink: enough of the protocol to accept one message and keep its bytes.
function smtpSink() {
  let data = '';
  const server = net.createServer((s) => {
    let inData = false;
    s.write('220 sink ESMTP\r\n');
    s.on('data', (chunk) => {
      const text = chunk.toString();
      if (inData) {
        data += text;
        if (data.includes('\r\n.\r\n')) {
          inData = false;
          s.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        const c = line.toUpperCase();
        if (c.startsWith('EHLO') || c.startsWith('HELO')) s.write('250 sink\r\n');
        else if (c.startsWith('DATA')) {
          inData = true;
          s.write('354 go\r\n');
        } else if (c.startsWith('QUIT')) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  return { server, body: () => data };
}

test('sendEmail delivers the confirmation to the passenger through SMTP', async () => {
  const sink = smtpSink();
  await new Promise<void>((r) => sink.server.listen(0, '127.0.0.1', r));
  const port = (sink.server.address() as net.AddressInfo).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), MAIL_FROM: 'Sajilo <no-reply@test.local>' });
  const m = ticketEmail({
    reference: 'SY-TEST00000001', name: 'Sita', seats: ['B2'], from: 'Kathmandu', to: 'Butwal',
    departsAt: new Date('2030-01-01T01:00:00Z'), arrivesAt: new Date('2030-01-01T09:00:00Z'),
    vehicle: 'Bus', amount: 1200,
  });
  try {
    await sendEmail({ to: 'sita@example.com', ...m, messageId: 'abc' });
  } finally {
    sink.server.close();
  }
  const raw = sink.body();
  assert.match(raw, /RCPT TO|To: sita@example.com/i);
  assert.ok(raw.includes('SY-TEST00000001'));
  assert.ok(raw.includes('Kathmandu'));
});
