import test from 'node:test';
import assert from 'node:assert/strict';
import { nepalDateString, nepalDayStart } from '../src/lib/nepal-time';
import { NEPAL_MOBILE_PATTERN, normalizePhone } from '../src/lib/phone';

test('the Nepal day starts at 18:15 UTC the evening before', () => {
  assert.equal(nepalDayStart(new Date('2026-11-07T06:00:00Z')).toISOString(), '2026-11-06T18:15:00.000Z');
  assert.equal(nepalDayStart(new Date('2026-11-07T18:14:59Z')).toISOString(), '2026-11-06T18:15:00.000Z', 'one second before Nepal midnight');
  assert.equal(nepalDayStart(new Date('2026-11-07T18:15:00Z')).toISOString(), '2026-11-07T18:15:00.000Z', 'exactly Nepal midnight');
});

test('a calendar date is the date in Nepal, not in UTC', () => {
  // 00:30 on 8 November in Kathmandu is still 7 November in UTC.
  assert.equal(nepalDateString(new Date('2026-11-07T18:45:00Z')), '2026-11-08');
  assert.equal(nepalDateString(new Date('2026-11-07T18:14:00Z')), '2026-11-07');
  assert.equal(nepalDateString(new Date('2026-12-31T18:15:00Z')), '2027-01-01', 'across a year end');
});

test('every way of typing a Nepali mobile number stores the same value', () => {
  for (const typed of ['9841234567', ' 9841234567 ', '9779841234567', '+9779841234567']) assert.equal(normalizePhone(typed), '+9779841234567');
  assert.equal(normalizePhone('014412345'), '014412345', 'a landline is kept as typed');
});

test('the form pattern accepts exactly what the server accepts', () => {
  const pattern = new RegExp('^(?:' + NEPAL_MOBILE_PATTERN + ')$');
  for (const good of ['9841234567', '9741234567', '+9779841234567', '9779841234567']) assert.ok(pattern.test(good), good);
  for (const bad of ['0123456789', '984123456', '98412345678', '+9771234567890']) assert.ok(!pattern.test(bad), bad);
});
