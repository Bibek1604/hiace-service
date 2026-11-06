import { db } from './db';
import { serial } from './bookings';
import { emailConfigured, sendEmail } from './mailer';
import { HTML_MARK } from './mail-format';
// Network delivery stays outside booking transactions. An expiring lease allows recovery after a crash.
export async function dispatchNotifications() {
  const smsOn = !!(process.env.SMS_HTTP_URL && process.env.SMS_HTTP_TOKEN);
  const channels = [...(smsOn ? ['SMS'] : []), ...(emailConfigured() ? ['EMAIL'] : [])];
  if (!channels.length) return { sent: 0, pendingConfiguration: true };
  const endpoint = smsOn ? new URL(process.env.SMS_HTTP_URL!) : null;
  if (endpoint && process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:')
    throw new Error('HTTPS SMS gateway required');
  let sent = 0;
  for (let i = 0; i < 5; i++) {
    const row = await serial(async (tx) => {
      const item = await tx.notificationOutbox.findFirst({
        where: {
          channel: { in: channels },
          nextAttemptAt: { lte: new Date() },
          OR: [{ status: 'PENDING' }, { status: 'PROCESSING', lockedUntil: { lt: new Date() } }],
        },
        orderBy: { nextAttemptAt: 'asc' },
        include: { booking: { select: { status: true } } },
      });
      if (!item) return null;
      if (item.booking.status !== item.expectedStatus) {
        await tx.notificationOutbox.update({
          where: { id: item.id },
          data: { status: 'CANCELLED' },
        });
        return { skip: true as const };
      }
      await tx.notificationOutbox.update({
        where: { id: item.id },
        data: {
          status: 'PROCESSING',
          lockedUntil: new Date(Date.now() + 60000),
          attempts: { increment: 1 },
        },
      });
      return { ...item, skip: false as const };
    });
    if (!row) break;
    if (row.skip) continue;
    try {
      if (row.channel === 'EMAIL') {
        const [text, html] = row.message.split(HTML_MARK);
        await sendEmail({
          to: row.recipient,
          subject: row.subject ?? 'Sajilo Yatra booking update',
          text,
          html,
          messageId: row.id,
        });
      } else {
        const res = await fetch(endpoint!, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + process.env.SMS_HTTP_TOKEN,
            'Idempotency-Key': row.id,
          },
          body: JSON.stringify({ to: row.recipient, message: row.message }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error('SMS enqueue failed');
      }
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date(), lockedUntil: null },
      });
      sent++;
    } catch {
      await db.notificationOutbox.update({
        where: { id: row.id },
        data: {
          status: 'PENDING',
          lockedUntil: null,
          nextAttemptAt: new Date(
            Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7)),
          ),
        },
      });
    }
  }
  return { sent, pendingConfiguration: false };
}
