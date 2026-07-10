import fg from 'fast-glob';

import { html, unsafeHtml } from '@prairielearn/html';
import { markdownToHtml } from '@prairielearn/markdown';
import { generateSignedToken } from '@prairielearn/signed-token';
import { workspaceFastGlobDefaultOptions } from '@prairielearn/workspace-utils';

import { HeadContents } from '../../components/HeadContents.js';
import { QuestionTitle } from '../../components/QuestionContainer.js';
import { QuestionHeadContents } from '../../components/QuestionHeadContents.js';
import { type SubmissionForRender, SubmissionPanel } from '../../components/SubmissionPanel.js';
import type * as questionServers from '../../question-servers/index.js';
import { CodeCallerPoolUnavailableError } from '../code-caller/code-caller-shared.js';
import { config } from '../config.js';
import type { Course, Question, Submission, Variant } from '../db-types.js';

import { makeQuestionPreviewAssetUrls } from './assets.js';
import {
  type LocalPreviewCourseSource,
  QuestionPreviewQuestionNotFoundError,
} from './course-source.js';
import { QuestionPreviewEngineGenerationError } from './engine-error.js';
import { ExpectedQuestionPreviewError, type QuestionPreviewPhase } from './expected-error.js';
import { type LocalPreviewGeneratedFiles } from './generated-files.js';
import type { QuestionPreviewQid } from './qid.js';
import {
  makeLocalPreviewQuestionRows,
  makeLocalPreviewSubmission,
  makeLocalPreviewVariant,
  makePreviewWorkspaceSettings,
} from './rows.js';
import {
  type QuestionPreviewSourceQuestionTypeAdapter,
  createQuestionPreviewSourceQuestionTypeAdapter,
} from './source-question-type-adapter.js';
import { type LocalPreviewSubmissionFiles, type PreviewSubmittedFile } from './submission-files.js';
import type { PreviewWorkspaceAllocator } from './workspace-launcher.js';

interface QuestionPreviewSubmissionInput {
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
  courseSource: LocalPreviewCourseSource;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewSubmissionFiles: LocalPreviewSubmissionFiles;
  localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
  renderMode?: QuestionPreviewRenderMode;
  urlPrefix: string;
}

export interface QuestionPreviewDiagnostic {
  data?: unknown;
  fatal: boolean;
  message: string;
  name: string;
  phase?: QuestionPreviewPhase;
  stack?: string;
}

interface QuestionPreviewDocumentSuccess {
  diagnostics: QuestionPreviewDiagnostic[];
  documentHtml: string;
  ok: true;
}

export interface QuestionPreviewDocumentFailure {
  diagnostics: QuestionPreviewDiagnostic[];
  documentHtml: string;
  reason: 'question-not-found' | 'render-failure';
  ok: false;
}

export type QuestionPreviewDocumentResult =
  | QuestionPreviewDocumentFailure
  | QuestionPreviewDocumentSuccess;

interface QuestionPreviewInternalRenderInput extends QuestionPreviewDocumentInput {
  courseSource: LocalPreviewCourseSource;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewSubmissionFiles: LocalPreviewSubmissionFiles;
  localPreviewWorkspaces: PreviewWorkspaceAllocator | null;
  renderMode: QuestionPreviewRenderMode;
  urlPrefix: string;
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
  courseSource: LocalPreviewCourseSource,
  phase?: QuestionPreviewPhase,
): QuestionPreviewDiagnostic[] {
  const engineFailure = issues.find(isCodeCallerPoolUnavailableFailure);
  if (engineFailure != null) {
    throw new QuestionPreviewEngineGenerationError('Question preview worker pool is unavailable.', {
      cause: engineFailure,
    });
  }

  return issues.map((issue) => ({
    data: courseSource.sanitizeDiagnosticValue(issue.data),
    fatal: issue.fatal ?? false,
    message: courseSource.sanitizeDiagnosticValue(issue.message) as string,
    name: issue.name,
    phase,
  }));
}

function isCodeCallerPoolUnavailableFailure(err: unknown): boolean {
  if (err instanceof CodeCallerPoolUnavailableError) return true;
  return err instanceof Error && isCodeCallerPoolUnavailableFailure(err.cause);
}

function diagnosticFromError(
  err: unknown,
  { courseSource, phase }: { courseSource: LocalPreviewCourseSource; phase: QuestionPreviewPhase },
): QuestionPreviewDiagnostic {
  if (err instanceof Error) {
    const errorPhase = 'phase' in err && isQuestionPreviewPhase(err.phase) ? err.phase : phase;

    return {
      data: 'data' in err ? courseSource.sanitizeDiagnosticValue(err.data) : undefined,
      fatal: 'fatal' in err && typeof err.fatal === 'boolean' ? err.fatal : true,
      message: courseSource.sanitizeDiagnosticValue(err.message) as string,
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
  questionAdapter,
  questionJsonBase64,
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
  questionAdapter: QuestionPreviewSourceQuestionTypeAdapter;
  questionJsonBase64: string | null;
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
      data-question-type="${question.type}"
    >
      ${questionJsonBase64 == null
        ? ''
        : html`<div hidden class="question-data">${questionJsonBase64}</div>`}
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
                    ${questionAdapter.kind === 'freeform'
                      ? html`name="__action" value="grade"`
                      : ''}
                  >
                    Save &amp; Grade
                  </button>
                  <input
                    type="hidden"
                    name="__variant_id"
                    value="${variant.id}"
                    data-skip-unload-check="true"
                  />
                  ${questionAdapter.kind === 'legacy'
                    ? html`
                        <input type="hidden" name="postData" class="postData" />
                        <input type="hidden" name="__action" class="__action" />
                      `
                    : ''}
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
  questionJsonBase64,
  questionType,
  variant,
}: {
  questionHtml: string;
  questionJsonBase64: string | null;
  questionType: Question['type'];
  variant: Variant;
}): string {
  return html`
    <div
      class="question-container"
      data-variant-id="${variant.id}"
      data-workspace-id="${variant.workspace_id ?? ''}"
      data-question-type="${questionType}"
    >
      ${questionJsonBase64 == null
        ? ''
        : html`<div hidden class="question-data">${questionJsonBase64}</div>`}
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
  reason: QuestionPreviewDocumentFailure['reason'] = 'render-failure',
): QuestionPreviewDocumentFailure {
  return {
    diagnostics,
    documentHtml: QUESTION_PREVIEW_ERROR_DOCUMENT,
    ok: false,
    reason,
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

function previewSubmittedFiles(
  submittedAnswer: Record<string, unknown> | null,
): PreviewSubmittedFile[] {
  const files = submittedAnswer?._files;
  if (!Array.isArray(files)) return [];

  const submittedFiles: PreviewSubmittedFile[] = [];
  for (const file of files) {
    if (file == null || typeof file !== 'object') continue;
    const { contents, name } = file as Record<string, unknown>;
    if (typeof contents === 'string' && typeof name === 'string') {
      submittedFiles.push({ contents, name });
    }
  }

  return submittedFiles;
}

async function renderQuestionPreviewDocumentResult({
  courseSource,
  localPreviewGeneratedFiles,
  localPreviewSubmissionFiles,
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
    let info;
    try {
      info = await courseSource.readQuestionInfo(qid);
    } catch (err) {
      if (err instanceof QuestionPreviewQuestionNotFoundError) {
        return makeQuestionPreviewDocumentFailureResult(
          [diagnosticFromError(err, { courseSource, phase })],
          'question-not-found',
        );
      }
      throw err;
    }
    const { caller, course, question } = makeLocalPreviewQuestionRows({
      courseSource,
      info,
      qid,
    });

    const questionAdapter = createQuestionPreviewSourceQuestionTypeAdapter({
      courseSource,
      info,
      qid,
      question,
    });
    const questionServer = questionAdapter.questionServer;
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
    const generateDiagnostics = diagnosticsFromIssues(generateIssues, courseSource, 'generate');
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
    const prepareDiagnostics = diagnosticsFromIssues(prepareIssues, courseSource, 'prepare');
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
        const rawSubmittedAnswer = questionAdapter.normalizeSubmittedAnswer(
          submissionInput.rawSubmittedAnswer,
        );

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
          ...diagnosticsFromIssues(parseResult.courseIssues, courseSource, 'parse'),
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
            ...diagnosticsFromIssues(gradeResult.courseIssues, courseSource, 'grade'),
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

    // The graded submission's files (workspace graded files and file uploads)
    // are held in an in-memory store keyed by a per-render submission id, so
    // `pl-file-preview` can download and inline-preview them for this render.
    // The freeform layer builds the file URLs from `submission.id`, so it must
    // be assigned before rendering.
    if (submission != null) {
      const submissionFiles = previewSubmittedFiles(submission.submitted_answer);
      if (submissionFiles.length > 0) {
        const submissionId = localPreviewSubmissionFiles.createSubmissionId();
        submission.id = submissionId;
        localPreviewSubmissionFiles.registerFiles({ files: submissionFiles, id: submissionId });
      }
    }

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
    const renderDiagnostics = diagnosticsFromIssues(
      renderResult.courseIssues,
      courseSource,
      'render',
    );
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
    const questionJsonBase64 = questionAdapter.makeLegacyQuestionJsonBase64({
      course,
      generatedFilesUrl: localPreviewVariantIdentity.generatedFilesUrl,
      questionFileUrl: `${urlPrefix}/questions/${qid.encodedPath}/legacy-files`,
      showCorrectAnswer,
      submission,
      submissions: submission == null ? [] : [submission],
      variant: preparedVariant,
    });
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
            questionJsonBase64,
            questionType: question.type,
            variant: preparedVariant,
          })
        : renderQuestionPreviewBodyHtml({
            answerHtml: renderResult.data.answerHtml,
            checkAnswerSupported,
            course,
            question,
            questionAdapter,
            questionHtml: renderResult.data.questionHtml,
            questionJsonBase64,
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
    if (err instanceof QuestionPreviewEngineGenerationError) throw err;
    if (isCodeCallerPoolUnavailableFailure(err)) {
      throw new QuestionPreviewEngineGenerationError(
        'Question preview worker pool is unavailable.',
        { cause: err },
      );
    }
    return makeQuestionPreviewDocumentFailureResult([
      diagnosticFromError(err, { courseSource, phase }),
    ]);
  }
}

export function createQuestionPreviewDocumentRenderer({
  courseSource,
  localPreviewGeneratedFiles,
  localPreviewSubmissionFiles,
  localPreviewWorkspaces = null,
  renderMode = 'full',
  urlPrefix,
}: QuestionPreviewDocumentRendererOptions): QuestionPreviewDocumentRenderer {
  return {
    render(input) {
      return renderQuestionPreviewDocumentResult({
        courseSource,
        localPreviewGeneratedFiles,
        localPreviewSubmissionFiles,
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
