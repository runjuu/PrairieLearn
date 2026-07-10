import nodeAssert from 'node:assert/strict';

import { assert, describe, it } from 'vitest';

import type { LocalPreviewCourseSource } from './course-source.js';
import type { QuestionPreviewDocumentResult } from './document.js';
import {
  type QuestionPreviewEngineGenerationFactory,
  createQuestionPreviewEngineLifecycle,
} from './engine.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { parseQuestionPreviewQid } from './qid.js';
import { LocalPreviewSubmissionFiles } from './submission-files.js';

function makeCourseSource(name: string): LocalPreviewCourseSource {
  return {
    courseDir: `/courses/${name}`,
    courseMetadata: { name, options: {}, timezone: 'UTC', title: `${name} title` },
    readQuestionInfo: async () => {
      throw new Error('not used by the fake engine generation');
    },
    readTemplateInfo: async () => {
      throw new Error('not used by the fake engine generation');
    },
    resolveLegacyQuestionFile: async () => {
      throw new Error('not used by the fake engine generation');
    },
    resolveResource: async () => null,
    sanitizeDiagnosticValue: (value) => value,
  };
}

function makeRendererOptions(courseSource: LocalPreviewCourseSource) {
  return {
    courseSource,
    localPreviewGeneratedFiles: new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' }),
    localPreviewSubmissionFiles: new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' }),
    urlPrefix: '/preview',
  };
}

function success(documentHtml: string): QuestionPreviewDocumentResult {
  return { diagnostics: [], documentHtml, ok: true };
}

describe('question preview engine lifecycle', () => {
  it('shares one engine generation across independently closeable course renderers', async () => {
    let activeRenders = 0;
    let generationCloseCalls = 0;
    let generationCreates = 0;
    let maxActiveRenders = 0;
    const createGeneration: QuestionPreviewEngineGenerationFactory = async () => {
      generationCreates++;
      return {
        close: async () => {
          generationCloseCalls++;
        },
        render: async (options) => {
          activeRenders++;
          maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeRenders--;
          return success(options.courseSource.courseMetadata.name);
        },
      };
    };
    const engine = await createQuestionPreviewEngineLifecycle({ createGeneration });
    const first = engine.createCourseRenderer(makeRendererOptions(makeCourseSource('first')));
    const second = engine.createCourseRenderer(makeRendererOptions(makeCourseSource('second')));
    const qidResult = parseQuestionPreviewQid('demo/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    const [firstResult, secondResult] = await Promise.all([
      first.render({ qid: qidResult.qid }),
      second.render({ qid: qidResult.qid }),
    ]);
    assert.equal(firstResult.documentHtml, 'first');
    assert.equal(secondResult.documentHtml, 'second');
    assert.equal(maxActiveRenders, 2);
    assert.equal(generationCreates, 1);

    await first.close();
    await nodeAssert.rejects(first.render({ qid: qidResult.qid }), /course renderer is closed/);
    assert.equal((await second.render({ qid: qidResult.qid })).documentHtml, 'second');
    assert.equal(generationCloseCalls, 0);

    await second.close();
    await engine.close();
    assert.equal(generationCloseCalls, 1);
  });

  it('drains one stale generation and coordinates one replacement for concurrent callers', async () => {
    let generationCreates = 0;
    const closedGenerationIds: number[] = [];
    let releaseSlowRender: (() => void) | undefined;
    let slowRenderStarted: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      slowRenderStarted = resolve;
    });
    const slowRelease = new Promise<void>((resolve) => {
      releaseSlowRender = resolve;
    });
    const createGeneration: QuestionPreviewEngineGenerationFactory = async () => {
      const generationId = ++generationCreates;
      return {
        close: async () => {
          closedGenerationIds.push(generationId);
        },
        render: async (_options, input) => {
          if (generationId === 1 && input.variantSeed === 'slow') {
            slowRenderStarted?.();
            await slowRelease;
          }
          if (generationId === 1 && input.variantSeed === 'crash') {
            throw new Error('worker-pool generation crashed');
          }
          return success(`generation ${generationId}`);
        },
      };
    };
    const engine = await createQuestionPreviewEngineLifecycle({ createGeneration });
    const renderer = engine.createCourseRenderer(makeRendererOptions(makeCourseSource('course')));
    const qidResult = parseQuestionPreviewQid('demo/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    const slowRender = renderer.render({ qid: qidResult.qid, variantSeed: 'slow' });
    await slowStarted;
    await nodeAssert.rejects(
      renderer.render({ qid: qidResult.qid, variantSeed: 'crash' }),
      /worker-pool generation crashed/,
    );
    assert.deepEqual(closedGenerationIds, []);

    const recoveredRenders = Promise.all([
      renderer.render({ qid: qidResult.qid, variantSeed: 'recovered-a' }),
      renderer.render({ qid: qidResult.qid, variantSeed: 'recovered-b' }),
    ]);
    assert.equal(generationCreates, 1);
    releaseSlowRender?.();

    assert.equal((await slowRender).documentHtml, 'generation 1');
    const recovered = await recoveredRenders;
    assert.deepEqual(
      recovered.map((result) => result.documentHtml),
      ['generation 2', 'generation 2'],
    );
    assert.equal(generationCreates, 2);
    assert.deepEqual(closedGenerationIds, [1]);

    await engine.close();
    assert.deepEqual(closedGenerationIds, [1, 2]);
  });

  it('counts a generation acquisition before shutdown can begin draining it', async () => {
    let closeCalls = 0;
    let releaseRender: (() => void) | undefined;
    const renderReleased = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const engine = await createQuestionPreviewEngineLifecycle({
      createGeneration: async () => ({
        close: async () => {
          closeCalls++;
        },
        render: async () => {
          await renderReleased;
          return success('finished');
        },
      }),
    });
    const renderer = engine.createCourseRenderer(makeRendererOptions(makeCourseSource('course')));
    const qidResult = parseQuestionPreviewQid('demo/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    const render = renderer.render({ qid: qidResult.qid });
    const close = engine.close();
    await Promise.resolve();
    assert.equal(closeCalls, 0);

    releaseRender?.();
    assert.equal((await render).documentHtml, 'finished');
    await close;
    assert.equal(closeCalls, 1);
  });
});
