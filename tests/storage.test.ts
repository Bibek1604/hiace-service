import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteObject, readObject, storageDir, storageMode } from '../src/lib/storage';

test('without S3_BUCKET images go to the database unless the local disk driver is chosen', () => {
  delete process.env.S3_BUCKET;
  delete process.env.STORAGE_DRIVER;
  assert.equal(storageMode(), 'database');
});

test('STORAGE_DRIVER=local uses the disk and bad object references are rejected', async () => {
  delete process.env.S3_BUCKET;
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = await mkdtemp(join(tmpdir(), 'sy-storage-'));
  assert.equal(storageMode(), 'local');
  assert.equal(storageDir(), process.env.STORAGE_DIR);
  await assert.rejects(readObject({ id: '../../etc/passwd', purpose: 'qr' }), (e: unknown) => (e as { status?: number }).status === 400);
  await assert.rejects(readObject({ id: 'abc', purpose: 'qr/../proof' }), (e: unknown) => (e as { status?: number }).status === 400);
});

test('a missing local object is a 404, a stored one is returned byte for byte and can be deleted', async () => {
  delete process.env.S3_BUCKET;
  process.env.STORAGE_DRIVER = 'local';
  const dir = await mkdtemp(join(tmpdir(), 'sy-storage-'));
  process.env.STORAGE_DIR = dir;
  await assert.rejects(readObject({ id: 'missing-id', purpose: 'vehicle' }), (e: unknown) => (e as { status?: number }).status === 404);
  await mkdir(join(dir, 'vehicle'), { recursive: true });
  const bytes = Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]);
  await writeFile(join(dir, 'vehicle', 'abc-123.webp'), bytes);
  assert.deepEqual(await readObject({ id: 'abc-123', purpose: 'vehicle' }), bytes);
  assert.deepEqual(await readFile(join(dir, 'vehicle', 'abc-123.webp')), bytes);
  await deleteObject('vehicle/abc-123.webp');
  await assert.rejects(stat(join(dir, 'vehicle', 'abc-123.webp')));
  await deleteObject('vehicle/abc-123.webp'); // idempotent
});

test('with S3_BUCKET set the S3 driver is selected', () => {
  process.env.S3_BUCKET = 'bucket';
  assert.equal(storageMode(), 's3');
  delete process.env.S3_BUCKET;
});
