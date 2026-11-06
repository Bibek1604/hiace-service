import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

// Connectivity check for the Supabase project; it reads no application table.
export default async function Page() {
  const supabase = createClient(await cookies());
  const { error } = await supabase.auth.getSession();
  return <main className="container narrow">{error ? 'Supabase error: ' + error.message : 'Supabase connected'}</main>;
}
