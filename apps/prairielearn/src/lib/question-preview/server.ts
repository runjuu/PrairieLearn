import fs from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import { omit } from 'es-toolkit';
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';
import asyncHandler from 'express-async-handler';

import * as assets from '../assets.js';

import { createQuestionPreviewAssetResolver } from './assets.js';
import type { QuestionPreviewRenderMode } from './document.js';
import type { LocalPreviewGeneratedFiles } from './generated-files.js';
import {
  type QuestionPreviewHttpAction,
  type QuestionPreviewHttpResponse,
  mapQuestionPreviewAssetFileResponse,
  mapQuestionPreviewDocumentResponse,
  mapQuestionPreviewGeneratedFileResponse,
  mapQuestionPreviewGradingDisabledResponse,
  mapQuestionPreviewInvalidQidResponse,
  mapQuestionPreviewInvalidRenderModeResponse,
  mapQuestionPreviewInvalidSubmissionActionResponse,
  mapQuestionPreviewRenderModeUnavailableResponse,
  mapQuestionPreviewRouteErrorResponse,
  mapQuestionPreviewWorkspaceActionResponse,
  mapQuestionPreviewWorkspacePageResponse,
  mapQuestionPreviewWorkspaceStatusResponse,
} from './http-response.js';
import { parseQuestionPreviewQid } from './qid.js';
import type { QuestionPreviewRuntime, QuestionPreviewStartupLogger } from './render.js';
import {
  type QuestionPreviewRuntimeFactory,
  type QuestionPreviewRuntimeLifecycle,
  createQuestionPreviewRuntimeLifecycle,
} from './runtime-lifecycle.js';
import {
  type QuestionPreviewServerHttpOptions,
  type QuestionPreviewServerOptions,
  getQuestionPreviewServerHttpOptions,
  getQuestionPreviewServerRuntimeOptions,
  getQuestionPreviewServerWorkspaceOptions,
  parseQuestionPreviewServerOptions,
} from './server-options.js';
import {
  type PreviewWorkspaceManager,
  type PreviewWorkspaceManagerOptions,
  createPreviewWorkspaceManager,
} from './workspace-launcher.js';
import {
  makePreviewWorkspaceStatusJson,
  renderPreviewWorkspacePageHtml,
  renderPreviewWorkspaceUnavailableHtml,
} from './workspace-page.js';
import { makePreviewWorkspaceProxy } from './workspace-proxy.js';
import type { PreviewWorkspaceEntry } from './workspace-registry.js';

export { parseQuestionPreviewServerOptions, type QuestionPreviewServerOptions };

type PreviewWorkspaceManagerFactory = (
  options: PreviewWorkspaceManagerOptions,
) => PreviewWorkspaceManager;

export interface StartedQuestionPreviewServer {
  close(): Promise<void>;
  options: QuestionPreviewServerOptions;
  runtime: QuestionPreviewRuntime;
  server: Server;
  workspaceManager: PreviewWorkspaceManager | null;
}

/**
 * Resolves once the server returned by Express is accepting requests.
 *
 * @param server - The Node HTTP server instance returned by `app.listen`.
 */
function waitForListening(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (server.listening) {
      server.off('error', reject);
      resolve();
      return;
    }

    server.once('listening', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Reads the URL pathname exactly as sent by the client, before Express decodes
 * wildcard route parameters.
 *
 * @param req - Incoming HTTP request.
 */
function rawRequestPathname(req: IncomingMessage) {
  const rawUrl = req.url ?? '/';
  const queryStart = rawUrl.search(/[?#]/);
  return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}

async function sendQuestionPreviewHttpResponse(
  res: Response,
  response: QuestionPreviewHttpResponse,
) {
  switch (response.kind) {
    case 'attachment':
      res.status(response.status).attachment(response.filename).send(response.data);
      return;
    case 'empty':
      res.status(response.status).end();
      return;
    case 'file':
      await new Promise<void>((resolve, reject) => {
        res
          .status(response.status)
          .sendFile(response.filePath, { headers: response.headers }, (err?: Error) => {
            if (err == null) {
              resolve();
            } else {
              reject(err);
            }
          });
      });
      return;
    case 'html':
      res.status(response.status).type('html').send(response.html);
      return;
    case 'json':
      res.status(response.status).json(response.body);
      return;
    case 'redirect':
      res.redirect(response.status, response.location);
      return;
  }
}

async function sendQuestionPreviewHttpAction(res: Response, action: QuestionPreviewHttpAction) {
  for (const log of action.logs) {
    console.error(log.message, log.details);
  }

  await sendQuestionPreviewHttpResponse(res, action.response);
}

type QuestionPreviewAssetResolver = ReturnType<typeof createQuestionPreviewAssetResolver>;

async function handleQuestionPreviewAssetRequest(
  res: Response,
  assetResolver: QuestionPreviewAssetResolver,
  pathname: string,
) {
  const generatedFileResult = await assetResolver.resolveGeneratedFile(pathname);
  if (generatedFileResult != null) {
    await sendQuestionPreviewHttpAction(
      res,
      mapQuestionPreviewGeneratedFileResponse(generatedFileResult),
    );
    return;
  }

  const filePath = await assetResolver.resolve(pathname);
  await sendQuestionPreviewHttpAction(res, mapQuestionPreviewAssetFileResponse(filePath));
}

function registerQuestionPreviewAssetRoutes(
  app: Express,
  assetResolver: QuestionPreviewAssetResolver,
) {
  for (const routePattern of assetResolver.routePatterns) {
    app
      .route(routePattern)
      .get(
        asyncHandler(async (req, res) => {
          await handleQuestionPreviewAssetRequest(res, assetResolver, rawRequestPathname(req));
        }),
      )
      .all((_req, res) => {
        res.status(405).end();
      });
  }
}

interface HandleQuestionPreviewRequestParams {
  qid: string;
  req: Request;
  res: Response;
  runtime: QuestionPreviewRuntime;
  serverRenderMode: QuestionPreviewRenderMode;
  submissionBody?: Record<string, unknown>;
}

/**
 * Handles direct question preview URLs and renders the requested question,
 * checking a posted answer first when a submission body is present.
 *
 * A `render-mode` query parameter can narrow an individual page to
 * `question-only`; the launch-time render mode remains a hard cap, so it
 * cannot re-enable grading on a question-only server.
 */
async function handleQuestionPreviewRequest({
  qid,
  req,
  res,
  runtime,
  serverRenderMode,
  submissionBody,
}: HandleQuestionPreviewRequestParams) {
  const qidResult = parseQuestionPreviewQid(qid);
  if (!qidResult.ok) {
    await sendQuestionPreviewHttpAction(res, mapQuestionPreviewInvalidQidResponse());
    return;
  }

  if (submissionBody != null && submissionBody.__action !== 'grade') {
    await sendQuestionPreviewHttpAction(
      res,
      mapQuestionPreviewInvalidSubmissionActionResponse(submissionBody.__action),
    );
    return;
  }

  const url = new URL(req.url, 'http://question-preview.local');

  const renderModeParam = url.searchParams.get('render-mode');
  let renderMode = serverRenderMode;
  if (renderModeParam != null) {
    if (renderModeParam !== 'full' && renderModeParam !== 'question-only') {
      await sendQuestionPreviewHttpAction(
        res,
        mapQuestionPreviewInvalidRenderModeResponse(renderModeParam),
      );
      return;
    }
    if (renderModeParam === 'full' && serverRenderMode === 'question-only') {
      await sendQuestionPreviewHttpAction(res, mapQuestionPreviewRenderModeUnavailableResponse());
      return;
    }
    renderMode = renderModeParam;
  }

  if (submissionBody != null && renderMode === 'question-only') {
    await sendQuestionPreviewHttpAction(res, mapQuestionPreviewGradingDisabledResponse());
    return;
  }

  const result = await runtime.render({
    qid: qidResult.qid,
    renderMode,
    variantSeed: url.searchParams.get('variant') ?? undefined,
    submission:
      submissionBody == null
        ? undefined
        : {
            rawSubmittedAnswer: omit(submissionBody, ['__action', '__csrf_token', '__variant_id']),
          },
  });

  await sendQuestionPreviewHttpAction(res, mapQuestionPreviewDocumentResponse(result));
}

function makePreviewWorkspacePageUrls(
  workspaceManager: PreviewWorkspaceManager,
  entry: PreviewWorkspaceEntry,
) {
  const workspaceUrl = workspaceManager.workspaces.workspaceUrl(entry.id);
  const encodedQid = entry.spec.qid.split('/').map(encodeURIComponent).join('/');

  return {
    actionUrl: workspaceUrl,
    containerUrl: workspaceManager.workspaces.containerUrl(entry.id),
    questionUrl: `/questions/${encodedQid}?variant=${encodeURIComponent(entry.spec.variantSeed)}`,
    statusUrl: `${workspaceUrl}/status`,
  };
}

function registerQuestionPreviewWorkspaceRoutes(
  app: Express,
  workspaceManager: PreviewWorkspaceManager | null,
) {
  if (workspaceManager == null) {
    app.all('/workspace/*', (_req, res) => {
      void sendQuestionPreviewHttpAction(
        res,
        mapQuestionPreviewWorkspacePageResponse({
          html: renderPreviewWorkspaceUnavailableHtml({
            reason:
              'Workspaces are disabled on this preview server. Restart it without --no-workspaces to launch workspaces.',
          }),
          status: 404,
        }),
      );
    });
    return;
  }

  app.get(
    '/workspace/:workspaceId',
    asyncHandler(async (req, res) => {
      const entry = workspaceManager.workspaces.get(req.params.workspaceId);
      if (entry == null) {
        await sendQuestionPreviewHttpAction(
          res,
          mapQuestionPreviewWorkspacePageResponse({
            html: renderPreviewWorkspaceUnavailableHtml({
              reason: 'Unknown workspace. Open a workspace question and use its workspace button.',
            }),
            status: 404,
          }),
        );
        return;
      }

      void workspaceManager.requestLaunch(entry.id);
      await sendQuestionPreviewHttpAction(
        res,
        mapQuestionPreviewWorkspacePageResponse({
          html: renderPreviewWorkspacePageHtml({
            entry,
            urls: makePreviewWorkspacePageUrls(workspaceManager, entry),
          }),
          status: 200,
        }),
      );
    }),
  );

  app.post(
    '/workspace/:workspaceId',
    express.urlencoded({ extended: false }),
    asyncHandler(async (req, res) => {
      const entry = workspaceManager.workspaces.get(req.params.workspaceId);
      if (entry == null) {
        await sendQuestionPreviewHttpAction(
          res,
          mapQuestionPreviewWorkspacePageResponse({
            html: renderPreviewWorkspaceUnavailableHtml({
              reason: 'Unknown workspace. Open a workspace question and use its workspace button.',
            }),
            status: 404,
          }),
        );
        return;
      }

      const submissionAction = req.body?.__action;
      if (submissionAction !== 'reboot' && submissionAction !== 'reset') {
        await sendQuestionPreviewHttpAction(
          res,
          mapQuestionPreviewWorkspaceActionResponse({
            action: submissionAction,
            kind: 'invalid-action',
          }),
        );
        return;
      }

      if (submissionAction === 'reboot') {
        await workspaceManager.reboot(entry.id);
      } else {
        await workspaceManager.reset(entry.id);
      }

      await sendQuestionPreviewHttpAction(
        res,
        mapQuestionPreviewWorkspaceActionResponse({
          kind: 'redirect',
          location: workspaceManager.workspaces.workspaceUrl(entry.id),
        }),
      );
    }),
  );

  app.get(
    '/workspace/:workspaceId/status',
    asyncHandler(async (req, res) => {
      const entry = workspaceManager.workspaces.get(req.params.workspaceId);
      if (entry == null) {
        await sendQuestionPreviewHttpAction(res, mapQuestionPreviewWorkspaceStatusResponse(null));
        return;
      }

      if (req.query.heartbeat === '1') workspaceManager.heartbeat(entry.id);
      await sendQuestionPreviewHttpAction(
        res,
        mapQuestionPreviewWorkspaceStatusResponse(
          makePreviewWorkspaceStatusJson(entry, {
            containerUrl: workspaceManager.workspaces.containerUrl(entry.id),
          }),
        ),
      );
    }),
  );
}

/**
 * Converts route handling failures into generic browser error pages.
 */
function questionPreviewErrorHandler(): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    void sendQuestionPreviewHttpAction(res, mapQuestionPreviewRouteErrorResponse(err)).catch(next);
  };
}

interface CreateQuestionPreviewAppParams {
  httpOptions: QuestionPreviewServerHttpOptions;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  runtime: QuestionPreviewRuntime;
  urlPrefix: string;
  workspaceManager: PreviewWorkspaceManager | null;
}

/**
 * Creates the Express app that serves direct previews, core assets, course
 * assets, generated files, and workspace pages, plus the upgrade handler that
 * tunnels workspace websocket traffic.
 */
function createQuestionPreviewApp({
  httpOptions,
  localPreviewGeneratedFiles,
  runtime,
  urlPrefix,
  workspaceManager,
}: CreateQuestionPreviewAppParams) {
  const app = express();
  const assetResolver = createQuestionPreviewAssetResolver({
    courseDir: httpOptions.courseDir,
    localPreviewGeneratedFiles,
    urlPrefix,
  });

  app.disable('x-powered-by');
  app.enable('strict routing');

  assets.applyMiddleware(app);

  app.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });

  let workspaceUpgradeHandler:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;
  if (workspaceManager != null) {
    const workspaceProxy = makePreviewWorkspaceProxy({
      logger: (message) => console.error(message),
      targets: workspaceManager,
    });
    app.use(workspaceProxy.middleware);
    workspaceUpgradeHandler = workspaceProxy.upgrade;
  }
  registerQuestionPreviewWorkspaceRoutes(app, workspaceManager);

  app.get(
    '/questions/*',
    asyncHandler(async (req, res) => {
      const qid = req.params[0];

      if (!qid) {
        res.status(404).end();
        return;
      }

      await handleQuestionPreviewRequest({
        qid,
        req,
        res,
        runtime,
        serverRenderMode: httpOptions.renderMode,
      });
    }),
  );

  if (httpOptions.renderMode === 'question-only') {
    app.post('/questions/*', (_req, res) => {
      void sendQuestionPreviewHttpAction(res, mapQuestionPreviewGradingDisabledResponse());
    });
  } else {
    app.post(
      '/questions/*',
      // Mirrors the submission body limits of the full PrairieLearn server.
      express.urlencoded({ extended: false, limit: 5 * 1536 * 1024 }),
      asyncHandler(async (req, res) => {
        const qid = req.params[0];

        if (!qid) {
          res.status(404).end();
          return;
        }

        await handleQuestionPreviewRequest({
          qid,
          req,
          res,
          runtime,
          serverRenderMode: httpOptions.renderMode,
          submissionBody: req.body ?? {},
        });
      }),
    );
  }

  registerQuestionPreviewAssetRoutes(app, assetResolver);

  app.use((_req, res) => {
    res.status(404).end();
  });

  app.use(questionPreviewErrorHandler());

  return { app, workspaceUpgradeHandler };
}

interface StartQuestionPreviewServerParams {
  argv: string[];
  createRuntime: QuestionPreviewRuntimeFactory;
  createWorkspaceManager?: PreviewWorkspaceManagerFactory;
  localPreviewGeneratedFilesMax?: number;
  startupLogger?: QuestionPreviewStartupLogger;
}

/**
 * Parses options, creates the preview runtime, starts the HTTP server, and
 * returns a handle that can cleanly close everything it owns.
 */
export async function startQuestionPreviewServer({
  argv,
  createRuntime,
  createWorkspaceManager = createPreviewWorkspaceManager,
  localPreviewGeneratedFilesMax,
  startupLogger,
}: StartQuestionPreviewServerParams): Promise<StartedQuestionPreviewServer> {
  startupLogger?.('Reading preview server options.');
  const options = await parseQuestionPreviewServerOptions(argv);
  startupLogger?.(`Validated course directory: ${options.courseDir}.`);

  const httpOptions = getQuestionPreviewServerHttpOptions(options);
  const runtimeOptions = getQuestionPreviewServerRuntimeOptions(options);
  const workspaceOptions = getQuestionPreviewServerWorkspaceOptions(options);
  let runtime: QuestionPreviewRuntimeLifecycle | null = null;
  let server: Server | null = null;
  let workspaceManager: PreviewWorkspaceManager | null = null;
  let workspaceHomeRootToRemove: string | null = null;
  const upgradedSockets = new Set<Duplex>();

  async function closeWorkspaceManager() {
    await workspaceManager?.close();
    if (workspaceHomeRootToRemove != null) {
      await fs.rm(workspaceHomeRootToRemove, { force: true, recursive: true });
    }
  }

  try {
    if (workspaceOptions.workspacesEnabled) {
      startupLogger?.('Initializing workspace manager.');
      const homeRoot =
        workspaceOptions.workspaceHomeDir ??
        (workspaceHomeRootToRemove = await fs.mkdtemp(
          path.join(os.tmpdir(), 'pl-preview-workspaces-'),
        ));
      workspaceManager = createWorkspaceManager({
        containerNetwork: workspaceOptions.workspaceNetwork,
        courseDir: options.courseDir,
        homeRoot,
        idleTimeoutMs: workspaceOptions.workspaceIdleTimeoutMs,
        logger: (message) => console.error(message),
        maxRunningContainers: workspaceOptions.workspaceMaxContainers,
        pullPolicy: workspaceOptions.workspacePullPolicy,
        startTimeoutMs: workspaceOptions.workspaceStartTimeoutMs,
      });

      try {
        const prunedContainerIds = await workspaceManager.pruneOrphans();
        if (prunedContainerIds.length > 0) {
          startupLogger?.(`Removed ${prunedContainerIds.length} orphaned workspace container(s).`);
        }
      } catch (err) {
        // Docker being unreachable at startup is fine: workspace launches
        // will report it per workspace, and question previews still work.
        startupLogger?.(
          `Skipping workspace orphan pruning: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    startupLogger?.('Initializing preview runtime.');
    runtime = await createQuestionPreviewRuntimeLifecycle({
      createRuntime,
      localPreviewGeneratedFilesMax,
      localPreviewWorkspaces: workspaceManager,
      runtimeOptions: startupLogger == null ? runtimeOptions : { ...runtimeOptions, startupLogger },
    });

    startupLogger?.('Preparing preview asset routes.');
    await assets.init();

    startupLogger?.(`Starting HTTP server on ${httpOptions.host}:${httpOptions.port}.`);
    const { app, workspaceUpgradeHandler } = createQuestionPreviewApp({
      httpOptions,
      localPreviewGeneratedFiles: runtime.localPreviewGeneratedFiles,
      runtime,
      urlPrefix: runtime.urlPrefix,
      workspaceManager,
    });
    server = app.listen(httpOptions.port, httpOptions.host);
    if (workspaceUpgradeHandler != null) {
      const upgradeHandler = workspaceUpgradeHandler;
      server.on('upgrade', (req, socket, head) => {
        // Upgraded sockets detach from the HTTP server's connection tracking,
        // so track them here to close them reliably on shutdown.
        upgradedSockets.add(socket);
        socket.on('close', () => upgradedSockets.delete(socket));
        upgradeHandler(req, socket, head);
      });
    }
    await waitForListening(server);
  } catch (err) {
    await runtime?.close().catch(() => {});
    await closeWorkspaceManager().catch(() => {});

    const failedServer = server;

    if (failedServer != null) {
      await new Promise<void>((resolve) => failedServer.close(() => resolve()));
    }

    throw err;
  }

  return {
    async close() {
      let closeError: unknown;

      try {
        for (const socket of upgradedSockets) socket.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        closeError = err;
      }

      try {
        await closeWorkspaceManager();
      } catch (err) {
        closeError ??= err;
      }

      try {
        await runtime.close();
      } catch (err) {
        closeError ??= err;
      }

      if (closeError != null) {
        throw closeError as Error;
      }
    },
    options,
    runtime,
    server,
    workspaceManager,
  };
}
