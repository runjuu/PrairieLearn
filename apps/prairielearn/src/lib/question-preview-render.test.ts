import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { QuestionJsonSchema } from '../schemas/index.js';

import {
  createQuestionPreviewRuntime,
  makeQuestionPreviewSuccessEnvelope,
  makePreviewLocals,
  makePreviewQuestion,
  makePreviewVariant,
  renderQuestionPreviewBodyHtml,
  renderQuestionPreview,
} from './question-preview-render.js';

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

describe('question preview renderer helpers', () => {
  it('maps v3 info.json data into a renderable Freeform question', () => {
    const info = QuestionJsonSchema.parse({
      title: 'Preview test',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111111',
      workspaceOptions: {
        args: ['start', '--port', '8080'],
        gradedFiles: ['answer.py'],
        home: '/home/prairie',
        image: 'prairielearn/workspace-python',
        port: 8080,
      },
    });

    const question = makePreviewQuestion('demo/preview', info);

    assert.equal(question.type, 'Freeform');
    assert.equal(question.partial_credit, true);
    assert.equal(question.qid, 'demo/preview');
    assert.equal(question.workspace_args, 'start --port 8080');
    assert.deepEqual(question.workspace_graded_files, ['answer.py']);
  });

  it('creates preview render locals without assessment or submission routes', () => {
    const locals = makePreviewLocals('/preview');

    assert.equal(locals.questionUrl, '/preview/question/1/');
    assert.equal(locals.clientFilesCourseUrl, '/preview/clientFilesCourse');
    assert.equal(
      locals.clientFilesQuestionGeneratedFileUrl,
      '/preview/generatedFilesQuestion/variant/1',
    );
    assert.equal(locals.allowAnswerEditing, true);
    assert.equal(locals.showCorrectAnswer, false);
  });

  it('creates deterministic preview variant ids for render-only use', () => {
    const variant = makePreviewVariant('123', {
      broken: false,
      options: { a: 1 },
      params: { x: 2 },
      preferences: {},
      true_answer: { y: 3 },
    });

    assert.equal(variant.id, '1');
    assert.equal(variant.variant_seed, '123');
    assert.equal(variant.open, true);
    assert.equal(variant.num_tries, 0);
  });

  it('wraps rendered question HTML in the narrow preview body runtime wrapper', () => {
    const info = QuestionJsonSchema.parse({
      title: 'Preview test',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    const question = makePreviewQuestion('demo/preview', info);
    const variant = makePreviewVariant('123', {
      broken: false,
      options: {},
      params: {},
      preferences: {},
      true_answer: {},
    });

    const bodyHtml = renderQuestionPreviewBodyHtml({
      question,
      questionHtml: '<pl-number-input answers-name="x"></pl-number-input>',
      variant,
      variantToken: 'signed-token',
    });

    assert.match(bodyHtml, /class="question-container"/);
    assert.match(bodyHtml, /class="question-form"/);
    assert.match(bodyHtml, /class="[^"]*question-body[^"]*"/);
    assert.match(bodyHtml, /data-grading-method="Internal"/);
    assert.match(bodyHtml, /data-variant-id="1"/);
    assert.match(bodyHtml, /data-variant-token="signed-token"/);
    assert.notMatch(bodyHtml, /question-block/);
    assert.notMatch(bodyHtml, /card-header/);
    assert.match(bodyHtml, /<pl-number-input answers-name="x"><\/pl-number-input>/);
  });

  it('creates the successful Preview Render Payload envelope without exposing raw PL internals', () => {
    const envelope = makeQuestionPreviewSuccessEnvelope({
      bodyHtml: '<div class="question-container"></div>',
      diagnostics: [],
      headHtml: '<script src="/assets/build/question.js"></script>',
      variantSeed: '123',
    });

    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.diagnostics, []);
    assert.equal(envelope.payload.variant.seed, '123');
    assert.equal(envelope.payload.headHtml, '<script src="/assets/build/question.js"></script>');
    assert.equal(envelope.payload.bodyHtml, '<div class="question-container"></div>');
    assert.equal('questionHtml' in envelope.payload, false);
    assert.equal('extraHeadersHtml' in envelope.payload, false);
    assert.equal('dependencies' in envelope.payload, false);
    assert.equal('shell' in envelope.payload, false);
  });

  it('returns diagnostics for invalid qids without a browser payload or debug details', async () => {
    const result: any = await renderQuestionPreview({
      courseDir: '/tmp/pl-preview-render-test-course',
      qid: '../secret',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
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

  it('returns diagnostics only for fatal PrairieLearn prepare issues', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'broken/render', {
      title: 'Broken render',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111112',
    });

    const result: any = await renderQuestionPreview({
      courseDir,
      qid: 'broken/render',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].name, 'CourseIssueError');
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'prepare');
    assert.match(result.diagnostics[0].message, /question\.html/);
    assert.equal('stack' in result.diagnostics[0], false);
    assert.equal(JSON.stringify(result.diagnostics[0]).includes(courseDir), false);
  });

  it('returns diagnostics for unsupported non-Freeform question types', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'legacy/multiple-choice', {
      title: 'Legacy question',
      topic: 'Testing',
      type: 'MultipleChoice',
      uuid: '11111111-1111-4111-8111-111111111113',
    });

    const result: any = await renderQuestionPreview({
      courseDir,
      qid: 'legacy/multiple-choice',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'metadata');
    assert.match(
      result.diagnostics[0].message,
      /Unsupported preview question type: MultipleChoice/,
    );
  });

  it('returns diagnostics for missing question metadata', async () => {
    const courseDir = await makeTempCourse();

    const result: any = await renderQuestionPreview({
      courseDir,
      qid: 'missing/question',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'metadata');
    assert.match(result.diagnostics[0].message, /missing info\.json/);
    assert.equal(JSON.stringify(result.diagnostics[0]).includes(courseDir), false);
  });

  it('returns diagnostics for invalid question metadata', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'invalid/metadata', {
      title: 'Invalid metadata',
      topic: 'Testing',
      type: 'v3',
    });

    const result: any = await renderQuestionPreview({
      courseDir,
      qid: 'invalid/metadata',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'metadata');
    assert.match(result.diagnostics[0].message, /invalid info\.json metadata/);
    assert.equal(Array.isArray(result.diagnostics[0].data.issues), true);
    assert.equal('stack' in result.diagnostics[0], false);
  });

  it('returns diagnostics for invalid variant seeds', async () => {
    const result: any = await renderQuestionPreview({
      courseDir: '/tmp/pl-preview-render-test-course',
      qid: 'valid/qid',
      variantSeed: '!',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'input');
    assert.match(result.diagnostics[0].message, /Invalid variant seed/);
  });

  it('returns diagnostics only for fatal PrairieLearn generate issues', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'broken/generate', {
      title: 'Broken generate',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111114',
    });
    await writeQuestionFile(
      courseDir,
      'broken/generate',
      'question.html',
      '<p>Broken generate</p>',
    );
    await writeQuestionFile(
      courseDir,
      'broken/generate',
      'server.py',
      'def generate(data):\n    raise Exception("preview generate failed")\n',
    );

    const result: any = await renderQuestionPreview({
      courseDir,
      qid: 'broken/generate',
      variantSeed: '1',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assert.equal(result.diagnostics[0].name, 'CourseIssueError');
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'generate');
    assert.match(result.diagnostics[0].message, /server\.py/);
    assert.equal(JSON.stringify(result.diagnostics[0]).includes(courseDir), false);
  });

  it('returns successful payloads with diagnostics for nonfatal PrairieLearn issues', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'warning/generate', {
      title: 'Warning generate',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111115',
    });
    await writeQuestionFile(
      courseDir,
      'warning/generate',
      'question.html',
      '<p>Warning generate</p>',
    );
    await writeQuestionFile(
      courseDir,
      'warning/generate',
      'server.py',
      'def generate(data):\n    print("preview warning")\n',
    );

    const result: any = await renderQuestionPreview({
      courseDir,
      qid: 'warning/generate',
      variantSeed: '1',
    });

    assert.equal(result.ok, true);
    assert.equal(typeof result.payload.bodyHtml, 'string');
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].name, 'CourseIssueError');
    assert.equal(result.diagnostics[0].fatal, false);
    assert.equal(result.diagnostics[0].phase, 'generate');
    assert.match(result.diagnostics[0].message, /output logged on console/);
    assert.equal('stack' in result.diagnostics[0], false);
  });

  it('keeps courseDir and urlPrefix startup-scoped for initialized runtimes', async () => {
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
      const success: any = await runtime.render({
        qid: 'startup/scoped',
        variantSeed: '1',
      });

      assert.equal(success.ok, true);
      assert.deepEqual(Object.keys(success.payload).sort(), ['bodyHtml', 'headHtml', 'variant']);
      assert.match(success.payload.bodyHtml, /Startup scoped/);
      assert.match(success.payload.headHtml, /document\.urlPrefix = '\/startup-preview'/);
      assert.match(success.payload.headHtml, /\/assets\//);
      assert.notMatch(`${success.payload.headHtml}${success.payload.bodyHtml}`, /<!doctype/i);
      assert.notMatch(`${success.payload.headHtml}${success.payload.bodyHtml}`, /<html/i);
      assert.notMatch(`${success.payload.headHtml}${success.payload.bodyHtml}`, /<body/i);
      assert.equal('assessment' in success.payload, false);
      assert.equal('submission' in success.payload, false);
      assert.equal('submittedAnswer' in success.payload, false);
      assert.equal('savedAnswer' in success.payload, false);
      assert.equal('answerHtml' in success.payload, false);
      assert.equal('submissionHtmls' in success.payload, false);
      assert.equal('correctAnswerHtml' in success.payload, false);
      assert.equal('documentHtml' in success.payload, false);
      assert.equal('port' in success.payload, false);
      assert.equal('assetServer' in success.payload, false);

      const rejected: any = await runtime.render({
        courseDir: '/tmp/other-course',
        qid: 'startup/scoped',
        urlPrefix: '/other-preview',
        variantSeed: '1',
      } as any);

      assert.equal(rejected.ok, false);
      assert.equal('payload' in rejected, false);
      assert.equal(rejected.diagnostics[0].fatal, true);
      assert.equal(rejected.diagnostics[0].phase, 'input');
      assert.match(rejected.diagnostics[0].message, /Render requests cannot override/);
    } finally {
      await runtime.close();
    }
  });
});
