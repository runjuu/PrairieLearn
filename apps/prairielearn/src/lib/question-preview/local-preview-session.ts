import { randomBytes } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

export interface LocalPreviewSessionDescriptor {
  courseDir: string;
  previewSessionId: string;
}

export interface LocalPreviewSessionOwnedState {
  close(): Promise<void>;
  courseDir: string;
  handle(req: Request, res: Response, next: NextFunction): void;
}

export type LocalPreviewSessionFactory = (
  previewSessionId: string,
  courseDir: string,
) => Promise<LocalPreviewSessionOwnedState>;

export interface LocalPreviewSessionLease {
  handle(req: Request, res: Response, next: NextFunction): void;
  release(): void;
}

class LocalPreviewSession {
  private activeLeases = 0;
  private closing = false;
  private drained: Promise<void> | null = null;
  private resolveDrained: (() => void) | null = null;

  constructor(
    readonly descriptor: LocalPreviewSessionDescriptor,
    private readonly owned: LocalPreviewSessionOwnedState,
    private readonly drainTimeoutMs: number,
  ) {}

  acquire(): LocalPreviewSessionLease | null {
    if (this.closing) return null;
    this.activeLeases++;
    let released = false;
    return {
      handle: (req, res, next) => this.owned.handle(req, res, next),
      release: () => {
        if (released) return;
        released = true;
        this.activeLeases--;
        if (this.closing && this.activeLeases === 0) this.resolveDrained?.();
      },
    };
  }

  async close() {
    if (!this.closing) {
      this.closing = true;
      if (this.activeLeases > 0) {
        this.drained = new Promise<void>((resolve) => {
          this.resolveDrained = resolve;
        });
      }
    }
    if (this.drained != null) {
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        this.drained,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.drainTimeoutMs);
          timeout.unref();
        }),
      ]);
      clearTimeout(timeout);
    }
    await this.owned.close();
  }
}

export class LocalPreviewSessionCatalog {
  private readonly sessions = new Map<string, LocalPreviewSession>();

  constructor(
    private readonly createOwnedState: LocalPreviewSessionFactory,
    private readonly drainTimeoutMs: number,
  ) {}

  async create(courseDir: string): Promise<LocalPreviewSessionDescriptor> {
    const previewSessionId = `pvs_${randomBytes(16).toString('base64url')}`;
    const owned = await this.createOwnedState(previewSessionId, courseDir);
    const descriptor = { courseDir: owned.courseDir, previewSessionId };
    this.sessions.set(
      previewSessionId,
      new LocalPreviewSession(descriptor, owned, this.drainTimeoutMs),
    );
    return descriptor;
  }

  list(): LocalPreviewSessionDescriptor[] {
    return [...this.sessions.values()].map((session) => session.descriptor);
  }

  acquire(previewSessionId: string): LocalPreviewSessionLease | null {
    return this.sessions.get(previewSessionId)?.acquire() ?? null;
  }

  async delete(previewSessionId: string): Promise<boolean> {
    const session = this.sessions.get(previewSessionId);
    if (session == null) return false;
    this.sessions.delete(previewSessionId);
    await session.close();
    return true;
  }

  async close() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const results = await Promise.allSettled(sessions.map((session) => session.close()));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }
}
