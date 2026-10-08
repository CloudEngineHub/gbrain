/**
 * The write gate on agent verbs (#5575 DX-1): one outcome shape on
 * `remember`, `put_page` and `capture`, additive `gate: {verdict, receipt_ref,
 * reason_families, active, next}`, present only when the gate did not allow
 * the write as-is. A flagged write is `inserted` with `active: false` and the
 * confirm command; a held (quarantined) fact is the verb error `write_held`
 * (never `inserted`) with its hold ref. Remote callers see reason families
 * only, never matched patterns. The journal stores the outcome, so a replay
 * of the same request id returns the same answer.
 */
import type { BrainEngine } from '../engine.ts';
import { verbError, type OperationError } from '../ops/contract.ts';
import { loadImportSanityConfig } from '../import-screen.ts';
import { DEFAULT_WRITE_GATE_CONFIG, writeGateOutcome, type WriteGateAssessment, type WriteGateConfig, type WriteGateInput, type WriteGateOutcome } from '../write-gate.ts';
import type { WriteTrust } from './tier.ts';

/** The effective write-gate switches (write_gate.*), read once per write. */
export async function loadWriteGateConfig(engine: BrainEngine): Promise<WriteGateConfig> {
  return (await loadImportSanityConfig(engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG;
}

/** The gate input for a declared write trust (ENG-18: the gate sees exactly the tier the rows get). */
export function gateInput(trust: WriteTrust, requestId: string | null): WriteGateInput {
  const origin = trust.origin;
  return { tier: trust.tier, origin: origin ? { channel: origin.channel, connector: origin.connector ?? null, source_uri: origin.source_uri ?? null } : null, requestId };
}

/**
 * The DX-1 gate field for a persisted row, or undefined when the gate allowed
 * it. `rowRef` (f<id>, t<id>, p:<source>/<slug>) is what the owner confirms;
 * `receiptId` names the stored receipt.
 */
export function gateField(assessment: WriteGateAssessment | null | undefined, rowRef: string, receiptId: number | null): WriteGateOutcome | undefined {
  if (!assessment || assessment.verdict === 'allow') return undefined;
  const outcome = writeGateOutcome(assessment, receiptId !== null ? `wgr${receiptId}` : null);
  if (outcome.next && assessment.verdict === 'flag') outcome.next = { ...outcome.next, argv: ['gbrain', 'trust', 'confirm', rowRef],
    user_message: `An agent saved something that reads like a standing instruction (${rowRef}). It is stored but not acted on until you confirm it.` };
  return outcome;
}

/** The stored outcome of a held fact or take: no row was inserted. */
export function heldOutcome(assessment: WriteGateAssessment, holdId: number): Record<string, unknown> {
  return { status: 'held', hold_ref: `h${holdId}`, gate: writeGateOutcome({ ...assessment, verdict: 'quarantine' }, `h${holdId}`), protocol_version: 1 };
}

/**
 * A memory-verb response whose stored outcome is a hold becomes the verb
 * error `write_held` (frozen MEMORY_VERBS v1 pair: `error` scope_denied,
 * `code` write_held), on first delivery and on every replay.
 */
export function throwIfHeld<T extends Record<string, unknown>>(response: T): T {
  if (response.status !== 'held') return response;
  const gate = response.gate as WriteGateOutcome | undefined;
  const ref = String(response.hold_ref ?? gate?.receipt_ref ?? '');
  const families = gate?.reason_families ?? [];
  const error: OperationError = verbError('scope_denied',
    `write_held: held for owner review as ${ref} (reads like an instruction: ${families.join(', ') || 'detector error'}). Nothing was saved as memory.`,
    'Do not retry: the same content re-opens the same hold. Tell the user it was held and relay the release command; releasing it is their decision.',
    JSON.stringify({ hold_ref: ref, reason_families: families, ...(response.write_request ? { write_request: response.write_request } : {}) }));
  error.canonical = 'write_held';
  error.reason = families[0] ?? 'detector_error';
  if (gate?.next) error.fix = gate.next;
  throw error;
}
