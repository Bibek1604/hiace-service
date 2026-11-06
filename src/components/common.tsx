'use client';
import Link from 'next/link';
import { BusFront, ArrowRight, ShieldCheck, Ticket, Search, House, LogOut } from 'lucide-react';
import { usePathname } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from './ui/button';
import { InstallApp } from './pwa';
import type { SiteContent } from '@/lib/site-content';
export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      ...init,
      headers: {
        ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error('Unable to reach the server. Check your connection and try again.');
  }
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(
      r.status >= 500
        ? 'The service is temporarily unavailable. Please try again in a moment.'
        : 'Unable to reach the server. Try again.',
    );
  }
  if (!r.ok)
    throw new Error(
      data?.error ||
        (r.status === 429 ? 'Too many attempts. Please wait a moment.' : 'Something went wrong. Please try again.'),
    );
  return data;
}
/**
 * Submit handler for a form. Unlike `<form action>`, which in React 19 clears every field once the action
 * returns (even when the server refused it), this keeps what the person typed. Reset explicitly on success.
 */
export const onForm =
  (fn: (data: FormData, form: HTMLFormElement) => unknown) => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void fn(new FormData(e.currentTarget), e.currentTarget);
  };
export const adminApi = (p: string) => `/api/admin/${p}`;
export const StaffLink = Link;
export function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <div role="alert" className="error">
      {error instanceof Error ? error.message : String(error)}
    </div>
  ) : null;
}
export function Skeleton() {
  return (
    <div className="skeleton" aria-label="Loading">
      <div />
      <div />
      <div />
    </div>
  );
}
export function Badge({ status }: { status: string }) {
  return <span className={'badge ' + status.toLowerCase()}>{status.replaceAll('_', ' ')}</span>;
}
export function Sheet({
  open,
  onOpenChange,
  title,
  description = 'Complete the details below to continue.',
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="sheet">
          <div className="sheet-handle" />
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description className="muted">{description}</Dialog.Description>
          {children}
          <Dialog.Close asChild>
            <Button variant="outline">Close</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
const hidden = (p: string) => ['/admin', '/driver', '/staff'].some((x) => p.startsWith(x));
function Logo({ site }: { site: SiteContent }) {
  return site.brand.logo ? (
    <img src={site.brand.logo} alt={site.brand.name} className="brand-logo" />
  ) : (
    <span className="brand-mark">
      <BusFront size={24} />
    </span>
  );
}
export function Header({ site }: { site: SiteContent }) {
  const path = usePathname();
  if (hidden(path)) return null;
  return (
    <>
      <header className={'header' + (path === '/' ? ' home-header' : '')}>
        <Link href="/" className="brand">
          <Logo site={site} />
          <span>
            {site.brand.name}
            <small>{site.brand.tagline.toUpperCase()}</small>
          </span>
        </Link>
        <nav>
          <Link href="/search">{site.copy.nav.findRide}</Link>
          <Link href="/track-booking" className="track-link">
            <Ticket size={17} />
            {site.copy.nav.track}
          </Link>
          <InstallApp />
        </nav>
      </header>
      <nav className="mobile-nav" aria-label="Main navigation">
        <Link href="/">
          <House size={20} />
          {site.copy.nav.home}
        </Link>
        <Link href="/search">
          <Search size={20} />
          {site.copy.nav.findRide}
        </Link>
        <Link href="/track-booking">
          <Ticket size={20} />
          {site.copy.nav.myBooking}
        </Link>
      </nav>
    </>
  );
}
export function Footer({ site }: { site: SiteContent }) {
  const path = usePathname();
  if (path.startsWith('/admin') || path.startsWith('/driver')) return null;
  const f = site.footer,
    t = site.copy.nav;
  return (
    <footer className="site-footer">
      <div className="site-footer-grid">
        <div>
          <Link href="/" className="brand">
            <Logo site={site} />
            <span>{site.brand.name}</span>
          </Link>
          <p>{f.about}</p>
        </div>
        <div>
          <h4>{t.footerTravel}</h4>
          <Link href="/search">{t.findRide}</Link>
          <Link href="/track-booking">{t.track}</Link>
          {f.links.map((l) => (
            <a key={l.label + l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </div>
        <div>
          <h4>{t.footerContact}</h4>
          {f.phone && <a href={'tel:' + f.phone}>{f.phone}</a>}
          {f.email && <a href={'mailto:' + f.email}>{f.email}</a>}
          {f.address && <span>{f.address}</span>}
        </div>
        <div>
          <h4>{t.footerApp}</h4>
          <InstallApp />
          {t.footerStaff && (t.staffSignIn || t.adminSignIn) && (
            <>
              <h4 style={{ marginTop: 16 }}>{t.footerStaff}</h4>
              {t.staffSignIn && (
                <Link className="footer-btn" href="/staff/sign-in?role=DRIVER">
                  <ShieldCheck size={15} /> {t.staffSignIn}
                </Link>
              )}
              {t.adminSignIn && (
                <Link className="footer-btn solid" href="/staff/sign-in?role=ADMIN">
                  <ShieldCheck size={15} /> {t.adminSignIn}
                </Link>
              )}
            </>
          )}
        </div>
      </div>
      <p className="copyright">
        &copy; {new Date().getFullYear()} {f.copyright}
      </p>
    </footer>
  );
}
/** Operator permissions for showing or hiding actions; null means every permission (platform admin). */
export function StaffShell({
  role,
  name,
  children,
}: {
  role: 'admin' | 'driver';
  name: string;
  children: React.ReactNode;
}) {
  const links =
    role === 'admin'
      ? [
          'dashboard',
          'drivers',
          'vehicles',
          'seat-layouts',
          'routes',
          'fares',
          'trips',
          'bookings',
          'payments',
          'payment-qr',
          'reports',
          'tickets',
          'website',
          'settings',
        ]
      : ['profile', 'vehicles', 'routes', 'payment', 'schedule', 'trips', 'bookings', 'passengers', 'history'];
  return (
    <div className="staff-shell">
      <aside>
        <Link className="brand" href={'/' + role}>
          <BusFront />
          SajiloYatra
        </Link>
        <p className="eyebrow">{role} workspace</p>
        <nav>
          {links.map((l) => (
            <Link key={l} href={'/' + role + '/' + l}>
              {l === 'schedule' ? 'publish route' : l.replaceAll('-', ' ')}
            </Link>
          ))}
        </nav>
        <small>{name}</small>
        <Button
          variant="outline"
          onClick={async () => {
            await api('/api/auth/logout', { method: 'POST', body: '{}' });
            location.href = '/staff/sign-in';
          }}
        >
          <LogOut size={16} />
          Sign out
        </Button>
      </aside>
      <div className="staff-content">
        {children}
      </div>
    </div>
  );
}
export function Empty({
  text = 'No records yet.',
  detail = 'Try another date or route, or check back later.',
  children,
}: {
  text?: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-art" aria-hidden="true">
        <BusFront size={34} strokeWidth={1.5} />
        <i />
      </span>
      <h3>{text}</h3>
      <p>{detail}</p>
      {children && <div className="empty-actions">{children}</div>}
    </div>
  );
}
/** Friendly "nothing here right now" state. A genuine connection failure gets a retry, not a dead end. */
export function Unavailable({
  error,
  retry,
  text = 'Not available currently',
  detail = 'This ride is not available right now. It may be sold out, closed or no longer running.',
}: {
  error?: unknown;
  retry?: () => void;
  text?: string;
  detail?: string;
}) {
  const offline = error instanceof Error && /unable to reach/i.test(error.message);
  return offline ? (
    <Empty text="Can’t connect right now" detail="Check your internet connection and try again.">
      {retry && <Button onClick={retry}>Try again</Button>}
    </Empty>
  ) : (
    <Empty text={text} detail={detail}>
      <Link href="/search" className="button">
        Find another ride
      </Link>
      <Link href="/" className="button outline">
        Back home
      </Link>
    </Empty>
  );
}
export { ArrowRight, ShieldCheck };
