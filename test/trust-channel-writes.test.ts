/**
 * Channel trust tiers on journaled writes (#5575: A3, CEO-12, CEO-21,
 * CEO-26/DX-8, ENG-1, ENG-18).
 *
 * Protects: remote and local agent writes land agent_written; content_origin
 * tool_output lowers to external_untrusted and an unknown value is
 * invalid_params listing the accepted values; an agent page write stamps the
 * lower-only `trust_tier` frontmatter marker; frontmatter markers lower and
 * never raise; an agent rewrite of a higher-tier page lowers it and files one
 * lower_page trust proposal that later edits fold into; a remember fence
 * append keeps the page's tier while the fact gets the writer's tier; the
 * pure channel and marker rules. Runs on PGLite, and on Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import {
  frontmatterTrustCaps, ownerPageTrust, requestChannelTrust, sourceDefaultTier, stampTrustMarker,
} from '../src/core/trust/channel.ts';
import { listTrustProposals } from '../src/core/trust/proposals.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-trust-channel-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => {
  resetGateway();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }
async function brain(engine: BrainEngine): Promise<Brain> {
  const sourceId = `trust-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  await readLocalWriter(engine, 'cli');
  return {
    engine, sourceId,
    remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } },
    local: { ...base, remote: false },
  } as Brain;
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const page = (title: string, body: string, extra = '') => `---\ntype: note\ntitle: ${title}\n${extra}---\n${body}\n`;
async function pageRow(b: Brain, slug: string) {
  const [row] = await b.engine.executeRaw<{ trust_tier: string; frontmatter: Record<string, unknown>; id: number; compiled_truth: string }>(
    'SELECT id, trust_tier, frontmatter, compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]);
  return row;
}
/** An owner page: imported, then classified operator_curated through the deterministic backfill seam. */
async function ownerPage(b: Brain, slug: string, body: string) {
  await run(b.local, 'put_page', { slug, content: page('Owner', body) });
  // Lowering to unknown is always allowed; the backfill may then raise unknown to operator_curated (CEO-10).
  await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], async () => {
    await tx.executeRaw(`UPDATE pages SET trust_tier='unknown', frontmatter = frontmatter - 'trust_tier' - 'source_kind' - 'ingested_via' WHERE source_id=$1 AND slug=$2`, [b.sourceId, slug]);
    await withTrustBackfill(tx, () => tx.executeRaw(`UPDATE pages SET trust_tier='operator_curated' WHERE source_id=$1 AND slug=$2`, [b.sourceId, slug]));
  }, TEST_WRITE_ATTRIBUTION));
  return (await pageRow(b, slug))!;
}

describe('channel tier rules (pure)', () => {
  const row = (operation: string, remote: boolean, intent: Record<string, unknown> = {}) =>
    ({ id: 'r1', operation, authority: { remote } as never, intent });
  test('remote and local agent verbs are agent_written; tool_output lowers; connectors are external; owner and derived intents are left to their preparer', () => {
    expect(requestChannelTrust(row('put_page', true))?.tier).toBe('agent_written');
    expect(requestChannelTrust(row('remember', false))?.tier).toBe('agent_written');
    expect(requestChannelTrust(row('capture', true, { content_origin: 'tool_output' }))?.tier).toBe('external_untrusted');
    expect(requestChannelTrust(row('remember', false, { content_origin: 'user_said' }))?.tier).toBe('agent_written');
    expect(requestChannelTrust(row('submit_job', false, { kind: 'connector_v2_google' }))?.tier).toBe('external_untrusted');
    expect(requestChannelTrust(row('submit_job', false, { kind: 'managed_sync_batch' }))).toBeUndefined();
    expect(requestChannelTrust(row('put_page', false, { kind: 'managed_file_import' }))).toBeUndefined();
    expect(requestChannelTrust(row('put_page', true))?.origin?.channel).toBe('mcp:put_page');
  });
  test('frontmatter markers only lower; sources set-trust never exceeds operator_curated; connector sources are external', () => {
    expect(frontmatterTrustCaps({ trust_tier: 'agent_written' })).toEqual(['agent_written']);
    expect(frontmatterTrustCaps({ source_kind: 'mcp:put_page' })).toEqual(['agent_written']);
    expect(frontmatterTrustCaps({ source_kind: 'webhook' })).toEqual(['external_untrusted']);
    expect(frontmatterTrustCaps({ transcript_import: { harness: 'claude-code' } })).toEqual(['agent_written']);
    expect(frontmatterTrustCaps({ transcript_import: { harness: 'meeting-vendor' } })).toEqual(['external_untrusted']);
    expect(frontmatterTrustCaps({ source_url: 'https://acme-example.com/a', clipped_at: '2026-01-01' })).toEqual(['external_untrusted']);
    expect(ownerPageTrust({ frontmatter: { trust_tier: 'user_confirmed' }, channel: 'sync' }).tier).toBe('operator_curated');
    expect(ownerPageTrust({ frontmatter: {}, channel: 'sync' }).tier).toBe('operator_curated');
    expect(ownerPageTrust({ frontmatter: { trust_tier: 'agent_written' }, channel: 'sync' }).tier).toBe('agent_written');
    expect(ownerPageTrust({ frontmatter: {}, sourceConfig: { kind: 'google' }, channel: 'sync' }).tier).toBe('external_untrusted');
    expect(sourceDefaultTier({ trust_tier: 'user_confirmed' })).toBe('operator_curated');
    expect(sourceDefaultTier({ trust_tier: 'tool_observed' })).toBe('tool_observed');
    expect(stampTrustMarker({}, 'operator_curated')).toEqual({});
    expect(stampTrustMarker({ trust_tier: 'external_untrusted' }, 'agent_written')).toEqual({ trust_tier: 'external_untrusted' });
    expect(stampTrustMarker({ trust_tier: 'agent_written' }, 'external_untrusted')).toEqual({ trust_tier: 'external_untrusted' });
  });
});

describe('channel tiers on journaled writes', () => {
  test('agent page writes are agent_written and stamp the lower-only marker; tool_output lowers to external_untrusted', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      await run(b.remote, 'put_page', { slug: 'notes/remote-example', content: page('Remote', 'From an agent.') });
      const remote = await pageRow(b, 'notes/remote-example');
      expect(remote.trust_tier).toBe('agent_written');
      expect(remote.frontmatter.trust_tier).toBe('agent_written');
      await run(b.local, 'put_page', { slug: 'notes/tool-example', content: page('Tool', 'Pasted web text.'), content_origin: 'tool_output' });
      const tool = await pageRow(b, 'notes/tool-example');
      expect(tool.trust_tier).toBe('external_untrusted');
      expect(tool.frontmatter.trust_tier).toBe('external_untrusted');
      // A hand-typed raising marker is ignored: content cannot claim owner tiers.
      await run(b.local, 'put_page', { slug: 'notes/claims-example', content: page('Claims', 'Claims to be confirmed.', 'trust_tier: user_confirmed\n') });
      expect((await pageRow(b, 'notes/claims-example')).trust_tier).toBe('agent_written');
    }
  }), 60_000);

  test('an unknown content_origin is invalid_params listing the accepted values, on remember and put_page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const b = await brain(engines[0]!);
    const failure = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { code?: string; message: string }; } };
    const remember = await failure(run(b.local, 'remember', { fact: 'Prefers tea', provenance: 'chat', content_origin: 'web' }));
    expect(remember?.code).toBe('invalid_params');
    expect(remember?.message).toContain('user_said, tool_output, inferred');
    const put = await failure(run(b.local, 'put_page', { slug: 'notes/x-example', content: page('X', 'y'), content_origin: 'web' }));
    expect(put?.code).toBe('invalid_params');
    expect(put?.message).toContain('user_said, tool_output, inferred');
  }), 60_000);

  test('remember: the fact is agent_written (external with tool_output); a fence append keeps the owner page tier (ENG-1)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const owner = await ownerPage(b, 'people/alice-example', 'Alice is a person.');
      expect(owner.trust_tier).toBe('operator_curated');
      const saved = await run(b.local, 'remember', { fact: 'Alice prefers green tea', provenance: 'chat', entity: 'people/alice-example' });
      const [fact] = await engine.executeRaw<{ trust_tier: string; write_origin: Record<string, unknown> | string }>('SELECT trust_tier, write_origin FROM facts WHERE id=$1', [Number(saved.id)]);
      expect(fact.trust_tier).toBe('agent_written');
      const fenced = await pageRow(b, 'people/alice-example');
      expect(fenced.compiled_truth).toContain('Alice prefers green tea');
      expect(fenced.trust_tier).toBe('operator_curated');
      const tool = await run(b.remote, 'remember', { fact: 'Alice moved to acme-example', provenance: 'email', entity: 'people/alice-example', content_origin: 'tool_output' });
      const [external] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM facts WHERE id=$1', [Number(tool.id)]);
      expect(external.trust_tier).toBe('external_untrusted');
      expect(await listTrustProposals(engine, { sourceId: b.sourceId, action: 'lower_page' })).toHaveLength(0);
    }
  }), 60_000);

  test('CEO-12: an agent rewrite of an owner page lowers it and files one lower_page proposal that later edits fold into', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'notes/owner-example';
      const owner = await ownerPage(b, slug, 'My own notes.');
      const first = await run(b.remote, 'put_page', { slug, content: page('Owner', 'Rewritten by an agent.'), force: true });
      expect(first.trust_lowered?.proposal_ref).toMatch(/^tp\d+$/);
      expect((await pageRow(b, slug)).trust_tier).toBe('agent_written');
      const [proposal] = await listTrustProposals(engine, { sourceId: b.sourceId, action: 'lower_page' });
      expect(proposal).toMatchObject({ target_table: 'pages', target_id: owner.id, status: 'pending' });
      expect(proposal!.before_state).toMatchObject({ slug, prior_tier: 'operator_curated' });
      expect(typeof proposal!.before_state.version_id).toBe('number');
      const [version] = await engine.executeRaw<{ trust_tier: string; compiled_truth: string }>('SELECT trust_tier, compiled_truth FROM page_versions WHERE id=$1', [proposal!.before_state.version_id]);
      expect(version).toMatchObject({ trust_tier: 'operator_curated' });
      expect(version!.compiled_truth).toContain('My own notes.');
      const second = await run(b.remote, 'put_page', { slug, content: page('Owner', 'Edited again.'), force: true });
      expect(second.trust_lowered?.proposal_ref).toBe(first.trust_lowered.proposal_ref);
      const all = await listTrustProposals(engine, { sourceId: b.sourceId, action: 'lower_page' });
      expect(all).toHaveLength(1);
      expect(all[0]!.after_state.revision).toBe(second.revision);
      // An external page edited by an agent stays external: min(prior, writer), no queue item.
      await run(b.local, 'put_page', { slug: 'notes/web-example', content: page('Web', 'Clipped.'), content_origin: 'tool_output' });
      await run(b.remote, 'put_page', { slug: 'notes/web-example', content: page('Web', 'Clipped. '), force: true });
      expect((await pageRow(b, 'notes/web-example')).trust_tier).toBe('external_untrusted');
      expect(await listTrustProposals(engine, { sourceId: b.sourceId, action: 'lower_page' })).toHaveLength(1);
    }
  }), 90_000);
});
