import type { Metadata } from 'next';
import { TripDetail } from '@/components/customer';
import { db } from '@/lib/db';
import { money } from '@/lib/utils';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
};

const when = (d: Date) =>
  d.toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A shared booking link shows the route, departure time and vehicle photo in WhatsApp, Viber and Messenger. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const t = await db.trip.findUnique({
      where: { id },
      select: {
        departure: true,
        fare: true,
        route: { select: { origin: { select: { name: true } }, destination: { select: { name: true } } } },
        vehicle: { select: { name: true, type: true, images: { select: { key: true }, orderBy: { position: 'asc' }, take: 1 } } },
      },
    });
    if (!t) return { title: 'Trip not found' };
    const title = `${t.route.origin.name} → ${t.route.destination.name} · ${when(t.departure)}`,
      description = `Book your seat on ${t.vehicle.name} (${t.vehicle.type}). From ${money(t.fare)} per seat.`,
      image = t.vehicle.images[0] ? '/api/images/' + t.vehicle.images[0].key : undefined;
    let metadataBase: URL | undefined;
    try {
      if (process.env.APP_ORIGIN) metadataBase = new URL(process.env.APP_ORIGIN);
    } catch {}
    return {
      metadataBase,
      title,
      description,
      openGraph: { title, description, type: 'website', ...(image ? { images: [image] } : {}) },
      twitter: { card: image ? 'summary_large_image' : 'summary', title, description },
    };
  } catch {
    // The page itself reports an unreachable database; the preview just falls back to the site title.
    return {};
  }
}

export default async function Trip({ params, searchParams }: Props) {
  const { from, to } = await searchParams;
  return <TripDetail id={(await params).id} from={typeof from === 'string' ? from : undefined} to={typeof to === 'string' ? to : undefined} />;
}
