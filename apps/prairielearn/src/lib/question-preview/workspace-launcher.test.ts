import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, it } from 'vitest';

import {
  type PreviewWorkspaceContainerCreateOptions,
  type PreviewWorkspaceContainerInfo,
  type PreviewWorkspaceDockerClient,
  type PreviewWorkspaceManagerOptions,
  type PreviewWorkspacePullProgressEvent,
  createPreviewWorkspaceManager,
  createPullProgressTracker,
  resolveHomeAndPort,
  shouldPruneContainer,
} from './workspace-launcher.js';
import type { PreviewWorkspaceSettings, PreviewWorkspaceSpec } from './workspace-registry.js';

const IMAGE_NOT_FOUND = Object.assign(new Error('no such image'), { statusCode: 404 });

class FakeContainer {
  removed = false;
  started = false;

  constructor(
    readonly options: PreviewWorkspaceContainerCreateOptions,
    private readonly hostPort: number,
  ) {}

  async inspect() {
    const portKey = Object.keys(this.options.ExposedPorts)[0];
    return {
      NetworkSettings: {
        Ports: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(this.hostPort) }] },
      },
    };
  }

  async remove() {
    this.removed = true;
  }

  async start() {
    this.started = true;
  }
}

class FakeDockerClient implements PreviewWorkspaceDockerClient {
  containers: FakeContainer[] = [];
  images = new Map<string, Record<string, string>>();
  listedContainers: PreviewWorkspaceContainerInfo[] = [];
  pingError: Error | null = null;
  pullCount = 0;
  pulledImageLabels: Record<string, string> = {};
  removedContainerIds: string[] = [];
  private nextHostPort = 40100;

  readonly modem = {
    followProgress: (
      _stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null) => void,
      _onProgress: (event: PreviewWorkspacePullProgressEvent) => void,
    ) => {
      onFinished(null);
    },
  };

  async createContainer(options: PreviewWorkspaceContainerCreateOptions) {
    const container = new FakeContainer(options, this.nextHostPort++);
    this.containers.push(container);
    return container;
  }

  getContainer(id: string) {
    return {
      inspect: () => Promise.reject(new Error('not implemented')),
      remove: async () => {
        this.removedContainerIds.push(id);
      },
      start: () => Promise.resolve(),
    };
  }

  getImage(name: string) {
    return {
      inspect: async () => {
        const labels = this.images.get(name);
        if (labels == null) throw IMAGE_NOT_FOUND;
        return { Config: { Labels: labels } };
      },
    };
  }

  async listContainers() {
    return this.listedContainers;
  }

  async ping() {
    if (this.pingError != null) throw this.pingError;
  }

  async pull(image: string) {
    this.pullCount++;
    this.images.set(image, this.pulledImageLabels);
    return null as unknown as NodeJS.ReadableStream;
  }
}

function makeSettings(overrides: Partial<PreviewWorkspaceSettings> = {}): PreviewWorkspaceSettings {
  return {
    args: null,
    enableNetworking: false,
    environment: {},
    gradedFiles: [],
    home: '/home/user',
    image: 'workspace-image',
    port: 8080,
    rewriteUrl: true,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<PreviewWorkspaceSpec> = {}): PreviewWorkspaceSpec {
  return {
    params: {},
    qid: 'demo/workspace',
    settings: makeSettings(),
    trueAnswer: {},
    variantSeed: '1',
    ...overrides,
  };
}

describe('createPullProgressTracker', () => {
  it('produces monotonically increasing percentages', () => {
    const tracker = createPullProgressTracker();
    const percents: number[] = [];

    const layers: PreviewWorkspacePullProgressEvent[] = [
      { id: 'a', progressDetail: { current: 0, total: 100 }, status: 'Downloading' },
      { id: 'a', progressDetail: { current: 50, total: 100 }, status: 'Downloading' },
      { id: 'b', progressDetail: { current: 0, total: 400 }, status: 'Downloading' },
      { id: 'a', progressDetail: { current: 100, total: 100 }, status: 'Downloading' },
      { id: 'b', progressDetail: { current: 400, total: 400 }, status: 'Downloading' },
    ];
    for (const event of layers) {
      const percent = tracker.observe(event);
      if (percent != null) percents.push(percent);
    }

    assert.isNotEmpty(percents);
    for (let i = 1; i < percents.length; i++) {
      assert.isAbove(percents[i], percents[i - 1]);
    }
  });

  it('returns null before any layer totals are known', () => {
    const tracker = createPullProgressTracker();

    assert.isNull(tracker.observe({ status: 'Pulling fs layer' }));
  });
});

describe('resolveHomeAndPort', () => {
  it('prefers question settings over image labels', () => {
    const resolved = resolveHomeAndPort(makeSettings(), {
      'com.prairielearn.workspace.home': '/home/labeled',
      'com.prairielearn.workspace.port': '9999',
    });

    assert.deepEqual(resolved, { containerHome: '/home/user', containerPort: 8080 });
  });

  it('falls back to image labels', () => {
    const resolved = resolveHomeAndPort(makeSettings({ home: null, port: null }), {
      'com.prairielearn.workspace.home': '/home/labeled',
      'com.prairielearn.workspace.port': '9999',
    });

    assert.deepEqual(resolved, { containerHome: '/home/labeled', containerPort: 9999 });
  });

  it('rejects missing or invalid values', () => {
    assert.throws(
      () => resolveHomeAndPort(makeSettings({ home: null }), null),
      /home directory is not specified/,
    );
    assert.throws(
      () => resolveHomeAndPort(makeSettings({ port: null }), {}),
      /port is not specified/,
    );
    assert.throws(
      () =>
        resolveHomeAndPort(makeSettings({ port: null }), {
          'com.prairielearn.workspace.port': 'not-a-port',
        }),
      /not a valid port number/,
    );
  });
});

describe('shouldPruneContainer', () => {
  const isPidAlive = (pid: number) => pid === 1234;

  it('prunes containers from dead processes', () => {
    assert.isTrue(
      shouldPruneContainer(
        {
          'com.prairielearn.preview-workspace': 'true',
          'com.prairielearn.preview-workspace.home-root': '/other/root',
          'com.prairielearn.preview-workspace.pid': '4321',
        },
        { isPidAlive, ownHomeRoot: '/own/root' },
      ),
    );
  });

  it('leaves containers owned by another live preview server', () => {
    assert.isFalse(
      shouldPruneContainer(
        {
          'com.prairielearn.preview-workspace': 'true',
          'com.prairielearn.preview-workspace.home-root': '/other/root',
          'com.prairielearn.preview-workspace.pid': '1234',
        },
        { isPidAlive, ownHomeRoot: '/own/root' },
      ),
    );
  });

  it('prunes containers that share our home root even when the process is alive', () => {
    assert.isTrue(
      shouldPruneContainer(
        {
          'com.prairielearn.preview-workspace': 'true',
          'com.prairielearn.preview-workspace.home-root': '/own/root',
          'com.prairielearn.preview-workspace.pid': '1234',
        },
        { isPidAlive, ownHomeRoot: '/own/root' },
      ),
    );
  });

  it('prunes containers with malformed pid labels and skips unlabeled containers', () => {
    assert.isTrue(
      shouldPruneContainer(
        {
          'com.prairielearn.preview-workspace': 'true',
          'com.prairielearn.preview-workspace.pid': 'garbage',
        },
        { isPidAlive, ownHomeRoot: '/own/root' },
      ),
    );
    assert.isFalse(shouldPruneContainer({}, { isPidAlive, ownHomeRoot: '/own/root' }));
  });
});

describe('preview workspace manager', () => {
  let tempDir: string;
  let docker: FakeDockerClient;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-workspace-launcher-'));
    await fs.mkdir(path.join(tempDir, 'course', 'questions', 'demo/workspace', 'workspace'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tempDir, 'course', 'questions', 'demo/workspace', 'workspace', 'starter.txt'),
      'starter contents',
    );
    docker = new FakeDockerClient();
    docker.images.set('workspace-image', {});
  });

  afterEach(async () => {
    await fs.rm(tempDir, { force: true, recursive: true });
  });

  function makeManager(overrides: Partial<PreviewWorkspaceManagerOptions> = {}) {
    return createPreviewWorkspaceManager({
      courseDir: path.join(tempDir, 'course'),
      docker,
      fetchFn: () => Promise.resolve(),
      gradedFilesLimits: { maxFiles: 100, maxSize: 100 * 1024 * 1024 },
      homeRoot: path.join(tempDir, 'homes'),
      idleTimeoutMs: 60_000,
      maxRunningContainers: 3,
      pullPolicy: 'missing',
      startTimeoutMs: 5_000,
      ...overrides,
    });
  }

  it('launches a workspace container and reaches the running state', async () => {
    const manager = makeManager();
    const { workspaceId } = manager.ensureWorkspace(
      makeSpec({
        settings: makeSettings({
          args: '--port 8080',
          environment: { GREETING: 'hi', UNSET: null },
        }),
      }),
    );

    await manager.requestLaunch(workspaceId);

    const entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'running');
    assert.deepEqual(entry?.target, { host: '127.0.0.1', port: 40100 });

    const container = docker.containers[0];
    assert.isTrue(container.started);
    assert.equal(container.options.HostConfig.NetworkMode, 'bridge');
    assert.isUndefined(container.options.NetworkingConfig);
    assert.deepEqual(container.options.Cmd, ['--port', '8080']);
    assert.includeMembers(container.options.Env, [
      'GREETING=hi',
      'UNSET',
      `WORKSPACE_BASE_URL=/workspace/${workspaceId}/container/`,
      'WORKSPACE_NETWORKING_DISABLED=1',
    ]);
    assert.deepEqual(container.options.HostConfig.PortBindings, {
      '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
    });
    assert.deepEqual(container.options.HostConfig.Binds, [
      `${path.join(tempDir, 'homes', `workspace-${workspaceId}-1`, 'current')}:/home/user`,
    ]);
    assert.equal(container.options.Labels['com.prairielearn.preview-workspace'], 'true');
    assert.equal(container.options.Labels['com.prairielearn.preview-workspace.id'], workspaceId);

    assert.deepEqual(manager.resolveContainerTarget(workspaceId), {
      host: '127.0.0.1',
      port: 40100,
      rewriteUrl: true,
    });
    const homeDir = path.join(tempDir, 'homes', `workspace-${workspaceId}-1`, 'current');
    assert.equal(await fs.readFile(path.join(homeDir, 'starter.txt'), 'utf8'), 'starter contents');
  });

  it('attaches the workspace to a shared network and targets it by alias', async () => {
    const manager = makeManager({ containerNetwork: 'pl-preview-net' });
    const { workspaceId } = manager.ensureWorkspace(makeSpec());

    await manager.requestLaunch(workspaceId);

    assert.equal(manager.workspaces.get(workspaceId)?.state, 'running');

    const container = docker.containers[0];
    assert.equal(container.options.HostConfig.NetworkMode, 'pl-preview-net');
    assert.isUndefined(container.options.HostConfig.PortBindings);
    assert.deepEqual(container.options.NetworkingConfig, {
      EndpointsConfig: { 'pl-preview-net': { Aliases: [`pl-workspace-${workspaceId}-1`] } },
    });

    assert.deepEqual(manager.resolveContainerTarget(workspaceId), {
      host: `pl-workspace-${workspaceId}-1`,
      port: 8080,
      rewriteUrl: true,
    });
  });

  it('resolves home and port from image labels when unset in the question', async () => {
    docker.images.set('workspace-image', {
      'com.prairielearn.workspace.home': '/home/labeled',
      'com.prairielearn.workspace.port': '9000',
    });
    const manager = makeManager();
    const { workspaceId } = manager.ensureWorkspace(
      makeSpec({ settings: makeSettings({ home: null, port: null }) }),
    );

    await manager.requestLaunch(workspaceId);

    assert.equal(manager.workspaces.get(workspaceId)?.state, 'running');
    assert.match(docker.containers[0].options.HostConfig.Binds[0], /:\/home\/labeled$/);
    assert.property(docker.containers[0].options.HostConfig.PortBindings, '9000/tcp');
  });

  it('pulls the image only when missing under the missing pull policy', async () => {
    const manager = makeManager();
    const first = manager.ensureWorkspace(makeSpec());
    await manager.requestLaunch(first.workspaceId);
    assert.equal(docker.pullCount, 0);

    docker.images.delete('workspace-image');
    docker.pulledImageLabels = {};
    const second = manager.ensureWorkspace(makeSpec({ variantSeed: '2' }));
    await manager.requestLaunch(second.workspaceId);

    assert.equal(docker.pullCount, 1);
    assert.equal(manager.workspaces.get(second.workspaceId)?.state, 'running');
  });

  it('always pulls under the always pull policy', async () => {
    const manager = makeManager({ pullPolicy: 'always' });
    const { workspaceId } = manager.ensureWorkspace(makeSpec());

    await manager.requestLaunch(workspaceId);

    assert.equal(docker.pullCount, 1);
  });

  it('fails when the image is missing under the never pull policy', async () => {
    docker.images.delete('workspace-image');
    const manager = makeManager({ pullPolicy: 'never' });
    const { workspaceId } = manager.ensureWorkspace(makeSpec());

    await manager.requestLaunch(workspaceId);

    const entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'failed');
    assert.match(entry?.message ?? '', /pull policy is "never"/);
    assert.equal(docker.pullCount, 0);
  });

  it('fails fast when Docker is not reachable', async () => {
    docker.pingError = new Error('connect ENOENT /var/run/docker.sock');
    const manager = makeManager();
    const { workspaceId } = manager.ensureWorkspace(makeSpec());

    await manager.requestLaunch(workspaceId);

    const entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'failed');
    assert.match(entry?.message ?? '', /Docker is not reachable/);
    assert.lengthOf(docker.containers, 0);
  });

  it('fails and removes the container when the health check times out', async () => {
    const manager = makeManager({
      fetchFn: () => Promise.reject(new Error('connection refused')),
      healthCheckIntervalMs: 1,
      startTimeoutMs: 0,
    });
    const { workspaceId } = manager.ensureWorkspace(makeSpec());

    await manager.requestLaunch(workspaceId);

    const entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'failed');
    assert.match(entry?.message ?? '', /did not respond before the startup timeout/);
    assert.isTrue(docker.containers[0].removed);
  });

  it('stops idle workspaces during the idle sweep', async () => {
    let currentTime = 0;
    const manager = makeManager({ idleTimeoutMs: 1_000, now: () => currentTime });
    const { workspaceId } = manager.ensureWorkspace(makeSpec());
    await manager.requestLaunch(workspaceId);
    assert.equal(manager.workspaces.get(workspaceId)?.state, 'running');

    currentTime = 500;
    await manager.sweepIdle();
    assert.equal(manager.workspaces.get(workspaceId)?.state, 'running');

    currentTime = 5_000;
    await manager.sweepIdle();

    const entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'stopped');
    assert.match(entry?.message ?? '', /inactivity/);
    assert.isTrue(docker.containers[0].removed);
  });

  it('stops the least recently active workspace to stay under the container cap', async () => {
    let currentTime = 0;
    const manager = makeManager({ maxRunningContainers: 1, now: () => currentTime });
    const first = manager.ensureWorkspace(makeSpec({ variantSeed: '1' }));
    await manager.requestLaunch(first.workspaceId);
    assert.equal(manager.workspaces.get(first.workspaceId)?.state, 'running');

    currentTime = 1_000;
    const second = manager.ensureWorkspace(makeSpec({ variantSeed: '2' }));
    await manager.requestLaunch(second.workspaceId);

    assert.equal(manager.workspaces.get(first.workspaceId)?.state, 'stopped');
    assert.equal(manager.workspaces.get(second.workspaceId)?.state, 'running');
    assert.isTrue(docker.containers[0].removed);
  });

  it('reboots into a fresh container while preserving workspace files', async () => {
    const manager = makeManager();
    const { workspaceId } = manager.ensureWorkspace(makeSpec());
    await manager.requestLaunch(workspaceId);

    const homeDir = path.join(tempDir, 'homes', `workspace-${workspaceId}-1`, 'current');
    await fs.writeFile(path.join(homeDir, 'user-edit.txt'), 'user work');

    await manager.reboot(workspaceId);
    await manager.requestLaunch(workspaceId);

    const entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'running');
    assert.equal(entry?.version, 1);
    assert.isTrue(docker.containers[0].removed);
    assert.lengthOf(docker.containers, 2);
    assert.equal(await fs.readFile(path.join(homeDir, 'user-edit.txt'), 'utf8'), 'user work');
  });

  it('resets to a new version with regenerated files', async () => {
    const manager = makeManager();
    const { workspaceId } = manager.ensureWorkspace(makeSpec());
    await manager.requestLaunch(workspaceId);

    const oldVersionDir = path.join(tempDir, 'homes', `workspace-${workspaceId}-1`);
    await fs.writeFile(path.join(oldVersionDir, 'current', 'user-edit.txt'), 'user work');

    await manager.reset(workspaceId);

    let entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'uninitialized');
    assert.equal(entry?.version, 2);
    assert.isTrue(docker.containers[0].removed);
    assert.isFalse(
      await fs.access(oldVersionDir).then(
        () => true,
        () => false,
      ),
    );

    await manager.requestLaunch(workspaceId);
    entry = manager.workspaces.get(workspaceId);
    assert.equal(entry?.state, 'running');
    const newHomeDir = path.join(tempDir, 'homes', `workspace-${workspaceId}-2`, 'current');
    assert.equal(
      await fs.readFile(path.join(newHomeDir, 'starter.txt'), 'utf8'),
      'starter contents',
    );
  });

  it('prunes orphaned containers from dead processes and our own home root', async () => {
    const manager = makeManager();
    docker.listedContainers = [
      {
        Id: 'dead-process',
        Labels: {
          'com.prairielearn.preview-workspace': 'true',
          'com.prairielearn.preview-workspace.home-root': '/somewhere/else',
          'com.prairielearn.preview-workspace.pid': '999999999',
        },
      },
      {
        Id: 'same-home-root',
        Labels: {
          'com.prairielearn.preview-workspace': 'true',
          'com.prairielearn.preview-workspace.home-root': path.join(tempDir, 'homes'),
          'com.prairielearn.preview-workspace.pid': String(process.pid),
        },
      },
      {
        Id: 'live-other-server',
        Labels: {
          'com.prairielearn.preview-workspace': 'true',
          'com.prairielearn.preview-workspace.home-root': '/somewhere/else',
          'com.prairielearn.preview-workspace.pid': String(process.pid),
        },
      },
    ];

    const removed = await manager.pruneOrphans();

    assert.deepEqual(removed, ['dead-process', 'same-home-root']);
    assert.deepEqual(docker.removedContainerIds, ['dead-process', 'same-home-root']);
  });

  it('collects graded files from the workspace home directory', async () => {
    const manager = makeManager();
    const { workspaceId } = manager.ensureWorkspace(
      makeSpec({ settings: makeSettings({ gradedFiles: ['starter.txt'] }) }),
    );
    await manager.requestLaunch(workspaceId);

    const result = await manager.collectGradedFiles({ qid: 'demo/workspace', variantSeed: '1' });

    assert.isTrue(result.ok);
    assert.lengthOf(result.files, 1);
    assert.equal(result.files[0].name, 'starter.txt');
    assert.equal(Buffer.from(result.files[0].contents, 'base64').toString(), 'starter contents');
  });

  it('returns no graded files for a workspace that was never rendered', async () => {
    const manager = makeManager();

    const result = await manager.collectGradedFiles({ qid: 'demo/unknown', variantSeed: '1' });

    assert.deepEqual(result, { files: [], ok: true });
  });

  it('removes all containers on close', async () => {
    const manager = makeManager();
    const first = manager.ensureWorkspace(makeSpec({ variantSeed: '1' }));
    const second = manager.ensureWorkspace(makeSpec({ variantSeed: '2' }));
    await manager.requestLaunch(first.workspaceId);
    await manager.requestLaunch(second.workspaceId);

    await manager.close();

    assert.isTrue(docker.containers.every((container) => container.removed));
    assert.equal(manager.workspaces.get(first.workspaceId)?.state, 'stopped');
    assert.isNull(manager.resolveContainerTarget(first.workspaceId));
  });
});
