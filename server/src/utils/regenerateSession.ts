import type { Request } from 'express';

/**
 * Issue a fresh session id (dropping all session data) before a login step
 * writes identity into the session. Prevents session fixation: a session id
 * planted in the victim's browser (sibling subdomain, http MITM) would
 * otherwise become authenticated as the victim once they sign in.
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}
