import { db } from './db';
import { ApiError, hash, token } from './security';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password';

export type LoginRole = 'ADMIN' | 'DRIVER';
export const SESSION_MS = 12 * 3600 * 1000;

type Account = { id: string; passwordHash: string; active: boolean; failedLogins: number; status?: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED' };

async function find(role: LoginRole, email: string): Promise<Account | null> {
  if (role === 'ADMIN') return db.adminUser.findUnique({ where: { email } });
  const d = await db.driver.findUnique({ where: { email } });
  return d && { ...d, failedLogins: 0 };
}

/**
 * Records the outcome of a sign-in attempt. Failed attempts are only counted for operations
 * visibility; by policy an account is never locked, however many wrong passwords were tried.
 */
async function record(role: LoginRole, id: string, ok: boolean, rehash?: string) {
  const data = ok
    ? { failedLogins: 0, lockedUntil: null, ...(rehash ? { passwordHash: rehash } : {}) }
    : { failedLogins: { increment: 1 }, lockedUntil: null };
  if (role === 'ADMIN') await db.adminUser.update({ where: { id }, data });
  else if (rehash && ok) await db.driver.update({ where: { id }, data: { passwordHash: rehash } });
}

/** Returns the opaque session secret on success. All failures present the same message. */
export async function login(role: LoginRole, email: string, password: string): Promise<string> {
  const fail = () => new ApiError(401, 'That email or password is incorrect. Please check them and try again.');
  const user = await find(role, email);
  if (!user) {
    await burnPasswordCheck(password);
    throw fail();
  }
  const { ok, rehash } = await verifyPassword(password, user.passwordHash);
  if (!ok || !user.active || (user.status && user.status !== 'ACTIVE')) {
    if (user.active) await record(role, user.id, false);
    throw fail();
  }
  await record(role, user.id, true, rehash ? await hashPassword(password) : undefined);
  const secret = token();
  await db.session.create({
    data: {
      id: hash(secret),
      ...(role === 'ADMIN' ? { adminId: user.id } : { driverId: user.id }),
      expiresAt: new Date(Date.now() + SESSION_MS),
    },
  });
  return secret;
}
