import { z } from 'zod';

/** A layout is a rectangular grid per deck. Only `seat` cells become bookable inventory. */
export const CELL_KINDS = ['seat', 'aisle', 'driver', 'door', 'toilet', 'luggage', 'empty'] as const;
export const SEAT_CATEGORIES = ['STANDARD', 'WINDOW', 'FRONT', 'SLEEPER', 'ACCESSIBLE', 'PREMIUM'] as const;
export type CellKind = (typeof CELL_KINDS)[number];
export type SeatCategory = (typeof SEAT_CATEGORIES)[number];

export const MAX_ROWS = 20;
export const MAX_COLS = 8;
export const MAX_SEATS = 60;

export const cellSchema = z.object({
  deck: z.number().int().min(0).max(1).default(0),
  row: z.number().int().min(0).max(MAX_ROWS - 1),
  col: z.number().int().min(0).max(MAX_COLS - 1),
  kind: z.enum(CELL_KINDS),
  label: z.string().trim().min(1).max(8).optional(),
  category: z.enum(SEAT_CATEGORIES).optional(),
});
export type Cell = z.infer<typeof cellSchema>;

export const gridSchema = z.object({
  rows: z.number().int().min(1).max(MAX_ROWS),
  cols: z.number().int().min(1).max(MAX_COLS),
  decks: z.number().int().min(1).max(2).default(1),
  cells: z.array(cellSchema).max(MAX_ROWS * MAX_COLS * 2),
});
export type Grid = z.infer<typeof gridSchema>;

export type LayoutIssue = { code: string; message: string; row?: number; col?: number; deck?: number };

/** Returns every problem found, never throws, so the editor can show all of them at once. */
export function validateLayout(input: Grid): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const at = new Map<string, Cell>();
  const labels = new Map<string, Cell>();
  let seats = 0;
  let drivers = 0;
  let doors = 0;
  for (const c of input.cells) {
    const where = { row: c.row, col: c.col, deck: c.deck };
    if (c.row >= input.rows || c.col >= input.cols || c.deck >= input.decks) {
      issues.push({ code: 'out_of_bounds', message: 'Cell lies outside the grid.', ...where });
      continue;
    }
    const key = `${c.deck}:${c.row}:${c.col}`;
    if (at.has(key)) {
      issues.push({ code: 'overlap', message: 'Two items occupy the same cell.', ...where });
      continue;
    }
    at.set(key, c);
    if (c.kind === 'driver') drivers++;
    if (c.kind === 'door') doors++;
    if (c.kind !== 'seat') {
      if (c.label || c.category)
        issues.push({ code: 'stray_seat_data', message: 'Only seats carry a label or category.', ...where });
      continue;
    }
    seats++;
    if (!c.label) {
      issues.push({ code: 'missing_label', message: 'Every seat needs a label.', ...where });
      continue;
    }
    const norm = c.label.toUpperCase();
    if (labels.has(norm))
      issues.push({ code: 'duplicate_label', message: `Seat label ${c.label} is used twice.`, ...where });
    else labels.set(norm, c);
  }
  if (seats === 0) issues.push({ code: 'no_seats', message: 'A layout needs at least one seat.' });
  if (seats > MAX_SEATS)
    issues.push({ code: 'too_many_seats', message: `A layout can hold at most ${MAX_SEATS} seats.` });
  if (drivers > 1) issues.push({ code: 'many_drivers', message: 'Only one driver position is allowed.' });
  if (doors === 0) issues.push({ code: 'no_door', message: 'Add at least one door so passengers can board.' });
  return issues;
}

export type CompiledSeat = {
  label: string;
  row: number;
  column: number;
  deck: number;
  category: SeatCategory;
};

/**
 * Turns a valid grid into bookable seats. Rows are stored decks-first so deck 1 never collides with
 * deck 0 on the (vehicleId,row,column) unique index: row = deck * MAX_ROWS + row.
 */
export function compileSeats(grid: Grid): CompiledSeat[] {
  const bad = validateLayout(grid);
  if (bad.length) throw new Error('Invalid layout: ' + bad[0].message);
  return grid.cells
    .filter((c) => c.kind === 'seat')
    .sort((a, b) => a.deck - b.deck || a.row - b.row || a.col - b.col)
    .map((c) => ({
      label: c.label!.toUpperCase(),
      row: c.deck * MAX_ROWS + c.row,
      column: c.col,
      deck: c.deck,
      category: c.category ?? 'STANDARD',
    }));
}

/** Seat labels A1.. by row letter and counted column, skipping non-seat cells. Used by templates and "auto label". */
export function autoLabel(grid: Grid): Grid {
  const cells = grid.cells.map((c) => ({ ...c }));
  const seats = cells
    .filter((c) => c.kind === 'seat')
    .sort((a, b) => a.deck - b.deck || a.row - b.row || a.col - b.col);
  const perRow = new Map<string, number>();
  const letterIndex = new Map<string, number>();
  let next = 0;
  for (const s of seats) {
    const rowKey = `${s.deck}:${s.row}`;
    if (!letterIndex.has(rowKey)) letterIndex.set(rowKey, next++);
    const n = (perRow.get(rowKey) ?? 0) + 1;
    perRow.set(rowKey, n);
    const idx = letterIndex.get(rowKey)!;
    const letter = idx < 26 ? String.fromCharCode(65 + idx) : 'A' + String.fromCharCode(65 + (idx - 26));
    s.label = `${letter}${n}`;
  }
  return { ...grid, cells };
}

const seat = (deck: number, row: number, col: number, category?: SeatCategory): Cell => ({
  deck,
  row,
  col,
  kind: 'seat',
  category,
});

/** 2+2 coach: driver and door in the first row, aisle in column 2, last row is a 5-seat bench. */
function coach(rows: number, cols: 4 | 3): Grid {
  const aisleCol = 2;
  const cells: Cell[] = [{ deck: 0, row: 0, col: 0, kind: 'door' }, { deck: 0, row: 0, col: cols, kind: 'driver' }];
  for (let r = 1; r <= rows; r++)
    for (let c = 0; c <= cols; c++) {
      if (c === aisleCol) cells.push({ deck: 0, row: r, col: c, kind: 'aisle' });
      else {
        const edge = c === 0 || c === cols;
        cells.push(seat(0, r, c, edge ? 'WINDOW' : 'STANDARD'));
      }
    }
  return autoLabel({ rows: rows + 1, cols: cols + 1, decks: 1, cells });
}

export const TEMPLATES: Record<string, { name: string; vehicleType: string; build: () => Grid }> = {
  coach_2x2_40: { name: 'Coach 2+2 (40 seats)', vehicleType: 'Bus', build: () => coach(10, 4) },
  deluxe_2x1_27: { name: 'Deluxe 2+1 (27 seats)', vehicleType: 'Deluxe Bus', build: () => coach(9, 3) },
  hiace_17: {
    name: 'Hiace (17 seats)',
    vehicleType: 'Hiace',
    build: () => {
      const cells: Cell[] = [
        { deck: 0, row: 0, col: 0, kind: 'driver' },
        seat(0, 0, 1, 'FRONT'),
        seat(0, 0, 2, 'FRONT'),
        { deck: 0, row: 1, col: 3, kind: 'door' },
      ];
      for (let r = 1; r <= 4; r++) {
        cells.push(seat(0, r, 0, 'WINDOW'), seat(0, r, 1), seat(0, r, 2));
        if (r > 1) cells.push(seat(0, r, 3, 'WINDOW'));
      }
      return autoLabel({ rows: 5, cols: 4, decks: 1, cells });
    },
  },
  sleeper_2deck_28: {
    name: 'Sleeper 2 decks (28 berths)',
    vehicleType: 'Deluxe Bus',
    build: () => {
      const cells: Cell[] = [{ deck: 0, row: 0, col: 0, kind: 'door' }, { deck: 0, row: 0, col: 2, kind: 'driver' }];
      for (let d = 0; d < 2; d++)
        for (let r = d === 0 ? 1 : 0; r < (d === 0 ? 8 : 7); r++) {
          cells.push(seat(d, r, 0, 'SLEEPER'), { deck: d, row: r, col: 1, kind: 'aisle' }, seat(d, r, 2, 'SLEEPER'));
        }
      return autoLabel({ rows: 8, cols: 3, decks: 2, cells });
    },
  },
};

/** What changed between two published versions; stored seat labels are the identity. */
export function diffLayouts(before: CompiledSeat[], after: CompiledSeat[]) {
  const a = new Map(before.map((s) => [s.label, s]));
  const b = new Map(after.map((s) => [s.label, s]));
  return {
    added: [...b.keys()].filter((l) => !a.has(l)),
    removed: [...a.keys()].filter((l) => !b.has(l)),
    moved: [...b.keys()].filter((l) => {
      const x = a.get(l),
        y = b.get(l);
      return x && y && (x.row !== y.row || x.column !== y.column);
    }),
  };
}
