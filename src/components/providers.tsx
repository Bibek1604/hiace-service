'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { SiteContent } from '@/lib/site-content';
import { SiteProvider } from './site-context';
export function Providers({ site, children }: { site: SiteContent; children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 10000, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <SiteProvider value={site}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </SiteProvider>
  );
}
