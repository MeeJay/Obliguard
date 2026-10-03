import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Machine-readable error code (lowerCamel), echoed as `code` in the body when set. */
    public code?: string,
    /** Values of the placeholders of the translated message (utils/errorCodes.ts), echoed as `params`. */
    public params?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Generic error codes set by this handler (UPPER_SNAKE, unlike the domain
 * codes of AppError): the client can tell "the input was refused" apart from
 * "the server failed" without parsing messages.
 */
export const HTTP_ERROR_CODES = {
  VALIDATION: 'VALIDATION',
  INVALID_JSON: 'INVALID_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  BAD_REQUEST: 'BAD_REQUEST',
  CONFLICT: 'CONFLICT',
  REFERENCE_CONFLICT: 'REFERENCE_CONFLICT',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
} as const;

interface MappedError {
  status: number;
  error: string;
  code: string;
  details?: unknown;
}

function isZodError(err: unknown): err is ZodError {
  if (err instanceof ZodError) return true;
  // A second zod copy (another workspace) fails instanceof: duck-type it.
  const e = err as { name?: unknown; issues?: unknown } | null;
  return !!e && e.name === 'ZodError' && Array.isArray(e.issues);
}

/** Same `details` shape as middleware/validate.ts (field -> messages). */
function zodDetails(err: ZodError): Record<string, string[] | undefined> {
  const flat = err.flatten();
  return flat.formErrors.length > 0
    ? { ...flat.fieldErrors, _form: flat.formErrors }
    : flat.fieldErrors;
}

interface PgErrorLike { code: string; severity?: string; detail?: string; constraint?: string; table?: string; message?: string }

/** A PostgreSQL server error (pg DatabaseError), not a Node system error (ECONNRESET...). */
function asPgError(err: unknown): PgErrorLike | null {
  const e = err as Partial<PgErrorLike> | null;
  if (!e || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return null;
  if (typeof e.severity !== 'string') return null;
  return e as PgErrorLike;
}

/**
 * 23503 on the referenced side. The detail follows the server's lc_messages
 * (a French PostgreSQL says "toujours référencée"), so a DELETE (the route
 * method, or the statement knex prefixes to its message) also counts: it can
 * only hit the "still referenced" case.
 */
function isStillReferenced(pg: PgErrorLike, method: string): boolean {
  if (pg.detail && /still referenced|toujours r\u00e9f\u00e9renc/i.test(pg.detail)) return true;
  if (method === 'DELETE') return true;
  return typeof pg.message === 'string' && /^\s*delete\b/i.test(pg.message);
}

/**
 * Maps the PostgreSQL errors a request can legitimately trigger to a 4xx.
 * The server message is never echoed: it names tables, constraints and values.
 */
function mapPgError(pg: PgErrorLike, method: string): MappedError | null {
  switch (pg.code) {
    case '23505': // unique_violation
      return { status: 409, error: 'This entry already exists', code: HTTP_ERROR_CODES.CONFLICT };
    case '23503': // foreign_key_violation
      // "Key (...) is still referenced from table ..." -> deleting something in use;
      // "Key (...) is not present in table ..." -> pointing at something missing.
      return isStillReferenced(pg, method)
        ? { status: 409, error: 'This entry is still in use', code: HTTP_ERROR_CODES.REFERENCE_CONFLICT }
        : { status: 400, error: 'A referenced entry does not exist', code: HTTP_ERROR_CODES.INVALID_REFERENCE };
    case '22P02': // invalid_text_representation (bad uuid / integer / inet)
    case '22001': // string_data_right_truncation
    case '22003': // numeric_value_out_of_range
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '23502': // not_null_violation
    case '23514': // check_violation
      return { status: 400, error: 'Invalid input', code: HTTP_ERROR_CODES.INVALID_INPUT };
    case '57014': // query_canceled (statement_timeout, see db/index.ts)
      return { status: 503, error: 'The request took too long, try again', code: HTTP_ERROR_CODES.TIMEOUT };
    default:
      return null;
  }
}

/**
 * Errors raised by Express itself and by body-parser (http-errors objects):
 * malformed JSON, oversized body, bad encoding... Only client errors are
 * mapped; their message is safe to echo when the library marks it exposable.
 */
function mapHttpError(err: unknown): MappedError | null {
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown; expose?: unknown; message?: unknown } | null;
  if (!e) return null;
  if (e.type === 'entity.parse.failed') {
    return { status: 400, error: 'Malformed JSON body', code: HTTP_ERROR_CODES.INVALID_JSON };
  }
  if (e.type === 'entity.too.large') {
    return { status: 413, error: 'Request body too large', code: HTTP_ERROR_CODES.PAYLOAD_TOO_LARGE };
  }
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : NaN;
  if (status === 404) {
    // e.g. serve-static / sendFile: the message would carry a filesystem path.
    return { status, error: 'Not found', code: HTTP_ERROR_CODES.NOT_FOUND };
  }
  // Generic pass-through only for http-errors objects (body-parser, send...),
  // which always carry a boolean `expose`: any other error with a `status`
  // (an upstream API's 401...) must not set this server's status code.
  if (status >= 400 && status < 500 && typeof e.expose === 'boolean') {
    const message = e.expose === true && typeof e.message === 'string' && e.message ? e.message : 'Bad request';
    return { status, error: message, code: HTTP_ERROR_CODES.BAD_REQUEST };
  }
  return null;
}

/** knex pool acquisition timeout (pool exhausted / database unreachable). */
function isKnexTimeout(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'KnexTimeoutError';
}

/**
 * JSON 404 for any /api path no router answered. Mount it right after the
 * API router (app.use('/api', apiNotFoundHandler)) so an unknown API route
 * never falls through to the SPA index.html (200 text/html) or to Express's
 * HTML "Cannot GET".
 */
export function apiNotFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ success: false, error: 'Not found', code: HTTP_ERROR_CODES.NOT_FOUND });
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Response already streaming: Express's default handler closes the socket.
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.params ? { params: err.params } : {}),
    });
    return;
  }

  let mapped: MappedError | null = null;
  if (isZodError(err)) {
    mapped = { status: 400, error: 'Validation failed', code: HTTP_ERROR_CODES.VALIDATION, details: zodDetails(err) };
  } else {
    const pg = asPgError(err);
    if (pg) {
      mapped = mapPgError(pg, req.method);
      if (mapped) {
        logger.warn(
          { pgCode: pg.code, constraint: pg.constraint, table: pg.table, method: req.method, path: req.path },
          'Database error mapped to client error',
        );
      }
    } else if (isKnexTimeout(err)) {
      logger.error({ err, method: req.method, path: req.path }, 'Database connection pool timeout');
      mapped = { status: 503, error: 'The server is busy, try again', code: HTTP_ERROR_CODES.TIMEOUT };
    } else {
      mapped = mapHttpError(err);
    }
  }

  if (mapped) {
    res.status(mapped.status).json({
      success: false,
      error: mapped.error,
      code: mapped.code,
      ...(mapped.details !== undefined ? { details: mapped.details } : {}),
    });
    return;
  }

  // Unknown failure: logged in full, answered without message nor stack.
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: HTTP_ERROR_CODES.INTERNAL,
  });
}
