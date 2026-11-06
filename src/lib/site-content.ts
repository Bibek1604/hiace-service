import { z } from 'zod';

const text = (max: number, fallback: string) => z.string().trim().max(max).default(fallback);
/** Image reference: an uploaded image path or an https URL; empty means "none". */
const image = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^(\/api\/images\/[\w-]+|https:\/\/[^\s]+)$/.test(v), 'Use an upload or an https URL.')
  .default('');
const href = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^(\/(?!\/)|https:\/\/|mailto:|tel:)/.test(v), 'Link must start with /, https://, mailto: or tel:');

/**
 * Every other piece of wording on the public site, grouped by page. Each entry is [default, label for the editor].
 * Adding an entry here makes it editable in Admin → Website with no other change.
 */
export const COPY = {
  seo: {
    _title: 'Search engines and app',
    title: ['Sajilo Yatra — Nepal, one journey at a time', 'Browser tab and search title'],
    description: ['Find your next ride across Nepal. Choose your seat, pay by QR, and track your booking securely.', 'Search engine description'],
    appDescription: ['Book bus, microbus and jeep seats across Nepal.', 'Installed app description'],
  },
  nav: {
    _title: 'Header, menu and footer',
    findRide: ['Find a ride', 'Find-a-ride link'],
    track: ['Track booking', 'Track-booking link'],
    home: ['Home', 'Mobile menu: home'],
    myBooking: ['My booking', 'Mobile menu: my booking'],
    footerTravel: ['Travel', 'Footer column: travel'],
    footerContact: ['Contact', 'Footer column: contact'],
    footerApp: ['Get the app', 'Footer column: app'],
    footerStaff: ['Sign in', 'Footer column: sign-in links (empty hides them)'],
    staffSignIn: ['Driver sign in', 'Driver sign-in button (empty hides it)'],
    adminSignIn: ['Admin sign in', 'Admin sign-in button (empty hides it)'],
  },
  home: {
    _title: 'Home page links',
    allRides: ['All rides', 'Link to all rides'],
    trackLink: ['Track your booking →', 'Link under the track-booking box'],
  },
  search: {
    _title: 'Search and results',
    eyebrow: ['FIND YOUR NEXT RIDE', 'Search page small heading'],
    title: ['Good journeys start here.', 'Search page title'],
    from: ['Your starting point', 'From field placeholder'],
    to: ['Where are you going?', 'To field placeholder'],
    fromSheet: ['Where are you leaving from?', 'From picker title'],
    toSheet: ['Where are you heading?', 'To picker title'],
    button: ['Find a ride', 'Search button'],
    perSeat: ['/ seat', 'Price suffix'],
    emptyTitle: ['Not available currently', 'No rides: title'],
    emptyHome: ['No buses, microbuses or jeeps are scheduled at the moment. Please check back soon.', 'No rides on the home page'],
    emptySearch: ['No buses, microbuses or jeeps are running for this route and date. Try another day or a nearby place.', 'No rides for a search'],
    errorTitle: ['Can’t load rides right now', 'Rides failed to load: title'],
    errorText: ['Please try again in a moment.', 'Rides failed to load: text'],
  },
  trip: {
    _title: 'Trip and seat selection',
    seatHeading: ['Pick your favourite seat', 'Seat map heading'],
    front: ['FRONT / DRIVER', 'Front-of-vehicle marker'],
    selectSeats: ['Select seats to continue', 'Prompt before seats are chosen'],
    travellerSheet: ['Who’s travelling?', 'Passenger details title'],
    holdButton: ['Hold seats & view payment QR', 'Book button'],
    holding: ['Reserving your seats…', 'Book button while saving'],
    driverPending: ['Assigned before departure', 'Driver not yet assigned'],
  },
  booking: {
    _title: 'Booking, payment and ticket',
    eyebrow: ['YOUR JOURNEY, ALL IN ONE PLACE', 'Small heading'],
    readyTitle: ['You’re ready to travel', 'Confirmed booking title'],
    statusTitle: ['Your booking status', 'Booking status title'],
    completeTitle: ['Complete your booking', 'Unpaid booking title'],
    payHeading: ['Pay securely by QR', 'Payment heading'],
    proofHeading: ['Upload your payment proof', 'Payment proof heading'],
    proofButton: ['Submit for verification', 'Payment proof button'],
    proofSubmitted: ['Payment proof submitted. Your booking is awaiting verification.', 'After proof is sent'],
    ticketHeading: ['Confirmed travel ticket', 'Ticket heading'],
    messageHeading: ['Message the driver', 'Message box heading'],
    accessTitle: ['Access your booking', 'Booking needs verification: title'],
    accessButton: ['Verify phone & retrieve booking', 'Booking needs verification: button'],
  },
  track: {
    _title: 'Track booking page',
    eyebrow: ['NO ACCOUNT NEEDED', 'Small heading'],
    title: ['Find your booking', 'Title'],
    intro: ['Your travel details stay private. Verify your phone to view them.', 'Introduction'],
    sendCode: ['Send verification code', 'Send-code button'],
    verify: ['Verify & view booking', 'Verify button'],
  },
  notFound: {
    _title: 'Page not found',
    title: ['Page not found', 'Title'],
    text: ['This page isn’t available. Let’s get you back on the road.', 'Text'],
  },
} as const;
type CopySpec = typeof COPY;
export type Copy = { [G in keyof CopySpec]: { [K in Exclude<keyof CopySpec[G], '_title'>]: string } };
const copyDefaults = () =>
  Object.fromEntries(
    Object.entries(COPY).map(([g, fields]) => [
      g,
      Object.fromEntries(Object.entries(fields).filter(([k]) => k !== '_title').map(([k, v]) => [k, (v as readonly string[])[0]])),
    ]),
  ) as Copy;
// Each group merges stored text over the defaults, so text added in a later release appears without a migration.
const copySchema = z
  .record(z.string(), z.record(z.string(), z.string().max(400)))
  .transform((stored) => {
    const out = copyDefaults();
    for (const [g, fields] of Object.entries(out) as [keyof Copy, Record<string, string>][])
      for (const k of Object.keys(fields)) {
        const v = stored[g]?.[k];
        if (typeof v === 'string') fields[k] = v.trim();
      }
    return out;
  })
  .prefault({});

export const siteContentSchema = z.object({
  copy: copySchema,
  brand: z
    .object({
      name: text(40, 'Sajilo Yatra'),
      tagline: text(80, 'Nepal, one journey at a time'),
      logo: image,
    })
    .default({ name: 'Sajilo Yatra', tagline: 'Nepal, one journey at a time', logo: '' }),
  theme: z
    .object({ primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563eb'), dark: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#123b75') })
    .default({ primary: '#2563eb', dark: '#123b75' }),
  hero: z
    .object({
      tag: text(60, 'Made for journeys across Nepal'),
      title: text(60, 'Your next journey.'),
      highlight: text(60, 'A little more sajilo.'),
      subtitle: text(240, 'Find your ride, choose your seat, and travel with peace of mind. From city streets to mountain roads.'),
      photos: z.array(z.object({ src: image, caption: text(40, '') })).max(5).default([]),
    })
    .default({ tag: 'Made for journeys across Nepal', title: 'Your next journey.', highlight: 'A little more sajilo.', subtitle: 'Find your ride, choose your seat, and travel with peace of mind. From city streets to mountain roads.', photos: [] }),
  search: z.object({ heading: text(80, 'Where will the road take you?') }).default({ heading: 'Where will the road take you?' }),
  benefits: z
    .array(z.object({ title: text(60, ''), text: text(140, '') }))
    .max(4)
    .default([
      { title: 'Your seat, your choice', text: 'Pick from live seat availability before you book.' },
      { title: 'Pay by QR, travel with confidence', text: 'Every payment is checked by the driver.' },
      { title: 'Book in a few simple steps', text: 'No account needed. Just your journey ahead.' },
    ]),
  departures: z
    .object({ eyebrow: text(40, "Let's get you moving"), heading: text(60, 'Upcoming departures'), text: text(140, 'Find a comfortable ride for your next adventure.') })
    .default({ eyebrow: "Let's get you moving", heading: 'Upcoming departures', text: 'Find a comfortable ride for your next adventure.' }),
  track: z
    .object({ title: text(60, 'Already booked your journey?'), text: text(160, 'Keep an eye on payment verification and find your travel details.') })
    .default({ title: 'Already booked your journey?', text: 'Keep an eye on payment verification and find your travel details.' }),
  footer: z
    .object({
      about: text(240, 'Book seats on buses, microbuses and jeeps across Nepal. No account needed.'),
      phone: text(40, ''),
      email: text(100, ''),
      address: text(120, ''),
      copyright: text(100, 'Sajilo Yatra. All rights reserved.'),
      links: z.array(z.object({ label: z.string().trim().min(1).max(30), href })).max(6).default([]),
    })
    .default({ about: 'Book seats on buses, microbuses and jeeps across Nepal. No account needed.', phone: '', email: '', address: '', copyright: 'Sajilo Yatra. All rights reserved.', links: [] }),
});
export type SiteContent = z.infer<typeof siteContentSchema>;
/** Defaults for every field; stored values are validated and merged over these. */
export const defaultSiteContent = (): SiteContent => siteContentSchema.parse({});
export function parseSiteContent(stored: unknown): SiteContent {
  const r = siteContentSchema.safeParse(stored ?? {});
  return r.success ? r.data : defaultSiteContent();
}
