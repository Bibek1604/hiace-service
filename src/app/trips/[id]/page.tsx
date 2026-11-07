import { TripDetail } from '@/components/customer';
export default async function Trip({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from, to } = await searchParams;
  return <TripDetail id={(await params).id} from={typeof from === 'string' ? from : undefined} to={typeof to === 'string' ? to : undefined} />;
}
