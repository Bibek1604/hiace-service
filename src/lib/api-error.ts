import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from './errors';

export type Classified = { status: number; message: string; retryAfter?: number; log: boolean };
/** The request being handled, so a failure can say what could not be done. */
export type RequestContext = { method: string; path: string[] };

/** Prisma codes that mean the database cannot be reached or is out of capacity, not that the request was wrong. */
const DB_DOWN = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1011', 'P1017', 'P2024']);
const BAD_VALUE = new Set(['P2000', 'P2005', 'P2006', 'P2007', 'P2008', 'P2009', 'P2011', 'P2012', 'P2013', 'P2019']);

/** Actions with their own wording, matched against "METHOD /path". The first match wins. */
const ACTIONS: [RegExp, string][] = [
  [/^POST \/auth\/login/, 'sign you in'],
  [/^POST \/auth\/logout/, 'sign you out'],
  [/\/uploads$/, 'upload your image'],
  [/^GET \/images\//, 'load this image'],
  [/^POST \/bookings\/[^/]+\/proof/, 'submit your payment proof'],
  [/^POST \/bookings\/[^/]+\/clarification/, 'send your message'],
  [/\/ticket$/, 'get this ticket'],
  [/^GET \/bookings\/[^/]+\/history/, 'load your booking history'],
  [/^GET \/bookings\//, 'load your booking'],
  [/^POST \/bookings$/, 'reserve your seats'],
  [/^POST \/track\/request/, 'send your verification code'],
  [/^POST \/track\/verify/, 'check your verification code'],
  [/^GET \/trips\//, 'load this ride'],
  [/^GET \/trips$/, 'search for rides'],
  [/^GET \/locations/, 'load the list of places'],
  [/\/bookings\/[^/]+\/cancel$/, 'cancel this booking'],
  [/\/bookings\/[^/]+\/refund$/, 'update this refund'],
  [/\/trips\/[^/]+\/cancel$/, 'cancel this ride'],
  [/\/trips\/[^/]+\/manifest$/, 'prepare the passenger list'],
  [/\/trips\/[^/]+\/availability$/, 'load seat availability'],
  [/^POST \/(admin|driver)\/payments\//, 'review this payment'],
  [/\/manual-bookings$/, 'save this booking'],
  [/\/validate-ticket$/, 'check this ticket'],
  [/\/check-in$/, 'check in this passenger'],
  [/^POST \/driver\/password/, 'change your password'],
  [/^GET \/driver\/profile/, 'load your profile'],
  [/\/driver\/profile/, 'save your profile'],
  [/\/trip-seats\//, 'update this seat'],
];
const LABELS: Record<string, [plural: string, one: string]> = {
  'payment-qr': ['the payment QR codes', 'this payment QR code'],
  'site-content': ['the site content', 'the site content'],
  dashboard: ['the dashboard', 'the dashboard'],
  fleet: ['your fleet', 'your fleet'],
  history: ['the history', 'the history'],
};
function resourceLabel(name: string): [string, string] {
  if (LABELS[name]) return LABELS[name];
  const words = name.replace(/-/g, ' ');
  return ['the ' + words, 'this ' + words.replace(/s$/, '')];
}

/** Plain words for what the request was doing, used as "We couldn't <action> right now". */
export function actionFor({ method, path }: RequestContext) {
  const request = method + ' /' + path.join('/');
  const known = ACTIONS.find(([pattern]) => pattern.test(request));
  if (known) return known[1];
  if ((path[0] === 'admin' || path[0] === 'driver') && path[1]) {
    const [plural, one] = resourceLabel(path[1] === 'resources' && path[2] ? path[2] : path[1]);
    if (method === 'GET') return 'load ' + plural;
    return (method === 'DELETE' ? 'delete ' : 'save ') + one;
  }
  return 'complete that';
}

const WORDS: Record<string, string> = {
  email: 'email address',
  contactEmail: 'contact email address',
  phone: 'phone number',
  mobile: 'mobile number',
  tripId: 'ride',
  tripSeatId: 'seat',
  fromLocationId: 'departure place',
  toLocationId: 'destination',
  dropPointId: 'drop-off point',
  dropPoint: 'drop-off point',
  paymentQRId: 'payment QR code',
  transactionRef: 'transaction reference',
  licenseExpiry: 'license expiry date',
  seatLabels: 'seats',
  imageKeys: 'images',
  photoKey: 'photo',
};
const labelFor = (key: string) =>
  WORDS[key] ??
  key
    .replace(/Id$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Zod's own wording. Anything else was written for people in the schema, so it is shown unchanged. */
const ZOD_DEFAULT = /^(Too (small|big): expected|Invalid (input|option|email address|UUID|URL|string|date|ISO|format)|Unrecognized key)/;

function friendlyIssue(issue: z.core.$ZodIssue) {
  if (!ZOD_DEFAULT.test(issue.message)) return issue.message;
  const key = [...issue.path].reverse().find((part) => typeof part === 'string');
  if (typeof key !== 'string') return 'Please check the details and try again.';
  const label = labelFor(key),
    Label = capitalize(label);
  const missing = /received (undefined|null)/.test(issue.message);
  if (issue.code === 'too_small') {
    const min = Number(issue.minimum);
    if (issue.origin === 'string')
      return min <= 1 ? `Please enter the ${label}.` : `${Label} must be at least ${min} characters.`;
    if (issue.origin === 'array' || issue.origin === 'set')
      return min <= 1 ? `Please add at least one ${label.replace(/s$/, '')}.` : `Please add at least ${min} ${label}.`;
    return `${Label} must be ${issue.inclusive === false ? 'more than' : 'at least'} ${min}.`;
  }
  if (issue.code === 'too_big') {
    const max = Number(issue.maximum);
    if (issue.origin === 'string') return `${Label} must be ${max} characters or fewer.`;
    if (issue.origin === 'array' || issue.origin === 'set') return `Please choose no more than ${max} ${label}.`;
    return `${Label} must be ${issue.inclusive === false ? 'less than' : 'no more than'} ${max}.`;
  }
  if (issue.code === 'invalid_format' && issue.format === 'email') return 'Please enter a valid email address.';
  if (issue.code === 'invalid_value') return `Please choose a valid ${label}.`;
  if (missing) return (/Id$/.test(key) ? 'Please choose the ' : 'Please enter the ') + label + '.';
  return `Please check the ${label}.`;
}

/** Every distinct problem with a form, in plain sentences. Long lists stop at three so the message stays readable. */
export function friendlyValidation(error: z.ZodError) {
  return [...new Set(error.issues.map(friendlyIssue))].slice(0, 3).join(' ');
}

const STORAGE_FAULT =
  /AccessDenied|InvalidAccessKey|SignatureDoesNotMatch|NoSuchBucket|Storage is not configured|CredentialsProviderError|Could not load credentials|EROFS|EACCES|ENOSPC/i;

/**
 * Turns any thrown value into a client-safe status and message. It never returns 500:
 * faults on our side are reported as 503 with a retry hint, and are logged (`log`) for follow-up.
 * With a request context, failures name the action that could not be completed.
 */
export function classifyError(error: unknown, context?: RequestContext): Classified {
  const action = context ? actionFor(context) : 'complete that';
  const busy = `The service is busy, so we couldn’t ${action}. Please try again in a moment.`;
  const updating = `We’re updating this part of the service, so we couldn’t ${action}. Please try again shortly.`;
  const fallback = `We couldn’t ${action} right now. Please try again in a moment. Your data is safe.`;
  if (error instanceof z.ZodError) return { status: 400, message: friendlyValidation(error), log: false };
  if (error instanceof ApiError) {
    // A deliberate client-facing error keeps its status, except a stray 5xx which becomes a retryable 503.
    if (error.status >= 500) return { status: 503, message: error.message || fallback, retryAfter: 10, log: true };
    return { status: error.status, message: error.message, log: false };
  }
  if (error instanceof SyntaxError) return { status: 400, message: 'The request could not be read. Check the data and try again.', log: false };
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const c = error.code;
    if (c === 'P2002') return { status: 409, message: 'This already exists or is already reserved. Refresh and try again.', log: false };
    if (c === 'P2003' || c === 'P2004' || c === 'P2014')
      return { status: 409, message: 'This is linked to other records and cannot be changed that way.', log: false };
    if (c === 'P2025' || c === 'P2001' || c === 'P2015' || c === 'P2018')
      return { status: 404, message: 'That record was not found. It may have been removed.', log: false };
    if (c === 'P2034') return { status: 409, message: 'Someone else changed this at the same moment. Please retry.', log: false };
    if (BAD_VALUE.has(c)) return { status: 400, message: 'One of the values is not valid. Check the form and try again.', log: false };
    if (DB_DOWN.has(c)) return { status: 503, message: busy, retryAfter: 5, log: true };
    // P2021 / P2022: the code is ahead of the database (a migration has not run yet).
    if (c === 'P2021' || c === 'P2022') return { status: 503, message: updating, retryAfter: 60, log: true };
    return { status: 503, message: fallback, retryAfter: 10, log: true };
  }
  if (error instanceof Prisma.PrismaClientValidationError)
    return { status: 400, message: 'The request contains invalid data. Check it and try again.', log: true };
  if (error instanceof Prisma.PrismaClientInitializationError || error instanceof Prisma.PrismaClientRustPanicError)
    return { status: 503, message: busy, retryAfter: 5, log: true };
  const name = error instanceof Error ? error.name : '';
  const msg = error instanceof Error ? error.message : '';
  if (name === 'NoSuchKey' || name === 'NotFound')
    return { status: 404, message: 'We couldn’t find that file. It may have been removed.', log: false };
  // Every error returned by the S3 service carries $metadata, so an unexpected refusal lands here too.
  if (STORAGE_FAULT.test(name + ' ' + msg) || (error instanceof Error && '$metadata' in error)) {
    const next =
      context?.path[0] === 'admin'
        ? 'Check the image storage settings, then try again.'
        : context?.path[0] === 'driver'
          ? 'Please try again shortly or contact the admin.'
          : 'Please try again shortly or contact the driver.';
    return { status: 503, message: `Image storage isn’t available, so we couldn’t ${action}. ${next}`, retryAfter: 60, log: true };
  }
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|timeout/i.test(name + msg))
    return { status: 503, message: busy, retryAfter: 5, log: true };
  return { status: 503, message: fallback, retryAfter: 10, log: true };
}

/** One-line, PII-free description for server logs. */
export function describeError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const model = typeof error.meta?.modelName === 'string' ? ':model=' + error.meta.modelName : '';
    return error.name + ':' + error.code + model;
  }
  if (error instanceof Error) return error.name + ': ' + error.message.split('\n').find((l) => l.trim())?.slice(0, 200);
  return 'UnknownError';
}
