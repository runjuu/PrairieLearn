import { assert, describe, it } from 'vitest';

import { QuestionJsonSchema } from '../../schemas/index.js';

import { parseQuestionPreviewQid } from './qid.js';
import { makeLocalPreviewQuestionRows, makeLocalPreviewVariant } from './rows.js';

function parseQid(qid: string) {
  const result = parseQuestionPreviewQid(qid);
  if (!result.ok) throw new Error(result.error.message);
  return result.qid;
}

describe('local preview rows', () => {
  it('constructs synthetic Course, Question, and QuestionCaller rows from parsed question metadata', () => {
    const { caller, course, question } = makeLocalPreviewQuestionRows({
      courseDir: '/course',
      info: QuestionJsonSchema.parse({
        externalGradingOptions: {
          entrypoint: ['python3', 'grade.py'],
          image: 'python:3',
        },
        partialCredit: false,
        title: 'Preview row question',
        topic: 'Testing',
        type: 'v3',
        uuid: '11111111-1111-4111-8111-111111111150',
        workspaceOptions: {
          args: ['--port', '8080'],
          home: '/workspace',
          image: 'workspace-image',
          port: 8080,
        },
      }),
      qid: parseQid('demo/rows'),
    });

    assert.equal(course.id, '1');
    assert.equal(course.path, '/course');
    assert.equal(course.short_name, 'preview-render');
    assert.deepEqual(caller, {
      effectiveUserId: null,
      groupId: null,
      variantCourse: { id: course.id },
    });
    assert.equal(question.id, '1');
    assert.equal(question.course_id, course.id);
    assert.equal(question.directory, 'demo/rows');
    assert.equal(question.qid, 'demo/rows');
    assert.equal(question.type, 'Freeform');
    assert.equal(question.partial_credit, false);
    assert.equal(question.external_grading_entrypoint, 'python3 grade.py');
    assert.equal(question.workspace_args, '--port 8080');
  });

  it('constructs synthetic Variant rows with generated-file variant identities', () => {
    const variant = makeLocalPreviewVariant(
      'abc',
      {
        broken: true,
        options: { source: 'prepare' },
        params: { value: 1 },
        preferences: { mode: 'fast' },
        true_answer: { value: 2 },
      },
      { id: 'preview-variant' },
    );

    assert.equal(variant.id, 'preview-variant');
    assert.equal(variant.course_id, '1');
    assert.equal(variant.question_id, '1');
    assert.equal(variant.user_id, '1');
    assert.equal(variant.variant_seed, 'abc');
    assert.equal(variant.broken, true);
    assert.equal(variant.broken_by, '1');
    assert.deepEqual(variant.options, { source: 'prepare' });
    assert.deepEqual(variant.params, { value: 1 });
    assert.deepEqual(variant.preferences, { mode: 'fast' });
    assert.deepEqual(variant.true_answer, { value: 2 });
  });
});
