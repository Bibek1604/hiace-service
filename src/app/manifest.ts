import type { MetadataRoute } from 'next';
import { getSiteContent } from '@/lib/site-content-db';

export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { brand, theme, copy } = await getSiteContent();
  return {
    id: '/',
    name: brand.name + ' — ' + brand.tagline,
    short_name: brand.name.slice(0, 12),
    description: copy.seo.appDescription,
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: theme.primary,
    categories: ['travel', 'transportation'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: copy.nav.findRide || 'Search', url: '/search' },
      { name: copy.nav.track || 'Track', url: '/track-booking' },
    ],
  };
}
