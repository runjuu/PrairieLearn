import fs from 'node:fs/promises';
import path from 'node:path';

import Docker from 'dockerode';
import { split as shlexSplit } from 'shlex';

import { config } from '../config.js';

import {
  type PreviewWorkspaceGradedFilesLimits,
  type PreviewWorkspaceGradedFilesResult,
  collectPreviewWorkspaceGradedFiles,
  generatePreviewWorkspaceFiles,
  makePreviewWorkspaceHomeDir,
} from './workspace-files.js';
import {
  LocalPreviewWorkspaces,
  type PreviewWorkspaceSettings,
  type PreviewWorkspaceSpec,
} from './workspace-registry.js';

const PREVIEW_WORKSPACE_CONTAINER_LABEL = 'com.prairielearn.preview-workspace';
const PREVIEW_WORKSPACE_HOME_ROOT_LABEL = 'com.prairielearn.preview-workspace.home-root';
const PREVIEW_WORKSPACE_ID_LABEL = 'com.prairielearn.preview-workspace.id';
const PREVIEW_WORKSPACE_PID_LABEL = 'com.prairielearn.preview-workspace.pid';
const PREVIEW_WORKSPACE_VERSION_LABEL = 'com.prairielearn.preview-workspace.version';

const WORKSPACE_HOME_IMAGE_LABEL = 'com.prairielearn.workspace.home';
const WORKSPACE_PORT_IMAGE_LABEL = 'com.prairielearn.workspace.port';

export type PreviewWorkspacePullPolicy = 'always' | 'missing' | 'never';

export interface PreviewWorkspaceContainerCreateOptions {
  Cmd?: string[];
  Env: string[];
  ExposedPorts: Record<string, Record<string, never>>;
  HostConfig: {
    Binds: string[];
    NetworkMode: string;
    PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
  };
  Image: string;
  Labels: Record<string, string>;
}

interface PreviewWorkspaceContainer {
  inspect(): Promise<{
    NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | undefined> };
  }>;
  remove(options?: { force?: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
}

export interface PreviewWorkspaceContainerInfo {
  Id: string;
  Labels: Record<string, string>;
}

export interface PreviewWorkspaceDockerClient {
  createContainer(
    options: PreviewWorkspaceContainerCreateOptions,
  ): Promise<PreviewWorkspaceContainer>;
  getContainer(id: string): PreviewWorkspaceContainer;
  getImage(name: string): {
    inspect(): Promise<{ Config: { Labels?: Record<string, string> | null } }>;
  };
  listContainers(options: {
    all: boolean;
    filters: Record<string, string[]>;
  }): Promise<PreviewWorkspaceContainerInfo[]>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null) => void,
      onProgress: (event: PreviewWorkspacePullProgressEvent) => void,
    ): void;
  };
  ping(): Promise<unknown>;
  pull(image: string): Promise<NodeJS.ReadableStream>;
}

export interface PreviewWorkspacePullProgressEvent {
  id?: string;
  progressDetail?: { current?: number; total?: number };
  status?: string;
}

type PreviewWorkspaceFetch = (url: string, init: { signal: AbortSignal }) => Promise<unknown>;

/** The subset of workspace operations the document renderer depends on. */
export interface PreviewWorkspaceAllocator {
  collectGradedFiles(input: {
    qid: string;
    variantSeed: string;
  }): Promise<PreviewWorkspaceGradedFilesResult>;
  ensureWorkspace(spec: PreviewWorkspaceSpec): { workspaceId: string; workspaceUrl: string };
}

export interface PreviewWorkspaceManagerOptions {
  courseDir: string;
  docker?: PreviewWorkspaceDockerClient;
  fetchFn?: PreviewWorkspaceFetch;
  gradedFilesLimits?: PreviewWorkspaceGradedFilesLimits;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  homeRoot: string;
  idleSweepIntervalMs?: number;
  idleTimeoutMs: number;
  logger?: (message: string) => void;
  maxRunningContainers: number;
  now?: () => number;
  pid?: number;
  pullPolicy: PreviewWorkspacePullPolicy;
  startTimeoutMs: number;
  urlPrefix?: string;
}

export interface PreviewWorkspaceManager extends PreviewWorkspaceAllocator {
  close(): Promise<void>;
  heartbeat(id: string): void;
  pruneOrphans(): Promise<string[]>;
  reboot(id: string): Promise<void>;
  requestLaunch(id: string): Promise<void>;
  reset(id: string): Promise<void>;
  resolveContainerTarget(id: string): { hostPort: number; rewriteUrl: boolean } | null;
  sweepIdle(): Promise<void>;
  workspaces: LocalPreviewWorkspaces;
}

/**
 * Produces monotonically increasing pull percentages from Docker pull
 * progress events. Adapted from the workspace host's `_pullImage`: totals grow
 * as new layers are discovered, so percentages are computed as increments
 * above a moving base to guarantee they never decrease.
 */
export function createPullProgressTracker() {
  const progressDetails: Record<string, { current: number; total: number }> = {};
  let currentBase = 0;
  let fraction = 0;
  let fractionBase = 0;
  let lastPercent = -1;
  let outputCount = 0;
  let total = 0;

  return {
    /** Returns the new percentage when it increased, or null otherwise. */
    observe(event: PreviewWorkspacePullProgressEvent): number | null {
      if (event.id != null && event.progressDetail?.total) {
        progressDetails[`${event.id}/${event.status}`] = {
          current: event.progressDetail.current ?? 0,
          total: event.progressDetail.total,
        };
      }

      const details = Object.values(progressDetails);
      let current = details.reduce((sum, detail) => sum + detail.current, 0);
      const newTotal = details.reduce((sum, detail) => sum + detail.total, 0);

      // Limit progress initially to wait for most layers to be seen.
      if (outputCount <= 200) current = Math.min(current, (outputCount / 200) * newTotal);
      if (newTotal > total) {
        total = newTotal;
        currentBase = current;
        fractionBase = fraction;
      }
      if (total === 0) return null;

      outputCount++;
      const fractionIncrement =
        total > currentBase ? (current - currentBase) / (total - currentBase) : 0;
      fraction = fractionBase + (1 - fractionBase) * fractionIncrement;
      const percent = Math.floor(fraction * 100);
      if (percent <= lastPercent) return null;

      lastPercent = percent;
      return percent;
    },
  };
}

/**
 * Resolves the container home directory and port from question settings,
 * falling back to the image labels the maintained workspace images provide.
 */
export function resolveHomeAndPort(
  settings: PreviewWorkspaceSettings,
  imageLabels: Record<string, string> | null | undefined,
): { containerHome: string; containerPort: number } {
  const home = settings.home ?? imageLabels?.[WORKSPACE_HOME_IMAGE_LABEL];
  const portValue = settings.port ?? imageLabels?.[WORKSPACE_PORT_IMAGE_LABEL];

  if (home == null) {
    throw new Error(
      'Workspace home directory is not specified in question settings or image labels.',
    );
  }
  if (portValue == null) {
    throw new Error('Workspace port is not specified in question settings or image labels.');
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Workspace port is not a valid port number.');
  }

  return { containerHome: home, containerPort: port };
}

/**
 * Decides whether a labeled preview workspace container is an orphan that
 * should be removed at startup. Containers owned by another live preview
 * server are left alone; containers from dead processes or from a previous
 * run against the same home root are pruned.
 */
export function shouldPruneContainer(
  labels: Record<string, string>,
  { isPidAlive, ownHomeRoot }: { isPidAlive: (pid: number) => boolean; ownHomeRoot: string },
): boolean {
  if (labels[PREVIEW_WORKSPACE_CONTAINER_LABEL] !== 'true') return false;
  if (labels[PREVIEW_WORKSPACE_HOME_ROOT_LABEL] === ownHomeRoot) return true;

  const pid = Number(labels[PREVIEW_WORKSPACE_PID_LABEL]);
  if (!Number.isInteger(pid) || pid <= 0) return true;

  return !isPidAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDockerNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'statusCode' in err && err.statusCode === 404;
}

function makeEnvironment({
  containerUrl,
  settings,
}: {
  containerUrl: string;
  settings: PreviewWorkspaceSettings;
}): string[] {
  const environment: Record<string, string | null> = { ...settings.environment , WORKSPACE_BASE_URL: containerUrl,};
  if (!settings.enableNetworking) environment.WORKSPACE_NETWORKING_DISABLED = '1';

  return Object.entries(environment).map(([name, value]) =>
    value === null ? name : `${name}=${value}`,
  );
}

interface OwnedContainer {
  container: PreviewWorkspaceContainer;
  generation: number;
}

class PreviewWorkspaceManagerImpl implements PreviewWorkspaceManager {
  readonly workspaces: LocalPreviewWorkspaces;

  private closed = false;
  private readonly containers = new Map<string, OwnedContainer>();
  private readonly courseDir: string;
  private readonly docker: PreviewWorkspaceDockerClient;
  private readonly fetchFn: PreviewWorkspaceFetch;
  private readonly gradedFilesLimits: PreviewWorkspaceGradedFilesLimits;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly homeRoot: string;
  private readonly idleSweepTimer: NodeJS.Timeout;
  private readonly idleTimeoutMs: number;
  private readonly logger: (message: string) => void;
  private readonly maxRunningContainers: number;
  private readonly now: () => number;
  private readonly pendingLaunches = new Map<string, Promise<void>>();
  private readonly pid: number;
  private readonly pullPolicy: PreviewWorkspacePullPolicy;
  private readonly startTimeoutMs: number;

  constructor(options: PreviewWorkspaceManagerOptions) {
    this.courseDir = options.courseDir;
    this.docker = options.docker ?? new Docker();
    this.fetchFn = options.fetchFn ?? fetch;
    this.gradedFilesLimits = options.gradedFilesLimits ?? {
      maxFiles: config.workspaceMaxGradedFilesCount,
      maxSize: config.workspaceMaxGradedFilesSize,
    };
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 1000;
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 10_000;
    this.homeRoot = options.homeRoot;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.logger = options.logger ?? (() => {});
    this.maxRunningContainers = options.maxRunningContainers;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.pullPolicy = options.pullPolicy;
    this.startTimeoutMs = options.startTimeoutMs;
    this.workspaces = new LocalPreviewWorkspaces({
      now: this.now,
      urlPrefix: options.urlPrefix,
    });

    this.idleSweepTimer = setInterval(
      () => void this.sweepIdle(),
      options.idleSweepIntervalMs ?? 60_000,
    );
    this.idleSweepTimer.unref();
  }

  ensureWorkspace(spec: PreviewWorkspaceSpec) {
    return this.workspaces.ensureWorkspace(spec);
  }

  async collectGradedFiles({ qid, variantSeed }: { qid: string; variantSeed: string }) {
    const entry = this.workspaces.getByKey(qid, variantSeed);
    if (entry == null) return { files: [], ok: true as const };

    return await collectPreviewWorkspaceGradedFiles({
      gradedFiles: entry.spec.settings.gradedFiles,
      homeDir: makePreviewWorkspaceHomeDir(this.homeRoot, entry.id, entry.version),
      limits: this.gradedFilesLimits,
    });
  }

  heartbeat(id: string) {
    this.workspaces.touch(id);
  }

  resolveContainerTarget(id: string) {
    const entry = this.workspaces.get(id);
    if (entry?.state !== 'running' || entry.hostPort == null) return null;

    return { hostPort: entry.hostPort, rewriteUrl: entry.spec.settings.rewriteUrl };
  }

  requestLaunch(id: string): Promise<void> {
    const launch = this.workspaces.beginLaunch(id);
    if (launch == null) return this.pendingLaunches.get(id) ?? Promise.resolve();

    const launchPromise = this.runLaunch(id, launch.generation)
      .catch(async (err) => {
        this.logger(`Workspace ${id} failed to launch: ${errorMessage(err)}`);
        const applied = this.workspaces.transition(id, launch.generation, {
          message: `Workspace failed to launch: ${errorMessage(err)}`,
          state: 'failed',
        });
        if (applied) await this.teardownContainer(id, launch.generation);
      })
      .finally(() => {
        if (this.pendingLaunches.get(id) === launchPromise) this.pendingLaunches.delete(id);
      });
    this.pendingLaunches.set(id, launchPromise);

    return launchPromise;
  }

  async reboot(id: string) {
    const entry = this.workspaces.get(id);
    if (entry == null) return;

    this.workspaces.forceState(id, { message: 'Rebooting workspace.', state: 'stopped' });
    await this.teardownContainer(id);
    void this.requestLaunch(id);
  }

  async reset(id: string) {
    const entry = this.workspaces.get(id);
    if (entry == null) return;

    this.workspaces.forceState(id, { message: 'Workspace reset.', state: 'uninitialized' });
    await this.teardownContainer(id);
    const homeDir = makePreviewWorkspaceHomeDir(this.homeRoot, entry.id, entry.version);
    await fs.rm(path.dirname(homeDir), { force: true, recursive: true });
    this.workspaces.bumpVersion(id);
  }

  async sweepIdle() {
    const idleCutoff = this.now() - this.idleTimeoutMs;
    for (const entry of this.workspaces.list()) {
      if (entry.state !== 'running' || entry.lastActivityAt > idleCutoff) continue;

      this.logger(`Stopping idle workspace ${entry.id}.`);
      await this.stopWorkspace(entry.id, 'Workspace stopped due to inactivity.');
    }
  }

  async pruneOrphans(): Promise<string[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${PREVIEW_WORKSPACE_CONTAINER_LABEL}=true`] },
    });

    const removedIds: string[] = [];
    for (const containerInfo of containers) {
      const prune = shouldPruneContainer(containerInfo.Labels, {
        isPidAlive: isProcessAlive,
        ownHomeRoot: this.homeRoot,
      });
      if (!prune) continue;

      await this.docker.getContainer(containerInfo.Id).remove({ force: true });
      removedIds.push(containerInfo.Id);
    }

    return removedIds;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.idleSweepTimer);

    // Invalidating every launch generation first makes in-flight launches
    // abort at their next checkpoint instead of running to completion.
    await Promise.all(
      this.workspaces.list().map(async (entry) => {
        this.workspaces.forceState(entry.id, {
          message: 'Preview server stopped.',
          state: 'stopped',
        });
        await this.teardownContainer(entry.id);
      }),
    );
    await Promise.all(this.pendingLaunches.values());
  }

  private async stopWorkspace(id: string, message: string) {
    this.workspaces.forceState(id, { message, state: 'stopped' });
    await this.teardownContainer(id);
  }

  /**
   * Removes the container owned for a workspace. When `generation` is given,
   * only that launch's container is removed, so a stale launch cannot tear
   * down a container created by a newer launch of the same workspace.
   */
  private async teardownContainer(id: string, generation?: number) {
    const owned = this.containers.get(id);
    if (owned == null || (generation != null && owned.generation !== generation)) return;

    this.containers.delete(id);
    try {
      await owned.container.remove({ force: true });
    } catch (err) {
      this.logger(`Failed to remove workspace ${id} container: ${errorMessage(err)}`);
    }
  }

  private async runLaunch(id: string, generation: number) {
    const entry = this.workspaces.get(id);
    if (entry == null) return;
    const { spec, version } = entry;
    const step = (message: string) => this.workspaces.transition(id, generation, { message });

    try {
      await this.docker.ping();
    } catch (err) {
      this.workspaces.transition(id, generation, {
        message: `Docker is not reachable: ${errorMessage(err)}`,
        state: 'failed',
      });
      return;
    }

    await this.makeRoomForContainer();

    if (!step('Checking image.')) return;
    const imageLabels = await this.ensureImage(id, generation, spec.settings.image);
    if (imageLabels === false) return;
    const { containerHome, containerPort } = resolveHomeAndPort(spec.settings, imageLabels);

    const homeDir = makePreviewWorkspaceHomeDir(this.homeRoot, id, version);
    const homeDirExists = await fs.access(homeDir).then(
      () => true,
      () => false,
    );
    if (!homeDirExists) {
      if (!step('Preparing workspace files.')) return;
      const { fileGenerationErrors } = await generatePreviewWorkspaceFiles({
        courseDir: this.courseDir,
        homeDir,
        params: spec.params,
        qid: spec.qid,
        trueAnswer: spec.trueAnswer,
      });
      this.workspaces.setFileGenerationErrors(id, fileGenerationErrors);
    }

    if (!step('Creating container.')) return;
    const container = await this.docker.createContainer({
      Cmd: spec.settings.args == null ? undefined : shlexSplit(spec.settings.args),
      Env: makeEnvironment({
        containerUrl: this.workspaces.containerUrl(id),
        settings: spec.settings,
      }),
      ExposedPorts: { [`${containerPort}/tcp`]: {} },
      HostConfig: {
        Binds: [`${homeDir}:${containerHome}`],
        NetworkMode: 'bridge',
        PortBindings: { [`${containerPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
      },
      Image: spec.settings.image,
      Labels: {
        [PREVIEW_WORKSPACE_CONTAINER_LABEL]: 'true',
        [PREVIEW_WORKSPACE_HOME_ROOT_LABEL]: this.homeRoot,
        [PREVIEW_WORKSPACE_ID_LABEL]: id,
        [PREVIEW_WORKSPACE_PID_LABEL]: String(this.pid),
        [PREVIEW_WORKSPACE_VERSION_LABEL]: String(version),
      },
    });
    if (this.workspaces.get(id)?.launchGeneration !== generation) {
      // Superseded while the container was being created; it was never
      // registered, so remove it directly.
      try {
        await container.remove({ force: true });
      } catch (err) {
        this.logger(`Failed to remove workspace ${id} container: ${errorMessage(err)}`);
      }
      return;
    }
    this.containers.set(id, { container, generation });

    if (!step('Starting container.')) {
      await this.teardownContainer(id, generation);
      return;
    }
    await container.start();

    const inspectInfo = await container.inspect();
    const hostPort = Number(
      inspectInfo.NetworkSettings.Ports[`${containerPort}/tcp`]?.[0]?.HostPort,
    );
    if (!Number.isInteger(hostPort) || hostPort <= 0) {
      throw new Error('Docker did not assign a host port to the workspace container.');
    }

    if (!step('Waiting for the workspace to respond.')) {
      await this.teardownContainer(id, generation);
      return;
    }
    const healthy = await this.waitForServer(id, generation, hostPort);
    if (!healthy) {
      await this.teardownContainer(id, generation);
      return;
    }

    if (
      !this.workspaces.transition(id, generation, {
        hostPort,
        message: 'Workspace is running.',
        state: 'running',
      })
    ) {
      await this.teardownContainer(id, generation);
    }
  }

  /**
   * Makes the workspace image available per the pull policy and returns its
   * labels, or false when the launch was superseded while pulling.
   */
  private async ensureImage(
    id: string,
    generation: number,
    image: string,
  ): Promise<Record<string, string> | null | false> {
    const inspectImage = async () => {
      try {
        return (await this.docker.getImage(image).inspect()).Config.Labels ?? null;
      } catch (err) {
        if (isDockerNotFoundError(err)) return false;
        throw err;
      }
    };

    if (this.pullPolicy !== 'always') {
      const labels = await inspectImage();
      if (labels !== false) return labels;
      if (this.pullPolicy === 'never') {
        throw new Error(
          `Workspace image "${image}" is not present locally and the pull policy is "never".`,
        );
      }
    }

    this.logger(`Pulling workspace image ${image}.`);
    const stream = await this.docker.pull(image);
    const tracker = createPullProgressTracker();
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event) => {
          const percent = tracker.observe(event);
          if (percent != null) {
            this.workspaces.transition(id, generation, { message: `Pulling image (${percent}%).` });
          }
        },
      );
    });

    if (this.workspaces.get(id)?.launchGeneration !== generation) return false;

    const labels = await inspectImage();
    if (labels === false) {
      throw new Error(`Workspace image "${image}" is not available after pulling.`);
    }
    return labels;
  }

  private async makeRoomForContainer() {
    while (
      this.workspaces.list().filter((entry) => entry.state === 'running').length >=
      this.maxRunningContainers
    ) {
      const victim = this.workspaces.leastRecentlyActiveRunning();
      if (victim == null) return;

      this.logger(`Stopping workspace ${victim.id} to make room for another workspace.`);
      await this.stopWorkspace(victim.id, 'Workspace stopped to make room for another workspace.');
    }
  }

  /** Returns false when the launch was superseded while waiting. */
  private async waitForServer(id: string, generation: number, hostPort: number) {
    const startTime = this.now();

    for (;;) {
      try {
        await this.fetchFn(`http://127.0.0.1:${hostPort}/`, {
          signal: AbortSignal.timeout(this.healthCheckTimeoutMs),
        });
        // Any response means the workspace server is up; strange status codes
        // are fine.
        return true;
      } catch {
        if (this.workspaces.get(id)?.launchGeneration !== generation) return false;
        if (this.now() - startTime > this.startTimeoutMs) {
          throw new Error('The workspace container did not respond before the startup timeout.');
        }
        await new Promise((resolve) => setTimeout(resolve, this.healthCheckIntervalMs));
      }
    }
  }
}

export function createPreviewWorkspaceManager(
  options: PreviewWorkspaceManagerOptions,
): PreviewWorkspaceManager {
  return new PreviewWorkspaceManagerImpl(options);
}
