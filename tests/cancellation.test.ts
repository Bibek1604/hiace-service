import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, seatOrder } from '../src/lib/manifest';
import { refundFor, REFUND_STEPS, tripTransitionAllowed } from '../src/lib/cancellations';

test('CSV cells are quoted and spreadsheet formulas defused', () => {
  assert.equal(csvCell('Ram "Bahadur"'), '"Ram ""Bahadur"""');
  for (const bad of ['=1+1', '+977', '-2', '@SUM(A1)', '\tx']) assert.ok(csvCell(bad).startsWith('"\''), bad);
  assert.equal(csvCell(null), '""');
  assert.deepEqual(['A10', 'B1', 'A2'].sort(seatOrder), ['A2', 'A10', 'B1']);
});

test('only verified money is refundable; unverified proof needs a bank check', () => {
  assert.deepEqual(refundFor({ status: 'VERIFIED', verifiedAmount: 1200 }, 1000), { refundStatus: 'PENDING', paidAmount: 1200 });
  assert.deepEqual(refundFor({ status: 'SUBMITTED', verifiedAmount: null }, 1000), { refundStatus: 'REVIEW_REQUIRED', paidAmount: 0 });
  assert.deepEqual(refundFor({ status: 'UNPAID', verifiedAmount: null }, 1000), { refundStatus: 'NOT_REQUIRED', paidAmount: 0 });
  assert.deepEqual(refundFor(null, 1000), { refundStatus: 'NOT_REQUIRED', paidAmount: 0 });
  assert.ok(!REFUND_STEPS.complete.from.includes('PENDING'), 'a refund is approved before it is completed');
});

test('trips move forward only', () => {
  assert.ok(tripTransitionAllowed('SCHEDULED', 'BOARDING'));
  assert.ok(tripTransitionAllowed('DEPARTED', 'COMPLETED'));
  assert.ok(tripTransitionAllowed('COMPLETED', 'COMPLETED'), 'saving other fields keeps the status');
  assert.ok(!tripTransitionAllowed('SCHEDULED', 'COMPLETED'));
  assert.ok(!tripTransitionAllowed('CANCELLED', 'SCHEDULED'));
  assert.ok(!tripTransitionAllowed('DEPARTED', 'CANCELLED'));
});
