import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { createLocalPreviewCourseSource } from './course-source.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { type QuestionPreviewQid, parseQuestionPreviewQid } from './qid.js';
import {
  createQuestionPreviewEngine,
  createQuestionPreviewRuntime,
  renderQuestionPreview,
} from './render.js';
import { LocalPreviewSubmissionFiles } from './submission-files.js';

async function makeTempCourse() {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-render-'));
  await fs.writeFile(
    path.join(courseDir, 'infoCourse.json'),
    JSON.stringify({
      name: 'TST 101',
      title: 'Question preview tests',
      topics: [{ color: 'blue1', name: 'Testing' }],
    }),
  );
  await fs.mkdir(path.join(courseDir, 'questions'));
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

async function writeQuestionInfo(courseDir: string, qid: string, info: Record<string, unknown>) {
  await writeQuestionFile(courseDir, qid, 'info.json', JSON.stringify(info));
}

function assertGenericFailureDocument(documentHtml: string) {
  assert.match(documentHtml, /^<!doctype html>/i);
  assert.match(documentHtml, /Question preview failed/);
  assert.match(documentHtml, /preview server console/);
}

function parsePreviewQid(qid: string): QuestionPreviewQid {
  const result = parseQuestionPreviewQid(qid);
  if (!result.ok) throw new Error(result.error.message);
  return result.qid;
}

describe('question preview renderer', () => {
  it('renders two courses concurrently through one independently closeable engine', async () => {
    const firstCourseDir = await makeTempCourse();
    const secondCourseDir = await makeTempCourse();
    await writeQuestionInfo(firstCourseDir, 'demo/shared', {
      title: 'First course question',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111170',
    });
    await writeQuestionFile(
      firstCourseDir,
      'demo/shared',
      'question.html',
      '<p>First course body</p>',
    );
    await writeQuestionInfo(secondCourseDir, 'demo/shared', {
      title: 'Second course question',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111171',
    });
    await writeQuestionFile(
      secondCourseDir,
      'demo/shared',
      'question.html',
      '<p>Second course body</p>',
    );
    const startupLogs: string[] = [];
    const engine = await createQuestionPreviewEngine({
      startupLogger: (message) => startupLogs.push(message),
      workersCount: 2,
      workersExecutionMode: 'native',
    });
    const makeRenderer = async (courseDir: string) =>
      engine.createCourseRenderer({
        courseSource: await createLocalPreviewCourseSource(courseDir),
        localPreviewGeneratedFiles: new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' }),
        localPreviewSubmissionFiles: new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' }),
        urlPrefix: '/preview',
      });
    const firstRenderer = await makeRenderer(firstCourseDir);
    const secondRenderer = await makeRenderer(secondCourseDir);
    const qid = parsePreviewQid('demo/shared');

    try {
      const [first, second] = await Promise.all([
        firstRenderer.render({ qid }),
        secondRenderer.render({ qid }),
      ]);
      assert.match(first.documentHtml, /First course body/);
      assert.match(second.documentHtml, /Second course body/);
      assert.equal(
        startupLogs.filter((message) => message === 'PrairieLearn runtime initialized.').length,
        1,
      );

      await firstRenderer.close();
      const secondAfterFirstClosed = await secondRenderer.render({ qid });
      assert.match(secondAfterFirstClosed.documentHtml, /Second course body/);
    } finally {
      await firstRenderer.close();
      await secondRenderer.close();
      await engine.close();
      await fs.rm(firstCourseDir, { force: true, recursive: true });
      await fs.rm(secondCourseDir, { force: true, recursive: true });
    }
  });

  it('renders valid raw qids through one-shot runtime startup', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'demo/preview', {
      title: 'Preview test',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    await writeQuestionFile(courseDir, 'demo/preview', 'question.html', '<p>Rendered preview</p>');
    const startupLogs: string[] = [];

    try {
      const result = await renderQuestionPreview({
        courseDir,
        qid: 'demo/preview',
        startupLogger: (message) => startupLogs.push(message),
        urlPrefix: '/preview',
        variantSeed: '123',
        workersExecutionMode: 'native',
      });

      assert.equal(result.ok, true);
      assert.include(startupLogs, 'Preparing question preview renderer.');
      assert.deepEqual(Object.keys(result).sort(), ['diagnostics', 'documentHtml', 'ok']);
      assert.match(result.documentHtml, /^<!doctype html>/i);
      assert.match(result.documentHtml, /document\.urlPrefix = '\/preview'/);
      assert.match(result.documentHtml, /Rendered preview/);
      assert.equal('payload' in result, false);
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics for invalid qids without debug details in the document', async () => {
    const result = await renderQuestionPreview({
      courseDir: '/tmp/pl-preview-render-test-course',
      qid: '../secret',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assertGenericFailureDocument(result.documentHtml);
    assert.notMatch(result.documentHtml, /Invalid question id/);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].name, 'Error');
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'input');
    assert.match(result.diagnostics[0].message, /Invalid question id/);
    assert.equal('stack' in result.diagnostics[0], false);
    assert.equal(
      JSON.stringify(result.diagnostics[0]).includes('/tmp/pl-preview-render-test-course'),
      false,
    );
  });

  it('uses startup-scoped courseDir and urlPrefix for initialized runtimes', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'startup/scoped', {
      title: 'Startup scoped',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111116',
    });
    await writeQuestionFile(courseDir, 'startup/scoped', 'question.html', '<p>Startup scoped</p>');

    const runtime = await createQuestionPreviewRuntime({
      courseDir,
      urlPrefix: '/startup-preview',
      workersExecutionMode: 'native',
    });

    try {
      const success = await runtime.render({
        qid: parsePreviewQid('startup/scoped'),
        variantSeed: '1',
      });

      assert.equal(success.ok, true);
      assert.deepEqual(Object.keys(success).sort(), ['diagnostics', 'documentHtml', 'ok']);
      assert.match(success.documentHtml, /^<!doctype html>/i);
      assert.match(success.documentHtml, /Startup scoped/);
      assert.match(success.documentHtml, /document\.urlPrefix = '\/startup-preview'/);
      assert.match(success.documentHtml, /\/assets\//);
      assert.equal('payload' in success, false);
      assert.equal('assessment' in success, false);
      assert.equal('submission' in success, false);
      assert.equal('submittedAnswer' in success, false);
      assert.equal('savedAnswer' in success, false);
      assert.equal('answerHtml' in success, false);
      assert.equal('submissionHtmls' in success, false);
      assert.equal('correctAnswerHtml' in success, false);
      assert.equal('port' in success, false);
      assert.equal('assetServer' in success, false);
    } finally {
      await runtime.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('passes the render mode through to the document renderer', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'startup/question-only', {
      title: 'Question only',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111117',
    });
    await writeQuestionFile(
      courseDir,
      'startup/question-only',
      'question.html',
      '<p>Question only</p>',
    );

    const runtime = await createQuestionPreviewRuntime({
      courseDir,
      renderMode: 'question-only',
      urlPrefix: '/preview',
      workersExecutionMode: 'native',
    });

    try {
      const result = await runtime.render({
        qid: parsePreviewQid('startup/question-only'),
        variantSeed: '1',
      });

      assert.equal(result.ok, true);
      assert.match(result.documentHtml, /Question only/);
      assert.notMatch(result.documentHtml, /question-form/);
    } finally {
      await runtime.close();
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid one-shot qids before runtime startup options are applied', async () => {
    const result = await renderQuestionPreview({
      courseDir: '/tmp/pl-preview-render-test-course',
      qid: '../secret',
      // @ts-expect-error Testing that invalid qids return before startup options are applied.
      workersExecutionMode: 'disabled',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assertGenericFailureDocument(result.documentHtml);
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'input');
    assert.match(result.diagnostics[0].message, /Invalid question id/);
  });
});
