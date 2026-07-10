import assert from 'node:assert';

import * as sqldb from '@prairielearn/postgres';

import { QuestionSchema } from './db-types.js';
import {
  type LegacyQuestionFileQuestion,
  resolveLegacyQuestionFilePath,
} from './legacy-question-file.js';

const sql = sqldb.loadSqlEquiv(import.meta.url);

interface QuestionFilePathInfo {
  /** The full path, including the filename, of the file to load */
  fullPath: string;
  /** The filename, excluding the path */
  effectiveFilename: string;
  /** The path, excluding the filename. */
  rootPath: string;
}

/**
 * Returns the full path for a file, as well as the effective filename and
 * the root path.
 *
 * Note that `fullPath === rootPath + '/' + effectiveFilename`.
 *
 * These can be used like this for safety when sending files:
 *
 * ```
 * res.sendFile(effectiveFilename, { root: rootPath });
 * ```
 *
 */
export async function questionFilePath(
  filename: string,
  questionDirectory: string,
  coursePath: string,
  question: any,
  nTemplates = 0,
): Promise<QuestionFilePathInfo> {
  assert(question.directory ?? questionDirectory, 'question directory is required');
  assert(question.type, 'question type is required');

  const toLegacyQuestion = (value: typeof question): LegacyQuestionFileQuestion => ({
    courseId: value.course_id,
    directory: value.directory ?? questionDirectory,
    templateDirectory: value.template_directory,
    type: value.type,
  });

  return resolveLegacyQuestionFilePath({
    coursePath,
    filename,
    lookupTemplate: async ({ courseId, directory }) => {
      const templateQuestion = await sqldb.queryOptionalRow(
        sql.select_question,
        { course_id: courseId, directory },
        QuestionSchema,
      );
      if (templateQuestion == null) return null;
      assert(templateQuestion.directory !== null, 'template question directory is required');
      assert(templateQuestion.type !== null, 'template question type is required');
      return {
        courseId: templateQuestion.course_id,
        directory: templateQuestion.directory,
        templateDirectory: templateQuestion.template_directory,
        type: templateQuestion.type,
      };
    },
    question: toLegacyQuestion(question),
    templateDepth: nTemplates,
  });
}
