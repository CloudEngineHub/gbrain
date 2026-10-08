/**
 * Page purge (`gbrain delete <slug> --purge`, #5575 CEO-4/CEO-8): the same
 * live-store sweep as a fact purge, applied to one page inside the
 * coordinated delete transaction, plus a text-free page tombstone.
 *
 * Swept in the transaction: facts filed on the page (each tombstoned in
 * fact_purges), the page's takes (tombstoned in take_purges), take proposals,
 * open loops and core-edit notices keyed to the page, stored intents of
 * finished requests for the slug, and its `files` rows; takes, timeline
 * entries, chunks, versions, links and raw data go by foreign-key cascade
 * with the page row. Stored blobs are deleted after commit (`finishPagePurge`);
 * a blob that cannot be deleted is listed by storage path.
 *
 * `page_purges` keeps (source_id, content_hash, slug): the pages guard raises
 * typed `purged_content` when a page with that content hash is written again
 * under any slug, until `gbrain pages unpurge <slug>` clears it.
 */

import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { WriteRequest } from './model.ts';
import { findRequestsForSlugs, redactRequestIntents } from './intent-redaction.ts';

export const PURGE_RESIDUALS = 'Removed from live stores: the page row with its chunks, versions, takes, timeline, links and raw data, the facts filed on it (tombstoned), '
  + 'its take proposals, open loops and core notices, stored write intents for the slug and its attached file records. Still out of reach: the brain repository\'s '
  + 'git history and every other clone or remote, Markdown exports and compiled context files, backups, provider copies (embeddings, decisions), and deleted rows '
  + 'in database pages and the write-ahead log until vacuum. Rotate any exposed credential.';

function hostOnly(command: string) {
  return opError('trusted_local_only', 'Page purge tombstones are managed only from the trusted local CLI on the brain host.',
    `Ask the user to run \`${command}\` on the brain host.`, { legacy_error: 'permission_denied' });
}

/** Inside the coordinated delete transaction, before the page row is deleted. */
export async function purgePageInTransaction(tx: BrainEngine, row: WriteRequest, snapshot: PageSnapshot): Promise<Record<string, unknown>> {
  const page = snapshot.page, sourceId = row.source_id, slug = page.slug;
  const actor = `${row.principal_kind}:${row.principal_id}`;
  const [stored] = await tx.executeRaw<{ content_hash: string | null }>('SELECT content_hash FROM pages WHERE id=$1', [page.id]);
  const contentHash = stored?.content_hash ?? null;
  if (contentHash) await tx.executeRaw(`INSERT INTO page_purges(source_id,content_hash,slug,request_id) VALUES ($1,$2,$3,$4::uuid)
    ON CONFLICT (source_id,content_hash) DO UPDATE SET slug=EXCLUDED.slug,request_id=EXCLUDED.request_id,purged_at=now()`, [sourceId, contentHash, slug, row.id]);
  await tx.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason)
    SELECT DISTINCT source_id,visibility,COALESCE(entity_slug,'*'),gbrain_fact_fingerprint(fact),$3::uuid,$4,'page purge'
    FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ON CONFLICT DO NOTHING`, [sourceId, slug, row.id, actor]);
  await tx.executeRaw(`INSERT INTO take_purges(source_id,subject,claim_hash,request_id)
    SELECT DISTINCT $1,$2,gbrain_fact_fingerprint(claim),$4::uuid FROM takes WHERE page_id=$3 ON CONFLICT DO NOTHING`, [sourceId, slug, page.id, row.id]);
  const count = async (sql: string, params: unknown[]) => (await tx.executeRaw(sql, params)).length;
  const facts = await count('DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 RETURNING 1', [sourceId, slug]);
  const takeProposals = await count('DELETE FROM take_proposals WHERE source_id=$1 AND page_slug=$2 RETURNING 1', [sourceId, slug]);
  const openLoops = await count('DELETE FROM open_loops WHERE source_id=$1 AND page_slug=$2 RETURNING 1', [sourceId, slug]);
  const notices = await count('DELETE FROM core_edit_notices WHERE source_id=$1 AND slug=$2 RETURNING 1', [sourceId, slug]);
  const requests = await findRequestsForSlugs(tx, sourceId, [slug]);
  const intents = await redactRequestIntents(tx, requests, row.id, { skipPending: true });
  const files = await tx.executeRaw<{ storage_path: string }>(`DELETE FROM files WHERE (page_id=$1 OR (page_slug=$2 AND (source_id=$3 OR source_id IS NULL)))
    RETURNING storage_path`, [page.id, slug, sourceId]);
  const [cascade] = await tx.executeRaw<{ chunks: number; versions: number; takes: number; timeline: number }>(`SELECT
    (SELECT count(*)::int FROM content_chunks WHERE page_id=$1) AS chunks, (SELECT count(*)::int FROM page_versions WHERE page_id=$1) AS versions,
    (SELECT count(*)::int FROM takes WHERE page_id=$1) AS takes, (SELECT count(*)::int FROM timeline_entries WHERE page_id=$1) AS timeline`, [page.id]);
  await tx.deletePage(slug, { sourceId });
  return { status: 'purged', slug, source_id: sourceId, residuals: PURGE_RESIDUALS,
    purge: { content_hash8: contentHash?.slice(0, 8) ?? null, tombstoned: contentHash !== null,
      removed: { facts, take_proposals: takeProposals, open_loops: openLoops, core_edit_notices: notices, persistence_requests: intents,
        files: files.length, content_chunks: cascade?.chunks ?? 0, page_versions: cascade?.versions ?? 0, takes: cascade?.takes ?? 0, timeline_entries: cascade?.timeline ?? 0 },
      blobs: files.map(f => f.storage_path).filter(Boolean) } };
}

/** After commit: delete the purged page's stored blobs; any that remain are listed by storage path. */
export async function finishPagePurge(config: GBrainConfig | undefined, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  const purge = result.purge as { blobs?: string[] } | undefined;
  if (result.status !== 'purged' || !purge?.blobs?.length) return result;
  const remaining: string[] = [];
  try {
    const { createStorage } = await import('../storage.ts');
    const storage = await createStorage((config as { storage?: unknown } | undefined)?.storage as never);
    for (const path of purge.blobs) { try { await storage.delete(path); } catch { remaining.push(path); } }
  } catch { remaining.push(...purge.blobs); }
  return { ...result, purge: { ...purge, blobs_deleted: purge.blobs.length - remaining.length, blobs_remaining: remaining } };
}

/** Prefetch for import screens: every page tombstone of a source, content hash -> slug (bounded). */
export async function readPagePurgeTombstones(engine: BrainEngine, sourceId: string, limit = 10_000): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ content_hash: string; slug: string }>('SELECT content_hash,slug FROM page_purges WHERE source_id=$1 ORDER BY purged_at DESC LIMIT $2', [sourceId, limit]);
  return new Map(rows.map(r => [r.content_hash, r.slug]));
}

export async function listPagePurges(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (ctx.remote !== false) throw hostOnly('gbrain pages purges list');
  const limit = Math.max(1, Math.min(1000, Number(p.limit ?? 100) || 100));
  const rows = await ctx.engine.executeRaw<{ source_id: string; slug: string; content_hash: string; request_id: string | null; purged_at: string }>(`SELECT source_id,slug,
      content_hash,request_id::text,purged_at FROM page_purges WHERE ($1::text IS NULL OR source_id=$1) ORDER BY purged_at DESC LIMIT $2`,
  [typeof p.source_id === 'string' ? p.source_id : null, limit]);
  return { purges: rows.map(r => ({ source_id: r.source_id, slug: r.slug, content_hash8: r.content_hash.slice(0, 8), request_id: r.request_id,
    purged_at: new Date(r.purged_at).toISOString() })), next: rows.length ? 'Clear one with gbrain pages unpurge <slug> [--source <id>].' : 'No page purge tombstones.' };
}

export async function unpurgePage(ctx: OperationContext, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (ctx.remote !== false) throw hostOnly('gbrain pages unpurge <slug>');
  const slug = typeof p.slug === 'string' ? p.slug : '';
  if (!slug) throw opError('invalid_params', 'unpurge needs a slug.', 'Pass the slug gbrain pages purges list shows.');
  const sourceId = typeof p.source_id === 'string' ? p.source_id : ctx.sourceId ?? 'default';
  return ctx.engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    const cleared = await tx.executeRaw<{ request_id: string | null }>('DELETE FROM page_purges WHERE source_id=$1 AND slug=$2 RETURNING request_id::text', [sourceId, slug]);
    const requests = cleared.map(r => r.request_id).filter((id): id is string => !!id);
    const facts = requests.length ? (await tx.executeRaw('DELETE FROM fact_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, requests])).length : 0;
    const takes = requests.length ? (await tx.executeRaw('DELETE FROM take_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, requests])).length : 0;
    return { slug, source_id: sourceId, cleared: cleared.length, fact_tombstones_cleared: facts, take_tombstones_cleared: takes,
      next: cleared.length ? `The next import of ${slug} with its old content is accepted (gbrain sync --source ${sourceId} --no-pull). Nothing was restored.` : `No purge tombstone is recorded for ${slug} in source ${sourceId}.` };
  });
}
