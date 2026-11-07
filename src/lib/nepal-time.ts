/** Nepal has one fixed offset (UTC+05:45) and no daylight saving, so calendar arithmetic is exact. */
export const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60000;
export const DAY_MS = 86400000;

/** The instant the current Nepal calendar day began. */
export function nepalDayStart(now = new Date()) {
  return new Date(Math.floor((now.getTime() + NEPAL_OFFSET_MS) / DAY_MS) * DAY_MS - NEPAL_OFFSET_MS);
}

/** Calendar date (YYYY-MM-DD) of an instant in Nepal. */
export const nepalDateString = (d: Date) => new Date(d.getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 10);
