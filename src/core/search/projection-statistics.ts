import type { BrainEngine } from '../engine.ts';
import { beginFullAnalyze, plannerAutoAnalyzeEnabled } from '../planner-stats.ts';

export const PROJECTION_STATISTICS_NAME = 'pages_text_projection_current_stats';

export const PROJECTION_STATISTICS_SQL = `
CREATE STATISTICS IF NOT EXISTS ${PROJECTION_STATISTICS_NAME}
  ON ((text_projection_revision = knowledge_revision)) FROM pages;
ANALYZE pages(text_projection_revision, knowledge_revision);
`;

export async function verifyProjectionStatistics(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  const rows = await engine.executeRaw<{
    expression: string;
    correct_table: boolean;
    sampled_rows: number;
    can_inspect: boolean;
    collected: boolean;
  }>(`SELECT pg_get_expr(e.stxexprs, e.stxrelid) AS expression,
       e.stxrelid = 'pages'::regclass AS correct_table,
       p.reltuples AS sampled_rows,
       has_table_privilege(p.oid, 'SELECT') AND NOT row_security_active(p.oid) AS can_inspect,
       x.null_frac IS NOT NULL AS collected
     FROM pg_class p JOIN pg_statistic_ext e ON e.stxnamespace = p.relnamespace
     LEFT JOIN pg_stats_ext_exprs x
       ON x.statistics_schemaname = (SELECT nspname FROM pg_namespace WHERE oid = e.stxnamespace)
       AND x.statistics_name = e.stxname
       AND x.expr = pg_get_expr(e.stxexprs, e.stxrelid)
     WHERE p.oid = 'pages'::regclass AND e.stxname = $1`, [PROJECTION_STATISTICS_NAME]);
  const state = rows[0];
  if (!state || !state.correct_table || state.expression !== '(text_projection_revision = knowledge_revision)') {
    throw new Error('Projection planner statistics are missing or have the wrong definition; the schema migration was not verified.');
  }
  if (!state.can_inspect) {
    throw new Error('Projection planner statistics cannot be inspected by this database role or its row-security policy; run schema maintenance with an authorized maintenance role.');
  }
  if (Number(state.sampled_rows) < 0 || (Number(state.sampled_rows) > 0 && !state.collected)) {
    throw new Error('Projection planner statistics have not been collected; run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner.');
  }
}

/**
 * The content_chunks columns vector search's candidate statement is estimated
 * from: its generation and modality filters (cc.model, cc.modality) and its
 * page join (cc.page_id). Without them Postgres prices each equality at 0.5%,
 * expects a handful of eligible chunks, and sorts every candidate instead of
 * walking the HNSW index: at 1M to 2M chunks that runs past the 8 s vector
 * budget (docs/eval/hnsw-scale-bench.md, "Statistics states and EXPLAIN").
 */
export const CHUNK_STATISTICS_SQL = 'ANALYZE content_chunks(model, modality, page_id)';

/**
 * The Postgres page refresh: the projection columns plus the page columns
 * every search filter reads (`p.deleted_at IS NULL`, source, type and slug
 * scopes). Without `deleted_at` statistics Postgres prices `IS NULL` at 0.5%
 * and drives the vector candidate statement from a few pages into their
 * chunks and a sort, even with content_chunks analyzed. Wide columns
 * (frontmatter, compiled_truth) stay out, so the sample stays cheap.
 */
export const SEARCH_PAGE_STATISTICS_SQL = 'ANALYZE pages(text_projection_revision, knowledge_revision, deleted_at, source_id, type, slug)';

const CHUNK_STATISTICS_WARNING = `[search] Chunk planner statistics could not be refreshed (a lock or the 30 s bound). Vector search may skip its index until autovacuum analyzes content_chunks; run ${CHUNK_STATISTICS_SQL} as the table owner to fix it now.`;

/**
 * The chunk ANALYZE inside a caller's bounded Postgres transaction, behind a
 * savepoint: a concurrent index build holding the table's lock (2 s lock
 * timeout) costs this step alone, never the caller's page statistics. A role
 * that does not own the table gets Postgres's skip warning, not an error.
 */
async function analyzeChunkColumns(tx: BrainEngine): Promise<boolean> {
  await tx.executeRaw('SAVEPOINT chunk_statistics');
  try {
    await tx.executeRaw(CHUNK_STATISTICS_SQL);
    await tx.executeRaw('RELEASE SAVEPOINT chunk_statistics');
    return true;
  } catch {
    await tx.executeRaw('ROLLBACK TO SAVEPOINT chunk_statistics');
    console.warn(CHUNK_STATISTICS_WARNING);
    return false;
  }
}

/**
 * Postgres only (PGLite's planner-stats deltas own its chunk statistics): one
 * bounded narrow ANALYZE of content_chunks after an embed drain, which moves
 * content_chunks.model on every row it embeds. Import, sync and reindex get
 * the same step inside refreshProjectionStatistics.
 */
export async function refreshChunkStatistics(engine: BrainEngine): Promise<boolean> {
  if (engine.kind !== 'postgres') return false;
  try {
    return await engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL statement_timeout = '30s'");
      await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
      return analyzeChunkColumns(tx);
    });
  } catch {
    console.warn(CHUNK_STATISTICS_WARNING);
    return false;
  }
}

/** Runs an embed drain, then refreshes the chunk statistics once when `changed()` says it embedded something (a drain moves content_chunks.model on every row it embeds). */
export async function withChunkStatisticsRefresh<T>(engine: BrainEngine, changed: () => boolean, drain: () => Promise<T>): Promise<T> {
  const out = await drain();
  if (changed()) await refreshChunkStatistics(engine);
  return out;
}

export async function refreshProjectionStatistics(engine: BrainEngine): Promise<boolean> {
  try {
    const [role] = await engine.executeRaw<{ can_analyze: boolean }>(
      `SELECT pg_has_role(current_user, p.relowner, 'USAGE') OR r.rolsuper AS can_analyze
       FROM pg_class p CROSS JOIN pg_roles r
       WHERE p.oid = 'pages'::regclass AND r.rolname = current_user`,
    );
    if (!role?.can_analyze) {
      console.warn('[search] Projection planner statistics were not refreshed: database-owner maintenance is required. Run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner.');
      return false;
    }
    // F4b: `planner.auto_analyze=false` keeps PGLite on the narrow refresh the projection statistics need.
    const full = engine.kind === 'pglite' && await plannerAutoAnalyzeEnabled(engine);
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') {
        await tx.executeRaw("SET LOCAL statement_timeout = '30s'");
        await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
      }
      // PGLite has no autovacuum, so nothing else ever collects planner statistics there. Without them the
      // planner sees empty tables and runs search's graph joins as pages-by-pages nested loops (about 50 s
      // per search on a freshly imported 4,000-page brain; 6 ms after ANALYZE). Postgres keeps the narrow
      // refresh (the search filter columns of pages, then content_chunks behind a savepoint) and leaves the rest to autovacuum.
      // F4b: the full ANALYZE covers every hot table, so it publishes their planner-stats watermarks too.
      const publishWatermarks = full ? await beginFullAnalyze(tx) : async () => {};
      await tx.executeRaw(full ? 'ANALYZE' : engine.kind === 'postgres' ? SEARCH_PAGE_STATISTICS_SQL : 'ANALYZE pages(text_projection_revision, knowledge_revision)');
      if (!full && engine.kind === 'postgres') await analyzeChunkColumns(tx);
      await publishWatermarks();
      await verifyProjectionStatistics(tx);
    });
    return true;
  } catch {
    console.warn('[search] Projection planner statistics could not be refreshed. Run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner; completed page writes were retained.');
    return false;
  }
}
