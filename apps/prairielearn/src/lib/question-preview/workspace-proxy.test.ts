import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import express from 'express';
import { afterEach, assert, beforeEach, describe, it } from 'vitest';

import { type PreviewWorkspaceProxyTargets, makePreviewWorkspaceProxy } from './workspace-proxy.js';

interface FakeTargets extends PreviewWorkspaceProxyTargets {
  heartbeats: string[];
  targetsById: Map<string, { hostPort: number; rewriteUrl: boolean }>;
}

function makeFakeTargets(): FakeTargets {
  const heartbeats: string[] = [];
  const targetsById = new Map<string, { hostPort: number; rewriteUrl: boolean }>();

  return {
    heartbeat(id) {
      heartbeats.push(id);
    },
    heartbeats,
    resolveContainerTarget(id) {
      return targetsById.get(id) ?? null;
    },
    targetsById,
  };
}

interface StartedServer {
  close(): Promise<void>;
  port: number;
}

/**
 * Sockets upgraded to another protocol are detached from the HTTP server's
 * connection tracking, so track raw connections to close them reliably.
 */
async function startServer(server: http.Server): Promise<StartedServer> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    port,
  };
}

async function fetchText(port: number, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { body: await response.text(), status: response.status };
}

describe('preview workspace proxy', () => {
  let containerServer: StartedServer | null = null;
  let previewServer: StartedServer | null = null;
  let targets: FakeTargets;
  let containerPort: number;
  let previewPort: number;

  beforeEach(async () => {
    targets = makeFakeTargets();

    const container = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end(`container saw ${req.url} cookie=${req.headers.cookie ?? 'none'}`);
    });
    container.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.write(`ws saw ${req.url}`);
      socket.on('data', (data) => socket.write(`echo:${data}`));
    });
    containerServer = await startServer(container);
    containerPort = containerServer.port;

    const proxy = makePreviewWorkspaceProxy({ targets });
    const app = express();
    app.use(proxy.middleware);
    app.use((_req, res) => {
      res.status(404).end();
    });
    const preview = http.createServer(app);
    preview.on('upgrade', proxy.upgrade);
    previewServer = await startServer(preview);
    previewPort = previewServer.port;
  });

  afterEach(async () => {
    await previewServer?.close();
    await containerServer?.close();
  });

  it('proxies container requests with the prefix stripped when rewriteUrl is enabled', async () => {
    targets.targetsById.set('1', { hostPort: containerPort, rewriteUrl: true });

    const { body, status } = await fetchText(previewPort, '/workspace/1/container/some/path?q=1');

    assert.equal(status, 200);
    assert.include(body, 'container saw /some/path?q=1');
    assert.include(targets.heartbeats, '1');
  });

  it('preserves the full path when rewriteUrl is disabled', async () => {
    targets.targetsById.set('1', { hostPort: containerPort, rewriteUrl: false });

    const { body, status } = await fetchText(previewPort, '/workspace/1/container/some/path');

    assert.equal(status, 200);
    assert.include(body, 'container saw /workspace/1/container/some/path');
  });

  it('responds with 404 when the workspace is not running', async () => {
    const { body, status } = await fetchText(previewPort, '/workspace/1/container/');

    assert.equal(status, 404);
    assert.equal(body, 'Workspace is not running');
  });

  it('passes non-container paths through to the next handler', async () => {
    const { status } = await fetchText(previewPort, '/workspace/1');

    assert.equal(status, 404);
    assert.deepEqual(targets.heartbeats, []);
  });

  it('strips sensitive cookies before requests reach the container', async () => {
    targets.targetsById.set('1', { hostPort: containerPort, rewriteUrl: true });

    const { body } = await fetchText(previewPort, '/workspace/1/container/', {
      cookie: 'pl_authn=secret; pl2_session=secret2; harmless=value',
    });

    assert.include(body, 'cookie=harmless=value');
    assert.notInclude(body, 'secret');
  });

  it('tunnels websocket upgrades to the container', async () => {
    targets.targetsById.set('1', { hostPort: containerPort, rewriteUrl: true });

    const { head, socket } = await new Promise<{
      head: Buffer;
      socket: Socket;
    }>((resolve, reject) => {
      const request = http.request({
        headers: {
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          Upgrade: 'websocket',
        },
        host: '127.0.0.1',
        path: '/workspace/1/container/socket',
        port: previewPort,
      });
      request.on('upgrade', (_res, upgradeSocket, upgradeHead) =>
        resolve({ head: upgradeHead, socket: upgradeSocket }),
      );
      request.on('response', (res) => reject(new Error(`Unexpected response: ${res.statusCode}`)));
      request.on('error', reject);
      request.end();
    });

    try {
      const received: Buffer[] = [head];
      const gotEcho = new Promise<string>((resolve) => {
        socket.on('data', (data) => {
          received.push(data);
          const text = Buffer.concat(received).toString();
          if (text.includes('echo:hello')) resolve(text);
        });
      });
      socket.write('hello');

      const text = await gotEcho;
      assert.include(text, 'ws saw /socket');
      assert.include(text, 'echo:hello');
      assert.include(targets.heartbeats, '1');
    } finally {
      socket.destroy();
    }
  });

  it('responds with a gateway error when the container is unreachable', async () => {
    const unreachableServer = await startServer(http.createServer());
    await unreachableServer.close();
    targets.targetsById.set('1', { hostPort: unreachableServer.port, rewriteUrl: true });

    const { body, status } = await fetchText(previewPort, '/workspace/1/container/');

    assert.equal(status, 504);
    assert.equal(body, 'Error proxying workspace request');
  });
});
