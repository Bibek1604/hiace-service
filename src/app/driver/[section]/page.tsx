import { notFound } from 'next/navigation';
import {
  DriverPayment,
  DriverProfile,
  DriverRoutes,
  DriverSchedule,
  DriverVehicles,
} from '@/components/driver-portal';
import { DriverBookings, DriverHistory } from '@/components/driver';

const SECTIONS = {
  bookings: DriverBookings,
  profile: DriverProfile,
  vehicles: DriverVehicles,
  routes: DriverRoutes,
  payment: DriverPayment,
  schedule: DriverSchedule,
  history: DriverHistory,
};

export default async function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!Object.hasOwn(SECTIONS, section)) notFound();
  const Section = SECTIONS[section as keyof typeof SECTIONS];
  return <Section />;
}
