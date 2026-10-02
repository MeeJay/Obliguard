import type { Knex } from 'knex';

/**
 * Migration 030 — advance the tenants id sequence past the seeded Default
 * tenant (BROKEN-5).
 *
 * 001 inserts the Default tenant with an explicit id 1, which never advances
 * the serial sequence: on a fresh install the first nextval() returned 1 and
 * the first "Create tenant" failed with a duplicate primary key. The sequence
 * is set to MAX(id) with is_called = true, so the next id is MAX + 1. It never
 * moves backwards (an install that deleted its newest tenants keeps skipping
 * their ids, so a stale reference can never resolve to a new tenant).
 * Down: no-op.
 */
export async function up(knex: Knex): Promise<void> {
  const res = await knex.raw("SELECT pg_get_serial_sequence('tenants', 'id') AS seq") as { rows: Array<{ seq: string | null }> };
  const seq = res.rows[0]?.seq;
  if (!seq) return;
  // seq is returned already quoted/qualified by Postgres (e.g. public.tenants_id_seq).
  await knex.raw(
    `SELECT setval(?::regclass, GREATEST(
       (SELECT COALESCE(MAX(id), 1) FROM tenants),
       (SELECT last_value FROM ${seq}),
       1
     ), true)`,
    [seq],
  );
}

export async function down(): Promise<void> {
  // Nothing to undo: the sequence only moved forward.
}
