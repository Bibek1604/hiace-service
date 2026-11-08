import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeImage } from './images';
import { db } from './db';
import { ApiError } from './security';

/**
 * Object storage driver. S3 (or any S3-compatible service) is used when S3_BUCKET is set. Otherwise
 * images are kept in the database, which survives serverless hosts such as Vercel whose disk is wiped
 * between requests. STORAGE_DRIVER="local" keeps them on the local disk under STORAGE_DIR instead
 * (a single long-running server with a persistent volume). Keys are always "<purpose>/<uuid>.webp"
 * and both parts are validated.
 */
export const storageMode = (): 's3' | 'local' | 'database' =>
  process.env.S3_BUCKET ? 's3' : process.env.STORAGE_DRIVER === 'local' ? 'local' : 'database';
// The directory is configured at run time, so the bundler must not try to trace it (turbopackIgnore).
export const storageDir = () => resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR || 'storage');

const SAFE = /^[a-z0-9-]{1,40}$/i;
function keyFor(purpose: string, id: string) {
  if (!SAFE.test(purpose) || !SAFE.test(id)) throw new ApiError(400, 'Invalid object reference.');
  return purpose + '/' + id + '.webp';
}

const idOf = (key: string) => key.slice(key.indexOf('/') + 1, -'.webp'.length);

const client = () => {
  if (!process.env.S3_BUCKET || !process.env.S3_REGION)
    throw new Error('Storage is not configured.');
  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  });
};

async function putObject(key: string, body: Buffer) {
  if (storageMode() === 's3') {
    await client().send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        ServerSideEncryption: 'AES256',
      }),
    );
    return;
  }
  if (storageMode() === 'database') {
    await db.storedObjectData.create({ data: { id: idOf(key), data: new Uint8Array(body) } });
    return;
  }
  await mkdir(join(storageDir(), key.split('/')[0]), { recursive: true });
  await writeFile(join(storageDir(), key), body, { flag: 'wx' });
}

async function getObject(key: string): Promise<Buffer> {
  if (storageMode() === 's3') {
    const result = await client().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    if (!result.Body) throw new ApiError(404, 'Image not found.');
    return Buffer.from(await result.Body.transformToByteArray());
  }
  if (storageMode() === 'database') {
    const row = await db.storedObjectData.findUnique({ where: { id: idOf(key) } });
    if (row) return Buffer.from(row.data);
    // Images saved to disk before database storage existed are still served when the file is there.
  }
  try {
    return await readFile(join(storageDir(), key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'Image not found.');
    throw e;
  }
}

export async function deleteObject(key: string) {
  if (storageMode() === 's3') {
    await client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return;
  }
  if (storageMode() === 'database') await db.storedObjectData.deleteMany({ where: { id: idOf(key) } });
  await rm(join(storageDir(), key), { force: true });
}

export async function upload(file: File, purpose: string, ownerId: string) {
  const image = await decodeImage(file);
  const id = randomUUID(),
    key = keyFor(purpose, id);
  await putObject(key, image);
  try {
    return await db.storedObject.create({
      data: { id, mime: 'image/webp', bytes: image.length, purpose, ownerId },
    });
  } catch (e) {
    await deleteObject(key).catch(() => {});
    throw e;
  }
}

export async function readObject(object: { id: string; purpose: string }) {
  return getObject(keyFor(object.purpose, object.id));
}

export async function multipart(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, 'Missing upload.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 6 * 1024 * 1024) {
      await reader.cancel();
      throw new ApiError(413, 'This image is larger than 5 MB. Please choose a smaller one.');
    }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks), {
    headers: { 'Content-Type': req.headers.get('content-type') || '' },
  }).formData();
}
