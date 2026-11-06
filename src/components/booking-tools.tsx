'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorBox, onForm } from './common';
import { useSite } from './site-context';
import { Button } from './ui/button';
export function SignedTicket({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => api<{ ticket: string }>('/api/bookings/' + id + '/ticket'),
  });
  return (
    <details>
      <summary>Secure ticket verification code</summary>
      <p className="muted">Your driver can paste this signed code into the manifest validator.</p>
      <textarea readOnly aria-label="Signed ticket code" value={q.data?.ticket || ''} />
      <ErrorBox error={q.error} />
    </details>
  );
}
export function Clarification({ id }: { id: string }) {
  const copy = useSite().copy;
  const [error, setError] = useState<unknown>(null),
    [sent, setSent] = useState(false),
    [pending, setPending] = useState(false);
  return (
    <form
      className="card stack no-print"
      onSubmit={onForm(async (f, form) => {
        setPending(true);
        setError(null);
        try {
          await api('/api/bookings/' + id + '/clarification', {
            method: 'POST',
            body: JSON.stringify({ message: f.get('message') }),
          });
          setSent(true);
          form.reset();
        } catch (e) {
          setError(e);
        } finally {
          setPending(false);
        }
      })}
    >
      <h2>{copy.booking.messageHeading}</h2>
      <label>
        Clarification or reconciliation details
        <textarea name="message" required minLength={3} maxLength={2000} />
      </label>
      <ErrorBox error={error} />
      {sent && <p className="notice">Your message was recorded.</p>}
      <Button disabled={pending}>{pending ? 'Sending…' : 'Send clarification'}</Button>
    </form>
  );
}
