import { DriverManifest } from '@/components/driver';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <DriverManifest tripId={(await params).id} />;
}
