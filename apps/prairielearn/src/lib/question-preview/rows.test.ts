import { assert, describe, it } from 'vitest';

import { QuestionJsonSchema } from '../../schemas/index.js';

import type { LocalPreviewCourseSource } from './course-source.js';
import { parseQuestionPreviewQid } from './qid.js';
import {
  makeLocalPreviewQuestionRows,
  makeLocalPreviewSubmission,
  makeLocalPreviewVariant,
  makePreviewWorkspaceSettings,
} from './rows.js';

function parseQid(qid: string) {
  const result = parseQuestionPreviewQid(qid);
  if (!result.ok) throw new Error(result.error.message);
  return result.qid;
}

describe('local preview rows', () => {
  it('constructs synthetic Course, Question, and QuestionCaller rows from parsed question metadata', () => {
    const courseSource: LocalPreviewCourseSource = {
      courseDir: '/course',
      courseMetadata: {
        name: 'TST 101',
        options: { questionsReceiveUserData: true },
        timezone: 'America/Chicago',
        title: 'Renderer-visible course',
      },
      readQuestionInfo: async () => {
        throw new Error('not used by this row test');
      },
      readTemplateInfo: async () => {
        throw new Error('not used by this row test');
      },
      resolveFile: async () => null,
    };
    const { caller, course, question } = makeLocalPreviewQuestionRows({
      courseSource,
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
    assert.equal(course.short_name, 'TST 101');
    assert.equal(course.title, 'Renderer-visible course');
    assert.equal(course.display_timezone, 'America/Chicago');
    assert.deepEqual(course.options, { questionsReceiveUserData: true });
    assert.equal(course.questions_receive_user_data, true);
    assert.deepEqual(caller, {
      groupId: null,
      userId: null,
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

  it('derives workspace settings from question metadata', () => {
    const info = QuestionJsonSchema.parse({
      title: 'Workspace settings question',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111151',
      workspaceOptions: {
        args: ['--port', '8080'],
        gradedFiles: ['starter.py'],
        image: 'workspace-image',
        port: 8080,
        rewriteUrl: false,
      },
    });

    assert.deepEqual(makePreviewWorkspaceSettings(info), {
      args: '--port 8080',
      enableNetworking: false,
      environment: {},
      gradedFiles: ['starter.py'],
      home: null,
      image: 'workspace-image',
      port: 8080,
      rewriteUrl: false,
    });
  });

  it('returns null workspace settings for questions without a workspace', () => {
    const info = QuestionJsonSchema.parse({
      title: 'Plain question',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111152',
    });

    assert.isNull(makePreviewWorkspaceSettings(info));
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

  it('constructs synthetic graded Submission rows linked to their variant', () => {
    const variant = makeLocalPreviewVariant(
      'abc',
      {
        broken: false,
        options: {},
        params: { value: 1 },
        preferences: {},
        true_answer: { value: 2 },
      },
      { id: 'preview-variant' },
    );

    const submission = makeLocalPreviewSubmission(
      variant,
      {
        broken: false,
        feedback: { note: 'good' },
        format_errors: {},
        gradable: true,
        params: { value: 1 },
        partial_scores: { ans: { score: 1, weight: 1 } },
        raw_submitted_answer: { ans: '2' },
        score: 1,
        submitted_answer: { ans: 2 },
        true_answer: { value: 2 },
      },
      { id: 'preview-submission' },
    );

    assert.equal(submission.id, 'preview-submission');
    assert.equal(submission.variant_id, 'preview-variant');
    assert.equal(submission.auth_user_id, '1');
    assert.equal(submission.score, 1);
    assert.equal(submission.correct, true);
    assert.instanceOf(submission.graded_at, Date);
    assert.equal(submission.gradable, true);
    assert.deepEqual(submission.feedback, { note: 'good' });
    assert.deepEqual(submission.partial_scores, { ans: { score: 1, weight: 1 } });
    assert.deepEqual(submission.raw_submitted_answer, { ans: '2' });
    assert.deepEqual(submission.submitted_answer, { ans: 2 });
    assert.deepEqual(submission.true_answer, { value: 2 });
    assert.equal(submission.v2_score, null);
    assert.equal(submission.credit, null);
    assert.equal(submission.mode, null);
  });

  it('constructs ungraded Submission rows without graded_at or correctness', () => {
    const variant = makeLocalPreviewVariant('abc', {
      broken: false,
      options: {},
      params: {},
      preferences: {},
      true_answer: {},
    });

    const submission = makeLocalPreviewSubmission(variant, {
      broken: false,
      feedback: {},
      format_errors: { ans: 'Invalid format.' },
      gradable: false,
      params: {},
      partial_scores: null,
      raw_submitted_answer: { ans: 'banana' },
      score: null,
      submitted_answer: { ans: 'banana' },
      true_answer: {},
    });

    assert.equal(submission.id, '1');
    assert.equal(submission.variant_id, '1');
    assert.equal(submission.score, null);
    assert.equal(submission.correct, null);
    assert.equal(submission.graded_at, null);
    assert.equal(submission.gradable, false);
    assert.deepEqual(submission.format_errors, { ans: 'Invalid format.' });
    assert.equal(submission.partial_scores, null);
  });

  it('marks partial-credit Submission rows as not correct', () => {
    const variant = makeLocalPreviewVariant('abc', {
      broken: false,
      options: {},
      params: {},
      preferences: {},
      true_answer: {},
    });

    const submission = makeLocalPreviewSubmission(variant, {
      broken: false,
      feedback: {},
      format_errors: {},
      gradable: true,
      params: {},
      partial_scores: {},
      raw_submitted_answer: {},
      score: 0.5,
      submitted_answer: {},
      true_answer: {},
    });

    assert.equal(submission.correct, false);
    assert.instanceOf(submission.graded_at, Date);
  });
});
