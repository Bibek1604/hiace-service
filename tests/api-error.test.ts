import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { classifyError, describeError } from '../src/lib/api-error';
import { ApiError } from '../src/lib/errors';

const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 't' });

test('no thrown value is ever classified as a 500', () => {
  const samples: unknown[] = [
    new Error('boom'), 'string', null, undefined, { weird: true }, new TypeError('x'),
    new ApiError(500, 'The upstream service failed.'), new ApiError(502, 'The gateway failed here.'), new SyntaxError('json'),
    new Prisma.PrismaClientInitializationError('down', 't'),
    new Prisma.PrismaClientValidationError('v', { clientVersion: 't' }),
    ...['P1001', 'P1017', 'P2002', 'P2003', 'P2021', 'P2022', 'P2024', 'P2025', 'P2034', 'P9999'].map(known),
    Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' }),
    Object.assign(new Error('denied'), { name: 'AccessDenied' }),
  ];
  for (const e of samples) {
    const c = classifyError(e);
    assert.ok(c.status >= 400 && c.status < 600 && c.status !== 500, String(e) + ' -> ' + c.status);
    assert.ok(c.message.length > 10);
    assert.doesNotMatch(c.message, /prisma|stack|at .*\(|select |insert /i);
  }
});

test('errors map to accurate, specific statuses', () => {
  const status = (e: unknown) => classifyError(e).status;
  assert.equal(status(known('P2002')), 409);
  assert.equal(status(known('P2025')), 404);
  assert.equal(status(known('P2034')), 409);
  assert.equal(status(known('P1001')), 503);
  assert.equal(status(known('P2021')), 503);
  assert.equal(status(new ApiError(404, 'nope')), 404);
  assert.equal(status(new ApiError(429, 'slow')), 429);
  assert.equal(status(new SyntaxError('bad json')), 400);
  assert.equal(status(z.string().safeParse(1).error), 400);
  assert.ok(classifyError(known('P1001')).retryAfter);
  assert.equal(classifyError(new ApiError(404, 'nope')).message, 'nope');
});

test('Prisma diagnostics contain only a code and optional model name', () => {
  const error = new Prisma.PrismaClientKnownRequestError('sensitive database details', {
    code: 'P2021',
    clientVersion: 't',
    meta: { modelName: 'Location' },
  });
  assert.equal(describeError(error), 'PrismaClientKnownRequestError:P2021:model=Location');
  assert.doesNotMatch(describeError(error), /sensitive|details/i);
});

const upload = { method: 'POST', path: ['admin', 'uploads'] };

test('a failure names the action that could not be completed', () => {
  const failed = (method: string, path: string[]) => classifyError(new Error('boom'), { method, path }).message;
  assert.match(failed('POST', ['bookings']), /reserve your seats/);
  assert.match(failed('POST', ['bookings', 'abc', 'proof']), /submit your payment proof/);
  assert.match(failed('GET', ['admin', 'vehicles']), /load the vehicles/);
  assert.match(failed('DELETE', ['admin', 'vehicles', 'abc']), /delete this vehicle/);
  assert.match(failed('POST', ['driver', 'uploads']), /upload your image/);
  assert.match(classifyError(new Error('boom')).message, /complete that/);
});

test('missing storage credentials are reported as a storage problem', () => {
  const missing = new Error('Could not load credentials from any providers');
  missing.name = 'CredentialsProviderError';
  const c = classifyError(missing, upload);
  assert.equal(c.status, 503);
  assert.match(c.message, /Image storage isn’t available, so we couldn’t upload your image/);
  assert.match(c.message, /storage settings/);
  assert.match(classifyError(missing, { method: 'POST', path: ['bookings', 'a', 'proof'] }).message, /contact the driver/);
});

test('any refusal from the storage service is a storage problem', () => {
  const refused = Object.assign(new Error('not supported'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } });
  assert.match(classifyError(refused, upload).message, /Image storage/);
});

test('form problems read as plain sentences', () => {
  const schema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    tripId: z.string(),
    seats: z.array(z.string()).min(1),
    mobile: z.string().regex(/^9/, 'Enter a Nepal mobile number.'),
  });
  const message = (input: unknown) => classifyError(schema.safeParse(input).error).message;
  const valid = { name: 'Ram', email: 'a@b.co', tripId: 't', seats: ['A1'], mobile: '98' };
  assert.equal(message({ ...valid, name: 'R' }), 'Name must be at least 2 characters.');
  assert.equal(message({ ...valid, email: 'x' }), 'Please enter a valid email address.');
  assert.equal(message({ ...valid, tripId: undefined }), 'Please choose the ride.');
  assert.equal(message({ ...valid, seats: [] }), 'Please add at least one seat.');
  assert.equal(message({ ...valid, mobile: '1' }), 'Enter a Nepal mobile number.');
  assert.equal(message({}).split('. ').length, 3);
});
