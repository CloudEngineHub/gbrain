/**
 * #5575: does a failed write's stored intent carry purged content? A write
 * refused for any reason (a permission or revision refusal arrives before the
 * purge guards run), or committed as a no-op after the purge overlay dropped
 * the purged rows, must not keep a copy of content the owner purged, so
 * `completeWrite` nulls the intent of a terminal request when this says yes.
 *
 * Checks the claims a memory or take write names (`fact`, `claim`) and the
 * facts-fence rows of page content against fact_purges, and page content's
 * content hash against page_purges. One indexed probe decides that a source
 * with no tombstones needs no parsing.
 */

import type { BrainEngine } from '../engine.ts';
import { parseMarkdown } from '../markdown.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { contentHash } from '../utils.ts';
import type { WriteRequest } from './model.ts';

export async function intentCarriesPurgedContent(tx: BrainEngine, row: Pick<WriteRequest, 'source_id' | 'slug' | 'intent'>): Promise<boolean> {
  const intent = row.intent as Record<string, unknown> | null;
  // Only content-bearing writes can carry purged text; every other completion skips the probe.
  if (!intent || ![intent.content, intent.fact, intent.claim].some(v => typeof v === 'string' && v)) return false;
  const [has] = await tx.executeRaw<{ facts: boolean; pages: boolean }>(`SELECT EXISTS (SELECT 1 FROM fact_purges WHERE source_id=$1) AS facts,
    EXISTS (SELECT 1 FROM page_purges WHERE source_id=$1) AS pages`, [row.source_id]);
  if (!has?.facts && !has?.pages) return false;
  const content = typeof intent.content === 'string' ? intent.content : null;
  // Tombstones are subject-scoped like the guards: a memory write's claim is about its entity, a fence row about its page.
  const subject = typeof intent.entity_slug === 'string' ? intent.entity_slug : typeof intent.entity === 'string' ? intent.entity : row.slug;
  const claims = [intent.fact, intent.claim].filter((c): c is string => typeof c === 'string' && !!c.trim()).map(claim => ({ claim, subject }));
  let parsed: ReturnType<typeof parseMarkdown> | null = null;
  try { parsed = content ? parseMarkdown(content, `${row.slug}.md`) : null; } catch { parsed = null; }
  if (parsed) for (const body of [parsed.compiled_truth, parsed.timeline ?? '']) claims.push(...parseFactsFence(body).facts.map(f => ({ claim: f.claim, subject: row.slug })));
  if (has.facts && claims.length) {
    const hit = await tx.executeRaw(`SELECT 1 FROM fact_purges p JOIN jsonb_to_recordset($2::text::jsonb) AS c(claim text, subject text)
      ON p.fact_hash=gbrain_fact_fingerprint(c.claim) AND (p.subject='*' OR p.subject=c.subject) WHERE p.source_id=$1 LIMIT 1`,
    [row.source_id, JSON.stringify(claims.slice(0, 1000))]);
    if (hit.length) return true;
  }
  if (has.pages && parsed) {
    const hit = await tx.executeRaw('SELECT 1 FROM page_purges WHERE source_id=$1 AND content_hash=$2 LIMIT 1', [row.source_id, contentHash(parsed)]);
    if (hit.length) return true;
  }
  return false;
}
