'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/common';

function sectionFor(pathname: string) {
  if (pathname.startsWith('/admin'))
    return { detail: 'This admin page couldn’t load. Your records are safe. Please try again.', home: '/admin', label: 'Admin home' };
  if (pathname.startsWith('/driver'))
    return { detail: 'This driver page couldn’t load. Your trips and bookings are safe. Please try again.', home: '/driver', label: 'Driver home' };
  if (pathname.startsWith('/booking') || pathname.startsWith('/track-booking'))
    return { detail: 'Your booking page couldn’t load. Your booking and payment are safe. Please try again.', home: '/track-booking', label: 'Track booking' };
  if (pathname.startsWith('/search') || pathname.startsWith('/trips'))
    return { detail: 'We couldn’t load the rides just now. No booking was changed. Please try again.', home: '/', label: 'Back home' };
  if (pathname.startsWith('/staff'))
    return { detail: 'The sign-in page couldn’t load. Please try again.', home: '/', label: 'Back home' };
  return { detail: 'This page couldn’t load right now. Your bookings and payments are safe. Please try again.', home: '/', label: 'Back home' };
}

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const section = sectionFor(usePathname() ?? '/');
  return (
    <main className="container narrow">
      <Empty text="We hit a small bump" detail={section.detail}>
        <Button onClick={reset}>Try again</Button>
        <Link href={section.home} className="button outline">
          {section.label}
        </Link>
      </Empty>
      {error.digest && <p className="muted" style={{ textAlign: 'center', fontSize: 'var(--text-caption)' }}>Reference: {error.digest}</p>}
    </main>
  );
}
