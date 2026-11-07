import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { checkEnv, describeDatabase } from '../src/lib/env';

function safeConnectionReason(error: unknown) {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' &&
    error.meta?.code === '42P05'
  )
    return 'the Transaction Pooler rejected a duplicate prepared statement; add pgbouncer=true to DATABASE_URL.';
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication failed|password authentication failed|invalid credentials/i.test(message))
    return 'authentication failed; reset or URL-encode the database password and verify the pooler username.';
  if (/can't reach database server|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message))
    return 'database host is unreachable; verify the host, port, firewall, and the selected Supabase connection mode.';
  if (/timeout|timed out/i.test(message))
    return 'connection timed out; verify network access and the database is not paused or overloaded.';
  return 'Prisma could not initialize a database connection; verify DATABASE_URL without exposing it in logs.';
}

// `npm run db:check`: explains in plain words whether this machine can use the configured database.
async function main() {
  const { errors, warnings } = checkEnv();
  for (const w of warnings) console.warn('warning: ' + w);
  for (const e of errors) console.error('error:   ' + e);
  const target = describeDatabase();
  const db = new PrismaClient();
  const started = Date.now();
  try {
    const rows = await db.$queryRawUnsafe<{ version: string }[]>('SELECT version() AS version');
    const migrations = await db.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL').catch(() => null);
    console.log(`database OK: ${target} (${Date.now() - started} ms)`);
    console.log('server:      ' + rows[0].version.split(',')[0]);
    console.log('migrations:  ' + (migrations ? migrations[0].n + ' applied' : 'none applied yet; run "npm run db:migrate"'));
  } catch (e) {
    console.error(`database FAILED: ${target} after ${Date.now() - started} ms`);
    console.error('reason:      ' + safeConnectionReason(e));
    console.error(
      'Check that the host and port are right, the server allows this machine through its firewall or IP allow-list,\n' +
        'and the user/password/database in DATABASE_URL exist. For a local database run "npm run db:local".',
    );
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
main();
