import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword as hash } from '../src/lib/password';
const db = new PrismaClient();

// Development logins. In production, set the *_EMAIL / *_PASSWORD variables; the defaults are refused.
const prod = process.env.NODE_ENV === 'production';
const real = (v?: string) => (v && !v.startsWith('replace-') && !v.startsWith('admin@example') ? v : undefined);
const pick = (email: string | undefined, password: string | undefined, d: [string, string]) => {
  const e = real(email)?.toLowerCase(),
    p = real(password);
  if (e && p) return { email: e, password: p, custom: true };
  if (prod) throw new Error('Set explicit seed emails and passwords (min 16 characters) in production.');
  return { email: d[0], password: d[1], custom: false };
};
async function main() {
  const admin = pick(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD, [
    'admin@sajiloyatra.com',
    'SajiloAdmin@2026!',
  ]);
  const driver = pick(process.env.DRIVER_EMAIL, process.env.DRIVER_PASSWORD, [
    'driver@sajiloyatra.com',
    'SajiloDriver@2026!',
  ]);
  if (admin.password.length < 16 || driver.password.length < 16)
    throw new Error('Seed passwords must be at least 16 characters.');

  // Existing accounts are never overwritten, so a changed password survives re-seeding.
  await db.adminUser.upsert({
    where: { email: admin.email },
    create: { email: admin.email, name: 'Super Admin', passwordHash: await hash(admin.password) },
    update: {},
  });
  const operator = await db.operator.upsert({
    where: { slug: 'sajilo-yatra-demo' },
    create: {
      name: 'Sajilo Yatra Demo',
      slug: 'sajilo-yatra-demo',
      contactName: 'Sajilo Yatra',
      contactPhone: '9800000000',
      status: 'ACTIVE',
    },
    update: {},
  });
  await db.driver.upsert({
    where: { email: driver.email },
    create: {
      operatorId: operator.id,
      email: driver.email,
      name: 'Demo Driver',
      passwordHash: await hash(driver.password),
      mobile: '9800000001',
      licenseNumber: 'SJL-DEMO-001',
      licenseExpiry: new Date('2030-01-01T00:00:00.000Z'),
      emergencyContact: '9800000002',
    },
    update: {},
  });
  await db.settings.upsert({ where: { id: 'global' }, create: {}, update: {} });

  const row = (role: string, a: { email: string; password: string }) =>
    `  ${role.padEnd(12)} ${a.email.padEnd(30)} ${a.password}`;
  console.log(
    [
      '',
      'Seed complete. Sign in at /staff/sign-in?role=ADMIN.',
      '  ROLE         EMAIL                          PASSWORD',
      row('Super admin', admin),
      row('Driver', driver),
      'Existing accounts keep their current passwords. Change these before any real use.',
      '',
    ].join('\n'),
  );
}
main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
