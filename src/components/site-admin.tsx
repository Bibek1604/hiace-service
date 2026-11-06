'use client';
import { useEffect, useState } from 'react';
import { ImagePlus, Save, Plus, Trash2, RotateCcw } from 'lucide-react';
import { api, ErrorBox, Skeleton } from './common';
import { Button } from './ui/button';
import { COPY, type Copy, type SiteContent } from '@/lib/site-content';

/** Image input: upload to private-bucket storage (served publicly by random id) or paste an https URL. */
function ImageField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  async function pick(file?: File) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('image', file);
      form.set('purpose', 'site');
      const o = await api<{ id: string }>('/api/admin/uploads', { method: 'POST', body: form });
      onChange('/api/images/' + o.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <label>
        {label}
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Upload, or paste an https:// image link" />
      </label>
      <div className="row">
        <label className="btn-like">
          <ImagePlus size={16} /> {busy ? 'Uploading…' : 'Upload image'}
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {value && (
          <img src={value} alt="" style={{ height: 44, borderRadius: 8, border: '1px solid var(--line)' }} />
        )}
        {value && (
          <Button type="button" variant="outline" onClick={() => onChange('')}>
            Remove
          </Button>
        )}
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

function Field({ label, value, onChange, area }: { label: string; value: string; onChange: (v: string) => void; area?: boolean }) {
  return (
    <label>
      {label}
      {area ? <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} /> : <input value={value} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

export function SiteContentAdmin() {
  const [c, setC] = useState<SiteContent | null>(null),
    [error, setError] = useState<unknown>(null),
    [saved, setSaved] = useState(false),
    [pending, setPending] = useState(false);
  useEffect(() => {
    api<SiteContent>('/api/admin/site-content').then(setC, setError);
  }, []);
  if (!c)
    return (
      <main className="container">
        <ErrorBox error={error} />
        {!error && <Skeleton />}
      </main>
    );
  const set = (fn: (d: SiteContent) => void) => {
    const d = structuredClone(c);
    fn(d);
    setC(d);
    setSaved(false);
  };
  async function save() {
    setPending(true);
    setError(null);
    try {
      setC(await api<SiteContent>('/api/admin/site-content', { method: 'PATCH', body: JSON.stringify(c) }));
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="stack" style={{ padding: 24, maxWidth: 860 }}>
      <h1 className="display">Website content</h1>
      <p className="muted">Everything visitors read or see on the public site. Changes appear on save.</p>

      <section className="card stack">
        <h2>Brand</h2>
        <Field label="Site name" value={c.brand.name} onChange={(v) => set((d) => void (d.brand.name = v))} />
        <Field label="Tagline" value={c.brand.tagline} onChange={(v) => set((d) => void (d.brand.tagline = v))} />
        <ImageField label="Logo" value={c.brand.logo} onChange={(v) => set((d) => void (d.brand.logo = v))} />
        <div className="row">
          <label>
            Main colour
            <input type="color" value={c.theme.primary} onChange={(e) => set((d) => void (d.theme.primary = e.target.value))} />
          </label>
          <label>
            Dark colour
            <input type="color" value={c.theme.dark} onChange={(e) => set((d) => void (d.theme.dark = e.target.value))} />
          </label>
        </div>
      </section>

      <section className="card stack">
        <h2>Home banner</h2>
        <Field label="Small tag" value={c.hero.tag} onChange={(v) => set((d) => void (d.hero.tag = v))} />
        <Field label="Headline" value={c.hero.title} onChange={(v) => set((d) => void (d.hero.title = v))} />
        <Field label="Highlighted line" value={c.hero.highlight} onChange={(v) => set((d) => void (d.hero.highlight = v))} />
        <Field area label="Subtitle" value={c.hero.subtitle} onChange={(v) => set((d) => void (d.hero.subtitle = v))} />
        <h3>Photo cards (up to 5)</h3>
        {c.hero.photos.map((p, i) => (
          <div key={i} className="card stack">
            <ImageField label={`Photo ${i + 1}`} value={p.src} onChange={(v) => set((d) => void (d.hero.photos[i].src = v))} />
            <Field label="Caption" value={p.caption} onChange={(v) => set((d) => void (d.hero.photos[i].caption = v))} />
            <Button type="button" variant="outline" onClick={() => set((d) => void d.hero.photos.splice(i, 1))}>
              <Trash2 size={15} /> Remove photo
            </Button>
          </div>
        ))}
        {c.hero.photos.length < 5 && (
          <Button type="button" variant="outline" onClick={() => set((d) => void d.hero.photos.push({ src: '', caption: '' }))}>
            <Plus size={15} /> Add photo
          </Button>
        )}
      </section>

      <section className="card stack">
        <h2>Search, highlights and sections</h2>
        <Field label="Search heading" value={c.search.heading} onChange={(v) => set((d) => void (d.search.heading = v))} />
        {c.benefits.map((b, i) => (
          <div key={i} className="stack">
            <Field label={`Highlight ${i + 1} title`} value={b.title} onChange={(v) => set((d) => void (d.benefits[i].title = v))} />
            <Field label="Text" value={b.text} onChange={(v) => set((d) => void (d.benefits[i].text = v))} />
          </div>
        ))}
        <Field label="Departures eyebrow" value={c.departures.eyebrow} onChange={(v) => set((d) => void (d.departures.eyebrow = v))} />
        <Field label="Departures heading" value={c.departures.heading} onChange={(v) => set((d) => void (d.departures.heading = v))} />
        <Field label="Departures text" value={c.departures.text} onChange={(v) => set((d) => void (d.departures.text = v))} />
        <Field label="Track-booking title" value={c.track.title} onChange={(v) => set((d) => void (d.track.title = v))} />
        <Field label="Track-booking text" value={c.track.text} onChange={(v) => set((d) => void (d.track.text = v))} />
      </section>

      <section className="card stack">
        <h2>Footer</h2>
        <Field area label="About text" value={c.footer.about} onChange={(v) => set((d) => void (d.footer.about = v))} />
        <Field label="Phone" value={c.footer.phone} onChange={(v) => set((d) => void (d.footer.phone = v))} />
        <Field label="Email" value={c.footer.email} onChange={(v) => set((d) => void (d.footer.email = v))} />
        <Field label="Address" value={c.footer.address} onChange={(v) => set((d) => void (d.footer.address = v))} />
        <Field label="Copyright line" value={c.footer.copyright} onChange={(v) => set((d) => void (d.footer.copyright = v))} />
        <h3>Extra links (up to 6)</h3>
        {c.footer.links.map((l, i) => (
          <div key={i} className="row">
            <input aria-label="Label" placeholder="Label" value={l.label} onChange={(e) => set((d) => void (d.footer.links[i].label = e.target.value))} />
            <input aria-label="Link" placeholder="/page or https://…" value={l.href} onChange={(e) => set((d) => void (d.footer.links[i].href = e.target.value))} />
            <Button type="button" variant="outline" onClick={() => set((d) => void d.footer.links.splice(i, 1))}>
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
        {c.footer.links.length < 6 && (
          <Button type="button" variant="outline" onClick={() => set((d) => void d.footer.links.push({ label: '', href: '/' }))}>
            <Plus size={15} /> Add link
          </Button>
        )}
      </section>

      <section className="card stack">
        <h2>Text and labels</h2>
        <p className="muted" style={{ margin: 0 }}>
          Every other word on the public site: buttons, headings, menus and messages. Leave a field as it is to keep the
          default shown underneath it.
        </p>
        {(Object.keys(COPY) as (keyof Copy)[]).map((group) => {
          const spec = COPY[group] as unknown as Record<string, string | readonly [string, string]>;
          return (
            <details key={group}>
              <summary>{spec._title as string}</summary>
              <div className="stack" style={{ paddingTop: 10 }}>
                {Object.entries(spec)
                  .filter(([k]) => k !== '_title')
                  .map(([k, v]) => {
                    const [fallback, label] = v as readonly [string, string];
                    const value = (c.copy[group] as Record<string, string>)[k] ?? '';
                    return (
                      <label key={k}>
                        {label}
                        {fallback.length > 70 ? (
                          <textarea rows={2} maxLength={400} value={value} onChange={(e) => set((d) => void ((d.copy[group] as Record<string, string>)[k] = e.target.value))} />
                        ) : (
                          <input maxLength={400} value={value} onChange={(e) => set((d) => void ((d.copy[group] as Record<string, string>)[k] = e.target.value))} />
                        )}
                        {value !== fallback && (
                          <small className="muted">
                            Default: “{fallback}”{' '}
                            <button type="button" className="link-button" onClick={() => set((d) => void ((d.copy[group] as Record<string, string>)[k] = fallback))}>
                              <RotateCcw size={11} /> restore
                            </button>
                          </small>
                        )}
                      </label>
                    );
                  })}
              </div>
            </details>
          );
        })}
      </section>

      <ErrorBox error={error} />
      {saved && <div className="notice success">Saved. The public site now shows these changes.</div>}
      <Button onClick={save} disabled={pending}>
        <Save size={16} /> {pending ? 'Saving…' : 'Save website content'}
      </Button>
    </main>
  );
}
