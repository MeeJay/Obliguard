import type { Knex } from 'knex';

/**
 * Migration 028 — M365 Guard: tenant registration and enrolment.
 *
 * A Microsoft 365 tenant is modelled as an `agent_devices` row with
 * `device_type = 'm365'`, exactly like a MikroTik device (migration 017). It
 * therefore inherits the existing group hierarchy, settings inheritance,
 * notification bindings and per-tenant RBAC without any new plumbing.
 *
 * Adds:
 *   - `m365_tenants`: Entra identifiers, the encrypted certificate private key,
 *     the detected licence profile, per-source cursors and the last error.
 *   - `m365_enrolment_tokens`: single-use tokens that let the onboarding script
 *     post `entra_tenant_id` and `client_id` back without a session.
 *
 * Obliguard generates the RSA key pair and keeps the private key; only the
 * self-signed certificate is uploaded into the customer tenant. No admin
 * password is ever collected, so the ROPC flow — whose `BAV2ROPC` user agent
 * this product flags under D-SI-01, and which cannot satisfy MFA — is not used.
 */
export async function up(knex: Knex): Promise<void> {
  // 1. Widen device_type. The column is a free-form string (017) with no CHECK
  //    constraint, so nothing to alter: 'm365' is simply a new accepted value,
  //    enforced in code and in the shared AgentDevice type.

  // 2. Tenant registration, one row per m365 device.
  if (!(await knex.schema.hasTable('m365_tenants'))) {
    await knex.schema.createTable('m365_tenants', (t) => {
      t.increments('id').primary();
      t.integer('device_id').unsigned().notNullable().unique()
        .references('id').inTable('agent_devices').onDelete('CASCADE');

      // ── Entra application, created in the customer tenant at enrolment ──
      t.string('entra_tenant_id', 64).nullable();
      t.string('primary_domain', 255).nullable();
      t.string('client_id', 64).nullable();
      // PKCS#8 private key, PEM, AES-256-GCM encrypted. Never leaves the server.
      t.text('cert_private_key_enc').nullable();
      // Self-signed certificate, PEM. Public material: stored in the clear so the
      // onboarding script and the UI can show which key the tenant should trust.
      t.text('cert_public_pem').nullable();
      // SHA-1 thumbprint, hex. Sent as `x5t` in the client assertion.
      t.string('cert_thumbprint', 40).nullable();
      t.timestamp('cert_not_after', { useTz: true }).nullable();

      // ── Capability detection ──
      // Drives which controls run: signIns via Graph needs P1, userRegistrationDetails
      // needs P1, risky users need P2. Null until the first successful probe.
      t.string('licence_profile', 8).nullable();
      // Write permissions are a second, optional consent. Until granted, the
      // response playbooks stay read-only.
      t.boolean('has_write_consent').notNullable().defaultTo(false);
      t.boolean('exo_worker_enabled').notNullable().defaultTo(true);

      // ── Per-source progress. A source that stops advancing is what F-DATA-01
      //    reports on: no conclusion may cover a period that was never fetched. ──
      t.timestamp('last_posture_at', { useTz: true }).nullable();
      t.timestamp('last_signin_at', { useTz: true }).nullable();
      t.jsonb('last_ual_cursor').nullable();
      t.timestamp('last_ual_event_at', { useTz: true }).nullable();
      t.text('last_error').nullable();
      t.timestamp('last_error_at', { useTz: true }).nullable();

      // Allowed countries, trusted IPs, thresholds, per-tenant allowlists.
      t.jsonb('settings').notNullable().defaultTo('{}');

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });

    // A tenant may only be registered once across the whole instance: two
    // Obliguard tenants polling the same Entra tenant would double-count events
    // and fight over the UAL cursor.
    await knex.schema.raw(
      'CREATE UNIQUE INDEX idx_m365_tenants_entra ON m365_tenants(entra_tenant_id) WHERE entra_tenant_id IS NOT NULL',
    );
  }

  await knex.raw('ALTER TABLE m365_tenants DROP CONSTRAINT IF EXISTS m365_tenants_licence_profile_check');
  await knex.raw(
    "ALTER TABLE m365_tenants ADD CONSTRAINT m365_tenants_licence_profile_check " +
      "CHECK (licence_profile IS NULL OR licence_profile IN ('free','p1','p2'))",
  );

  // 3. Single-use enrolment tokens.
  if (!(await knex.schema.hasTable('m365_enrolment_tokens'))) {
    await knex.schema.createTable('m365_enrolment_tokens', (t) => {
      t.increments('id').primary();
      t.integer('device_id').unsigned().notNullable()
        .references('id').inTable('agent_devices').onDelete('CASCADE');
      // Only the hash is stored: a token read from the database must not be
      // replayable, same rule as the password reset tokens.
      t.string('token_hash', 64).notNullable().unique();
      t.timestamp('expires_at', { useTz: true }).notNullable();
      t.timestamp('used_at', { useTz: true }).nullable();
      t.integer('created_by').unsigned().nullable()
        .references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index('device_id');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('m365_enrolment_tokens');
  await knex.schema.dropTableIfExists('m365_tenants');
  // device_type is left alone: migration 017 owns that column.
}
