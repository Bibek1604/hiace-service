'use client';
/**
 * Browser-side image helpers shared by every upload and "save image" button.
 *
 * Phones hand the page files the server cannot take as they are: iPhone HEIC photos, 12-50 MP camera
 * shots far above the 4.5 MB request limit on Vercel, and gallery picks with no MIME type at all.
 * prepareImage() redraws those on a canvas as a JPEG of at most 2200 px, which is still sharp enough
 * for a QR code. Small JPEG/PNG/WebP files are sent untouched.
 */

const SAFE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SEND_AS_IS = 3.5 * 1024 * 1024;
const MAX_SIDE = 2200;
const UNREADABLE =
  'This photo format cannot be read on this device. Take a screenshot of it, or choose a JPEG or PNG image.';

/** The value for every image <input accept>: "image/*" lets phone galleries and cameras offer all photos. */
export const IMAGE_ACCEPT = 'image/*';

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Older Safari cannot decode some formats through createImageBitmap but can through <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(UNREADABLE);
  }
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

export async function prepareImage(file: File): Promise<File> {
  if (SAFE_TYPES.includes(file.type) && file.size <= SEND_AS_IS) return file;
  if (typeof document === 'undefined') return file;
  const image = await decode(file);
  try {
    let side = MAX_SIDE;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, side / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(UNREADABLE);
      // JPEG has no transparency; a white background keeps transparent PNG QR codes scannable.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      const blob = await toBlob(canvas, 0.9);
      if (!blob) throw new Error(UNREADABLE);
      if (blob.size <= SEND_AS_IS || attempt === 3) {
        const base = (file.name || 'image').replace(/\.[^.]*$/, '') || 'image';
        return new File([blob], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
      }
      side = Math.round(side * 0.75);
    }
    throw new Error(UNREADABLE);
  } finally {
    image.close();
  }
}

const isApple = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * Saves an uploaded image (served from /api/images/:id) as a PNG on every device:
 * iPhone/iPad open the share sheet, where "Save Image" puts it in Photos (a plain download only
 * reaches the Files app, which wallet apps cannot pick from); everything else downloads the file,
 * which Android shows in the gallery under Downloads.
 */
export async function saveImage(id: string, filename: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/images/' + encodeURIComponent(id) + '?download=1&format=png', { credentials: 'same-origin' });
  } catch {
    throw new Error('Unable to reach the server. Check your connection and try again.');
  }
  if (!response.ok) throw new Error('This image is no longer available. Ask the operator to upload it again.');
  const blob = await response.blob();
  const file = new File([blob], filename, { type: 'image/png' });
  if (isApple() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return; // The person closed the share sheet.
      // Fall through to a normal download.
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
