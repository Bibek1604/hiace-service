'use client';
import { useState } from 'react';
import { BusFront, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { api, ErrorBox, onForm } from './common';
import { Button } from './ui/button';
import { PasswordInput } from './ui/password-input';
export function SignIn() {
  const [error, setError] = useState<unknown>(null),
    [pending, setPending] = useState(false);
  const asked = useSearchParams().get('role')?.toUpperCase();
  // Workspace and email are controlled so a wrong password never clears them (React resets form fields after an action).
  const [role, setRole] = useState(['ADMIN', 'DRIVER'].includes(asked ?? '') ? asked! : 'DRIVER'),
    [email, setEmail] = useState('');
  return (
    <main className="auth-page">
      <div className="brand">
        <BusFront className="blue" />
        SajiloYatra
      </div>
      <h1 className="display" style={{ marginTop: 30 }}>{role === 'ADMIN' ? 'Admin sign in' : 'Driver sign in'}</h1>
      <p className="muted">Secure access for administrators and drivers.</p>
      <form
        className="card stack"
        onSubmit={onForm(async (form) => {
          setPending(true);
          setError(null);
          try {
            const r = await api<{ role: string }>('/api/auth/login', {
              method: 'POST',
              body: JSON.stringify(Object.fromEntries(form)),
            });
            location.href = r.role === 'ADMIN' ? '/admin/dashboard' : '/driver/trips';
          } catch (e) {
            setError(e);
            setPending(false);
          }
        })}
      >
        <label>
          Workspace
          <select name="role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="ADMIN">Admin</option>
            <option value="DRIVER">Driver</option>
          </select>
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <PasswordInput name="password" autoComplete="current-password" required />
        </label>
        <ErrorBox error={error} />
        <Button disabled={pending}>
          <ShieldCheck size={16} />
          {pending ? 'Signing in…' : 'Sign in securely'}
        </Button>
      </form>
      <p className="muted">
        Drivers receive access from the admin. Customers can book without an account.
      </p>
    </main>
  );
}
