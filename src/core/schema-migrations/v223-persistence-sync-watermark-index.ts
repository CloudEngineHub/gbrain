import type { Migration } from './types.ts';
import { PERSISTENCE_SYNC_WATERMARK_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// The movement watermark read (persistence/sync-movement.ts, every minute per
// managed source in `gbrain serve`) filtered v222's
// `persistence_requests_committed_watermark` by incarnation and intent kind,
// so a worktree whose committed receipts are not managed sync receipts was a
// full walk that detoasted every intent: 115 ms at 5k receipts, 1.1 s at 50k.
// `persistence_requests_sync_watermark` keys on (worktree_id,
// source_incarnation, completed_at DESC) and holds only committed receipts of
// a `managed_sync_*` kind, so the read is one index probe. Postgres builds it
// CONCURRENTLY and then drops v222's index CONCURRENTLY (nothing else reads
// it); PGLite builds and drops inline. Fresh installs replay v222 on an empty
// table, so the build and drop there cost nothing.
export const v223: Migration = {
  version: 223,
  name: 'persistence_sync_watermark_index',
  idempotent: true,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 223, PERSISTENCE_SYNC_WATERMARK_INDEX, { notice: migrationNotice });
    await engine.runMigration(223, `DROP INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS persistence_requests_committed_watermark;`);
  },
};
