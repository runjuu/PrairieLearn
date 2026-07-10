import path from 'node:path';

import { contains } from '@prairielearn/path-utils';

import * as calculationServer from '../../question-servers/calculation-subprocess.js';
import * as questionServers from '../../question-servers/index.js';
import type {
  GenerateResultData,
  GradeResultData,
  QuestionServer,
  QuestionServerReturnValue,
} from '../../question-servers/types.js';
import type { QuestionJson } from '../../schemas/index.js';
import { withCodeCaller } from '../code-caller/index.js';
import { config } from '../config.js';
import type { Course, Question, Submission, Variant } from '../db-types.js';
import { REPOSITORY_ROOT_PATH } from '../paths.js';

import type { LocalPreviewCourseSource } from './course-source.js';
import { ExpectedQuestionPreviewError } from './expected-error.js';
import type { QuestionPreviewQid } from './qid.js';

const MAX_LEGACY_POST_DATA_BYTES = 1024 * 1024;

interface LegacyQuestionBrowserDataInput {
  course: Course;
  generatedFilesUrl: string;
  questionFileUrl: string;
  showCorrectAnswer: boolean;
  submission: Submission | null;
  submissions: Submission[];
  variant: Variant;
}

export interface QuestionPreviewSourceQuestionTypeAdapter {
  kind: 'freeform' | 'legacy';
  makeLegacyQuestionJsonBase64(input: LegacyQuestionBrowserDataInput): string | null;
  normalizeSubmittedAnswer(rawSubmittedAnswer: Record<string, unknown>): Record<string, unknown>;
  questionServer: QuestionServer;
}

function makeFreeformAdapter(question: Question): QuestionPreviewSourceQuestionTypeAdapter {
  return {
    kind: 'freeform',
    makeLegacyQuestionJsonBase64: () => null,
    normalizeSubmittedAnswer: (rawSubmittedAnswer) => rawSubmittedAnswer,
    questionServer: questionServers.getModule(question.type),
  };
}

function getQuestionRuntimePath(questionServerPath: string, coursePath: string) {
  if (contains(coursePath, questionServerPath)) {
    return config.workersExecutionMode === 'native'
      ? questionServerPath
      : path.join('/course', path.relative(coursePath, questionServerPath));
  }

  if (config.workersExecutionMode === 'native') return questionServerPath;
  return path.join('/PrairieLearn', path.relative(REPOSITORY_ROOT_PATH, questionServerPath));
}

async function callLegacyQuestionFunction<Data>({
  course,
  courseSource,
  func,
  inputData,
  info,
  question,
  qid,
}: {
  course: Course;
  courseSource: LocalPreviewCourseSource;
  func: 'generate' | 'grade';
  inputData: Record<string, unknown>;
  info: QuestionJson;
  question: Question;
  qid: QuestionPreviewQid;
}): QuestionServerReturnValue<Data> {
  try {
    const { fullPath } = await courseSource.resolveLegacyQuestionFile({
      filename: 'server.js',
      info,
      qid,
    });
    const questionServerPath = getQuestionRuntimePath(fullPath, courseSource.courseDir);
    const coursePath =
      config.workersExecutionMode === 'native' ? courseSource.courseDir : '/course';

    return await withCodeCaller(course, async (codeCaller) => {
      const response = await codeCaller.call('v2-question', null, questionServerPath, null, [
        {
          questionServerPath,
          func,
          coursePath,
          question,
          ...inputData,
        },
      ]);
      return { courseIssues: [], data: response.result as Data };
    });
  } catch (err) {
    const issue = err instanceof Error ? err : new Error(String(err));
    Object.assign(issue, { fatal: true });
    return { courseIssues: [issue], data: {} as Data };
  }
}

function makeLegacyQuestionServer({
  courseSource,
  info,
  qid,
}: {
  courseSource: LocalPreviewCourseSource;
  info: QuestionJson;
  qid: QuestionPreviewQid;
}): QuestionServer {
  return {
    async generate(question, course, variantSeed) {
      return await callLegacyQuestionFunction<GenerateResultData>({
        course,
        courseSource,
        func: 'generate',
        inputData: { variant_seed: variantSeed },
        info,
        question,
        qid,
      });
    },
    async grade(submission, variant, question, course) {
      return await callLegacyQuestionFunction<GradeResultData>({
        course,
        courseSource,
        func: 'grade',
        inputData: { submission, variant },
        info,
        question,
        qid,
      });
    },
    parse: calculationServer.parse,
    prepare: calculationServer.prepare,
    render: calculationServer.render,
  };
}

function normalizeLegacySubmittedAnswer(
  rawSubmittedAnswer: Record<string, unknown>,
): Record<string, unknown> {
  const postData = rawSubmittedAnswer.postData;
  if (typeof postData !== 'string') {
    throw new ExpectedQuestionPreviewError('Legacy submissions require a postData envelope.', {
      phase: 'parse',
    });
  }
  if (Buffer.byteLength(postData, 'utf8') > MAX_LEGACY_POST_DATA_BYTES) {
    throw new ExpectedQuestionPreviewError('Legacy submission postData is too large.', {
      phase: 'parse',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(postData);
  } catch {
    throw new ExpectedQuestionPreviewError('Legacy submission postData is invalid JSON.', {
      phase: 'parse',
    });
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExpectedQuestionPreviewError('Legacy submission postData must be an object.', {
      phase: 'parse',
    });
  }

  const submittedAnswer = (parsed as Record<string, unknown>).submittedAnswer;
  if (
    submittedAnswer == null ||
    typeof submittedAnswer !== 'object' ||
    Array.isArray(submittedAnswer)
  ) {
    throw new ExpectedQuestionPreviewError(
      'Legacy submission postData requires an object submittedAnswer.',
      { phase: 'parse' },
    );
  }
  return submittedAnswer as Record<string, unknown>;
}

function encodeLegacyQuestionData(input: LegacyQuestionBrowserDataInput) {
  const questionJson = JSON.stringify({
    questionFilePath: input.questionFileUrl,
    questionGeneratedFilePath: input.generatedFilesUrl,
    effectiveQuestionType: 'Calculation',
    course: input.course,
    courseInstance: null,
    variant: {
      id: input.variant.id,
      params: input.variant.params,
    },
    submittedAnswer: input.submission?.submitted_answer ?? null,
    feedback: input.submission?.feedback ?? null,
    trueAnswer: input.showCorrectAnswer ? input.variant.true_answer : null,
    submissions: input.submissions.length > 0 ? input.submissions : null,
  });
  return Buffer.from(encodeURIComponent(questionJson)).toString('base64');
}

function makeLegacyAdapter({
  courseSource,
  info,
  qid,
}: {
  courseSource: LocalPreviewCourseSource;
  info: QuestionJson;
  qid: QuestionPreviewQid;
}): QuestionPreviewSourceQuestionTypeAdapter {
  return {
    kind: 'legacy',
    makeLegacyQuestionJsonBase64: encodeLegacyQuestionData,
    normalizeSubmittedAnswer: normalizeLegacySubmittedAnswer,
    questionServer: makeLegacyQuestionServer({ courseSource, info, qid }),
  };
}

export function createQuestionPreviewSourceQuestionTypeAdapter({
  courseSource,
  info,
  qid,
  question,
}: {
  courseSource: LocalPreviewCourseSource;
  info: QuestionJson;
  qid: QuestionPreviewQid;
  question: Question;
}): QuestionPreviewSourceQuestionTypeAdapter {
  return question.type === 'Freeform'
    ? makeFreeformAdapter(question)
    : makeLegacyAdapter({ courseSource, info, qid });
}
