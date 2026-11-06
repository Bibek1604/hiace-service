'use client';

// Last resort when the root layout itself fails. It must render its own <html> and avoid app styles.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', display: 'grid', placeItems: 'center', minHeight: '100vh', margin: 0, background: '#f4f7fc', color: '#123b75' }}>
        <main style={{ textAlign: 'center', padding: 24, maxWidth: 420 }}>
          <h1>Service temporarily unavailable</h1>
          <p>We couldn’t load the site just now. Your bookings are safe. Please try again.</p>
          <button onClick={reset} style={{ minHeight: 44, padding: '0 22px', borderRadius: 12, border: 0, background: '#2563eb', color: 'white', fontSize: 15 }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
