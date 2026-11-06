import test from 'node:test';
import assert from 'node:assert/strict';
import { seatState, expirationStatus, normalizeReference } from '../src/lib/policy';
test('expired screenshot review requires reconciliation rather than payment failure', () => {
  assert.equal(expirationStatus('PAYMENT_REVIEW'), 'PAYMENT_RECONCILIATION_REQUIRED');
  assert.equal(expirationStatus('HELD'), 'EXPIRED');
});
test('a confirmed seat stays booked even when its original hold time passed', () => {
  assert.equal(seatState(false, { status: 'CONFIRMED', expiresAt: new Date(0) }), 'BOOKED');
});
test('unexpired hold is unavailable, expired hold is available, blocked is labeled', () => {
  assert.equal(
    seatState(false, { status: 'HELD', expiresAt: new Date(Date.now() + 60000) }),
    'HELD',
  );
  assert.equal(seatState(false, { status: 'HELD', expiresAt: new Date(0) }), 'AVAILABLE');
  assert.equal(seatState(true), 'BLOCKED');
  assert.equal(seatState(false), 'AVAILABLE');
});
test('payment references are normalized for duplicate investigation', () =>
  assert.equal(normalizeReference(' ab 123 '), 'AB123'));
