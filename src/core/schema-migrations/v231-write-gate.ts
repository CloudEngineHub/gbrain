import type { Migration } from './types.ts';
import { WRITE_GATE_SCHEMA_SQL } from '../write-gate-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5575 blocking write gate: verdict receipts and the holding table for
// quarantined facts and takes (src/core/write-gate-store.ts). New empty
// tables, so their indexes build inline on both engines.
export const v231: Migration = {
  version: 231,
  name: 'write_gate',
  idempotent: true,
  sql: WRITE_GATE_SCHEMA_SQL,
};
