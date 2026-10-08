/**
 * Stamps `trust_tier` + `origin` (eligibility/labels.ts) onto page-derived
 * read rows (search/query hits, evidence, fetch results) after ranking, so
 * label mode never changes ordering (A7). A chunk's tier is its page's tier,
 * lowered to the row tier when its text carries a facts-fence trust marker
 * (fence-overlay.ts, ENG-1); a marker can only lower.
 * One batched lookup per call; a failed lookup labels the rows `unknown` /
 * `unrecorded` rather than dropping them or leaving them unlabeled.
 */
import type { BrainEngine } from '../engine.ts';
import { admitsTrust, compareTrust, type TrustTier } from '../trust/tier.ts';
import { FENCE_TRUST_ORIGIN, lowestFenceTrustMarker } from './fence-overlay.ts';
import { trustFields, type TrustFields } from './labels.ts';

interface PageRef { page_id?: number | null; source_id?: string | null; slug: string; chunk_text?: string | null; trust_tier?: string; origin?: string }

type Exec = Pick<BrainEngine, 'executeRaw'>;

const key = (source: string | null | undefined, slug: string) => `${source ?? 'default'}\u0000${slug}`;

/** Trust fields per page id and per (source_id, slug). */
export async function loadPageTrust(engine: Exec, refs: readonly PageRef[]): Promise<{ byId: Map<number, TrustFields>; byKey: Map<string, TrustFields> }> {
  const byId = new Map<number, TrustFields>();
  const byKey = new Map<string, TrustFields>();
  const ids = [...new Set(refs.map(r => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)))];
  const slugRefs = refs.filter(r => typeof r.page_id !== 'number');
  if (ids.length) {
    const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; trust_tier: string; write_origin: unknown }>(
      'SELECT id, source_id, slug, trust_tier, write_origin FROM pages WHERE id = ANY($1::int[])', [ids]);
    for (const row of rows) {
      const fields = trustFields(row.trust_tier, row.write_origin);
      byId.set(Number(row.id), fields);
      byKey.set(key(row.source_id, row.slug), fields);
    }
  }
  if (slugRefs.length) {
    const rows = await engine.executeRaw<{ source_id: string; slug: string; trust_tier: string; write_origin: unknown }>(
      `SELECT source_id, slug, trust_tier, write_origin FROM pages
        WHERE deleted_at IS NULL AND (source_id, slug) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [slugRefs.map(r => r.source_id ?? 'default'), slugRefs.map(r => r.slug)]);
    for (const row of rows) byKey.set(key(row.source_id, row.slug), trustFields(row.trust_tier, row.write_origin));
  }
  return { byId, byKey };
}

/**
 * Sets `trust_tier` and `origin` on each row in place and returns the rows a
 * floor admits. A row whose text carries a fence trust marker below its
 * page's tier is labeled with the marker tier (origin `facts-fence`) and is
 * held to the floor at that tier. The floor is already applied inside every arm's SQL; this is
 * the backstop for rows a stage adds by slug (exact lookup, alias hop, graph
 * walk), so no row below the floor leaves the operation.
 */
export async function stampPageTrust<T extends PageRef>(engine: Exec, rows: T[], floor?: TrustTier): Promise<T[]> {
  if (rows.length === 0) return rows;
  let found: Awaited<ReturnType<typeof loadPageTrust>> | null = null;
  try { found = await loadPageTrust(engine, rows); } catch { found = null; }
  for (const row of rows) {
    const fields = (typeof row.page_id === 'number' ? found?.byId.get(row.page_id) : undefined)
      ?? found?.byKey.get(key(row.source_id, row.slug))
      ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' };
    const marked = lowestFenceTrustMarker(row.chunk_text);
    const lowered = marked !== null && compareTrust(marked, fields.trust_tier) < 0;
    row.trust_tier = lowered ? marked : fields.trust_tier;
    row.origin = lowered ? FENCE_TRUST_ORIGIN : fields.origin;
  }
  return floor ? rows.filter(row => admitsTrust(row.trust_tier as TrustTier, floor)) : rows;
}
