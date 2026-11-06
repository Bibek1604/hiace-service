import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEnv, describeDatabase } from '../src/lib/env';

const good = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:secret@db.internal:5432/booking',
  APP_ORIGIN: 'https://booking.example.com',
  SESSION_SECRET: 'x'.repeat(40),
  CRON_SECRET: 'y'.repeat(40),
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'Sajilo <no-reply@example.com>',
  S3_BUCKET: 'b',
  S3_REGION: 'r',
  AWS_ACCESS_KEY_ID: 'k',
  AWS_SECRET_ACCESS_KEY: 's',
};

test('a complete production configuration passes without errors or warnings', () => {
  assert.deepEqual(checkEnv(good), { errors: [], warnings: [] });
});

test('missing or placeholder secrets and a bad origin are errors', () => {
  const r = checkEnv({ ...good, SESSION_SECRET: 'replace-with-at-least-32-random-characters', APP_ORIGIN: 'booking.example.com', DATABASE_URL: 'mysql://x' });
  assert.equal(r.errors.length, 3);
  assert.ok(r.errors.some((e) => /SESSION_SECRET.*placeholder/.test(e)));
  assert.ok(r.errors.some((e) => /APP_ORIGIN/.test(e)));
  assert.ok(r.errors.some((e) => /DATABASE_URL/.test(e)));
  assert.ok(checkEnv({ ...good, SESSION_SECRET: 'short' }).errors.some((e) => /32/.test(e)));
});

test('Vercel rejects a database URL that points back to its own function', () => {
  const r = checkEnv({ ...good, VERCEL: '1', DATABASE_URL: 'postgresql://app:secret@127.0.0.1:54329/booking' });
  assert.ok(r.errors.some((e) => /loopback host/.test(e)));
});

test('Vercel flags incomplete Prisma transaction-pooler settings', () => {
  const r = checkEnv({
    ...good,
    VERCEL: '1',
    DATABASE_URL: 'postgresql://app:secret@pooler.example.com:6543/booking',
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /pgbouncer=true/.test(w)));
  assert.ok(r.warnings.some((w) => /connection_limit=1/.test(w)));
});

test('partial storage, mail or SMS setup and a missing delivery channel are warnings, not errors', () => {
  const r = checkEnv({ ...good, AWS_SECRET_ACCESS_KEY: undefined, MAIL_FROM: undefined, SMS_HTTP_URL: 'https://sms' });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /partly configured/.test(w)));
  assert.ok(r.warnings.some((w) => /SMTP_HOST and MAIL_FROM/.test(w)));
  assert.ok(r.warnings.some((w) => /SMS_HTTP_URL and SMS_HTTP_TOKEN/.test(w)));
  const none = checkEnv({ ...good, SMTP_HOST: undefined, MAIL_FROM: undefined });
  assert.ok(none.warnings.some((w) => /cannot be delivered/.test(w)));
  const dev = checkEnv({ ...good, NODE_ENV: 'development', SMTP_HOST: undefined, MAIL_FROM: undefined, APP_ORIGIN: 'http://localhost:3000' });
  assert.ok(dev.warnings.some((w) => /printed to this console/.test(w)));
  assert.ok(checkEnv({ ...good, APP_ORIGIN: 'http://booking.example.com' }).warnings.some((w) => /https/.test(w)));
});

test('database descriptions never include the password', () => {
  assert.equal(describeDatabase('postgresql://app:hunter2@db.internal:5432/booking'), 'db.internal:5432/booking');
  assert.ok(!describeDatabase('postgresql://app:hunter2@db.internal:5432/booking').includes('hunter2'));
  assert.equal(describeDatabase('nope'), '(invalid DATABASE_URL)');
});
