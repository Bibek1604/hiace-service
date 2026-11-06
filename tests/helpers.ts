import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createOwnerDriver } from '../src/lib/driver-portal';

// Mirrors hash() in src/lib/security.ts, which cannot be imported outside a Next.js request context.
export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

const uid = () => randomUUID().slice(0, 8);

/** A valid add-driver form with a unique email and licence. */
export function driverForm(label = 'driver') {
  const id = uid();
  return {
    name: `${label} ${id}`,
    email: `${label}-${id}@test.local`,
    password: 'correct-horse-battery-' + id,
    mobile: '9800000000',
    licenseNumber: `${label}-${id}`,
    licenseExpiry: new Date(Date.now() + 1e11).toISOString(),
    emergencyContact: '9800000000',
  };
}

/** A bare Operator row: another tenant to prove scope isolation against, with no driver attached. */
export function makeTenant(db: PrismaClient, label = 'tenant') {
  const id = uid();
  return db.operator.create({ data: { name: `${label} ${id}`, slug: `${label}-${id}`, status: 'ACTIVE', settings: { create: {} } } });
}

/** A driver with their private Operator, the way the admin creates one. `operatorId` is the driver's tenant scope. */
export async function makeDriver(db: PrismaClient, actorId: string, label = 'driver') {
  const form = driverForm(label);
  const { id } = await createOwnerDriver(form, actorId);
  const { operatorId } = await db.driver.findUniqueOrThrow({ where: { id }, select: { operatorId: true } });
  return { ...form, id, operatorId };
}
