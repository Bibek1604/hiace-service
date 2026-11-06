import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSiteContent, parseSiteContent, siteContentSchema } from '../src/lib/site-content';

test('site content has complete defaults and falls back when stored data is corrupt', () => {
  const d = defaultSiteContent();
  assert.equal(d.brand.name, 'Sajilo Yatra');
  assert.equal(d.benefits.length, 3);
  assert.deepEqual(parseSiteContent({ hero: { photos: 'bad' } }), d);
  assert.equal(parseSiteContent({ brand: { name: 'Yatra Nepal' } }).brand.name, 'Yatra Nepal');
});

test('passenger copy talks about drivers, never operators', () => {
  assert.doesNotMatch(JSON.stringify(defaultSiteContent()), /operator/i);
});

test('site content rejects script-capable image and link values', () => {
  assert.throws(() => siteContentSchema.parse({ brand: { logo: 'javascript:alert(1)' } }));
  assert.throws(() => siteContentSchema.parse({ brand: { logo: 'http://insecure.example/a.png' } }));
  assert.throws(() => siteContentSchema.parse({ footer: { links: [{ label: 'x', href: 'javascript:alert(1)' }] } }));
  assert.throws(() => siteContentSchema.parse({ footer: { links: [{ label: 'x', href: '//evil.example' }] } }));
  assert.throws(() => siteContentSchema.parse({ theme: { primary: 'red;} body{display:none' } }));
  assert.ok(siteContentSchema.parse({ brand: { logo: '/api/images/abc-123' }, footer: { links: [{ label: 'Terms', href: '/terms' }] } }));
});

test('every public text label has a default and stored edits merge over the defaults', async () => {
  const { COPY, defaultSiteContent, parseSiteContent, siteContentSchema } = await import('../src/lib/site-content');
  const d = defaultSiteContent();
  for (const [group, spec] of Object.entries(COPY))
    for (const [key, v] of Object.entries(spec)) {
      if (key === '_title') continue;
      assert.equal((d.copy as Record<string, Record<string, string>>)[group][key], (v as readonly string[])[0], group + '.' + key);
    }
  const edited = parseSiteContent({ copy: { search: { title: '  Ghumna jaau  ' }, unknown: { x: 'y' } } });
  assert.equal(edited.copy.search.title, 'Ghumna jaau');
  assert.equal(edited.copy.search.eyebrow, COPY.search.eyebrow[0], 'untouched labels keep their default');
  assert.ok(!('unknown' in edited.copy), 'unknown groups are dropped');
  assert.equal(parseSiteContent({ copy: { nav: { staffSignIn: '' } } }).copy.nav.staffSignIn, '', 'empty is kept so links can be hidden');
  assert.throws(() => siteContentSchema.parse({ copy: { nav: { home: 'x'.repeat(401) } } }));
});
