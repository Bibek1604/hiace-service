import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from './errors';

export type Classified = { status: number; message: string; retryAfter?: number; log: boolean };

const BUSY = 'The service is busy right now. Please try again in a moment.';
const UPDATING = 'This feature is being updated and is temporarily unavailable. Please try again shortly.';
const FALLBACK = 'We couldn’t complete that right now. Please try again in a moment. Your data is safe.';

/** Prisma codes that mean the database cannot be reached or is out of capacity, not that the request was wrong. */
const DB_DOWN = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1008', 'P1011', 'P1017', 'P2024']);
const BAD_VALUE = new Set(['P2000', 'P2005', 'P2006', 'P2007', 'P2008', 'P2009', 'P2011', 'P2012', 'P2013', 'P2019']);

/**
 * Turns any thrown value into a client-safe status and message. It never returns 500:
 * faults on our side are reported as 503 with a retry hint, and are logged (`log`) for follow-up.
 */
export function classifyError(error: unknown): Classified {
  if (error instanceof z.ZodError)
    return {
      status: 400,
      message: error.issues.map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; '),
      log: false,
    };
  if (error instanceof ApiError) {
    // A deliberate client-facing error keeps its status, except a stray 5xx which becomes a retryable 503.
    if (error.status >= 500) return { status: 503, message: error.message || FALLBACK, retryAfter: 10, log: true };
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
    if (DB_DOWN.has(c)) return { status: 503, message: BUSY, retryAfter: 5, log: true };
    // P2021 / P2022: the code is ahead of the database (a migration has not run yet).
    if (c === 'P2021' || c === 'P2022') return { status: 503, message: UPDATING, retryAfter: 60, log: true };
    return { status: 503, message: FALLBACK, retryAfter: 10, log: true };
  }
  if (error instanceof Prisma.PrismaClientValidationError)
    return { status: 400, message: 'The request contains invalid data. Check it and try again.', log: true };
  if (error instanceof Prisma.PrismaClientInitializationError || error instanceof Prisma.PrismaClientRustPanicError)
    return { status: 503, message: BUSY, retryAfter: 5, log: true };
  const name = error instanceof Error ? error.name : '';
  const msg = error instanceof Error ? error.message : '';
  if (name === 'NoSuchKey' || name === 'NotFound') return { status: 404, message: 'That file was not found.', log: false };
  if (/AccessDenied|InvalidAccessKey|SignatureDoesNotMatch|NoSuchBucket|Storage is not configured/i.test(name + msg))
    return { status: 503, message: 'File storage is temporarily unavailable. Please try again later.', retryAfter: 60, log: true };
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|timeout/i.test(name + msg))
    return { status: 503, message: BUSY, retryAfter: 5, log: true };
  return { status: 503, message: FALLBACK, retryAfter: 10, log: true };
}

/** One-line, PII-free description for server logs. */
export function describeError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.name + ':' + error.code;
  if (error instanceof Error) return error.name + ': ' + error.message.split('\n').find((l) => l.trim())?.slice(0, 200);
  return 'UnknownError';
}
