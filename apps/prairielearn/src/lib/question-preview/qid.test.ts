import { assert, describe, it } from 'vitest';

import {
  type QuestionPreviewQid,
  parseQuestionPreviewQid,
  questionPreviewQidFromPathSegments,
  questionPreviewQidValidationError,
} from './qid.js';

describe('question preview qid rule', () => {
  it('parses valid qids into decoded, path, and URL forms', () => {
    const parsed = parseQuestionPreviewQid('demo/question with spaces');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    assert.equal(parsed.qid.decoded, 'demo/question with spaces');
    assert.equal(parsed.qid.encodedPath, 'demo/question%20with%20spaces');
    assert.deepEqual(parsed.qid.pathSegments, ['demo', 'question with spaces']);

    const fromSegments = questionPreviewQidFromPathSegments(['demo', 'files', 'example']);
    assert.equal(fromSegments.ok, true);
    if (!fromSegments.ok) throw new Error(fromSegments.error.message);
    assert.equal(fromSegments.qid.decoded, 'demo/files/example');
    assert.equal(fromSegments.qid.encodedPath, 'demo/files/example');
    assert.deepEqual(fromSegments.qid.pathSegments, ['demo', 'files', 'example']);
  });

  it('accepts relative qids below the course questions directory', () => {
    for (const qid of ['demo/example', 'demo/question with spaces', 'demo/files/example']) {
      assert.equal(questionPreviewQidValidationError(qid), null);
    }
  });

  it('rejects qids that would escape or confuse the question namespace', () => {
    for (const qid of [
      '',
      '/demo/example',
      '../secret',
      'demo/../secret',
      'demo//example',
      'demo/./example',
      'demo\\example',
      'demo\0example',
    ]) {
      assert.deepEqual(questionPreviewQidValidationError(qid), {
        message:
          'Invalid question id. Expected a relative qid below the course questions directory.',
        qid,
      });
      assert.deepEqual(parseQuestionPreviewQid(qid), {
        error: {
          message:
            'Invalid question id. Expected a relative qid below the course questions directory.',
          qid,
        },
        ok: false,
      });
    }
  });

  it('requires parsed qids at compile time', () => {
    // @ts-expect-error Preview qids must come from the parser functions.
    const fabricatedQid: QuestionPreviewQid = {
      decoded: '../secret',
      encodedPath: '../secret',
      pathSegments: ['..', 'secret'],
    };

    assert.equal(fabricatedQid.decoded, '../secret');
  });

  it('prevents parsed qids from being mutated at compile time', () => {
    function mutateQid(qid: QuestionPreviewQid) {
      // @ts-expect-error Parsed preview qids must preserve their decoded invariant.
      qid.decoded = '../secret';
      // @ts-expect-error Parsed preview qids must preserve their encoded path invariant.
      qid.encodedPath = '../secret';
      // @ts-expect-error Parsed preview qids must preserve their path segment invariant.
      qid.pathSegments = ['..', 'secret'];
    }

    assert.isFunction(mutateQid);
  });

  it('returns frozen parsed qids', () => {
    const parsed = parseQuestionPreviewQid('demo/question');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error(parsed.error.message);

    assert.equal(Object.isFrozen(parsed.qid), true);
    assert.equal(Object.isFrozen(parsed.qid.pathSegments), true);
    assert.equal(Reflect.set(parsed.qid, 'decoded', '../secret'), false);
    assert.equal(Reflect.set(parsed.qid, 'pathSegments', ['..', 'secret']), false);
    assert.equal(parsed.qid.decoded, 'demo/question');
    assert.deepEqual(parsed.qid.pathSegments, ['demo', 'question']);
  });
});
