/**
 * BrainBench memory-trust suite orchestration (#5575): runs every trust,
 * state-resolution, poisoning and deletion fixture on one persistence-enabled
 * brain (trust-scenario.ts), scores each with its suite's metric module, and
 * replays poisoning fixtures' later session through every harness seam.
 *
 * trust, state-resolution and deletion are harness-independent write and read
 * paths (like write-back): every harness cell carries the same once-computed
 * numbers. Poisoning activation is per seam.
 *
 * `beforeStep` and a caller-supplied `brain` are the mutation-probe seam
 * (test/brainbench-trust-mutations.serial.test.ts): break one protection,
 * rerun, and the gated metric must breach.
 */

import { operationsByName } from '../../core/operations.ts';
import { createTrustBrain, runTrustSteps, type RunTrustStepsOpts, type TrustBrain, type TrustFixtureRun } from './trust-scenario.ts';
import { emptyTrustCounts, scoreTrustFixture, trustMetrics, type SuiteScore, type TrustSuiteCounts } from './metrics/trust.ts';
import { emptyStateCounts, scoreStateFixture, stateMetrics, type StateSuiteCounts } from './metrics/state-resolution.ts';
import {
  emptyPoisonCounts, observePoisonDurability, poisonMetrics, scorePoisonFixture,
  type PoisonSuiteCounts, type ProactiveCapture,
} from './metrics/poisoning.ts';
import { deletionMetrics, emptyDeletionCounts, scoreDeletionFixture, type DeletionSuiteCounts } from './metrics/deletion.ts';
import {
  isTrustSuite,
  round4,
  toPublicTurn,
  type AdapterFixtureView,
  type HarnessAdapter,
  type HarnessName,
  type LoadedFixture,
  type SeamKind,
  type SuiteMetrics,
  type TrustSuite,
  type TurnRow,
} from './types.ts';

export interface TrustCellAgg<C> { counts: C; gold_total: number; gold_failed: number; fixtures: string[]; failed_items: string[] }
export interface TrustAgg {
  trust: TrustCellAgg<TrustSuiteCounts>;
  'state-resolution': TrustCellAgg<StateSuiteCounts>;
  deletion: TrustCellAgg<DeletionSuiteCounts>;
  /** Poisoning activation is per harness (each seam's proactive surfaces differ). */
  poisoning: Map<HarnessName, TrustCellAgg<PoisonSuiteCounts>>;
  /** Poisoning later-session turn rows (one per harness, source and user turn). */
  turnRows: TurnRow[];
}

function newTrustAgg(): TrustAgg {
  const cell = <C>(counts: C): TrustCellAgg<C> => ({ counts, gold_total: 0, gold_failed: 0, fixtures: [], failed_items: [] });
  return { trust: cell(emptyTrustCounts()), 'state-resolution': cell(emptyStateCounts()), deletion: cell(emptyDeletionCounts()), poisoning: new Map(), turnRows: [] };
}

function addScore<C extends object>(agg: TrustCellAgg<C>, fixtureId: string, score: SuiteScore<C>, progress?: (note: string) => void): void {
  for (const f of score.failed_items) progress?.(`  failed ${f}`);
  const counts = agg.counts as Record<string, number>;
  for (const [k, v] of Object.entries(score.counts as Record<string, number>)) counts[k] = (counts[k] ?? 0) + v;
  agg.gold_total += score.gold_total;
  agg.gold_failed += score.gold_failed;
  if (!agg.fixtures.includes(fixtureId)) agg.fixtures.push(fixtureId);
  agg.failed_items.push(...score.failed_items);
}

/**
 * The later session: every user turn through the harness's proactive seam, once per
 * source the fixture wrote into (a harness reads one source at a time; the payload
 * must not activate from any of them).
 */
async function captureProactive(
  run: TrustFixtureRun, adapter: HarnessAdapter, lf: LoadedFixture, structured: unknown[],
): Promise<{ capture: ProactiveCapture; rows: TurnRow[] }> {
  const capture: ProactiveCapture = { texts: [], structured };
  const rows: TurnRow[] = [];
  for (const sourceId of run.sourceIds) {
    const view: AdapterFixtureView = { fixture_id: lf.fixture.fixture_id, active_source: sourceId, turns: lf.fixture.turns.map(toPublicTurn) };
    const pages = new Set((await run.engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id = $1', [sourceId])).map(r => r.slug));
    await adapter.beginConversation(run.engine, view);
    let prior = '';
    try {
      for (const turn of view.turns) {
        if (turn.role !== 'user') { prior += `\n${turn.text}`; continue; }
        const result = await adapter.replayTurn(turn, prior);
        if (result.injectedText) capture.texts.push(result.injectedText);
        rows.push({
          fixture_id: lf.fixture.fixture_id, turn_id: turn.turn_id, harness: adapter.name, suite: 'poisoning',
          injected_slugs: result.injectedSlugs, injected_tokens: result.injectedTokens, gold: null,
          cross_source_slugs: result.injectedSlugs.filter(slug => !pages.has(slug)),
          latency_ms: Math.round(result.latencyMs * 1000) / 1000,
        });
        prior += `\n${turn.text}`;
        if (result.injectedText) prior += `\n${result.injectedText}`;
      }
    } finally {
      await adapter.endConversation();
    }
  }
  return { capture, rows };
}

/**
 * context_pack is a proactive surface every harness can call: captured once per
 * fixture as the agent's connection, for the people the session is about (the
 * owner pages and remembered entities, never the slugs of the injected pages).
 */
async function contextPackFor(run: TrustFixtureRun, lf: LoadedFixture): Promise<unknown[]> {
  const steps = lf.fixture.trust_steps ?? [];
  const entities = [...new Set(steps.flatMap(s => (s.entity ? [s.entity] : s.actor === 'owner' && s.slug ? [s.slug] : [])))].slice(0, 8);
  const def = operationsByName.context_pack;
  if (!def || entities.length === 0) return [];
  try {
    return [await def.handler(run.remote, { entities: entities.join(','), budget_tokens: 4000 })];
  } catch {
    return [];
  }
}

export interface RunTrustSuitesOpts {
  harnesses: HarnessName[];
  adapterFor: (h: HarnessName) => Promise<HarnessAdapter>;
  progress?: (note: string) => void;
  /** Use this brain instead of a fresh one (left open for the caller). */
  brain?: TrustBrain;
  /** Called before each step of each fixture (mutation probes). */
  beforeStep?: RunTrustStepsOpts['beforeStep'];
}

/** Runs and scores every memory-trust fixture. */
export async function runTrustSuites(fixtures: LoadedFixture[], opts: RunTrustSuitesOpts): Promise<TrustAgg> {
  const agg = newTrustAgg();
  const progress = opts.progress ?? (() => {});
  const brain = opts.brain ?? await createTrustBrain();
  try {
    for (const lf of fixtures) {
      progress(`trust ${lf.fixture.fixture_id}`);
      await runTrustFixture(brain, lf, opts, agg, progress);
    }
  } finally {
    if (!opts.brain) await brain.close();
  }
  return agg;
}

async function runTrustFixture(
  brain: TrustBrain,
  lf: LoadedFixture,
  opts: RunTrustSuitesOpts,
  agg: TrustAgg,
  progress: (note: string) => void,
): Promise<void> {
  const suite = lf.fixture.suites.find(isTrustSuite)!;
  const items = lf.gold.trust?.items ?? [];
  const run = await runTrustSteps(brain, lf.fixture, { beforeStep: opts.beforeStep });
  const id = lf.fixture.fixture_id;
  if (suite === 'trust') addScore(agg.trust, id, await scoreTrustFixture(run, items), progress);
  else if (suite === 'state-resolution') addScore(agg['state-resolution'], id, await scoreStateFixture(run, items), progress);
  else if (suite === 'deletion') addScore(agg.deletion, id, await scoreDeletionFixture(run, items), progress);
  else {
    const durability = await observePoisonDurability(run, items);
    const pack = await contextPackFor(run, lf);
    for (const harness of opts.harnesses) {
      const { capture, rows } = await captureProactive(run, await opts.adapterFor(harness), lf, pack);
      agg.turnRows.push(...rows);
      const cell = agg.poisoning.get(harness) ?? { counts: emptyPoisonCounts(), gold_total: 0, gold_failed: 0, fixtures: [], failed_items: [] };
      addScore(cell, id, scorePoisonFixture(id, durability, capture), (n) => progress(`${n} [${harness}]`));
      agg.poisoning.set(harness, cell);
    }
  }
}

export function assembleTrustCell(harness: HarnessName, suite: TrustSuite, agg: TrustAgg, seam: SeamKind): SuiteMetrics | null {
  // trust, state-resolution and deletion are harness-independent write/read paths (like write-back):
  // every harness cell carries the same once-computed numbers. Poisoning activation is per seam.
  const cell: TrustCellAgg<object> | undefined = suite === 'poisoning' ? agg.poisoning.get(harness) : agg[suite];
  if (!cell || cell.fixtures.length === 0) return null;
  let metrics: Record<string, number>;
  if (suite === 'trust') metrics = trustMetrics(cell.counts as TrustSuiteCounts);
  else if (suite === 'state-resolution') metrics = stateMetrics(cell.counts as StateSuiteCounts);
  else if (suite === 'deletion') metrics = deletionMetrics(cell.counts as DeletionSuiteCounts);
  else {
    const rows = agg.turnRows.filter((r) => r.harness === harness);
    metrics = {
      ...poisonMetrics(cell.counts as PoisonSuiteCounts),
      source_isolation_violations: rows.reduce((n, r) => n + r.cross_source_slugs.length, 0),
      avg_injected_tokens: avg(rows.map((r) => r.injected_tokens)),
    };
  }
  return {
    suite, harness, seam,
    gold_total: cell.gold_total,
    gold_failed: cell.gold_failed,
    metrics: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, round4(v)])),
    fixtures: [...cell.fixtures],
  };
}


function avg(ns: number[]): number {
  return ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length;
}
