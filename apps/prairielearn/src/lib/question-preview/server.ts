import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, Server } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';

import { omit } from 'es-toolkit';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import asyncHandler from 'express-async-handler';

import * as assets from '../assets.js';
import { guessMimeType } from '../mime-type.js';
import { APP_ROOT_PATH } from '../paths.js';

import { createQuestionPreviewAssetResolver } from './assets.js';
import {
  InvalidLocalPreviewCourseError,
  type LocalPreviewCourseSource,
  createLocalPreviewCourseSource,
} from './course-source.js';
import type { QuestionPreviewRenderMode } from './document.js';
import type { QuestionPreviewEngineLifecycle } from './engine.js';
import type { LocalPreviewGeneratedFiles } from './generated-files.js';
import {
  type QuestionPreviewHttpAction,
  type QuestionPreviewHttpResponse,
  mapLocalPreviewSessionNotFoundResponse,
  mapQuestionPreviewAssetFileResponse,
  mapQuestionPreviewDocumentResponse,
  mapQuestionPreviewGeneratedFileResponse,
  mapQuestionPreviewGradingDisabledResponse,
  mapQuestionPreviewInvalidQidResponse,
  mapQuestionPreviewInvalidRenderModeResponse,
  mapQuestionPreviewInvalidSubmissionActionResponse,
  mapQuestionPreviewRenderModeUnavailableResponse,
  mapQuestionPreviewRouteErrorResponse,
  mapQuestionPreviewSubmissionFileResponse,
  mapQuestionPreviewWorkspacePageResponse,
  mapQuestionPreviewWorkspaceStatusResponse,
} from './http-response.js';
import {
  LocalPreviewSessionCatalog,
  type LocalPreviewSessionDescriptor,
} from './local-preview-session.js';
import { parseQuestionPreviewQid } from './qid.js';
import {
  type QuestionPreviewRuntime,
  type QuestionPreviewStartupLogger,
  createQuestionPreviewEngine,
} from './render.js';
import {
  type QuestionPreviewRuntimeFactory,
  type QuestionPreviewRuntimeLifecycle,
  createQuestionPreviewCourseRuntimeLifecycle,
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
import type { LocalPreviewSubmissionFiles } from './submission-files.js';
import {
  type PreviewWorkspaceManager,
  type PreviewWorkspaceOwner,
  type PreviewWorkspaceOwnerOptions,
  createPreviewWorkspaceOwner,
} from './workspace-launcher.js';
import {
  makePreviewWorkspaceStatusJson,
  renderPreviewWorkspacePageHtml,
  renderPreviewWorkspaceUnavailableHtml,
} from './workspace-page.js';
import { makePreviewWorkspaceProxy } from './workspace-proxy.js';
import type { PreviewWorkspaceEntry } from './workspace-registry.js';

export { parseQuestionPreviewServerOptions };

type PreviewWorkspaceOwnerFactory = (
  options: PreviewWorkspaceOwnerOptions,
) => PreviewWorkspaceOwner;

export interface StartedQuestionPreviewServer {
  close(): Promise<void>;
  options: QuestionPreviewServerOptions;
  server: Server;
  startupSessions: LocalPreviewSessionDescriptor[];
}

const PRAIRIELEARN_VERSION = (
  createRequire(import.meta.url)('../../../package.json') as { version: string }
).version;

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

function rawOriginalRequestPathname(req: Request) {
  const queryStart = req.originalUrl.search(/[?#]/);
  return queryStart === -1 ? req.originalUrl : req.originalUrl.slice(0, queryStart);
}

function questionQidFromRawPath(req: Request, sessionPrefix: string) {
  const questionPrefix = `${sessionPrefix}/questions/`;
  const pathname = rawOriginalRequestPathname(req);
  if (!pathname.startsWith(questionPrefix)) return null;

  const decodedSegments: string[] = [];
  for (const encodedSegment of pathname.slice(questionPrefix.length).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      return null;
    }
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      return null;
    }
    decodedSegments.push(segment);
  }
  return decodedSegments.join('/');
}

async function sendQuestionPreviewHttpResponse(
  res: Response,
  response: QuestionPreviewHttpResponse,
) {
  switch (response.kind) {
    case 'attachment':
      res.status(response.status).attachment(response.filename).send(response.data);
      return;
    case 'bytes':
      res.setHeader('Content-Type', response.contentType);
      res.status(response.status).send(response.data);
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
  sessionPrefix = '',
) {
  for (const routePattern of assetResolver.routePatterns) {
    app
      .route(routePattern.slice(sessionPrefix.length))
      .get(
        asyncHandler(async (req, res) => {
          await handleQuestionPreviewAssetRequest(
            res,
            assetResolver,
            sessionPrefix === '' ? rawRequestPathname(req) : rawOriginalRequestPathname(req),
          );
        }),
      )
      .all((_req, res) => {
        res.status(405).end();
      });
  }
}

async function handleQuestionPreviewSubmissionFileRequest(
  res: Response,
  localPreviewSubmissionFiles: LocalPreviewSubmissionFiles,
  pathname: string,
) {
  const resolved = localPreviewSubmissionFiles.resolveRequest(pathname);
  if (!resolved?.found) {
    await sendQuestionPreviewHttpAction(
      res,
      mapQuestionPreviewSubmissionFileResponse({ found: false }),
    );
    return;
  }

  const contentType = await guessMimeType(resolved.filename, resolved.contents);
  await sendQuestionPreviewHttpAction(
    res,
    mapQuestionPreviewSubmissionFileResponse({
      contentType,
      data: resolved.contents,
      found: true,
    }),
  );
}

function registerQuestionPreviewSubmissionFileRoutes(
  app: Express,
  localPreviewSubmissionFiles: LocalPreviewSubmissionFiles,
  sessionPrefix = '',
) {
  app.get(
    localPreviewSubmissionFiles.routePattern.slice(sessionPrefix.length),
    asyncHandler(async (req, res) => {
      await handleQuestionPreviewSubmissionFileRequest(
        res,
        localPreviewSubmissionFiles,
        sessionPrefix === '' ? rawRequestPathname(req) : rawOriginalRequestPathname(req),
      );
    }),
  );
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
  const workspaceUrl = workspaceManager.workspaceUrl(entry.id);

  return {
    containerUrl: workspaceManager.containerUrl(entry.id),
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
              'Workspaces are disabled on this preview server. Restart it with --workspaces to launch workspaces.',
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
      const entry = workspaceManager.getWorkspace(req.params.workspaceId);
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

  // Reboot/reset are exposed as programmatic endpoints (rather than an in-page
  // form) so the embedding host can drive them from its own controls and confirm
  // through a native dialog. Each returns the resulting status JSON; the caller
  // reloads the workspace iframe to pick up the fresh container.
  for (const action of ['reboot', 'reset'] as const) {
    app.post(
      `/workspace/:workspaceId/${action}`,
      asyncHandler(async (req, res) => {
        const entry = workspaceManager.getWorkspace(req.params.workspaceId);
        if (entry == null) {
          await sendQuestionPreviewHttpAction(res, mapQuestionPreviewWorkspaceStatusResponse(null));
          return;
        }

        if (action === 'reboot') {
          await workspaceManager.reboot(entry.id);
        } else {
          await workspaceManager.reset(entry.id);
        }
        // reboot() already kicks off a relaunch; reset() leaves the workspace
        // uninitialized, so start one here too or it would stay down until the
        // next page load triggers a launch.
        void workspaceManager.requestLaunch(entry.id);

        const updatedEntry = workspaceManager.getWorkspace(entry.id);
        await sendQuestionPreviewHttpAction(
          res,
          mapQuestionPreviewWorkspaceStatusResponse(
            updatedEntry == null
              ? null
              : makePreviewWorkspaceStatusJson(updatedEntry, {
                  containerUrl: workspaceManager.containerUrl(updatedEntry.id),
                }),
          ),
        );
      }),
    );
  }

  app.get(
    '/workspace/:workspaceId/status',
    asyncHandler(async (req, res) => {
      const entry = workspaceManager.getWorkspace(req.params.workspaceId);
      if (entry == null) {
        await sendQuestionPreviewHttpAction(res, mapQuestionPreviewWorkspaceStatusResponse(null));
        return;
      }

      if (req.query.heartbeat === '1') workspaceManager.heartbeat(entry.id);
      await sendQuestionPreviewHttpAction(
        res,
        mapQuestionPreviewWorkspaceStatusResponse(
          makePreviewWorkspaceStatusJson(entry, {
            containerUrl: workspaceManager.containerUrl(entry.id),
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
  courseSource: LocalPreviewCourseSource;
  httpOptions: QuestionPreviewServerHttpOptions;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewSubmissionFiles: LocalPreviewSubmissionFiles;
  runtime: QuestionPreviewRuntime;
  sessionPrefix: string;
  urlPrefix: string;
  workspaceManager: PreviewWorkspaceManager | null;
}

/**
 * Creates the Express app that serves direct previews, core assets, course
 * assets, generated files, and workspace pages, plus the upgrade handler that
 * tunnels workspace websocket traffic.
 */
function createQuestionPreviewApp({
  courseSource,
  httpOptions,
  localPreviewGeneratedFiles,
  localPreviewSubmissionFiles,
  runtime,
  sessionPrefix,
  urlPrefix,
  workspaceManager,
}: CreateQuestionPreviewAppParams) {
  const app = express();
  const assetResolver = createQuestionPreviewAssetResolver({
    courseSource,
    localPreviewGeneratedFiles,
    urlPrefix,
  });

  app.disable('x-powered-by');
  app.enable('strict routing');

  let workspaceUpgradeHandler:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)
    | null = null;
  let closeWorkspaceProxy = () => {};
  if (workspaceManager != null) {
    const workspaceProxy = makePreviewWorkspaceProxy({
      logger: (message) => console.error(message),
      targets: workspaceManager,
    });
    app.use(workspaceProxy.middleware);
    workspaceUpgradeHandler = workspaceProxy.upgrade;
    closeWorkspaceProxy = () => workspaceProxy.close();
  }
  registerQuestionPreviewWorkspaceRoutes(app, workspaceManager);

  app.get(
    '/questions/*',
    asyncHandler(async (req, res) => {
      const qid = questionQidFromRawPath(req, sessionPrefix);

      if (!qid) {
        await sendQuestionPreviewHttpAction(res, mapQuestionPreviewInvalidQidResponse());
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
    app.post('/questions/*', (req, res) => {
      const response = questionQidFromRawPath(req, sessionPrefix)
        ? mapQuestionPreviewGradingDisabledResponse()
        : mapQuestionPreviewInvalidQidResponse();
      void sendQuestionPreviewHttpAction(res, response);
    });
  } else {
    app.post(
      '/questions/*',
      // Mirrors the submission body limits of the full PrairieLearn server.
      express.urlencoded({ extended: false, limit: 5 * 1536 * 1024 }),
      asyncHandler(async (req, res) => {
        const qid = questionQidFromRawPath(req, sessionPrefix);

        if (!qid) {
          await sendQuestionPreviewHttpAction(res, mapQuestionPreviewInvalidQidResponse());
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

  registerQuestionPreviewAssetRoutes(app, assetResolver, sessionPrefix);
  registerQuestionPreviewSubmissionFileRoutes(app, localPreviewSubmissionFiles, sessionPrefix);

  app.use((_req, res) => {
    res.status(404).end();
  });

  app.use(questionPreviewErrorHandler());

  return { app, closeWorkspaceProxy, workspaceUpgradeHandler };
}

interface StartQuestionPreviewServerParams {
  argv: string[];
  createEngine?: typeof createQuestionPreviewEngine;
  createRuntime?: QuestionPreviewRuntimeFactory;
  createWorkspaceOwner?: PreviewWorkspaceOwnerFactory;
  localPreviewGeneratedFilesMax?: number;
  startupLogger?: QuestionPreviewStartupLogger;
}

/**
 * Parses options, creates the preview runtime, starts the HTTP server, and
 * returns a handle that can cleanly close everything it owns.
 */
export async function startQuestionPreviewServer({
  argv,
  createEngine = createQuestionPreviewEngine,
  createRuntime,
  createWorkspaceOwner = createPreviewWorkspaceOwner,
  localPreviewGeneratedFilesMax,
  startupLogger,
}: StartQuestionPreviewServerParams): Promise<StartedQuestionPreviewServer> {
  startupLogger?.('Reading preview server options.');
  const options = await parseQuestionPreviewServerOptions(argv);
  const httpOptions = getQuestionPreviewServerHttpOptions(options);
  const runtimeOptions = getQuestionPreviewServerRuntimeOptions(options);
  const workspaceOptions = getQuestionPreviewServerWorkspaceOptions(options);
  let engine: QuestionPreviewEngineLifecycle | null = null;
  let server: Server | null = null;
  let workspaceHomeRootToRemove: string | null = null;
  let workspaceOwner: PreviewWorkspaceOwner | null = null;

  if (createRuntime == null) {
    startupLogger?.('Initializing shared PrairieLearn preview engine.');
    engine = await createEngine({
      ...runtimeOptions,
      prewarmWorkers: true,
      ...(startupLogger == null ? {} : { startupLogger }),
    });
  }

  try {
    if (workspaceOptions.workspacesEnabled) {
      const homeRoot =
        workspaceOptions.workspaceHomeDir ??
        (workspaceHomeRootToRemove = await fs.mkdtemp(
          path.join(os.tmpdir(), 'pl-preview-workspaces-'),
        ));
      workspaceOwner = createWorkspaceOwner({
        containerNetwork: workspaceOptions.workspaceNetwork,
        homeRoot,
        homeVolume: workspaceOptions.workspaceHomeVolume,
        idleTimeoutMs: workspaceOptions.workspaceIdleTimeoutMs,
        logger: (message) => console.error(message),
        maxRunningContainers: workspaceOptions.workspaceMaxContainers,
        pullPolicy: workspaceOptions.workspacePullPolicy,
        startTimeoutMs: workspaceOptions.workspaceStartTimeoutMs,
      });
      try {
        await workspaceOwner.pruneOrphans();
      } catch (err) {
        startupLogger?.(
          `Skipping workspace orphan pruning: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    await workspaceOwner?.close().catch(() => {});
    if (workspaceHomeRootToRemove != null) {
      await fs.rm(workspaceHomeRootToRemove, { force: true, recursive: true }).catch(() => {});
    }
    await engine?.close().catch(() => {});
    throw err;
  }

  const catalog = new LocalPreviewSessionCatalog(async (previewSessionId, courseDir) => {
    const courseSource = await createLocalPreviewCourseSource(courseDir);
    const sessionPrefix = `/preview-sessions/${previewSessionId}`;
    const workspaceManager =
      workspaceOwner?.createSession({
        courseDir: courseSource.courseDir,
        previewSessionId,
        urlPrefix: sessionPrefix,
      }) ?? null;

    let runtime: QuestionPreviewRuntimeLifecycle;
    try {
      runtime =
        createRuntime == null
          ? createQuestionPreviewCourseRuntimeLifecycle({
              courseSource,
              engine: engine!,
              localPreviewGeneratedFilesMax,
              localPreviewWorkspaces: workspaceManager,
              renderMode: options.renderMode,
              urlPrefix: `${sessionPrefix}/preview-render`,
            })
          : await createQuestionPreviewRuntimeLifecycle({
              createRuntime,
              localPreviewGeneratedFilesMax,
              localPreviewWorkspaces: workspaceManager,
              runtimeOptions: {
                ...runtimeOptions,
                courseDir: courseSource.courseDir,
                courseSource,
                ...(startupLogger == null ? {} : { startupLogger }),
              },
              urlPrefix: `${sessionPrefix}/preview-render`,
            });
    } catch (err) {
      await workspaceManager?.close().catch(() => {});
      throw err;
    }

    const { app, closeWorkspaceProxy, workspaceUpgradeHandler } = createQuestionPreviewApp({
      courseSource,
      httpOptions,
      localPreviewGeneratedFiles: runtime.localPreviewGeneratedFiles,
      localPreviewSubmissionFiles: runtime.localPreviewSubmissionFiles,
      runtime,
      sessionPrefix,
      urlPrefix: runtime.urlPrefix,
      workspaceManager,
    });

    return {
      beginClose: closeWorkspaceProxy,
      async close() {
        let closeError: unknown;
        closeWorkspaceProxy();
        try {
          await workspaceManager?.close();
        } catch (err) {
          closeError = err;
        }
        await runtime.close().catch((err) => {
          closeError ??= err;
        });
        if (closeError != null) throw closeError as Error;
      },
      courseDir: courseSource.courseDir,
      handle: app,
      handleUpgrade: workspaceUpgradeHandler ?? undefined,
    };
  }, options.questionTimeoutMilliseconds);

  const controlPlaneError = (
    res: Response,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => {
    res.status(status).json({ error: { code, message, ...(details == null ? {} : { details }) } });
  };

  const authToken = process.env.PRAIRIELEARN_PREVIEW_AUTH_TOKEN;
  const requireControlPlaneAuth = (req: Request, res: Response, next: () => void) => {
    if (authToken == null || authToken === '') {
      next();
      return;
    }
    const authorization = req.get('authorization');
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expectedDigest = createHash('sha256').update(authToken).digest();
    const suppliedDigest = createHash('sha256').update(supplied).digest();
    if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
      controlPlaneError(res, 401, 'unauthorized', 'A valid bearer token is required.');
      return;
    }
    next();
  };

  const isCanonicalSessionId = (previewSessionId: string) =>
    /^pvs_[A-Za-z0-9_-]{22}$/.test(previewSessionId);
  const hasCanonicalSessionId = (req: Request, previewSessionId: string) =>
    isCanonicalSessionId(previewSessionId) &&
    rawOriginalRequestPathname(req).split('/')[2] === previewSessionId;

  const app = express();
  app.disable('x-powered-by');
  app.enable('strict routing');
  assets.applyMiddleware(app);
  app.use(
    '/localscripts/calculationQuestion',
    express.static(path.join(APP_ROOT_PATH, 'public/localscripts/calculationQuestion')),
  );
  app.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/metadata', requireControlPlaneAuth, (_req, res) => {
    res.json({
      apiVersion: 'experimental-1',
      prairieLearnVersion: PRAIRIELEARN_VERSION,
      previewSessionsEndpoint: '/preview-sessions',
      features: {
        renderModes: options.renderMode === 'full' ? ['question-only', 'full'] : ['question-only'],
        defaultRenderMode: options.renderMode,
        grading: options.renderMode === 'full',
        workspaces: options.workspacesEnabled,
        workspaceControls: options.workspacesEnabled ? ['reboot', 'reset'] : [],
      },
      limits: {
        questionTimeoutMs: options.questionTimeoutMilliseconds,
        workersCount: options.workersCount,
        ...(options.workspacesEnabled
          ? {
              workspaceIdleTimeoutMs: options.workspaceIdleTimeoutMs,
              workspaceMaxContainers: options.workspaceMaxContainers,
              workspaceStartTimeoutMs: options.workspaceStartTimeoutMs,
            }
          : {}),
      },
    });
  });
  app.get('/preview-sessions', requireControlPlaneAuth, (_req, res) => {
    res.json({ previewSessions: catalog.list() });
  });
  app.post(
    '/preview-sessions',
    requireControlPlaneAuth,
    express.json({ limit: '16kb', strict: true }),
    asyncHandler(async (req, res) => {
      const courseDir = req.body?.courseDir;
      if (typeof courseDir !== 'string' || !path.isAbsolute(courseDir)) {
        controlPlaneError(
          res,
          400,
          'invalid_request',
          'courseDir must be an absolute path.',
          typeof courseDir === 'string' ? { courseDir } : undefined,
        );
        return;
      }
      try {
        const descriptor = await catalog.create(courseDir);
        res.status(201).json(descriptor);
      } catch (err) {
        if (err instanceof InvalidLocalPreviewCourseError) {
          controlPlaneError(
            res,
            422,
            'invalid_course_dir',
            'The course directory does not exist or is not a PrairieLearn course.',
            { courseDir },
          );
        } else {
          controlPlaneError(
            res,
            503,
            'capability_unavailable',
            'The Local Preview Session could not be created.',
          );
        }
      }
    }),
  );
  app.delete(
    '/preview-sessions/:previewSessionId',
    requireControlPlaneAuth,
    asyncHandler(async (req, res) => {
      if (
        !hasCanonicalSessionId(req, req.params.previewSessionId) ||
        !(await catalog.delete(req.params.previewSessionId))
      ) {
        controlPlaneError(
          res,
          404,
          'preview_session_not_found',
          'The Local Preview Session does not exist.',
        );
        return;
      }
      res.status(204).end();
    }),
  );
  app.use('/preview-sessions/:previewSessionId', (req, res, next) => {
    const previewSessionId = req.params.previewSessionId;
    if (!hasCanonicalSessionId(req, previewSessionId)) {
      void sendQuestionPreviewHttpAction(res, mapLocalPreviewSessionNotFoundResponse()).catch(next);
      return;
    }
    const lease = catalog.acquire(previewSessionId);
    if (lease == null) {
      void sendQuestionPreviewHttpAction(res, mapLocalPreviewSessionNotFoundResponse()).catch(next);
      return;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lease.release();
    };
    res.once('finish', release);
    res.once('close', release);
    lease.handle(req, res, next);
  });
  app.use((_req, res) => res.status(404).end());
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (_req.path === '/preview-sessions' || _req.path === '/metadata') {
      controlPlaneError(res, 400, 'invalid_request', 'The request body is invalid.');
    } else if (rawOriginalRequestPathname(_req).startsWith('/preview-sessions/')) {
      void sendQuestionPreviewHttpAction(res, mapQuestionPreviewInvalidQidResponse()).catch(next);
    } else {
      res.status(404).end();
    }
  });

  try {
    const startupSessions: LocalPreviewSessionDescriptor[] = [];
    for (const courseDir of options.courseDirs) {
      const session = await catalog.create(courseDir);
      startupSessions.push(session);
      startupLogger?.(
        `Created startup Local Preview Session ${session.previewSessionId}: ${session.courseDir}.`,
      );
    }

    startupLogger?.(`Starting HTTP server on ${httpOptions.host}:${httpOptions.port}.`);
    server = app.listen(httpOptions.port, httpOptions.host);
    server.on('upgrade', (req, socket, head) => {
      const previewSessionId = rawRequestPathname(req).split('/')[2] ?? '';
      if (!isCanonicalSessionId(previewSessionId)) {
        socket.destroy();
        return;
      }
      const lease = catalog.acquire(previewSessionId);
      if (lease == null) {
        socket.destroy();
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        lease.release();
      };
      socket.once('close', release);
      socket.once('error', release);
      lease.handleUpgrade(req, socket, head);
    });
    await waitForListening(server);
    return {
      async close() {
        let closeError: unknown;
        const serverClosed = new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        await catalog.close().catch((err) => {
          closeError ??= err;
        });
        await serverClosed.catch((err) => {
          closeError ??= err;
        });
        await workspaceOwner?.close().catch((err) => {
          closeError ??= err;
        });
        if (workspaceHomeRootToRemove != null) {
          await fs.rm(workspaceHomeRootToRemove, { force: true, recursive: true }).catch((err) => {
            closeError ??= err;
          });
        }
        await engine?.close().catch((err) => {
          closeError ??= err;
        });
        if (closeError != null) throw closeError as Error;
      },
      options,
      server,
      startupSessions,
    };
  } catch (err) {
    await catalog.close().catch(() => {});
    await workspaceOwner?.close().catch(() => {});
    if (workspaceHomeRootToRemove != null) {
      await fs.rm(workspaceHomeRootToRemove, { force: true, recursive: true }).catch(() => {});
    }
    await engine?.close().catch(() => {});
    if (server != null) await new Promise<void>((resolve) => server!.close(() => resolve()));
    throw err;
  }
}
