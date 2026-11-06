export function expirationStatus(status: string) {
  return status === 'PAYMENT_REVIEW' ? 'PAYMENT_RECONCILIATION_REQUIRED' : 'EXPIRED';
}
export function normalizeReference(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}
export function seatState(blocked: boolean, claim?: { status: string; expiresAt: Date | string }) {
  if (blocked) return 'BLOCKED';
  if (!claim) return 'AVAILABLE';
  if (claim.status === 'CONFIRMED') return 'BOOKED';
  return new Date(claim.expiresAt).getTime() > Date.now() ? 'HELD' : 'AVAILABLE';
}
