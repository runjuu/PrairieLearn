import fs from 'node:fs/promises';
import path from 'node:path';

import { APP_ROOT_PATH } from './paths.js';

const DEFAULT_LEGACY_QUESTION_FILES_PATH = path.resolve(APP_ROOT_PATH, 'v2-question-servers');
export const MAX_LEGACY_QUESTION_TEMPLATE_DEPTH = 10;

export interface LegacyQuestionFileQuestion {
  courseId: string;
  directory: string;
  templateDirectory: string | null;
  type: string;
}

export interface LegacyQuestionFilePath {
  effectiveFilename: string;
  fullPath: string;
  rootPath: string;
}

export type LegacyQuestionTemplateLookup = (input: {
  courseId: string;
  directory: string;
}) => Promise<LegacyQuestionFileQuestion | null>;

function isPathInsideRoot(root: string, candidate: string) {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function validateLegacyFilename(filename: string) {
  if (
    filename.length === 0 ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0') ||
    path.isAbsolute(filename)
  ) {
    throw new Error('Invalid legacy question filename.');
  }
}

async function resolveContainedFile(rootPath: string, filename: string) {
  let canonicalRoot: string;
  let fullPath: string;
  try {
    canonicalRoot = await fs.realpath(rootPath);
    fullPath = await fs.realpath(path.join(canonicalRoot, filename));
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (!isPathInsideRoot(canonicalRoot, fullPath) || !(await fs.stat(fullPath)).isFile()) {
    return null;
  }
  return { fullPath, rootPath: canonicalRoot };
}

export async function resolveLegacyQuestionFilePath({
  coursePath,
  filename,
  lookupTemplate,
  question,
  templateDepth = 0,
}: {
  coursePath: string;
  filename: string;
  lookupTemplate: LegacyQuestionTemplateLookup;
  question: LegacyQuestionFileQuestion;
  templateDepth?: number;
}): Promise<LegacyQuestionFilePath> {
  validateLegacyFilename(filename);
  if (templateDepth > MAX_LEGACY_QUESTION_TEMPLATE_DEPTH) {
    throw new Error(
      `Template recursion exceeded maximum depth of ${MAX_LEGACY_QUESTION_TEMPLATE_DEPTH}.`,
    );
  }

  const questionRoot = path.join(coursePath, 'questions', question.directory);
  const questionFile = await resolveContainedFile(questionRoot, filename);
  if (questionFile != null) {
    const canonicalQuestionsRoot = await fs.realpath(path.join(coursePath, 'questions'));
    if (!isPathInsideRoot(canonicalQuestionsRoot, questionFile.rootPath)) {
      throw new Error('Legacy question directory escapes the canonical course root.');
    }
    return { effectiveFilename: filename, ...questionFile };
  }

  if (question.templateDirectory != null) {
    const templateQuestion = await lookupTemplate({
      courseId: question.courseId,
      directory: question.templateDirectory,
    });
    if (templateQuestion == null) {
      throw new Error(
        `Could not find template question "${question.templateDirectory}" from question "${question.directory}".`,
      );
    }
    return resolveLegacyQuestionFilePath({
      coursePath,
      filename,
      lookupTemplate,
      question: templateQuestion,
      templateDepth: templateDepth + 1,
    });
  }

  const suffix =
    filename === 'client.js' ? 'Client.js' : filename === 'server.js' ? 'Server.js' : null;
  if (suffix != null) {
    const effectiveFilename = `${question.type}${suffix}`;
    const defaultFile = await resolveContainedFile(
      DEFAULT_LEGACY_QUESTION_FILES_PATH,
      effectiveFilename,
    );
    if (defaultFile == null) {
      throw new Error(`Default legacy question file "${effectiveFilename}" was not found.`);
    }
    return { effectiveFilename, ...defaultFile };
  }

  const courseFile = await resolveContainedFile(
    path.join(coursePath, 'clientFilesCourse'),
    filename,
  );
  if (courseFile == null) {
    throw new Error(`Legacy question file "${filename}" was not found.`);
  }
  return { effectiveFilename: filename, ...courseFile };
}
