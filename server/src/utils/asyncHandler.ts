import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { ParsedQs } from 'qs';

/**
 * Express 4 ignores the promise an async handler returns: a rejection never
 * reaches errorHandler, the request hangs until the client gives up and Node
 * reports an unhandled rejection. Wrapping the handler forwards both sync
 * throws and rejections to next(err).
 *
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 *
 * Handlers that already end in try/catch -> next(err) do not need it.
 */
export function asyncHandler<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = ParsedQs,
>(
  fn: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction,
  ) => unknown,
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      next(err);
    }
  };
}
