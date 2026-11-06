/**
 * Runs once when the Next.js server starts. It validates configuration and reports whether the
 * database is reachable, so a misconfigured deployment fails loudly instead of answering 503 to users.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkEnv, describeDatabase } = await import('./lib/env');
  const { errors, warnings } = checkEnv();
  for (const w of warnings) console.warn('[config] ' + w);
  for (const e of errors) console.error('[config] ' + e);
  if (errors.length && process.env.NODE_ENV === 'production')
    throw new Error('Refusing to start with invalid configuration. Fix the [config] errors above.');
  try {
    const { db } = await import('./lib/db');
    await Promise.race([
      db.$queryRawUnsafe('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    console.log('[startup] database reachable at ' + describeDatabase());
  } catch (e) {
    const reason = e instanceof Error ? e.message.split('\n').find((l) => l.trim())?.slice(0, 160) : 'unknown error';
    console.error(
      '[startup] database NOT reachable at ' +
        describeDatabase() +
        ' (' +
        reason +
        '). Pages still render; data endpoints answer 503 until the database is available.',
    );
  }
}
