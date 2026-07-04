import path from 'node:path';

const QUESTION_PREVIEW_QID_ERROR_MESSAGE =
  'Invalid question id. Expected a relative qid below the course questions directory.';

const questionPreviewQidBrand: unique symbol = Symbol('QuestionPreviewQid');

export interface QuestionPreviewQidValidationError {
  message: string;
  qid: string;
}

export interface QuestionPreviewQid {
  readonly [questionPreviewQidBrand]: true;
  readonly decoded: string;
  readonly encodedPath: string;
  readonly pathSegments: readonly string[];
}

export type QuestionPreviewQidParseResult =
  | { ok: true; qid: QuestionPreviewQid }
  | { error: QuestionPreviewQidValidationError; ok: false };

function questionPreviewQidValidationErrorFromSegments(
  qid: string,
  segments: readonly string[],
): QuestionPreviewQidValidationError | null {
  if (
    qid.length === 0 ||
    qid.startsWith('/') ||
    qid.includes('\\') ||
    qid.includes('\0') ||
    path.isAbsolute(qid) ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        segment.includes('\0') ||
        path.isAbsolute(segment),
    )
  ) {
    return {
      message: QUESTION_PREVIEW_QID_ERROR_MESSAGE,
      qid,
    };
  }

  return null;
}

function makeQuestionPreviewQid(pathSegments: string[]): QuestionPreviewQid {
  const frozenSegments = Object.freeze([...pathSegments]);
  const qid: QuestionPreviewQid = {
    [questionPreviewQidBrand]: true,
    decoded: frozenSegments.join('/'),
    encodedPath: frozenSegments.map(encodeURIComponent).join('/'),
    pathSegments: frozenSegments,
  };

  Object.defineProperty(qid, questionPreviewQidBrand, { enumerable: false });
  return Object.freeze(qid);
}

export function parseQuestionPreviewQid(qid: string): QuestionPreviewQidParseResult {
  const segments = qid.split('/');
  const error = questionPreviewQidValidationErrorFromSegments(qid, segments);
  if (error != null) return { error, ok: false };

  return {
    ok: true,
    qid: makeQuestionPreviewQid(segments),
  };
}

export function questionPreviewQidFromPathSegments(
  pathSegments: readonly string[],
): QuestionPreviewQidParseResult {
  const qid = pathSegments.join('/');
  const error = questionPreviewQidValidationErrorFromSegments(qid, pathSegments);
  if (error != null) return { error, ok: false };

  return {
    ok: true,
    qid: makeQuestionPreviewQid([...pathSegments]),
  };
}

export function questionPreviewQidValidationError(
  qid: string,
): QuestionPreviewQidValidationError | null {
  const result = parseQuestionPreviewQid(qid);
  return result.ok ? null : result.error;
}
