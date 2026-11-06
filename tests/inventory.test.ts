import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { buildFareMatrix, matchJourney, priceJourney, seatStateFor, timeAtStop, type TripStop } from '../src/lib/inventory';

const stop = (locationId: string, name: string, offsetMinutes: number, kmFromOrigin: number, allowBoarding = true, allowDropoff = true): TripStop => ({
  locationId,
  name,
  offsetMinutes,
  kmFromOrigin,
  allowBoarding,
  allowDropoff,
});
// Kathmandu -> Mugling -> Damauli -> Pokhara, 200 km
const seq: TripStop[] = [
  stop('KTM', 'Kathmandu', 0, 0, true, false),
  stop('MUG', 'Mugling', 150, 80),
  stop('DMK', 'Damauli', 300, 150),
  stop('PKR', 'Pokhara', 400, 200, false, true),
];

test('fare matrix is proportional to distance, rounds, and keeps the full fare exact', () => {
  const m = buildFareMatrix(seq, 1000);
  assert.equal(priceJourney(m, { from: 0, to: 3 }), 1000);
  assert.equal(priceJourney(m, { from: 0, to: 1 }), 400);
  assert.equal(priceJourney(m, { from: 1, to: 2 }), 350);
  assert.equal(priceJourney(m, { from: 2, to: 3 }), 250);
  assert.equal(m.length, 6);
  assert.throws(() => priceJourney(m, { from: 3, to: 3 }), /No fare/);
});

test('overrides replace a leg but never the full route', () => {
  const m = buildFareMatrix(seq, 1000, new Map([['KTM>MUG', 450], ['KTM>PKR', 1]]));
  assert.equal(priceJourney(m, { from: 0, to: 1 }), 450);
  assert.equal(priceJourney(m, { from: 0, to: 3 }), 1000);
});

test('stops that forbid boarding or drop-off have no fares for that movement', () => {
  const s = [seq[0], stop('MUG', 'Mugling', 150, 80, false, true), seq[2], seq[3]];
  const m = buildFareMatrix(s, 1000);
  assert.ok(!m.some((r) => r.fromIdx === 1));
  assert.ok(m.some((r) => r.toIdx === 1));
});

const claim = (fromIdx: number, toIdx: number, status = 'CONFIRMED', expiresAt = new Date(Date.now() + 60000)) => ({
  status,
  expiresAt,
  fromIdx,
  toIdx,
});

test('a seat is free for the legs nobody has claimed', () => {
  const sold = [claim(0, 1)];
  assert.equal(seatStateFor(false, sold, { from: 0, to: 3 }), 'BOOKED');
  assert.equal(seatStateFor(false, sold, { from: 1, to: 3 }), 'AVAILABLE');
  assert.equal(seatStateFor(false, sold, { from: 0, to: 1 }), 'BOOKED');
  assert.equal(seatStateFor(false, sold, { from: 2, to: 3 }), 'AVAILABLE');
});

test('holds block only while live, confirmed beats held, blocked beats all', () => {
  const live = claim(0, 2, 'HELD'),
    stale = claim(0, 2, 'HELD', new Date(Date.now() - 1000));
  assert.equal(seatStateFor(false, [live], { from: 1, to: 3 }), 'HELD');
  assert.equal(seatStateFor(false, [stale], { from: 1, to: 3 }), 'AVAILABLE');
  assert.equal(seatStateFor(false, [live, claim(1, 2)], { from: 1, to: 3 }), 'BOOKED');
  assert.equal(seatStateFor(true, [], { from: 0, to: 1 }), 'BLOCKED');
});

test('search matches places in travel order anywhere on the trip', () => {
  const j = matchJourney(seq, 'mugl', 'pokh')!;
  assert.deepEqual([j.from, j.to], [1, 3]);
  assert.deepEqual(matchJourney(seq, '', '')!.segments, [0, 1, 2]);
  assert.equal(matchJourney(seq, 'pokhara', 'kathmandu'), null);
  assert.equal(matchJourney(seq, 'mugling', 'mugling'), null);
  const k = matchJourney(seq, 'kath', 'dam')!;
  assert.deepEqual([k.from, k.to], [0, 2]);
  assert.equal(matchJourney(seq, '', 'damauli')!.from, 0);
});

test('stop times are offsets from departure', () => {
  const d = new Date('2030-01-01T06:00:00Z');
  assert.equal(timeAtStop(d, seq, 2).toISOString(), '2030-01-01T11:00:00.000Z');
});

test('database refuses overlapping claims on one seat but allows adjacent legs', async () => {
  const pg = new PGlite({ extensions: { btree_gist } });
  try {
    for (const dir of (await readdir('prisma/migrations')).filter((n) => /^\d/.test(n)).sort())
      await pg.exec(await readFile('prisma/migrations/' + dir + '/migration.sql', 'utf8'));
    await pg.exec(`INSERT INTO "Operator"(id,name,slug,status) VALUES ('op','Op','op','ACTIVE');
INSERT INTO "Location"(id,name) VALUES ('KTM','Kathmandu'),('MUG','Mugling'),('PKR','Pokhara');
INSERT INTO "Route"(id,"operatorId","originId","destinationId","distanceKm","durationMinutes","baseFare") VALUES ('r','op','KTM','PKR',200,400,1000);
INSERT INTO "RouteStop"(id,"routeId","locationId",position,"offsetMinutes","kmFromOrigin") VALUES ('s','r','MUG',0,150,80);
INSERT INTO "Vehicle"(id,"operatorId",registration,name,type,operator,"operatorContact","emergencyContact",amenities) VALUES ('v','op','R','n','Bus','o','1','1','{}');
INSERT INTO "VehicleSeat"(id,"vehicleId",label,row,"column") VALUES ('vs','v','A1',0,0);
INSERT INTO "PaymentQR"(id,"operatorId",label,"imageKey","accountName",instructions) VALUES ('qr','op','b','k','n','i');
INSERT INTO "Trip"(id,"operatorId","vehicleId","routeId",departure,arrival,"boardingPoint","dropPoint",fare,"paymentQRId") VALUES ('t','op','v','r','2030-01-01 01:00','2030-01-01 09:00','a','b',1000,'qr');
INSERT INTO "TripSeat"(id,"tripId","vehicleSeatId") VALUES ('ts','t','vs');
INSERT INTO "GuestCustomer"(id,name,phone) VALUES ('g','T','9800000000');`);
    // The trigger snapshots the route timeline for trips created without one.
    const t = await pg.query<{ segmentCount: number; name: string }>(
      `SELECT "segmentCount", "stopSnapshot"->1->>'name' AS name FROM "Trip" WHERE id='t'`,
    );
    assert.deepEqual(t.rows[0], { segmentCount: 2, name: 'Mugling' });
    const booking = (id: string, from: number, to: number) =>
      pg.exec(`INSERT INTO "Booking"(id,"operatorId",reference,"accessHash","idempotencyKey","requestHash","tripId","customerId",amount,"fareSnapshot","qrSnapshot","expiresAt","fromIdx","toIdx") VALUES ('${id}','op','R${id}','h','k${id}','q${id}','t','g',1,1,'{}','2030-01-01',${from},${to})`);
    const seat = (id: string, b: string, from: number, to: number) =>
      pg.exec(`INSERT INTO "BookingSeat"(id,"bookingId","tripSeatId","fromIdx","toIdx") VALUES ('${id}','${b}','ts',${from},${to})`);
    await booking('b1', 0, 1);
    await seat('s1', 'b1', 0, 1);
    await booking('b2', 1, 2);
    await seat('s2', 'b2', 1, 2); // adjacent leg: allowed
    await booking('b3', 0, 2);
    await assert.rejects(seat('s3', 'b3', 0, 2), /one_active_claim_per_seat/);
    await assert.rejects(seat('s4', 'b3', 0, 1), /seat journey must equal/);
    await assert.rejects(booking('b4', 0, 3), /beyond the trip route/);
    await assert.rejects(booking('b5', 1, 1), /booking_journey_order/);
    // Releasing the first claim frees its leg.
    await pg.exec(`UPDATE "BookingSeat" SET active=false WHERE id='s1'`);
    await booking('b6', 0, 1);
    await seat('s6', 'b6', 0, 1);
    // Trip timelines and fare snapshots cannot be rewritten.
    await assert.rejects(pg.exec(`UPDATE "Trip" SET "segmentCount"=3 WHERE id='t'`), /trip_timeline_immutable|trip_segments_match/);
    await pg.exec(`INSERT INTO "TripFare"("tripId","fromIdx","toIdx",amount) VALUES ('t',0,2,1000)`);
    await assert.rejects(pg.exec(`UPDATE "TripFare" SET amount=1 WHERE "tripId"='t'`), /trip_fare_immutable/);
    await assert.rejects(pg.exec(`DELETE FROM "TripFare" WHERE "tripId"='t'`), /trip_fare_immutable/);
    await assert.rejects(pg.exec(`INSERT INTO "TripFare"("tripId","fromIdx","toIdx",amount) VALUES ('t',1,2,0)`), /trip_fare_positive/);
  } finally {
    await pg.close();
  }
});
