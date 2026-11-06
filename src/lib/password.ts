import { hash, verify } from '@node-rs/argon2';
import { compare as bcryptCompare } from 'bcryptjs';

// OWASP-recommended Argon2id minimum: 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { algorithm: 2 as const /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => hash(plain, OPTIONS);

/** Verifies Argon2id hashes and legacy bcrypt hashes; `rehash` is true when the stored hash should be upgraded. */
export async function verifyPassword(plain: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
  if (stored.startsWith('$argon2id$')) return { ok: await verify(stored, plain).catch(() => false), rehash: false };
  if (/^\$2[aby]\$/.test(stored)) return { ok: await bcryptCompare(plain, stored), rehash: true };
  return { ok: false, rehash: false };
}

/** Constant-ish work for unknown accounts so login timing does not reveal which emails exist. */
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(plain: string) {
  dummy ??= hashPassword('not-a-real-password');
  await verify(await dummy, plain).catch(() => false);
}
