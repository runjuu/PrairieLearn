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

async function writeQuestion(courseDir: string, qid: string) {
  await writeQuestionFile(
    courseDir,
    qid,
    'info.json',
    JSON.stringify({
      title: 'Runtime direct preview',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111124',
    }),
  );
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
});
