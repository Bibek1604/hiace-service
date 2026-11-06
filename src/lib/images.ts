import sharp from 'sharp';
import { ApiError } from './errors';
export async function decodeImage(file: File): Promise<Buffer> {
  if (
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
    file.size > 5 * 1024 * 1024 ||
    !file.size
  )
    throw new ApiError(400, 'Choose a JPEG, PNG, or WebP image under 5 MB.');
  const buffer = Buffer.from(await file.arrayBuffer());
  let image: Buffer;
  try {
    const source = sharp(buffer, {
      limitInputPixels: 24000000,
      animated: false,
      failOn: 'warning',
    });
    const info = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(info.format || '') || (info.pages && info.pages > 1))
      throw new Error('Invalid image');
    const expected = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    if (info.format !== expected) throw new Error('Type mismatch');
    image = await source
      .rotate()
      .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 92 })
      .toBuffer();
  } catch {
    throw new ApiError(400, 'The file content is not a valid supported image.');
  }

  return image;
}
