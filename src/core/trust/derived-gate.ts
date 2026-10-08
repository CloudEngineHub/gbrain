/**
 * The row-level write gate for derivers (#5575 B3, ENG-18): the gate input
 * is exactly the tier the deriver declared (trust/taint.ts). Each writer
 * calls decideFactWrite / decideTakeWrite / assessTimelineForGate itself
 * (write-gate-store.ts, write-gate.ts); these helpers read the gate config
 * once per run and apply one decision inside the writer's transaction.
 * A deriver never throws for one row: a held row goes to write_gate_holds, a
 * rejected row is skipped and counted.
 */
import type { BrainEngine } from '../engine.ts';
import { loadImportSanityConfig } from '../import-screen.ts';
import { DEFAULT_WRITE_GATE_CONFIG, type WriteGateConfig, type WriteGateInput } from '../write-gate.ts';
import { recordFlaggedRow, recordWriteGateHold, type GatedRowDecision } from '../write-gate-store.ts';
import type { WriteTrust } from './tier.ts';

/** `write_gate.*` as the import path reads it; unreadable values fall back to the defaults, never `off`. */
export async function derivedGateConfig(engine: BrainEngine): Promise<WriteGateConfig> {
  return (await loadImportSanityConfig(engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG;
}

/** The gate input for a declared derivation. */
export function derivedGateInput(trust: WriteTrust, requestId?: string | null): WriteGateInput {
  return { tier: trust.tier, origin: trust.origin, requestId: requestId ?? trust.origin?.request_id ?? null };
}

/** What one run's gate did, for the run result. */
export interface GateTally { flagged: number; held: number; rejected: number }
export const emptyGateTally = (): GateTally => ({ flagged: 0, held: 0, rejected: 0 });

/**
 * Applies one decision inside the writer's transaction: `insert` runs the
 * insert and records the flag receipt on the new row; `hold` records the hold
 * instead of inserting; `reject` writes nothing. Returns the inserted id.
 */
export async function applyGateDecision(tx: BrainEngine, decision: GatedRowDecision, target: { table: 'facts' | 'takes'; sourceId: string },
  insert: () => Promise<number | null>, tally?: GateTally): Promise<number | null> {
  if (decision.action === 'reject') { if (tally) tally.rejected++; return null; }
  if (decision.action === 'hold') { await recordWriteGateHold(tx, decision.hold!); if (tally) tally.held++; return null; }
  const id = await insert();
  if (id !== null && await recordFlaggedRow(tx, decision, { table: target.table, id, sourceId: target.sourceId }) !== null && tally) tally.flagged++;
  return id;
}
