import nodeAssert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { resolveLegacyQuestionFilePath } from './legacy-question-file.js';

describe('legacy question file resolution', () => {
  it('bounds template inheritance before falling back to type defaults', async () => {
    const coursePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-legacy-files-'));
    const questions = new Map(
      Array.from({ length: 12 }, (_, index) => {
        const directory = `template-${index}`;
        return [
          directory,
          {
            courseId: '1',
            directory,
            templateDirectory: index === 11 ? null : `template-${index + 1}`,
            type: 'MultipleChoice',
          },
        ] as const;
      }),
    );
    await Promise.all(
      [...questions].map(([directory]) =>
        fs.mkdir(path.join(coursePath, 'questions', directory), { recursive: true }),
      ),
    );

    try {
      await nodeAssert.rejects(
        resolveLegacyQuestionFilePath({
          coursePath,
          filename: 'client.js',
          lookupTemplate: async ({ directory }) => questions.get(directory) ?? null,
          question: questions.get('template-0')!,
        }),
        /Template recursion exceeded maximum depth of 10/,
      );
    } finally {
      await fs.rm(coursePath, { force: true, recursive: true });
    }
  });

  it('rejects traversal and symlink escapes before exposing question files', async () => {
    const coursePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-legacy-files-'));
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-legacy-files-outside-'));
    const questionRoot = path.join(coursePath, 'questions', 'legacy');
    await fs.mkdir(questionRoot, { recursive: true });
    await fs.writeFile(path.join(outsidePath, 'secret.js'), 'outside secret');
    await fs.symlink(path.join(outsidePath, 'secret.js'), path.join(questionRoot, 'client.js'));
    const question = {
      courseId: '1',
      directory: 'legacy',
      templateDirectory: null,
      type: 'MultipleChoice',
    };

    try {
      await nodeAssert.rejects(
        resolveLegacyQuestionFilePath({
          coursePath,
          filename: '../secret.js',
          lookupTemplate: async () => null,
          question,
        }),
        /Invalid legacy question filename/,
      );
      const resolved = await resolveLegacyQuestionFilePath({
        coursePath,
        filename: 'client.js',
        lookupTemplate: async () => null,
        question,
      });
      assert.notEqual(resolved.fullPath, await fs.realpath(path.join(outsidePath, 'secret.js')));
      assert.equal(resolved.effectiveFilename, 'MultipleChoiceClient.js');
    } finally {
      await fs.rm(coursePath, { force: true, recursive: true });
      await fs.rm(outsidePath, { force: true, recursive: true });
    }
  });
});
