/**
 * Lot flags of the verification harness.
 *
 * Flip to true in the SAME commit that lands the lot. Never weaken or delete a
 * check to make it pass; a check that contradicts the owner-decided model is
 * escalated, and edited only with the owner decision cited in the commit
 * message. Lot checks may only use HTTP, the database, symbols that already
 * exist in server/src, and adapters.ts. Importing a symbol a future lot will
 * add breaks the baseline typecheck.
 *
 * The flags live in lots.json so the release scripts can read them with
 * `node -e`. Any commit may ADD a key (e.g. an owning lot for a KNOWN_BROKEN
 * path of suite 13).
 *
 * Environment:
 *   VERIFY_STRICT=1      every lot counts as landed (pending checks fail);
 *   VERIFY_LOTS=A1,A2    these lots count as landed (development of a lot).
 */
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import LANDED from './lots.json';

export type Lot = keyof typeof LANDED | 'UNTRACKED';

type TestFn = (t: TestContext) => void | Promise<void>;
type ItOptions = { timeout?: number; skip?: boolean | string; only?: boolean; concurrency?: number | boolean };

export function landed(lot: Lot): boolean {
  if (process.env.VERIFY_STRICT === '1') return true;
  const listed = (process.env.VERIFY_LOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (listed.includes(lot)) return true;
  if (lot === 'UNTRACKED') return false;
  return (LANDED as Record<string, boolean>)[lot] === true;
}

/** A check owned by a lot: a node:test TODO until the lot's flag is flipped. */
export function lotIt(lot: Lot, name: string, fn: TestFn, opts: ItOptions = {}): void {
  const title = `${name} [${lot}]`;
  if (landed(lot)) {
    it(title, { ...opts }, fn);
  } else {
    it(title, { ...opts, todo: `${lot} not landed yet` }, fn);
  }
}

/**
 * A lot check that needs a lot-owned adapter (adapters.ts).
 *   - adapter missing, lot landed: a failing test;
 *   - adapter missing, lot not landed: a TODO that fails fast;
 *   - adapter present: a regular lotIt.
 */
export function adapterIt<A>(lot: Lot, adapter: A | null | undefined, name: string, fn: (a: A, t: TestContext) => void | Promise<void>, opts: ItOptions = {}): void {
  if (adapter == null) {
    lotIt(lot, name, () => {
      throw new Error(landed(lot) ? `${lot}: landed but adapters.ts not filled` : `${lot}: adapters.ts not filled yet`);
    }, opts);
    return;
  }
  lotIt(lot, name, (t) => fn(adapter, t), opts);
}
