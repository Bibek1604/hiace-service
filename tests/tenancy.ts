import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { list, save } from '../src/lib/admin';
import { login } from '../src/lib/auth';
import { hashPassword } from '../src/lib/password';
import { createLayout, getLayout, publishLayout, saveDraft } from '../src/lib/layouts';
import { makeDriver, makeTenant, sha256Hex } from './helpers';

const enabled = process.env.RUN_DB_TESTS === '1';
const rejectsWith = (status: number) => (e: unknown) => (e as { status?: number }).status === status;

// Requires an isolated, disposable database. Records intentionally remain for debugging.
test('tenant isolation and no lockout', { skip: !enabled }, async () => {
  const db = new PrismaClient();
  const id = randomUUID().slice(0, 8);
  const password = 'correct-horse-battery-' + id;
  try {
    const admin = await db.adminUser.create({
      data: { email: id + '@platform.test', name: 'Platform', passwordHash: await hashPassword(password) },
    });
    const driver = await makeDriver(db, admin.id, 'tenant');
    const a = { id: driver.operatorId };
    const b = await makeTenant(db, 'b');

    // Tenant A creates a vehicle; tenant B can neither see, edit, nor create into it.
    const vehicle = await save(
      'vehicles',
      {
        name: 'A bus',
        registration: 'A-' + id,
        type: 'Bus',
        operator: 'A',
        operatorContact: '9800000000',
        emergencyContact: '9800000000',
        amenities: [],
        seatLabels: ['A1', 'A2'],
        imageKeys: [],
      },
      admin.id,
      false,
      a.id,
    );
    assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).operatorId, a.id);
    await assert.rejects(
      save(
        'vehicles',
        {
          id: vehicle.id,
          name: 'hijack',
          registration: 'HJ-' + id,
          type: 'Bus',
          operator: 'Hijack',
          operatorContact: '9800000000',
          emergencyContact: '9800000000',
          amenities: [],
          seatLabels: ['A1', 'A2'],
          imageKeys: [],
        },
        admin.id,
        true,
        b.id,
      ),
      rejectsWith(404),
      'foreign id is indistinguishable from a missing one',
    );
    await assert.rejects(
      save('vehicles', { name: 'forged', operatorId: a.id }, admin.id, false, b.id),
      rejectsWith(404),
      'a forged operatorId in the body is refused',
    );
    assert.ok(!(await list('vehicles', 1, b.id)).some((v) => v.id === vehicle.id));
    assert.ok((await list('vehicles', 1, a.id)).some((v) => v.id === vehicle.id));
    await assert.rejects(save('settings', {}, admin.id, true, a.id), rejectsWith(403));

    // The database refuses cross-tenant graphs even if application code is bypassed.
    const origin = await db.location.create({ data: { name: 'o-' + id } }),
      destination = await db.location.create({ data: { name: 'd-' + id } });
    const routeB = await db.route.create({
      data: {
        operatorId: b.id,
        originId: origin.id,
        destinationId: destination.id,
        baseFare: 1,
        distanceKm: 1,
        durationMinutes: 1,
      },
    });
    const qrA = await db.paymentQR.create({
      data: { operatorId: a.id, label: 'q', imageKey: 'k', accountName: 'n', instructions: 'i' },
    });
    await assert.rejects(
      db.trip.create({
        data: {
          operatorId: a.id,
          vehicleId: vehicle.id,
          routeId: routeB.id,
          paymentQRId: qrA.id,
          departure: new Date(Date.now() + 864e5),
          arrival: new Date(Date.now() + 9e7),
          fare: 1,
          boardingPoint: 'o',
          dropPoint: 'd',
        },
      }),
      /tenant_mismatch/,
    );

    // No lockout policy: every wrong password is refused on its own, and the right one still works afterwards.
    const accounts = [
      { role: 'DRIVER', email: driver.email, password: driver.password },
      { role: 'ADMIN', email: admin.email, password },
    ] as const;
    for (const account of accounts) {
      for (let i = 0; i < 12; i++) await assert.rejects(login(account.role, account.email, 'wrong-password-' + i), rejectsWith(401));
      const secret = await login(account.role, account.email, account.password);
      assert.ok(await db.session.findUnique({ where: { id: sha256Hex(secret) } }));
    }
    assert.equal((await db.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).lockedUntil, null);
  } finally {
    await db.$disconnect();
  }
});

test('seat layouts: versioned, tenant-scoped, and compiled into vehicle seats', { skip: !enabled }, async () => {
  const db = new PrismaClient();
  const id = randomUUID().slice(0, 8);
  try {
    const admin = await db.adminUser.create({ data: { email: id + '@layout.test', name: 'Platform', passwordHash: 'unused' } });
    const [a, b] = [await makeTenant(db, 'lay-a'), await makeTenant(db, 'lay-b')];

    const layout = await createLayout(a.id, admin.id, { name: 'Coach ' + id, vehicleType: 'Bus', template: 'coach_2x2_40' });
    await assert.rejects(getLayout(b.id, layout.id), rejectsWith(404));
    await assert.rejects(publishLayout(b.id, admin.id, layout.id), rejectsWith(404));
    await assert.rejects(createLayout(a.id, admin.id, { name: 'coach ' + id, vehicleType: 'Bus' }), rejectsWith(409));

    // An unpublished draft cannot back a vehicle.
    const vehicle = {
      name: 'Bus',
      registration: 'L-' + id,
      type: 'Bus',
      operator: 'A',
      operatorContact: '9800000000',
      emergencyContact: '9800000000',
    };
    await assert.rejects(save('vehicles', { ...vehicle, layoutVersionId: layout.versions[0].id }, admin.id, false, a.id), rejectsWith(400));

    await publishLayout(a.id, admin.id, layout.id);
    const published = (await getLayout(a.id, layout.id)).versions[0];
    assert.equal(published.status, 'PUBLISHED');
    await assert.rejects(
      save('vehicles', { ...vehicle, registration: 'LB-' + id, layoutVersionId: published.id }, admin.id, false, b.id),
      rejectsWith(400),
      'another tenant cannot use the layout',
    );
    const v = await save('vehicles', { ...vehicle, layoutVersionId: published.id }, admin.id, false, a.id);
    assert.equal(await db.vehicleSeat.count({ where: { vehicleId: v.id } }), 40);

    // Editing a published layout opens version 2; version 1 and the vehicle are untouched.
    const g = published.grid;
    await saveDraft(a.id, admin.id, { layoutId: layout.id, grid: { ...g, cells: g.cells.filter((c) => c.label !== 'A1') } });
    const after = await getLayout(a.id, layout.id);
    assert.deepEqual(after.versions.map((x) => [x.version, x.status]), [[2, 'DRAFT'], [1, 'PUBLISHED']]);
    await publishLayout(a.id, admin.id, layout.id);
    assert.equal((await db.seatLayoutVersion.findUniqueOrThrow({ where: { id: published.id } })).status, 'ARCHIVED');
    assert.equal(await db.vehicleSeat.count({ where: { vehicleId: v.id } }), 40);
    await assert.rejects(db.seatLayoutVersion.update({ where: { id: published.id }, data: { rows: 3 } }), /layout_immutable/);
  } finally {
    await db.$disconnect();
  }
});
