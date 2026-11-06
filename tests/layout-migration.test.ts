import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

test('migration 3 keeps published layouts immutable and route points on valid stops', async () => {
  const pg = new PGlite({ extensions: { btree_gist } });
  try {
    for (const dir of (await readdir('prisma/migrations')).filter((n) => /^\d/.test(n)).sort())
      await pg.exec(await readFile('prisma/migrations/' + dir + '/migration.sql', 'utf8'));
    await pg.exec(`INSERT INTO "Operator"(id,name,slug,status) VALUES ('op1','One','one','ACTIVE'),('op2','Two','two','ACTIVE');
INSERT INTO "Location"(id,name) VALUES ('a','A'),('b','B'),('m','M'),('z','Z');
INSERT INTO "Route"(id,"operatorId","originId","destinationId","distanceKm","durationMinutes","baseFare") VALUES ('r','op1','a','b',100,200,1000);
INSERT INTO "RouteStop"(id,"routeId","locationId",position,"offsetMinutes","kmFromOrigin","allowBoarding","allowDropoff") VALUES ('s1','r','m',0,100,50,false,true);
INSERT INTO "SeatLayout"(id,"operatorId",name,"vehicleType") VALUES ('l1','op1','Coach','Bus');
INSERT INTO "SeatLayoutVersion"(id,"layoutId",version,status,rows,cols,decks,cells,"seatCount","createdById","publishedAt") VALUES
  ('v1','l1',1,'PUBLISHED',2,2,1,'[{"kind":"seat"}]',1,'x',now());
INSERT INTO "SeatLayoutVersion"(id,"layoutId",version,status,rows,cols,decks,cells,"seatCount","createdById") VALUES
  ('v2','l1',2,'DRAFT',2,2,1,'[]',0,'x');`);

    // layouts
    await assert.rejects(
      pg.exec(`INSERT INTO "SeatLayoutVersion"(id,"layoutId",version,status,rows,cols,cells,"createdById") VALUES ('v3','l1',3,'DRAFT',2,2,'[]','x')`),
      /SeatLayoutVersion_one_draft/,
    );
    await assert.rejects(
      pg.exec(`INSERT INTO "SeatLayoutVersion"(id,"layoutId",version,status,rows,cols,cells,"seatCount","createdById","publishedAt") VALUES ('v4','l1',1,'ARCHIVED',2,2,'[]',1,'x',now())`),
      /SeatLayoutVersion_layout_version/,
    );
    await assert.rejects(
      pg.exec(`UPDATE "SeatLayoutVersion" SET cells='[{"kind":"seat"},{"kind":"seat"}]' WHERE id='v1'`),
      /layout_immutable/,
    );
    await assert.rejects(pg.exec(`UPDATE "SeatLayoutVersion" SET status='DRAFT' WHERE id='v1'`), /layout_immutable/);
    await assert.rejects(pg.exec(`DELETE FROM "SeatLayoutVersion" WHERE id='v1'`), /layout_immutable/);
    await assert.rejects(
      pg.exec(`UPDATE "SeatLayoutVersion" SET status='PUBLISHED' WHERE id='v2'`),
      /layout_published_has_seats/,
      'a published version needs seats and a publish time',
    );
    await pg.exec(`UPDATE "SeatLayoutVersion" SET status='ARCHIVED' WHERE id='v1'`);
    await pg.exec(`DELETE FROM "SeatLayoutVersion" WHERE id='v2'`);

    // vehicles
    await assert.rejects(
      pg.exec(`INSERT INTO "Vehicle"(id,"operatorId",registration,name,type,operator,"operatorContact","emergencyContact",amenities,"layoutVersionId") VALUES ('x1','op1','R1','n','Bus','o','1','1','{}','v1')`),
      /layout_not_published/,
      'archived versions cannot be assigned to new vehicles',
    );
    await pg.exec(`INSERT INTO "SeatLayoutVersion"(id,"layoutId",version,status,rows,cols,cells,"seatCount","createdById","publishedAt") VALUES ('v5','l1',5,'PUBLISHED',2,2,'[{"kind":"seat"}]',1,'x',now())`);
    await assert.rejects(
      pg.exec(`INSERT INTO "Vehicle"(id,"operatorId",registration,name,type,operator,"operatorContact","emergencyContact",amenities,"layoutVersionId") VALUES ('x2','op2','R2','n','Bus','o','1','1','{}','v5')`),
      /tenant_mismatch/,
    );
    await pg.exec(`INSERT INTO "Vehicle"(id,"operatorId",registration,name,type,operator,"operatorContact","emergencyContact",amenities,"layoutVersionId") VALUES ('x3','op1','R3','n','Bus','o','1','1','{}','v5')`);
    await assert.rejects(pg.exec(`UPDATE "Vehicle" SET "layoutVersionId"=NULL WHERE id='x3'`), /layout_immutable/);
    await assert.rejects(
      pg.exec(`INSERT INTO "VehicleSeat"(id,"vehicleId",label,row,"column",category) VALUES ('bad','x3','Q1',0,0,'VIP')`),
      /vehicle_seat_category/,
    );

    // route points
    const point = (id: string, loc: string, kind: string) =>
      pg.exec(`INSERT INTO "BoardingPoint"(id,"routeId","locationId",kind,name) VALUES ('${id}','r','${loc}','${kind}','Gate ${id}')`);
    await point('p1', 'a', 'BOARDING');
    await point('p2', 'b', 'DROPOFF');
    await point('p3', 'm', 'DROPOFF');
    await assert.rejects(point('p4', 'a', 'DROPOFF'), /origin cannot be a drop-off/);
    await assert.rejects(point('p5', 'b', 'BOARDING'), /destination cannot be a boarding/);
    await assert.rejects(point('p6', 'm', 'BOARDING'), /does not allow that movement/);
    await assert.rejects(point('p7', 'z', 'BOARDING'), /not on this route/);
    await assert.rejects(
      pg.exec(`INSERT INTO "BoardingPoint"(id,"routeId","locationId",kind,name) VALUES ('p8','r','a','BOARDING','GATE p1')`),
      /BoardingPoint_unique/,
      'names are unique per stop and kind regardless of case',
    );
  } finally {
    await pg.close();
  }
});
