import 'dotenv/config';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiClient, adminCredentials, pngFile, seedScenario, type Scenario } from './fixtures/api-client';

/**
 * End-to-end HTTP tests. By default they build nothing: run `npm run build` first, then `npm run test:api`
 * boots `next start` on E2E_PORT (3100) against DATABASE_URL with a local SMTP sink and disk storage.
 * Set E2E_BASE_URL to test an already running server instead (the email-dependent checks are then skipped).
 */
const PORT = Number(process.env.E2E_PORT || 3100);
const external = process.env.E2E_BASE_URL?.replace(/\/$/, '');
const BASE = external || `http://localhost:${PORT}`;

type Mail = { to: string; raw: string };
/** Minimal SMTP server: accepts any sender, stores every message, speaks just enough of RFC 5321 for nodemailer. */
function smtpSink() {
  const mails: Mail[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    let inData = false,
      buffer = '',
      rcpt: string[] = [],
      data = '';
    s.write('220 sink ESMTP\r\n');
    s.on('data', (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          mails.push({ to: rcpt.join(','), raw: data });
          rcpt = [];
          inData = false;
          s.write('250 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const c = line.toUpperCase();
        if (c.startsWith('EHLO') || c.startsWith('HELO')) s.write('250-sink\r\n250 PIPELINING\r\n');
        else if (c.startsWith('RCPT TO:')) {
          rcpt.push(line.slice(8).replace(/[<>\s]/g, ''));
          s.write('250 ok\r\n');
        } else if (c.startsWith('DATA')) {
          inData = true;
          s.write('354 go\r\n');
        } else if (c.startsWith('QUIT')) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
    s.on('error', () => undefined);
  });
  // Open connections would keep the test process alive after the suite; destroy them on shutdown.
  const close = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  return { server, mails, close };
}
const decodeQp = (s: string) =>
  s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
function mailText(m: Mail) {
  const parts = [decodeQp(m.raw)];
  for (const b64 of m.raw.match(/(?:^[A-Za-z0-9+/=]{60,}\r?\n)+/gm) ?? [])
    parts.push(Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8'));
  return parts.join('\n');
}
async function waitFor<T>(fn: () => T | undefined, ms = 15000, what = 'condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('Timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sink = smtpSink();
let server: ChildProcess | undefined;
let serverLog = '';
let scenario: Scenario;

before(async () => {
  if (!external) {
    if (!existsSync('.next/BUILD_ID')) throw new Error('No production build found. Run `npm run build` before `npm run test:api`.');
    await new Promise<void>((r) => sink.server.listen(0, '127.0.0.1', r));
    const smtpPort = (sink.server.address() as net.AddressInfo).port;
    const storage = await mkdtemp(join(tmpdir(), 'sy-e2e-storage-'));
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(PORT),
        APP_ORIGIN: BASE,
        STORAGE_DIR: storage,
        STORAGE_DRIVER: 'local',
        S3_BUCKET: '',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtpPort),
        SMTP_REQUIRE_TLS: 'false',
        MAIL_FROM: 'Sajilo Yatra Test <no-reply@test.local>',
        SMS_HTTP_URL: '',
        SMS_HTTP_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (d) => (serverLog += d));
    server.stderr?.on('data', (d) => (serverLog += d));
    const until = Date.now() + 90000;
    for (;;) {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.status === 200) break;
      } catch {
        /* not up yet */
      }
      if (server.exitCode !== null) throw new Error('Server exited early:\n' + serverLog);
      if (Date.now() > until) throw new Error('Server did not become healthy:\n' + serverLog);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  scenario = await seedScenario(BASE);
});

after(async () => {
  if (server?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill('SIGTERM');
  }
  sink.close();
  if (process.env.E2E_SERVER_LOG) console.log(serverLog);
});

const anon = () => new ApiClient(BASE);

async function signedInDriver() {
  const c = anon();
  const r = await c.login('DRIVER', scenario.driver.email, scenario.driver.password);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

/** The admin sees every driver's records, so a row of this scenario may sit past the first page of a shared database. */
async function findListed<T extends { id: string }>(path: string, id: string) {
  for (let page = 1; ; page++) {
    const { data } = await scenario.admin.get<{ items: T[]; nextPage: number | null }>(`${path}?page=${page}`);
    const row = data.items.find((x) => x.id === id);
    if (row || !data.nextPage) return row;
  }
}

test('health, 404s, CSRF origin guard and malformed JSON are answered correctly', async () => {
  const h = await anon().get<{ status: string; database: string; schema: string }>('/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(h.data, { status: 'ready', database: 'up', schema: 'up' });
  assert.equal((await anon().get('/api/nope')).status, 404);
  const noOrigin = await new ApiClient(BASE, 'https://evil.example').post('/api/bookings', {});
  assert.equal(noOrigin.status, 403);
  const bad = await anon().call('POST', '/api/track/request', '{not json');
  assert.equal(bad.status, 400);
  const img = await anon().get(`/api/images/${scenario.qrImageId}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/webp');
});

test('sign-in never locks an account: many wrong passwords, then the right one', async () => {
  const creds = adminCredentials();
  const c = anon();
  for (let i = 0; i < 12; i++) {
    const r = await c.login('ADMIN', creds.email, 'wrong-' + i);
    assert.equal(r.status, 401, 'attempt ' + i + ' -> ' + JSON.stringify(r.data));
  }
  const ok = await c.login('ADMIN', creds.email, creds.password);
  assert.equal(ok.status, 200);
  assert.ok(c.jar.has('staff_session'), "session cookie is set after sign-in");
  assert.equal((await c.get('/api/driver/trips')).status, 403, 'an admin session has no driver privileges');
  const out = await c.post('/api/auth/logout');
  assert.equal(out.status, 200);
  assert.equal((await c.get('/api/admin/reports')).status, 401, 'logout ends the session');
});

test('a driver account has a private owner record, a unique email and an admin password reset', async () => {
  const { admin, operatorId, driver, id } = scenario;
  const owners = await admin.get<{ items: { id: string; name: string }[] }>('/api/admin/owners');
  assert.equal(owners.status, 200);
  assert.ok(owners.data.items.some((o) => o.id === operatorId && o.name === driver.form.name), 'the driver is offered as an owner');
  const dup = await admin.post('/api/admin/drivers', { ...driver.form, licenseNumber: 'DUP-' + id, password: 'a-long-password-123' });
  assert.equal(dup.status, 409);
  assert.equal((await admin.post('/api/admin/vehicles', { name: 'No owner' })).status, 400, 'tenant-owned creates need an operatorId');

  const newPassword = 'Driver-reset-' + id + '!';
  assert.equal((await admin.patch('/api/admin/drivers', { ...driver.form, id: driver.id, password: newPassword })).status, 200);
  assert.equal((await anon().login('DRIVER', driver.email, driver.password)).status, 401, 'the old password stops working');
  assert.equal((await anon().login('DRIVER', driver.email, newPassword)).status, 200);
  driver.password = newPassword;
});

test('catalog CRUD: vehicles, drivers, routes, stops, points, segment fares, QR accounts, layouts and settings', async () => {
  const { admin, operatorId, id, locations, vehicleId, routeId, layoutId, driver, qrId, tripId } = scenario;
  const vehicles = await admin.get<{ items: { id: string; name: string; seats: unknown[] }[] }>(`/api/admin/vehicles?q=BA-${id}`);
  assert.equal(vehicles.status, 200);
  const v = vehicles.data.items.find((x) => x.id === vehicleId)!;
  assert.equal(v.seats.length, 17, 'seats compiled from the published layout');
  const patched = await admin.patch<{ id: string }>('/api/admin/vehicles', { id: vehicleId, name: 'Hiace ' + id + ' Deluxe', registration: 'BA-' + id, type: 'Hiace', operator: 'E2E Travels ' + id, operatorContact: '9800000001', emergencyContact: '9800000002', amenities: ['AC'] });
  assert.equal(patched.status, 200);
  assert.equal((await admin.patch('/api/admin/vehicles', { id: vehicleId, name: 'x', registration: 'BA-' + id, type: 'Hiace', operator: 'E', operatorContact: '9800000001', emergencyContact: '9800000002', layoutVersionId: 'other' })).status, 409, 'layouts are fixed after registration');
  assert.equal((await admin.delete(`/api/admin/vehicles/${vehicleId}`)).status, 409, 'a vehicle with trips cannot be deleted');
  const profile = await admin.get<{ trips: unknown[] }>(`/api/admin/vehicle-profile/${vehicleId}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.data.trips.length, 1);

  const spareVehicle = await admin.post<{ id: string }>('/api/admin/vehicles', { operatorId, name: 'Spare', registration: 'SP-' + id, type: 'Bus', operator: 'E', operatorContact: '9800000001', emergencyContact: '9800000002', seatLabels: ['A1', 'A2', 'B1', 'B2'] });
  assert.equal(spareVehicle.status, 201);
  assert.equal((await admin.delete(`/api/admin/vehicles/${spareVehicle.data.id}`)).status, 200);
  assert.equal(await findListed('/api/admin/vehicles', spareVehicle.data.id), undefined, 'a deleted vehicle is no longer listed');
  assert.equal((await admin.delete(`/api/admin/vehicles/${spareVehicle.data.id}`)).status, 404);

  assert.equal((await admin.delete(`/api/admin/drivers/${driver.id}`)).status, 409, 'an assigned driver stays');
  const d2 = await admin.post<{ id: string; operatorId: string }>('/api/admin/drivers', { name: 'Temp', email: `temp-${id}@test.local`, password: 'Temp-password-' + id, mobile: '9800000009', licenseNumber: 'TMP-' + id, licenseExpiry: new Date(Date.now() + 1e11).toISOString(), emergencyContact: '9800000008' });
  assert.equal(d2.status, 201);
  assert.equal((await admin.patch('/api/admin/drivers', { id: d2.data.id, name: 'Temp 2', email: `temp-${id}@test.local`, mobile: '9800000009', licenseNumber: 'TMP-' + id, licenseExpiry: new Date(Date.now() + 1e11).toISOString(), emergencyContact: '9800000008', active: false })).status, 200);
  assert.equal((await admin.delete(`/api/admin/drivers/${d2.data.id}`)).status, 200);
  const owners = await admin.get<{ items: { id: string }[] }>('/api/admin/owners');
  assert.ok(owners.data.items.some((o) => o.id === operatorId), 'a driver with records keeps their owner record');
  assert.ok(!owners.data.items.some((o) => o.id === d2.data.operatorId), 'the private owner record goes with its driver');

  const detail = await admin.get<{ sequence: { name: string }[]; points: { id: string }[] }>(`/api/admin/route-points/${routeId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.sequence.map((s) => s.name), [scenario.names.origin, scenario.names.mid, scenario.names.dest]);
  const point = await admin.post<{ id: string }>('/api/admin/route-points', { routeId, locationId: locations.origin, kind: 'BOARDING', name: 'Gate 3', landmark: 'Near the clock tower' });
  assert.equal(point.status, 201);
  assert.equal((await admin.post('/api/admin/route-points', { routeId, locationId: locations.origin, kind: 'DROPOFF', name: 'Nope' })).status, 400, 'the origin cannot be a drop-off point');
  assert.equal((await admin.patch('/api/admin/route-points', { id: point.data.id, routeId, locationId: locations.origin, kind: 'BOARDING', name: 'Gate 3', active: false })).status, 200);
  assert.equal((await admin.delete(`/api/admin/route-points/${point.data.id}`)).status, 200);
  assert.equal((await admin.get<{ points: unknown[] }>(`/api/admin/route-points/${routeId}`)).data.points.length, 0);

  const fares = await admin.patch<{ rows: { fromName: string; toName: string; amount: number; override: number | null; locked: boolean }[] }>('/api/admin/segment-fares', { routeId, vehicleType: 'Hiace', fromLocationId: locations.origin, toLocationId: locations.mid, amount: 450 });
  assert.equal(fares.status, 200);
  const leg = fares.data.rows.find((r) => r.fromName === scenario.names.origin && r.toName === scenario.names.mid)!;
  assert.equal(leg.amount, 450);
  assert.equal(leg.override, 450);
  assert.ok(fares.data.rows.find((r) => r.locked)?.amount === 1000, 'the full route keeps the trip fare');
  assert.equal((await admin.patch('/api/admin/segment-fares', { routeId, vehicleType: 'Hiace', fromLocationId: locations.origin, toLocationId: locations.dest, amount: 1 })).status, 400);
  assert.equal((await admin.delete(`/api/admin/routes/${routeId}`)).status, 409, 'a route with trips stays');

  const fare = await admin.post<{ id: string }>('/api/admin/fares', { routeId, vehicleType: 'Bus', fare: 1500 });
  assert.equal(fare.status, 201);
  assert.equal((await admin.patch('/api/admin/fares', { id: fare.data.id, routeId, vehicleType: 'Bus', fare: 1600 })).status, 200);
  assert.equal((await findListed<{ id: string; fare: number }>('/api/admin/fares', fare.data.id))?.fare, 1600, 'the updated fare is listed');
  assert.equal((await admin.delete(`/api/admin/fares/${fare.data.id}`)).status, 200);

  assert.equal((await admin.delete(`/api/admin/payment-qr/${qrId}`)).status, 409, 'a QR used by a trip stays');
  assert.ok(await findListed('/api/admin/payment-qr', qrId), 'the QR account is listed');
  assert.equal((await admin.post('/api/admin/payment-qr', { operatorId, label: 'No image', imageKey: 'missing', accountName: 'x', instructions: 'y' })).status, 400);

  const layouts = await admin.get<{ items: { id: string; versions: { status: string }[] }[]; templates: unknown[] }>('/api/admin/seat-layouts');
  assert.ok(layouts.data.items.some((l) => l.id === layoutId && l.versions[0].status === 'PUBLISHED'), "the layout is listed with its published version first");
  assert.ok(layouts.data.templates.length >= 4, "layout templates are offered");
  assert.equal((await admin.delete(`/api/admin/seat-layouts/${layoutId}`)).status, 409, 'published layouts are history');
  const draft = await admin.post<{ id: string }>('/api/admin/seat-layouts', { operatorId, name: 'Draft ' + id, vehicleType: 'Bus' });
  assert.equal(draft.status, 201);
  assert.equal((await admin.post(`/api/admin/seat-layouts/${draft.data.id}/publish`)).status, 422, 'an empty grid cannot be published');
  assert.equal((await admin.delete(`/api/admin/seat-layouts/${draft.data.id}`)).status, 200);
  assert.equal((await admin.post(`/api/admin/seat-layouts/${layoutId}/archive`)).status, 200);

  const spareLoc = await admin.post<{ id: string }>('/api/admin/locations', { name: 'Spare-' + id });
  assert.equal((await admin.patch('/api/admin/locations', { id: spareLoc.data.id, name: 'Spare2-' + id })).status, 200);
  assert.equal((await admin.delete(`/api/admin/locations/${spareLoc.data.id}`)).status, 200);
  assert.equal((await admin.delete(`/api/admin/locations/${locations.mid}`)).status, 409, 'a stop on a route stays');

  const settings = await admin.get<{ items: { holdMinutes: number; reviewMinutes: number }[] }>('/api/admin/settings');
  assert.equal(settings.status, 200);
  assert.equal((await admin.patch('/api/admin/settings', { holdMinutes: settings.data.items[0].holdMinutes, reviewMinutes: settings.data.items[0].reviewMinutes })).status, 200);
  assert.equal((await (await signedInDriver()).get('/api/admin/settings')).status, 403, 'settings are for the admin');

  const catalog = await admin.get<{ vehicles: unknown[]; drivers: unknown[]; routes: unknown[]; qrs: unknown[]; layouts: unknown[] }>('/api/admin/catalog');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.data.vehicles.length >= 1 && catalog.data.routes.length >= 1 && catalog.data.qrs.length >= 1, "the catalog lists vehicles, routes and QR accounts");
  const trips = await admin.get<{ items: { id: string }[] }>(`/api/admin/trips?q=${id}`);
  assert.ok(trips.data.items.some((t) => t.id === tripId), 'the trip is listed');
});

let booking: { id: string; reference: string; seat: string; paymentId: string; ticket: string; guest: ApiClient };

test('customer journey: search, seat map, hold, idempotent retry, proof upload, verification, ticket', async () => {
  const { names, tripId } = scenario;
  const pub = anon();
  const locs = await pub.get<{ name: string }[]>('/api/locations');
  assert.ok(locs.data.some((l) => l.name === names.origin), "the new location is in the public list");
  const search = await pub.get<{ items: { id: string; available: number; fare: number; journey: { from: number; to: number } }[]; nextPage: null }>(`/api/trips?origin=${encodeURIComponent(names.origin)}&destination=${encodeURIComponent(names.dest)}&page=1`);
  assert.equal(search.status, 200);
  const found = search.data.items.find((t) => t.id === tripId)!;
  assert.ok(found, 'the new trip is searchable');
  assert.equal(found.available, 17);
  assert.equal(found.fare, 1000);
  const leg = await pub.get<{ items: { id: string; fare: number; journey: { from: number; to: number } }[] }>(`/api/trips?origin=${encodeURIComponent(names.origin)}&destination=${encodeURIComponent(names.mid)}`);
  // 80 of 200 km at 1000 = 400. The 450 override saved later never touches a trip already on sale.
  assert.equal(leg.data.items.find((t) => t.id === tripId)?.fare, 400, 'trips snapshot their fare matrix at creation');
  assert.equal(leg.data.items.find((t) => t.id === tripId)?.journey.to, 1);
});

test('customer journey continued: hold, pay, verify, ticket, driver manifest', async () => {
  const { tripId, admin, driver } = scenario;
  const pub = anon();
  const trip = await pub.get<{ seats: { id: string; label: string; state: string }[]; bookingOpen: boolean; fare: number }>(`/api/trips/${tripId}`);
  assert.equal(trip.status, 200);
  const available = trip.data.seats.filter((s) => s.state === 'AVAILABLE');
  assert.equal(available.length, 17);
  const seat = available[0].id,
    seat2 = available[1].id,
    seat3 = available[2].id;

  const guest = anon();
  const key = randomUUID() + randomUUID();
  const body = { tripId, seats: [seat], name: 'Sita Guest', phone: '9841000000', email: 'sita-' + scenario.id + '@test.local', idempotencyKey: key };
  const held = await guest.post<{ id: string; reference: string }>('/api/bookings', body);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  assert.match(held.data.reference, /^SY-[A-Z0-9]{12}$/);
  assert.ok(guest.jar.has('booking_' + held.data.id), 'capability cookie set');
  const replay = await guest.post<{ id: string }>('/api/bookings', body);
  assert.equal(replay.status, 201);
  assert.equal(replay.data.id, held.data.id, 'same idempotency key replays the same booking');
  assert.equal((await guest.post('/api/bookings', { ...body, name: 'Someone Else' })).status, 409, 'changed data under the same key is refused');
  assert.equal((await anon().post('/api/bookings', { ...body, idempotencyKey: randomUUID() + randomUUID() })).status, 409, 'the seat is held');
  assert.equal((await anon().get(`/api/bookings/${held.data.id}`)).status, 404, 'no cookie, no booking');
  const mine = await guest.get<{ status: string; accessHash?: string; payment: { status: string }; qrSnapshot: { imageKey: string } }>(`/api/bookings/${held.data.id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.status, 'HELD');
  assert.equal(mine.data.accessHash, undefined, 'secrets never leave the server');
  assert.equal(mine.data.qrSnapshot.imageKey, scenario.qrImageId);
  const map = await pub.get<{ seats: { id: string; state: string }[] }>(`/api/trips/${tripId}`);
  assert.equal(map.data.seats.find((s) => s.id === seat)?.state, 'HELD');
  assert.equal((await guest.get(`/api/bookings/${held.data.id}/ticket`)).status, 409, 'no ticket before verification');
  assert.equal((await guest.post(`/api/bookings/${held.data.id}/clarification`, { message: 'hello' })).status, 409, 'clarification only while under review');

  const proof = new FormData();
  proof.set('image', await pngFile('proof.png', '#0a0'));
  proof.set('claimedAmount', '1000');
  proof.set('method', 'eSewa');
  proof.set('transactionRef', 'TX-' + scenario.id);
  const submitted = await guest.post(`/api/bookings/${held.data.id}/proof`, proof);
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  assert.equal((await guest.get<{ status: string }>(`/api/bookings/${held.data.id}`)).data.status, 'PAYMENT_REVIEW');
  assert.equal((await guest.post(`/api/bookings/${held.data.id}/clarification`, { message: 'Paid from my mother’s account.' })).status, 200);

  const queue = await admin.get<{ items: { id: string; status: string; duplicateReference: boolean; proofs: { imageKey: string }[]; booking: { id: string } }[] }>('/api/admin/payments?page=1');
  assert.equal(queue.status, 200);
  const payment = queue.data.items.find((p) => p.booking.id === held.data.id)!;
  assert.ok(payment && payment.status === 'SUBMITTED' && payment.proofs.length === 1, "the submitted payment with one proof is in the review queue");
  assert.equal((await anon().get(`/api/images/${payment.proofs[0].imageKey}`)).status, 404, 'proofs are private');
  assert.equal((await admin.get(`/api/images/${payment.proofs[0].imageKey}`)).status, 200, 'the admin can see the proof');
  assert.equal((await guest.get(`/api/images/${payment.proofs[0].imageKey}`)).status, 200, 'so can the booking owner');
  assert.equal((await admin.post(`/api/admin/payments/${payment.id}`, { action: 'verify', note: 'Checked', verifiedAmount: 1000 })).status, 400, 'verification requires confirmation and evidence');
  assert.equal((await admin.post(`/api/admin/payments/${payment.id}`, { action: 'verify', note: 'Checked', verifiedAmount: 900, confirm: true, bankEvidence: 'ledger 1' })).status, 400, 'short payment is not accepted');
  const verified = await admin.post<{ status: string }>(`/api/admin/payments/${payment.id}`, { action: 'verify', note: 'Matched bank ledger', verifiedAmount: 1000, confirm: true, bankEvidence: 'ledger ' + scenario.id });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  assert.equal(verified.data.status, 'CONFIRMED');
  assert.equal((await admin.post(`/api/admin/payments/${payment.id}`, { action: 'reject', note: 'oops' })).status, 409, 'verified payments are final');
  const confirmed = await guest.get<{ status: string; payment: { status: string; note: string } }>(`/api/bookings/${held.data.id}`);
  assert.equal(confirmed.data.status, 'CONFIRMED');
  assert.equal(confirmed.data.payment.status, 'VERIFIED');
  const ticket = await guest.get<{ ticket: string }>(`/api/bookings/${held.data.id}/ticket`);
  assert.equal(ticket.status, 200);
  assert.match(ticket.data.ticket, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const audit = await admin.get<{ action: string }[]>(`/api/admin/audit?targetId=${held.data.id}`);
  assert.equal(audit.status, 200);
  const actions = audit.data.map((a) => a.action);
  for (const expected of ['PROOF_SUBMITTED', 'CUSTOMER_CLARIFICATION', 'PAYMENT_VERIFY'])
    assert.ok(actions.includes(expected), 'the audit history shows ' + expected + '; got ' + actions.join(','));

  const reports = await admin.get<{ trips: number; bookings: number; confirmed: number; revenue: number }>('/api/admin/reports');
  assert.ok(reports.data.confirmed >= 1 && reports.data.revenue >= 1000, "reports count the confirmed booking and its verified revenue");
  assert.equal((await admin.get<{ items: { id: string }[] }>('/api/admin/bookings')).data.items.some((b) => b.id === held.data.id), true);

  // Walk-in booking by the admin, then seat blocking rules.
  const manual = await admin.post<{ id: string; reference: string }>('/api/admin/manual-bookings', { tripId, seats: [seat2], name: 'Walk In', phone: '9841000001', idempotencyKey: randomUUID() + randomUUID(), method: 'CASH', confirm: true, note: 'Paid cash at counter', bankEvidence: 'receipt 7' });
  assert.equal(manual.status, 201, JSON.stringify(manual.data));
  assert.equal((await admin.post('/api/admin/manual-bookings', { tripId, seats: [seat3], name: 'Walk In', phone: '9841000001', idempotencyKey: randomUUID() + randomUUID(), method: 'CASH', confirm: false, note: 'no evidence' })).status, 400);
  assert.equal((await admin.patch('/api/admin/trip-seats', { tripSeatId: seat, blocked: true, note: 'maintenance' })).status, 409, 'a reserved seat cannot be blocked');
  assert.equal((await admin.patch('/api/admin/trip-seats', { tripSeatId: seat3, blocked: true, note: 'broken recliner' })).status, 200);
  assert.equal((await pub.get<{ seats: { id: string; state: string }[] }>(`/api/trips/${tripId}`)).data.seats.find((s) => s.id === seat3)?.state, 'BLOCKED');
  assert.equal((await admin.patch('/api/admin/trip-seats', { tripSeatId: seat3, blocked: false, note: 'fixed' })).status, 200);
  assert.equal((await admin.delete(`/api/admin/trips/${tripId}`)).status, 409, 'a trip with bookings cannot be deleted');
  const search = await pub.get<{ items: { id: string; available: number }[] }>(`/api/trips?origin=${encodeURIComponent(scenario.names.origin)}&destination=${encodeURIComponent(scenario.names.dest)}`);
  assert.equal(search.data.items.find((t) => t.id === tripId)?.available, 15);

  // Driver side.
  const drv = anon();
  assert.equal((await drv.login('DRIVER', driver.email, driver.password)).status, 200);
  assert.equal((await drv.get('/api/admin/payments')).status, 403);
  const trips = await drv.get<{ items: { id: string; confirmedPassengers: number; remainingSeats: number }[] }>('/api/driver/trips');
  const t = trips.data.items.find((x) => x.id === tripId)!;
  assert.equal(t.confirmedPassengers, 2);
  assert.equal(t.remainingSeats, 15);
  const manifest = await drv.get<{ items: { id: string; name: string; seatLabel: string; checkIn: null | { status: string } }[] }>(`/api/driver/passengers?tripId=${tripId}`);
  assert.equal(manifest.data.items.length, 2);
  const sita = manifest.data.items.find((p) => p.name === 'Sita Guest')!;
  assert.equal((await drv.post('/api/driver/check-in', { passengerId: sita.id, status: 'CHECKED_IN' })).status, 200);
  assert.equal((await drv.post('/api/driver/check-in', { passengerId: sita.id, status: 'BOARDED' })).status, 200);
  assert.equal((await drv.post('/api/driver/check-in', { passengerId: sita.id, status: 'CHECKED_IN' })).status, 409, 'cannot un-board');
  const valid = await drv.post<{ verified: boolean; reference: string }>('/api/driver/validate-ticket', { ticket: ticket.data.ticket });
  assert.equal(valid.status, 200);
  assert.equal(valid.data.reference, held.data.reference);
  assert.equal((await drv.post('/api/driver/validate-ticket', { ticket: ticket.data.ticket + 'x' })).status, 400);
  assert.equal((await drv.post('/api/driver/issues', { tripId, note: 'Passenger arrived late' })).status, 201);
  assert.equal((await drv.get(`/api/driver/passengers?tripId=nope`)).status, 404);

  booking = { id: held.data.id, reference: held.data.reference, seat, paymentId: payment.id, ticket: ticket.data.ticket, guest };
});

test('ticket email is delivered and booking tracking works with the emailed code', { skip: !!external }, async () => {
  const mail = await waitFor(() => sink.mails.find((m) => mailText(m).includes(booking.reference) && /Booking confirmed/.test(mailText(m))), 20000, 'ticket email');
  assert.ok(mail.to.includes('sita-' + scenario.id + '@test.local'), "the ticket email goes to the booking email address");
  const text = mailText(mail);
  assert.ok(text.includes(scenario.names.origin) && text.includes(scenario.names.dest), "the ticket email names origin and destination");

  const other = anon();
  const req = await other.post<{ challengeId: string }>('/api/track/request', { reference: booking.reference, phone: '9841000000' });
  assert.equal(req.status, 200, JSON.stringify(req.data));
  assert.ok(other.jar.has('otp_' + req.data.challengeId), "the OTP cookie is set");
  const code = await waitFor(() => {
    const m = sink.mails.filter((x) => /access code/i.test(mailText(x))).at(-1);
    return m ? mailText(m).match(/code is (\d{6})/)?.[1] : undefined;
  }, 20000, 'access code email');
  assert.equal((await other.post('/api/track/verify', { challengeId: req.data.challengeId, code: code === '000000' ? '000001' : '000000' })).status, 400, 'wrong code');
  const ok = await other.post<{ id: string }>('/api/track/verify', { challengeId: req.data.challengeId, code });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.id, booking.id);
  assert.equal((await other.get<{ status: string }>(`/api/bookings/${booking.id}`)).data.status, 'CONFIRMED');
  assert.equal((await other.post('/api/track/verify', { challengeId: req.data.challengeId, code })).status, 400, 'codes are single use');
  assert.equal((await booking.guest.get(`/api/bookings/${booking.id}`)).status, 404, 'recovery rotates the old device out');
  const unknown = await anon().post<{ challengeId: string }>('/api/track/request', { reference: 'SY-DOESNOTEXIST', phone: '9841000000' });
  assert.equal(unknown.status, 200, 'unknown bookings are not revealed');
});

test('website content is editable by the platform admin and served publicly', async () => {
  const { admin } = scenario;
  const current = await admin.get<{ brand: { name: string }; hero: { title: string } }>('/api/admin/site-content');
  assert.equal(current.status, 200);
  try {
    const changed = await admin.patch<{ brand: { name: string } }>('/api/admin/site-content', { ...current.data, brand: { ...current.data.brand, name: 'Sajilo Yatra E2E' } });
    assert.equal(changed.status, 200);
    assert.equal((await anon().get<{ brand: { name: string } }>('/api/site-content')).data.brand.name, 'Sajilo Yatra E2E');
    assert.equal((await (await signedInDriver()).get('/api/admin/site-content')).status, 403, 'drivers do not manage the website');
    assert.equal((await admin.patch('/api/admin/site-content', { ...current.data, brand: { ...current.data.brand, logo: 'javascript:alert(1)' } })).status, 400);
  } finally {
    // The public site must look exactly as before even when an assertion above fails.
    assert.equal((await admin.patch('/api/admin/site-content', current.data)).status, 200, 'restored');
  }
});

test('booking search and details, manifest download, ticket checks by the admin, cancellation and refund', async () => {
  const { admin, tripId, id } = scenario;
  const found = await admin.get<{ items: { id: string }[] }>('/api/admin/bookings?q=' + encodeURIComponent(booking.reference.toLowerCase()));
  assert.deepEqual(found.data.items.map((b) => b.id), [booking.id], 'search by reference is case-insensitive');
  assert.ok((await admin.get<{ items: { id: string }[] }>('/api/admin/bookings?q=9841000000&status=CONFIRMED')).data.items.some((b) => b.id === booking.id));
  assert.ok(!(await admin.get<{ items: { id: string }[] }>('/api/admin/bookings?status=CANCELLED')).data.items.some((b) => b.id === booking.id));
  const detail = await admin.get<{ reference: string; passengers: unknown[]; history: { action: string }[]; accessHash?: string }>(`/api/admin/bookings/${booking.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.accessHash, undefined, 'no secrets in booking details');
  assert.ok(detail.data.history.some((h) => h.action === 'PAYMENT_VERIFY'));

  const csv = await admin.call<string>('GET', `/api/admin/trips/${tripId}/manifest`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /^text\/csv; charset=utf-8/);
  assert.match(csv.headers.get('content-disposition') || '', /^attachment; filename="manifest-.+\.csv"$/);
  assert.ok(csv.data.includes('"Sita Guest"') && csv.data.includes('"BOARDED"') && csv.data.includes('"Walk In"'), 'confirmed passengers with check-in status');
  assert.ok(!csv.data.includes('proof') && !csv.data.includes('eyJ'), 'no payment evidence or tokens');

  const checked = await admin.post<{ reference: string; passengers: { name: string; checkIn: string }[] }>('/api/admin/validate-ticket', { ticket: booking.ticket });
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  assert.equal(checked.data.reference, booking.reference);
  assert.equal(checked.data.passengers[0].checkIn, 'BOARDED');
  assert.equal((await admin.post('/api/admin/validate-ticket', { ticket: booking.ticket.slice(0, -2) + 'xx' })).status, 400);
  const drv = await signedInDriver();
  assert.equal((await drv.get(`/api/admin/trips/${tripId}/manifest`)).status, 403);
  assert.equal((await drv.post(`/api/admin/bookings/${booking.id}/cancel`, { reason: 'Not allowed' })).status, 403);

  const printable = await admin.get<{ ticket: string; reference: string }>(`/api/admin/bookings/${booking.id}/ticket`);
  assert.equal(printable.status, 200);
  assert.equal(printable.data.reference, booking.reference);

  // Cancelling a paid booking releases the seat and opens a refund, without marking anything refunded.
  const before = (await admin.get<{ cancelledBookings: number; openRefunds: number }>('/api/admin/reports')).data;
  assert.equal((await admin.post(`/api/admin/bookings/${booking.id}/cancel`, {})).status, 400, 'a reason is required');
  const cancelled = await admin.post<{ status: string; cancellation: { refundStatus: string; paidAmount: number; refundAmount: number | null } }>(
    `/api/admin/bookings/${booking.id}/cancel`,
    { reason: 'Customer requested cancellation' },
  );
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.status, 'CANCELLED');
  assert.equal(cancelled.data.cancellation.refundStatus, 'PENDING');
  assert.equal(cancelled.data.cancellation.paidAmount, 1000);
  assert.equal(cancelled.data.cancellation.refundAmount, null);
  assert.equal((await admin.post(`/api/admin/bookings/${booking.id}/cancel`, { reason: 'Again' })).status, 409, 'no double cancellation');
  assert.equal((await admin.post(`/api/admin/bookings/${booking.id}/cancel`, { reason: 'Refund 5000 please', refundAmount: 5000 })).status, 400, 'clients cannot name a refund amount');
  assert.equal((await admin.post('/api/admin/validate-ticket', { ticket: booking.ticket })).status, 409, 'a cancelled ticket fails the check');
  assert.equal((await anon().get<{ seats: { id: string; state: string }[] }>(`/api/trips/${tripId}`)).data.seats.find((s) => s.id === booking.seat)?.state, 'AVAILABLE');
  const after = (await admin.get<{ cancelledBookings: number; openRefunds: number }>('/api/admin/reports')).data;
  assert.equal(after.cancelledBookings, before.cancelledBookings + 1);
  assert.equal(after.openRefunds, before.openRefunds + 1);
  assert.ok(!(await admin.call<string>('GET', `/api/admin/trips/${tripId}/manifest`)).data.includes('Sita Guest'), 'cancelled passengers leave the manifest');
  assert.equal((await admin.post(`/api/admin/bookings/${booking.id}/refund`, { action: 'approve', note: 'Full refund', amount: 1001 })).status, 400);
  assert.equal((await admin.post(`/api/admin/bookings/${booking.id}/refund`, { action: 'approve', note: 'Full refund' })).status, 200);
  const done = await admin.post<{ refundStatus: string; refundAmount: number }>(`/api/admin/bookings/${booking.id}/refund`, { action: 'complete', note: 'Sent by eSewa', reference: 'ES-' + id });
  assert.equal(done.data.refundStatus, 'COMPLETED');
  assert.equal(done.data.refundAmount, 1000);
});

test('the expiration job is protected and idempotent', async () => {
  const secret = process.env.CRON_SECRET;
  const c = anon();
  assert.equal((await c.post('/api/jobs/expire')).status, 401);
  if (!secret || secret.length < 32) return;
  const r = await c.call<{ expired: number; notifications: { sent: number } }>('POST', '/api/jobs/expire', {}, { Authorization: 'Bearer ' + secret });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(typeof r.data.expired, 'number');
});

test('deactivating a driver ends their sessions and closes sales; reactivating lets them back in', async () => {
  const { admin, driver, tripId, names, id } = scenario;
  const drv = await signedInDriver();
  assert.equal((await admin.patch('/api/admin/drivers', { ...driver.form, id: driver.id, active: false })).status, 200);
  assert.equal((await drv.get('/api/driver/trips')).status, 401, 'their session ended');
  assert.equal((await anon().login('DRIVER', driver.email, driver.password)).status, 401);
  const search = await anon().get<{ items: { id: string }[] }>(`/api/trips?origin=${encodeURIComponent(names.origin)}&destination=${encodeURIComponent(names.dest)}`);
  assert.ok(!search.data.items.some((t) => t.id === tripId), 'their scheduled trips stop selling');
  assert.equal((await admin.patch('/api/admin/drivers', { ...driver.form, id: driver.id, active: true })).status, 200);
  assert.equal((await drv.login('DRIVER', driver.email, driver.password)).status, 200);
  const reopened = await admin.get<{ items: { id: string; bookingOpen: boolean }[] }>(`/api/admin/trips?q=${id}`);
  assert.equal(reopened.data.items.find((t) => t.id === tripId)?.bookingOpen, false, 'sales stay closed until the admin reopens the trip deliberately');
  const t = (await anon().get<{ vehicle: { id: string }; route: { id: string }; departure: string; arrival: string; boardingPoint: string; dropPoint: string; fare: number; status: string }>(`/api/trips/${tripId}`)).data;
  const reopen = await admin.patch('/api/admin/trips', { id: tripId, vehicleId: t.vehicle.id, routeId: t.route.id, driverId: scenario.driver.id, paymentQRId: scenario.qrId, departure: t.departure, arrival: t.arrival, boardingPoint: t.boardingPoint, dropPoint: t.dropPoint, fare: t.fare, status: t.status, bookingOpen: true });
  assert.equal(reopen.status, 200, JSON.stringify(reopen.data));
  assert.equal((await admin.patch('/api/admin/trips', { id: tripId, vehicleId: t.vehicle.id, routeId: t.route.id, driverId: scenario.driver.id, paymentQRId: scenario.qrId, departure: t.departure, arrival: t.arrival, boardingPoint: t.boardingPoint, dropPoint: t.dropPoint, fare: 1200, status: t.status })).status, 409, 'fares are fixed once a trip has bookings');
  assert.equal((await admin.patch('/api/admin/trips', { id: tripId, vehicleId: t.vehicle.id, routeId: t.route.id, driverId: scenario.driver.id, paymentQRId: scenario.qrId, departure: t.departure, arrival: t.arrival, boardingPoint: t.boardingPoint, dropPoint: t.dropPoint, fare: t.fare, status: 'CANCELLED' })).status, 409, 'active bookings block a plain status change');
  // The explicit workflow cancels the trip together with the walk-in booking still on it.
  const cancelled = await admin.post<{ bookingsCancelled: number; refundsToReview: number }>(`/api/admin/trips/${tripId}/cancel`, { reason: 'Vehicle breakdown' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.bookingsCancelled, 1);
  assert.equal(cancelled.data.refundsToReview, 1, 'the cash walk-in is owed a refund');
  const listed = await admin.get<{ items: { id: string }[] }>(`/api/admin/trips?status=CANCELLED&q=${id}`);
  assert.ok(listed.data.items.some((x) => x.id === tripId), 'the trip is listed as cancelled');
  assert.equal((await admin.post(`/api/admin/trips/${tripId}/cancel`, { reason: 'Again' })).status, 409);
});
