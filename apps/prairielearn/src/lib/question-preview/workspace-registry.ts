const WORKSPACE_PATH_PREFIX = '/workspace/';

export type PreviewWorkspaceState =
  | 'uninitialized'
  | 'stopped'
  | 'launching'
  | 'running'
  | 'failed';

export interface PreviewWorkspaceSettings {
  args: string | null;
  enableNetworking: boolean;
  environment: Record<string, string | null>;
  gradedFiles: string[];
  home: string | null;
  image: string;
  port: number | null;
  rewriteUrl: boolean;
}

export interface PreviewWorkspaceSpec {
  params: Record<string, unknown>;
  qid: string;
  settings: PreviewWorkspaceSettings;
  trueAnswer: Record<string, unknown>;
  variantSeed: string;
}

export interface PreviewWorkspaceFileGenerationError {
  file: string;
  msg: string;
}

/**
 * Where the container proxy and health check should reach a running
 * workspace. On the host-published path this is `127.0.0.1` plus the
 * dynamically assigned host port; on the shared-network path it is the
 * container's network alias plus its internal port.
 */
export interface PreviewWorkspaceTarget {
  host: string;
  port: number;
}

export interface PreviewWorkspaceEntry {
  fileGenerationErrors: PreviewWorkspaceFileGenerationError[];
  id: string;
  lastActivityAt: number;
  launchGeneration: number;
  message: string;
  spec: PreviewWorkspaceSpec;
  state: PreviewWorkspaceState;
  target: PreviewWorkspaceTarget | null;
  version: number;
}

export interface PreviewWorkspaceUpdate {
  message?: string;
  state?: PreviewWorkspaceState;
  target?: PreviewWorkspaceTarget | null;
}

function workspaceKey(qid: string, variantSeed: string) {
  return `${qid}\0${variantSeed}`;
}

/**
 * In-memory registry of preview workspaces, keyed by question and variant
 * seed so re-renders of the same variant reuse the same workspace. Owns all
 * workspace state and the launch-generation guard; performs no I/O.
 */
export class LocalPreviewWorkspaces {
  private nextWorkspaceId = 1;
  private readonly entriesById = new Map<string, PreviewWorkspaceEntry>();
  private readonly idsByKey = new Map<string, string>();
  private readonly now: () => number;
  private readonly urlPrefix: string;

  constructor({ now = Date.now, urlPrefix = '' }: { now?: () => number; urlPrefix?: string } = {}) {
    this.now = now;
    this.urlPrefix = urlPrefix;
  }

  /**
   * Returns the workspace for the spec's question and variant seed, creating
   * it if needed. An existing entry keeps its state and version but adopts the
   * latest spec, so source edits are reflected the next time files are
   * generated.
   */
  ensureWorkspace(spec: PreviewWorkspaceSpec): { workspaceId: string; workspaceUrl: string } {
    const key = workspaceKey(spec.qid, spec.variantSeed);
    const existingId = this.idsByKey.get(key);

    if (existingId != null) {
      const entry = this.entriesById.get(existingId);
      if (entry != null) {
        entry.spec = spec;
        return { workspaceId: entry.id, workspaceUrl: this.workspaceUrl(entry.id) };
      }
    }

    const id = String(this.nextWorkspaceId++);
    this.entriesById.set(id, {
      fileGenerationErrors: [],
      id,
      lastActivityAt: this.now(),
      launchGeneration: 0,
      message: '',
      spec,
      state: 'uninitialized',
      target: null,
      version: 1,
    });
    this.idsByKey.set(key, id);

    return { workspaceId: id, workspaceUrl: this.workspaceUrl(id) };
  }

  get(id: string): PreviewWorkspaceEntry | null {
    return this.entriesById.get(id) ?? null;
  }

  getByKey(qid: string, variantSeed: string): PreviewWorkspaceEntry | null {
    const id = this.idsByKey.get(workspaceKey(qid, variantSeed));
    return id == null ? null : this.get(id);
  }

  list(): PreviewWorkspaceEntry[] {
    return [...this.entriesById.values()];
  }

  touch(id: string) {
    const entry = this.entriesById.get(id);
    if (entry != null) entry.lastActivityAt = this.now();
  }

  /**
   * Moves a workspace into `launching` and returns the new launch generation.
   * Returns null when the workspace is unknown or already launching/running,
   * so concurrent launch requests collapse into one.
   */
  beginLaunch(id: string): { generation: number } | null {
    const entry = this.entriesById.get(id);
    if (entry == null || entry.state === 'launching' || entry.state === 'running') return null;

    entry.launchGeneration += 1;
    entry.state = 'launching';
    entry.message = 'Launching';
    entry.target = null;
    entry.lastActivityAt = this.now();

    return { generation: entry.launchGeneration };
  }

  /**
   * Applies an update on behalf of the launch identified by `generation`.
   * Returns false without changes when the launch has been superseded by a
   * newer launch, reboot, or reset.
   */
  transition(id: string, generation: number, update: PreviewWorkspaceUpdate): boolean {
    const entry = this.entriesById.get(id);
    if (entry?.launchGeneration !== generation) return false;

    this.applyUpdate(entry, update);
    return true;
  }

  /**
   * Applies an update unconditionally and invalidates any in-flight launch.
   * Used for externally-initiated changes: reboot, reset, idle stop, close.
   */
  forceState(id: string, update: PreviewWorkspaceUpdate): boolean {
    const entry = this.entriesById.get(id);
    if (entry == null) return false;

    entry.launchGeneration += 1;
    this.applyUpdate(entry, update);
    return true;
  }

  /** Increments the version for reset, discarding recorded file errors. */
  bumpVersion(id: string): number | null {
    const entry = this.entriesById.get(id);
    if (entry == null) return null;

    entry.version += 1;
    entry.fileGenerationErrors = [];
    return entry.version;
  }

  setFileGenerationErrors(id: string, errors: PreviewWorkspaceFileGenerationError[]) {
    const entry = this.entriesById.get(id);
    if (entry != null) entry.fileGenerationErrors = errors;
  }

  leastRecentlyActiveRunning(): PreviewWorkspaceEntry | null {
    let leastRecent: PreviewWorkspaceEntry | null = null;
    for (const entry of this.entriesById.values()) {
      if (entry.state !== 'running') continue;
      if (leastRecent == null || entry.lastActivityAt < leastRecent.lastActivityAt) {
        leastRecent = entry;
      }
    }

    return leastRecent;
  }

  workspaceUrl(id: string) {
    return `${this.urlPrefix}${WORKSPACE_PATH_PREFIX}${encodeURIComponent(id)}`;
  }

  containerUrl(id: string) {
    return `${this.workspaceUrl(id)}/container/`;
  }

  private applyUpdate(entry: PreviewWorkspaceEntry, update: PreviewWorkspaceUpdate) {
    if (update.state != null) {
      entry.state = update.state;
      if (update.state !== 'running') entry.target = null;
    }
    if (update.target !== undefined) entry.target = update.target;
    if (update.message != null) entry.message = update.message;
    entry.lastActivityAt = this.now();
  }
}
