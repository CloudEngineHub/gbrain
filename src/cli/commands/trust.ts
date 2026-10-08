/**
 * `gbrain trust`: the memory-trust noun (#5575, DX-7). This module dispatches
 * `backfill` (A8, DX-5); the other subcommands (review, confirm, release,
 * drop, revert, explain, allow, disable) join the same record. The record is
 * startup: 'observational', so `backfill --dry-run` runs on a probe-only
 * engine with no migrations and no writes; applying completes startup first.
 */
import { jsonRequested, setCliExitVerdict, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { TRUST_TIERS, trustLabel } from '../../core/trust/tier.ts';
import type { TrustBackfillReport } from '../../core/trust/backfill.ts';
import type { CliDispatchContext } from '../command-table.ts';

export const TRUST_USAGE = [
  'Usage: gbrain trust backfill [--dry-run] [--resume] [--batch-size N] [--json]',
  '  Classifies rows written before trust tiers (facts, takes, timeline entries, pages) from deterministic signals:',
  '  connector sources, page source_kind, transcript/extraction/dream provenance, facts and takes source tags, and',
  '  the journaled request that wrote the row. Rows with no signal stay "unverified origin"; nothing becomes',
  '  "confirmed by you". --dry-run is read-only (no migrations, no writes) and works before the trust migration;',
  '  it reports the projected count per table and tier. --resume continues an interrupted run.',
  '',
  'Usage: gbrain trust scan [--batch-size N] [--json]',
  '  Runs the write gate\'s deterministic detector over agent-written and lower rows written before the gate,',
  '  recording a receipt for each instruction-like row so proactive surfaces stop injecting it until you confirm',
  '  it (gbrain trust review). Changes no row; resumable (rerun to continue); a detector upgrade rescans.',
  '',
  'Usage: gbrain trust explain <ref> [--json]',
  '  Why a memory is or is not used: its trust tier and origin, the write gate\'s verdict and receipts, and whether',
  '  each proactive surface (hook, context engine, context pack, volunteer, reflex, core, hot memory) and explicit',
  '  reads use it. Refs: f<id> fact, t<id> take, e<id> timeline entry, h<id> hold, p:<source>/<slug> page. Read-only.',
].join('\n');

function render(report: TrustBackfillReport): string {
  const lines = [`Trust backfill (${report.mode === 'dry_run' ? 'dry run, nothing written' : 'applied'}; schema: ${report.schema}):`];
  for (const t of report.tables) {
    const parts = TRUST_TIERS.filter(tier => t.projected[tier] > 0).map(tier => `${trustLabel(tier)} ${t.projected[tier]}`);
    lines.push(`  ${t.table}: ${t.rows} row(s)${t.updated !== undefined ? `, ${t.updated} classified now` : ''}${parts.length ? ` -> ${parts.join(', ')}` : ''}`);
  }
  lines.push(`  ${report.at_or_below_agent_written_pct}% of ${report.rows} row(s) at "written by an agent" or below; ${report.unknown_pct}% "unverified origin".`);
  if (report.resume_command) lines.push(`  Resume with: ${report.resume_command}`);
  return lines.join('\n');
}

/** A typed refusal: the error envelope under --json, `Error [code]` text otherwise. */
async function refuse(args: string[], code: 'invalid_params' | 'not_found', message: string, suggestion: string): Promise<void> {
  const { OperationError } = await import('../../core/ops/contract.ts');
  const { reportPersistenceCliError } = await import('../../commands/persistence-delegate.ts');
  await reportPersistenceCliError(new OperationError(code, message, suggestion), jsonRequested(args));
  setCliExitVerdict(code === 'not_found' ? 1 : 2);
}

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const [sub, ...rest] = args;
  const known = sub === 'backfill' || sub === 'scan' || sub === 'explain';
  if (args.includes('--help') || args.includes('-h') || (!sub && !jsonRequested(args))) {
    console.log(TRUST_USAGE);
    return;
  }
  if (!known) {
    if (!jsonRequested(args)) console.log(TRUST_USAGE);
    await refuse(args, 'invalid_params', !sub || sub.startsWith('-') ? 'gbrain trust needs a subcommand.' : `Unknown trust subcommand '${sub}'.`, 'Run gbrain trust backfill, gbrain trust scan or gbrain trust explain <ref> (gbrain trust --help lists them).');
    return;
  }
  const dryRun = rest.includes('--dry-run');
  const sizeAt = rest.indexOf('--batch-size');
  const batchSize = sizeAt >= 0 ? Number(rest[sizeAt + 1]) : undefined;
  if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000)) {
    await refuse(args, 'invalid_params', '--batch-size must be an integer from 1 to 100000.', `Run gbrain trust ${sub} --batch-size 500, or omit --batch-size for the default.`);
    return;
  }
  if (sub === 'explain') {
    const ref = rest.find(a => !a.startsWith('--'));
    if (!ref) { await refuse(args, 'invalid_params', 'gbrain trust explain needs a ref.', 'Run gbrain trust explain <ref> with f<id>, t<id>, e<id>, h<id> or p:<source>/<slug>.'); return; }
    const { explainTrust } = await import('../../core/eligibility/explain.ts');
    const why = await explainTrust(engine, ref);
    if (!why.found) {
      await refuse(args, 'not_found', `${ref}: no fact, take, timeline entry, hold or page has this ref.`,
        'Check the ref: f<id> fact, t<id> take, e<id> timeline entry, h<id> hold, p:<source>/<slug> page (gbrain recall and gbrain get show ids and slugs).');
      return;
    }
    if (jsonRequested(args)) { await writeStdoutFinal(`${JSON.stringify(why, null, 2)}\n`); return; }
    console.log([`${ref}: ${why.label} (${why.trust_tier}), origin ${why.origin}; gate verdict ${why.verdict}${why.unconfirmed ? ', unconfirmed' : ''}`,
      ...Object.entries(why.activation).map(([surface, decision]) => `  ${surface}: ${decision}`),
      ...(why.next ? [`  Review: ${why.next.join(' ')}`] : [])].join('\n'));
    return;
  }
  if (sub === 'scan') {
    await ctx.completeStartup?.(engine);
    const { runTrustScan } = await import('../../core/eligibility/scan.ts');
    const scan = await runTrustScan(engine, batchSize ? { batchSize } : {});
    if (jsonRequested(args)) await writeStdoutFinal(`${JSON.stringify(scan, null, 2)}\n`);
    else console.log([`Trust scan (detector v${scan.detector_version}):`,
      ...scan.tables.map(t => `  ${t.table}: ${t.scanned} row(s) scanned, ${t.flagged} flagged${t.done ? '' : ' (more to scan)'}`),
      scan.complete ? '  Complete. Flagged rows are withheld from proactive context until confirmed (gbrain trust review).' : `  Continue with: ${scan.resume_command}`].join('\n'));
    return;
  }
  if (!dryRun) await ctx.completeStartup?.(engine);
  const { runTrustBackfill } = await import('../../core/trust/backfill.ts');
  const report = await runTrustBackfill(engine, { dryRun, resume: rest.includes('--resume'), ...(batchSize ? { batchSize } : {}) });
  if (jsonRequested(args)) await writeStdoutFinal(`${JSON.stringify(report, null, 2)}\n`);
  else console.log(render(report));
}
