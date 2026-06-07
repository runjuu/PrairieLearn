import type { IncomingMessage, Server } from 'node:http';

import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';
import asyncHandler from 'express-async-handler';

import * as assets from '../assets.js';

import { createQuestionPreviewAssetResolver } from './assets.js';
import type { LocalPreviewGeneratedFiles } from './generated-files.js';
import {
  type QuestionPreviewHttpAction,
  type QuestionPreviewHttpResponse,
  mapQuestionPreviewAssetFileResponse,
  mapQuestionPreviewDocumentResponse,
  mapQuestionPreviewGeneratedFileResponse,
  mapQuestionPreviewInvalidQidResponse,
  mapQuestionPreviewRouteErrorResponse,
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
  parseQuestionPreviewServerOptions,
} from './server-options.js';

export { parseQuestionPreviewServerOptions, type QuestionPreviewServerOptions };

export interface StartedQuestionPreviewServer {
  close(): Promise<void>;
  options: QuestionPreviewServerOptions;
  runtime: QuestionPreviewRuntime;
  server: Server;
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
}

/**
 * Handles direct question preview URLs and renders the requested question.
 */
async function handleQuestionPreviewRequest({
  qid,
  req,
  res,
  runtime,
}: HandleQuestionPreviewRequestParams) {
  const qidResult = parseQuestionPreviewQid(qid);
  if (!qidResult.ok) {
    await sendQuestionPreviewHttpAction(res, mapQuestionPreviewInvalidQidResponse());
    return;
  }

  const url = new URL(req.url, 'http://question-preview.local');

  const result = await runtime.render({
    qid: qidResult.qid,
    variantSeed: url.searchParams.get('variant') ?? undefined,
  });

  await sendQuestionPreviewHttpAction(res, mapQuestionPreviewDocumentResponse(result));
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
}

/**
 * Creates the Express app that serves direct previews, core assets, course
 * assets, and generated files.
 */
function createQuestionPreviewApp({
  httpOptions,
  localPreviewGeneratedFiles,
  runtime,
  urlPrefix,
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

  app.get(
    '/questions/*',
    asyncHandler(async (req, res) => {
      const qid = req.params[0];

      if (!qid) {
        res.status(404).end();
        return;
      }

      await handleQuestionPreviewRequest({ qid, req, res, runtime });
    }),
  );

  registerQuestionPreviewAssetRoutes(app, assetResolver);

  app.use((_req, res) => {
    res.status(404).end();
  });

  app.use(questionPreviewErrorHandler());

  return app;
}

interface StartQuestionPreviewServerParams {
  argv: string[];
  createRuntime: QuestionPreviewRuntimeFactory;
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
  localPreviewGeneratedFilesMax,
  startupLogger,
}: StartQuestionPreviewServerParams): Promise<StartedQuestionPreviewServer> {
  startupLogger?.('Reading preview server options.');
  const options = await parseQuestionPreviewServerOptions(argv);
  startupLogger?.(`Validated course directory: ${options.courseDir}.`);

  const httpOptions = getQuestionPreviewServerHttpOptions(options);
  const runtimeOptions = getQuestionPreviewServerRuntimeOptions(options);
  let runtime: QuestionPreviewRuntimeLifecycle | null = null;
  let server: Server | null = null;

  try {
    startupLogger?.('Initializing preview runtime.');
    runtime = await createQuestionPreviewRuntimeLifecycle({
      createRuntime,
      localPreviewGeneratedFilesMax,
      runtimeOptions: startupLogger == null ? runtimeOptions : { ...runtimeOptions, startupLogger },
    });

    startupLogger?.('Preparing preview asset routes.');
    await assets.init();

    startupLogger?.(`Starting HTTP server on ${httpOptions.host}:${httpOptions.port}.`);
    server = createQuestionPreviewApp({
      httpOptions,
      localPreviewGeneratedFiles: runtime.localPreviewGeneratedFiles,
      runtime,
      urlPrefix: runtime.urlPrefix,
    }).listen(httpOptions.port, httpOptions.host);
    await waitForListening(server);
  } catch (err) {
    await runtime?.close().catch(() => {});

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
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        closeError = err;
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
  };
}
