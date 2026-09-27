import crypto from 'crypto';

/**
 * Constant-time equality check for secrets (API keys, Bearer tokens).
 *
 * Both values are hashed first so that inputs of different lengths neither
 * throw in crypto.timingSafeEqual nor leak their length through an early
 * return. A missing, empty or non-string expected value never matches
 * (fail closed), and neither does an empty presented value.
 */
export function safeEqualSecret(presented: unknown, expected: unknown): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
