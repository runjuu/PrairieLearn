import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { type QuestionPreviewQid, parseQuestionPreviewQid } from './qid.js';
import { createQuestionPreviewRuntime, renderQuestionPreview } from './render.js';

async function makeTempCourse() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-render-'));
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
