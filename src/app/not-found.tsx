import Link from 'next/link';
import { Empty } from '@/components/common';
import { getSiteContent } from '@/lib/site-content-db';

export default async function NotFound() {
  const { copy } = await getSiteContent();
  return (
    <main className="container narrow">
      <Empty text={copy.notFound.title} detail={copy.notFound.text}>
        <Link href="/" className="button">
          {copy.nav.findRide}
        </Link>
        <Link href="/track-booking" className="button outline">
          {copy.nav.track}
        </Link>
      </Empty>
    </main>
  );
}
