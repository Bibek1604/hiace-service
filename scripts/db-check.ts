import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkEnv, describeDatabase } from '../src/lib/env';

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
    const message = e instanceof Error ? e.message.split('\n').find((l) => l.trim()) ?? e.message : String(e);
    console.error(`database FAILED: ${target} after ${Date.now() - started} ms`);
    console.error('reason:      ' + message);
    console.error(
      'Check that the host and port are right, the server allows this machine through its firewall or IP allow-list,\n' +
        'and the user/password/database in DATABASE_URL exist. For a local database run "docker compose up -d db".',
    );
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
main();
