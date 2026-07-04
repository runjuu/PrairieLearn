import fs from 'node:fs/promises';
import path from 'node:path';

import fg from 'fast-glob';

import { html, unsafeHtml } from '@prairielearn/html';
import { markdownToHtml } from '@prairielearn/markdown';
import { generateSignedToken } from '@prairielearn/signed-token';
import { workspaceFastGlobDefaultOptions } from '@prairielearn/workspace-utils';

import { HeadContents } from '../../components/HeadContents.js';
import { QuestionTitle } from '../../components/QuestionContainer.js';
import { QuestionHeadContents } from '../../components/QuestionHeadContents.js';
import { type SubmissionForRender, SubmissionPanel } from '../../components/SubmissionPanel.js';
import * as questionServers from '../../question-servers/index.js';
import { type QuestionJson, QuestionJsonSchema } from '../../schemas/index.js';
import { config } from '../config.js';
import type { Course, Question, Submission, Variant } from '../db-types.js';

import { makeQuestionPreviewAssetUrls } from './assets.js';
import { type LocalPreviewGeneratedFiles } from './generated-files.js';
import type { QuestionPreviewQid } from './qid.js';
import {
  makeLocalPreviewQuestionRows,
  makeLocalPreviewSubmission,
  makeLocalPreviewVariant,
  makePreviewWorkspaceSettings,
} from './rows.js';
import type { PreviewWorkspaceAllocator } from './workspace-launcher.js';

export interface QuestionPreviewSubmissionInput {
  /** Posted form fields with `__action`/`__csrf_token`/`__variant_id` already stripped. */
  rawSubmittedAnswer: Record<string, unknown>;
}

export interface QuestionPreviewDocumentInput {
  qid: QuestionPreviewQid;
  variantSeed?: string;
  submission?: QuestionPreviewSubmissionInput;
  /** Overrides the renderer's configured render mode for this render only. */
  renderMode?: QuestionPreviewRenderMode;
}

export interface QuestionPreviewDocumentRenderer {
  render(input: QuestionPreviewDocumentInput): Promise<QuestionPreviewDocumentResult>;
}

export type QuestionPreviewRenderMode = 'full' | 'question-only';

export interface QuestionPreviewDocumentRendererOptions {
  courseDir: string;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
  renderMode?: QuestionPreviewRenderMode;
  urlPrefix: string;
}

export type QuestionPreviewPhase =
  | 'input'
  | 'metadata'
  | 'generate'
  | 'prepare'
  | 'parse'
  | 'grade'
  | 'render';

export interface QuestionPreviewDiagnostic {
  data?: unknown;
  fatal: boolean;
  message: string;
  name: string;
  phase?: QuestionPreviewPhase;
  stack?: string;
}

export interface QuestionPreviewDocumentSuccess {
  diagnostics: QuestionPreviewDiagnostic[];
  documentHtml: string;
  ok: true;
}

export interface QuestionPreviewDocumentFailure {
  diagnostics: QuestionPreviewDiagnostic[];
  documentHtml: string;
  ok: false;
}

export type QuestionPreviewDocumentResult =
  | QuestionPreviewDocumentFailure
  | QuestionPreviewDocumentSuccess;

interface QuestionPreviewInternalRenderInput extends QuestionPreviewDocumentInput {
  courseDir: string;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewWorkspaces: PreviewWorkspaceAllocator | null;
  renderMode: QuestionPreviewRenderMode;
  urlPrefix: string;
}

class ExpectedQuestionPreviewError extends Error {
  data?: unknown;
  fatal = true;
  phase: QuestionPreviewPhase;

  constructor(message: string, { data, phase }: { data?: unknown; phase: QuestionPreviewPhase }) {
    super(message);
    this.data = data;
    this.phase = phase;
  }
}

function makePreviewLocals({
  clientFilesQuestionGeneratedFileUrl,
  qid,
  questionId,
  showCorrectAnswer,
  urlPrefix,
  workspaceUrl,
}: {
  clientFilesQuestionGeneratedFileUrl: string;
  qid: QuestionPreviewQid;
  questionId: string;
  showCorrectAnswer: boolean;
  urlPrefix: string;
  workspaceUrl: string;
}): questionServers.QuestionRenderRequiredLocals {
  const assetUrls = makeQuestionPreviewAssetUrls({
    clientFilesQuestionGeneratedFileUrl,
    qid,
    urlPrefix,
  });

  return {
    allowAnswerEditing: true,
    baseUrl: urlPrefix,
    clientFilesCourseUrl: assetUrls.clientFilesCourseUrl,
    clientFilesQuestionGeneratedFileUrl: assetUrls.clientFilesQuestionGeneratedFileUrl,
    clientFilesQuestionUrl: assetUrls.clientFilesQuestionUrl,
    externalImageCaptureUrl: null,
    questionUrl: `${urlPrefix}/question/${questionId}/`,
    showCorrectAnswer,
    urlPrefix,
    workspaceUrl,
  };
}

function diagnosticsFromIssues(
  issues: (Error & { fatal?: boolean; data?: unknown })[],
  phase?: QuestionPreviewPhase,
  { sanitizePaths = [] }: { sanitizePaths?: string[] } = {},
): QuestionPreviewDiagnostic[] {
  return issues.map((issue) => ({
    data: sanitizeDiagnosticValue(issue.data, sanitizePaths),
    fatal: issue.fatal ?? false,
    message: sanitizeDiagnosticText(issue.message, sanitizePaths),
    name: issue.name,
    phase,
  }));
}

function sanitizeDiagnosticText(text: string, sanitizePaths: string[]): string {
  return sanitizePaths.reduce((result, unsafePath) => {
    if (unsafePath.length === 0) return result;
    return result.split(unsafePath).join('<course>');
  }, text);
}

function sanitizeDiagnosticValue(value: unknown, sanitizePaths: string[]): unknown {
  if (typeof value === 'string') return sanitizeDiagnosticText(value, sanitizePaths);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, sanitizePaths));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDiagnosticValue(item, sanitizePaths),
      ]),
    );
  }

  return value;
}

function diagnosticFromError(
  err: unknown,
  { phase }: { phase: QuestionPreviewPhase },
): QuestionPreviewDiagnostic {
  if (err instanceof Error) {
    const errorPhase = 'phase' in err && isQuestionPreviewPhase(err.phase) ? err.phase : phase;

    return {
      data: 'data' in err ? err.data : undefined,
      fatal: 'fatal' in err && typeof err.fatal === 'boolean' ? err.fatal : true,
      message: err.message,
      name: err.name,
      phase: errorPhase,
    };
  }

  return {
    fatal: true,
    message: String(err),
    name: 'Error',
    phase,
  };
}

function isQuestionPreviewPhase(value: unknown): value is QuestionPreviewPhase {
  return (
    value === 'input' ||
    value === 'metadata' ||
    value === 'generate' ||
    value === 'prepare' ||
    value === 'parse' ||
    value === 'grade' ||
    value === 'render'
  );
}

function renderQuestionPreviewShellHeadHtml({
  extraHeadersHtml,
  pageTitle,
  questionType,
  urlPrefix,
}: {
  extraHeadersHtml: string;
  pageTitle: string;
  questionType: Question['type'];
  urlPrefix: string;
}): string {
  return html`
    ${HeadContents({
      pageTitle,
      resLocals: {},
    })}
    ${QuestionHeadContents({ extraHeadersHtml, questionType, urlPrefix })}
  `.toString();
}

type QuestionPreviewSubmissionPanel =
  | { kind: 'graded'; submission: Submission; submissionHtml: string }
  | { kind: 'unsupported-grading-method'; gradingMethod: Question['grading_method'] };

function renderQuestionPreviewSubmissionPanelHtml({
  course,
  question,
  submissionPanel,
  urlPrefix,
  variant,
}: {
  course: Course;
  question: Question;
  submissionPanel: QuestionPreviewSubmissionPanel;
  urlPrefix: string;
  variant: Variant;
}) {
  if (submissionPanel.kind === 'unsupported-grading-method') {
    return html`
      <div class="alert alert-secondary" role="alert">
        This question uses ${submissionPanel.gradingMethod} grading, which is not supported by the
        local preview server. Only internally graded questions can be checked here.
      </div>
    `;
  }

  const { submission, submissionHtml } = submissionPanel;
  const submissionForRender: SubmissionForRender = {
    ...submission,
    grading_job: null,
    user_uid: null,
    submission_number: 1,
    feedback_manual_html: submission.feedback?.manual
      ? markdownToHtml(submission.feedback.manual.toString())
      : undefined,
  };

  return SubmissionPanel({
    course,
    question,
    questionContext: 'instructor',
    submission: submissionForRender,
    submissionCount: 1,
    submissionHtml,
    urlPrefix,
    variant_id: variant.id,
  });
}

function renderQuestionPreviewBodyHtml({
  answerHtml,
  checkAnswerSupported,
  course,
  question,
  questionHtml,
  showCorrectAnswer,
  submissionPanel,
  urlPrefix,
  variant,
  variantToken,
}: {
  answerHtml: string;
  checkAnswerSupported: boolean;
  course: Course;
  question: Question;
  questionHtml: string;
  showCorrectAnswer: boolean;
  submissionPanel: QuestionPreviewSubmissionPanel | null;
  urlPrefix: string;
  variant: Variant;
  variantToken: string;
}): string {
  return html`
    <div
      class="question-container mb-4"
      data-grading-method="${question.grading_method}"
      data-variant-id="${variant.id}"
      data-variant-token="${variantToken}"
      data-workspace-id="${variant.workspace_id ?? ''}"
    >
      <form class="question-form" name="question-form" method="POST" autocomplete="off">
        <div class="card mb-3 question-block">
          <div class="card-header bg-primary text-white d-flex align-items-center gap-2">
            <h1>
              ${QuestionTitle({ questionContext: 'instructor', question, questionNumber: '' })}
            </h1>
          </div>
          <div class="card-body overflow-x-auto question-body">${unsafeHtml(questionHtml)}</div>
          <div class="card-footer" id="question-panel-footer">
            ${checkAnswerSupported
              ? html`
                  <button
                    type="submit"
                    class="btn btn-primary question-grade disable-on-submit"
                    name="__action"
                    value="grade"
                  >
                    Save &amp; Grade
                  </button>
                  <input
                    type="hidden"
                    name="__variant_id"
                    value="${variant.id}"
                    data-skip-unload-check="true"
                  />
                `
              : html`
                  <p class="small text-muted mb-0">
                    Save &amp; Grade is unavailable: this question uses ${question.grading_method}
                    grading.
                  </p>
                `}
          </div>
        </div>
      </form>
      <div class="card mb-3 grading-block${showCorrectAnswer ? '' : ' d-none'}">
        <div class="card-header bg-secondary text-white">
          <h2>Correct answer</h2>
        </div>
        <div class="card-body overflow-x-auto answer-body">
          ${showCorrectAnswer ? unsafeHtml(answerHtml) : ''}
        </div>
      </div>
      ${submissionPanel == null
        ? ''
        : renderQuestionPreviewSubmissionPanelHtml({
            course,
            question,
            submissionPanel,
            urlPrefix,
            variant,
          })}
    </div>
  `.toString();
}

function renderQuestionOnlyPreviewBodyHtml({
  questionHtml,
  variant,
}: {
  questionHtml: string;
  variant: Variant;
}): string {
  return html`
    <div
      class="question-container"
      data-variant-id="${variant.id}"
      data-workspace-id="${variant.workspace_id ?? ''}"
    >
      <div class="question-body">${unsafeHtml(questionHtml)}</div>
    </div>
  `.toString();
}

function renderQuestionPreviewDocumentHtml({
  bodyHtml,
  headHtml,
}: {
  bodyHtml: string;
  headHtml: string;
}) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${headHtml}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export const QUESTION_PREVIEW_ERROR_DOCUMENT = renderQuestionPreviewDocumentHtml({
  bodyHtml: `<main>
<h1>Question preview failed</h1>
<p>Check the preview server console for details.</p>
</main>`,
  headHtml: '<title>Question Preview Error</title>',
});

function makeQuestionPreviewSuccessResult({
  bodyHtml,
  diagnostics,
  headHtml,
}: {
  bodyHtml: string;
  diagnostics: QuestionPreviewDiagnostic[];
  headHtml: string;
}): QuestionPreviewDocumentSuccess {
  return {
    diagnostics,
    documentHtml: renderQuestionPreviewDocumentHtml({ bodyHtml, headHtml }),
    ok: true,
  };
}

export function makeQuestionPreviewDocumentFailureResult(
  diagnostics: QuestionPreviewDiagnostic[],
): QuestionPreviewDocumentFailure {
  return {
    diagnostics,
    documentHtml: QUESTION_PREVIEW_ERROR_DOCUMENT,
    ok: false,
  };
}

function validateQuestionPreviewVariantSeed(variantSeed: string) {
  if (variantSeed.length === 0 || Number.isNaN(Number.parseInt(variantSeed, 36))) {
    throw new ExpectedQuestionPreviewError(
      'Invalid variant seed. Expected a non-empty seed with a base-36 prefix.',
      {
        data: { variantSeed },
        phase: 'input',
      },
    );
  }
}

async function readQuestionInfo(courseDir: string, qid: QuestionPreviewQid): Promise<QuestionJson> {
  const infoPath = path.join(courseDir, 'questions', ...qid.pathSegments, 'info.json');
  let contents: string;

  try {
    contents = await fs.readFile(infoPath, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new ExpectedQuestionPreviewError(`Question "${qid.decoded}" is missing info.json.`, {
        data: { qid: qid.decoded },
        phase: 'metadata',
      });
    }

    throw err;
  }

  let rawInfo: unknown;
  try {
    rawInfo = JSON.parse(contents);
  } catch {
    throw new ExpectedQuestionPreviewError(
      `Question "${qid.decoded}" has invalid info.json JSON.`,
      {
        data: { qid: qid.decoded },
        phase: 'metadata',
      },
    );
  }

  const parsed = QuestionJsonSchema.safeParse(rawInfo);
  if (!parsed.success) {
    throw new ExpectedQuestionPreviewError(
      `Question "${qid.decoded}" has invalid info.json metadata.`,
      {
        data: { issues: parsed.error.issues, qid: qid.decoded },
        phase: 'metadata',
      },
    );
  }

  return parsed.data;
}

async function renderQuestionPreviewDocumentResult({
  courseDir,
  localPreviewGeneratedFiles,
  localPreviewWorkspaces,
  qid,
  renderMode,
  submission: submissionInput,
  urlPrefix,
  variantSeed = '1',
}: QuestionPreviewInternalRenderInput): Promise<QuestionPreviewDocumentResult> {
  let phase: QuestionPreviewPhase = 'input';

  try {
    // The HTTP layer already rejects POSTs in question-only mode; this guards
    // the programmatic `runtime.render()` seam.
    if (renderMode === 'question-only' && submissionInput != null) {
      throw new ExpectedQuestionPreviewError(
        'Submissions are not supported in question-only render mode.',
        { phase: 'input' },
      );
    }

    validateQuestionPreviewVariantSeed(variantSeed);

    phase = 'metadata';
    const info = await readQuestionInfo(courseDir, qid);
    const { caller, course, question } = makeLocalPreviewQuestionRows({
      courseDir,
      info,
      qid,
    });

    if (question.type !== 'Freeform') {
      throw new ExpectedQuestionPreviewError(
        `Unsupported preview question type: ${question.type ?? 'null'}. Only v3/Freeform questions can be rendered by the local preview server.`,
        {
          data: { qid: qid.decoded, questionType: question.type },
          phase: 'metadata',
        },
      );
    }

    const questionServer = questionServers.getModule(question.type);
    const preferences: Record<string, string | number | boolean> = {};

    phase = 'generate';
    const generateResult = await questionServer.generate(
      question,
      course,
      variantSeed,
      preferences,
      caller,
    );
    const generateIssues = generateResult.courseIssues;
    const sanitizePaths = [courseDir];
    const generateDiagnostics = diagnosticsFromIssues(generateIssues, 'generate', {
      sanitizePaths,
    });
    if (generateIssues.some((issue) => issue.fatal)) {
      return makeQuestionPreviewDocumentFailureResult(generateDiagnostics);
    }
    const generatedVariant = {
      broken: false,
      options: generateResult.data.options ?? {},
      params: generateResult.data.params ?? {},
      preferences,
      true_answer: generateResult.data.true_answer ?? {},
      variant_seed: variantSeed,
    };

    const workspaceSettings = makePreviewWorkspaceSettings(info);
    if (workspaceSettings != null) {
      // Mirrors variant creation in the full server: non-glob graded files
      // become required file names so `pl-workspace` can enforce them.
      const workspaceRequiredFileNames = workspaceSettings.gradedFiles.filter(
        (file) => !fg.isDynamicPattern(file, workspaceFastGlobDefaultOptions),
      );
      const requiredFileNames = generatedVariant.params._required_file_names;
      generatedVariant.params._workspace_required_file_names = workspaceRequiredFileNames;
      generatedVariant.params._required_file_names = (
        Array.isArray(requiredFileNames) ? requiredFileNames : []
      ).concat(workspaceRequiredFileNames);
    }

    phase = 'prepare';
    const prepareResult = await questionServer.prepare(question, course, generatedVariant, caller);
    const prepareIssues = prepareResult.courseIssues;
    const prepareDiagnostics = diagnosticsFromIssues(prepareIssues, 'prepare', {
      sanitizePaths,
    });
    if (prepareIssues.some((issue) => issue.fatal)) {
      return makeQuestionPreviewDocumentFailureResult([
        ...generateDiagnostics,
        ...prepareDiagnostics,
      ]);
    }
    const localPreviewVariantIdentity = localPreviewGeneratedFiles.createVariantIdentity();
    const preparedVariant = makeLocalPreviewVariant(
      variantSeed,
      {
        broken: false,
        options: prepareResult.data.options ?? generatedVariant.options,
        params: prepareResult.data.params,
        preferences,
        true_answer: prepareResult.data.true_answer,
      },
      { id: localPreviewVariantIdentity.id },
    );
    const file = questionServer.file;
    localPreviewGeneratedFiles.registerVariantFiles({
      file:
        file == null
          ? null
          : (filename) => file(filename, preparedVariant, null, question, course, caller),
      identity: localPreviewVariantIdentity,
    });

    // Without a workspace allocator the workspace URL stays a placeholder
    // `#`, so the question still renders with a non-functional button.
    let workspaceUrl = '#';
    if (workspaceSettings != null && localPreviewWorkspaces != null) {
      const workspace = localPreviewWorkspaces.ensureWorkspace({
        params: preparedVariant.params ?? {},
        qid: qid.decoded,
        settings: workspaceSettings,
        trueAnswer: preparedVariant.true_answer ?? {},
        variantSeed,
      });
      preparedVariant.workspace_id = workspace.workspaceId;
      workspaceUrl = workspace.workspaceUrl;
    }

    const checkAnswerSupported = question.grading_method === 'Internal';
    const submissionDiagnostics: QuestionPreviewDiagnostic[] = [];
    let submission: Submission | null = null;
    let unsupportedGradingMethod = false;

    if (submissionInput != null) {
      if (!checkAnswerSupported) {
        unsupportedGradingMethod = true;
      } else {
        phase = 'parse';
        const rawSubmittedAnswer = submissionInput.rawSubmittedAnswer;

        // Mirrors `saveSubmission` in the full server: the workspace's graded
        // files are injected into `submitted_answer._files` before parsing,
        // and file-collection failures become a `_files` format error. The
        // variant is regenerated from the seed on this request, but generate
        // and prepare are deterministic per seed, so the files come from the
        // same workspace the user edited.
        let submittedAnswer = rawSubmittedAnswer;
        let workspaceFormatErrors: Record<string, unknown> | undefined;
        if (
          workspaceSettings != null &&
          localPreviewWorkspaces != null &&
          workspaceSettings.gradedFiles.length > 0
        ) {
          const collected = await localPreviewWorkspaces.collectGradedFiles({
            qid: qid.decoded,
            variantSeed,
          });
          if (!collected.ok) {
            workspaceFormatErrors = { _files: [collected.formatError] };
          } else if (collected.files.length > 0) {
            const existingFiles = Array.isArray(rawSubmittedAnswer._files)
              ? rawSubmittedAnswer._files
              : [];
            submittedAnswer = {
              ...rawSubmittedAnswer,
              _files: [...existingFiles, ...collected.files],
            };
          }
        }

        const parseResult = await questionServer.parse(
          {
            submitted_answer: submittedAnswer,
            raw_submitted_answer: rawSubmittedAnswer,
            format_errors: workspaceFormatErrors,
            gradable: true,
          },
          preparedVariant,
          question,
          course,
          caller,
        );
        submissionDiagnostics.push(
          ...diagnosticsFromIssues(parseResult.courseIssues, 'parse', { sanitizePaths }),
        );
        if (parseResult.courseIssues.some((issue) => issue.fatal)) {
          return makeQuestionPreviewDocumentFailureResult([
            ...generateDiagnostics,
            ...prepareDiagnostics,
            ...submissionDiagnostics,
          ]);
        }

        // `params` and `true_answer` may legitimately change during `parse()`,
        // so carry them onto the variant like the full app persists them.
        preparedVariant.params = parseResult.data.params;
        preparedVariant.true_answer = parseResult.data.true_answer;
        submission = makeLocalPreviewSubmission(preparedVariant, {
          broken: false,
          feedback: parseResult.data.feedback,
          format_errors: parseResult.data.format_errors,
          gradable: parseResult.data.gradable,
          params: parseResult.data.params,
          partial_scores: null,
          raw_submitted_answer: parseResult.data.raw_submitted_answer,
          score: null,
          submitted_answer: parseResult.data.submitted_answer,
          true_answer: parseResult.data.true_answer,
        });

        if (submission.gradable) {
          phase = 'grade';
          const gradeResult = await questionServer.grade(
            submission,
            preparedVariant,
            question,
            course,
            caller,
          );
          submissionDiagnostics.push(
            ...diagnosticsFromIssues(gradeResult.courseIssues, 'grade', { sanitizePaths }),
          );
          if (gradeResult.courseIssues.some((issue) => issue.fatal)) {
            return makeQuestionPreviewDocumentFailureResult([
              ...generateDiagnostics,
              ...prepareDiagnostics,
              ...submissionDiagnostics,
            ]);
          }

          preparedVariant.params = gradeResult.data.params ?? preparedVariant.params;
          preparedVariant.true_answer = gradeResult.data.true_answer ?? preparedVariant.true_answer;
          submission = makeLocalPreviewSubmission(preparedVariant, {
            broken: false,
            feedback: gradeResult.data.feedback ?? {},
            format_errors: gradeResult.data.format_errors ?? {},
            gradable: gradeResult.data.gradable ?? false,
            params: preparedVariant.params,
            partial_scores: gradeResult.data.partial_scores ?? {},
            raw_submitted_answer: gradeResult.data.raw_submitted_answer ?? {},
            score: gradeResult.data.score ?? 0,
            submitted_answer: gradeResult.data.submitted_answer ?? {},
            true_answer: preparedVariant.true_answer,
            v2_score: gradeResult.data.v2_score,
          });
        }

        preparedVariant.num_tries = submission.gradable ? 1 : 0;
      }
    }

    const showCorrectAnswer =
      renderMode === 'full' && question.show_correct_answer === true && submission != null;

    phase = 'render';
    const renderResult = await questionServer.render({
      course,
      locals: makePreviewLocals({
        clientFilesQuestionGeneratedFileUrl: localPreviewVariantIdentity.generatedFilesUrl,
        qid,
        questionId: question.id,
        showCorrectAnswer,
        urlPrefix,
        workspaceUrl,
      }),
      question,
      renderSelection: {
        question: true,
        submissions: submission != null,
        answer: showCorrectAnswer,
      },
      submission,
      submissions: submission == null ? [] : [submission],
      variant: preparedVariant,
      caller,
    });
    const renderDiagnostics = diagnosticsFromIssues(renderResult.courseIssues, 'render', {
      sanitizePaths,
    });
    if (renderResult.courseIssues.some((issue) => issue.fatal)) {
      return makeQuestionPreviewDocumentFailureResult([
        ...generateDiagnostics,
        ...prepareDiagnostics,
        ...submissionDiagnostics,
        ...renderDiagnostics,
      ]);
    }

    const submissionPanel: QuestionPreviewSubmissionPanel | null = unsupportedGradingMethod
      ? { kind: 'unsupported-grading-method', gradingMethod: question.grading_method }
      : submission == null
        ? null
        : {
            kind: 'graded',
            submission,
            submissionHtml: renderResult.data.submissionHtmls[0] ?? '',
          };

    const extraHeadersHtml = renderResult.data.extraHeadersHtml;
    const shellHeadHtml = renderQuestionPreviewShellHeadHtml({
      extraHeadersHtml,
      pageTitle: question.title?.trim() || qid.decoded,
      questionType: question.type,
      urlPrefix,
    });
    const bodyHtml =
      renderMode === 'question-only'
        ? renderQuestionOnlyPreviewBodyHtml({
            questionHtml: renderResult.data.questionHtml,
            variant: preparedVariant,
          })
        : renderQuestionPreviewBodyHtml({
            answerHtml: renderResult.data.answerHtml,
            checkAnswerSupported,
            course,
            question,
            questionHtml: renderResult.data.questionHtml,
            showCorrectAnswer,
            submissionPanel,
            urlPrefix,
            variant: preparedVariant,
            variantToken: generateSignedToken(
              { variantId: preparedVariant.id.toString() },
              config.secretKey,
            ),
          });

    return makeQuestionPreviewSuccessResult({
      bodyHtml,
      diagnostics: [
        ...generateDiagnostics,
        ...prepareDiagnostics,
        ...submissionDiagnostics,
        ...renderDiagnostics,
      ],
      headHtml: shellHeadHtml,
    });
  } catch (err) {
    return makeQuestionPreviewDocumentFailureResult([diagnosticFromError(err, { phase })]);
  }
}

export function createQuestionPreviewDocumentRenderer({
  courseDir,
  localPreviewGeneratedFiles,
  localPreviewWorkspaces = null,
  renderMode = 'full',
  urlPrefix,
}: QuestionPreviewDocumentRendererOptions): QuestionPreviewDocumentRenderer {
  const resolvedCourseDir = path.resolve(courseDir);

  return {
    render(input) {
      return renderQuestionPreviewDocumentResult({
        courseDir: resolvedCourseDir,
        localPreviewGeneratedFiles,
        localPreviewWorkspaces,
        qid: input.qid,
        renderMode: input.renderMode ?? renderMode,
        submission: input.submission,
        urlPrefix,
        variantSeed: input.variantSeed,
      });
    },
  };
}
