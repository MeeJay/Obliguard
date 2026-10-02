import rateLimit from 'express-rate-limit';

// Global API limiter — protects unauthenticated / public endpoints only.
//
// IMPORTANT: This limiter runs AFTER session middleware (see app.ts) so that
// req.session.userId is populated and we can skip authenticated users.
//
// Why skip authenticated sessions?
//   - Behind a reverse proxy (e.g. Nginx Proxy Manager) ALL users share the
//     same apparent IP.  A limit of N req/window would be shared by every user
//     simultaneously, causing false positives on normal dashboard usage.
//   - Authenticated requests are already protected by the session cookie; the
//     rate limiter adds no meaningful security benefit for them.
//   - Unauthenticated requests (login page, public health endpoint, etc.) still
//     get rate-limited to defend against enumeration / DDoS.
export const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes (shorter window = faster recovery)
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    // ── Authenticated dashboard users ──────────────────────────────────────
    // Session is populated by the time this limiter runs (middleware order in app.ts).
    !!req.session?.userId ||
    // ── Public informational endpoints ─────────────────────────────────────
    // Health check is polled by the login page to show the server version;
    // rate-limiting it would block the login page's UI, not improve security.
    req.path === '/health' ||
    // Auth state probe — returns 401 for unauthenticated callers, no info leak.
    req.path === '/api/auth/me' ||
    // ── Machine-to-machine endpoints ───────────────────────────────────────
    // All /api/agent/* paths are API-key authenticated (X-API-Key header).
    // Rate-limiting them would cause false positives when agents post metrics,
    // version checks, download updates, and serve installer scripts at their
    // natural cadence. Security is provided by the API key itself.
    req.path.startsWith('/api/agent/') ||
    // Passive heartbeats (token authenticated, triggered by external systems).
    req.path.startsWith('/api/heartbeat/'),
  message: {
    success: false,
    error: 'Too many requests, please try again later',
  },
});

// Login-specific limiter — stricter window to slow down brute-force attempts.
//
// Key = IP + username so that:
//   a) A shared proxy IP does NOT cause all users to share one rate-limit bucket.
//      User A hitting the limit doesn't lock out User B.
//   b) An attacker cannot brute-force a single account faster than the limit allows.
//   c) req.body is available here because authLimiter is applied per-route in
//      auth.routes.ts, after express.json() has already run globally.
//
// skipSuccessfulRequests: successful logins (HTTP 200) do not count toward the
// limit, so a legitimate user who eventually gets their password right is not
// penalised for earlier typos.  Only failed attempts (4xx) accumulate.
export const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes — resets quickly after an accidental lock-out
  max: 20,                  // 20 failed attempts per 5-minute window per IP+username
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip       = req.ip ?? 'unknown';
    const username = (req.body as { username?: string })?.username?.toLowerCase() ?? '';
    // Combine both so shared-IP users each get their own bucket per account.
    return `${ip}:${username}`;
  },
  message: {
    success: false,
    error: 'Too many login attempts, please try again in 5 minutes',
  },
});

// Current-password limiter — the profile's current-password check (password
// change, e-mail change) is a password oracle reachable with a session cookie
// alone: a stolen cookie must not get unlimited guesses at the password.
//
// Key = the ACCOUNT (session user id), not the IP: the guesses are bounded per
// account wherever they come from. Only REJECTED current passwords count: the
// controller sets res.locals.currentPasswordRejected before answering 400, so
// validation errors and successful changes cost nothing. Once the budget is
// spent every request answers 429 until the window slides.
export const CURRENT_PASSWORD_MAX_FAILURES = 5;
export const CURRENT_PASSWORD_WINDOW_MS = 15 * 60 * 1000;

export const currentPasswordLimiter = rateLimit({
  windowMs: CURRENT_PASSWORD_WINDOW_MS,
  max: CURRENT_PASSWORD_MAX_FAILURES,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.locals.currentPasswordRejected !== true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.session?.userId ?? 'anonymous'}`,
  message: {
    success: false,
    error: 'Too many incorrect passwords, please try again in 15 minutes',
  },
});

// M365 enrolment limiter — the two session-less endpoints that validate a
// single-use enrolment token.
//
// These are reached by the PowerShell script on an operator's workstation, so
// the natural volume is a handful of calls per enrolment. The global apiLimiter
// already covers them, but a route that checks a secret deserves its own,
// tighter bucket, the same reasoning as authLimiter for login.
//
// The key is the IP alone: the token is the thing being guessed, so bucketing by
// token would hand an attacker a fresh allowance per attempt.
export const m365EnrolLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many enrolment attempts, please try again later',
  },
});
