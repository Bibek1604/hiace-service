import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Draws the app icon from vector shapes (no stock or generated imagery) and writes the PNG sizes the
// web manifest and iOS need. `maskable` icons keep the artwork inside the safe zone and fill the square.
const bus = (size: number, maskable: boolean) => {
  const pad = maskable ? size * 0.2 : size * 0.12;
  const s = (size - pad * 2) / 100;
  const x = (n: number) => pad + n * s;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38a9f8"/><stop offset="1" stop-color="#123b75"/></linearGradient></defs>
  <rect width="${size}" height="${size}" rx="${maskable ? 0 : size * 0.22}" fill="url(#g)"/>
  <rect x="${x(8)}" y="${x(18)}" width="${84 * s}" height="${56 * s}" rx="${10 * s}" fill="#fff"/>
  <rect x="${x(16)}" y="${x(26)}" width="${20 * s}" height="${18 * s}" rx="${3 * s}" fill="#2563eb"/>
  <rect x="${x(40)}" y="${x(26)}" width="${20 * s}" height="${18 * s}" rx="${3 * s}" fill="#2563eb"/>
  <rect x="${x(64)}" y="${x(26)}" width="${20 * s}" height="${18 * s}" rx="${3 * s}" fill="#2563eb"/>
  <rect x="${x(8)}" y="${x(52)}" width="${84 * s}" height="${5 * s}" fill="#38a9f8"/>
  <circle cx="${x(28)}" cy="${x(76)}" r="${9 * s}" fill="#123b75" stroke="#fff" stroke-width="${3 * s}"/>
  <circle cx="${x(72)}" cy="${x(76)}" r="${9 * s}" fill="#123b75" stroke="#fff" stroke-width="${3 * s}"/>
</svg>`);
};

async function main() {
  await mkdir('public/icons', { recursive: true });
  const out: [string, number, boolean][] = [
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
    ['apple-touch-icon.png', 180, true],
  ];
  for (const [name, size, maskable] of out)
    await writeFile('public/icons/' + name, await sharp(bus(size, maskable)).png().toBuffer());
  console.log('Icons written:', out.map((o) => o[0]).join(', '));
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
