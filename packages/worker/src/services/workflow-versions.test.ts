import { describe, expect, it, beforeEach } from 'vitest';
import type { WorkflowDefinition } from '@valet/shared';
import { createTestDb } from '../test-utils/db.js';
import { users, workflows } from '../lib/schema/index.js';
import {
  getDraft,
  saveDraft,
  publishDraft,
  listVersions,
  restoreVersion,
  getPublishedDefinition,
  getPublishedDefinitions,
  WorkflowVersionError,
} from './workflow-versions.js';

const USER_ID = 'wv-user';
const WORKFLOW_ID = 'wv-wf';

function makeDef(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    version: 'dag/v1',
    inputs: {},
    nodes: [
      { id: 'start', type: 'set', values: { x: 1 } },
      { id: 'stop', type: 'stop' },
    ],
    edges: [{ from: 'start', to: 'stop' }],
    ...overrides,
  } as WorkflowDefinition;
}

describe('workflow-versions service', () => {
  let db: ReturnType<typeof createTestDb>['db'];

  beforeEach(() => {
    ({ db } = createTestDb());
    db.insert(users).values({ id: USER_ID, email: 'u@e.io' }).run();
    db.insert(workflows).values({
      id: WORKFLOW_ID,
      userId: USER_ID,
      name: 'demo',
      version: '0',
      data: '{}',
    }).run();
  });

  it('saves and returns drafts', async () => {
    const def = makeDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def, { layout: 'demo' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got = await getDraft(db as any, WORKFLOW_ID);
    expect(got.draft).toEqual(def);
    expect(got.ui).toEqual({ layout: 'demo' });
    expect(got.publishedVersionId).toBeNull();
  });

  it('rejects publishing when no draft exists', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID }),
    ).rejects.toBeInstanceOf(WorkflowVersionError);
  });

  it('rejects publishing an invalid draft', async () => {
    // Invalid: stop has no incoming edge from start and references unknown
    // node "missing".
    const bad = makeDef({
      edges: [{ from: 'missing', to: 'stop' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, bad);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowVersionError);
      expect((err as WorkflowVersionError).code).toBe('invalid_definition');
      expect((err as WorkflowVersionError).errors).toBeTruthy();
    }
  });

  it('rejects publishing when env-validation fails (llm provider key missing)', async () => {
    const def = makeDef({
      nodes: [
        { id: 'extract', type: 'llm', model: 'anthropic:claude-3-5-sonnet', prompt: 'do it', maxOutputTokens: 100 },
        { id: 'stop', type: 'stop' },
      ],
      edges: [{ from: 'extract', to: 'stop' }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def);
    try {
      // env={} has no provider keys configured
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID, env: {} as any });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowVersionError);
      expect((err as WorkflowVersionError).code).toBe('invalid_definition');
      const errors = (err as WorkflowVersionError).errors ?? [];
      expect(errors.some((e) => e.code === 'llm_provider_key_missing')).toBe(true);
    }
  });

  it('publishes a clean draft + bumps version', async () => {
    const def = makeDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1 = await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID, publishNote: 'v1' });
    expect(r1.version.version).toBe(1);
    expect(r1.version.publishNote).toBe('v1');
    expect(r1.version.definitionHash).toMatch(/^[0-9a-f]{64}$/);

    // Re-saving + republishing bumps to v2.
    const def2 = makeDef({
      nodes: [
        { id: 'start', type: 'set', values: { x: 2 } },
        { id: 'stop', type: 'stop' },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r2 = await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
    expect(r2.version.version).toBe(2);
    expect(r2.version.definitionHash).not.toEqual(r1.version.definitionHash);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const versions = await listVersions(db as any, WORKFLOW_ID);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const published = await getPublishedDefinition(db as any, WORKFLOW_ID);
    expect(published).toEqual(def2);
  });

  it('restore copies an old version back into the draft', async () => {
    const def1 = makeDef();
    const def2 = makeDef({
      nodes: [
        { id: 'start', type: 'set', values: { x: 2 } },
        { id: 'stop', type: 'stop' },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r1 = await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });

    // Restore v1 — draft should become def1 again, published still def2.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const restored = await restoreVersion(db as any, WORKFLOW_ID, r1.version.id);
    expect(restored.draft).toEqual(def1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draftNow = await getDraft(db as any, WORKFLOW_ID);
    expect(draftNow.draft).toEqual(def1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const published = await getPublishedDefinition(db as any, WORKFLOW_ID);
    expect(published).toEqual(def2);
  });

  it('throws on unknown workflow id', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getDraft(db as any, 'does-not-exist'),
    ).rejects.toBeInstanceOf(WorkflowVersionError);
  });

  it('refuses to publish over a non-dag/v1 workflows.data', async () => {
    // Seed a non-dag/v1 definition (e.g. an older 'steps' shape).
    db.update(workflows).set({ data: JSON.stringify({ version: 'steps', steps: [] }) })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .where(((await import('drizzle-orm')).eq)(workflows.id, WORKFLOW_ID)).run();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, makeDef());
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowVersionError);
      expect((err as WorkflowVersionError).code).toBe('invalid_definition');
    }
  });

  it('getPublishedDefinitions returns null for unpublished + published def for published', async () => {
    // Workflow 1: not published, has data only.
    db.insert(workflows).values({
      id: 'wf-2',
      userId: USER_ID,
      name: 'two',
      version: '0',
      data: '{}',
    }).run();
    // Workflow WORKFLOW_ID: publish a clean draft.
    const def = makeDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = await getPublishedDefinitions(db as any, [WORKFLOW_ID, 'wf-2', 'missing']);
    expect(map.get(WORKFLOW_ID)).toEqual(def);
    expect(map.get('wf-2')).toBeNull();
    expect(map.has('missing')).toBe(false);
  });

  it('after-publish drift: list/detail readers must see the published version, not workflows.data', async () => {
    const published = makeDef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, published);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });

    // Simulate workflows.data going stale (e.g., a /sync write before
    // the guard, or a manual DB edit).
    const stale = JSON.stringify({ version: 'dag/v1', nodes: [{ id: 'mutated', type: 'stop' }], edges: [] });
    db.update(workflows).set({ data: stale })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .where(((await import('drizzle-orm')).eq)(workflows.id, WORKFLOW_ID)).run();

    // Both the single + batched readers must return the PUBLISHED def, not the stale one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const single = await getPublishedDefinition(db as any, WORKFLOW_ID);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batched = await getPublishedDefinitions(db as any, [WORKFLOW_ID]);
    expect(single).toEqual(published);
    expect(batched.get(WORKFLOW_ID)).toEqual(published);
  });

  it('snapshots ui at publish time and restores it', async () => {
    const def = makeDef();
    const ui = { nodes: { start: { x: 10, y: 20 } } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def, ui);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await publishDraft(db as any, WORKFLOW_ID, { userId: USER_ID });
    // Edit the draft + ui to something else (simulate moving nodes).
    const def2 = makeDef({
      nodes: [
        { id: 'start', type: 'set', values: { x: 99 } },
        { id: 'stop', type: 'stop' },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await saveDraft(db as any, WORKFLOW_ID, def2, { nodes: { start: { x: 500, y: 600 } } });
    // Restore the first version — ui should come back AND be inlined
    // into the returned draft (so clients reading draft.ui directly
    // don't see undefined).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const restored = await restoreVersion(db as any, WORKFLOW_ID, r.version.id);
    expect(restored.draft).toMatchObject({ ...def, ui });
    expect(restored.ui).toEqual(ui);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await getDraft(db as any, WORKFLOW_ID);
    expect(after.ui).toEqual(ui);
    expect((after.draft as { ui?: unknown }).ui).toEqual(ui);
  });
});
