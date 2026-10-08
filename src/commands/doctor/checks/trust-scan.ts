/**
 * trust_scan (#5575, DX-6 / ENG-8): rows at `agent_written` or lower that
 * the write gate's current detector has not scanned. Activation control
 * (CEO-20) only covers scanned rows, so unscanned legacy rows can still be
 * injected by proactive surfaces; the fix runs `gbrain trust scan`, which
 * records flag receipts in bounded, resumable batches and changes no row.
 * A brain before the trust or write-gate migrations is ok. Read-only.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readTrustScanState } from '../../../core/eligibility/scan.ts';
import { isUndefinedColumnError, isUndefinedTableError } from '../../../core/utils.ts';

async function runTrustScan(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  try {
    const state = await readTrustScanState(engine);
    const details = { detector_version: state.detector_version, unscanned: state.unscanned, total_unscanned: state.total_unscanned, completed_at: state.completed_at };
    if (state.total_unscanned === 0) {
      checks.push({ name: 'trust_scan', status: 'ok', details,
        message: 'Every agent-written or lower row has been scanned by the current write-gate detector; proactive suppression covers them.' });
      return checks;
    }
    checks.push({ name: 'trust_scan', status: 'warn', details,
      message: `${state.total_unscanned} agent-written or lower row(s) have not been scanned by the write-gate detector (v${state.detector_version}), `
        + 'so proactive surfaces cannot yet withhold instruction-like ones. Run gbrain trust scan on the brain host; it records receipts in resumable batches and changes no row.',
      fix: agentFix(['gbrain', 'trust', 'scan'], 'Scans legacy agent-written rows with the deterministic detector and records flag receipts; it never hides, moves or rewrites a row.', 'trust_scan') });
  } catch (err) {
    if (isUndefinedColumnError(err, 'trust_tier') || isUndefinedTableError(err)) {
      checks.push({ name: 'trust_scan', status: 'ok', details: { schema: 'pre_trust' }, message: 'This schema predates the write gate; the scan arrives with its migration.' });
    } else {
      checks.push(checkError('trust_scan', 'read the trust scan state', err));
    }
  }
  return checks;
}

export const trustScanEntry: DoctorEntry = { name: 'trust_scan', emits: ['trust_scan'], run: runTrustScan };
