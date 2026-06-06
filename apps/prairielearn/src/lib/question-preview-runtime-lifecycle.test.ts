import nodeAssert from 'node:assert/strict';

import { assert, describe, it } from 'vitest';

import type { QuestionPreviewDiagnostic } from './question-preview-document.js';
import { type QuestionPreviewQid, parseQuestionPreviewQid } from './question-preview-qid.js';
import {
  type QuestionPreviewRuntimeFactory,
  createQuestionPreviewRuntimeLifecycle,
} from './question-preview-runtime-lifecycle.js';

function testSuccessDocument(bodyHtml: string) {
  return {
    diagnostics: [],
    documentHtml: `<!doctype html><html><body>${bodyHtml}</body></html>`,
    ok: true as const,
  };
}

function testFailureDocument(diagnostics: QuestionPreviewDiagnostic[] = []) {
  return {
    diagnostics,
    documentHtml: '<!doctype html><html><body>Question preview failed</body></html>',
    ok: false as const,
  };
}

function parsePreviewQid(qid: string): QuestionPreviewQid {
  const result = parseQuestionPreviewQid(qid);
  if (!result.ok) throw new Error(result.error.message);
  return result.qid;
}

describe('question preview runtime lifecycle', () => {
  it('replaces the runtime after infrastructure failures', async () => {
    const closedRuntimeIds: number[] = [];
    const runtimeOptions: Parameters<QuestionPreviewRuntimeFactory>[0][] = [];
    let runtimeCount = 0;

    const createRuntime: QuestionPreviewRuntimeFactory = async (options) => {
      runtimeOptions.push(options);
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
    };

    const lifecycle = await createQuestionPreviewRuntimeLifecycle({
      createRuntime,
      runtimeOptions: { courseDir: '/course' },
    });

    await nodeAssert.rejects(
      () => lifecycle.render({ qid: parsePreviewQid('demo/example'), variantSeed: '1' }),
      /preview runtime crashed/,
    );
    assert.deepEqual(closedRuntimeIds, [1]);
    assert.equal(
      runtimeOptions[0]?.localPreviewGeneratedFiles,
      lifecycle.localPreviewGeneratedFiles,
    );
    assert.equal(runtimeOptions[0]?.prewarmWorkers, true);
    assert.equal(runtimeOptions[0]?.urlPrefix, lifecycle.urlPrefix);

    const recovered = await lifecycle.render({
      qid: parsePreviewQid('demo/example'),
      variantSeed: '1',
    });

    assert.equal(recovered.ok, true);
    assert.match(recovered.documentHtml, /Recovered on runtime 2/);
    assert.equal(runtimeCount, 2);
    assert.equal(
      runtimeOptions[1]?.localPreviewGeneratedFiles,
      lifecycle.localPreviewGeneratedFiles,
    );
    assert.equal(runtimeOptions[1]?.urlPrefix, lifecycle.urlPrefix);
    assert.equal(
      lifecycle.localPreviewGeneratedFiles.routePattern,
      `${lifecycle.urlPrefix}/generatedFilesQuestion/variant/*`,
    );

    await lifecycle.close();
    assert.deepEqual(closedRuntimeIds, [1, 2]);
  });

  it('keeps the runtime after expected render failures', async () => {
    let renderCalls = 0;
    let closeCalls = 0;

    const lifecycle = await createQuestionPreviewRuntimeLifecycle({
      createRuntime: async () => ({
        close: async () => {
          closeCalls++;
        },
        render: async () => {
          renderCalls++;
          if (renderCalls === 1) {
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
      }),
      runtimeOptions: { courseDir: '/course' },
    });

    const expectedFailure = await lifecycle.render({
      qid: parsePreviewQid('demo/example'),
      variantSeed: '1',
    });
    const refresh = await lifecycle.render({
      qid: parsePreviewQid('demo/example'),
      variantSeed: '1',
    });

    assert.equal(expectedFailure.ok, false);
    assert.equal(refresh.ok, true);
    assert.equal(renderCalls, 2);
    assert.equal(closeCalls, 0);

    await lifecycle.close();
    assert.equal(closeCalls, 1);
  });
});
