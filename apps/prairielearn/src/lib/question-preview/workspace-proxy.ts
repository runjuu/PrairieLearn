import type http from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const CONTAINER_PATH_REGEX = /^\/workspace\/([0-9]+)\/container\/(.*)/;

/** The subset of workspace operations the container proxy depends on. */
export interface PreviewWorkspaceProxyTargets {
  heartbeat(id: string): void;
  resolveContainerTarget(id: string): { host: string; port: number; rewriteUrl: boolean } | null;
}

export interface PreviewWorkspaceProxy {
  middleware: RequestHandler;
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/**
 * Removes "sensitive" cookies from the request to avoid exposing them to
 * workspace containers. The preview server sets no cookies of its own, but a
 * developer's browser may carry PrairieLearn cookies from other origins.
 */
function stripSensitiveCookies(proxyReq: http.ClientRequest) {
  const cookies = proxyReq.getHeader('cookie');
  if (!cookies) return;

  const items = (cookies as string).split(';');
  const filteredItems = items.filter((item) => {
    const name = item.split('=')[0].trim();
    return (
      name !== 'pl_authn' &&
      name !== 'pl2_authn' &&
      name !== 'pl_assessmentpw' &&
      name !== 'pl2_assessmentpw' &&
      name !== 'connect.sid' &&
      name !== 'prairielearn_session' &&
      name !== 'pl2_session' &&
      // The workspace authz cookies use a prefix plus the workspace ID, so
      // we need to check for that prefix instead of an exact name match.
      !name.startsWith('pl_authz_workspace_') &&
      !name.startsWith('pl2_authz_workspace_')
    );
  });

  proxyReq.setHeader('cookie', filteredItems.join(';'));
}

function isResponseLike(obj: unknown): obj is http.ServerResponse {
  return obj != null && typeof (obj as http.ServerResponse).writeHead === 'function';
}

function isSocketLike(obj: unknown): obj is Socket {
  return (
    typeof obj === 'object' &&
    obj != null &&
    typeof (obj as Socket).write === 'function' &&
    !('writeHead' in obj)
  );
}

/**
 * Adapted from the following file in `http-proxy-middleware`:
 * https://github.com/chimurai/http-proxy-middleware/blob/e94087e8d072c0c54a6c3a6b050c590a92921482/src/status-code.ts
 */
function getStatusCode(err: NodeJS.ErrnoException): number {
  if ((err.code ?? '').includes('HPE_INVALID')) {
    return 502;
  }

  switch (err.code) {
    case 'ECONNRESET':
    case 'ENOTFOUND':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return 504;
    default:
      return 500;
  }
}

function getRequestPath(req: http.IncomingMessage & { originalUrl?: string }): string {
  // `req.originalUrl` won't be defined for websocket requests, but for
  // non-websocket requests, `req.url` won't contain the full path when the
  // middleware is mounted under a subpath. So we need to handle both.
  return req.originalUrl ?? req.url ?? '';
}

function matchContainerPath(req: http.IncomingMessage & { originalUrl?: string }) {
  const match = getRequestPath(req).match(CONTAINER_PATH_REGEX);
  if (match == null) return null;

  return { pathSuffix: match[2], workspaceId: match[1] };
}

/**
 * Proxies HTTP and websocket traffic under `/workspace/<id>/container/` to
 * the workspace's container, resolving targets from the in-memory workspace
 * state instead of the database the full server uses.
 */
export function makePreviewWorkspaceProxy({
  logger = () => {},
  targets,
}: {
  logger?: (message: string) => void;
  targets: PreviewWorkspaceProxyTargets;
}): PreviewWorkspaceProxy {
  const proxyMiddleware = createProxyMiddleware<
    http.IncomingMessage & { originalUrl?: string },
    http.ServerResponse
  >({
    target: 'invalid',
    ws: true,
    pathFilter: (_path, req) => matchContainerPath(req) != null,
    pathRewrite: (_path, req) => {
      const path = getRequestPath(req);
      const match = matchContainerPath(req);
      if (match == null) return path;

      const target = targets.resolveContainerTarget(match.workspaceId);
      if (!target?.rewriteUrl) return path;

      return '/' + match.pathSuffix;
    },
    router: (req) => {
      const match = matchContainerPath(req);
      if (match == null) throw new Error(`Could not match path: ${getRequestPath(req)}`);

      const target = targets.resolveContainerTarget(match.workspaceId);
      if (target == null) throw new Error('Workspace is not running');

      return `http://${target.host}:${target.port}/`;
    },
    on: {
      proxyReq: (proxyReq, req) => {
        stripSensitiveCookies(proxyReq);
        const match = matchContainerPath(req);
        if (match != null) targets.heartbeat(match.workspaceId);
      },
      proxyReqWs: (proxyReq) => {
        // `req.url` has already been rewritten here, so the workspace id is
        // gone; websocket heartbeats are bumped in the `upgrade` handler.
        stripSensitiveCookies(proxyReq);
      },
      error: (err, req, res) => {
        logger(`Error proxying workspace request for ${req.url}: ${err}`);

        if (isResponseLike(res)) {
          // Check to make sure we weren't already in the middle of sending a
          // response before replying with our own error.
          if (!res.headersSent) {
            res.writeHead(getStatusCode(err));
          }

          res.end('Error proxying workspace request');
        } else if (isSocketLike(res)) {
          // There's nothing we can do but destroy the socket.
          res.destroy();
        }
      },
    },
  });

  const middleware: RequestHandler = (req, res, next) => {
    const match = matchContainerPath(req);
    if (match != null && targets.resolveContainerTarget(match.workspaceId) == null) {
      res.status(404).type('text/plain').send('Workspace is not running');
      return;
    }

    void proxyMiddleware(req, res, next);
  };

  const upgrade: PreviewWorkspaceProxy['upgrade'] = (req, socket, head) => {
    const match = matchContainerPath(req);
    if (match != null) targets.heartbeat(match.workspaceId);
    // The upgrade event's socket is typed as a Duplex, but it is always a
    // net.Socket at runtime, which is what the proxy middleware expects.
    proxyMiddleware.upgrade(req, socket as Socket, head);
  };

  return { middleware, upgrade };
}
