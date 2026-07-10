import type { Request, Response } from 'express';
import { assert, describe, it, vi } from 'vitest';

import { LocalPreviewSessionCatalog } from './local-preview-session.js';

describe('Local Preview Session catalog', () => {
  it('removes a closing session before draining its leases and owned state', async () => {
    const events: string[] = [];
    const catalog = new LocalPreviewSessionCatalog(
      async (_previewSessionId, courseDir) => ({
        beginClose: () => {
          events.push('begin close');
        },
        close: async () => {
          events.push('close owned state');
        },
        courseDir: `/canonical${courseDir}`,
        handle: (_req: Request, _res: Response) => {},
      }),
      1000,
    );
    const descriptor = await catalog.create('/course');
    const lease = catalog.acquire(descriptor.previewSessionId);
    assert.isNotNull(lease);

    let deletionFinished = false;
    const deletion = catalog.delete(descriptor.previewSessionId).then((deleted) => {
      deletionFinished = true;
      return deleted;
    });

    await vi.waitFor(() => {
      assert.deepEqual(events, ['begin close']);
    });
    assert.deepEqual(catalog.list(), []);
    assert.isNull(catalog.acquire(descriptor.previewSessionId));
    assert.isFalse(deletionFinished);

    lease.release();
    assert.isTrue(await deletion);
    assert.deepEqual(events, ['begin close', 'close owned state']);
  });

  it('keeps duplicate course sessions distinct until their owner closes them', async () => {
    const closed: string[] = [];
    const catalog = new LocalPreviewSessionCatalog(
      async (previewSessionId, courseDir) => ({
        close: async () => {
          closed.push(previewSessionId);
        },
        courseDir,
        handle: (_req: Request, _res: Response) => {},
      }),
      1000,
    );

    const first = await catalog.create('/course');
    const second = await catalog.create('/course');
    assert.notEqual(first.previewSessionId, second.previewSessionId);
    assert.deepEqual(catalog.list(), [first, second]);

    await catalog.close();
    assert.deepEqual(new Set(closed), new Set([first.previewSessionId, second.previewSessionId]));
    assert.deepEqual(catalog.list(), []);
  });

  it('bounds lease draining before closing owned state', async () => {
    let closed = false;
    const catalog = new LocalPreviewSessionCatalog(
      async (_previewSessionId, courseDir) => ({
        close: async () => {
          closed = true;
        },
        courseDir,
        handle: (_req: Request, _res: Response) => {},
      }),
      1,
    );
    const descriptor = await catalog.create('/course');
    assert.isNotNull(catalog.acquire(descriptor.previewSessionId));

    assert.isTrue(await catalog.delete(descriptor.previewSessionId));
    assert.isTrue(closed);
  });
});
