import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { discoverInfoDirs } from './discover-info-dirs.js';
import { APP_ROOT_PATH, REPOSITORY_ROOT_PATH } from './paths.js';
import {
  parseQuestionPreviewServerOptions,
  type QuestionPreviewServerOptions,
} from './question-preview-server-options.js';
import {
  type QuestionPreviewDiagnostic,
  type QuestionPreviewPayload,
  type QuestionPreviewRuntime,
  type QuestionPreviewRuntimeRenderInput,
  type QuestionPreviewRuntimeRenderOptions,
  type QuestionPreviewRuntimeOptions,
  createQuestionPreviewRuntime,
} from './question-preview-render.js';

const GENERATED_FILES_TEMP_PREFIX = 'pl-preview-server-generated-files-';
const GENERATED_FILES_OWNER_FILE = '.owner.json';
const activeGeneratedFilesRoots = new Set<string>();

export { parseQuestionPreviewServerOptions, type QuestionPreviewServerOptions };

export interface QuestionDiscoveryItem {
  previewUrl: string;
  qid: string;
  title: string;
  topic: string | null;
  type: string;
}

export interface StartedQuestionPreviewServer {
  close(): Promise<void>;
  generatedFilesRoot: string;
  options: QuestionPreviewServerOptions;
  runtime: QuestionPreviewRuntime;
  server: http.Server;
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

function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ESRCH') return false;
    return true;
  }
}

async function generatedFilesRootOwnerPid(root: string) {
  try {
    const owner = JSON.parse(
      await fs.readFile(path.join(root, GENERATED_FILES_OWNER_FILE), 'utf8'),
    ) as unknown;
    if (typeof owner !== 'object' || owner == null || Array.isArray(owner)) return null;
    const pid = (owner as Record<string, unknown>).pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

async function cleanupStaleGeneratedFilesRoots() {
  let entries: { isDirectory(): boolean; name: string }[];
  try {
    entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(GENERATED_FILES_TEMP_PREFIX)) return;

      const root = path.join(os.tmpdir(), entry.name);
      if (activeGeneratedFilesRoots.has(root)) return;

      const ownerPid = await generatedFilesRootOwnerPid(root);
      if (ownerPid != null && ownerPid !== process.pid && processIsAlive(ownerPid)) return;

      await fs.rm(root, { force: true, recursive: true }).catch(() => {});
    }),
  );
}

async function createGeneratedFilesRoot() {
  await cleanupStaleGeneratedFilesRoots();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), GENERATED_FILES_TEMP_PREFIX));
  activeGeneratedFilesRoots.add(root);
  await fs.writeFile(
    path.join(root, GENERATED_FILES_OWNER_FILE),
    JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
  );
  return root;
}

async function removeGeneratedFilesRoot(root: string) {
  activeGeneratedFilesRoots.delete(root);
  await fs.rm(root, { force: true, recursive: true }).catch(() => {});
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

  async render(
    input: QuestionPreviewRuntimeRenderInput,
    options?: QuestionPreviewRuntimeRenderOptions,
  ) {
    const runtime = await this.getRuntime();

    try {
      return await runtime.render(input, options);
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

function isGeneratedFilesRenderId(renderId: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    renderId,
  );
}

function assetRequestFromPathname(courseDir: string, generatedFilesRoot: string, pathname: string) {
  const generatedFilesPrefix = '/preview-render/generatedFilesQuestion/render/';
  if (pathname.startsWith(generatedFilesPrefix)) {
    const segments = decodeAssetPathSegments(pathname.slice(generatedFilesPrefix.length));
    if (segments == null || segments.length < 2) return null;

    const [renderId, ...fileSegments] = segments;
    if (!isGeneratedFilesRenderId(renderId)) return null;

    return {
      roots: [path.join(generatedFilesRoot, renderId)],
      segments: fileSegments,
    };
  }

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
  generatedFilesRoot,
  req,
  res,
}: {
  generatedFilesRoot: string;
  options: QuestionPreviewServerOptions;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendEmpty(res, 405);
    return;
  }

  const assetRequest = assetRequestFromPathname(
    options.courseDir,
    generatedFilesRoot,
    rawRequestPathname(req),
  );
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
  generatedFilesRoot,
  req,
  res,
  runtime,
}: {
  generatedFilesRoot: string;
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

  const renderId = crypto.randomUUID();
  const result = await runtime.render(
    {
      qid,
      variantSeed: url.searchParams.get('variant') ?? '1',
    },
    {
      generatedFiles: {
        renderId,
        root: generatedFilesRoot,
      },
    },
  );

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
  const generatedFilesRoot = await createGeneratedFilesRoot();
  const runtimeOptions = makeRuntimeOptions(options);
  let runtime: ReplaceableQuestionPreviewRuntime | null = null;
  let server: http.Server | null = null;

  try {
    const previewRuntime = new ReplaceableQuestionPreviewRuntime(
      await createRuntime(runtimeOptions),
      createRuntime,
      runtimeOptions,
    );
    runtime = previewRuntime;
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`);
      const rawPathname = rawRequestPathname(req);
      const requestPromise =
        url.pathname === '/api/questions'
          ? handleQuestionDiscoveryRequest({ options, req, res })
          : isAssetRoutePathname(rawPathname)
            ? handleAssetRequest({ generatedFilesRoot, options, req, res })
            : handleQuestionPreviewRequest({
                generatedFilesRoot,
                options,
                req,
                res,
                runtime: previewRuntime,
              });

      requestPromise.catch((err) => {
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
  } catch (err) {
    await runtime?.close().catch(() => {});
    const failedServer = server;
    if (failedServer != null) {
      await new Promise<void>((resolve) => failedServer.close(() => resolve()));
    }
    await removeGeneratedFilesRoot(generatedFilesRoot);
    throw err;
  }
  if (runtime == null || server == null) {
    await removeGeneratedFilesRoot(generatedFilesRoot);
    throw new Error('Preview server startup failed before runtime initialization.');
  }

  const startedRuntime = runtime;
  const startedServer = server;

  const started: StartedQuestionPreviewServer = {
    async close() {
      let closeError: unknown;
      try {
        await new Promise<void>((resolve, reject) => {
          startedServer.close((err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        closeError = err;
      }

      try {
        await startedRuntime.close();
      } catch (err) {
        closeError ??= err;
      }

      await removeGeneratedFilesRoot(generatedFilesRoot);

      if (closeError != null) throw closeError;
    },
    generatedFilesRoot,
    options,
    runtime: startedRuntime,
    server: startedServer,
  };
  onReady?.(started);
  return started;
}
