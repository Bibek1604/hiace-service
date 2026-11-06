import type { Metadata, Viewport } from 'next';
import { Poppins, Fraunces } from 'next/font/google';
import { Providers } from '@/components/providers';
import { Header, Footer } from '@/components/common';
import { PwaRegister } from '@/components/pwa';
import { getSiteContent } from '@/lib/site-content-db';
import './globals.css';
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});
const display = Fraunces({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display', display: 'swap' });
export const dynamic = 'force-dynamic';
export async function generateMetadata(): Promise<Metadata> {
  const { brand, copy } = await getSiteContent();
  return {
    applicationName: brand.name,
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, title: brand.name, statusBarStyle: 'default' },
    icons: brand.logo ? { icon: brand.logo, apple: brand.logo } : { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
    title: { default: copy.seo.title || brand.name, template: '%s | ' + brand.name },
    description: copy.seo.description,
  };
}
export async function generateViewport(): Promise<Viewport> {
  const { theme } = await getSiteContent();
  return { themeColor: theme.primary, width: 'device-width', initialScale: 1, viewportFit: 'cover' };
}
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const site = await getSiteContent();
  return (
    <html lang="en">
      <body suppressHydrationWarning className={poppins.className + ' ' + display.variable} style={{ ['--blue' as string]: site.theme.primary, ['--navy' as string]: site.theme.dark }}>
        <Providers site={site}>
          <PwaRegister />
          <Header site={site} />
          {children}
          <Footer site={site} />
        </Providers>
      </body>
    </html>
  );
}
