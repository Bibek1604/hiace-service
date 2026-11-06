import 'dotenv/config';
import { setTimeout } from 'node:timers/promises';
import { dispatchNotifications } from '../src/lib/notifications';
import { db } from '../src/lib/db';
import { expire, serial } from '../src/lib/bookings';
import { describeDatabase } from '../src/lib/env';

// Releases expired seat holds and delivers queued notifications every 30 seconds until SIGINT/SIGTERM.
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 30000);
let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});

/** One readable line for an error. Prisma messages start with a blank line, so the first non-empty line is used. */
function describe(error: unknown) {
  if (!(error instanceof Error)) return 'UnknownError';
  const code = (error as { code?: string }).code;
  const detail = error.message.split(/\r?\n/).find((l) => l.trim())?.slice(0, 160) ?? '';
  return error.name + (code ? ' ' + code : '') + (detail ? ': ' + detail : '');
}

async function main() {
  console.log(`[worker] started; database ${describeDatabase()}; pass every ${INTERVAL_MS / 1000}s`);
  try {
    while (!stopped) {
      try {
        let expired = 0,
          count;
        do {
          count = await serial((tx) => expire(tx));
          expired += count;
        } while (count === 200 && !stopped);
        const sent = await dispatchNotifications();
        if (expired || sent.sent)
          console.log(`[worker] ${new Date().toISOString()} expired ${expired} hold(s), sent ${sent.sent} notification(s)`);
      } catch (error) {
        console.error('[worker] pass failed:', describe(error));
      }
      if (!stopped) await setTimeout(INTERVAL_MS);
    }
  } finally {
    await db.$disconnect();
    console.log('[worker] stopped');
  }
}

main();
