import { assert, describe, it } from 'vitest';

import { LocalPreviewWorkspaces, type PreviewWorkspaceSpec } from './workspace-registry.js';

function makeSpec(overrides: Partial<PreviewWorkspaceSpec> = {}): PreviewWorkspaceSpec {
  return {
    params: { starter: 'original' },
    qid: 'demo/workspace',
    settings: {
      args: null,
      enableNetworking: false,
      environment: {},
      gradedFiles: ['starter.py'],
      home: '/home/user',
      image: 'workspace-image',
      port: 8080,
      rewriteUrl: true,
    },
    trueAnswer: {},
    variantSeed: '1',
    ...overrides,
  };
}

describe('local preview workspaces', () => {
  it('allocates stable workspace ids keyed by question and variant seed', () => {
    const workspaces = new LocalPreviewWorkspaces();

    const first = workspaces.ensureWorkspace(makeSpec());
    const again = workspaces.ensureWorkspace(makeSpec());
    const otherSeed = workspaces.ensureWorkspace(makeSpec({ variantSeed: '2' }));
    const otherQid = workspaces.ensureWorkspace(makeSpec({ qid: 'demo/other' }));

    assert.equal(first.workspaceId, '1');
    assert.equal(first.workspaceUrl, '/workspace/1');
    assert.equal(again.workspaceId, '1');
    assert.equal(otherSeed.workspaceId, '2');
    assert.equal(otherQid.workspaceId, '3');
  });

  it('refreshes the stored spec without resetting workspace state', () => {
    const workspaces = new LocalPreviewWorkspaces();
    const { workspaceId } = workspaces.ensureWorkspace(makeSpec());
    const launch = workspaces.beginLaunch(workspaceId);
    assert.isNotNull(launch);
    workspaces.transition(workspaceId, launch.generation, { hostPort: 40100, state: 'running' });

    workspaces.ensureWorkspace(makeSpec({ params: { starter: 'edited' } }));

    const entry = workspaces.get(workspaceId);
    assert.equal(entry?.state, 'running');
    assert.equal(entry?.hostPort, 40100);
    assert.deepEqual(entry?.spec.params, { starter: 'edited' });
  });

  it('collapses concurrent launch requests into a single launch', () => {
    const workspaces = new LocalPreviewWorkspaces();
    const { workspaceId } = workspaces.ensureWorkspace(makeSpec());

    const launch = workspaces.beginLaunch(workspaceId);
    assert.isNotNull(launch);
    assert.equal(workspaces.get(workspaceId)?.state, 'launching');

    assert.isNull(workspaces.beginLaunch(workspaceId));
    workspaces.transition(workspaceId, launch.generation, { hostPort: 40100, state: 'running' });
    assert.isNull(workspaces.beginLaunch(workspaceId));
  });

  it('ignores transitions from a superseded launch', () => {
    const workspaces = new LocalPreviewWorkspaces();
    const { workspaceId } = workspaces.ensureWorkspace(makeSpec());
    const staleLaunch = workspaces.beginLaunch(workspaceId);
    assert.isNotNull(staleLaunch);

    workspaces.forceState(workspaceId, { message: 'Workspace stopped.', state: 'stopped' });
    const applied = workspaces.transition(workspaceId, staleLaunch.generation, {
      hostPort: 40100,
      state: 'running',
    });

    assert.isFalse(applied);
    const entry = workspaces.get(workspaceId);
    assert.equal(entry?.state, 'stopped');
    assert.isNull(entry?.hostPort);
  });

  it('clears the host port when a workspace leaves the running state', () => {
    const workspaces = new LocalPreviewWorkspaces();
    const { workspaceId } = workspaces.ensureWorkspace(makeSpec());
    const launch = workspaces.beginLaunch(workspaceId);
    assert.isNotNull(launch);
    workspaces.transition(workspaceId, launch.generation, { hostPort: 40100, state: 'running' });

    workspaces.forceState(workspaceId, { state: 'stopped' });

    assert.isNull(workspaces.get(workspaceId)?.hostPort);
  });

  it('bumps the version and discards file errors on reset', () => {
    const workspaces = new LocalPreviewWorkspaces();
    const { workspaceId } = workspaces.ensureWorkspace(makeSpec());
    workspaces.setFileGenerationErrors(workspaceId, [
      { file: 'starter.py', msg: 'Error rendering workspace template file' },
    ]);

    assert.equal(workspaces.bumpVersion(workspaceId), 2);

    const entry = workspaces.get(workspaceId);
    assert.equal(entry?.version, 2);
    assert.deepEqual(entry?.fileGenerationErrors, []);
  });

  it('finds the least recently active running workspace', () => {
    let currentTime = 1_000;
    const workspaces = new LocalPreviewWorkspaces({ now: () => currentTime });

    const first = workspaces.ensureWorkspace(makeSpec({ variantSeed: '1' }));
    const second = workspaces.ensureWorkspace(makeSpec({ variantSeed: '2' }));
    const third = workspaces.ensureWorkspace(makeSpec({ variantSeed: '3' }));

    for (const { workspaceId } of [first, second]) {
      const launch = workspaces.beginLaunch(workspaceId);
      assert.isNotNull(launch);
      currentTime += 1_000;
      workspaces.transition(workspaceId, launch.generation, { hostPort: 40100, state: 'running' });
    }

    assert.equal(workspaces.leastRecentlyActiveRunning()?.id, first.workspaceId);

    currentTime += 1_000;
    workspaces.touch(first.workspaceId);
    assert.equal(workspaces.leastRecentlyActiveRunning()?.id, second.workspaceId);

    assert.equal(workspaces.get(third.workspaceId)?.state, 'uninitialized');
  });

  it('builds workspace and container URLs with the configured prefix', () => {
    const workspaces = new LocalPreviewWorkspaces({ urlPrefix: '/preview' });
    const { workspaceId, workspaceUrl } = workspaces.ensureWorkspace(makeSpec());

    assert.equal(workspaceUrl, '/preview/workspace/1');
    assert.equal(workspaces.workspaceUrl(workspaceId), '/preview/workspace/1');
    assert.equal(workspaces.containerUrl(workspaceId), '/preview/workspace/1/container/');
  });

  it('returns null for unknown workspaces', () => {
    const workspaces = new LocalPreviewWorkspaces();

    assert.isNull(workspaces.get('999'));
    assert.isNull(workspaces.getByKey('demo/workspace', '1'));
    assert.isNull(workspaces.beginLaunch('999'));
    assert.isNull(workspaces.bumpVersion('999'));
    assert.isFalse(workspaces.transition('999', 1, { state: 'running' }));
    assert.isFalse(workspaces.forceState('999', { state: 'stopped' }));
  });
});
