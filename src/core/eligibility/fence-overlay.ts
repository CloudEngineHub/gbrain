/**
 * Fence eligibility overlay for chunks (#5575 ENG-1).
 *
 * Chunk text renders the world rows of a page's `## Facts` fence. A fence row
 * never reaches chunks above its own eligibility:
 * - held rows (a write-gate hold for the row's fingerprint on this page) and
 *   purged rows (a fact_purges tombstone; L3's import overlay already drops
 *   them from canonical markdown, this is the backstop) are omitted;
 * - rows whose stored tier is below the page tier are taken out of the page's
 *   chunks and emitted as separate chunks whose first line is a trust marker
 *   naming the row tier (`fenceTrustMarker`, read back by `chunkTrustMarker`).
 *
 * Chunks carry no tier column: a chunk's tier is its page's tier at read time
 * (stamp.ts), lowered to the marker tier when its text carries one. A marker
 * can only lower a label, so text that imitates one cannot raise anything.
 *
 * The split is pure (`splitFenceOverlay`); `loadFenceChunkOverlay` reads what
 * it needs for one page in one batched query. Rows the current write appends
 * have no facts row yet when chunks are prepared; the writer names them and
 * their tier with `withPendingFenceRows`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import { dropFactFenceRowsByNumber } from '../facts/purge-overlay.ts';
import { withdrawalFenceBlocks } from '../facts/withdrawal-overlay.ts';
import { compareTrust, isTrustTier, minTrust, TRUST_TIERS, type TrustTier } from '../trust/tier.ts';
import { compactTrustLabel } from './labels.ts';

/** The origin slot of a fence trust marker: the chunk holds facts-fence rows, not page prose. */
export const FENCE_TRUST_ORIGIN = 'facts-fence';

export interface FenceChunkOverlay {
  /** Fence row numbers left out of chunk text entirely (held, purged). */
  omit: ReadonlySet<number>;
  /** Fence row numbers whose tier is below the page tier, with that tier. */
  demote: ReadonlyMap<number, TrustTier>;
}

export function fenceOverlayIsEmpty(overlay: FenceChunkOverlay | null | undefined): boolean {
  return !overlay || (overlay.omit.size === 0 && overlay.demote.size === 0);
}

/** The first line of a low-tier fence chunk, e.g. `[written by an agent · facts-fence]`. */
export function fenceTrustMarker(tier: TrustTier): string {
  return compactTrustLabel({ trust_tier: tier, origin: FENCE_TRUST_ORIGIN });
}

const MARKER_TIERS: ReadonlyMap<string, TrustTier> = new Map(TRUST_TIERS.map(tier => [fenceTrustMarker(tier), tier]));

/** The row tier a chunk's leading fence trust marker names, or null when the chunk carries none. */
export function chunkTrustMarker(chunkText: unknown): TrustTier | null {
  if (typeof chunkText !== 'string' || !chunkText.startsWith('[')) return null;
  const end = chunkText.indexOf('\n');
  return MARKER_TIERS.get(end === -1 ? chunkText : chunkText.slice(0, end)) ?? null;
}

/**
 * The least trusted tier any marker line in a text names, or null. Search
 * evidence can join several chunks into one delivered text, so every line is
 * read, not just the first; a marker only ever lowers a label.
 */
export function lowestFenceTrustMarker(text: unknown): TrustTier | null {
  if (typeof text !== 'string' || !text.includes(FENCE_TRUST_ORIGIN)) return null;
  let lowest: TrustTier | null = null;
  for (const line of text.split('\n')) {
    const tier = MARKER_TIERS.get(line);
    if (tier && (!lowest || compareTrust(tier, lowest) < 0)) lowest = tier;
  }
  return lowest;
}

/** Prefix every piece of a low-tier fence text with its marker line. */
export function markFenceChunk(tier: TrustTier, text: string): string {
  return `${fenceTrustMarker(tier)}\n${text}`;
}

/** Text with a leading marker line removed, and the marker's tier (for re-splitting an oversized chunk). */
export function unmarkFenceChunk(text: string): { tier: TrustTier | null; body: string } {
  const tier = chunkTrustMarker(text);
  return tier ? { tier, body: text.slice(text.indexOf('\n') + 1) } : { tier: null, body: text };
}

export interface FenceOverlaySplit {
  /** The text with omitted and demoted rows removed from every facts fence. */
  main: string;
  /** One rendered facts fence per demoted tier (visible world rows only), least trusted last. */
  lowTier: Array<{ tier: TrustTier; body: string }>;
}

/** Pure: apply an overlay to one body. Unchanged text when the overlay is empty or the body has no facts fence. */
export function splitFenceOverlay(text: string, overlay: FenceChunkOverlay | null | undefined): FenceOverlaySplit {
  if (fenceOverlayIsEmpty(overlay) || !text.includes('gbrain:facts:begin')) return { main: text, lowTier: [] };
  const { omit, demote } = overlay!;
  const byTier = new Map<TrustTier, ParsedFact[]>();
  for (const block of withdrawalFenceBlocks(text)) {
    if (block.parsed.warnings.length) continue;
    for (const row of block.parsed.facts) {
      const tier = demote.get(row.rowNum);
      if (!tier || omit.has(row.rowNum) || row.visibility !== 'world' || row.forgotten) continue;
      byTier.set(tier, [...(byTier.get(tier) ?? []), row]);
    }
  }
  const main = dropFactFenceRowsByNumber(text, row => !omit.has(row.rowNum) && !demote.has(row.rowNum));
  return { main, lowTier: TRUST_TIERS.filter(tier => byTier.has(tier)).map(tier => ({ tier, body: renderFactsTable(byTier.get(tier)!) })) };
}

/** World fence rows of a body, every complete block. */
function worldFenceRows(text: string | null | undefined): ParsedFact[] {
  if (!text || !text.includes('gbrain:facts:begin')) return [];
  return withdrawalFenceBlocks(text).flatMap(block => block.parsed.warnings.length ? [] : block.parsed.facts.filter(row => row.visibility === 'world'));
}

interface PendingFenceRows { sourceId: string; slug: string; rowNums: readonly number[]; tier: TrustTier }
const pendingRows = new AsyncLocalStorage<PendingFenceRows>();

/**
 * Inside `fn`, chunk preparation for (sourceId, slug) treats `rowNums` as
 * rows of tier `tier`: a fence writer appends them in the same publication,
 * so their facts rows do not exist yet when the page's chunks are prepared.
 */
export function withPendingFenceRows<T>(rows: PendingFenceRows, fn: () => Promise<T>): Promise<T> {
  return pendingRows.run(rows, fn);
}

/**
 * The tier a fence append's new rows are labeled with while chunks are
 * prepared. Fence appends (remember, extract_facts entity facts) are
 * agent-classified (trust/backfill.ts); a lower declared tier lowers it.
 */
export function fenceAppendPendingTier(declared?: TrustTier | null): TrustTier {
  return declared ? minTrust('agent_written', declared) : 'agent_written';
}

type HoldTexts = ReadonlyArray<string | null | undefined>;

/**
 * Lane L2a seam (write gate): the fingerprint of a held fact,
 * `holdFingerprint('fact', texts)` from write-gate-store.ts. Null until the
 * gate is on this branch: no held lookup runs (write_gate_holds does not
 * exist yet). The L1b integrator sets the default to the gate's function.
 */
let factHoldFingerprint: ((texts: HoldTexts) => string) | null = null;

/** Installs the held-row fingerprint (the write gate's `holdFingerprint('fact', …)`); null turns the held lookup off. */
export function registerFactHoldFingerprint(fingerprint: ((texts: HoldTexts) => string) | null): void {
  factHoldFingerprint = fingerprint;
}

/** The gated text fields of a fence row, in the gate's `decideFactWrite` order (fact, context, value). */
export function fenceRowHoldTexts(row: Pick<ParsedFact, 'claim' | 'context'>): HoldTexts {
  return [row.claim, row.context ?? null, null];
}

const OVERLAY_SQL = (held: boolean) => `WITH incoming AS MATERIALIZED (
    SELECT i.row_num, i.claim, i.visibility, i.fp FROM jsonb_to_recordset($3::text::jsonb) AS i(row_num integer, claim text, visibility text, fp text))
  SELECT incoming.row_num,
    (SELECT p.trust_tier FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL LIMIT 1) AS page_tier,
    (SELECT f.trust_tier FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.row_num=incoming.row_num
      ORDER BY f.id DESC LIMIT 1) AS row_tier,
    EXISTS (SELECT 1 FROM fact_purges fp WHERE fp.source_id=$1 AND fp.visibility=incoming.visibility
      AND fp.fact_hash=gbrain_fact_fingerprint(incoming.claim) AND (fp.subject='*' OR fp.subject=$2)) AS purged,
    ${held ? `EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.kind='fact' AND h.source_id=$1 AND h.slug=$2
      AND h.status='held' AND h.fingerprint=incoming.fp)` : 'false'} AS held
  FROM incoming`;
const OVERLAY_SQL_WITH_HOLDS = OVERLAY_SQL(true);
const OVERLAY_SQL_WITHOUT_HOLDS = OVERLAY_SQL(false);

export interface LoadFenceOverlayOpts {
  /** Overrides the registered L2a fingerprint for this call. */
  holdFingerprint?: ((texts: HoldTexts) => string) | null;
}

/**
 * The overlay for one page's body, one query. No query runs (and the overlay
 * is empty) when the body has no world fence rows. A row with no facts row
 * and no pending declaration is treated as the page's own tier (the import
 * that publishes it inserts it at the writer's tier, which is the page's).
 */
export async function loadFenceChunkOverlay(
  engine: Pick<BrainEngine, 'executeRaw'>,
  page: { sourceId: string; slug: string; compiled_truth: string; timeline?: string | null },
  opts: LoadFenceOverlayOpts = {},
): Promise<FenceChunkOverlay | undefined> {
  const rows = [...worldFenceRows(page.compiled_truth), ...worldFenceRows(page.timeline)];
  if (!rows.length) return undefined;
  const fingerprint = opts.holdFingerprint === undefined ? factHoldFingerprint : opts.holdFingerprint;
  const incoming = rows.map(row => ({ row_num: row.rowNum, claim: row.claim, visibility: row.visibility,
    fp: fingerprint ? fingerprint(fenceRowHoldTexts(row)) : null }));
  const found = await engine.executeRaw<{ row_num: number; page_tier: string | null; row_tier: string | null; purged: boolean; held: boolean }>(
    fingerprint ? OVERLAY_SQL_WITH_HOLDS : OVERLAY_SQL_WITHOUT_HOLDS, [page.sourceId, page.slug, JSON.stringify(incoming)]);
  const pending = pendingRows.getStore();
  const pendingHere = pending && pending.sourceId === page.sourceId && pending.slug === page.slug ? new Set(pending.rowNums) : null;
  const omit = new Set<number>();
  const demote = new Map<number, TrustTier>();
  for (const row of found) {
    const rowNum = Number(row.row_num);
    if (row.purged === true || row.held === true) { omit.add(rowNum); continue; }
    if (!isTrustTier(row.page_tier)) continue;
    const rowTier = pendingHere?.has(rowNum) ? pending!.tier : isTrustTier(row.row_tier) ? row.row_tier : null;
    if (rowTier && compareTrust(rowTier, row.page_tier) < 0) demote.set(rowNum, rowTier);
  }
  return omit.size || demote.size ? { omit, demote } : undefined;
}
