import { TripDetail } from '@/components/customer';
export default async function Trip({ params }: { params: Promise<{ id: string }> }) {
  return <TripDetail id={(await params).id} />;
}
