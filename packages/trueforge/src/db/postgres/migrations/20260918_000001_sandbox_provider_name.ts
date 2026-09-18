import { sql, type Kysely } from 'kysely';

/**
 * Persist sandbox provider identity `name` (always equal to `manifest.type` for now).
 * Backfill existing rows from the jsonb type, then require NOT NULL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('sandbox_provider').addColumn('name', 'text').execute();

  await sql`
    UPDATE sandbox_provider
    SET name = manifest ->> 'type'
    WHERE name IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE sandbox_provider
    ALTER COLUMN name SET NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);
  await db.schema.alterTable('sandbox_provider').dropColumn('name').execute();
}
