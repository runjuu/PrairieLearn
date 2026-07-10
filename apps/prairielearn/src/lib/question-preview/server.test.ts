import nodeAssert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import { assert, describe, it, vi } from 'vitest';

import * as assets from '../assets.js';

import type { QuestionPreviewDiagnostic } from './document.js';
import { createQuestionPreviewRuntime } from './render.js';
import { parseQuestionPreviewServerOptions, startQuestionPreviewServer } from './server.js';
import {
  type PreviewWorkspaceAllocator,
  type PreviewWorkspaceDockerClient,
  createPreviewWorkspaceOwner,
} from './workspace-launcher.js';
import type { PreviewWorkspaceSpec } from './workspace-registry.js';

type StartQuestionPreviewServerParams = Parameters<typeof startQuestionPreviewServer>[0];
type StartTestQuestionPreviewServerParams = Omit<
  StartQuestionPreviewServerParams,
  'createRuntime'
> &
  Partial<Pick<StartQuestionPreviewServerParams, 'createRuntime'>>;

/**
 * A docker client stub for server tests: no containers exist, no images can
 * be found, and pulls resolve without producing an image, so workspace
 * launches fail fast without touching a real Docker daemon.
 */
function makeStubDockerClient(): PreviewWorkspaceDockerClient {
  return {
    createContainer: () => Promise.reject(new Error('not implemented')),
    getContainer: () => ({
      inspect: () => Promise.reject(new Error('not implemented')),
      remove: () => Promise.resolve(),
      start: () => Promise.resolve(),
    }),
    getImage: () => ({
      inspect: () => Promise.reject(Object.assign(new Error('no such image'), { statusCode: 404 })),
    }),
    listContainers: () => Promise.resolve([]),
    modem: {
      followProgress: (_stream, onFinished) => onFinished(null),
    },
    ping: () => Promise.resolve(),
    pull: () => Promise.resolve(null as unknown as NodeJS.ReadableStream),
  };
}

function makeLaunchingDockerClient(fixedPort?: number): PreviewWorkspaceDockerClient {
  let nextPort = fixedPort ?? 40_100;
  return {
    createContainer: async (options) => {
      const hostPort = fixedPort ?? nextPort++;
      return {
        inspect: async () => ({
          NetworkSettings: {
            Ports: {
              [Object.keys(options.ExposedPorts)[0]]: [
                { HostIp: '127.0.0.1', HostPort: String(hostPort) },
              ],
            },
          },
        }),
        remove: async () => {},
        start: async () => {},
      };
    },
    getContainer: () => ({
      inspect: () => Promise.reject(new Error('not implemented')),
      remove: () => Promise.resolve(),
      start: () => Promise.resolve(),
    }),
    getImage: () => ({ inspect: async () => ({ Config: { Labels: {} } }) }),
    listContainers: () => Promise.resolve([]),
    modem: {
      followProgress: (_stream, onFinished) => onFinished(null),
    },
    ping: () => Promise.resolve(),
    pull: () => Promise.resolve(null as unknown as NodeJS.ReadableStream),
  };
}

async function startWorkspaceApplication() {
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => res.end('workspace application'));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    port: (server.address() as AddressInfo).port,
  };
}

async function startTestQuestionPreviewServer({
  createRuntime = createQuestionPreviewRuntime,
  createWorkspaceOwner = (options) =>
    createPreviewWorkspaceOwner({ ...options, docker: makeStubDockerClient() }),
  ...params
}: StartTestQuestionPreviewServerParams) {
  const usesFakeRuntime = createRuntime !== createQuestionPreviewRuntime;
  if (usesFakeRuntime) await assets.init();

  try {
    const started = await startQuestionPreviewServer({
      ...params,
      createRuntime,
      createWorkspaceOwner,
    });
    if (!usesFakeRuntime) return started;

    return {
      ...started,
      async close() {
        try {
          await started.close();
        } finally {
          await assets.close();
        }
      },
    };
  } catch (err) {
    if (usesFakeRuntime) await assets.close();
    throw err;
  }
}

function makeWorkspaceSpec(overrides: Partial<PreviewWorkspaceSpec> = {}): PreviewWorkspaceSpec {
  return {
    params: {},
    qid: 'demo/workspace',
    settings: {
      args: null,
      enableNetworking: false,
      environment: {},
      gradedFiles: [],
      home: '/home/user',
      image: 'workspace-image',
      port: 8080,
      rewriteUrl: true,
    },
    trueAnswer: {},
    variantSeed: '1',
    ...overrides,
  };
}

async function makeTempCourse() {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-server-'));
  await fs.writeFile(
    path.join(courseDir, 'infoCourse.json'),
    JSON.stringify({
      name: 'TST 101',
      title: 'Question preview tests',
      topics: [{ color: 'blue1', name: 'Testing' }],
    }),
  );
  await fs.mkdir(path.join(courseDir, 'questions'), { recursive: true });
  return courseDir;
}

async function writeQuestionFile(
  courseDir: string,
  qid: string,
  filename: string,
  contents: string,
) {
  const questionDir = path.join(courseDir, 'questions', qid);
  await fs.mkdir(questionDir, { recursive: true });
  await fs.writeFile(path.join(questionDir, filename), contents);
}

async function writeCourseFile(courseDir: string, filename: string, contents: string) {
  const fullPath = path.join(courseDir, filename);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, contents);
}

async function writeQuestionInfo(
  courseDir: string,
  qid: string,
  info: { title: string; topic: string; type: string; uuid: string } & Record<string, unknown>,
) {
  await writeQuestionFile(courseDir, qid, 'info.json', JSON.stringify(info));
}

async function writeQuestion(courseDir: string, qid: string) {
  await writeQuestionInfo(courseDir, qid, {
    title: 'Runtime direct preview',
    topic: 'Testing',
    type: 'v3',
    uuid: '11111111-1111-4111-8111-111111111124',
  });
  await writeQuestionFile(courseDir, qid, 'question.html', '<p>Runtime direct preview body</p>');
}

function serverUrl(started: Awaited<ReturnType<typeof startQuestionPreviewServer>>) {
  const address = started.server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected preview server to listen on a TCP address.');
  }
  return `http://${address.address}:${address.port}`;
}

function startupSessionUrl(started: Awaited<ReturnType<typeof startQuestionPreviewServer>>) {
  const session = started.startupSessions[0];
  return `${serverUrl(started)}/preview-sessions/${session.previewSessionId}`;
}

function startupSessionPath(started: Awaited<ReturnType<typeof startQuestionPreviewServer>>) {
  return new URL(startupSessionUrl(started)).pathname;
}

async function requestRawPath(
  started: Awaited<ReturnType<typeof startQuestionPreviewServer>>,
  requestPath: string,
) {
  const address = started.server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected preview server to listen on a TCP address.');
  }

  return new Promise<{ body: string; status: number }>((resolve, reject) => {
    const req = http.request(
      {
        host: address.address,
        method: 'GET',
        path: requestPath,
        port: address.port,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function testPreviewDocument(bodyHtml: string, headHtml = '') {
  return `<!doctype html>
<html>
<head>
${headHtml}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function testSuccessDocument(bodyHtml: string, headHtml = '') {
  return {
    diagnostics: [],
    documentHtml: testPreviewDocument(bodyHtml, headHtml),
    ok: true as const,
  };
}

function testFailureDocument(diagnostics: QuestionPreviewDiagnostic[] = []) {
  return {
    diagnostics,
    documentHtml: testPreviewDocument(`<main>
<h1>Question preview failed</h1>
<p>Check the preview server console for details.</p>
</main>`),
    ok: false as const,
    reason: 'render-failure' as const,
  };
}

describe('Local Preview Session contract', () => {
  it('creates, renders through, lists, and deletes an opaque session', async () => {
    const courseDir = await makeTempCourse();
    const canonicalCourseDir = await fs.realpath(courseDir);
    let closed = false;
    const started = await startTestQuestionPreviewServer({
      argv: ['--port', '0'],
      createRuntime: async () => ({
        close: async () => {
          closed = true;
        },
        render: async () => testSuccessDocument('<p>Scoped preview</p>'),
      }),
    });

    try {
      const baseUrl = serverUrl(started);
      const health = await fetch(`${baseUrl}/health`);
      assert.deepEqual(await health.json(), { status: 'ok' });

      const created = await fetch(`${baseUrl}/preview-sessions`, {
        body: JSON.stringify({ courseDir }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as {
        courseDir: string;
        previewSessionId: string;
      };
      assert.equal(createdBody.courseDir, canonicalCourseDir);
      assert.match(createdBody.previewSessionId, /^pvs_[A-Za-z0-9_-]{22}$/);

      const preview = await fetch(
        `${baseUrl}/preview-sessions/${createdBody.previewSessionId}/questions/demo/example`,
      );
      assert.equal(preview.status, 200);
      assert.match(await preview.text(), /Scoped preview/);
      assert.equal((await fetch(`${baseUrl}/questions/demo/example`)).status, 404);

      const listed = await fetch(`${baseUrl}/preview-sessions`);
      assert.deepEqual(await listed.json(), { previewSessions: [createdBody] });

      const deleted = await fetch(`${baseUrl}/preview-sessions/${createdBody.previewSessionId}`, {
        method: 'DELETE',
      });
      assert.equal(deleted.status, 204);
      assert.equal(closed, true);
      assert.equal(
        (
          await fetch(
            `${baseUrl}/preview-sessions/${createdBody.previewSessionId}/questions/demo/example`,
          )
        ).status,
        404,
      );
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns control-plane JSON when runtime cleanup fails', async () => {
    const courseDir = await makeTempCourse();
    const runtimeCleanupDiagnostic = `Runtime cleanup failed for ${courseDir} in Docker.`;
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {
          throw new Error(runtimeCleanupDiagnostic);
        },
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const session = started.startupSessions[0];
      assert.isDefined(session);
      const baseUrl = serverUrl(started);
      const sessionUrl = `${baseUrl}/preview-sessions/${session.previewSessionId}`;

      const deleted = await fetch(sessionUrl, { method: 'DELETE' });
      const responseBody = await deleted.text();
      assert.equal(deleted.status, 503);
      assert.match(deleted.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(JSON.parse(responseBody), {
        error: {
          code: 'capability_unavailable',
          message: 'The Local Preview Session could not be fully cleaned up.',
        },
      });
      assert.notInclude(responseBody, runtimeCleanupDiagnostic);
      assert.deepEqual(await (await fetch(`${baseUrl}/preview-sessions`)).json(), {
        previewSessions: [],
      });
      assert.equal((await fetch(`${sessionUrl}/questions/demo/example`)).status, 404);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns control-plane JSON when Preview Workspace cleanup fails', async () => {
    const courseDir = await makeTempCourse();
    const workspaceHomePath = path.join(courseDir, 'workspace-home-file');
    await fs.writeFile(workspaceHomePath, 'not a directory');
    let runtimeClosed = false;
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--workspaces',
        '--workspace-home-dir',
        workspaceHomePath,
      ],
      createRuntime: async () => ({
        close: async () => {
          runtimeClosed = true;
        },
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const session = started.startupSessions[0];
      assert.isDefined(session);
      const baseUrl = serverUrl(started);
      const sessionUrl = `${baseUrl}/preview-sessions/${session.previewSessionId}`;

      const deleted = await fetch(sessionUrl, { method: 'DELETE' });
      const responseBody = await deleted.text();
      assert.equal(deleted.status, 503);
      assert.match(deleted.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(JSON.parse(responseBody), {
        error: {
          code: 'capability_unavailable',
          message: 'The Local Preview Session could not be fully cleaned up.',
        },
      });
      assert.notInclude(responseBody, workspaceHomePath);
      assert.equal(runtimeClosed, true);
      assert.deepEqual(await (await fetch(`${baseUrl}/preview-sessions`)).json(), {
        previewSessions: [],
      });
      assert.equal((await fetch(`${sessionUrl}/questions/demo/example`)).status, 404);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('protects only the control plane and advertises exact default capabilities', async () => {
    const courseDir = await makeTempCourse();
    vi.stubEnv('PRAIRIELEARN_PREVIEW_AUTH_TOKEN', 'server-secret');
    const started = await startTestQuestionPreviewServer({
      argv: ['--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testSuccessDocument('<p>Bearer-free browser route</p>'),
      }),
    });

    try {
      const baseUrl = serverUrl(started);
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      const unauthorized = await fetch(`${baseUrl}/metadata`);
      assert.equal(unauthorized.status, 401);
      assert.deepEqual(await unauthorized.json(), {
        error: { code: 'unauthorized', message: 'A valid bearer token is required.' },
      });

      const authorization = { authorization: 'Bearer server-secret' };
      const metadata = await fetch(`${baseUrl}/metadata`, { headers: authorization });
      assert.deepEqual(await metadata.json(), {
        apiVersion: 'experimental-1',
        prairieLearnVersion: '1.0.0',
        previewSessionsEndpoint: '/preview-sessions',
        features: {
          defaultRenderMode: 'question-only',
          grading: false,
          renderModes: ['question-only'],
          workspaceControls: [],
          workspaces: false,
        },
        limits: { questionTimeoutMs: 5000, workersCount: 1 },
      });

      const created = await fetch(`${baseUrl}/preview-sessions`, {
        body: JSON.stringify({ courseDir }),
        headers: { ...authorization, 'content-type': 'application/json' },
        method: 'POST',
      });
      const { previewSessionId } = (await created.json()) as { previewSessionId: string };
      const browserRoute = await fetch(
        `${baseUrl}/preview-sessions/${previewSessionId}/questions/demo/example`,
      );
      assert.equal(browserRoute.status, 200);
      assert.match(await browserRoute.text(), /Bearer-free browser route/);
    } finally {
      vi.unstubAllEnvs();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('advertises exact full-rendering and Preview Workspace capabilities', async () => {
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--port',
        '0',
        '--render-mode',
        'full',
        '--question-timeout-ms',
        '2345',
        '--workers-count',
        '4',
        '--workspaces',
        '--workspace-idle-timeout-ms',
        '1000',
        '--workspace-max-containers',
        '2',
        '--workspace-start-timeout-ms',
        '2000',
      ],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
      }),
      createWorkspaceOwner: (options) =>
        createPreviewWorkspaceOwner({
          ...options,
          docker: makeLaunchingDockerClient(),
          fetchFn: () => Promise.resolve(),
        }),
    });

    try {
      const metadata = await fetch(`${serverUrl(started)}/metadata`);
      assert.equal(metadata.status, 200);
      assert.match(metadata.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await metadata.json(), {
        apiVersion: 'experimental-1',
        prairieLearnVersion: '1.0.0',
        previewSessionsEndpoint: '/preview-sessions',
        features: {
          defaultRenderMode: 'full',
          grading: true,
          renderModes: ['question-only', 'full'],
          workspaceControls: ['reboot', 'reset'],
          workspaces: true,
        },
        limits: {
          questionTimeoutMs: 2345,
          workersCount: 4,
          workspaceIdleTimeoutMs: 1000,
          workspaceMaxContainers: 2,
          workspaceStartTimeoutMs: 2000,
        },
      });
    } finally {
      await started.close();
    }
  });

  it('returns stable control-plane errors and rejects removed browser routes', async () => {
    const courseDir = await makeTempCourse();
    const started = await startTestQuestionPreviewServer({
      argv: ['--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const baseUrl = serverUrl(started);
      const malformed = await fetch(`${baseUrl}/preview-sessions`, {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(malformed.status, 400);
      assert.match(malformed.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await malformed.json(), {
        error: { code: 'invalid_request', message: 'The request body is invalid.' },
      });

      const relative = await fetch(`${baseUrl}/preview-sessions`, {
        body: JSON.stringify({ courseDir: 'relative/course' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(relative.status, 400);
      assert.deepEqual(await relative.json(), {
        error: {
          code: 'invalid_request',
          details: { courseDir: 'relative/course' },
          message: 'courseDir must be an absolute path.',
        },
      });

      const invalidCourse = await fetch(`${baseUrl}/preview-sessions`, {
        body: JSON.stringify({ courseDir: path.join(courseDir, 'missing') }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(invalidCourse.status, 422);
      assert.deepEqual(await invalidCourse.json(), {
        error: {
          code: 'invalid_course_dir',
          details: { courseDir: path.join(courseDir, 'missing') },
          message: 'The course directory does not exist or is not a PrairieLearn course.',
        },
      });

      const unknownDelete = await fetch(`${baseUrl}/preview-sessions/pvs_0000000000000000000000`, {
        method: 'DELETE',
      });
      assert.equal(unknownDelete.status, 404);
      assert.deepEqual(await unknownDelete.json(), {
        error: {
          code: 'preview_session_not_found',
          message: 'The Local Preview Session does not exist.',
        },
      });

      for (const removedPath of [
        '/questions/demo/example',
        '/preview-render/clientFilesCourse/course.txt',
        '/workspace/1',
        '/api/questions',
      ]) {
        const response = await fetch(`${baseUrl}${removedPath}`);
        assert.equal(response.status, 404, removedPath);
        assert.equal(await response.text(), '', removedPath);
      }

      for (const [method, requestPath] of [
        ['POST', '/health'],
        ['POST', '/metadata'],
        ['PUT', '/preview-sessions'],
      ]) {
        const response = await fetch(`${baseUrl}${requestPath}`, { method });
        assert.equal(response.status, 404, `${method} ${requestPath}`);
      }
    } finally {
      await started.close();
    }

    const unavailable = await startTestQuestionPreviewServer({
      argv: ['--port', '0'],
      createRuntime: async () => {
        throw new Error('worker pool unavailable');
      },
    });
    try {
      const response = await fetch(`${serverUrl(unavailable)}/preview-sessions`, {
        body: JSON.stringify({ courseDir }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: {
          code: 'capability_unavailable',
          message: 'The Local Preview Session could not be created.',
        },
      });
    } finally {
      await unavailable.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('keeps duplicate-course sessions isolated and closes startup atomically', async () => {
    const courseDir = await makeTempCourse();
    const missingCourseDir = path.join(courseDir, 'missing');
    const closedRuntimeIds: number[] = [];
    let nextRuntimeId = 1;
    const createRuntime = async () => {
      const runtimeId = nextRuntimeId++;
      return {
        close: async () => {
          closedRuntimeIds.push(runtimeId);
        },
        render: async () => testSuccessDocument(`<p>Runtime ${runtimeId}</p>`),
      };
    };

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
      ],
      createRuntime,
    });
    try {
      const [first, second] = started.startupSessions;
      assert.isDefined(first);
      assert.isDefined(second);
      assert.notEqual(first.previewSessionId, second.previewSessionId);

      const firstPreview = await fetch(
        `${serverUrl(started)}/preview-sessions/${first.previewSessionId}/questions/demo/example`,
      );
      const secondPreview = await fetch(
        `${serverUrl(started)}/preview-sessions/${second.previewSessionId}/questions/demo/example`,
      );
      assert.match(await firstPreview.text(), /Runtime 1/);
      assert.match(await secondPreview.text(), /Runtime 2/);

      const deleted = await fetch(
        `${serverUrl(started)}/preview-sessions/${first.previewSessionId}`,
        { method: 'DELETE' },
      );
      assert.equal(deleted.status, 204);
      assert.deepEqual(closedRuntimeIds, [1]);
      assert.equal(
        (
          await fetch(
            `${serverUrl(started)}/preview-sessions/${second.previewSessionId}/questions/demo/example`,
          )
        ).status,
        200,
      );
    } finally {
      await started.close();
    }
    assert.deepEqual(closedRuntimeIds, [1, 2]);

    await nodeAssert.rejects(
      () =>
        startTestQuestionPreviewServer({
          argv: ['--course-dir', courseDir, '--course-dir', missingCourseDir, '--port', '0'],
          createRuntime,
        }),
      /Invalid Local Preview Course Source/,
    );
    assert.deepEqual(closedRuntimeIds, [1, 2, 3]);
    await fs.rm(courseDir, { force: true, recursive: true });
  });

  it('removes a deleting session from routing before its accepted render drains', async () => {
    const courseDir = await makeTempCourse();
    let beginRender = () => {};
    const renderStarted = new Promise<void>((resolve) => {
      beginRender = resolve;
    });
    let finishRender = () => {};
    const renderCanFinish = new Promise<void>((resolve) => {
      finishRender = resolve;
    });
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => {
          beginRender();
          await renderCanFinish;
          return testSuccessDocument('<p>Drained render</p>');
        },
      }),
    });

    try {
      const session = started.startupSessions[0];
      assert.isDefined(session);
      const sessionUrl = `${serverUrl(started)}/preview-sessions/${session.previewSessionId}`;
      const renderResponse = fetch(`${sessionUrl}/questions/demo/example`);
      await renderStarted;
      const deleteResponse = fetch(sessionUrl, { method: 'DELETE' });

      await vi.waitFor(async () => {
        assert.equal((await fetch(`${sessionUrl}/questions/demo/example`)).status, 404);
      });
      let deletionSettled = false;
      void deleteResponse.then(() => {
        deletionSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(deletionSettled, false);

      finishRender();
      assert.equal((await renderResponse).status, 200);
      assert.equal((await deleteResponse).status, 204);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('shares one process engine while closing course renderers independently', async () => {
    const courseDir = await makeTempCourse();
    let engineClosed = false;
    let engineCreations = 0;
    const closedRenderers: number[] = [];
    let nextRendererId = 1;
    await assets.init();
    const started = await startQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
      ],
      createEngine: async () => {
        engineCreations++;
        return {
          close: async () => {
            engineClosed = true;
          },
          createCourseRenderer: () => {
            const rendererId = nextRendererId++;
            return {
              close: async () => {
                closedRenderers.push(rendererId);
              },
              render: async () => testSuccessDocument(`<p>Renderer ${rendererId}</p>`),
            };
          },
        };
      },
    });

    try {
      assert.equal(engineCreations, 1);
      const [first, second] = started.startupSessions;
      assert.isDefined(first);
      assert.isDefined(second);
      const deleted = await fetch(
        `${serverUrl(started)}/preview-sessions/${first.previewSessionId}`,
        { method: 'DELETE' },
      );
      assert.equal(deleted.status, 204);
      assert.deepEqual(closedRenderers, [1]);
      assert.equal(engineClosed, false);
      assert.equal(
        (
          await fetch(
            `${serverUrl(started)}/preview-sessions/${second.previewSessionId}/questions/demo/example`,
          )
        ).status,
        200,
      );
    } finally {
      await started.close();
      await assets.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
    assert.deepEqual(closedRenderers, [1, 2]);
    assert.equal(engineClosed, true);
  });
});

describe('question preview server startup', () => {
  it('rejects a value-required startup flag when its value is omitted', async () => {
    const courseDir = await makeTempCourse();

    try {
      await nodeAssert.rejects(
        () => parseQuestionPreviewServerOptions(['--course-dir', courseDir, '--port']),
        /Invalid --port/,
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('preserves supported startup option defaults and explicit flag parsing', async () => {
    const courseDir = await makeTempCourse();

    try {
      const defaultOptions = await parseQuestionPreviewServerOptions([]);
      assert.deepEqual(defaultOptions, {
        cacheType: 'none',
        courseDirs: [],
        devMode: false,
        host: '127.0.0.1',
        port: 4310,
        questionTimeoutMilliseconds: 5000,
        renderMode: 'question-only',
        workersCount: 1,
        workersExecutionMode: 'container',
        workspaceHomeDir: undefined,
        workspaceHomeVolume: undefined,
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceMaxContainers: 3,
        workspaceNetwork: undefined,
        workspacePullPolicy: 'missing',
        workspaceStartTimeoutMs: 60 * 1000,
        workspacesEnabled: false,
      });

      const explicitOptions = await parseQuestionPreviewServerOptions([
        '--course-dir',
        courseDir,
        '--course-dir',
        courseDir,
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--question-timeout-ms',
        '1',
        '--render-mode',
        'question-only',
        '--workers-count',
        '4',
        '--workers-execution-mode',
        'native',
        '--workspaces',
        '--workspace-home-dir',
        'preview-homes',
        '--workspace-home-volume',
        'pl-preview-workspaces-course-123',
        '--workspace-idle-timeout-ms',
        '1000',
        '--workspace-max-containers',
        '1',
        '--workspace-network',
        'pl-preview-net',
        '--workspace-pull-policy',
        'never',
        '--workspace-start-timeout-ms',
        '2000',
      ]);

      assert.deepEqual(explicitOptions, {
        cacheType: 'none',
        courseDirs: [path.resolve(courseDir), path.resolve(courseDir)],
        devMode: false,
        host: '0.0.0.0',
        port: 0,
        questionTimeoutMilliseconds: 1,
        renderMode: 'question-only',
        workersCount: 4,
        workersExecutionMode: 'native',
        workspaceHomeDir: path.resolve('preview-homes'),
        workspaceHomeVolume: 'pl-preview-workspaces-course-123',
        workspaceIdleTimeoutMs: 1000,
        workspaceMaxContainers: 1,
        workspaceNetwork: 'pl-preview-net',
        workspacePullPolicy: 'never',
        workspaceStartTimeoutMs: 2000,
        workspacesEnabled: true,
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects unsupported and invalid startup options before creating the runtime', async () => {
    const courseDir = await makeTempCourse();
    const missingCourseDir = path.join(os.tmpdir(), 'pl-preview-server-missing-course');
    let runtimeCreations = 0;

    const invalidCases: { argv: string[]; message: RegExp }[] = [
      {
        argv: ['--course-dir', courseDir, '--unsupported-flag'],
        message: /Unsupported preview-server flag/,
      },
      {
        argv: ['--course-dir', courseDir, 'unexpected'],
        message: /Unexpected positional arguments/,
      },
      { argv: ['--course-dir', courseDir, '--port', '65536'], message: /Invalid --port/ },
      {
        argv: ['--course-dir', courseDir, '--question-timeout-ms', '0'],
        message: /Invalid --question-timeout-ms/,
      },
      {
        argv: ['--course-dir', courseDir, '--render-timeout-ms', '1000'],
        message: /Unsupported preview-server flag/,
      },
      {
        argv: ['--course-dir', courseDir, '--startup-timeout-ms', '1000'],
        message: /Unsupported preview-server flag/,
      },
      {
        argv: ['--course-dir', courseDir, '--workers-count', '0'],
        message: /Invalid --workers-count/,
      },
      {
        argv: ['--course-dir', courseDir, '--cache-type', 'disk'],
        message: /Unsupported preview-server flag/,
      },
      {
        argv: ['--course-dir', courseDir, '--dev-mode'],
        message: /Unsupported preview-server flag/,
      },
      {
        argv: ['--course-dir', courseDir, '--no-workspaces'],
        message: /Unsupported preview-server flag/,
      },
      {
        argv: ['--course-dir', courseDir, '--render-mode', 'bogus'],
        message: /Invalid --render-mode/,
      },
      {
        argv: ['--course-dir', courseDir, '--workers-execution-mode', 'disabled'],
        message: /Invalid --workers-execution-mode/,
      },
      {
        argv: ['--course-dir', courseDir, '--workspace-pull-policy', 'sometimes'],
        message: /Invalid --workspace-pull-policy/,
      },
      {
        argv: ['--course-dir', courseDir, '--workspace-idle-timeout-ms', '0'],
        message: /Invalid --workspace-idle-timeout-ms/,
      },
      {
        argv: ['--course-dir', courseDir, '--workspace-max-containers', '0'],
        message: /Invalid --workspace-max-containers/,
      },
      { argv: ['--course-dir', missingCourseDir], message: /Invalid Local Preview Course Source/ },
    ];

    try {
      for (const testCase of invalidCases) {
        await nodeAssert.rejects(
          () =>
            startTestQuestionPreviewServer({
              argv: testCase.argv,
              createRuntime: async () => {
                runtimeCreations++;
                return {
                  close: async () => {},
                  render: async () => testFailureDocument(),
                };
              },
            }),
          testCase.message,
          testCase.argv.join(' '),
        );
      }

      assert.equal(runtimeCreations, 0);
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('starts with zero courses and registers valid startup courses before readiness', async () => {
    const courseDir = await makeTempCourse();
    const missingCourseDir = path.join(os.tmpdir(), 'pl-preview-server-missing-course');
    const events: string[] = [];

    const empty = await startTestQuestionPreviewServer({
      argv: ['--port', '0'],
      createRuntime: async () => {
        events.push('runtime');
        return { close: async () => {}, render: async () => testFailureDocument() };
      },
    });
    assert.deepEqual(empty.startupSessions, []);
    await empty.close();
    assert.deepEqual(events, []);

    await nodeAssert.rejects(
      () =>
        startTestQuestionPreviewServer({
          argv: ['--course-dir', missingCourseDir],
          createRuntime: async () => {
            events.push('runtime');
            return { close: async () => {}, render: async () => testFailureDocument() };
          },
        }),
      /Invalid Local Preview Course Source/,
    );
    assert.deepEqual(events, []);

    const defaultOptions = await parseQuestionPreviewServerOptions(['--course-dir', courseDir]);
    assert.equal(defaultOptions.host, '127.0.0.1');
    assert.equal(defaultOptions.port, 4310);
    const canonicalCourseDir = await fs.realpath(courseDir);

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0'],
      createRuntime: async (options) => {
        events.push(`runtime:${options.courseDir}:${options.prewarmWorkers}`);
        return { close: async () => {}, render: async () => testFailureDocument() };
      },
    });
    events.push('ready');

    try {
      const address = started.server.address();
      if (address == null || typeof address === 'string') {
        throw new Error('Expected preview server to listen on a TCP address.');
      }
      assert.equal(address.address, '127.0.0.1');
      assert.equal(started.options.host, '127.0.0.1');
      assert.equal(started.options.port, 0);
      assert.deepEqual(started.options.courseDirs, [path.resolve(courseDir)]);
      assert.equal(started.startupSessions[0]?.courseDir, canonicalCourseDir);
      assert.deepEqual(events, [`runtime:${canonicalCourseDir}:true`, 'ready']);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('reports startup progress when a startup logger is provided', async () => {
    const courseDir = await makeTempCourse();
    const canonicalCourseDir = await fs.realpath(courseDir);
    const logs: string[] = [];
    const startupLogger = (message: string) => logs.push(message);
    const runtimeOptions: Parameters<
      NonNullable<StartQuestionPreviewServerParams['createRuntime']>
    >[0][] = [];

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0'],
      createRuntime: async (options) => {
        runtimeOptions.push(options);
        return { close: async () => {}, render: async () => testFailureDocument() };
      },
      startupLogger,
    });

    try {
      assert.equal(runtimeOptions[0]?.startupLogger, startupLogger);
      assert.equal(logs[0], 'Reading preview server options.');
      assert.match(
        logs[1] ?? '',
        new RegExp(
          `^Created startup Local Preview Session pvs_[A-Za-z0-9_-]{22}: ${canonicalCourseDir.replaceAll('/', '\\/')}\\.$`,
        ),
      );
      assert.equal(logs[2], 'Starting HTTP server on 127.0.0.1:0.');
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});

describe('question preview server asset routes', () => {
  it('serves declared legacy question files and PrairieLearn-owned legacy modules only', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'legacy/assets', {
      clientFiles: ['client.js', 'diagram.svg'],
      options: {
        correctAnswers: ['Four'],
        incorrectAnswers: ['Three'],
        text: 'What is two plus two?',
      },
      title: 'Legacy assets',
      topic: 'Testing',
      type: 'MultipleChoice',
      uuid: '11111111-1111-4111-8111-111111111130',
    });
    await writeQuestionFile(
      courseDir,
      'legacy/assets',
      'client.js',
      "define(['MCQClient'], function (MCQClient) { return new MCQClient.MCQClient(); });",
    );
    await writeQuestionFile(courseDir, 'legacy/assets', 'diagram.svg', '<svg></svg>');
    await writeQuestionFile(courseDir, 'legacy/assets', 'server.js', 'server secret');

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const cases = [
        {
          body: /MCQClient/,
          path: '/preview-render/questions/legacy/assets/legacy-files/client.js',
          status: 200,
        },
        {
          body: /<svg>/,
          path: '/preview-render/questions/legacy/assets/legacy-files/diagram.svg',
          status: 200,
        },
        {
          body: /define/,
          path: '/localscripts/calculationQuestion/MCQClient.js',
          status: 200,
        },
        {
          body: /server secret/,
          path: '/preview-render/questions/legacy/assets/legacy-files/server.js',
          status: 404,
        },
      ];

      for (const testCase of cases) {
        const origin = testCase.path.startsWith('/localscripts/') ? serverUrl(started) : baseUrl;
        const response = await fetch(`${origin}${testCase.path}`);
        const body = await response.text();
        assert.equal(response.status, testCase.status, testCase.path);
        if (testCase.status === 200) assert.match(body, testCase.body, testCase.path);
        else nodeAssert.doesNotMatch(body, testCase.body, testCase.path);
      }
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('serves ordinary PrairieLearn, course, element, extension, and question-local assets', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'unit/assets', {
      title: 'Asset question',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111132',
    });
    await writeCourseFile(courseDir, 'clientFilesCourse/course.css', 'course asset');
    await writeCourseFile(courseDir, 'elements/course-widget/course-widget.css', 'element asset');
    await writeCourseFile(
      courseDir,
      'elementExtensions/pl-number-input/course-extension/course-extension.js',
      'extension asset',
    );
    await writeCourseFile(
      courseDir,
      'questions/unit/assets/clientFilesQuestion/question.txt',
      'question asset',
    );

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const cases = [
        {
          body: /function|window|document/,
          path: '/assets/public/cache/localscripts/question.js',
        },
        {
          body: /Bootstrap/,
          path: '/assets/node_modules/cache/bootstrap/dist/css/bootstrap.min.css',
        },
        { body: /course asset/, path: '/preview-render/clientFilesCourse/course.css' },
        { body: /element asset/, path: '/preview-render/elements/course-widget/course-widget.css' },
        {
          body: /element asset/,
          path: '/preview-render/cacheableElements/cache/course-widget/course-widget.css',
        },
        {
          body: /extension asset/,
          path: '/preview-render/elementExtensions/pl-number-input/course-extension/course-extension.js',
        },
        {
          body: /extension asset/,
          path: '/preview-render/cacheableElementExtensions/cache/pl-number-input/course-extension/course-extension.js',
        },
        {
          body: /question asset/,
          path: '/preview-render/questions/unit/assets/files/question.txt',
        },
      ];

      for (const testCase of cases) {
        const origin = testCase.path.startsWith('/assets/') ? serverUrl(started) : baseUrl;
        const response = await fetch(`${origin}${testCase.path}`);
        const body = await response.text();

        assert.equal(response.status, 200, testCase.path);
        assert.match(body, testCase.body, testCase.path);
      }
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns not found for missing core assets without falling through to preview rendering', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: string[] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push(input.qid.decoded);
          return testSuccessDocument(
            '<p>Preview fallback should not render for missing assets</p>',
          );
        },
      }),
    });

    try {
      const response = await fetch(
        `${serverUrl(started)}/assets/public/cache/localscripts/does-not-exist.js`,
        { headers: { origin: 'http://localhost:3000' } },
      );
      const body = await response.text();

      assert.equal(response.status, 404);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      nodeAssert.doesNotMatch(body, /Preview fallback/);
      assert.deepEqual(renderCalls, []);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('renders question-local asset URLs with the qid separated from the file path', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'unit/asset-links', {
      title: 'Asset links',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111133',
    });
    await writeQuestionFile(
      courseDir,
      'unit/asset-links',
      'question.html',
      '<pl-figure file-name="diagram.svg" alt="Diagram"></pl-figure>',
    );
    await writeCourseFile(
      courseDir,
      'questions/unit/asset-links/clientFilesQuestion/diagram.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const response = await fetch(`${baseUrl}/questions/unit/asset-links?variant=1`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.include(
        html,
        `src="${startupSessionPath(started)}/preview-render/questions/unit/asset-links/files/diagram.svg"`,
      );

      const asset = await fetch(
        `${baseUrl}/preview-render/questions/unit/asset-links/files/diagram.svg`,
      );
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /<svg/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('serves question-local assets when the qid contains a files path segment', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'unit/files/assets', {
      title: 'Files segment question',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111135',
    });
    await writeCourseFile(
      courseDir,
      'questions/unit/files/assets/clientFilesQuestion/question.txt',
      'question asset through files qid',
    );

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const response = await fetch(
        `${startupSessionUrl(started)}/preview-render/questions/unit/files/assets/files/question.txt`,
      );
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(body, /question asset through files qid/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects asset traversal, invalid paths, and category mixing', async () => {
    const courseDir = await makeTempCourse();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-server-outside-'));
    await writeQuestionInfo(courseDir, 'unit/assets', {
      title: 'Asset isolation',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111134',
    });
    await writeCourseFile(courseDir, 'clientFilesCourse/course.txt', 'course asset');
    await writeCourseFile(
      courseDir,
      'questions/unit/assets/clientFilesQuestion/question.txt',
      'question asset',
    );
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'outside secret');
    await fs.symlink(
      path.join(outsideDir, 'secret.txt'),
      path.join(courseDir, 'clientFilesCourse', 'linked-secret.txt'),
    );

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const rejectedPaths = [
        '/assets/public/cache/%2e%2e/package.json',
        '/preview-render/clientFilesCourse/%2e%2e/questions/unit/assets/clientFilesQuestion/question.txt',
        '/preview-render/clientFilesCourse/%2Ftmp%2Fsecret.txt',
        '/preview-render/clientFilesCourse/dir%5Csecret.txt',
        '/preview-render/clientFilesCourse//course.txt',
        '/preview-render/clientFilesCourse/question.txt',
        '/preview-render/questions/unit/assets/files/%2e%2e/course.txt',
        '/preview-render/questions/%2e%2e/assets/files/question.txt',
        '/preview-render/questions/unit/assets/files/course.txt',
        '/preview-render/elements/%2e%2e/clientFilesCourse/course.txt',
        '/preview-render/elementExtensions/%2e%2e/clientFilesCourse/course.txt',
      ];

      for (const rejectedPath of rejectedPaths) {
        const response = await requestRawPath(started, rejectedPath);

        assert.notEqual(response.status, 200, rejectedPath);
        nodeAssert.doesNotMatch(
          response.body,
          /outside secret|course asset|question asset/,
          rejectedPath,
        );
      }

      const symlinkedAsset = await requestRawPath(
        started,
        '/preview-render/clientFilesCourse/linked-secret.txt',
      );
      assert.equal(symlinkedAsset.status, 404);
      nodeAssert.doesNotMatch(symlinkedAsset.body, /outside secret/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('serves generated files through local preview variant identity URLs that keep older identities available', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'runtime/generated-file';
    await writeQuestionInfo(courseDir, qid, {
      title: 'Generated file',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111136',
    });
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<p>Generated file preview</p><pl-file-download file-name="data.txt" type="dynamic" force-download="false"></pl-file-download>',
    );
    await writeQuestionFile(
      courseDir,
      qid,
      'server.py',
      [
        'def file(data):',
        '    if data["filename"] == "data.txt":',
        '        return "generated file for seed " + str(data["variant_seed"])',
        '    return "unexpected file"',
        '',
      ].join('\n'),
    );

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="(?<path>\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/data\.txt)"/,
      );

      assert.equal(first.status, 200);
      nodeAssert.doesNotMatch(firstHtml, /generatedFilesQuestion\/render\//);
      assert.isNotNull(firstMatch);
      const firstPath = firstMatch.groups?.path ?? '';
      const firstVariantId = firstMatch.groups?.variantId ?? '';

      const firstFile = await fetch(`${serverUrl(started)}${firstPath}`);
      assert.equal(firstFile.status, 200);
      assert.equal(await firstFile.text(), 'generated file for seed 1');

      const postFile = await fetch(`${serverUrl(started)}${firstPath}`, { method: 'POST' });
      assert.equal(postFile.status, 405);

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="(?<path>\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/data\.txt)"/,
      );

      assert.equal(second.status, 200);
      assert.isNotNull(secondMatch);
      const secondPath = secondMatch.groups?.path ?? '';
      const secondVariantId = secondMatch.groups?.variantId ?? '';
      assert.notEqual(firstVariantId, secondVariantId);

      const secondFile = await fetch(`${serverUrl(started)}${secondPath}`);
      assert.equal(secondFile.status, 200);
      assert.equal(await secondFile.text(), 'generated file for seed 2');

      const oldFirstFile = await fetch(`${serverUrl(started)}${firstPath}`);
      assert.equal(oldFirstFile.status, 200);
      assert.equal(await oldFirstFile.text(), 'generated file for seed 1');
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('generates local preview files lazily from the stored prepared variant', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'runtime/lazy-generated-file';
    await writeQuestionInfo(courseDir, qid, {
      title: 'Lazy generated file',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111138',
    });
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<pl-file-download file-name="data.txt" type="dynamic" force-download="false"></pl-file-download>',
    );
    await writeQuestionFile(
      courseDir,
      qid,
      'server.py',
      [
        'def generate(data):',
        '    data["params"]["message"] = "prepared seed " + str(data["variant_seed"])',
        '',
        'def file(data):',
        '    return "old file with " + data["params"]["message"]',
        '',
      ].join('\n'),
    );

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const response = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const html = await response.text();
      const match = html.match(
        /href="(?<path>\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
      );

      assert.equal(response.status, 200);
      assert.isNotNull(match);
      const generatedFilePath = match.groups?.path ?? '';

      await writeQuestionFile(
        courseDir,
        qid,
        'server.py',
        [
          'def generate(data):',
          '    data["params"]["message"] = "regenerated"',
          '',
          'def file(data):',
          '    return "lazy file with " + data["params"]["message"]',
          '',
        ].join('\n'),
      );

      const generatedFile = await fetch(`${serverUrl(started)}${generatedFilePath}`);

      assert.equal(generatedFile.status, 200);
      assert.equal(await generatedFile.text(), 'lazy file with prepared seed 1');
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns not found for evicted local preview variant identities and refreshes with fresh URLs', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'runtime/generated-file-eviction';
    await writeQuestionInfo(courseDir, qid, {
      title: 'Generated file eviction',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111139',
    });
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<pl-file-download file-name="data.txt" type="dynamic" force-download="false"></pl-file-download>',
    );
    await writeQuestionFile(
      courseDir,
      qid,
      'server.py',
      [
        'def file(data):',
        '    return "generated file for seed " + str(data["variant_seed"])',
        '',
      ].join('\n'),
    );

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
      localPreviewGeneratedFilesMax: 1,
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="(?<path>\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
      );
      assert.equal(first.status, 200);
      assert.isNotNull(firstMatch);
      const firstPath = firstMatch.groups?.path ?? '';

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="(?<path>\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
      );
      assert.equal(second.status, 200);
      assert.isNotNull(secondMatch);
      const secondPath = secondMatch.groups?.path ?? '';
      assert.notEqual(firstPath, secondPath);

      const evictedFile = await fetch(`${serverUrl(started)}${firstPath}`);
      assert.equal(evictedFile.status, 404);

      const retainedFile = await fetch(`${serverUrl(started)}${secondPath}`);
      assert.equal(retainedFile.status, 200);
      assert.equal(await retainedFile.text(), 'generated file for seed 2');

      const refresh = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const refreshHtml = await refresh.text();
      const refreshMatch = refreshHtml.match(
        /href="(?<path>\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
      );
      assert.equal(refresh.status, 200);
      assert.isNotNull(refreshMatch);
      const refreshPath = refreshMatch.groups?.path ?? '';
      assert.notEqual(refreshPath, firstPath);

      const refreshedFile = await fetch(`${serverUrl(started)}${refreshPath}`);
      assert.equal(refreshedFile.status, 200);
      assert.equal(await refreshedFile.text(), 'generated file for seed 1');
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects unknown local preview variant identities and invalid generated-file paths', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'runtime/generated-file-isolation';
    await writeQuestionInfo(courseDir, qid, {
      title: 'Generated file isolation',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111137',
    });
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<pl-file-download file-name="{{params.filename}}" type="dynamic" force-download="false"></pl-file-download>',
    );
    await writeQuestionFile(
      courseDir,
      qid,
      'server.py',
      [
        'def generate(data):',
        '    if data["variant_seed"] == 1:',
        '        data["params"]["filename"] = "first.txt"',
        '    else:',
        '        data["params"]["filename"] = "second.txt"',
        '',
        'def file(data):',
        '    return "generated " + data["filename"]',
        '',
      ].join('\n'),
    );

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/first\.txt"/,
      );
      assert.equal(first.status, 200);
      assert.isNotNull(firstMatch);
      const firstVariantId = firstMatch.groups?.variantId ?? '';

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="\/preview-sessions\/[^/"?#]+\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/second\.txt"/,
      );
      assert.equal(second.status, 200);
      assert.isNotNull(secondMatch);
      const secondVariantId = secondMatch.groups?.variantId ?? '';
      assert.notEqual(firstVariantId, secondVariantId);

      const unknownVariantId = await fetch(
        `${baseUrl}/preview-render/generatedFilesQuestion/variant/999999/first.txt`,
      );
      const unknownVariantIdBody = await unknownVariantId.text();
      assert.equal(unknownVariantId.status, 404);
      nodeAssert.doesNotMatch(unknownVariantIdBody, /generated first/);

      const rejectedPaths = [
        `/preview-render/generatedFilesQuestion/variant/${firstVariantId}/%2e%2e/${secondVariantId}/second.txt`,
        `/preview-render/generatedFilesQuestion/variant/${firstVariantId}/%2Ftmp%2Fsecret.txt`,
        `/preview-render/generatedFilesQuestion/variant/${firstVariantId}/dir%5Csecret.txt`,
        `/preview-render/generatedFilesQuestion/variant/${firstVariantId}//first.txt`,
      ];

      for (const rejectedPath of rejectedPaths) {
        const response = await requestRawPath(started, rejectedPath);

        assert.notEqual(response.status, 200, rejectedPath);
        nodeAssert.doesNotMatch(response.body, /generated first|generated second/, rejectedPath);
      }
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});

describe('question preview server direct preview route', () => {
  it('bounds a complete GET render and remains usable after the timed-out render finishes', async () => {
    const courseDir = await makeTempCourse();
    let finishFirstRender = () => {};
    let markFirstRenderFinished = () => {};
    const firstRenderCanFinish = new Promise<void>((resolve) => {
      finishFirstRender = resolve;
    });
    const firstRenderFinished = new Promise<void>((resolve) => {
      markFirstRenderFinished = resolve;
    });
    let renderCalls = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--question-timeout-ms',
        '20',
        '--render-mode',
        'full',
      ],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => {
          renderCalls++;
          if (renderCalls === 1) {
            await firstRenderCanFinish;
            markFirstRenderFinished();
            return testSuccessDocument(`<p>Late render from ${courseDir}</p>`);
          }
          return testSuccessDocument('<p>Recovered render</p>');
        },
      }),
    });

    try {
      const firstResponse = await fetch(
        `${startupSessionUrl(started)}/questions/demo/example?variant=1`,
        { signal: AbortSignal.timeout(1000) },
      );
      const firstHtml = await firstResponse.text();

      assert.equal(firstResponse.status, 504);
      assert.match(firstResponse.headers.get('content-type') ?? '', /text\/html/);
      assert.match(firstHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(firstHtml, /Late render/);
      nodeAssert.doesNotMatch(firstHtml, new RegExp(courseDir.replaceAll('/', '\\/')));

      const recoveredResponse = await fetch(
        `${startupSessionUrl(started)}/questions/demo/example?variant=2`,
      );
      assert.equal(recoveredResponse.status, 200);
      assert.match(await recoveredResponse.text(), /Recovered render/);
      assert.equal(renderCalls, 2);

      finishFirstRender();
      await firstRenderFinished;
      nodeAssert.doesNotMatch(firstHtml, /Late render/);
    } finally {
      finishFirstRender();
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('defaults missing variants and renders a full HTML document for direct question URLs', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: { qid: string; variantSeed?: string }[] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push({ qid: input.qid.decoded, variantSeed: input.variantSeed });
          return testSuccessDocument(
            '<div class="question-container"><p>Rendered preview body</p></div>',
            '<script>window.previewHeadLoaded = true;</script>',
          );
        },
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const defaultResponse = await fetch(`${baseUrl}/questions/demo/example`);
      const defaultHtml = await defaultResponse.text();

      assert.equal(defaultResponse.status, 200);
      assert.match(defaultHtml, /Rendered preview body/);

      const response = await fetch(`${baseUrl}/questions/demo/example?variant=2`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, /<html/);
      assert.match(html, /<head>/);
      assert.match(html, /window\.previewHeadLoaded = true/);
      assert.match(html, /<body>/);
      assert.match(html, /Rendered preview body/);
      assert.deepEqual(renderCalls, [
        { qid: 'demo/example', variantSeed: undefined },
        { qid: 'demo/example', variantSeed: '2' },
      ]);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('keeps direct preview pages free of server controls and has no JSON render endpoint', async () => {
    const courseDir = await makeTempCourse();
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () =>
          testSuccessDocument('<section><p>Only rendered question content</p></section>'),
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const response = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const html = await response.text();

      assert.equal(response.status, 200);
      nodeAssert.doesNotMatch(html, /New Variant/i);
      nodeAssert.doesNotMatch(html, /Refresh/i);
      nodeAssert.doesNotMatch(html, /Question ID|qid/i);
      nodeAssert.doesNotMatch(html, /Variant:|variant label/i);
      nodeAssert.doesNotMatch(html, /<header|<nav|<iframe/i);

      const jsonEndpoint = await fetch(`${baseUrl}/preview`, {
        body: JSON.stringify({ qid: 'demo/example', variantSeed: '1' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const jsonEndpointBody = await jsonEndpoint.text();

      assert.equal(jsonEndpoint.status, 404);
      nodeAssert.doesNotMatch(jsonEndpoint.headers.get('content-type') ?? '', /application\/json/);
      nodeAssert.doesNotMatch(jsonEndpointBody, /"ok"|"payload"|"diagnostics"/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('does not expose assessment backend routes', async () => {
    const courseDir = await makeTempCourse();
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testSuccessDocument('<p>Preview only</p>'),
      }),
    });

    try {
      const absentRoutes = [
        { method: 'GET', path: '/parse' },
        { method: 'POST', path: '/grade' },
        { method: 'POST', path: '/submission' },
        { method: 'POST', path: '/answer-save' },
        { method: 'GET', path: '/saved-answer' },
        { method: 'GET', path: '/answer-panel' },
        { method: 'GET', path: '/assessment/1' },
      ];

      for (const route of absentRoutes) {
        const response = await fetch(`${startupSessionUrl(started)}${route.path}`, {
          method: route.method,
        });
        const body = await response.text();

        assert.notEqual(response.status, 200, route.path);
        nodeAssert.doesNotMatch(body, /Preview only|"ok"|"payload"|"diagnostics"/, route.path);
      }
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('checks posted answers through the runtime with metadata fields stripped', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push({
            qid: input.qid.decoded,
            submission: input.submission,
            variantSeed: input.variantSeed,
          });
          return testSuccessDocument('<p>Graded preview body</p>');
        },
      }),
    });

    try {
      const response = await fetch(
        `${startupSessionUrl(started)}/questions/demo/example?variant=2`,
        {
          body: new URLSearchParams({
            __action: 'grade',
            __csrf_token: 'ignored-token',
            __variant_id: '9',
            ans: '42',
          }),
          method: 'POST',
        },
      );
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(html, /Graded preview body/);
      assert.deepEqual(renderCalls, [
        {
          qid: 'demo/example',
          submission: { rawSubmittedAnswer: { ans: '42' } },
          variantSeed: '2',
        },
      ]);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('bounds a complete POST answer check and remains usable after late grading finishes', async () => {
    const courseDir = await makeTempCourse();
    let finishFirstRender = () => {};
    let markFirstRenderFinished = () => {};
    const firstRenderCanFinish = new Promise<void>((resolve) => {
      finishFirstRender = resolve;
    });
    const firstRenderFinished = new Promise<void>((resolve) => {
      markFirstRenderFinished = resolve;
    });
    const submittedAnswers: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--question-timeout-ms',
        '20',
        '--render-mode',
        'full',
      ],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          submittedAnswers.push(input.submission?.rawSubmittedAnswer);
          if (submittedAnswers.length === 1) {
            await firstRenderCanFinish;
            markFirstRenderFinished();
            return testSuccessDocument(`<p>Late grading from ${courseDir}</p>`);
          }
          return testSuccessDocument('<p>Recovered grading</p>');
        },
      }),
    });

    try {
      const questionUrl = `${startupSessionUrl(started)}/questions/demo/example?variant=1`;
      const firstResponse = await fetch(questionUrl, {
        body: new URLSearchParams({ __action: 'grade', ans: 'slow' }),
        method: 'POST',
        signal: AbortSignal.timeout(1000),
      });
      const firstHtml = await firstResponse.text();

      assert.equal(firstResponse.status, 504);
      assert.match(firstResponse.headers.get('content-type') ?? '', /text\/html/);
      assert.match(firstHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(firstHtml, /Late grading/);
      nodeAssert.doesNotMatch(firstHtml, new RegExp(courseDir.replaceAll('/', '\\/')));

      const recoveredResponse = await fetch(questionUrl, {
        body: new URLSearchParams({ __action: 'grade', ans: 'recovered' }),
        method: 'POST',
      });
      assert.equal(recoveredResponse.status, 200);
      assert.match(await recoveredResponse.text(), /Recovered grading/);
      assert.deepEqual(submittedAnswers, [{ ans: 'slow' }, { ans: 'recovered' }]);

      finishFirstRender();
      await firstRenderFinished;
      nodeAssert.doesNotMatch(firstHtml, /Late grading/);
    } finally {
      finishFirstRender();
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('starts the POST deadline before reading the submitted form body', async () => {
    const courseDir = await makeTempCourse();
    let renderCalls = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--question-timeout-ms',
        '20',
        '--render-mode',
        'full',
      ],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => {
          renderCalls++;
          return testSuccessDocument('<p>Rendered after the expired deadline</p>');
        },
      }),
    });

    try {
      const address = started.server.address();
      if (address == null || typeof address === 'string') {
        throw new Error('Expected preview server to listen on a TCP address.');
      }
      const body = '__action=grade&ans=slow';
      let bodySent = false;
      const response = await new Promise<{ body: string; status: number }>((resolve, reject) => {
        const req = http.request(
          {
            headers: {
              'content-length': Buffer.byteLength(body),
              'content-type': 'application/x-www-form-urlencoded',
            },
            host: address.address,
            method: 'POST',
            path: `${startupSessionPath(started)}/questions/demo/example?variant=1`,
            port: address.port,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('error', reject);
            res.on('end', () => {
              clearTimeout(sendBody);
              req.destroy();
              resolve({
                body: Buffer.concat(chunks).toString('utf8'),
                status: res.statusCode ?? 0,
              });
            });
          },
        );
        req.on('error', reject);
        req.flushHeaders();
        const sendBody = setTimeout(() => {
          bodySent = true;
          req.end(body);
        }, 100);
      });

      assert.equal(response.status, 504);
      assert.match(response.body, /Question preview failed/);
      nodeAssert.doesNotMatch(response.body, /Rendered after the expired deadline/);
      assert.isFalse(bodySent);
      assert.equal(renderCalls, 0);
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects posted answers without a grade action before invoking the runtime', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push(input);
          return testSuccessDocument('<p>Runtime rendered rejected action</p>');
        },
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const saveResponse = await fetch(`${baseUrl}/questions/demo/example?variant=1`, {
        body: new URLSearchParams({ __action: 'save', ans: '42' }),
        method: 'POST',
      });
      const saveHtml = await saveResponse.text();

      assert.equal(saveResponse.status, 400);
      assert.match(saveHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(saveHtml, /Runtime rendered rejected action/);

      const missingActionResponse = await fetch(`${baseUrl}/questions/demo/example?variant=1`, {
        body: new URLSearchParams({ ans: '42' }),
        method: 'POST',
      });

      assert.equal(missingActionResponse.status, 400);
      assert.deepEqual(renderCalls, []);
      assert.equal(consoleError.mock.calls.length, 2);
      assert.match(String(consoleError.mock.calls[0]?.[0]), /submission rejected/);
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects posted answers without invoking the runtime in question-only render mode', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'question-only'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push({ qid: input.qid.decoded, submission: input.submission });
          return testSuccessDocument('<p>Question-only preview body</p>');
        },
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const getResponse = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const getHtml = await getResponse.text();

      assert.equal(getResponse.status, 200);
      assert.match(getHtml, /Question-only preview body/);

      const postResponse = await fetch(`${baseUrl}/questions/demo/example?variant=1`, {
        body: new URLSearchParams({ __action: 'grade', ans: '42' }),
        method: 'POST',
      });
      const postBody = await postResponse.text();

      assert.equal(postResponse.status, 405);
      assert.equal(postBody, '');
      assert.deepEqual(renderCalls, [{ qid: 'demo/example', submission: undefined }]);
      assert.equal(consoleError.mock.calls.length, 1);
      assert.match(
        String(consoleError.mock.calls[0]?.[0]),
        /grading is disabled in question-only render mode/,
      );

      const upgradeResponse = await fetch(
        `${baseUrl}/questions/demo/example?render-mode=full&variant=1`,
      );
      const upgradeHtml = await upgradeResponse.text();

      assert.equal(upgradeResponse.status, 400);
      assert.match(upgradeHtml, /Question preview failed/);
      assert.match(
        String(consoleError.mock.calls[1]?.[0]),
        /the "full" render mode is unavailable/,
      );

      const narrowedResponse = await fetch(
        `${baseUrl}/questions/demo/example?render-mode=question-only&variant=1`,
      );

      assert.equal(narrowedResponse.status, 200);
      assert.lengthOf(renderCalls, 2);
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('narrows individual pages through the render-mode query parameter on a full server', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push({ renderMode: input.renderMode, submission: input.submission });
          return testSuccessDocument('<p>Query render mode body</p>');
        },
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);

      const narrowed = await fetch(
        `${baseUrl}/questions/demo/example?render-mode=question-only&variant=1`,
      );
      assert.equal(narrowed.status, 200);

      const explicitFull = await fetch(`${baseUrl}/questions/demo/example?render-mode=full`);
      assert.equal(explicitFull.status, 200);

      const invalid = await fetch(`${baseUrl}/questions/demo/example?render-mode=bogus`);
      const invalidHtml = await invalid.text();
      assert.equal(invalid.status, 400);
      assert.match(invalidHtml, /Question preview failed/);
      assert.match(String(consoleError.mock.calls[0]?.[0]), /invalid render-mode query parameter/);

      const narrowedPost = await fetch(
        `${baseUrl}/questions/demo/example?render-mode=question-only`,
        {
          body: new URLSearchParams({ __action: 'grade', ans: '42' }),
          method: 'POST',
        },
      );
      assert.equal(narrowedPost.status, 405);
      assert.match(
        String(consoleError.mock.calls[1]?.[0]),
        /grading is disabled in question-only render mode/,
      );

      assert.deepEqual(renderCalls, [
        { renderMode: 'question-only', submission: undefined },
        { renderMode: 'full', submission: undefined },
      ]);
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns generic HTML errors for posted answers on failed renders and invalid qids', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push(input);
          return testFailureDocument([
            {
              fatal: true,
              message: 'Submission parse failed',
              name: 'CourseIssueError',
              phase: 'parse',
            },
          ]);
        },
      }),
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const failedRender = await fetch(`${baseUrl}/questions/demo/example?variant=1`, {
        body: new URLSearchParams({ __action: 'grade', ans: '42' }),
        method: 'POST',
      });
      const failedRenderHtml = await failedRender.text();

      assert.equal(failedRender.status, 422);
      assert.match(failedRenderHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(failedRenderHtml, /Submission parse failed/);
      assert.equal(renderCalls.length, 1);
      assert.equal(consoleError.mock.calls.length, 1);
      assert.equal(consoleError.mock.calls[0]?.[0], 'Question preview render failed:');

      const invalidQid = await fetch(`${baseUrl}/questions/demo%5Cexample?variant=1`, {
        body: new URLSearchParams({ __action: 'grade', ans: '42' }),
        method: 'POST',
      });
      const invalidQidHtml = await invalidQid.text();

      assert.equal(invalidQid.status, 422);
      assert.match(invalidQidHtml, /Question preview failed/);
      assert.equal(renderCalls.length, 1);
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns a generic HTML error and logs render failure details instead of negotiating JSON', async () => {
    const courseDir = await makeTempCourse();
    const longOutput = `combined output first line\n${'x'.repeat(5000)}\ncombined output hidden tail`;
    const longStderr = `stderr first line from ${courseDir}\n${'y'.repeat(5000)}\nstderr hidden tail`;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () =>
          testFailureDocument([
            {
              data: {
                env: { SECRET_TOKEN: 'shh' },
                outputBoth: longOutput,
                source: '<pl-question-panel>full question source</pl-question-panel>',
                stack: `Error: render failed\n    at render (${courseDir}/server.py:3:1)`,
                stderr: longStderr,
              },
              fatal: true,
              message: `Render failed while reading ${courseDir}/questions/demo/example/server.py`,
              name: 'CourseIssueError',
              phase: 'generate',
            },
          ]),
      }),
    });

    try {
      const response = await fetch(
        `${startupSessionUrl(started)}/questions/demo/example?variant=1`,
        {
          headers: { accept: 'application/json' },
        },
      );
      const html = await response.text();

      assert.equal(response.status, 422);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(html, /Question preview failed/);
      assert.match(html, /preview server console/);
      nodeAssert.doesNotMatch(html, /CourseIssueError/);
      nodeAssert.doesNotMatch(html, /Phase: generate/);
      nodeAssert.doesNotMatch(html, /Render failed while reading/);
      nodeAssert.doesNotMatch(html, /combined output first line/);
      nodeAssert.doesNotMatch(html, /stderr first line/);
      nodeAssert.doesNotMatch(html, new RegExp(courseDir.replaceAll('/', '\\/')));
      nodeAssert.doesNotMatch(html, /SECRET_TOKEN|shh|full question source|at render/);
      assert.isBelow(html.length, 1000);
      assert.equal(consoleError.mock.calls.length, 1);
      assert.equal(consoleError.mock.calls[0]?.[0], 'Question preview render failed:');
      assert.include(JSON.stringify(consoleError.mock.calls[0]?.[1]), 'CourseIssueError');
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid qid path forms before invoking the runtime', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: string[] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push(input.qid.decoded);
          return testSuccessDocument('<p>Permissive runtime rendered invalid qid</p>');
        },
      }),
    });

    try {
      for (const invalidPath of [
        '/questions/demo%5Cexample?variant=1',
        '/questions/demo%2Fexample?variant=1',
        '/questions/demo%00example?variant=1',
        '/questions/%2e%2e/secret?variant=1',
      ]) {
        const response = await requestRawPath(
          started,
          `${startupSessionPath(started)}${invalidPath}`,
        );

        assert.equal(response.status, 422, invalidPath);
        assert.match(response.body, /Question preview failed/, invalidPath);
        nodeAssert.doesNotMatch(response.body, /Invalid question id/, invalidPath);
        nodeAssert.doesNotMatch(response.body, /Permissive runtime/, invalidPath);
      }
      assert.deepEqual(renderCalls, []);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid qid path forms with generic error pages', async () => {
    const courseDir = await makeTempCourse();
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      for (const invalidPath of [
        '/questions/demo%5Cexample?variant=1',
        '/questions/demo%2Fexample?variant=1',
        '/questions/demo%00example?variant=1',
        '/questions/%2e%2e/secret?variant=1',
      ]) {
        const response = await requestRawPath(
          started,
          `${startupSessionPath(started)}${invalidPath}`,
        );

        assert.equal(response.status, 422, invalidPath);
        assert.match(response.body, /Question preview failed/, invalidPath);
        nodeAssert.doesNotMatch(response.body, /Invalid question id/, invalidPath);
        nodeAssert.doesNotMatch(response.body, /missing info\.json/, invalidPath);
      }
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('distinguishes an unknown question from an existing question with invalid metadata', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionFile(
      courseDir,
      'broken/metadata',
      'info.json',
      JSON.stringify({ title: 'Missing required question metadata' }),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const getUnknown = await fetch(
        `${startupSessionUrl(started)}/questions/unknown/question?variant=1`,
      );
      const getUnknownHtml = await getUnknown.text();

      assert.equal(getUnknown.status, 404);
      assert.match(getUnknown.headers.get('content-type') ?? '', /text\/html/);
      assert.match(getUnknownHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(getUnknownHtml, /unknown\/question|does not exist/);
      nodeAssert.doesNotMatch(getUnknownHtml, new RegExp(courseDir.replaceAll('/', '\\/')));

      const postUnknown = await fetch(
        `${startupSessionUrl(started)}/questions/unknown/question?variant=1`,
        {
          body: new URLSearchParams({ __action: 'grade', ans: '42' }),
          method: 'POST',
        },
      );
      const postUnknownHtml = await postUnknown.text();

      assert.equal(postUnknown.status, 404);
      assert.equal(postUnknownHtml, getUnknownHtml);

      for (const method of ['GET', 'POST'] as const) {
        const response = await fetch(
          `${startupSessionUrl(started)}/questions/broken/metadata?variant=1`,
          method === 'GET'
            ? undefined
            : {
                body: new URLSearchParams({ __action: 'grade', ans: '42' }),
                method,
              },
        );
        const html = await response.text();

        assert.equal(response.status, 422);
        assert.equal(html, getUnknownHtml);
        nodeAssert.doesNotMatch(html, /broken\/metadata|Missing required question metadata/);
        nodeAssert.doesNotMatch(html, new RegExp(courseDir.replaceAll('/', '\\/')));
      }
      assert.equal(consoleError.mock.calls.length, 2);
      assert.equal(consoleError.mock.calls[0]?.[0], 'Question preview render failed:');
      assert.equal(consoleError.mock.calls[1]?.[0], 'Question preview render failed:');
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('keeps the warm runtime after expected direct preview failures', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: { qid: string; runtimeId: number; variantSeed?: string }[] = [];
    let runtimeCount = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => {
        const runtimeId = ++runtimeCount;
        return {
          close: async () => {},
          render: async (input) => {
            renderCalls.push({
              qid: input.qid.decoded,
              runtimeId,
              variantSeed: input.variantSeed,
            });
            if (renderCalls.length === 1) {
              return testFailureDocument([
                {
                  fatal: true,
                  message: 'Unsupported question type from edited info.json',
                  name: 'ExpectedPreviewFailure',
                  phase: 'metadata',
                },
              ]);
            }

            return testSuccessDocument('<p>Rendered after expected failure</p>');
          },
        };
      },
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const diagnostic = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const diagnosticHtml = await diagnostic.text();

      assert.equal(diagnostic.status, 422);
      assert.match(diagnosticHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(diagnosticHtml, /Unsupported question type from edited info\.json/);
      assert.equal(consoleError.mock.calls.length, 1);
      assert.include(JSON.stringify(consoleError.mock.calls[0]?.[1]), 'ExpectedPreviewFailure');

      const refresh = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const refreshHtml = await refresh.text();

      assert.equal(refresh.status, 200);
      assert.match(refreshHtml, /Rendered after expected failure/);
      assert.equal(runtimeCount, 1);
      assert.deepEqual(renderCalls, [
        { qid: 'demo/example', runtimeId: 1, variantSeed: '1' },
        { qid: 'demo/example', runtimeId: 1, variantSeed: '1' },
      ]);
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('keeps the engine-owned runtime after infrastructure recovery so a later refresh can render', async () => {
    const courseDir = await makeTempCourse();
    const closedRuntimeIds: number[] = [];
    let runtimeCount = 0;
    let renderCalls = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--render-mode', 'full'],
      createRuntime: async () => {
        const runtimeId = ++runtimeCount;
        return {
          close: async () => {
            closedRuntimeIds.push(runtimeId);
          },
          render: async () => {
            renderCalls++;
            if (renderCalls === 1) {
              throw new Error('preview runtime crashed');
            }

            return testSuccessDocument(`<p>Recovered on runtime ${runtimeId}</p>`);
          },
        };
      },
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const failed = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const failedHtml = await failed.text();

      assert.equal(failed.status, 500);
      assert.match(failedHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(failedHtml, /preview runtime crashed/);
      assert.equal(consoleError.mock.calls.length, 1);
      assert.equal(consoleError.mock.calls[0]?.[0], 'Question preview request failed:');
      assert.include(String(consoleError.mock.calls[0]?.[1]), 'preview runtime crashed');
      assert.deepEqual(closedRuntimeIds, []);

      const refresh = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const refreshHtml = await refresh.text();

      assert.equal(refresh.status, 200);
      assert.match(refreshHtml, /Recovered on runtime 1/);
      assert.equal(runtimeCount, 1);
    } finally {
      consoleError.mockRestore();
      await started.close();
      assert.deepEqual(closedRuntimeIds, [1]);
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('serves direct preview HTML rendered through the PrairieLearn runtime', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(courseDir, 'runtime/simple');
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const response = await fetch(
        `${startupSessionUrl(started)}/questions/runtime/simple?variant=1`,
      );
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, /Runtime direct preview body/);
      assert.match(html, /class="question-container mb-4"/);
      assert.match(html, /<h1>\s*Runtime direct preview\s*<\/h1>/);
      nodeAssert.doesNotMatch(html, /New Variant|Question ID|Variant:/i);

      const narrowed = await fetch(
        `${startupSessionUrl(started)}/questions/runtime/simple?variant=1&render-mode=question-only`,
      );
      const narrowedHtml = await narrowed.text();

      assert.equal(narrowed.status, 200);
      assert.match(narrowedHtml, /Runtime direct preview body/);
      assert.match(narrowedHtml, /class="question-container"/);
      nodeAssert.doesNotMatch(narrowedHtml, /question-form/);
      nodeAssert.doesNotMatch(narrowedHtml, /question-block/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('checks posted answers through the PrairieLearn runtime without keeping submission state', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'runtime/gradable';
    await writeQuestionInfo(courseDir, qid, {
      title: 'Runtime gradable preview',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111126',
    });
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<pl-question-panel><p>1 + 1 = ?</p></pl-question-panel><pl-number-input answers-name="ans"></pl-number-input>',
    );
    await writeQuestionFile(
      courseDir,
      qid,
      'server.py',
      'def generate(data):\n    data["correct_answers"]["ans"] = 2\n',
    );

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const previewUrl = `${startupSessionUrl(started)}/questions/${qid}?variant=1`;

      const correct = await fetch(previewUrl, {
        body: new URLSearchParams({ __action: 'grade', ans: '2' }),
        method: 'POST',
      });
      const correctHtml = await correct.text();

      assert.equal(correct.status, 200);
      assert.match(correctHtml, /data-testid="submission-block"/);
      assert.match(correctHtml, /data-testid="submission-with-feedback"/);
      assert.match(correctHtml, /text-bg-success/);
      assert.match(correctHtml, /100%/);
      assert.match(correctHtml, /class="card mb-3 grading-block"/);
      assert.match(correctHtml, /Correct answer/);

      const wrong = await fetch(previewUrl, {
        body: new URLSearchParams({ __action: 'grade', ans: '3' }),
        method: 'POST',
      });
      const wrongHtml = await wrong.text();

      assert.equal(wrong.status, 200);
      assert.match(wrongHtml, /data-testid="submission-block"/);
      assert.match(wrongHtml, /text-bg-danger/);
      assert.match(wrongHtml, /0%/);

      const refreshed = await fetch(previewUrl);
      const refreshedHtml = await refreshed.text();

      assert.equal(refreshed.status, 200);
      nodeAssert.doesNotMatch(refreshedHtml, /submission-block/);
      assert.match(refreshedHtml, /Save &amp; Grade/);
      assert.match(refreshedHtml, /class="card mb-3 grading-block d-none"/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('observes question.html, info.json, and server.py edits on repeated direct preview requests', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'runtime/source-refresh';

    const writeInfo = async (type: string) => {
      await writeQuestionFile(
        courseDir,
        qid,
        'info.json',
        JSON.stringify({
          title: 'Refresh source preview',
          topic: 'Testing',
          type,
          uuid: '11111111-1111-4111-8111-111111111125',
        }),
      );
    };
    const writeServer = async (message: string) => {
      await writeQuestionFile(
        courseDir,
        qid,
        'server.py',
        `def generate(data):\n    data["params"]["server_message"] = "${message}"\n`,
      );
    };

    await writeInfo('v3');
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<p>HTML edit one {{params.server_message}}</p>',
    );
    await writeServer('server edit one');

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const previewUrl = `${startupSessionUrl(started)}/questions/${qid}?variant=1`;
      const first = await fetch(previewUrl);
      const firstHtml = await first.text();

      assert.equal(first.status, 200);
      assert.match(firstHtml, /HTML edit one/);
      assert.match(firstHtml, /server edit one/);

      await writeQuestionFile(
        courseDir,
        qid,
        'question.html',
        '<p>HTML edit two {{params.server_message}}</p>',
      );

      const htmlRefresh = await fetch(previewUrl);
      const htmlRefreshBody = await htmlRefresh.text();

      assert.equal(htmlRefresh.status, 200);
      assert.match(htmlRefreshBody, /HTML edit two/);
      nodeAssert.doesNotMatch(htmlRefreshBody, /HTML edit one/);
      assert.match(htmlRefreshBody, /server edit one/);

      await writeInfo('MultipleChoice');

      const metadataRefresh = await fetch(previewUrl);
      const metadataRefreshBody = await metadataRefresh.text();

      assert.equal(metadataRefresh.status, 200);
      assert.match(metadataRefreshBody, /data-question-type="MultipleChoice"/);
      assert.match(metadataRefreshBody, /class="question-data"/);

      await writeInfo('v3');
      await writeServer('server edit two');

      const serverRefresh = await fetch(previewUrl);
      const serverRefreshBody = await serverRefresh.text();

      assert.equal(serverRefresh.status, 200);
      assert.match(serverRefreshBody, /HTML edit two/);
      assert.match(serverRefreshBody, /server edit two/);
      nodeAssert.doesNotMatch(serverRefreshBody, /server edit one/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});

describe('question preview server submission files', () => {
  it('serves a graded submission file so pl-file-preview can download and inline-preview it', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'runtime/submission-file';
    await writeQuestionInfo(courseDir, qid, {
      title: 'Submission file preview',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111140',
    });
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<pl-file-editor file-name="solution.py"></pl-file-editor><pl-file-preview></pl-file-preview>',
    );

    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--port',
        '0',
        '--render-mode',
        'full',
        '--workers-execution-mode',
        'native',
      ],
    });

    try {
      const baseUrl = startupSessionUrl(started);
      const fileContents = 'print("hello from solution")\n';
      const answerName = `_file_editor_${createHash('sha1').update('solution.py').digest('hex')}`;

      const graded = await fetch(`${baseUrl}/questions/${qid}?variant=1`, {
        body: new URLSearchParams({
          __action: 'grade',
          [answerName]: Buffer.from(fileContents).toString('base64'),
        }),
        method: 'POST',
      });
      const gradedHtml = await graded.text();

      assert.equal(graded.status, 200);
      assert.match(gradedHtml, /data-file="solution\.py"/);
      const match = gradedHtml.match(
        /data-submission-files-url="(?<url>\/preview-sessions\/[^/"?#]+\/preview-render\/question\/[^"]+\/submission\/[^"]+\/file)"/,
      );
      assert.isNotNull(match);
      const submissionFilesUrl = match.groups?.url ?? '';

      const fileResponse = await fetch(`${serverUrl(started)}${submissionFilesUrl}/solution.py`);
      assert.equal(fileResponse.status, 200);
      assert.equal(fileResponse.headers.get('content-type'), 'text/plain');
      assert.equal(await fileResponse.text(), fileContents);

      const missing = await fetch(`${serverUrl(started)}${submissionFilesUrl}/missing.py`);
      assert.equal(missing.status, 404);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});

describe('question preview server workspace routes', () => {
  it('applies the running-container limit across runtime Local Preview Sessions', async () => {
    const firstCourseDir = await makeTempCourse();
    const secondCourseDir = await makeTempCourse();
    const allocators: PreviewWorkspaceAllocator[] = [];
    const docker = makeLaunchingDockerClient();
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        firstCourseDir,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--workspaces',
        '--workspace-max-containers',
        '1',
      ],
      createRuntime: async (options) => {
        if (options.localPreviewWorkspaces != null) {
          allocators.push(options.localPreviewWorkspaces);
        }
        return { close: async () => {}, render: async () => testFailureDocument() };
      },
      createWorkspaceOwner: (options) =>
        createPreviewWorkspaceOwner({
          ...options,
          docker,
          fetchFn: () => Promise.resolve(),
        }),
    });

    try {
      const firstSessionPath = startupSessionPath(started);
      const firstAllocator = allocators[0];
      assert.isDefined(firstAllocator);
      const first = firstAllocator.ensureWorkspace(makeWorkspaceSpec());
      await fetch(`${serverUrl(started)}${firstSessionPath}/workspace/${first.workspaceId}`);
      await vi.waitFor(async () => {
        const response = await fetch(
          `${serverUrl(started)}${firstSessionPath}/workspace/${first.workspaceId}/status`,
        );
        assert.equal((await response.json()).state, 'running');
      });

      const created = await fetch(`${serverUrl(started)}/preview-sessions`, {
        body: JSON.stringify({ courseDir: secondCourseDir }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(created.status, 201);
      const secondSession = await created.json();
      const secondAllocator = allocators[1];
      assert.isDefined(secondAllocator);
      const second = secondAllocator.ensureWorkspace(makeWorkspaceSpec());
      await fetch(
        `${serverUrl(started)}/preview-sessions/${secondSession.previewSessionId}/workspace/${second.workspaceId}`,
      );

      await vi.waitFor(async () => {
        const secondStatus = await fetch(
          `${serverUrl(started)}/preview-sessions/${secondSession.previewSessionId}/workspace/${second.workspaceId}/status`,
        );
        assert.equal((await secondStatus.json()).state, 'running');
      });
      const firstStatus = await fetch(
        `${serverUrl(started)}${firstSessionPath}/workspace/${first.workspaceId}/status`,
      );
      assert.equal((await firstStatus.json()).state, 'stopped');
    } finally {
      await started.close();
      await Promise.all(
        [firstCourseDir, secondCourseDir].map((courseDir) =>
          fs.rm(courseDir, { force: true, recursive: true }),
        ),
      );
    }
  });

  it('routes WebSockets through the session and closes them before deletion returns', async () => {
    const courseDir = await makeTempCourse();
    const workspaceApplication = await startWorkspaceApplication();
    const captured: { workspaceAllocator?: PreviewWorkspaceAllocator } = {};
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0', '--workspaces'],
      createRuntime: async (options) => {
        captured.workspaceAllocator = options.localPreviewWorkspaces ?? undefined;
        return { close: async () => {}, render: async () => testFailureDocument() };
      },
      createWorkspaceOwner: (options) =>
        createPreviewWorkspaceOwner({
          ...options,
          docker: makeLaunchingDockerClient(workspaceApplication.port),
          fetchFn: () => Promise.resolve(),
        }),
    });

    try {
      const workspaceAllocator = captured.workspaceAllocator;
      assert.isDefined(workspaceAllocator);
      const workspace = workspaceAllocator.ensureWorkspace(makeWorkspaceSpec());
      const workspacePath = `${startupSessionPath(started)}/workspace/${workspace.workspaceId}`;
      await fetch(`${serverUrl(started)}${workspacePath}`);
      await vi.waitFor(async () => {
        const status = await fetch(`${serverUrl(started)}${workspacePath}/status`);
        assert.equal((await status.json()).state, 'running');
      });

      const previewOrigin = new URL(serverUrl(started));
      const socket = await new Promise<Socket>((resolve, reject) => {
        const request = http.request({
          headers: {
            Connection: 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
            Upgrade: 'websocket',
          },
          host: previewOrigin.hostname,
          path: `${workspacePath}/container/socket`,
          port: Number(previewOrigin.port),
        });
        request.on('upgrade', (_res, upgradeSocket) => resolve(upgradeSocket));
        request.on('error', reject);
        request.end();
      });
      socket.resume();
      const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      const deleted = fetch(
        `${serverUrl(started)}/preview-sessions/${started.startupSessions[0].previewSessionId}`,
        { method: 'DELETE' },
      );

      const response = await Promise.race([
        Promise.all([deleted, socketClosed]).then(([result]) => result),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('Session deletion did not close its WebSocket.')),
            1000,
          ),
        ),
      ]);
      assert.equal(response.status, 204);
      assert.isTrue(socket.destroyed);
    } finally {
      await started.close();
      await workspaceApplication.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('serves the workspace page, status endpoint, and reboot/reset actions', async () => {
    const courseDir = await makeTempCourse();
    const captured: { workspaceAllocator?: PreviewWorkspaceAllocator } = {};
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0', '--workspaces'],
      createRuntime: async (options) => {
        captured.workspaceAllocator = options.localPreviewWorkspaces ?? undefined;
        return {
          close: async () => {},
          render: async () => testFailureDocument(),
        };
      },
    });
    const baseUrl = startupSessionUrl(started);

    try {
      const workspaceAllocator = captured.workspaceAllocator;
      assert.isDefined(workspaceAllocator);
      const { workspaceId, workspaceUrl } = workspaceAllocator.ensureWorkspace(makeWorkspaceSpec());
      assert.equal(workspaceUrl, `${startupSessionPath(started)}/workspace/${workspaceId}`);

      const page = await fetch(`${baseUrl}/workspace/${workspaceId}`);
      const pageBody = await page.text();
      assert.equal(page.status, 200);
      assert.match(pageBody, /id="workspace-root"/);
      assert.match(pageBody, /demo\/workspace/);
      assert.notMatch(pageBody, /pv-toolbar/);

      const status = await fetch(`${baseUrl}/workspace/${workspaceId}/status`);
      assert.equal(status.status, 200);
      const statusJson = await status.json();
      assert.property(statusJson, 'state');
      assert.property(statusJson, 'message');

      const heartbeat = await fetch(`${baseUrl}/workspace/${workspaceId}/status?heartbeat=1`);
      assert.equal(heartbeat.status, 200);

      const reboot = await fetch(`${baseUrl}/workspace/${workspaceId}/reboot`, { method: 'POST' });
      assert.equal(reboot.status, 200);
      const rebootJson = await reboot.json();
      assert.property(rebootJson, 'state');

      const reset = await fetch(`${baseUrl}/workspace/${workspaceId}/reset`, { method: 'POST' });
      assert.equal(reset.status, 200);
      const resetJson = await reset.json();
      assert.property(resetJson, 'state');
      assert.equal(resetJson.version, 2);

      const unknownReboot = await fetch(`${baseUrl}/workspace/999/reboot`, { method: 'POST' });
      assert.equal(unknownReboot.status, 404);

      const unknownPage = await fetch(`${baseUrl}/workspace/999`);
      assert.equal(unknownPage.status, 404);
      assert.match(await unknownPage.text(), /Unknown workspace/);

      const unknownStatus = await fetch(`${baseUrl}/workspace/999/status`);
      assert.equal(unknownStatus.status, 404);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('responds with 404 for container traffic when the workspace is not running', async () => {
    const courseDir = await makeTempCourse();
    const captured: { workspaceAllocator?: PreviewWorkspaceAllocator } = {};
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0', '--workspaces'],
      createRuntime: async (options) => {
        captured.workspaceAllocator = options.localPreviewWorkspaces ?? undefined;
        return {
          close: async () => {},
          render: async () => testFailureDocument(),
        };
      },
    });
    const baseUrl = startupSessionUrl(started);

    try {
      const workspaceAllocator = captured.workspaceAllocator;
      assert.isDefined(workspaceAllocator);
      const { workspaceId } = workspaceAllocator.ensureWorkspace(makeWorkspaceSpec());

      const response = await fetch(`${baseUrl}/workspace/${workspaceId}/container/`);
      assert.equal(response.status, 404);
      assert.equal(await response.text(), 'Workspace is not running');
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('disables workspace routes and the renderer allocator by default', async () => {
    const courseDir = await makeTempCourse();
    const runtimeOptions: Parameters<
      NonNullable<StartQuestionPreviewServerParams['createRuntime']>
    >[0][] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0'],
      createRuntime: async (options) => {
        runtimeOptions.push(options);
        return { close: async () => {}, render: async () => testFailureDocument() };
      },
    });
    const baseUrl = startupSessionUrl(started);

    try {
      assert.isNull(runtimeOptions[0]?.localPreviewWorkspaces);

      const response = await fetch(`${baseUrl}/workspace/1`);
      assert.equal(response.status, 404);
      assert.match(await response.text(), /Workspaces are disabled/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});

// Exercises a real workspace container end-to-end. Opt in with
// `PL_PREVIEW_WORKSPACE_DOCKER_TEST=1`; requires Docker and pulls the
// `prairielearn/workspace-xtermjs` image on first run.
describe.skipIf(process.env.PL_PREVIEW_WORKSPACE_DOCKER_TEST !== '1')(
  'question preview server with real Docker workspaces',
  () => {
    it(
      'launches, proxies, resets, and cleans up a real workspace container',
      { timeout: 600_000 },
      async () => {
        const courseDir = await makeTempCourse();
        const captured: { workspaceAllocator?: PreviewWorkspaceAllocator } = {};
        const workspaceFilesDir = path.join(courseDir, 'questions', 'demo/workspace', 'workspace');
        await fs.mkdir(workspaceFilesDir, { recursive: true });
        await fs.writeFile(path.join(workspaceFilesDir, 'starter.c'), 'int main() { return 0; }\n');

        const started = await startTestQuestionPreviewServer({
          argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0', '--workspaces'],
          createRuntime: async (options) => {
            captured.workspaceAllocator = options.localPreviewWorkspaces ?? undefined;
            return {
              close: async () => {},
              render: async () => testFailureDocument(),
            };
          },
          createWorkspaceOwner: createPreviewWorkspaceOwner,
        });
        const baseUrl = startupSessionUrl(started);

        try {
          const workspaceAllocator = captured.workspaceAllocator;
          assert.isDefined(workspaceAllocator);
          const { workspaceId } = workspaceAllocator.ensureWorkspace(
            makeWorkspaceSpec({
              settings: {
                args: null,
                enableNetworking: false,
                environment: {},
                gradedFiles: ['**/*.c'],
                home: null,
                image: 'prairielearn/workspace-xtermjs',
                port: null,
                rewriteUrl: true,
              },
            }),
          );

          const page = await fetch(`${baseUrl}/workspace/${workspaceId}`);
          assert.equal(page.status, 200);

          await vi.waitFor(
            async () => {
              const status = await fetch(`${baseUrl}/workspace/${workspaceId}/status`);
              const statusJson = await status.json();
              if (statusJson.state === 'failed') {
                throw new Error(`Workspace failed to launch: ${statusJson.message}`);
              }
              assert.equal(statusJson.state, 'running');
            },
            { interval: 1000, timeout: 570_000 },
          );

          const proxied = await fetch(`${baseUrl}/workspace/${workspaceId}/container/`);
          assert.equal(proxied.status, 200);

          const previewOrigin = new URL(serverUrl(started));
          const workspaceSocket = await new Promise<Socket>((resolve, reject) => {
            const request = http.request({
              headers: {
                Connection: 'Upgrade',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version': '13',
                Upgrade: 'websocket',
              },
              host: previewOrigin.hostname,
              path: `${startupSessionPath(started)}/workspace/${workspaceId}/container/`,
              port: Number(previewOrigin.port),
            });
            request.on('upgrade', (_res, upgradeSocket) => resolve(upgradeSocket));
            request.on('response', (res) =>
              reject(new Error(`Unexpected WebSocket response: ${res.statusCode}`)),
            );
            request.on('error', reject);
            request.end();
          });
          workspaceSocket.destroy();

          const graded = await workspaceAllocator.collectGradedFiles({
            qid: 'demo/workspace',
            variantSeed: '1',
          });
          assert.isTrue(graded.ok);
          assert.deepEqual(
            graded.files.map((file) => file.name),
            ['starter.c'],
          );

          const reset = await fetch(`${baseUrl}/workspace/${workspaceId}/reset`, {
            method: 'POST',
          });
          assert.equal(reset.status, 200);
          assert.equal((await reset.json()).version, 2);
        } finally {
          await started.close();
          await fs.rm(courseDir, { force: true, recursive: true });
        }

        const docker = new Docker();
        const remaining = await docker.listContainers({
          all: true,
          filters: { label: ['com.prairielearn.preview-workspace=true'] },
        });
        assert.lengthOf(
          remaining.filter(
            (container) =>
              container.Labels['com.prairielearn.preview-workspace.pid'] === String(process.pid),
          ),
          0,
        );
      },
    );
  },
);
