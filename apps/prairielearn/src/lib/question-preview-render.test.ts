import { assert, describe, it } from 'vitest';

import { QuestionJsonSchema } from '../schemas/index.js';

import {
  makeQuestionPreviewSuccessEnvelope,
  makePreviewLocals,
  makePreviewQuestion,
  makePreviewVariant,
  renderQuestionPreviewBodyHtml,
} from './question-preview-render.js';

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
});
