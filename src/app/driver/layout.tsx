import { redirect } from 'next/navigation';
import { staff } from '@/lib/security';
import { StaffShell } from '@/components/common';
export const dynamic = 'force-dynamic';
export default async function Layout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await staff('DRIVER');
  } catch {
    redirect('/staff/sign-in');
  }
  return (
    <StaffShell role="driver" name={user.name}>
      {children}
    </StaffShell>
  );
}
