'use client';
import { createContext, useContext } from 'react';
import type { SiteContent } from '@/lib/site-content';

const SiteContext = createContext<SiteContent | null>(null);
export const SiteProvider = SiteContext.Provider;
/** Admin-edited website content; the root layout loads it once per request and provides it here. */
export function useSite(): SiteContent {
  const site = useContext(SiteContext);
  if (!site) throw new Error('useSite() needs the root layout’s SiteProvider.');
  return site;
}
