'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { TripView } from '@/lib/types';
import { api, ErrorBox, adminApi } from './common';
import { Button } from './ui/button';
export function SeatControls({ tripId }: { tripId: string }) {
  const [error, setError] = useState<unknown>(null),
    [pending, setPending] = useState('');
  const q = useQuery({
    queryKey: ['admin-seats', tripId],
    queryFn: () => api<TripView>('/api/trips/' + tripId),
  });
  async function toggle(id: string, blocked: boolean) {
    const note = window.prompt('Record the reason for this inventory change:');
    if (!note || note.trim().length < 3) return;
    setPending(id);
    setError(null);
    try {
      await api(adminApi('trip-seats'), {
        method: 'PATCH',
        body: JSON.stringify({ tripSeatId: id, blocked, note }),
      });
      await q.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setPending('');
    }
  }
  return (
    <div className="card">
      <h2>Trip seat inventory</h2>
      <p className="muted">Reserved seats cannot be blocked. Every change is audited.</p>
      <div className="row">
        {q.data?.seats.map((s) => (
          <Button
            key={s.id}
            variant="outline"
            disabled={!!pending || ['HELD', 'BOOKED'].includes(s.state)}
            onClick={() => toggle(s.id, s.state !== 'BLOCKED')}
          >
            {s.label} ·{' '}
            {s.state === 'BLOCKED' ? 'Unblock' : s.state === 'AVAILABLE' ? 'Block' : s.state}
          </Button>
        ))}
      </div>
      <ErrorBox error={error || q.error} />
    </div>
  );
}
