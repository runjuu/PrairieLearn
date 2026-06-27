import fs from 'node:fs/promises';
import path from 'node:path';

import { html, unsafeHtml } from '@prairielearn/html';
import { generateSignedToken } from '@prairielearn/signed-token';

import { HeadContents } from '../../components/HeadContents.js';
import { QuestionHeadContents } from '../../components/QuestionHeadContents.js';
import * as questionServers from '../../question-servers/index.js';
import { type QuestionJson, QuestionJsonSchema } from '../../schemas/index.js';
import { config } from '../config.js';
import type { Question, Variant } from '../db-types.js';

import { makeQuestionPreviewAssetUrls } from './assets.js';
import { type LocalPreviewGeneratedFiles } from './generated-files.js';
import type { QuestionPreviewQid } from './qid.js';
import { makeLocalPreviewQuestionRows, makeLocalPreviewVariant } from './rows.js';

export interface QuestionPreviewDocumentInput {
  qid: QuestionPreviewQid;
  variantSeed?: string;
}

export interface QuestionPreviewDocumentRenderer {
  render(input: QuestionPreviewDocumentInput): Promise<QuestionPreviewDocumentResult>;
}

export interface QuestionPreviewDocumentRendererOptions {
  courseDir: string;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  urlPrefix: string;
}

export type QuestionPreviewPhase = 'input' | 'metadata' | 'generate' | 'prepare' | 'render';

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
  urlPrefix,
}: {
  clientFilesQuestionGeneratedFileUrl: string;
  qid: QuestionPreviewQid;
  questionId: string;
  urlPrefix: string;
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
    showCorrectAnswer: false,
    urlPrefix,
    workspaceUrl: '#',
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
    value === 'render'
  );
}

function renderQuestionPreviewShellHeadHtml({
  extraHeadersHtml,
  questionType,
  urlPrefix,
}: {
  extraHeadersHtml: string;
  questionType: Question['type'];
  urlPrefix: string;
}): string {
  return html`
    ${HeadContents({
      pageTitle: 'Question Preview',
      resLocals: {},
    })}
    ${QuestionHeadContents({ extraHeadersHtml, questionType, urlPrefix })}
  `.toString();
}

function renderQuestionPreviewBodyHtml({
  question,
  questionHtml,
  variant,
  variantToken,
}: {
  question: Question;
  questionHtml: string;
  variant: Variant;
  variantToken: string;
}): string {
  return html`
    <div
      class="question-container"
      data-grading-method="${question.grading_method}"
      data-variant-id="${variant.id}"
      data-variant-token="${variantToken}"
      data-workspace-id="${variant.workspace_id ?? ''}"
    >
      <form class="question-form" name="question-form" method="POST" autocomplete="off">
        <div class="question-body">${unsafeHtml(questionHtml)}</div>
      </form>
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
  qid,
  urlPrefix,
  variantSeed = '1',
}: QuestionPreviewInternalRenderInput): Promise<QuestionPreviewDocumentResult> {
  let phase: QuestionPreviewPhase = 'input';

  try {
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
          : (filename) => file(filename, preparedVariant, question, course, caller),
      identity: localPreviewVariantIdentity,
    });

    phase = 'render';
    const renderResult = await questionServer.render({
      course,
      locals: makePreviewLocals({
        clientFilesQuestionGeneratedFileUrl: localPreviewVariantIdentity.generatedFilesUrl,
        qid,
        questionId: question.id,
        urlPrefix,
      }),
      question,
      renderSelection: { question: true },
      submission: null,
      submissions: [],
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
        ...renderDiagnostics,
      ]);
    }

    const extraHeadersHtml = renderResult.data.extraHeadersHtml;
    const shellHeadHtml = renderQuestionPreviewShellHeadHtml({
      extraHeadersHtml,
      questionType: question.type,
      urlPrefix,
    });
    const bodyHtml = renderQuestionPreviewBodyHtml({
      question,
      questionHtml: renderResult.data.questionHtml,
      variant: preparedVariant,
      variantToken: generateSignedToken(
        { variantId: preparedVariant.id.toString() },
        config.secretKey,
      ),
    });

    return makeQuestionPreviewSuccessResult({
      bodyHtml,
      diagnostics: [...generateDiagnostics, ...prepareDiagnostics, ...renderDiagnostics],
      headHtml: shellHeadHtml,
    });
  } catch (err) {
    return makeQuestionPreviewDocumentFailureResult([diagnosticFromError(err, { phase })]);
  }
}

export function createQuestionPreviewDocumentRenderer({
  courseDir,
  localPreviewGeneratedFiles,
  urlPrefix,
}: QuestionPreviewDocumentRendererOptions): QuestionPreviewDocumentRenderer {
  const resolvedCourseDir = path.resolve(courseDir);

  return {
    render(input) {
      return renderQuestionPreviewDocumentResult({
        courseDir: resolvedCourseDir,
        localPreviewGeneratedFiles,
        qid: input.qid,
        urlPrefix,
        variantSeed: input.variantSeed,
      });
    },
  };
}
