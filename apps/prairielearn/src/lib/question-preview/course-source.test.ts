import nodeAssert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { createLocalPreviewCourseSource } from './course-source.js';
import { parseQuestionPreviewQid } from './qid.js';

async function makeCourseRoot(infoCourse: Record<string, unknown>) {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-course-source-'));
  await fs.writeFile(path.join(courseDir, 'infoCourse.json'), JSON.stringify(infoCourse));
  await fs.mkdir(path.join(courseDir, 'questions'));
  return courseDir;
}

describe('Local Preview Course Source', () => {
  it('rejects relative course directories', async () => {
    await nodeAssert.rejects(createLocalPreviewCourseSource('relative/course'), {
      message: 'Invalid Local Preview Course Source: course directory must be absolute.',
      name: 'InvalidLocalPreviewCourseError',
    });
  });

  it('rejects invalid course metadata with a stable registration error', async () => {
    const courseDir = await makeCourseRoot({ title: 'Missing required course fields' });

    try {
      await nodeAssert.rejects(createLocalPreviewCourseSource(courseDir), {
        message: 'Invalid Local Preview Course Source: invalid infoCourse.json metadata.',
        name: 'InvalidLocalPreviewCourseError',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('registers canonical course metadata with a UTC timezone fallback', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      options: { questionsReceiveUserData: true },
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-course-link-'));
    const linkedCourseDir = path.join(linkRoot, 'course');
    await fs.symlink(courseDir, linkedCourseDir);

    try {
      const source = await createLocalPreviewCourseSource(linkedCourseDir);

      assert.equal(source.courseDir, await fs.realpath(courseDir));
      assert.deepEqual(source.courseMetadata, {
        name: 'TST 101',
        options: { questionsReceiveUserData: true },
        timezone: 'UTC',
        title: 'Preview source testing',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(linkRoot, { force: true, recursive: true });
    }
  });

  it('rejects a questions directory that resolves outside the canonical course root', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-outside-questions-'));
    await fs.rm(path.join(courseDir, 'questions'), { recursive: true });
    await fs.symlink(outsideDir, path.join(courseDir, 'questions'));

    try {
      await nodeAssert.rejects(createLocalPreviewCourseSource(courseDir), {
        message:
          'Invalid Local Preview Course Source: questions directory escapes the canonical course root.',
        name: 'InvalidLocalPreviewCourseError',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('reads changing question metadata fresh through the Course Source', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const questionDir = path.join(courseDir, 'questions', 'unit', 'question');
    await fs.mkdir(questionDir, { recursive: true });
    const infoPath = path.join(questionDir, 'info.json');
    const qidResult = parseQuestionPreviewQid('unit/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    try {
      await fs.writeFile(
        infoPath,
        JSON.stringify({
          title: 'Before edit',
          topic: 'Testing',
          type: 'v3',
          uuid: '11111111-1111-4111-8111-111111111160',
        }),
      );
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal((await source.readQuestionInfo(qidResult.qid)).title, 'Before edit');

      await fs.writeFile(
        infoPath,
        JSON.stringify({
          title: 'After edit',
          topic: 'Testing',
          type: 'v3',
          uuid: '11111111-1111-4111-8111-111111111160',
        }),
      );

      assert.equal((await source.readQuestionInfo(qidResult.qid)).title, 'After edit');
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('resolves template metadata through the contained Course Source lookup', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const templateDir = path.join(courseDir, 'questions', 'templates', 'base');
    await fs.mkdir(templateDir, { recursive: true });
    await fs.writeFile(
      path.join(templateDir, 'info.json'),
      JSON.stringify({
        title: 'Base template',
        topic: 'Testing',
        type: 'v3',
        uuid: '11111111-1111-4111-8111-111111111162',
      }),
    );
    const qidResult = parseQuestionPreviewQid('templates/base');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal((await source.readTemplateInfo(qidResult.qid)).title, 'Base template');
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects question metadata reached through an escaping symlink', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-outside-question-'));
    await fs.writeFile(
      path.join(outsideDir, 'info.json'),
      JSON.stringify({
        title: 'Outside question',
        topic: 'Testing',
        type: 'v3',
        uuid: '11111111-1111-4111-8111-111111111161',
      }),
    );
    await fs.mkdir(path.join(courseDir, 'questions', 'unit'));
    await fs.symlink(outsideDir, path.join(courseDir, 'questions', 'unit', 'question'));
    const qidResult = parseQuestionPreviewQid('unit/question');
    if (!qidResult.ok) throw new Error(qidResult.error.message);

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      await nodeAssert.rejects(source.readQuestionInfo(qidResult.qid), {
        message: 'Question "unit/question" escapes the canonical course root.',
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('resolves only files contained by a canonical course-owned root', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });
    const assetsDir = path.join(courseDir, 'clientFilesCourse');
    await fs.mkdir(assetsDir);
    const courseAsset = path.join(assetsDir, 'course.txt');
    await fs.writeFile(courseAsset, 'course');
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-outside-asset-'));
    const outsideAsset = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideAsset, 'secret');
    await fs.symlink(outsideAsset, path.join(assetsDir, 'secret.txt'));

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.equal(
        await source.resolveResource({
          filePathSegments: ['course.txt'],
          kind: 'course-client-file',
        }),
        await fs.realpath(courseAsset),
      );
      assert.isNull(
        await source.resolveResource({
          filePathSegments: ['secret.txt'],
          kind: 'course-client-file',
        }),
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
      await fs.rm(outsideDir, { force: true, recursive: true });
    }
  });

  it('sanitizes its canonical path from nested diagnostic values', async () => {
    const courseDir = await makeCourseRoot({
      name: 'TST 101',
      title: 'Preview source testing',
      topics: [{ color: 'blue1', name: 'Testing' }],
    });

    try {
      const source = await createLocalPreviewCourseSource(courseDir);
      assert.deepEqual(
        source.sanitizeDiagnosticValue({
          message: `Failed below ${source.courseDir}/questions`,
          paths: [source.courseDir],
        }),
        {
          message: 'Failed below <course>/questions',
          paths: ['<course>'],
        },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});
