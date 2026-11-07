import { notFound } from 'next/navigation';
import { AdminDashboard, AdminResource, VehicleProfile } from '@/components/admin';
import { Payments } from '@/components/payments';
import { AuditLogPage, TicketCheckPage } from '@/components/admin';
import { LayoutEditor, LayoutsAdmin } from '@/components/layouts';
import { RouteStops } from '@/components/route-stops';
import { DriverRequests } from '@/components/driver-requests';
import { SiteContentAdmin } from '@/components/site-admin';
export default async function Page({ params }: { params: Promise<{ section: string[] }> }) {
  const { section } = await params,
    resource = section[0];
  if (resource === 'dashboard' || resource === 'reports')
    return <AdminDashboard reports={resource === 'reports'} />;
  if (resource === 'driver-requests') return <DriverRequests />;
  if (resource === 'website') return <SiteContentAdmin />;
  if (resource === 'payments') return <Payments />;
  if (resource === 'tickets') return <TicketCheckPage />;
  if (resource === 'audit') return <AuditLogPage />;
  if (resource === 'seat-layouts') return section[1] ? <LayoutEditor id={section[1]} /> : <LayoutsAdmin />;
  if (resource === 'routes' && section[1] && section[1] !== 'new') return <RouteStops id={section[1]} />;
  if (resource === 'vehicles' && section[1] && section[1] !== 'new')
    return <VehicleProfile id={section[1]} />;
  if (
    ![
      'vehicles',
      'drivers',
      'locations',
      'routes',
      'fares',
      'trips',
      'bookings',
      'payment-qr',
      'settings',
    ].includes(resource)
  )
    notFound();
  return (
    <AdminResource key={section.join('/')} resource={resource} create={section[1] === 'new'} />
  );
}
