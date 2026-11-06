/**
 * Configuration checks run once at server start (see src/instrumentation.ts). Errors stop a production
 * server before it serves a single broken request; in development they are printed as warnings so the
 * app still boots while the environment is being set up.
 */
export type EnvReport = { errors: string[]; warnings: string[] };

type Env = Record<string, string | undefined>;

export function checkEnv(env: Env = process.env): EnvReport {
  const errors: string[] = [],
    warnings: string[] = [];
  const production = env.NODE_ENV === 'production';
  const url = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(url)) errors.push('DATABASE_URL must be a postgresql:// connection string.');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    errors.push(
      'SESSION_SECRET must be at least 32 random characters (sessions, tickets and booking links depend on it).',
    );
  else if (/^replace-/.test(env.SESSION_SECRET))
    errors.push('SESSION_SECRET still has the placeholder value from .env.example.');
  try {
    const origin = new URL(env.APP_ORIGIN ?? '');
    if (production && origin.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(origin.hostname))
      warnings.push('APP_ORIGIN should use https in production.');
  } catch {
    errors.push(
      'APP_ORIGIN must be the exact public origin of the site, e.g. https://booking.example.com (browsers send it on every write).',
    );
  }
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 32)
    warnings.push(
      'CRON_SECRET is missing or shorter than 32 characters: POST /api/jobs/expire is disabled; run "npm run worker" instead.',
    );
  const s3 = ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((k) => env[k]);
  if (s3.length && s3.length < 4)
    warnings.push(
      'Object storage is partly configured (' + s3.join(', ') + '); uploads will fail until all S3 variables are set.',
    );
  if (!env.S3_BUCKET)
    warnings.push(
      'S3_BUCKET is empty: uploads are stored on the local disk under ' +
        (env.STORAGE_DIR || './storage') +
        '. Use a persistent volume or configure S3 for multi-instance deployments.',
    );
  const smtp = ['SMTP_HOST', 'MAIL_FROM'].filter((k) => env[k]);
  if (smtp.length === 1) warnings.push('Email needs both SMTP_HOST and MAIL_FROM; only ' + smtp[0] + ' is set.');
  const sms = ['SMS_HTTP_URL', 'SMS_HTTP_TOKEN'].filter((k) => env[k]);
  if (sms.length === 1) warnings.push('SMS needs both SMS_HTTP_URL and SMS_HTTP_TOKEN; only ' + sms[0] + ' is set.');
  if (!smtp.length && !sms.length)
    warnings.push(
      production
        ? 'Neither email nor SMS is configured: booking tracking codes cannot be delivered and ticket emails stay queued.'
        : 'Neither email nor SMS is configured: booking tracking codes are printed to this console in development.',
    );
  if (env.TRUST_PROXY && !['true', 'false'].includes(env.TRUST_PROXY))
    warnings.push('TRUST_PROXY must be "true" or "false".');
  if (env.RATE_LIMITS && env.RATE_LIMITS !== 'on')
    warnings.push('RATE_LIMITS is set but not "on"; request throttling stays disabled.');
  return { errors, warnings };
}

/** Database host and name for logs, never the password. */
export function describeDatabase(url = process.env.DATABASE_URL ?? '') {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? ':' + u.port : '') + u.pathname;
  } catch {
    return '(invalid DATABASE_URL)';
  }
}
