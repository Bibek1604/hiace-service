import { SearchForm, TripResults } from '@/components/customer';
import { getSiteContent } from '@/lib/site-content-db';
export default async function Search({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { copy } = await getSiteContent();
  const raw = await searchParams,
    filters = Object.fromEntries(
      ['origin', 'destination', 'date'].map((k) => [k, typeof raw[k] === 'string' ? raw[k] : '']),
    ) as Record<string, string>;
  return (
    <main className="container">
      <p className="eyebrow">{copy.search.eyebrow}</p>
      <h1>{copy.search.title}</h1>
      <div className="search-card" style={{ marginBottom: 30 }}>
        <SearchForm initial={filters} />
      </div>
      <TripResults
        key={JSON.stringify(filters)}
        filters={new URLSearchParams(filters).toString()}
      />
    </main>
  );
}
