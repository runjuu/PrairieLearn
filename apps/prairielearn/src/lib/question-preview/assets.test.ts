import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { createQuestionPreviewAssetResolver, makeQuestionPreviewAssetUrls } from './assets.js';
import { createLocalPreviewCourseSource } from './course-source.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { type QuestionPreviewQid, parseQuestionPreviewQid } from './qid.js';

async function writeFile(root: string, filename: string, contents: string) {
  const fullPath = path.join(root, filename);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, contents);
  return fullPath;
}

async function makeCourseDir() {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-assets-course-'));
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

function parseQid(qid: string): QuestionPreviewQid {
  const result = parseQuestionPreviewQid(qid);
  if (!result.ok) throw new Error(result.error.message);
  return result.qid;
}

describe('question preview assets', () => {
  it('constructs preview asset URLs from qid and local preview variant identities', () => {
    const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
    const identity = localPreviewGeneratedFiles.createVariantIdentity();

    assert.equal(identity.generatedFilesUrl, '/preview/generatedFilesQuestion/variant/1');
    assert.deepEqual(
      makeQuestionPreviewAssetUrls({
        clientFilesQuestionGeneratedFileUrl: identity.generatedFilesUrl,
        qid: parseQid('demo/question with spaces'),
        urlPrefix: '/preview',
      }),
      {
        clientFilesCourseUrl: '/preview/clientFilesCourse',
        clientFilesQuestionGeneratedFileUrl: '/preview/generatedFilesQuestion/variant/1',
        clientFilesQuestionUrl: '/preview/questions/demo/question%20with%20spaces/files',
      },
    );
  });

  it('resolves startup course asset URLs to bounded files', async () => {
    const courseDir = await makeCourseDir();

    try {
      const courseAsset = await fs.realpath(
        await writeFile(courseDir, 'clientFilesCourse/course.txt', 'course'),
      );
      const elementAsset = await fs.realpath(
        await writeFile(courseDir, 'elements/widget/widget.css', 'element'),
      );
      const extensionAsset = await fs.realpath(
        await writeFile(courseDir, 'elementExtensions/pl-demo/demo.js', 'extension'),
      );
      const questionAsset = await fs.realpath(
        await writeFile(
          courseDir,
          'questions/unit/files/assets/clientFilesQuestion/question.txt',
          'question',
        ),
      );

      const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
      const resolver = createQuestionPreviewAssetResolver({
        courseSource: await createLocalPreviewCourseSource(courseDir),
        localPreviewGeneratedFiles,
        urlPrefix: '/preview',
      });

      assert.deepEqual(resolver.routePatterns, [
        '/preview/clientFilesCourse/*',
        '/preview/elements/*',
        '/preview/cacheableElements/*',
        '/preview/elementExtensions/*',
        '/preview/cacheableElementExtensions/*',
        '/preview/questions/*',
        '/preview/generatedFilesQuestion/variant/*',
      ]);
      assert.equal(await resolver.resolve('/preview/clientFilesCourse/course.txt'), courseAsset);
      assert.equal(await resolver.resolve('/preview/elements/widget/widget.css'), elementAsset);
      assert.equal(
        await resolver.resolve('/preview/cacheableElements/cache/widget/widget.css'),
        elementAsset,
      );
      assert.equal(
        await resolver.resolve('/preview/elementExtensions/pl-demo/demo.js'),
        extensionAsset,
      );
      assert.equal(
        await resolver.resolve('/preview/cacheableElementExtensions/cache/pl-demo/demo.js'),
        extensionAsset,
      );
      assert.equal(
        await resolver.resolve('/preview/questions/unit/files/assets/files/question.txt'),
        questionAsset,
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('resolves generated-file URLs through local preview variant identities', async () => {
    const courseDir = await makeCourseDir();
    const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({
      max: 1,
      urlPrefix: '/preview',
    });
    const evictedIdentity = localPreviewGeneratedFiles.createVariantIdentity();
    localPreviewGeneratedFiles.registerVariantFiles({
      file: async () => ({
        courseIssues: [],
        data: Buffer.from('evicted'),
      }),
      identity: evictedIdentity,
    });
    const identity = localPreviewGeneratedFiles.createVariantIdentity();
    localPreviewGeneratedFiles.registerVariantFiles({
      file: async (filename) => ({
        courseIssues: [],
        data: Buffer.from(`generated ${filename}`),
      }),
      identity,
    });

    try {
      const resolver = createQuestionPreviewAssetResolver({
        courseSource: await createLocalPreviewCourseSource(courseDir),
        localPreviewGeneratedFiles,
        urlPrefix: '/preview',
      });

      const generatedFile = await resolver.resolveGeneratedFile(
        `${identity.generatedFilesUrl}/data.txt`,
      );

      assert.equal(generatedFile?.found, true);
      if (generatedFile?.found !== true) throw new Error('Expected generated file to be found.');
      assert.equal(generatedFile.filename, 'data.txt');
      assert.equal(generatedFile.generatedFile.data.toString(), 'generated data.txt');
      assert.deepEqual(generatedFile.generatedFile.issues, []);
      assert.deepEqual(
        await resolver.resolveGeneratedFile(`${evictedIdentity.generatedFilesUrl}/data.txt`),
        { found: false },
      );
      assert.equal(
        await resolver.resolveGeneratedFile(`${identity.generatedFilesUrl}/%2e%2e/other/data.txt`),
        null,
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects unsafe or missing preview asset paths', async () => {
    const courseDir = await makeCourseDir();

    try {
      await writeFile(courseDir, 'clientFilesCourse/course.txt', 'course');
      const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
      const resolver = createQuestionPreviewAssetResolver({
        courseSource: await createLocalPreviewCourseSource(courseDir),
        localPreviewGeneratedFiles,
        urlPrefix: '/preview',
      });

      assert.equal(await resolver.resolve('/preview/clientFilesCourse/%2e%2e/course.txt'), null);
      assert.equal(await resolver.resolve('/preview/clientFilesCourse/%2Ftmp%2Fsecret.txt'), null);
      assert.equal(await resolver.resolve('/preview/clientFilesCourse/dir%5Csecret.txt'), null);
      assert.equal(await resolver.resolve('/preview/clientFilesCourse//course.txt'), null);
      assert.equal(await resolver.resolve('/preview/clientFilesCourse/missing.txt'), null);
      assert.equal(await resolver.resolve('/other/clientFilesCourse/course.txt'), null);
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});
