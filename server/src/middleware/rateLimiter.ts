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

// MFA verify limiter — applied to /profile/2fa/verify and /profile/2fa/resend-email.
// Keyed by IP only (no username in the body at that point).
// More generous than the login limiter: the attacker must first have a valid
// username+password AND a live pendingMfaUserId session to even reach this endpoint.
// 50 attempts / 15 minutes is enough to survive testing while still blocking automation.
export const MFA_IP_MAX_FAILURES = 50;
export const MFA_ACCOUNT_MAX_FAILURES = 10;
export const MFA_WINDOW_MS = 15 * 60 * 1000;

export const mfaLimiter = rateLimit({
  windowMs: MFA_WINDOW_MS,     // 15-minute window
  max: MFA_IP_MAX_FAILURES,    // 50 failed attempts per 15 minutes per IP
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many verification attempts, please try again later',
  },
});

// MFA verify limiter keyed on the ACCOUNT (the pending 2FA user), not the IP.
// An IP-keyed limit alone does not bound a TOTP / email-code brute force: the
// attacker already knows the password and can open a new pending session at
// will, from as many addresses as they have. 10 wrong codes per 15 minutes
// per account keeps a 6-digit code out of reach; the worst an attacker can do
// with it is delay that one account's sign-in (and they hold its password).
// Applied to /profile/2fa/verify only, after mfaLimiter.
export const mfaAccountLimiter = rateLimit({
  windowMs: MFA_WINDOW_MS,
  max: MFA_ACCOUNT_MAX_FAILURES,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  // No pending 2FA user: the controller answers 400, nothing to guess.
  skip: (req) => !req.session?.pendingMfaUserId,
  keyGenerator: (req) => `mfa-user:${req.session?.pendingMfaUserId}`,
  message: {
    success: false,
    error: 'Too many verification attempts, please try again later',
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
//
// The second-factor management routes (TOTP setup/disable, e-mail codes
// setup/disable) share this budget: their proof is the current password or a
// current authenticator code, and both are guesses a stolen cookie must pay
// for from the same allowance (the controller sets the same flag).
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
