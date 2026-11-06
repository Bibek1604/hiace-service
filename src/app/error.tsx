'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/common';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="container narrow">
      <Empty text="We hit a small bump" detail="This page couldn’t load right now. Your bookings and payments are safe. Please try again.">
        <Button onClick={reset}>Try again</Button>
        <Link href="/" className="button outline">
          Back home
        </Link>
      </Empty>
      {error.digest && <p className="muted" style={{ textAlign: 'center', fontSize: 11 }}>Reference: {error.digest}</p>}
    </main>
  );
}
