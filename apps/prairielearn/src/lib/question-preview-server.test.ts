import fs from 'node:fs/promises';
import nodeAssert from 'node:assert/strict';
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

describe('question preview server startup', () => {
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

describe('question preview server direct preview route', () => {
  it('redirects missing variants and renders a full HTML document for direct question URLs', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: Array<{ qid: string; variantSeed?: string }> = [];
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

  it('keeps the warm runtime after expected direct preview failures', async () => {
    const courseDir = await makeTempCourse();
    const renderCalls: Array<{ qid: string; runtimeId: number; variantSeed?: string }> = [];
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
