import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

import minimist from 'minimist';

import {
  createQuestionPreviewRuntime,
  type QuestionPreviewCacheType,
  type QuestionPreviewDiagnostic,
  type QuestionPreviewPayload,
  type QuestionPreviewRuntime,
  type QuestionPreviewRuntimeOptions,
  type QuestionPreviewWorkersExecutionMode,
} from './question-preview-render.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;
const DEFAULT_QUESTION_TIMEOUT_MS = 5000;
const DEFAULT_RENDER_TIMEOUT_MS = 10000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;

export interface QuestionPreviewServerOptions {
  cacheType: QuestionPreviewCacheType;
  courseDir: string;
  devMode: boolean;
  host: string;
  port: number;
  questionTimeoutMilliseconds: number;
  renderTimeoutMilliseconds: number;
  startupTimeoutMilliseconds: number;
  workersCount: number;
  workersExecutionMode: QuestionPreviewWorkersExecutionMode;
}

export interface StartedQuestionPreviewServer {
  close(): Promise<void>;
  options: QuestionPreviewServerOptions;
  runtime: QuestionPreviewRuntime;
  server: http.Server;
}

function stringArg(argv: Record<string, unknown>, primary: string) {
  const value = argv[primary];
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}

function booleanArg(argv: Record<string, unknown>, primary: string, defaultValue = false) {
  const value = argv[primary];
  if (typeof value === 'boolean') return value;
  return defaultValue;
}

function parsePort(value: string | undefined) {
  if (value == null) return DEFAULT_PORT;
  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || String(port) !== value) {
    throw new Error(`Invalid --port "${value}". Expected an integer from 0 through 65535.`);
  }
  return port;
}

function parsePositiveInteger(value: string | undefined, flagName: string, defaultValue: number) {
  if (value == null) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`Invalid --${flagName} "${value}". Expected a positive integer.`);
  }
  return parsed;
}

function parseWorkersExecutionMode(value: string | undefined): QuestionPreviewWorkersExecutionMode {
  const mode = value ?? 'native';
  if (mode !== 'native' && mode !== 'container') {
    throw new Error(
      `Invalid --workers-execution-mode "${mode}". Expected "native" or "container".`,
    );
  }
  return mode;
}

function parseCacheType(value: string | undefined): QuestionPreviewCacheType {
  const cacheType = value ?? 'none';
  if (cacheType !== 'none' && cacheType !== 'memory' && cacheType !== 'redis') {
    throw new Error(`Invalid --cache-type "${cacheType}". Expected "none", "memory", or "redis".`);
  }
  return cacheType;
}

async function assertValidCourseDir(courseDir: string) {
  try {
    const stat = await fs.stat(courseDir);
    if (!stat.isDirectory()) throw new Error('not a directory');
    const questionsStat = await fs.stat(path.join(courseDir, 'questions'));
    if (!questionsStat.isDirectory()) throw new Error('missing questions directory');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid --course-dir "${courseDir}": ${detail}`);
  }
}

export async function parseQuestionPreviewServerOptions(
  argvInput: string[],
): Promise<QuestionPreviewServerOptions> {
  const argv = minimist(argvInput, {
    boolean: ['dev-mode'],
    string: [
      'cache-type',
      'course-dir',
      'host',
      'port',
      'question-timeout-ms',
      'render-timeout-ms',
      'startup-timeout-ms',
      'workers-count',
      'workers-execution-mode',
    ],
  });

  if (argv._.length > 0) {
    throw new Error(`Unexpected positional arguments: ${argv._.join(' ')}`);
  }

  const supportedFlags = new Set([
    '_',
    'cache-type',
    'course-dir',
    'dev-mode',
    'host',
    'port',
    'question-timeout-ms',
    'render-timeout-ms',
    'startup-timeout-ms',
    'workers-count',
    'workers-execution-mode',
  ]);
  const unsupportedFlags = Object.keys(argv).filter((flag) => !supportedFlags.has(flag));
  if (unsupportedFlags.length > 0) {
    throw new Error(`Unsupported preview-server flag(s): ${unsupportedFlags.join(', ')}.`);
  }

  const rawCourseDir = stringArg(argv, 'course-dir');
  if (!rawCourseDir) {
    throw new Error('Missing required --course-dir <path> for the local preview server.');
  }

  const courseDir = path.resolve(rawCourseDir);
  await assertValidCourseDir(courseDir);

  return {
    cacheType: parseCacheType(stringArg(argv, 'cache-type')),
    courseDir,
    devMode: booleanArg(argv, 'dev-mode'),
    host: stringArg(argv, 'host') ?? DEFAULT_HOST,
    port: parsePort(stringArg(argv, 'port')),
    questionTimeoutMilliseconds: parsePositiveInteger(
      stringArg(argv, 'question-timeout-ms'),
      'question-timeout-ms',
      DEFAULT_QUESTION_TIMEOUT_MS,
    ),
    renderTimeoutMilliseconds: parsePositiveInteger(
      stringArg(argv, 'render-timeout-ms'),
      'render-timeout-ms',
      DEFAULT_RENDER_TIMEOUT_MS,
    ),
    startupTimeoutMilliseconds: parsePositiveInteger(
      stringArg(argv, 'startup-timeout-ms'),
      'startup-timeout-ms',
      DEFAULT_STARTUP_TIMEOUT_MS,
    ),
    workersCount: parsePositiveInteger(stringArg(argv, 'workers-count'), 'workers-count', 1),
    workersExecutionMode: parseWorkersExecutionMode(stringArg(argv, 'workers-execution-mode')),
  };
}

function listen(server: http.Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function makeRuntimeOptions(options: QuestionPreviewServerOptions): QuestionPreviewRuntimeOptions {
  return {
    cacheType: options.cacheType,
    courseDir: options.courseDir,
    devMode: options.devMode,
    prewarmWorkers: true,
    questionTimeoutMilliseconds: options.questionTimeoutMilliseconds,
    urlPrefix: '/preview-render',
    workersCount: options.workersCount,
    workersExecutionMode: options.workersExecutionMode,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sendHtml(res: http.ServerResponse, statusCode: number, html: string) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  });
  res.end(html);
}

function renderPreviewDocument(payload: QuestionPreviewPayload) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${payload.headHtml}
</head>
<body>
${payload.bodyHtml}
</body>
</html>`;
}

function renderDiagnosticDocument(diagnostics: QuestionPreviewDiagnostic[]) {
  const items = diagnostics
    .map((diagnostic) => {
      const phase = diagnostic.phase ? `<p>Phase: ${escapeHtml(diagnostic.phase)}</p>` : '';
      return `<li><strong>${escapeHtml(diagnostic.name)}</strong>${phase}<p>${escapeHtml(diagnostic.message)}</p></li>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Question Preview Diagnostic</title>
</head>
<body>
<main>
<h1>Question Preview Diagnostic</h1>
<ul>${items}</ul>
</main>
</body>
</html>`;
}

function qidFromPathname(pathname: string) {
  const prefix = '/questions/';
  if (!pathname.startsWith(prefix) || pathname.length === prefix.length) return null;
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

async function handleQuestionPreviewRequest({
  options,
  req,
  res,
  runtime,
}: {
  options: QuestionPreviewServerOptions;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  runtime: QuestionPreviewRuntime;
}) {
  const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
  const qid = qidFromPathname(url.pathname);
  if (req.method !== 'GET' || qid == null) {
    sendHtml(res, 404, '<!doctype html><html><body><h1>Not found</h1></body></html>');
    return;
  }

  if (!url.searchParams.has('variant')) {
    url.searchParams.set('variant', '1');
    res.writeHead(302, { location: `${url.pathname}${url.search}` });
    res.end();
    return;
  }

  const result = await runtime.render({
    qid,
    variantSeed: url.searchParams.get('variant') ?? '1',
  });

  if (result.ok) {
    sendHtml(res, 200, renderPreviewDocument(result.payload));
    return;
  }

  sendHtml(res, 422, renderDiagnosticDocument(result.diagnostics));
}

export async function startQuestionPreviewServer({
  argv = process.argv.slice(2),
  createRuntime = createQuestionPreviewRuntime,
  onReady,
}: {
  argv?: string[];
  createRuntime?: (options: QuestionPreviewRuntimeOptions) => Promise<QuestionPreviewRuntime>;
  onReady?: (started: StartedQuestionPreviewServer) => void;
} = {}): Promise<StartedQuestionPreviewServer> {
  const options = await parseQuestionPreviewServerOptions(argv);
  const runtime = await createRuntime(makeRuntimeOptions(options));
  const server = http.createServer((req, res) => {
    handleQuestionPreviewRequest({ options, req, res, runtime }).catch((err) => {
      const diagnostic: QuestionPreviewDiagnostic = {
        fatal: true,
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : 'Error',
        phase: 'render',
      };
      sendHtml(res, 500, renderDiagnosticDocument([diagnostic]));
    });
  });

  await listen(server, options.port, options.host);

  const started: StartedQuestionPreviewServer = {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await runtime.close();
    },
    options,
    runtime,
    server,
  };
  onReady?.(started);
  return started;
}
