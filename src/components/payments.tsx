'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Search, ShieldCheck } from 'lucide-react';
import { api, Badge, ErrorBox, Skeleton, Sheet, adminApi, onForm } from './common';
import { Button } from './ui/button';
import { money } from '@/lib/utils';
type Payment = {
  id: string;
  status: string;
  claimedAmount: number | null;
  method: string;
  transactionRef: string | null;
  duplicateReference: boolean;
  reviewedAt: string | null;
  note: string;
  proofs: { id: string; imageKey: string; createdAt: string; remarks: string }[];
  booking: {
    id: string;
    reference: string;
    amount: number;
    expiresAt: string;
    status: string;
    customer: { name: string; phone: string };
    trip: {
      departure: string;
      vehicle: { name: string; registration: string };
      route: { origin: { name: string }; destination: { name: string } };
    };
    seats: { tripSeat: { vehicleSeat: { label: string } } }[];
  };
};
function Audit({ target }: { target: string }) {
  const q = useQuery({
    queryKey: ['audit', target],
    queryFn: () =>
      api<{ id: string; action: string; actorId: string; createdAt: string; details: unknown }[]>(
        adminApi('audit?targetId=') + target,
      ),
  });
  return (
    <details>
      <summary>Immutable decision history</summary>
      <ErrorBox error={q.error} />
      {q.data?.map((a) => (
        <div className="notice" key={a.id}>
          <strong>{a.action}</strong>
          <p>
            {a.actorId} ·{' '}
            {new Date(a.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
            {JSON.stringify(a.details, null, 2)}
          </pre>
        </div>
      ))}
    </details>
  );
}
export function Payments() {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [status, setStatus] = useState('SUBMITTED'),
    [selected, setSelected] = useState<Payment | null>(null),
    [action, setAction] = useState<'verify' | 'reject' | 'clarify' | 'reconcile'>('verify'),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ['payments', page, status, search],
    queryFn: () =>
      api<{ items: Payment[]; nextPage: number | null }>(
        adminApi('payments?') + new URLSearchParams({ page: String(page), ...(status ? { status } : {}), ...(search ? { q: search } : {}) }),
      ),
    refetchInterval: 15000,
  });
  async function decide(form: FormData) {
    if (!selected) return;
    setPending(true);
    setError(null);
    try {
      if (action === 'reconcile')
        await api(adminApi('reconciliation'), {
          method: 'POST',
          body: JSON.stringify({
            bookingId: selected.booking.id,
            note: form.get('note'),
            outcome: form.get('outcome'),
          }),
        });
      else
        await api(adminApi('payments/') + selected.id, {
          method: 'POST',
          body: JSON.stringify({
            action,
            note: form.get('note'),
            bankEvidence: form.get('bankEvidence') || undefined,
            ...(action === 'verify' ? { verifiedAmount: Number(form.get('verifiedAmount')) } : {}),
            confirm: form.get('confirm') === 'on',
            acknowledgeDuplicate: form.get('acknowledgeDuplicate') === 'on',
          }),
        });
      setSelected(null);
      await client.invalidateQueries({ queryKey: ['payments'] });
      await client.invalidateQueries({ queryKey: ['audit'] });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <p className="eyebrow">PAYMENT OPERATIONS</p>
      <h1>Review & verify payments</h1>
      <p className="muted">
        A screenshot is a claim of payment. Check the actual transaction before verifying.
      </p>
      <form
        className="toolbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(String(new FormData(e.currentTarget).get('q') || '').trim());
        }}
      >
        <label className="toolbar-search">
          <Search size={16} aria-hidden="true" />
          <input name="q" key={search} defaultValue={search} placeholder="Booking reference, passenger, phone or transaction" aria-label="Search payments" />
        </label>
        <select
          aria-label="Filter by payment status"
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
        >
          <option value="">All payments</option>
          <option value="SUBMITTED">Waiting for review</option>
          <option value="UNDER_REVIEW">Clarification asked</option>
          <option value="VERIFIED">Verified</option>
          <option value="REJECTED">Rejected</option>
          <option value="UNPAID">Not paid yet</option>
        </select>
        <Button variant="outline">Search</Button>
      </form>
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Skeleton />
      ) : (
        q.data?.items
          .map((p) => (
            <article className="payment-review" key={p.id}>
              <div className="spread">
                <h2>{p.booking.reference}</h2>
                <Badge status={p.status} />
              </div>
              <div className="grid-2">
                <div>
                  <h3>{p.booking.customer.name}</h3>
                  <a className="blue" href={'tel:' + p.booking.customer.phone}>
                    {p.booking.customer.phone}
                  </a>
                  <p>
                    {p.booking.trip.route.origin.name} → {p.booking.trip.route.destination.name}
                    <br />
                    {p.booking.trip.vehicle.name} · {p.booking.trip.vehicle.registration}
                    <br />
                    {new Date(p.booking.trip.departure).toLocaleString('en-GB', {
                      timeZone: 'Asia/Kathmandu',
                    })}
                  </p>
                  <p>
                    <strong>Seats:</strong>{' '}
                    {p.booking.seats.map((s) => s.tripSeat.vehicleSeat.label).join(', ')}
                  </p>
                  <dl className="definition">
                    <div>
                      <dt>Amount expected</dt>
                      <dd>{money(p.booking.amount)}</dd>
                    </div>
                    <div>
                      <dt>Amount claimed</dt>
                      <dd>{p.claimedAmount ? money(p.claimedAmount) : 'Not submitted'}</dd>
                    </div>
                    <div>
                      <dt>Transaction reference</dt>
                      <dd>{p.transactionRef || 'Not provided'}</dd>
                    </div>
                    <div>
                      <dt>Method</dt>
                      <dd>{p.method}</dd>
                    </div>
                    <div>
                      <dt>Verification deadline</dt>
                      <dd>
                        {new Date(p.booking.expiresAt).toLocaleString('en-GB', {
                          timeZone: 'Asia/Kathmandu',
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>Booking</dt>
                      <dd>
                        <Badge status={p.booking.status} />
                      </dd>
                    </div>
                  </dl>
                  {p.duplicateReference && (
                    <div className="error">
                      <AlertTriangle size={18} /> Duplicate reference. Investigate before
                      verification.
                    </div>
                  )}
                  {p.claimedAmount !== null && p.claimedAmount !== p.booking.amount && (
                    <div className="error">Claimed amount differs from the expected fare.</div>
                  )}
                  {p.note && <p className="notice">{p.note}</p>}
                </div>
                <div>
                  {p.proofs.map((proof) => (
                    <div key={proof.id}>
                      <a href={'/api/images/' + proof.imageKey} target="_blank" rel="noreferrer">
                        <img
                          className="proof-preview"
                          src={'/api/images/' + proof.imageKey}
                          alt={'Payment proof for ' + p.booking.reference}
                        />
                      </a>
                      <p className="muted">
                        Submitted{' '}
                        {new Date(proof.createdAt).toLocaleString('en-GB', {
                          timeZone: 'Asia/Kathmandu',
                        })}
                        <br />
                        {proof.remarks}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="row">
                {p.proofs.length > 0 &&
                  ['SUBMITTED', 'UNDER_REVIEW'].includes(p.status) &&
                  ['PAYMENT_REVIEW', 'PAYMENT_RECONCILIATION_REQUIRED'].includes(p.booking.status) && (
                  <>
                    <Button
                      onClick={() => {
                        setSelected(p);
                        setAction('verify');
                        setError(null);
                      }}
                    >
                      <ShieldCheck size={16} />
                      Verify payment
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setSelected(p);
                        setAction('reject');
                        setError(null);
                      }}
                    >
                      Reject proof
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelected(p);
                        setAction('clarify');
                        setError(null);
                      }}
                    >
                      Request clarification
                    </Button>
                  </>
                )}
                {p.booking.status === 'PAYMENT_RECONCILIATION_REQUIRED' && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelected(p);
                      setAction('reconcile');
                      setError(null);
                    }}
                  >
                    Record reconciliation
                  </Button>
                )}
              </div>
              <div style={{ marginTop: 20 }}>
                <Audit target={p.booking.id} />
              </div>
            </article>
          ))
      )}
      {!q.isLoading && !q.data?.items.length && (
        <div className="card">{search || status ? 'No payments match this view.' : 'No payment records yet.'}</div>
      )}
      <div className="pagination">
        <Button variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </Button>
        <span>Page {page}</span>
        <Button
          variant="outline"
          disabled={!q.data?.nextPage}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
      <Sheet
        open={!!selected}
        onOpenChange={(o) => {
          if (!o && !pending) setSelected(null);
        }}
        title={
          action === 'verify'
            ? 'Confirm bank / wallet verification'
            : action === 'reject'
              ? 'Reject this payment proof'
              : action === 'reconcile'
                ? 'Record reconciliation outcome'
                : 'Request clarification'
        }
      >
        <form onSubmit={onForm(decide)} className="stack">
          <p>
            {selected?.booking.reference} · {selected && money(selected.booking.amount)}
          </p>
          {action === 'verify' && (
            <>
              <div className="notice">
                Check the actual bank or wallet ledger. If the hold expired, the server will reserve
                all original seats or flag reconciliation.
              </div>
              <label>
                Confirmed bank / wallet amount (NPR)
                <input
                  name="verifiedAmount"
                  type="number"
                  step="1"
                  min={selected?.booking.amount || 1}
                  defaultValue={selected?.booking.amount}
                  required
                />
              </label>
              <label>
                Actual bank / wallet evidence
                <input
                  name="bankEvidence"
                  required
                  maxLength={1000}
                  placeholder="Ledger reference and verified amount"
                />
              </label>
              <label className="row">
                <input name="confirm" type="checkbox" required />I checked the actual transaction
                and confirm receipt.
              </label>
              {selected?.duplicateReference && (
                <label className="row">
                  <input type="checkbox" name="acknowledgeDuplicate" required />I investigated this
                  duplicate reference.
                </label>
              )}
            </>
          )}
          {action === 'reconcile' && (
            <label>
              Admin action
              <select name="outcome">
                <option>Alternative seat offered</option>
                <option>Alternative trip offered</option>
                <option>Refund arranged</option>
                <option>Customer contacted; investigation pending</option>
              </select>
            </label>
          )}
          <label>
            {action === 'clarify' ? 'Message to customer' : 'Decision / reconciliation notes'}
            <textarea name="note" minLength={3} maxLength={2000} required />
          </label>
          <ErrorBox error={error} />
          <Button disabled={pending} variant={action === 'reject' ? 'destructive' : 'default'}>
            {pending
              ? 'Recording decision…'
              : action === 'verify'
                ? 'Confirm verified payment'
                : 'Record ' + action}
          </Button>
        </form>
      </Sheet>
    </>
  );
}
