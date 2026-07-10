import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type CourseJson,
  CourseJsonSchema,
  type QuestionJson,
  QuestionJsonSchema,
} from '../../schemas/index.js';

import type { QuestionPreviewQid } from './qid.js';

export interface LocalPreviewCourseMetadata {
  name: string;
  options: CourseJson['options'];
  timezone: string;
  title: string;
}

export interface LocalPreviewCourseSource {
  courseDir: string;
  courseMetadata: LocalPreviewCourseMetadata;
  readQuestionInfo(qid: QuestionPreviewQid): Promise<QuestionJson>;
  readTemplateInfo(qid: QuestionPreviewQid): Promise<QuestionJson>;
  resolveFile(rootPathSegments: string[], filePathSegments: string[]): Promise<string | null>;
}

export class InvalidLocalPreviewCourseError extends Error {
  override name = 'InvalidLocalPreviewCourseError';
}

class ExpectedLocalPreviewCourseSourceError extends Error {
  data: unknown;
  expectedQuestionPreviewFailure = true;
  fatal = true;
  phase = 'metadata' as const;

  constructor(message: string, data: unknown) {
    super(message);
    this.data = data;
  }
}

function isPathInsideRoot(root: string, candidate: string) {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function hasUnsafePathSegment(pathSegments: string[]) {
  return pathSegments.some(
    (segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      path.isAbsolute(segment),
  );
}

export async function createLocalPreviewCourseSource(
  courseDirInput: string,
): Promise<LocalPreviewCourseSource> {
  if (!path.isAbsolute(courseDirInput)) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: course directory must be absolute.',
    );
  }

  let courseDir: string;
  try {
    courseDir = await fs.realpath(courseDirInput);
    if (!(await fs.stat(courseDir)).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: course directory is not usable.',
      { cause: err },
    );
  }

  let infoCoursePath: string;
  let infoCourseContents: string;
  try {
    infoCoursePath = await fs.realpath(path.join(courseDir, 'infoCourse.json'));
    if (!isPathInsideRoot(courseDir, infoCoursePath)) {
      throw new InvalidLocalPreviewCourseError(
        'Invalid Local Preview Course Source: infoCourse.json escapes the canonical course root.',
      );
    }
    infoCourseContents = await fs.readFile(infoCoursePath, 'utf8');
  } catch (err) {
    if (err instanceof InvalidLocalPreviewCourseError) throw err;
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: infoCourse.json is not readable.',
      { cause: err },
    );
  }

  let rawInfoCourse: unknown;
  try {
    rawInfoCourse = JSON.parse(infoCourseContents);
  } catch (err) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: invalid infoCourse.json JSON.',
      { cause: err },
    );
  }
  const parsedInfoCourse = CourseJsonSchema.safeParse(rawInfoCourse);
  if (!parsedInfoCourse.success) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: invalid infoCourse.json metadata.',
      { cause: parsedInfoCourse.error },
    );
  }
  const infoCourse = parsedInfoCourse.data;

  let questionsDir: string;
  try {
    questionsDir = await fs.realpath(path.join(courseDir, 'questions'));
    if (!(await fs.stat(questionsDir)).isDirectory()) throw new Error('not a directory');
    await fs.access(questionsDir, constants.R_OK | constants.X_OK);
  } catch (err) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: questions directory is not usable.',
      { cause: err },
    );
  }
  if (!isPathInsideRoot(courseDir, questionsDir)) {
    throw new InvalidLocalPreviewCourseError(
      'Invalid Local Preview Course Source: questions directory escapes the canonical course root.',
    );
  }

  const source: LocalPreviewCourseSource = {
    courseDir,
    courseMetadata: {
      name: infoCourse.name,
      options: infoCourse.options,
      timezone: infoCourse.timezone ?? 'UTC',
      title: infoCourse.title,
    },
    async readQuestionInfo(qid) {
      let questionDir: string;
      let infoPath: string;
      try {
        questionDir = await fs.realpath(path.join(questionsDir, ...qid.pathSegments));
        infoPath = await fs.realpath(path.join(questionDir, 'info.json'));
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
          throw new ExpectedLocalPreviewCourseSourceError(
            `Question "${qid.decoded}" is missing info.json.`,
            { qid: qid.decoded },
          );
        }
        throw err;
      }
      if (!isPathInsideRoot(questionsDir, questionDir)) {
        throw new ExpectedLocalPreviewCourseSourceError(
          `Question "${qid.decoded}" escapes the canonical course root.`,
          { qid: qid.decoded },
        );
      }
      if (!isPathInsideRoot(questionDir, infoPath)) {
        throw new ExpectedLocalPreviewCourseSourceError(
          `Question "${qid.decoded}" escapes the canonical course root.`,
          { qid: qid.decoded },
        );
      }

      let rawInfo: unknown;
      try {
        rawInfo = JSON.parse(await fs.readFile(infoPath, 'utf8'));
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new ExpectedLocalPreviewCourseSourceError(
            `Question "${qid.decoded}" has invalid info.json JSON.`,
            { qid: qid.decoded },
          );
        }
        throw err;
      }

      const parsedInfo = QuestionJsonSchema.safeParse(rawInfo);
      if (!parsedInfo.success) {
        throw new ExpectedLocalPreviewCourseSourceError(
          `Question "${qid.decoded}" has invalid info.json metadata.`,
          { issues: parsedInfo.error.issues, qid: qid.decoded },
        );
      }
      return parsedInfo.data;
    },
    async readTemplateInfo(qid) {
      return source.readQuestionInfo(qid);
    },
    async resolveFile(rootPathSegments, filePathSegments) {
      if (
        hasUnsafePathSegment(rootPathSegments) ||
        hasUnsafePathSegment(filePathSegments) ||
        filePathSegments.length === 0
      ) {
        return null;
      }

      try {
        const rootDir = await fs.realpath(path.join(courseDir, ...rootPathSegments));
        if (!isPathInsideRoot(courseDir, rootDir)) return null;
        const filePath = await fs.realpath(path.join(rootDir, ...filePathSegments));
        if (!isPathInsideRoot(rootDir, filePath)) return null;
        return (await fs.stat(filePath)).isFile() ? filePath : null;
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
  return source;
}
