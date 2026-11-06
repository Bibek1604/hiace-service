import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { decodeImage } from '../src/lib/images';
test('a genuine PNG is decoded and reencoded as metadata-free WebP without enlargement', async () => {
  const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#123b75' } })
    .png()
    .toBuffer();
  const output = await decodeImage(
    new File([new Uint8Array(png)], 'receipt.png', { type: 'image/png' }),
  );
  const info = await sharp(output).metadata();
  assert.equal(info.format, 'webp');
  assert.equal(info.width, 30);
  assert.equal(info.height, 20);
  assert.equal(info.exif, undefined);
});
test('MIME spoofing and SVG disguised as PNG are rejected', async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
  await assert.rejects(
    () => decodeImage(new File([new Uint8Array(png)], 'fake.jpg', { type: 'image/jpeg' })),
    /not a valid/,
  );
  await assert.rejects(
    () =>
      decodeImage(
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'],
          'fake.png',
          { type: 'image/png' },
        ),
      ),
    /not a valid/,
  );
});
test('oversized, executable and truncated image uploads fail closed', async () => {
  await assert.rejects(
    () =>
      decodeImage(
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }),
      ),
    /under 5 MB/,
  );
  await assert.rejects(
    () =>
      decodeImage(new File(['MZ executable'], 'receipt.exe', { type: 'application/octet-stream' })),
    /under 5 MB/,
  );
  await assert.rejects(
    () =>
      decodeImage(
        new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'truncated.png', {
          type: 'image/png',
        }),
      ),
    /not a valid/,
  );
});
