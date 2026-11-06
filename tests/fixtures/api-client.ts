import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import sharp from 'sharp';

/**
 * Black-box HTTP client for the running application: keeps cookies like a browser, sends the Origin
 * header the CSRF guard requires, and parses JSON. Shared by the API suite and the Playwright specs.
 */
export type Reply<T = unknown> = { status: number; data: T; headers: Headers };

/** E2E_DEBUG=1 prints every request; E2E_DEBUG_FILE=<path> appends them to a file (survives test-runner output capture). */
function trace(line: string) {
  if (process.env.E2E_DEBUG_FILE) appendFileSync(process.env.E2E_DEBUG_FILE, new Date().toISOString() + ' ' + line + String.fromCharCode(10));
  else if (process.env.E2E_DEBUG) console.error('[e2e] ' + line);
}

export class ApiClient {
  readonly jar = new Map<string, string>();
  constructor(
    readonly base: string,
    readonly origin = base,
  ) {}
  get cookieHeader() {
    return [...this.jar].map(([k, v]) => k + '=' + v).join('; ');
  }
  async call<T = unknown>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = { Origin: this.origin, ...extra };
    if (this.jar.size) headers.Cookie = this.cookieHeader;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const started = Date.now();
    trace(method + ' ' + path + ' ...');
    const r = await fetch(this.base + path, { method, headers, body: payload, redirect: 'manual' });
    trace(method + ' ' + path + ' -> ' + r.status + ' in ' + (Date.now() - started) + ' ms');
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const eq = kv.indexOf('=');
      const name = kv.slice(0, eq).trim(),
        value = kv.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=.*1970/i.test(a));
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await r.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* binary or empty body */
    }
    return { status: r.status, data: data as T, headers: r.headers };
  }
  get<T = unknown>(path: string) {
    return this.call<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown) {
    return this.call<T>('POST', path, body ?? {});
  }
  patch<T = unknown>(path: string, body?: unknown) {
    return this.call<T>('PATCH', path, body ?? {});
  }
  delete<T = unknown>(path: string) {
    return this.call<T>('DELETE', path);
  }
  async login(role: 'ADMIN' | 'DRIVER', email: string, password: string) {
    return this.post<{ role: string; error?: string }>('/api/auth/login', { role, email, password });
  }
}

/** Mirrors prisma/seed.ts: placeholder values in .env mean the development defaults were seeded. */
const real = (v?: string) => (v && !v.startsWith('replace-') && !v.startsWith('admin@example') ? v : undefined);
export function adminCredentials(env: Record<string, string | undefined> = process.env) {
  return {
    email: (env.E2E_ADMIN_EMAIL ?? real(env.ADMIN_EMAIL) ?? 'admin@sajiloyatra.com').toLowerCase(),
    password: env.E2E_ADMIN_PASSWORD ?? real(env.ADMIN_PASSWORD) ?? 'SajiloAdmin@2026!',
  };
}

/** A real PNG with the given colour, so uploads pass the content sniffing in src/lib/images.ts. */
export async function pngFile(name: string, background = '#2563eb') {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer();
  return new File([new Uint8Array(png)], name, { type: 'image/png' });
}

export const uid = () => randomUUID().slice(0, 8);
export const phone = () => '98' + String(Math.floor(10000000 + Math.random() * 89999999));
export const isoIn = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

export type Scenario = Awaited<ReturnType<typeof seedScenario>>;

/**
 * Builds a complete, uniquely named sales scenario through the admin API: a driver (whose private
 * Operator is the scenario's tenant), three locations, a published layout, a vehicle, a payment QR and
 * a bookable trip two days out.
 */
export async function seedScenario(base: string, origin = base) {
  const id = uid();
  const admin = new ApiClient(base, origin);
  const creds = adminCredentials();
  const a = await admin.login('ADMIN', creds.email, creds.password);
  if (a.status !== 200) throw new Error('admin login failed (' + a.status + '): ' + JSON.stringify(a.data));

  const driverPassword = 'Driver-password-' + id + '!';
  const driverForm = {
    name: 'Driver ' + id,
    email: `driver-${id}@test.local`,
    mobile: '9800000003',
    licenseNumber: 'LIC-' + id,
    licenseExpiry: isoIn(24 * 365 * 5),
    emergencyContact: '9800000004',
  };
  const driver = await admin.post<{ id: string; operatorId: string }>('/api/admin/drivers', { ...driverForm, password: driverPassword });
  if (driver.status !== 201) throw new Error('driver create failed: ' + JSON.stringify(driver.data));
  const operatorId = driver.data.operatorId;

  const names = { origin: 'Kathmandu-' + id, mid: 'Mugling-' + id, dest: 'Pokhara-' + id };
  const loc: Record<string, string> = {};
  for (const [k, name] of Object.entries(names)) {
    const r = await admin.post<{ id: string }>('/api/admin/locations', { name });
    if (r.status !== 201) throw new Error('location create failed: ' + JSON.stringify(r.data));
    loc[k] = r.data.id;
  }

  const layout = await admin.post<{ id: string; versions: { id: string }[] }>('/api/admin/seat-layouts', {
    operatorId,
    name: 'Hiace ' + id,
    vehicleType: 'Hiace',
    template: 'hiace_17',
  });
  if (layout.status !== 201) throw new Error('layout create failed: ' + JSON.stringify(layout.data));
  const published = await admin.post<{ id: string; seatCount: number }>(`/api/admin/seat-layouts/${layout.data.id}/publish`);
  if (published.status !== 200) throw new Error('layout publish failed: ' + JSON.stringify(published.data));

  const vehicle = await admin.post<{ id: string }>('/api/admin/vehicles', {
    operatorId,
    name: 'Hiace ' + id,
    registration: 'BA-' + id,
    type: 'Hiace',
    operator: 'E2E Travels ' + id,
    operatorContact: '9800000001',
    emergencyContact: '9800000002',
    amenities: ['AC', 'Water'],
    layoutVersionId: published.data.id,
  });
  if (vehicle.status !== 201) throw new Error('vehicle create failed: ' + JSON.stringify(vehicle.data));

  const route = await admin.post<{ id: string }>('/api/admin/routes', {
    operatorId,
    originId: loc.origin,
    destinationId: loc.dest,
    distanceKm: 200,
    durationMinutes: 360,
    baseFare: 1000,
    stops: [{ locationId: loc.mid, offsetMinutes: 150, kmFromOrigin: 80, allowBoarding: true, allowDropoff: true }],
  });
  if (route.status !== 201) throw new Error('route create failed: ' + JSON.stringify(route.data));

  const form = new FormData();
  form.set('image', await pngFile('qr.png'));
  form.set('purpose', 'qr');
  const qrImage = await admin.post<{ id: string }>('/api/admin/uploads', form);
  if (qrImage.status !== 201) throw new Error('qr upload failed: ' + JSON.stringify(qrImage.data));
  const qr = await admin.post<{ id: string }>('/api/admin/payment-qr', {
    operatorId,
    label: 'eSewa ' + id,
    imageKey: qrImage.data.id,
    accountName: 'E2E Travels ' + id,
    accountNumber: '9800000000',
    instructions: 'Scan and pay the exact amount. Use the booking reference as remarks.',
  });
  if (qr.status !== 201) throw new Error('payment-qr create failed: ' + JSON.stringify(qr.data));

  const departure = isoIn(48),
    arrival = isoIn(54);
  const trip = await admin.post<{ id: string }>('/api/admin/trips', {
    operatorId,
    vehicleId: vehicle.data.id,
    routeId: route.data.id,
    driverId: driver.data.id,
    paymentQRId: qr.data.id,
    departure,
    arrival,
    boardingPoint: 'New Bus Park',
    dropPoint: 'Prithvi Chowk',
    fare: 1000,
  });
  if (trip.status !== 201) throw new Error('trip create failed: ' + JSON.stringify(trip.data));

  return {
    id,
    admin,
    operatorId,
    driver: { id: driver.data.id, email: driverForm.email, password: driverPassword, form: driverForm },
    names,
    locations: loc,
    layoutId: layout.data.id,
    layoutVersionId: published.data.id,
    vehicleId: vehicle.data.id,
    routeId: route.data.id,
    qrId: qr.data.id,
    qrImageId: qrImage.data.id,
    tripId: trip.data.id,
    departure,
    arrival,
  };
}
