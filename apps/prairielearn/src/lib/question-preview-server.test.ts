import nodeAssert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import {
  parseQuestionPreviewServerOptions,
  startQuestionPreviewServer,
} from './question-preview-server.js';

async function makeTempCourse() {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-server-'));
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
  info: { title: string; topic: string; type: string; uuid: string },
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

async function pathExists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function serverUrl(started: Awaited<ReturnType<typeof startQuestionPreviewServer>>) {
  const address = started.server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Expected preview server to listen on a TCP address.');
  }
  return `http://${address.address}:${address.port}`;
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
      const defaultOptions = await parseQuestionPreviewServerOptions(['--course-dir', courseDir]);
      assert.deepEqual(defaultOptions, {
        cacheType: 'none',
        corsOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
        courseDir: path.resolve(courseDir),
        devMode: false,
        host: '127.0.0.1',
        port: 4310,
        questionTimeoutMilliseconds: 5000,
        renderTimeoutMilliseconds: 10000,
        startupTimeoutMilliseconds: 30000,
        workersCount: 1,
        workersExecutionMode: 'native',
      });

      const explicitOptions = await parseQuestionPreviewServerOptions([
        '--course-dir',
        courseDir,
        '--cache-type',
        'memory',
        '--cors-origin',
        ' http://127.0.0.1:5173/demo , https://example.test ',
        '--cors-origin',
        'http://127.0.0.1:5173',
        '--dev-mode',
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--question-timeout-ms',
        '1',
        '--render-timeout-ms',
        '2',
        '--startup-timeout-ms',
        '3',
        '--workers-count',
        '4',
        '--workers-execution-mode',
        'container',
      ]);

      assert.deepEqual(explicitOptions, {
        cacheType: 'memory',
        corsOrigins: ['http://127.0.0.1:5173', 'https://example.test'],
        courseDir: path.resolve(courseDir),
        devMode: true,
        host: '0.0.0.0',
        port: 0,
        questionTimeoutMilliseconds: 1,
        renderTimeoutMilliseconds: 2,
        startupTimeoutMilliseconds: 3,
        workersCount: 4,
        workersExecutionMode: 'container',
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
        argv: ['--course-dir', courseDir, '--render-timeout-ms', '1.5'],
        message: /Invalid --render-timeout-ms/,
      },
      {
        argv: ['--course-dir', courseDir, '--startup-timeout-ms', 'abc'],
        message: /Invalid --startup-timeout-ms/,
      },
      {
        argv: ['--course-dir', courseDir, '--workers-count', '0'],
        message: /Invalid --workers-count/,
      },
      {
        argv: ['--course-dir', courseDir, '--cache-type', 'disk'],
        message: /Invalid --cache-type/,
      },
      {
        argv: ['--course-dir', courseDir, '--workers-execution-mode', 'disabled'],
        message: /Invalid --workers-execution-mode/,
      },
      {
        argv: ['--course-dir', courseDir, '--cors-origin', 'ftp://example.test'],
        message: /Invalid --cors-origin/,
      },
      { argv: ['--course-dir', missingCourseDir], message: /Invalid --course-dir/ },
    ];

    try {
      for (const testCase of invalidCases) {
        await nodeAssert.rejects(
          () =>
            startQuestionPreviewServer({
              argv: testCase.argv,
              createRuntime: async () => {
                runtimeCreations++;
                return {
                  close: async () => {},
                  render: async () => ({ diagnostics: [], ok: false }),
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

  it('requires an explicit valid course directory and prewarms before readiness', async () => {
    const courseDir = await makeTempCourse();
    const missingCourseDir = path.join(os.tmpdir(), 'pl-preview-server-missing-course');
    const events: string[] = [];
    const previousEnvCourseDir = process.env.PL_PREVIEW_COURSE_DIR;

    try {
      process.env.PL_PREVIEW_COURSE_DIR = courseDir;
      await nodeAssert.rejects(
        () =>
          startQuestionPreviewServer({
            argv: [],
            createRuntime: async () => {
              events.push('runtime');
              return {
                close: async () => {},
                render: async () => ({ diagnostics: [], ok: false }),
              };
            },
          }),
        /--course-dir/,
      );
      assert.deepEqual(events, []);
    } finally {
      if (previousEnvCourseDir == null) {
        delete process.env.PL_PREVIEW_COURSE_DIR;
      } else {
        process.env.PL_PREVIEW_COURSE_DIR = previousEnvCourseDir;
      }
    }

    await nodeAssert.rejects(
      () =>
        startQuestionPreviewServer({
          argv: ['--course-dir', missingCourseDir],
          createRuntime: async () => {
            events.push('runtime');
            return { close: async () => {}, render: async () => ({ diagnostics: [], ok: false }) };
          },
        }),
      /Invalid --course-dir/,
    );
    assert.deepEqual(events, []);

    const defaultOptions = await parseQuestionPreviewServerOptions(['--course-dir', courseDir]);
    assert.equal(defaultOptions.host, '127.0.0.1');
    assert.equal(defaultOptions.port, 4310);

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--host', '127.0.0.1', '--port', '0'],
      createRuntime: async (options) => {
        events.push(`runtime:${options.courseDir}:${options.prewarmWorkers}`);
        return { close: async () => {}, render: async () => ({ diagnostics: [], ok: false }) };
      },
      onReady: () => {
        events.push('ready');
      },
    });

    try {
      const address = started.server.address();
      if (address == null || typeof address === 'string') {
        throw new Error('Expected preview server to listen on a TCP address.');
      }
      assert.equal(address.address, '127.0.0.1');
      assert.equal(started.options.host, '127.0.0.1');
      assert.equal(started.options.port, 0);
      assert.equal(started.options.courseDir, path.resolve(courseDir));
      assert.deepEqual(events, [`runtime:${path.resolve(courseDir)}:true`, 'ready']);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('cleans stale generated-file temp roots on startup and removes the current root on close', async () => {
    const courseDir = await makeTempCourse();
    let tempRootPrefix: string;

    const first = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    tempRootPrefix = path.basename(first.generatedFilesRoot).slice(0, -6);
    await first.close();

    const staleRoot = path.join(os.tmpdir(), `${tempRootPrefix}stale-test`);
    await fs.mkdir(staleRoot, { recursive: true });
    await fs.writeFile(path.join(staleRoot, 'leftover.txt'), 'stale generated file');

    const second = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      assert.equal(await pathExists(staleRoot), false);
      assert.equal(path.basename(second.generatedFilesRoot).startsWith(tempRootPrefix), true);
      assert.equal(await pathExists(second.generatedFilesRoot), true);
    } finally {
      await second.close();
      await fs.rm(staleRoot, { force: true, recursive: true });
      await fs.rm(courseDir, { force: true, recursive: true });
    }

    assert.equal(await pathExists(second.generatedFilesRoot), false);
  });
});

describe('question preview server discovery API', () => {
  it('recursively lists valid questions with canonical preview URLs', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'beta/question', {
      title: 'Beta question',
      topic: 'Rendering',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111126',
    });
    await writeQuestionInfo(courseDir, 'alpha/question', {
      title: 'Alpha question',
      topic: 'Logic',
      type: 'Freeform',
      uuid: '11111111-1111-4111-8111-111111111127',
    });

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      const response = await fetch(`${serverUrl(started)}/api/questions`);
      const questions = await response.json();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(questions, [
        {
          previewUrl: '/questions/alpha/question?variant=1',
          qid: 'alpha/question',
          title: 'Alpha question',
          topic: 'Logic',
          type: 'Freeform',
        },
        {
          previewUrl: '/questions/beta/question?variant=1',
          qid: 'beta/question',
          title: 'Beta question',
          topic: 'Rendering',
          type: 'v3',
        },
      ]);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('includes invalid question metadata entries with an invalid-info marker', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'valid/question', {
      title: 'Valid question',
      topic: 'Rendering',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111128',
    });
    await writeQuestionFile(courseDir, 'broken/question', 'info.json', '{ not valid json');
    await writeQuestionFile(
      courseDir,
      'missing/title',
      'info.json',
      JSON.stringify({ topic: 'Rendering', type: 'v3' }),
    );

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      const response = await fetch(`${serverUrl(started)}/api/questions`);
      const questions = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(questions, [
        {
          previewUrl: '/questions/broken/question?variant=1',
          qid: 'broken/question',
          title: 'broken/question',
          topic: null,
          type: 'invalid-info-json',
        },
        {
          previewUrl: '/questions/missing/title?variant=1',
          qid: 'missing/title',
          title: 'missing/title',
          topic: null,
          type: 'invalid-info-json',
        },
        {
          previewUrl: '/questions/valid/question?variant=1',
          qid: 'valid/question',
          title: 'Valid question',
          topic: 'Rendering',
          type: 'v3',
        },
      ]);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('does not accept or reveal a per-request course directory', async () => {
    const courseDir = await makeTempCourse();
    const otherCourseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'startup/question', {
      title: 'Startup-bound question',
      topic: 'Rendering',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111129',
    });
    await writeQuestionInfo(otherCourseDir, 'other/question', {
      title: 'Other course question',
      topic: 'Rendering',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111130',
    });

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      const response = await fetch(
        `${serverUrl(started)}/api/questions?courseDir=${encodeURIComponent(otherCourseDir)}`,
      );
      const text = await response.text();
      const questions = JSON.parse(text);

      assert.equal(response.status, 200);
      assert.deepEqual(
        questions.map((question: { qid: string }) => question.qid),
        ['startup/question'],
      );
      nodeAssert.doesNotMatch(text, new RegExp(courseDir.replaceAll('/', '\\/')));
      nodeAssert.doesNotMatch(text, new RegExp(otherCourseDir.replaceAll('/', '\\/')));
      nodeAssert.doesNotMatch(text, /Other course question/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(otherCourseDir, { force: true, recursive: true });
    }
  });

  it('does not expose discovery responses on adjacent API paths', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'exact/discovery-route', {
      title: 'Exact discovery route',
      topic: 'Rendering',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111138',
    });
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      const response = await fetch(`${serverUrl(started)}/api/questions/`, {
        headers: { origin: 'http://localhost:3000' },
      });
      const body = await response.text();

      assert.equal(response.status, 404);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      nodeAssert.doesNotMatch(body, /Exact discovery route|exact\/discovery-route/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('allows only default local Next.js origins for discovery CORS', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'cors/question', {
      title: 'CORS question',
      topic: 'Rendering',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111131',
    });
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => ({
          diagnostics: [],
          ok: true,
          payload: {
            bodyHtml: '<p>Preview body</p>',
            headHtml: '',
            variant: { seed: input.variantSeed ?? '1' },
          },
        }),
      }),
    });

    try {
      const baseUrl = serverUrl(started);
      const allowedDiscovery = await fetch(`${baseUrl}/api/questions`, {
        headers: { origin: 'http://localhost:3000' },
      });

      assert.equal(allowedDiscovery.status, 200);
      assert.equal(
        allowedDiscovery.headers.get('access-control-allow-origin'),
        'http://localhost:3000',
      );
      assert.notEqual(allowedDiscovery.headers.get('access-control-allow-origin'), '*');
      assert.match(allowedDiscovery.headers.get('vary') ?? '', /Origin/);

      const blockedDiscovery = await fetch(`${baseUrl}/api/questions`, {
        headers: { origin: 'http://example.test:3000' },
      });

      assert.equal(blockedDiscovery.status, 200);
      assert.equal(blockedDiscovery.headers.get('access-control-allow-origin'), null);

      const preflight = await fetch(`${baseUrl}/api/questions`, {
        headers: {
          'access-control-request-method': 'GET',
          origin: 'http://127.0.0.1:3000',
        },
        method: 'OPTIONS',
      });

      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3000');
      assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /GET/);

      const preview = await fetch(`${baseUrl}/questions/cors/question?variant=1`, {
        headers: { origin: 'http://localhost:3000' },
      });

      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get('access-control-allow-origin'), null);

      const asset = await fetch(`${baseUrl}/preview-render/clientFilesCourse/example.css`, {
        headers: { origin: 'http://localhost:3000' },
      });

      assert.equal(asset.headers.get('access-control-allow-origin'), null);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('uses configured discovery CORS origins instead of the defaults', async () => {
    const courseDir = await makeTempCourse();
    const configuredOrigin = 'http://127.0.0.1:5173';
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--cors-origin', configuredOrigin],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      assert.deepEqual(started.options.corsOrigins, [configuredOrigin]);

      const baseUrl = serverUrl(started);
      const configured = await fetch(`${baseUrl}/api/questions`, {
        headers: { origin: configuredOrigin },
      });

      assert.equal(configured.status, 200);
      assert.equal(configured.headers.get('access-control-allow-origin'), configuredOrigin);

      const defaultOrigin = await fetch(`${baseUrl}/api/questions`, {
        headers: { origin: 'http://localhost:3000' },
      });

      assert.equal(defaultOrigin.status, 200);
      assert.equal(defaultOrigin.headers.get('access-control-allow-origin'), null);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});

describe('question preview server asset routes', () => {
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

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      const baseUrl = serverUrl(started);
      const cases = [
        {
          body: /function|window|document/,
          path: '/assets/public/cache/localscripts/question.js',
        },
        { body: /course asset/, path: '/preview-render/clientFilesCourse/course.css' },
        { body: /element asset/, path: '/preview-render/elements/course-widget/course-widget.css' },
        {
          body: /extension asset/,
          path: '/preview-render/elementExtensions/pl-number-input/course-extension/course-extension.js',
        },
        {
          body: /question asset/,
          path: '/preview-render/questions/unit/assets/files/question.txt',
        },
      ];

      for (const testCase of cases) {
        const response = await fetch(`${baseUrl}${testCase.path}`);
        const body = await response.text();

        assert.equal(response.status, 200, testCase.path);
        assert.match(body, testCase.body, testCase.path);
      }
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

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
    });

    try {
      const baseUrl = serverUrl(started);
      const response = await fetch(`${baseUrl}/questions/unit/asset-links?variant=1`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(
        html,
        /src="\/preview-render\/questions\/unit\/asset-links\/files\/diagram\.svg"/,
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

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      const response = await fetch(
        `${serverUrl(started)}/preview-render/questions/unit/files/assets/files/question.txt`,
      );
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(body, /question asset through files qid/);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects asset traversal, symlinks, invalid paths, and category mixing', async () => {
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

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({ diagnostics: [], ok: false }),
      }),
    });

    try {
      const rejectedPaths = [
        '/assets/public/cache/%2e%2e/package.json',
        '/preview-render/clientFilesCourse/%2e%2e/questions/unit/assets/clientFilesQuestion/question.txt',
        '/preview-render/clientFilesCourse/%2Ftmp%2Fsecret.txt',
        '/preview-render/clientFilesCourse/dir%5Csecret.txt',
        '/preview-render/clientFilesCourse//course.txt',
        '/preview-render/clientFilesCourse/linked-secret.txt',
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
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('serves generated files through render ID-scoped URLs that keep older renders available', async () => {
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

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
    });

    try {
      const baseUrl = serverUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/render\/(?<renderId>[^/"?#]+)\/data\.txt)"/,
      );

      assert.equal(first.status, 200);
      nodeAssert.doesNotMatch(firstHtml, /generatedFilesQuestion\/variant\/1/);
      assert.isNotNull(firstMatch);
      const firstPath = firstMatch?.groups?.path ?? '';
      const firstRenderId = firstMatch?.groups?.renderId ?? '';

      const firstFile = await fetch(`${baseUrl}${firstPath}`);
      assert.equal(firstFile.status, 200);
      assert.equal(await firstFile.text(), 'generated file for seed 1');

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/render\/(?<renderId>[^/"?#]+)\/data\.txt)"/,
      );

      assert.equal(second.status, 200);
      assert.isNotNull(secondMatch);
      const secondPath = secondMatch?.groups?.path ?? '';
      const secondRenderId = secondMatch?.groups?.renderId ?? '';
      assert.notEqual(firstRenderId, secondRenderId);

      const secondFile = await fetch(`${baseUrl}${secondPath}`);
      assert.equal(secondFile.status, 200);
      assert.equal(await secondFile.text(), 'generated file for seed 2');

      const oldFirstFile = await fetch(`${baseUrl}${firstPath}`);
      assert.equal(oldFirstFile.status, 200);
      assert.equal(await oldFirstFile.text(), 'generated file for seed 1');
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects generated-file render ID mixing and invalid generated-file paths', async () => {
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

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
    });

    try {
      const baseUrl = serverUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="\/preview-render\/generatedFilesQuestion\/render\/(?<renderId>[^/"?#]+)\/first\.txt"/,
      );
      assert.equal(first.status, 200);
      assert.isNotNull(firstMatch);
      const firstRenderId = firstMatch?.groups?.renderId ?? '';

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="\/preview-render\/generatedFilesQuestion\/render\/(?<renderId>[^/"?#]+)\/second\.txt"/,
      );
      assert.equal(second.status, 200);
      assert.isNotNull(secondMatch);
      const secondRenderId = secondMatch?.groups?.renderId ?? '';
      assert.notEqual(firstRenderId, secondRenderId);

      const mixedRenderId = await fetch(
        `${baseUrl}/preview-render/generatedFilesQuestion/render/${secondRenderId}/first.txt`,
      );
      const mixedRenderIdBody = await mixedRenderId.text();
      assert.notEqual(mixedRenderId.status, 200);
      nodeAssert.doesNotMatch(mixedRenderIdBody, /generated first/);

      const rejectedPaths = [
        '/preview-render/generatedFilesQuestion/render/not-a-render-id/first.txt',
        `/preview-render/generatedFilesQuestion/render/${firstRenderId}/%2e%2e/${secondRenderId}/second.txt`,
        `/preview-render/generatedFilesQuestion/render/${firstRenderId}/%2Ftmp%2Fsecret.txt`,
        `/preview-render/generatedFilesQuestion/render/${firstRenderId}/dir%5Csecret.txt`,
        `/preview-render/generatedFilesQuestion/render/${firstRenderId}//first.txt`,
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
  it('redirects missing variants and renders a full HTML document for direct question URLs', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: { qid: string; variantSeed?: string }[] = [];
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push(input);
          return {
            diagnostics: [],
            ok: true,
            payload: {
              bodyHtml: '<div class="question-container"><p>Rendered preview body</p></div>',
              headHtml: '<script>window.previewHeadLoaded = true;</script>',
              variant: { seed: input.variantSeed ?? '1' },
            },
          };
        },
      }),
    });

    try {
      const baseUrl = serverUrl(started);
      const redirect = await fetch(`${baseUrl}/questions/demo/example`, {
        redirect: 'manual',
      });

      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), '/questions/demo/example?variant=1');
      assert.deepEqual(renderCalls, []);

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
      assert.deepEqual(renderCalls, [{ qid: 'demo/example', variantSeed: '2' }]);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('keeps direct preview pages free of server controls and has no JSON render endpoint', async () => {
    const courseDir = await makeTempCourse();
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({
          diagnostics: [],
          ok: true,
          payload: {
            bodyHtml: '<section><p>Only rendered question content</p></section>',
            headHtml: '',
            variant: { seed: '1' },
          },
        }),
      }),
    });

    try {
      const baseUrl = serverUrl(started);
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
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({
          diagnostics: [],
          ok: true,
          payload: {
            bodyHtml: '<p>Preview only</p>',
            headHtml: '',
            variant: { seed: '1' },
          },
        }),
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
        { method: 'POST', path: '/questions/demo/example?variant=1' },
      ];

      for (const route of absentRoutes) {
        const response = await fetch(`${serverUrl(started)}${route.path}`, {
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

  it('returns bounded sanitized HTML diagnostics instead of negotiating JSON', async () => {
    const courseDir = await makeTempCourse();
    const longOutput = `combined output first line\n${'x'.repeat(5000)}\ncombined output hidden tail`;
    const longStderr = `stderr first line from ${courseDir}\n${'y'.repeat(5000)}\nstderr hidden tail`;

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => ({
          diagnostics: [
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
          ],
          ok: false,
        }),
      }),
    });

    try {
      const response = await fetch(`${serverUrl(started)}/questions/demo/example?variant=1`, {
        headers: { accept: 'application/json' },
      });
      const html = await response.text();

      assert.equal(response.status, 422);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(html, /CourseIssueError/);
      assert.match(html, /Phase: generate/);
      assert.match(html, /Render failed while reading/);
      assert.match(html, /combined output first line/);
      assert.match(html, /stderr first line/);
      nodeAssert.doesNotMatch(html, new RegExp(courseDir.replaceAll('/', '\\/')));
      nodeAssert.doesNotMatch(html, /combined output hidden tail|stderr hidden tail/);
      nodeAssert.doesNotMatch(html, /SECRET_TOKEN|shh|full question source|at render/);
      assert.isBelow(html.length, 7000);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid qid path forms before invoking the runtime', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: string[] = [];
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push(input.qid);
          return {
            diagnostics: [],
            ok: true,
            payload: {
              bodyHtml: '<p>Permissive runtime rendered invalid qid</p>',
              headHtml: '',
              variant: { seed: input.variantSeed ?? '1' },
            },
          };
        },
      }),
    });

    try {
      for (const invalidPath of [
        '/questions/demo%5Cexample?variant=1',
        '/questions/%2e%2e/secret?variant=1',
      ]) {
        const response = await requestRawPath(started, invalidPath);

        assert.equal(response.status, 422, invalidPath);
        assert.match(response.body, /Invalid question id/, invalidPath);
        nodeAssert.doesNotMatch(response.body, /Permissive runtime/, invalidPath);
      }
      assert.deepEqual(renderCalls, []);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid qid path forms with diagnostic pages', async () => {
    const courseDir = await makeTempCourse();
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
    });

    try {
      for (const invalidPath of [
        '/questions/demo%5Cexample?variant=1',
        '/questions/%2e%2e/secret?variant=1',
      ]) {
        const response = await requestRawPath(started, invalidPath);

        assert.equal(response.status, 422, invalidPath);
        assert.match(response.body, /Invalid question id/, invalidPath);
        nodeAssert.doesNotMatch(response.body, /missing info\.json/, invalidPath);
      }
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('keeps the warm runtime after expected direct preview failures', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: { qid: string; runtimeId: number; variantSeed?: string }[] = [];
    let runtimeCount = 0;

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => {
        const runtimeId = ++runtimeCount;
        return {
          close: async () => {},
          render: async (input) => {
            renderCalls.push({ ...input, runtimeId });
            if (renderCalls.length === 1) {
              return {
                diagnostics: [
                  {
                    fatal: true,
                    message: 'Unsupported question type from edited info.json',
                    name: 'ExpectedPreviewFailure',
                    phase: 'metadata',
                  },
                ],
                ok: false,
              };
            }

            return {
              diagnostics: [],
              ok: true,
              payload: {
                bodyHtml: '<p>Rendered after expected failure</p>',
                headHtml: '',
                variant: { seed: input.variantSeed ?? '1' },
              },
            };
          },
        };
      },
    });

    try {
      const baseUrl = serverUrl(started);
      const diagnostic = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const diagnosticHtml = await diagnostic.text();

      assert.equal(diagnostic.status, 422);
      assert.match(diagnosticHtml, /Unsupported question type from edited info\.json/);

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
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('replaces the runtime after infrastructure failures so a later refresh can render', async () => {
    const courseDir = await makeTempCourse();
    const closedRuntimeIds: number[] = [];
    let runtimeCount = 0;

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => {
        const runtimeId = ++runtimeCount;
        return {
          close: async () => {
            closedRuntimeIds.push(runtimeId);
          },
          render: async (input) => {
            if (runtimeId === 1) {
              throw new Error('preview runtime crashed');
            }

            return {
              diagnostics: [],
              ok: true,
              payload: {
                bodyHtml: `<p>Recovered on runtime ${runtimeId}</p>`,
                headHtml: '',
                variant: { seed: input.variantSeed ?? '1' },
              },
            };
          },
        };
      },
    });

    try {
      const baseUrl = serverUrl(started);
      const failed = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const failedHtml = await failed.text();

      assert.equal(failed.status, 500);
      assert.match(failedHtml, /preview runtime crashed/);
      assert.deepEqual(closedRuntimeIds, [1]);

      const refresh = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const refreshHtml = await refresh.text();

      assert.equal(refresh.status, 200);
      assert.match(refreshHtml, /Recovered on runtime 2/);
      assert.equal(runtimeCount, 2);
    } finally {
      await started.close();
      assert.deepEqual(closedRuntimeIds, [1, 2]);
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('serves direct preview HTML rendered through the PrairieLearn runtime', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(courseDir, 'runtime/simple');
    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
    });

    try {
      const response = await fetch(`${serverUrl(started)}/questions/runtime/simple?variant=1`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(html, /^<!doctype html>/i);
      assert.match(html, /Runtime direct preview body/);
      assert.match(html, /class="question-container"/);
      nodeAssert.doesNotMatch(html, /New Variant|Question ID|Variant:/i);
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

    const started = await startQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--cache-type', 'memory', '--port', '0'],
    });

    try {
      const previewUrl = `${serverUrl(started)}/questions/${qid}?variant=1`;
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

      assert.equal(metadataRefresh.status, 422);
      assert.match(metadataRefreshBody, /Unsupported preview question type: MultipleChoice/);

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
