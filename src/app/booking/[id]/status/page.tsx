import { BookingPage } from '@/components/customer';
export default async function Status({ params }: { params: Promise<{ id: string }> }) {
  return <BookingPage id={(await params).id} statusPage />;
}
