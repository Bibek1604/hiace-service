import { db } from './db';
import { defaultSiteContent, parseSiteContent, siteContentSchema, type SiteContent } from './site-content';

/** Never throws: the public site must render even when the database is unreachable. */
export async function getSiteContent(): Promise<SiteContent> {
  try {
    const row = await db.siteContent.findUnique({ where: { id: 'site' } });
    return parseSiteContent(row?.value);
  } catch {
    return defaultSiteContent();
  }
}
export async function saveSiteContent(raw: unknown, actorId: string) {
  const value = siteContentSchema.parse(raw);
  await db.$transaction([
    db.siteContent.upsert({
      where: { id: 'site' },
      create: { id: 'site', value, updatedBy: actorId },
      update: { value, updatedBy: actorId },
    }),
    db.auditLog.create({ data: { actorId, action: 'SITE_CONTENT_UPDATED', targetId: 'site', details: {} } }),
  ]);
  return value;
}
