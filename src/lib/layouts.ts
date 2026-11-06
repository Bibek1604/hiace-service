import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { ApiError } from './errors';
import { gridSchema, TEMPLATES, validateLayout, compileSeats, countSeats, diffLayouts, type Grid } from './seat-layout';
import type { Scope } from './admin';

// Plain transaction: unique violations here are about names and versions, not seats.
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => db.$transaction(fn, { timeout: 15000 });

export const layoutCreate = z.object({
  operatorId: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  vehicleType: z.string().trim().min(1).max(60),
  template: z.string().optional(),
  grid: gridSchema.optional(),
});
export const draftSave = z.object({ layoutId: z.string().min(1), grid: gridSchema });

const asGrid = (v: { rows: number; cols: number; decks: number; cells: unknown }): Grid =>
  gridSchema.parse({ rows: v.rows, cols: v.cols, decks: v.decks, cells: v.cells });

const owned = (scope: Scope) => (scope ? { operatorId: scope } : {});

export async function listLayouts(scope: Scope) {
  const layouts = await db.seatLayout.findMany({
    where: owned(scope),
    orderBy: { createdAt: 'desc' },
    include: {
      versions: {
        orderBy: { version: 'desc' },
        select: { id: true, version: true, status: true, seatCount: true, publishedAt: true },
      },
    },
  });
  return { items: layouts, templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, vehicleType: t.vehicleType })) };
}

export async function getLayout(scope: Scope, layoutId: string) {
  const l = await db.seatLayout.findFirst({
    where: { id: layoutId, ...owned(scope) },
    include: { versions: { orderBy: { version: 'desc' } } },
  });
  // A layout of another operator is reported as missing.
  if (!l) throw new ApiError(404, 'Layout not found.');
  return {
    ...l,
    versions: l.versions.map((v) => ({ ...v, grid: asGrid(v) })),
    issues: Object.fromEntries(l.versions.map((v) => [v.id, validateLayout(asGrid(v))])),
  };
}

export async function createLayout(scope: Scope, actorId: string, raw: unknown) {
  const d = layoutCreate.parse(raw);
  const operatorId = scope ?? d.operatorId;
  if (!operatorId) throw new ApiError(400, 'operatorId is required.');
  if (scope && d.operatorId && d.operatorId !== scope) throw new ApiError(404, 'Layout not found.');
  const template = d.template ? TEMPLATES[d.template] : null;
  if (d.template && !template) throw new ApiError(400, 'Unknown template.');
  const grid = d.grid ?? template?.build() ?? { rows: 6, cols: 5, decks: 1, cells: [] };
  try {
    return await tx(async (t) => {
      const layout = await t.seatLayout.create({
        data: { operatorId, name: d.name, vehicleType: d.vehicleType },
      });
      const version = await t.seatLayoutVersion.create({
        data: { layoutId: layout.id, version: 1, ...grid, seatCount: countSeats(grid), createdById: actorId },
      });
      await t.auditLog.create({
        data: { actorId, operatorId, action: 'CREATE_LAYOUT', targetId: layout.id, details: { name: d.name, template: d.template ?? null } },
      });
      return { ...layout, versions: [version] };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      throw new ApiError(409, 'A layout with that name already exists.');
    throw e;
  }
}

/** Saves the editable draft, opening a new draft from the latest version when none exists. Never touches published history. */
export async function saveDraft(scope: Scope, actorId: string, raw: unknown) {
  const d = draftSave.parse(raw);
  const seatCount = countSeats(d.grid);
  return tx(async (t) => {
    const layout = await t.seatLayout.findFirst({
      where: { id: d.layoutId, ...owned(scope) },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!layout) throw new ApiError(404, 'Layout not found.');
    if (layout.archived) throw new ApiError(409, 'This layout is archived.');
    const latest = layout.versions[0];
    const data = { rows: d.grid.rows, cols: d.grid.cols, decks: d.grid.decks, cells: d.grid.cells, seatCount };
    const draft =
      latest.status === 'DRAFT'
        ? await t.seatLayoutVersion.update({ where: { id: latest.id }, data })
        : await t.seatLayoutVersion.create({
            data: { ...data, layoutId: layout.id, version: latest.version + 1, createdById: actorId },
          });
    return { id: draft.id, version: draft.version, issues: validateLayout(d.grid) };
  });
}

/** Publishes the draft. Validation failures are returned to the editor as 422 with every issue. */
export async function publishLayout(scope: Scope, actorId: string, layoutId: string) {
  return tx(async (t) => {
    const layout = await t.seatLayout.findFirst({
      where: { id: layoutId, ...owned(scope) },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!layout) throw new ApiError(404, 'Layout not found.');
    const draft = layout.versions.find((v) => v.status === 'DRAFT');
    if (!draft) throw new ApiError(409, 'There is no draft to publish.');
    const grid = asGrid(draft);
    const issues = validateLayout(grid);
    if (issues.length) throw new ApiError(422, issues.map((i) => i.message).join(' '));
    const previous = layout.versions.find((v) => v.status === 'PUBLISHED');
    const published = await t.seatLayoutVersion.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), seatCount: compileSeats(grid).length },
    });
    if (previous) await t.seatLayoutVersion.update({ where: { id: previous.id }, data: { status: 'ARCHIVED' } });
    const change = previous ? diffLayouts(compileSeats(asGrid(previous)), compileSeats(grid)) : null;
    await t.auditLog.create({
      data: {
        actorId,
        operatorId: layout.operatorId,
        action: 'PUBLISH_LAYOUT',
        targetId: layout.id,
        details: { version: published.version, seats: published.seatCount, change },
      },
    });
    return { id: published.id, version: published.version, seatCount: published.seatCount };
  });
}

export async function archiveLayout(scope: Scope, actorId: string, layoutId: string) {
  return tx(async (t) => {
    const layout = await t.seatLayout.findFirst({ where: { id: layoutId, ...owned(scope) } });
    if (!layout) throw new ApiError(404, 'Layout not found.');
    await t.seatLayout.update({ where: { id: layoutId }, data: { archived: true } });
    await t.auditLog.create({
      data: { actorId, operatorId: layout.operatorId, action: 'ARCHIVE_LAYOUT', targetId: layout.id, details: {} },
    });
    return { ok: true };
  });
}

/** Seat rows for a new vehicle, from a published layout version of that operator. */
export async function seatsForVehicle(t: Prisma.TransactionClient, operatorId: string, versionId: string) {
  const v = await t.seatLayoutVersion.findFirst({
    where: { id: versionId, status: 'PUBLISHED', layout: { operatorId, archived: false } },
  });
  if (!v) throw new ApiError(400, 'Choose a published seat layout of this operator.');
  return compileSeats(asGrid(v));
}

/**
 * Deletes a layout that was never published and is not used by any vehicle. Published layouts are
 * history (vehicles and bookings were compiled from them) and can only be archived.
 */
export async function deleteLayout(scope: Scope, actorId: string, layoutId: string) {
  return tx(async (t) => {
    const layout = await t.seatLayout.findFirst({
      where: { id: layoutId, ...owned(scope) },
      include: { versions: { select: { id: true, status: true, _count: { select: { vehicles: true } } } } },
    });
    if (!layout) throw new ApiError(404, 'Layout not found.');
    if (layout.versions.some((v) => v._count.vehicles > 0))
      throw new ApiError(409, 'Vehicles are registered with this layout. Archive it instead.');
    if (layout.versions.some((v) => v.status !== 'DRAFT'))
      throw new ApiError(409, 'A published layout is kept as history. Archive it instead.');
    await t.seatLayoutVersion.deleteMany({ where: { layoutId } });
    await t.seatLayout.delete({ where: { id: layoutId } });
    await t.auditLog.create({
      data: { actorId, operatorId: layout.operatorId, action: 'DELETE_LAYOUT', targetId: layoutId, details: { name: layout.name } },
    });
    return { ok: true, id: layoutId };
  });
}
