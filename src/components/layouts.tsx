'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, api, Badge, ErrorBox, Skeleton, StaffLink as Link } from './common';
import { Button } from './ui/button';
import {
  CELL_KINDS,
  SEAT_CATEGORIES,
  autoLabel,
  countSeats,
  isBookableSeat,
  validateLayout,
  type Cell,
  type CellKind,
  type Grid,
  type SeatCategory,
} from '@/lib/seat-layout';

type LayoutRow = {
  id: string;
  name: string;
  vehicleType: string;
  archived: boolean;
  versions: { id: string; version: number; status: string; seatCount: number }[];
};
type LayoutList = { items: LayoutRow[]; templates: { key: string; name: string; vehicleType: string }[] };
type LayoutDetail = {
  id: string;
  name: string;
  versions: { id: string; version: number; status: string; grid: Grid }[];
};

const json = (v: unknown) => JSON.stringify(v);
const LABEL: Record<CellKind, string> = {
  seat: 'Seat',
  'door-seat': 'Door + seat',
  aisle: 'Aisle',
  driver: 'Driver',
  door: 'Door',
  toilet: 'Toilet',
  luggage: 'Luggage',
  empty: 'Erase',
};

export function LayoutsAdmin() {
  const client = useQueryClient();
  const [name, setName] = useState(''),
    [type, setType] = useState('Bus'),
    [template, setTemplate] = useState(''),
    [operatorId, setOperatorId] = useState(''),
    [error, setError] = useState<unknown>(null);
  const q = useQuery({ queryKey: ['layouts'], queryFn: () => api<LayoutList>(adminApi('seat-layouts')) });
  const operators = useQuery({
    queryKey: ['owners'],
    queryFn: () => api<{ items: { id: string; name: string }[] }>(adminApi('owners')),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(adminApi('seat-layouts/' + id), { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['layouts'] }),
    onError: setError,
  });
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>(adminApi('seat-layouts'), {
        method: 'POST',
        body: json({ name, vehicleType: type, template: template || undefined, operatorId: operatorId || undefined }),
      }),
    onSuccess: (l) => {
      client.invalidateQueries({ queryKey: ['layouts'] });
      location.href = `${location.pathname.replace(/\/new$/, '')}/${l.id}`;
    },
    onError: setError,
  });
  return (
    <div className="stack">
      <section className="card">
        <h2>New seat layout</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate();
          }}
        >
          <div className="grid-2">
            <label>
              Layout name *
              <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Vehicle type *
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {['Bus', 'Deluxe Bus', 'Hiace', 'Jeep', 'Car'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              Start from
              <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                <option value="">Blank grid</option>
                {q.data?.templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            {(
              <label>
                Driver *
                <select required value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
                  <option value="">Select driver</option>
                  {operators.data?.items
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>
          <ErrorBox error={error} />
          <Button disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create and edit'}</Button>
        </form>
      </section>
      <section className="card">
        <h2>Seat layouts</h2>
        {q.isLoading ? (
          <Skeleton />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : !q.data?.items.length ? (
          <p className="muted">No layouts yet. Pick a template above to get started.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Versions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td>{l.vehicleType}</td>
                    <td>
                      {l.versions.map((v) => (
                        <span key={v.id} style={{ marginRight: 6 }}>
                          v{v.version} <Badge status={v.status} /> ({v.seatCount})
                        </span>
                      ))}
                    </td>
                    <td>
                      <Link href={`/admin/seat-layouts/${l.id}`}>Open</Link>
                      {l.archived && <Badge status="ARCHIVED" />}
                      {l.versions.every((v) => v.status === 'DRAFT') && (
                        <>
                          {' '}
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={() => window.confirm(`Delete the draft layout "${l.name}"?`) && (setError(null), del.mutate(l.id))}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const keyOf = (c: Pick<Cell, 'deck' | 'row' | 'col'>) => `${c.deck}:${c.row}:${c.col}`;

/** The tap-and-drag seat grid. Callers own the grid, so it works with or without a saved layout. */
export function SeatGridEditor({ grid, edit, header }: { grid: Grid; edit: (change: (g: Grid) => Grid) => void; header?: ReactNode }) {
  const [tool, setTool] = useState<CellKind>('seat'),
    [category, setCategory] = useState<SeatCategory>('STANDARD'),
    [deck, setDeck] = useState(0);
  const painting = useRef(false);
  const cells = useMemo(() => new Map(grid.cells.map((c) => [keyOf(c), c])), [grid]);
  const seatCount = countSeats(grid);
  const paint = (row: number, col: number) =>
    edit((g) => {
      const rest = g.cells.filter((c) => !(c.deck === deck && c.row === row && c.col === col));
      if (tool === 'empty') return { ...g, cells: rest };
      const cell: Cell = { deck, row, col, kind: tool };
      if (tool === 'seat' || tool === 'door-seat') cell.category = category;
      return { ...g, cells: [...rest, cell] };
    });
  const resize = (key: 'rows' | 'cols' | 'decks', value: number) => {
    edit((g) => {
      const next = { ...g, [key]: value };
      return { ...next, cells: next.cells.filter((c) => c.row < next.rows && c.col < next.cols && c.deck < next.decks) };
    });
    if (key === 'decks' && deck >= value) setDeck(0);
  };
  const relabel = (c: Cell, label: string) =>
    edit((g) => ({ ...g, cells: g.cells.map((x) => (keyOf(x) === keyOf(c) ? { ...x, label: label || undefined } : x)) }));
  const decks = Array.from({ length: grid.decks }, (_, i) => i);
  const labelled = grid.cells.filter(isBookableSeat);
  return (
    <>
      <section className="card">
        {header}
        <div className="grid-2">
          <label>
            Rows
            <input type="number" min={1} max={20} value={grid.rows} onChange={(e) => resize('rows', Math.min(20, Math.max(1, +e.target.value || 1)))} />
          </label>
          <label>
            Columns
            <input type="number" min={1} max={8} value={grid.cols} onChange={(e) => resize('cols', Math.min(8, Math.max(1, +e.target.value || 1)))} />
          </label>
          <label>
            Decks
            <select value={grid.decks} onChange={(e) => resize('decks', +e.target.value)}>
              <option value={1}>Single deck</option>
              <option value={2}>Double deck</option>
            </select>
          </label>
        </div>
        <div role="toolbar" aria-label="Layout tools" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' }}>
          {CELL_KINDS.map((k) => (
            <Button key={k} type="button" variant={tool === k ? 'default' : 'outline'} aria-pressed={tool === k} onClick={() => setTool(k)}>
              {LABEL[k]}
            </Button>
          ))}
          {(tool === 'seat' || tool === 'door-seat') && (
            <select aria-label="Seat category" value={category} onChange={(e) => setCategory(e.target.value as SeatCategory)}>
              {SEAT_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => edit(autoLabel)}
          >
            Auto-label seats
          </Button>
        </div>
        {grid.decks > 1 && (
          <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {decks.map((d) => (
              <Button key={d} type="button" role="tab" aria-selected={deck === d} variant={deck === d ? 'default' : 'outline'} onClick={() => setDeck(d)}>
                {d === 0 ? 'Lower deck' : 'Upper deck'}
              </Button>
            ))}
          </div>
        )}
        <div style={{ overflowX: 'auto', touchAction: 'none' }} onPointerUp={() => (painting.current = false)} onPointerLeave={() => (painting.current = false)}>
          <div
            role="grid"
            aria-label={`Seat grid, ${deck === 0 ? 'lower' : 'upper'} deck`}
            style={{ display: 'grid', gridTemplateColumns: `repeat(${grid.cols}, 52px)`, gap: 4, width: 'max-content' }}
          >
            {Array.from({ length: grid.rows * grid.cols }, (_, i) => {
              const row = Math.floor(i / grid.cols),
                col = i % grid.cols,
                c = cells.get(`${deck}:${row}:${col}`);
              return (
                <button
                  type="button"
                  key={i}
                  role="gridcell"
                  aria-label={`Row ${row + 1}, column ${col + 1}: ${c ? (isBookableSeat(c) ? `${c.kind === 'door-seat' ? 'door and ' : ''}seat ${c.label ?? 'unlabelled'}` : c.kind) : 'empty'}`}
                  onPointerDown={(e) => {
                    e.currentTarget.releasePointerCapture?.(e.pointerId);
                    painting.current = true;
                    paint(row, col);
                  }}
                  onPointerEnter={() => painting.current && paint(row, col)}
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 8,
                    border: '1px solid var(--border, #cbd5e1)',
                    background: !c ? 'transparent' : isBookableSeat(c) ? (c.label ? (c.kind === 'door-seat' ? '#fef3c7' : '#dcfce7') : '#fee2e2') : '#e2e8f0',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {c ? (isBookableSeat(c) ? c.kind === 'door-seat' ? `Door ${c.label ?? '?'}` : c.label ?? '?' : LABEL[c.kind]) : ''}
                </button>
              );
            })}
          </div>
        </div>
        <p className="muted">
          {seatCount} seats. “Door + seat” is a bookable seat at the same fare as other seats. Tap or drag to place the selected item. Red seats still need a label.
        </p>
      </section>
      {labelled.length > 0 && (
        <section className="card">
          <h2>Seat labels</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {labelled
              .sort((a, b) => a.deck - b.deck || a.row - b.row || a.col - b.col)
              .map((c) => (
                <label key={keyOf(c)} style={{ width: 84 }}>
                  <small>
                    {c.deck ? 'U' : 'L'}
                    {c.row + 1}/{c.col + 1}
                  </small>
                  <input aria-label={`Label for seat at row ${c.row + 1}, column ${c.col + 1}`} maxLength={8} value={c.label ?? ''} onChange={(e) => relabel(c, e.target.value.trim())} />
                </label>
              ))}
          </div>
        </section>
      )}
    </>
  );
}

export function LayoutEditor({ id }: { id: string }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['layout', id], queryFn: () => api<LayoutDetail>(adminApi('seat-layouts/' + id)) });
  const [grid, setGrid] = useState<Grid | null>(null),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');

  // The editable grid is the draft when one exists, otherwise a copy of the latest version.
  const latest = q.data?.versions[0];
  const isDraft = latest?.status === 'DRAFT';
  useEffect(() => {
    if (latest && !dirty) setGrid(latest.grid);
  }, [latest, dirty]);

  const issues = useMemo(() => (grid ? validateLayout(grid) : []), [grid]);

  const edit = (change: (g: Grid) => Grid) => {
    setGrid((g) => g && change(g));
    setDirty(true);
    setNotice('');
  };

  const save = useMutation({
    mutationFn: () => api(adminApi('seat-layouts'), { method: 'PATCH', body: json({ layoutId: id, grid }) }),
    onSuccess: async () => {
      setDirty(false);
      setNotice('Draft saved.');
      await client.invalidateQueries({ queryKey: ['layout', id] });
    },
    onError: setError,
  });
  const publish = useMutation({
    mutationFn: async () => {
      await api(adminApi('seat-layouts'), { method: 'PATCH', body: json({ layoutId: id, grid }) });
      return api<{ version: number }>(adminApi(`seat-layouts/${id}/publish`), { method: 'POST', body: '{}' });
    },
    onSuccess: async (r) => {
      setDirty(false);
      setNotice(`Version ${r.version} published. Vehicles registered from now on can use it.`);
      await client.invalidateQueries({ queryKey: ['layout', id] });
      await client.invalidateQueries({ queryKey: ['layouts'] });
    },
    onError: setError,
  });

  if (q.isLoading || !grid) return q.error ? <ErrorBox error={q.error} /> : <Skeleton />;
  const readOnly = latest?.status !== 'DRAFT' && !dirty;

  return (
    <div className="stack">
      <SeatGridEditor
        grid={grid}
        edit={edit}
        header={
          <>
        <h2>
          {q.data!.name} <Badge status={latest!.status} /> <small>v{latest!.version}</small>
        </h2>
        {readOnly && (
          <p className="muted">
            Published versions never change, because vehicles and bookings depend on them. Edit the grid to start version{' '}
            {latest!.version + 1}.
          </p>
        )}
          </>
        }
      />
      <section className="card">
        <h2>Checks</h2>
        {issues.length === 0 ? (
          <p>No problems. This layout can be published.</p>
        ) : (
          <ul>
            {issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        )}
        <ErrorBox error={error} />
        {notice && <p role="status">{notice}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button type="button" variant="secondary" disabled={!dirty || save.isPending} onClick={() => (setError(null), save.mutate())}>
            Save draft
          </Button>
          <Button type="button" disabled={issues.length > 0 || (!dirty && !isDraft) || publish.isPending} onClick={() => (setError(null), publish.mutate())}>
            Publish version
          </Button>
        </div>
      </section>
    </div>
  );
}
