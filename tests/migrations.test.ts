import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

test('PostgreSQL migrations enforce ownership, immutable confirmed claims and audit, and nonoverlapping schedules', async () => {
  const pg = new PGlite({ extensions: { btree_gist } });
  try {
    for (const dir of (await readdir('prisma/migrations')).filter((n) => /^\d/.test(n)).sort())
      await pg.exec(await readFile('prisma/migrations/' + dir + '/migration.sql', 'utf8'));
    await pg.exec(`INSERT INTO "Operator"(id,name,slug,status) VALUES ('op1','One','one','ACTIVE'),('op2','Two','two','ACTIVE');
INSERT INTO "AdminUser"(id,email,name,"passwordHash") VALUES ('admin','admin@test.local','Admin','test');
INSERT INTO "Driver"(id,"operatorId",email,name,"passwordHash",mobile,"licenseNumber","licenseExpiry","emergencyContact") VALUES ('driver','op1','driver@test.local','Driver','test','9800000000','test','2030-01-01','9800000000');
INSERT INTO "Vehicle"(id,"operatorId",registration,name,type,operator,"operatorContact","emergencyContact",amenities) VALUES ('v1','op1','TEST1','One','Bus','Test','9800000000','9800000000','{}'),('v2','op1','TEST2','Two','Bus','Test','9800000000','9800000000','{}');
INSERT INTO "VehicleSeat"(id,"vehicleId",label,row,"column") VALUES ('vs1','v1','A1',0,0),('vs2','v2','A1',0,0);
INSERT INTO "Location"(id,name) VALUES ('l1','Origin'),('l2','Destination');
INSERT INTO "Route"(id,"operatorId","originId","destinationId","distanceKm","durationMinutes","baseFare") VALUES ('r','op1','l1','l2',100,60,1000);
INSERT INTO "PaymentQR"(id,"operatorId",label,"imageKey","accountName",instructions) VALUES ('qr','op1','Bank','test-only','Test','Test');
INSERT INTO "Trip"(id,"operatorId","vehicleId","routeId",departure,arrival,"boardingPoint","dropPoint",fare,"paymentQRId") VALUES ('t1','op1','v1','r','2030-01-01 01:00','2030-01-01 02:00','Origin','Destination',1000,'qr'),('t2','op1','v2','r','2030-01-01 01:00','2030-01-01 02:00','Origin','Destination',1000,'qr');
INSERT INTO "TripSeat"(id,"tripId","vehicleSeatId") VALUES ('ts1','t1','vs1');
INSERT INTO "GuestCustomer"(id,name,phone) VALUES ('g','Test','9800000000');
INSERT INTO "Booking"(id,"operatorId",reference,"accessHash","idempotencyKey","requestHash","tripId","customerId",amount,"fareSnapshot","qrSnapshot","expiresAt") VALUES ('b1','op1','REF1','hash','key1','req1','t1','g',1000,1000,'{}','2030-01-01'),('b2','op1','REF2','hash','key2','req2','t1','g',1000,1000,'{}','2030-01-01');
INSERT INTO "BookingSeat"(id,"bookingId","tripSeatId") VALUES ('bs1','b1','ts1');`);
    await assert.rejects(
      () =>
        pg.exec(`INSERT INTO "BookingSeat"(id,"bookingId","tripSeatId") VALUES ('bs2','b2','ts1')`),
      /one_active_claim_per_seat/,
    );
    await pg.exec(
      `UPDATE "BookingSeat" SET active=false WHERE id='bs1'; INSERT INTO "BookingSeat"(id,"bookingId","tripSeatId") VALUES ('bs2','b2','ts1'); UPDATE "Booking" SET status='CONFIRMED' WHERE id='b2';`,
    );
    await assert.rejects(
      () => pg.exec(`UPDATE "BookingSeat" SET active=false WHERE id='bs2'`),
      /Confirmed seats/,
    );
    await assert.rejects(
      () => pg.exec(`DELETE FROM "BookingSeat" WHERE id='bs2'`),
      /Confirmed seats/,
    );
    await assert.rejects(
      () => pg.exec(`UPDATE "Booking" SET status='EXPIRED' WHERE id='b2'`),
      /refund workflow/,
    );
    await assert.rejects(
      () => pg.exec(`UPDATE "TripSeat" SET blocked=true WHERE id='ts1'`),
      /Seat is reserved/,
    );
    await assert.rejects(
      () =>
        pg.exec(`INSERT INTO "TripSeat"(id,"tripId","vehicleSeatId") VALUES ('bad','t1','vs2')`),
      /another vehicle/,
    );
    await assert.rejects(
      () =>
        pg.exec(
          `INSERT INTO "Trip"(id,"operatorId","vehicleId","routeId",departure,arrival,"boardingPoint","dropPoint",fare,"paymentQRId") VALUES ('conflict','op1','v1','r','2030-01-01 01:30','2030-01-01 02:30','Origin','Destination',1000,'qr')`,
        ),
      /vehicle_schedule_conflict/,
    );
    await pg.exec(
      `INSERT INTO "Trip"(id,"operatorId","vehicleId","routeId",departure,arrival,"boardingPoint","dropPoint",fare,"paymentQRId") VALUES ('adjacent','op1','v1','r','2030-01-01 02:00','2030-01-01 03:00','Origin','Destination',1000,'qr'); INSERT INTO "TripDriverAssignment"(id,"tripId","driverId","startsAt","endsAt") VALUES ('a1','t1','driver','2030-01-01 01:00','2030-01-01 02:00');`,
    );
    await assert.rejects(
      () =>
        pg.exec(
          `INSERT INTO "TripDriverAssignment"(id,"tripId","driverId","startsAt","endsAt") VALUES ('a2','t2','driver','2030-01-01 01:00','2030-01-01 02:00')`,
        ),
      /driver_schedule_conflict/,
    );
    await assert.rejects(
      () =>
        pg.exec(
          `INSERT INTO "TripDriverAssignment"(id,"tripId","driverId","startsAt","endsAt") VALUES ('a3','adjacent','driver','2030-01-01 03:00','2030-01-01 04:00')`,
        ),
      /match trip times/,
    );
    await assert.rejects(
      () =>
        pg.exec(
          `INSERT INTO "Vehicle"(id,"operatorId",registration,name,type,operator,"operatorContact","emergencyContact",amenities) VALUES ('v3','op2','TEST3','Three','Bus','T','9','9','{}'); INSERT INTO "Trip"(id,"operatorId","vehicleId","routeId",departure,arrival,"boardingPoint","dropPoint",fare,"paymentQRId") VALUES ('cross','op2','v3','r','2031-01-01 01:00','2031-01-01 02:00','O','D',1,'qr')`,
        ),
      /tenant_mismatch/,
    );
    await assert.rejects(
      () =>
        pg.exec(
          `INSERT INTO "Booking"(id,"operatorId",reference,"accessHash","idempotencyKey","requestHash","tripId","customerId",amount,"fareSnapshot","qrSnapshot","expiresAt") VALUES ('b3','op2','REF3','h','key3','r3','t1','g',1,1,'{}','2030-01-01')`,
        ),
      /tenant_mismatch/,
    );
    await assert.rejects(
      () =>
        pg.exec(
          `INSERT INTO "Driver"(id,"operatorId",email,name,"passwordHash",mobile,"licenseNumber","licenseExpiry","emergencyContact") VALUES ('d2','op2','d2@test.local','D2','x','9','lic2','2030-01-01','9'); INSERT INTO "TripDriverAssignment"(id,"tripId","driverId","startsAt","endsAt") VALUES ('xa','adjacent','d2','2030-01-01 02:00','2030-01-01 03:00')`,
        ),
      /tenant_mismatch/,
    );
    await pg.exec(
      `INSERT INTO "AuditLog"(id,"actorId",action,"targetId",details) VALUES ('audit','admin','VERIFY','b2','{}')`,
    );
    await assert.rejects(
      () => pg.exec(`UPDATE "AuditLog" SET action='TAMPER' WHERE id='audit'`),
      /immutable/,
    );
    await assert.rejects(() => pg.exec(`DELETE FROM "AuditLog" WHERE id='audit'`), /immutable/);
    assert.equal(
      (
        await pg.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "BookingSeat" WHERE active AND "tripSeatId"='ts1'`,
        )
      ).rows[0].count,
      1,
    );
    await assert.rejects(
      () =>
        pg.exec(
          `INSERT INTO "Payment"(id,"bookingId","paymentQRId",status) VALUES ('bad-payment','b2','qr','VERIFIED')`,
        ),
      /verified_payment_has_evidence/,
    );
    await pg.exec(
      `INSERT INTO "Payment"(id,"bookingId","paymentQRId",status,"verifiedAmount","reviewedById","reviewedAt") VALUES ('verified-payment','b2','qr','VERIFIED',1000,'admin',CURRENT_TIMESTAMP)`,
    );
  } finally {
    await pg.close();
  }
});
