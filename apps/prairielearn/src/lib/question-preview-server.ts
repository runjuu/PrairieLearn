import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import minimist from 'minimist';

import { discoverInfoDirs } from './discover-info-dirs.js';
import { APP_ROOT_PATH, REPOSITORY_ROOT_PATH } from './paths.js';
import {
  type QuestionPreviewCacheType,
  type QuestionPreviewDiagnostic,
  type QuestionPreviewPayload,
  type QuestionPreviewRuntime,
  type QuestionPreviewRuntimeOptions,
  type QuestionPreviewWorkersExecutionMode,
  createQuestionPreviewRuntime,
} from './question-preview-render.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;
const DEFAULT_QUESTION_TIMEOUT_MS = 5000;
const DEFAULT_RENDER_TIMEOUT_MS = 10000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_CORS_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];

export interface QuestionPreviewServerOptions {
  cacheType: QuestionPreviewCacheType;
  corsOrigins: string[];
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

export interface QuestionDiscoveryItem {
  previewUrl: string;
  qid: string;
  title: string;
  topic: string | null;
  type: string;
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

function stringArrayArg(argv: Record<string, unknown>, primary: string) {
  const value = argv[primary];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
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

function parseWorkersExecutionMode(value = 'native'): QuestionPreviewWorkersExecutionMode {
  const mode = value;
  if (mode !== 'native' && mode !== 'container') {
    throw new Error(
      `Invalid --workers-execution-mode "${mode}". Expected "native" or "container".`,
    );
  }
  return mode;
}

function parseCacheType(value = 'none'): QuestionPreviewCacheType {
  const cacheType = value;
  if (cacheType !== 'none' && cacheType !== 'memory' && cacheType !== 'redis') {
    throw new Error(`Invalid --cache-type "${cacheType}". Expected "none", "memory", or "redis".`);
  }
  return cacheType;
}

function parseCorsOrigins(values: string[] | undefined) {
  const rawOrigins = values ?? DEFAULT_CORS_ORIGINS;
  const origins = rawOrigins.flatMap((value) => value.split(',').map((origin) => origin.trim()));
  const parsedOrigins = origins
    .filter((origin) => origin.length > 0)
    .map((origin) => {
      try {
        const url = new URL(origin);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
        return url.origin;
      } catch {
        throw new Error(`Invalid --cors-origin "${origin}". Expected an HTTP(S) origin.`);
      }
    });

  return [...new Set(parsedOrigins)];
}

async function assertValidCourseDir(courseDir: string) {
  try {
    const stat = await fs.stat(courseDir);
    if (!stat.isDirectory()) throw new Error('not a directory');
    const questionsStat = await fs.stat(path.join(courseDir, 'questions'));
    if (!questionsStat.isDirectory()) throw new Error('missing questions directory');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid --course-dir "${courseDir}": ${detail}`, { cause: err });
  }
}

export async function parseQuestionPreviewServerOptions(
  argvInput: string[],
): Promise<QuestionPreviewServerOptions> {
  const argv = minimist(argvInput, {
    boolean: ['dev-mode'],
    string: [
      'cache-type',
      'cors-origin',
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
    'cors-origin',
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
    corsOrigins: parseCorsOrigins(stringArrayArg(argv, 'cors-origin')),
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

class ReplaceableQuestionPreviewRuntime implements QuestionPreviewRuntime {
  private currentRuntime: QuestionPreviewRuntime | null;
  private nextRuntimePromise: Promise<QuestionPreviewRuntime> | null = null;

  constructor(
    initialRuntime: QuestionPreviewRuntime,
    private readonly createRuntime: (
      options: QuestionPreviewRuntimeOptions,
    ) => Promise<QuestionPreviewRuntime>,
    private readonly runtimeOptions: QuestionPreviewRuntimeOptions,
  ) {
    this.currentRuntime = initialRuntime;
  }

  private async getRuntime() {
    if (this.currentRuntime != null) return this.currentRuntime;

    this.nextRuntimePromise ??= this.createRuntime(this.runtimeOptions).finally(() => {
      this.nextRuntimePromise = null;
    });
    this.currentRuntime = await this.nextRuntimePromise;
    return this.currentRuntime;
  }

  private async discardRuntime(runtime: QuestionPreviewRuntime) {
    if (this.currentRuntime !== runtime) return;
    this.currentRuntime = null;

    try {
      await runtime.close();
    } catch {
      // The runtime has already failed. A close failure should not prevent
      // the request from reporting the original infrastructure failure.
    }
  }

  async render(input: Parameters<QuestionPreviewRuntime['render']>[0]) {
    const runtime = await this.getRuntime();

    try {
      return await runtime.render(input);
    } catch (err) {
      await this.discardRuntime(runtime);
      throw err;
    }
  }

  async close() {
    const pendingRuntime = this.nextRuntimePromise;
    if (pendingRuntime != null) {
      await pendingRuntime.catch(() => null);
    }

    const runtime = this.currentRuntime;
    this.currentRuntime = null;
    await runtime?.close();
  }
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

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendEmpty(res: http.ServerResponse, statusCode: number) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
  });
  res.end();
}

function contentTypeForPath(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.gif':
      return 'image/gif';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function decodeAssetPathSegments(encodedPath: string) {
  if (encodedPath.length === 0) return null;

  const segments = encodedPath.split('/');
  if (segments.length === 0) return null;

  const decodedSegments: string[] = [];
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }

    if (
      decoded.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\0') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      path.isAbsolute(decoded)
    ) {
      return null;
    }

    decodedSegments.push(decoded);
  }

  return decodedSegments;
}

function isPathInsideRoot(root: string, filePath: string) {
  const relativePath = path.relative(root, filePath);
  return (
    relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

async function resolveBoundedFile(rootInput: string, pathSegments: string[]) {
  const root = path.resolve(rootInput);
  const filePath = path.resolve(root, ...pathSegments);
  if (!isPathInsideRoot(root, filePath)) return null;

  let currentPath = root;
  const rootStat = await fs.lstat(currentPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;

  let fileStat = rootStat;
  for (const segment of pathSegments) {
    currentPath = path.join(currentPath, segment);
    fileStat = await fs.lstat(currentPath);
    if (fileStat.isSymbolicLink()) return null;
  }

  if (!fileStat.isFile()) return null;
  return filePath;
}

async function resolveBoundedFileFromRoots(roots: string[], pathSegments: string[]) {
  for (const root of roots) {
    try {
      const filePath = await resolveBoundedFile(root, pathSegments);
      if (filePath != null) return filePath;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') continue;
      throw err;
    }
  }

  return null;
}

function assetRequestFromPathname(courseDir: string, pathname: string) {
  const appNodeModules = path.join(APP_ROOT_PATH, 'node_modules');
  const repoNodeModules = path.join(REPOSITORY_ROOT_PATH, 'node_modules');
  const staticAssetRoutes = [
    {
      prefix: '/assets/build/',
      roots: [path.join(APP_ROOT_PATH, 'public', 'build')],
      stripCachebuster: false,
    },
    {
      prefix: '/assets/public/',
      roots: [path.join(APP_ROOT_PATH, 'public')],
      stripCachebuster: true,
    },
    {
      prefix: '/assets/node_modules/',
      roots: [appNodeModules, repoNodeModules],
      stripCachebuster: true,
    },
    {
      prefix: '/assets/elements/',
      roots: [path.join(APP_ROOT_PATH, 'elements')],
      stripCachebuster: true,
    },
    {
      prefix: '/preview-render/clientFilesCourse/',
      roots: [path.join(courseDir, 'clientFilesCourse')],
      stripCachebuster: false,
    },
    {
      prefix: '/preview-render/elements/',
      roots: [path.join(courseDir, 'elements')],
      stripCachebuster: false,
    },
    {
      prefix: '/preview-render/cacheableElements/',
      roots: [path.join(courseDir, 'elements')],
      stripCachebuster: true,
    },
    {
      prefix: '/preview-render/elementExtensions/',
      roots: [path.join(courseDir, 'elementExtensions')],
      stripCachebuster: false,
    },
    {
      prefix: '/preview-render/cacheableElementExtensions/',
      roots: [path.join(courseDir, 'elementExtensions')],
      stripCachebuster: true,
    },
  ];

  for (const route of staticAssetRoutes) {
    if (!pathname.startsWith(route.prefix)) continue;

    const segments = decodeAssetPathSegments(pathname.slice(route.prefix.length));
    if (segments == null) return null;

    const fileSegments = route.stripCachebuster ? segments.slice(1) : segments;
    if (fileSegments.length === 0) return null;

    return {
      roots: route.roots,
      segments: fileSegments,
    };
  }

  const questionFilesPrefix = '/preview-render/questions/';
  if (pathname.startsWith(questionFilesPrefix)) {
    const segments = decodeAssetPathSegments(pathname.slice(questionFilesPrefix.length));
    if (segments == null) return null;

    const filesSegmentIndex = segments.lastIndexOf('files');
    if (filesSegmentIndex <= 0 || filesSegmentIndex === segments.length - 1) return null;

    const qidSegments = segments.slice(0, filesSegmentIndex);
    const fileSegments = segments.slice(filesSegmentIndex + 1);

    return {
      roots: [path.join(courseDir, 'questions', ...qidSegments, 'clientFilesQuestion')],
      segments: fileSegments,
    };
  }

  return null;
}

function rawRequestPathname(req: http.IncomingMessage) {
  const rawUrl = req.url ?? '/';
  const queryStart = rawUrl.search(/[?#]/);
  return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}

function isAssetRoutePathname(pathname: string) {
  return pathname.startsWith('/assets/') || pathname.startsWith('/preview-render/');
}

async function handleAssetRequest({
  options,
  req,
  res,
}: {
  options: QuestionPreviewServerOptions;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendEmpty(res, 405);
    return;
  }

  const assetRequest = assetRequestFromPathname(options.courseDir, rawRequestPathname(req));
  if (assetRequest == null) {
    sendEmpty(res, 404);
    return;
  }

  const filePath = await resolveBoundedFileFromRoots(assetRequest.roots, assetRequest.segments);
  if (filePath == null) {
    sendEmpty(res, 404);
    return;
  }

  const contents = req.method === 'HEAD' ? null : await fs.readFile(filePath);
  res.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': contentTypeForPath(filePath),
  });
  res.end(contents);
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

const DIAGNOSTIC_EXCERPT_MAX_CHARS = 2000;

function sanitizeBrowserDiagnosticText(value: string, sanitizePaths: string[]) {
  return sanitizePaths.reduce((result, unsafePath) => {
    if (unsafePath.length === 0) return result;
    return result.split(unsafePath).join('<course>');
  }, value);
}

function truncateDiagnosticExcerpt(value: string) {
  if (value.length <= DIAGNOSTIC_EXCERPT_MAX_CHARS) return value;
  return `${value.slice(0, DIAGNOSTIC_EXCERPT_MAX_CHARS)}\n[truncated]`;
}

type DiagnosticOutputField = 'outputBoth' | 'stderr' | 'stdout';

function diagnosticDataField(data: unknown, field: DiagnosticOutputField) {
  if (typeof data !== 'object' || data == null || Array.isArray(data)) return null;

  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function renderDiagnosticExcerpt({
  data,
  field,
  sanitizePaths,
}: {
  data: unknown;
  field: DiagnosticOutputField;
  sanitizePaths: string[];
}) {
  const value = diagnosticDataField(data, field);
  if (value == null) return '';

  const label = field === 'outputBoth' ? 'output' : field;
  const sanitized = sanitizeBrowserDiagnosticText(truncateDiagnosticExcerpt(value), sanitizePaths);
  return `<details open><summary>${label}</summary><pre>${escapeHtml(sanitized)}</pre></details>`;
}

function renderDiagnosticDocument(
  diagnostics: QuestionPreviewDiagnostic[],
  { sanitizePaths = [] }: { sanitizePaths?: string[] } = {},
) {
  const items = diagnostics
    .map((diagnostic) => {
      const phase = diagnostic.phase ? `<p>Phase: ${escapeHtml(diagnostic.phase)}</p>` : '';
      const message = escapeHtml(sanitizeBrowserDiagnosticText(diagnostic.message, sanitizePaths));
      const output = renderDiagnosticExcerpt({
        data: diagnostic.data,
        field: 'outputBoth',
        sanitizePaths,
      });
      const stdout = renderDiagnosticExcerpt({
        data: diagnostic.data,
        field: 'stdout',
        sanitizePaths,
      });
      const stderr = renderDiagnosticExcerpt({
        data: diagnostic.data,
        field: 'stderr',
        sanitizePaths,
      });
      return `<li><strong>${escapeHtml(diagnostic.name)}</strong>${phase}<p>${message}</p>${output}${stdout}${stderr}</li>`;
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

function previewUrlForQid(qid: string) {
  return `/questions/${qid.split('/').map(encodeURIComponent).join('/')}?variant=1`;
}

function questionDiscoveryItem(qid: string, info: Record<string, unknown>): QuestionDiscoveryItem {
  if (
    typeof info.title !== 'string' ||
    typeof info.topic !== 'string' ||
    typeof info.type !== 'string'
  ) {
    throw new Error('Expected info.json to contain string title, topic, and type fields.');
  }

  return {
    previewUrl: previewUrlForQid(qid),
    qid,
    title: info.title,
    topic: info.topic,
    type: info.type,
  };
}

function invalidQuestionDiscoveryItem(qid: string): QuestionDiscoveryItem {
  return {
    previewUrl: previewUrlForQid(qid),
    qid,
    title: qid,
    topic: null,
    type: 'invalid-info-json',
  };
}

export async function listQuestionDiscoveryItems(
  courseDir: string,
): Promise<QuestionDiscoveryItem[]> {
  const questionsRoot = path.join(courseDir, 'questions');
  const qids = await discoverInfoDirs(questionsRoot, 'info.json');
  const questions = await Promise.all(
    qids.map(async (qidPath) => {
      const qid = qidPath.split(path.sep).join('/');
      const infoPath = path.join(questionsRoot, qidPath, 'info.json');
      try {
        const info = JSON.parse(await fs.readFile(infoPath, 'utf8')) as unknown;
        if (typeof info !== 'object' || info == null || Array.isArray(info)) {
          throw new Error('Expected info.json to contain an object.');
        }
        return questionDiscoveryItem(qid, info as Record<string, unknown>);
      } catch {
        return invalidQuestionDiscoveryItem(qid);
      }
    }),
  );
  return questions.sort((a, b) => a.qid.localeCompare(b.qid));
}

function requestHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function discoveryCorsHeaders(
  options: QuestionPreviewServerOptions,
  req: http.IncomingMessage,
  headers: Record<string, string> = {},
) {
  const origin = requestHeaderValue(req.headers.origin);
  if (origin == null || !options.corsOrigins.includes(origin)) return headers;

  return {
    ...headers,
    'access-control-allow-origin': origin,
    vary: 'Origin',
  };
}

async function handleQuestionDiscoveryRequest({
  options,
  req,
  res,
}: {
  options: QuestionPreviewServerOptions;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}) {
  if (req.method === 'OPTIONS') {
    const requestHeaders = requestHeaderValue(req.headers['access-control-request-headers']);
    res.writeHead(
      204,
      discoveryCorsHeaders(options, req, {
        'access-control-allow-methods': 'GET, OPTIONS',
        ...(requestHeaders ? { 'access-control-allow-headers': requestHeaders } : {}),
      }),
    );
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' }, discoveryCorsHeaders(options, req));
    return;
  }

  sendJson(
    res,
    200,
    await listQuestionDiscoveryItems(options.courseDir),
    discoveryCorsHeaders(options, req),
  );
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
  const pathname = rawRequestPathname(req);
  const qid = qidFromPathname(pathname);
  if (req.method !== 'GET' || qid == null) {
    sendHtml(res, 404, '<!doctype html><html><body><h1>Not found</h1></body></html>');
    return;
  }

  if (!url.searchParams.has('variant')) {
    url.searchParams.set('variant', '1');
    res.writeHead(302, { location: `${pathname}${url.search}` });
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

  sendHtml(
    res,
    422,
    renderDiagnosticDocument(result.diagnostics, { sanitizePaths: [options.courseDir] }),
  );
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
  const runtimeOptions = makeRuntimeOptions(options);
  const runtime = new ReplaceableQuestionPreviewRuntime(
    await createRuntime(runtimeOptions),
    createRuntime,
    runtimeOptions,
  );
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
    const rawPathname = rawRequestPathname(req);
    const handler =
      url.pathname === '/api/questions'
        ? handleQuestionDiscoveryRequest
        : isAssetRoutePathname(rawPathname)
          ? handleAssetRequest
          : handleQuestionPreviewRequest;

    handler({ options, req, res, runtime }).catch((err) => {
      const diagnostic: QuestionPreviewDiagnostic = {
        fatal: true,
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : 'Error',
        phase: 'render',
      };
      sendHtml(
        res,
        500,
        renderDiagnosticDocument([diagnostic], { sanitizePaths: [options.courseDir] }),
      );
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
