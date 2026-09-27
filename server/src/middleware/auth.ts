import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
    // unset = no tenant access (non-admin without membership); only login,
    // /tenant/switch, /auth/me and the SSO callback write it
    currentTenantId?: number;
    oauthState: string;
    // redirect_uri sent to Obligate by /auth/sso-redirect, replayed verbatim by
    // /auth/callback for the code exchange (never rebuilt from request headers).
    oauthRedirectUri?: string;
    requestedTenantSlug?: string;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    next(new AppError(401, 'Authentication required'));
    return;
  }
  next();
}
