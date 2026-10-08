import type { Migration } from './types.ts';
import { TRUST_SCHEMA_SQL } from '../trust/schema.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../persistence/writer-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Memory trust tiers (#5575): `trust_tier` (NOT NULL DEFAULT 'unknown', a
// constant default, so the ADD is metadata-only on Postgres 11+ and PGLite;
// the CHECK is added NOT VALID and validated in a separate statement) and
// `write_origin` on facts, takes, timeline_entries and pages; the
// page_versions snapshot; the nullable per-token `min_trust` read floor on
// oauth_clients and access_tokens; the trust_proposals decision record; and
// the BEFORE ROW trigger that stamps and guards the tier (trust/schema.ts).
// Every existing row reads `unknown` until `gbrain trust backfill` classifies
// it. content_chunks gets no column: chunk tier is its page's at read time.
// The managed-writer guard function is re-created (no table lock) so a page
// tier change is guarded content like the page body. No schema.sql mirror:
// like write attribution, these columns exist only through migrations.
export const v230: Migration = {
  version: 230,
  name: 'trust_tiers',
  idempotent: true,
  sql: `${TRUST_SCHEMA_SQL}
${MANAGED_WRITER_GUARD_FUNCTION_SQL}`,
};
