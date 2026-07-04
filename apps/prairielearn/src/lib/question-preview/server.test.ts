import nodeAssert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it, vi } from 'vitest';

import type { QuestionPreviewDiagnostic } from './document.js';
import { createQuestionPreviewRuntime } from './render.js';
import { parseQuestionPreviewServerOptions, startQuestionPreviewServer } from './server.js';

type StartQuestionPreviewServerParams = Parameters<typeof startQuestionPreviewServer>[0];
type StartTestQuestionPreviewServerParams = Omit<
  StartQuestionPreviewServerParams,
  'createRuntime'
> &
  Partial<Pick<StartQuestionPreviewServerParams, 'createRuntime'>>;

function startTestQuestionPreviewServer({
  createRuntime = createQuestionPreviewRuntime,
  ...params
}: StartTestQuestionPreviewServerParams) {
  return startQuestionPreviewServer({ ...params, createRuntime });
}

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
  };
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
        courseDir: path.resolve(courseDir),
        devMode: false,
        host: '127.0.0.1',
        port: 4310,
        questionTimeoutMilliseconds: 5000,
        workersCount: 1,
        workersExecutionMode: 'container',
      });

      const explicitOptions = await parseQuestionPreviewServerOptions([
        '--course-dir',
        courseDir,
        '--cache-type',
        'memory',
        '--dev-mode',
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--question-timeout-ms',
        '1',
        '--workers-count',
        '4',
        '--workers-execution-mode',
        'native',
      ]);

      assert.deepEqual(explicitOptions, {
        cacheType: 'memory',
        courseDir: path.resolve(courseDir),
        devMode: true,
        host: '0.0.0.0',
        port: 0,
        questionTimeoutMilliseconds: 1,
        workersCount: 4,
        workersExecutionMode: 'native',
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
        message: /Invalid --cache-type/,
      },
      {
        argv: ['--course-dir', courseDir, '--workers-execution-mode', 'disabled'],
        message: /Invalid --workers-execution-mode/,
      },
      { argv: ['--course-dir', missingCourseDir], message: /Invalid --course-dir/ },
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

  it('requires an explicit valid course directory and prewarms before readiness', async () => {
    const courseDir = await makeTempCourse();
    const missingCourseDir = path.join(os.tmpdir(), 'pl-preview-server-missing-course');
    const events: string[] = [];

    await nodeAssert.rejects(
      () =>
        startTestQuestionPreviewServer({
          argv: [],
          createRuntime: async () => {
            events.push('runtime');
            return {
              close: async () => {},
              render: async () => testFailureDocument(),
            };
          },
        }),
      /--course-dir/,
    );
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
      /Invalid --course-dir/,
    );
    assert.deepEqual(events, []);

    const defaultOptions = await parseQuestionPreviewServerOptions(['--course-dir', courseDir]);
    assert.equal(defaultOptions.host, '127.0.0.1');
    assert.equal(defaultOptions.port, 4310);

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
      assert.equal(started.options.courseDir, path.resolve(courseDir));
      assert.deepEqual(events, [`runtime:${path.resolve(courseDir)}:true`, 'ready']);
    } finally {
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('reports startup progress when a startup logger is provided', async () => {
    const courseDir = await makeTempCourse();
    const logs: string[] = [];
    const startupLogger = (message: string) => logs.push(message);
    const runtimeOptions: Parameters<StartQuestionPreviewServerParams['createRuntime']>[0][] = [];

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
      assert.deepEqual(logs, [
        'Reading preview server options.',
        `Validated course directory: ${path.resolve(courseDir)}.`,
        'Initializing preview runtime.',
        'Preparing preview asset routes.',
        'Starting HTTP server on 127.0.0.1:0.',
      ]);
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

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
      }),
    });

    try {
      const baseUrl = serverUrl(started);
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

  it('returns not found for missing core assets without falling through to preview rendering', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: string[] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
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
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
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

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () => testFailureDocument(),
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
      argv: ['--course-dir', courseDir, '--port', '0'],
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
      assert.equal(symlinkedAsset.status, 200);
      assert.match(symlinkedAsset.body, /outside secret/);
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
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
    });

    try {
      const baseUrl = serverUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/data\.txt)"/,
      );

      assert.equal(first.status, 200);
      nodeAssert.doesNotMatch(firstHtml, /generatedFilesQuestion\/render\//);
      assert.isNotNull(firstMatch);
      const firstPath = firstMatch.groups?.path ?? '';
      const firstVariantId = firstMatch.groups?.variantId ?? '';

      const firstFile = await fetch(`${baseUrl}${firstPath}`);
      assert.equal(firstFile.status, 200);
      assert.equal(await firstFile.text(), 'generated file for seed 1');

      const postFile = await fetch(`${baseUrl}${firstPath}`, { method: 'POST' });
      assert.equal(postFile.status, 405);

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/data\.txt)"/,
      );

      assert.equal(second.status, 200);
      assert.isNotNull(secondMatch);
      const secondPath = secondMatch.groups?.path ?? '';
      const secondVariantId = secondMatch.groups?.variantId ?? '';
      assert.notEqual(firstVariantId, secondVariantId);

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
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
    });

    try {
      const baseUrl = serverUrl(started);
      const response = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const html = await response.text();
      const match = html.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
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

      const generatedFile = await fetch(`${baseUrl}${generatedFilePath}`);

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
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
      localPreviewGeneratedFilesMax: 1,
    });

    try {
      const baseUrl = serverUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
      );
      assert.equal(first.status, 200);
      assert.isNotNull(firstMatch);
      const firstPath = firstMatch.groups?.path ?? '';

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
      );
      assert.equal(second.status, 200);
      assert.isNotNull(secondMatch);
      const secondPath = secondMatch.groups?.path ?? '';
      assert.notEqual(firstPath, secondPath);

      const evictedFile = await fetch(`${baseUrl}${firstPath}`);
      assert.equal(evictedFile.status, 404);

      const retainedFile = await fetch(`${baseUrl}${secondPath}`);
      assert.equal(retainedFile.status, 200);
      assert.equal(await retainedFile.text(), 'generated file for seed 2');

      const refresh = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const refreshHtml = await refresh.text();
      const refreshMatch = refreshHtml.match(
        /href="(?<path>\/preview-render\/generatedFilesQuestion\/variant\/[^/"?#]+\/data\.txt)"/,
      );
      assert.equal(refresh.status, 200);
      assert.isNotNull(refreshMatch);
      const refreshPath = refreshMatch.groups?.path ?? '';
      assert.notEqual(refreshPath, firstPath);

      const refreshedFile = await fetch(`${baseUrl}${refreshPath}`);
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
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
    });

    try {
      const baseUrl = serverUrl(started);
      const first = await fetch(`${baseUrl}/questions/${qid}?variant=1`);
      const firstHtml = await first.text();
      const firstMatch = firstHtml.match(
        /href="\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/first\.txt"/,
      );
      assert.equal(first.status, 200);
      assert.isNotNull(firstMatch);
      const firstVariantId = firstMatch.groups?.variantId ?? '';

      const second = await fetch(`${baseUrl}/questions/${qid}?variant=2`);
      const secondHtml = await second.text();
      const secondMatch = secondHtml.match(
        /href="\/preview-render\/generatedFilesQuestion\/variant\/(?<variantId>[^/"?#]+)\/second\.txt"/,
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
  it('defaults missing variants and renders a full HTML document for direct question URLs', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: { qid: string; variantSeed?: string }[] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
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
      const baseUrl = serverUrl(started);
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
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async () =>
          testSuccessDocument('<section><p>Only rendered question content</p></section>'),
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
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
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

  it('checks posted answers through the runtime with metadata fields stripped', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
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
      const response = await fetch(`${serverUrl(started)}/questions/demo/example?variant=2`, {
        body: new URLSearchParams({
          __action: 'grade',
          __csrf_token: 'ignored-token',
          __variant_id: '9',
          ans: '42',
        }),
        method: 'POST',
      });
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

  it('rejects posted answers without a grade action before invoking the runtime', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => ({
        close: async () => {},
        render: async (input) => {
          renderCalls.push(input);
          return testSuccessDocument('<p>Runtime rendered rejected action</p>');
        },
      }),
    });

    try {
      const baseUrl = serverUrl(started);
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

  it('returns generic HTML errors for posted answers on failed renders and invalid qids', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
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
      const baseUrl = serverUrl(started);
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
      argv: ['--course-dir', courseDir, '--port', '0'],
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
      const response = await fetch(`${serverUrl(started)}/questions/demo/example?variant=1`, {
        headers: { accept: 'application/json' },
      });
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
      argv: ['--course-dir', courseDir, '--port', '0'],
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
        '/questions/%2e%2e/secret?variant=1',
      ]) {
        const response = await requestRawPath(started, invalidPath);

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
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
    });

    try {
      for (const invalidPath of [
        '/questions/demo%5Cexample?variant=1',
        '/questions/%2e%2e/secret?variant=1',
      ]) {
        const response = await requestRawPath(started, invalidPath);

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

  it('keeps the warm runtime after expected direct preview failures', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: { qid: string; runtimeId: number; variantSeed?: string }[] = [];
    let runtimeCount = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
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
      const baseUrl = serverUrl(started);
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

  it('replaces the runtime after infrastructure failures so a later refresh can render', async () => {
    const courseDir = await makeTempCourse();
    const closedRuntimeIds: number[] = [];
    let runtimeCount = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0'],
      createRuntime: async () => {
        const runtimeId = ++runtimeCount;
        return {
          close: async () => {
            closedRuntimeIds.push(runtimeId);
          },
          render: async () => {
            if (runtimeId === 1) {
              throw new Error('preview runtime crashed');
            }

            return testSuccessDocument(`<p>Recovered on runtime ${runtimeId}</p>`);
          },
        };
      },
    });

    try {
      const baseUrl = serverUrl(started);
      const failed = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const failedHtml = await failed.text();

      assert.equal(failed.status, 500);
      assert.match(failedHtml, /Question preview failed/);
      nodeAssert.doesNotMatch(failedHtml, /preview runtime crashed/);
      assert.equal(consoleError.mock.calls.length, 1);
      assert.equal(consoleError.mock.calls[0]?.[0], 'Question preview request failed:');
      assert.include(String(consoleError.mock.calls[0]?.[1]), 'preview runtime crashed');
      assert.deepEqual(closedRuntimeIds, [1]);

      const refresh = await fetch(`${baseUrl}/questions/demo/example?variant=1`);
      const refreshHtml = await refresh.text();

      assert.equal(refresh.status, 200);
      assert.match(refreshHtml, /Recovered on runtime 2/);
      assert.equal(runtimeCount, 2);
    } finally {
      consoleError.mockRestore();
      await started.close();
      assert.deepEqual(closedRuntimeIds, [1, 2]);
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('serves direct preview HTML rendered through the PrairieLearn runtime', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(courseDir, 'runtime/simple');
    const started = await startTestQuestionPreviewServer({
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
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
      argv: ['--course-dir', courseDir, '--port', '0', '--workers-execution-mode', 'native'],
    });

    try {
      const previewUrl = `${serverUrl(started)}/questions/${qid}?variant=1`;

      const correct = await fetch(previewUrl, {
        body: new URLSearchParams({ __action: 'grade', ans: '2' }),
        method: 'POST',
      });
      const correctHtml = await correct.text();

      assert.equal(correct.status, 200);
      assert.match(correctHtml, /data-testid="submission-block"/);
      assert.match(correctHtml, /text-bg-success/);
      assert.match(correctHtml, /100%/);

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
      assert.match(refreshedHtml, /Check answer/);
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

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const started = await startTestQuestionPreviewServer({
      argv: [
        '--course-dir',
        courseDir,
        '--cache-type',
        'memory',
        '--port',
        '0',
        '--workers-execution-mode',
        'native',
      ],
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
      assert.match(metadataRefreshBody, /Question preview failed/);
      nodeAssert.doesNotMatch(
        metadataRefreshBody,
        /Unsupported preview question type: MultipleChoice/,
      );
      assert.isAtLeast(consoleError.mock.calls.length, 1);

      await writeInfo('v3');
      await writeServer('server edit two');

      const serverRefresh = await fetch(previewUrl);
      const serverRefreshBody = await serverRefresh.text();

      assert.equal(serverRefresh.status, 200);
      assert.match(serverRefreshBody, /HTML edit two/);
      assert.match(serverRefreshBody, /server edit two/);
      nodeAssert.doesNotMatch(serverRefreshBody, /server edit one/);
    } finally {
      consoleError.mockRestore();
      await started.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});
