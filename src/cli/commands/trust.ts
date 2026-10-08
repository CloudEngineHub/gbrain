/**
 * `gbrain trust`: the memory-trust noun (#5575, DX-7). This module dispatches
 * `backfill` (A8, DX-5) and hands the owner subcommands (review, confirm,
 * release, drop, revert, explain, allow, disable) to src/commands/trust.ts.
 * The record is startup: 'observational', so `backfill --dry-run` runs on a
 * probe-only engine with no migrations and no writes; every other subcommand
 * completes startup first. While a resident serve holds a PGLite brain,
 * src/cli.ts routes the owner subcommands to it before any engine opens.
 */
import { jsonRequested, setCliExitVerdict, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { TRUST_TIERS, trustLabel } from '../../core/trust/tier.ts';
import { runTrustBackfill, type TrustBackfillReport } from '../../core/trust/backfill.ts';
import type { CliDispatchContext } from '../command-table.ts';
import { TRUST_OWNER_USAGE, isTrustOwnerSubcommand, localTrustBackend, runTrustOwnerCommand } from '../../commands/trust.ts';

export const TRUST_BACKFILL_USAGE = [
  'Usage: gbrain trust backfill [--dry-run] [--resume] [--batch-size N] [--json]',
  '  Classifies rows written before trust tiers (facts, takes, timeline entries, pages) from deterministic signals:',
  '  connector sources, page source_kind, transcript/extraction/dream provenance, facts and takes source tags, and',
  '  the journaled request that wrote the row. Rows with no signal stay "unverified origin"; nothing becomes',
  '  "confirmed by you". --dry-run is read-only (no migrations, no writes) and works before the trust migration;',
  '  it reports the projected count per table and tier. --resume continues an interrupted run.',
].join('\n');
export const TRUST_USAGE = `${TRUST_OWNER_USAGE}\n\n${TRUST_BACKFILL_USAGE}`;

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

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  const [sub, ...rest] = args;
  const known = sub === 'backfill' || isTrustOwnerSubcommand(sub);
  if (!sub || args.includes('--help') || args.includes('-h') || !known) {
    console.log(sub === 'backfill' ? TRUST_BACKFILL_USAGE : TRUST_USAGE);
    if (sub && !known && !args.includes('--help') && !args.includes('-h')) setCliExitVerdict(2);
    return;
  }
  if (sub !== 'backfill') {
    await ctx.completeStartup?.(engine);
    await runTrustOwnerCommand(localTrustBackend(engine, ctx.SELECTED_CONFIG_BY_ENGINE.get(engine)), sub, rest);
    return;
  }
  const dryRun = rest.includes('--dry-run');
  const sizeAt = rest.indexOf('--batch-size');
  const batchSize = sizeAt >= 0 ? Number(rest[sizeAt + 1]) : undefined;
  if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000)) {
    console.error('--batch-size must be an integer from 1 to 100000.');
    setCliExitVerdict(2);
    return;
  }
  if (!dryRun) await ctx.completeStartup?.(engine);
  const report = await runTrustBackfill(engine, { dryRun, resume: rest.includes('--resume'), ...(batchSize ? { batchSize } : {}) });
  if (jsonRequested(args)) await writeStdoutFinal(`${JSON.stringify(report, null, 2)}\n`);
  else console.log(render(report));
}
