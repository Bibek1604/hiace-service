import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATES,
  autoLabel,
  compileSeats,
  diffLayouts,
  validateLayout,
  type Grid,
} from '../src/lib/seat-layout';
import {
  buildSequence,
  checkPoint,
  journeysOverlap,
  resolveJourney,
  validateSequence,
  type StopInput,
} from '../src/lib/route-stops';

test('every built-in template is valid and yields the advertised seat count', () => {
  const counts: Record<string, number> = { coach_2x2_40: 40, deluxe_2x1_27: 27, hiace_17: 17, sleeper_2deck_28: 28 };
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const grid = t.build();
    assert.deepEqual(validateLayout(grid), [], key);
    const seats = compileSeats(grid);
    assert.equal(seats.length, counts[key], key);
    assert.equal(new Set(seats.map((s) => s.label)).size, seats.length, key + ' labels unique');
    assert.equal(new Set(seats.map((s) => s.row + ':' + s.column)).size, seats.length, key + ' positions unique');
  }
});

test('validation reports every problem at once', () => {
  const grid: Grid = {
    rows: 2,
    cols: 2,
    decks: 1,
    cells: [
      { deck: 0, row: 0, col: 0, kind: 'seat', label: 'A1' },
      { deck: 0, row: 0, col: 0, kind: 'seat', label: 'A2' },
      { deck: 0, row: 0, col: 1, kind: 'seat', label: 'a1' },
      { deck: 0, row: 1, col: 0, kind: 'seat' },
      { deck: 0, row: 1, col: 1, kind: 'aisle', label: 'X' },
      { deck: 0, row: 5, col: 5, kind: 'driver' },
    ],
  };
  const codes = validateLayout(grid).map((i) => i.code).sort();
  assert.deepEqual(codes, ['duplicate_label', 'missing_label', 'no_door', 'out_of_bounds', 'overlap', 'stray_seat_data']);
  assert.throws(() => compileSeats(grid), /Invalid layout/);
});

test('layout needs a door, at most one driver and some seats', () => {
  const base: Grid = { rows: 2, cols: 2, decks: 1, cells: [] };
  assert.deepEqual(validateLayout(base).map((i) => i.code).sort(), ['no_door', 'no_seats']);
  const twoDrivers: Grid = {
    ...base,
    cells: [
      { deck: 0, row: 0, col: 0, kind: 'driver' },
      { deck: 0, row: 0, col: 1, kind: 'driver' },
      { deck: 0, row: 1, col: 0, kind: 'door' },
      { deck: 0, row: 1, col: 1, kind: 'seat', label: 'A1' },
    ],
  };
  assert.deepEqual(validateLayout(twoDrivers).map((i) => i.code), ['many_drivers']);
});

test('upper and lower deck seats never share a stored position', () => {
  const seats = compileSeats(TEMPLATES.sleeper_2deck_28.build());
  assert.ok(seats.some((s) => s.deck === 1) && seats.some((s) => s.deck === 0));
  assert.equal(new Set(seats.map((s) => s.row + ':' + s.column)).size, seats.length);
});

test('autoLabel numbers seats left to right by row and ignores non-seat cells', () => {
  const g = autoLabel({
    rows: 2,
    cols: 4,
    decks: 1,
    cells: [
      { deck: 0, row: 0, col: 3, kind: 'seat' },
      { deck: 0, row: 0, col: 0, kind: 'seat' },
      { deck: 0, row: 0, col: 1, kind: 'aisle' },
      { deck: 0, row: 1, col: 0, kind: 'seat' },
    ],
  });
  const label = (r: number, c: number) => g.cells.find((x) => x.row === r && x.col === c)!.label;
  assert.deepEqual([label(0, 0), label(0, 3), label(1, 0)], ['A1', 'A2', 'B1']);
});

test('diff identifies added, removed and moved seats by label', () => {
  const a = compileSeats(TEMPLATES.deluxe_2x1_27.build());
  const b = a.filter((s) => s.label !== 'A1').map((s) => (s.label === 'A2' ? { ...s, column: 9 } : s));
  b.push({ label: 'Z9', row: 0, column: 0, deck: 0, category: 'STANDARD' });
  assert.deepEqual(diffLayouts(a, b), { added: ['Z9'], removed: ['A1'], moved: ['A2'] });
});

const route = { originId: 'KTM', destinationId: 'PKR', durationMinutes: 400, distanceKm: 200 };
const mid = (locationId: string, offsetMinutes: number, kmFromOrigin: number, extra: Partial<StopInput> = {}): StopInput => ({
  locationId,
  offsetMinutes,
  kmFromOrigin,
  allowBoarding: true,
  allowDropoff: true,
  ...extra,
});

test('stop sequences must be ordered, unique and inside the route totals', () => {
  assert.deepEqual(validateSequence(buildSequence(route, [mid('MUG', 150, 80), mid('DMK', 300, 150)])), []);
  assert.match(validateSequence(buildSequence(route, [mid('DMK', 300, 150), mid('MUG', 150, 80)])).join(), /time order/);
  assert.match(validateSequence(buildSequence(route, [mid('MUG', 150, 80), mid('MUG', 200, 90)])).join(), /only once/);
  assert.match(validateSequence(buildSequence(route, [mid('MUG', 450, 80)])).join(), /time order/);
  assert.match(validateSequence(buildSequence(route, [mid('MUG', 100, 250)])).join(), /distance/);
  assert.match(
    validateSequence(buildSequence(route, [mid('MUG', 100, 50, { allowBoarding: false, allowDropoff: false })])).join(),
    /allow boarding or drop-off/,
  );
});

test('journeys occupy exactly the segments between boarding and drop-off', () => {
  const seq = buildSequence(route, [mid('MUG', 150, 80), mid('DMK', 300, 150)]);
  const full = resolveJourney(seq, 'KTM', 'PKR');
  const first = resolveJourney(seq, 'KTM', 'MUG');
  const second = resolveJourney(seq, 'MUG', 'PKR');
  assert.deepEqual(full.segments, [0, 1, 2]);
  assert.deepEqual(first.segments, [0]);
  assert.deepEqual(second.segments, [1, 2]);
  // A seat sold KTM->MUG can be resold MUG->PKR, but not to anyone overlapping either leg.
  assert.equal(journeysOverlap(first, second), false);
  assert.equal(journeysOverlap(full, first), true);
  assert.equal(journeysOverlap(resolveJourney(seq, 'MUG', 'DMK'), second), true);
});

test('invalid journeys are refused', () => {
  const seq = buildSequence(route, [mid('MUG', 150, 80, { allowBoarding: false }), mid('DMK', 300, 150, { allowDropoff: false })]);
  assert.throws(() => resolveJourney(seq, 'PKR', 'KTM'), /after boarding/);
  assert.throws(() => resolveJourney(seq, 'KTM', 'KTM'), /after boarding/);
  assert.throws(() => resolveJourney(seq, 'KTM', 'XXX'), /not on this route/);
  assert.throws(() => resolveJourney(seq, 'MUG', 'PKR'), /Boarding is not allowed/);
  assert.throws(() => resolveJourney(seq, 'KTM', 'DMK'), /Drop-off is not allowed/);
});

test('boarding points follow the stop they belong to', () => {
  const seq = buildSequence(route, [mid('MUG', 150, 80, { allowBoarding: false })]);
  const p = (locationId: string, kind: 'BOARDING' | 'DROPOFF') =>
    ({ locationId, kind, name: 'x', landmark: '', extraMinutes: 0, active: true }) as const;
  assert.equal(checkPoint(seq, p('KTM', 'BOARDING')), null);
  assert.match(checkPoint(seq, p('KTM', 'DROPOFF'))!, /not allowed/);
  assert.match(checkPoint(seq, p('PKR', 'BOARDING'))!, /not allowed/);
  assert.match(checkPoint(seq, p('MUG', 'BOARDING'))!, /not allowed/);
  assert.equal(checkPoint(seq, p('MUG', 'DROPOFF')), null);
  assert.match(checkPoint(seq, p('ZZZ', 'BOARDING'))!, /not on the route/);
});
