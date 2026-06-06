import { assert, describe, it } from 'vitest';

import { LocalPreviewGeneratedFiles } from './question-preview-generated-files.js';
import { makeLocalPreviewVariant } from './question-preview-rows.js';

describe('local preview generated files', () => {
  it('creates local preview variant identities with generated-file URLs', () => {
    const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });

    const firstIdentity = localPreviewGeneratedFiles.createVariantIdentity();
    const secondIdentity = localPreviewGeneratedFiles.createVariantIdentity();

    assert.equal(firstIdentity.id, '1');
    assert.equal(firstIdentity.generatedFilesUrl, '/preview/generatedFilesQuestion/variant/1');
    assert.equal(secondIdentity.id, '2');
    assert.equal(secondIdentity.generatedFilesUrl, '/preview/generatedFilesQuestion/variant/2');
  });

  it('captures prepared preview variants for lazy generated-file requests', async () => {
    const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
    const identity = localPreviewGeneratedFiles.createVariantIdentity();
    const variant = makeLocalPreviewVariant(
      '2',
      {
        broken: false,
        options: { source: 'prepare' },
        params: { message: 'prepared value' },
        preferences: {},
        true_answer: {},
      },
      { id: identity.id },
    );

    localPreviewGeneratedFiles.registerVariantFiles({
      file: async (filename) => ({
        courseIssues: [],
        data: Buffer.from(`${filename}:${variant.params?.message}`),
      }),
      identity,
    });

    assert.equal(variant.id, identity.id);
    assert.equal(variant.variant_seed, '2');
    assert.deepEqual(variant.options, { source: 'prepare' });
    assert.equal(identity.generatedFilesUrl, '/preview/generatedFilesQuestion/variant/1');

    const generatedFile = await localPreviewGeneratedFiles.resolveRequest(
      `${identity.generatedFilesUrl}/data.txt`,
    );

    assert.equal(generatedFile?.found, true);
    if (generatedFile?.found !== true) throw new Error('Expected generated file to be found.');
    assert.equal(generatedFile.filename, 'data.txt');
    assert.equal(generatedFile.generatedFile.data.toString(), 'data.txt:prepared value');
  });

  it('returns a fatal generated-file issue when no file adapter is registered', async () => {
    const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
    const identity = localPreviewGeneratedFiles.createVariantIdentity();

    localPreviewGeneratedFiles.registerVariantFiles({
      file: null,
      identity,
    });

    const generatedFile = await localPreviewGeneratedFiles.resolveRequest(
      `${identity.generatedFilesUrl}/data.txt`,
    );

    assert.equal(generatedFile?.found, true);
    if (generatedFile?.found !== true) throw new Error('Expected generated file to be found.');
    assert.deepEqual(generatedFile.generatedFile.issues, [
      {
        fatal: true,
        message:
          'Question preview generated-file URL requested, but the question type has no file() handler.',
        name: 'Error',
      },
    ]);
  });

  it('normalizes question-server file issues into generated-file issues', async () => {
    class TestCourseIssue extends Error {
      data = { filename: 'data.txt' };
      fatal = true;

      constructor() {
        super('Generated file failed.');
        this.name = 'CourseIssueError';
      }
    }

    const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
    const identity = localPreviewGeneratedFiles.createVariantIdentity();

    localPreviewGeneratedFiles.registerVariantFiles({
      file: async () => ({
        courseIssues: [new TestCourseIssue()],
        data: Buffer.from(''),
      }),
      identity,
    });

    const generatedFile = await localPreviewGeneratedFiles.resolveRequest(
      `${identity.generatedFilesUrl}/data.txt`,
    );

    assert.equal(generatedFile?.found, true);
    if (generatedFile?.found !== true) throw new Error('Expected generated file to be found.');
    assert.deepEqual(generatedFile.generatedFile.issues, [
      {
        data: { filename: 'data.txt' },
        fatal: true,
        message: 'Generated file failed.',
        name: 'CourseIssueError',
      },
    ]);
  });
});
