/** Nepali mobile numbers are stored as +977XXXXXXXXXX, so tracking finds a booking however it was typed. */
export const NEPAL_MOBILE = /^(?:\+?977)?9[78][0-9]{8}$/;
/** The same rule for an HTML pattern attribute. */
export const NEPAL_MOBILE_PATTERN = '(\\+?977)?9[78][0-9]{8}';
export const NEPAL_MOBILE_MESSAGE = 'Enter a Nepali mobile number such as 98XXXXXXXX.';

export function normalizePhone(value: string) {
  const v = value.trim();
  if (!NEPAL_MOBILE.test(v)) return v;
  return v.startsWith('+') ? v : v.length === 13 ? '+' + v : '+977' + v;
}
