import Link from 'next/link';
import { BusFront, ShieldCheck, Armchair, ArrowRight, MapPin, Route, CalendarDays, CreditCard, CheckCircle2 } from 'lucide-react';
import { SearchForm, TripResults } from '@/components/customer';
import { getSiteContent } from '@/lib/site-content-db';
export const dynamic = 'force-dynamic';
const icons = [Armchair, ShieldCheck, BusFront, Route];
export default async function Home() {
  const { hero, search, benefits, departures, track, copy } = await getSiteContent();
  const photos = hero.photos.filter((p) => p.src);
  return (
    <>
      <section className="hero">
        {/* Decorative road drawn in CSS; photos come only from the admin's own uploads. */}
        <div className="hero-road" aria-hidden="true">
          <span className="hero-sun" />
          <span className="hero-bus">
            <BusFront size={26} />
          </span>
        </div>
        <div className="hero-inner">
          <span className="hero-tag">
            <MapPin size={12} /> {hero.tag.toUpperCase()}
          </span>
          <h1>
            {hero.title}
            <br />
            <span className="blue">{hero.highlight}</span>
          </h1>
          <p>{hero.subtitle}</p>
          <div className="hero-actions">
            <Link href="/search" className="button">
              {copy.nav.findRide} <ArrowRight size={17} />
            </Link>
            <Link href="/track-booking" className="button outline">
              <TicketIcon /> {copy.nav.track}
            </Link>
          </div>
        </div>
        {photos.length > 0 && (
          <div className="hero-photos" aria-label="Featured places">
            {photos.map((p, i) => (
              <figure
                key={p.src + i}
                style={{ ['--tilt' as string]: `${(i % 2 ? 1 : -1) * (2 + i)}deg` }}
              >
                <img src={p.src} alt={p.caption || 'Featured destination'} loading="lazy" />
                {p.caption && <figcaption>{p.caption}</figcaption>}
              </figure>
            ))}
          </div>
        )}
      </section>
      <div className="search-wrap" id="find-trip">
        <div className="search-card">
          <p className="eyebrow">PLAN YOUR JOURNEY</p>
          <h2 className="display">{search.heading}</h2>
          <SearchForm />
        </div>
      </div>
      <main className="container">
        <section className="journey-steps" aria-labelledby="journey-steps-title">
          <div className="section-title">
            <div>
              <p className="eyebrow">SIMPLE BOOKING</p>
              <h2 className="display" id="journey-steps-title">Book your seat in three clear steps</h2>
            </div>
          </div>
          <div className="journey-step-grid">
            <div className="journey-step"><span className="step-number">1</span><MapPin size={22} /><h3>Choose your route</h3><p>Search your departure, destination, and travel date.</p></div>
            <div className="journey-step"><span className="step-number">2</span><CalendarDays size={22} /><h3>Select a departure</h3><p>Compare available trips, timings, and seats before you continue.</p></div>
            <div className="journey-step"><span className="step-number">3</span><CreditCard size={22} /><h3>Pay and travel</h3><p>Pay by QR, upload the proof, and keep your ticket ready.</p></div>
          </div>
        </section>
        <div className="benefits">
          {benefits
            .filter((b) => b.title)
            .map((b, i) => {
              const Icon = icons[i % icons.length];
              return (
                <div className="benefit" key={b.title}>
                  <span className="icon-tile">
                    <Icon size={23} />
                  </span>
                  <div>
                    <h3>{b.title}</h3>
                    <p>{b.text}</p>
                  </div>
                </div>
              );
            })}
        </div>
        <section>
          <div className="section-title">
            <div>
              <p className="eyebrow">{departures.eyebrow.toUpperCase()}</p>
              <h2 className="display">{departures.heading}</h2>
              <p className="muted">{departures.text}</p>
            </div>
            <Link href="/search" className="blue row">
              {copy.home.allRides} <ArrowRight size={16} />
            </Link>
          </div>
          <TripResults home />
        </section>
        <div className="notice" style={{ marginTop: 40, padding: 25 }}>
          <div className="row">
            <ShieldCheck size={26} />
            <div>
              <strong>{track.title}</strong>
              <p style={{ margin: '4px 0' }}>{track.text}</p>
              <Link className="blue" href="/track-booking">
                {copy.home.trackLink}
              </Link>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

function TicketIcon() {
  return <CheckCircle2 size={17} />;
}
