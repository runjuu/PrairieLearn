import fs from 'node:fs/promises';
import path from 'node:path';

import { cache } from '@prairielearn/cache';
import { html, unsafeHtml } from '@prairielearn/html';
import { generateSignedToken } from '@prairielearn/signed-token';
import * as cheerio from 'cheerio';
import { isTag } from 'domhandler';

import { HeadContents } from '../components/HeadContents.js';
import { QuestionHeadContents } from '../components/QuestionHeadContents.js';
import * as freeformServer from '../question-servers/freeform.js';
import * as questionServers from '../question-servers/index.js';
import type { QuestionCaller } from '../question-servers/types.js';
import {
  type QuestionJson,
  QuestionJsonSchema,
  defaultWorkspaceOptions,
} from '../schemas/index.js';

import * as assets from './assets.js';
import * as codeCaller from './code-caller/index.js';
import { config } from './config.js';
import type { Course, Question, Variant } from './db-types.js';
import * as load from './load.js';

const PREVIEW_COURSE_ID = '1';
const PREVIEW_QUESTION_ID = '1';
const PREVIEW_VARIANT_ID = '1';
const PREVIEW_USER_ID = '1';
const DEFAULT_PREVIEW_URL_PREFIX = '/preview-render';

export type QuestionPreviewWorkersExecutionMode = 'native' | 'container';
export type QuestionPreviewCacheType = 'memory' | 'none' | 'redis';

export interface QuestionPreviewRuntimeOptions {
  cacheType?: QuestionPreviewCacheType;
  courseDir: string;
  devMode?: boolean;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  urlPrefix?: string;
  workersCount?: number;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewRuntimeRenderInput {
  qid: string;
  variantSeed?: string;
}

export interface QuestionPreviewGeneratedFilesOptions {
  renderId: string;
  root: string;
}

export interface QuestionPreviewRuntimeRenderOptions {
  generatedFiles?: QuestionPreviewGeneratedFilesOptions;
}

export interface QuestionPreviewInput
  extends QuestionPreviewRuntimeOptions, QuestionPreviewRuntimeRenderInput {}

interface QuestionPreviewInternalRenderInput extends QuestionPreviewRuntimeRenderInput {
  courseDir: string;
  generatedFiles?: QuestionPreviewGeneratedFilesOptions;
  urlPrefix: string;
}

export interface QuestionPreviewRuntime {
  close(): Promise<void>;
  render(
    input: QuestionPreviewRuntimeRenderInput,
    options?: QuestionPreviewRuntimeRenderOptions,
  ): Promise<QuestionPreviewResult>;
}

export interface QuestionPreviewDiagnostic {
  data?: unknown;
  fatal: boolean;
  message: string;
  name: string;
  phase?: QuestionPreviewPhase;
  stack?: string;
}

type QuestionPreviewPhase = 'input' | 'metadata' | 'generate' | 'prepare' | 'render';

export interface QuestionPreviewPayload {
  bodyHtml: string;
  headHtml: string;
  variant: {
    seed: string;
  };
}

export interface QuestionPreviewSuccessEnvelope {
  diagnostics: QuestionPreviewDiagnostic[];
  ok: true;
  payload: QuestionPreviewPayload;
}

export interface QuestionPreviewFailureEnvelope {
  diagnostics: QuestionPreviewDiagnostic[];
  ok: false;
}

export type QuestionPreviewResult = QuestionPreviewFailureEnvelope | QuestionPreviewSuccessEnvelope;

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

function normalizeExternalEntrypoint(entrypoint: string | string[] | undefined): string | null {
  if (entrypoint == null) return null;
  if (Array.isArray(entrypoint)) return entrypoint.join(' ');
  return entrypoint;
}

function normalizeWorkspaceArgs(args: string | string[] | undefined): string | null {
  if (args == null) return null;
  if (Array.isArray(args)) return args.join(' ');
  return args;
}

function validateQuestionPreviewWorkersExecutionMode(
  mode: string,
): asserts mode is QuestionPreviewWorkersExecutionMode {
  if (mode !== 'native' && mode !== 'container') {
    throw new Error(`Invalid workersExecutionMode "${mode}". Expected "native" or "container".`);
  }
}

export function makePreviewCourse(courseDir: string): Course {
  const now = new Date();

  return {
    ai_grading_free_credit_redemptions_used: 0,
    announcement_color: null,
    announcement_html: null,
    branch: 'preview-render',
    commit_hash: null,
    course_instance_enrollment_limit: null,
    created_at: now,
    deleted_at: null,
    display_timezone: 'America/Vancouver',
    draft_number: 0,
    example_course: false,
    id: PREVIEW_COURSE_ID,
    institution_id: '1',
    json_comment: null,
    options: {},
    path: courseDir,
    questions_receive_user_data: false,
    repository: null,
    sharing_name: null,
    sharing_token: 'preview-render',
    short_name: 'preview-render',
    show_getting_started: false,
    sync_errors: null,
    sync_job_sequence_id: null,
    sync_warnings: null,
    template_course: false,
    title: 'Preview render course',
    yearly_enrollment_limit: null,
  };
}

function makePreviewQuestionCaller(course: Course): QuestionCaller {
  return {
    effectiveUserId: null,
    groupId: null,
    variantCourse: { id: course.id },
  };
}

export function makePreviewQuestion(qid: string, info: QuestionJson): Question {
  const workspaceOptions = info.workspaceOptions ?? defaultWorkspaceOptions;
  const partialCredit = info.partialCredit ?? (info.type === 'v3' ? true : false);

  return {
    client_files: info.clientFiles,
    course_id: PREVIEW_COURSE_ID,
    deleted_at: null,
    dependencies: info.dependencies,
    directory: qid,
    draft: false,
    external_grading_enable_networking: info.externalGradingOptions?.enableNetworking ?? false,
    external_grading_entrypoint: normalizeExternalEntrypoint(
      info.externalGradingOptions?.entrypoint,
    ),
    external_grading_environment: info.externalGradingOptions?.environment ?? {},
    external_grading_files: info.externalGradingOptions?.serverFilesCourse ?? [],
    external_grading_image: info.externalGradingOptions?.image ?? null,
    external_grading_timeout: info.externalGradingOptions?.timeout ?? null,
    grading_method: info.gradingMethod,
    id: PREVIEW_QUESTION_ID,
    json_comment: info.comment ?? null,
    json_external_grading_comment: info.externalGradingOptions?.comment ?? null,
    json_workspace_comment: workspaceOptions.comment ?? null,
    number: null,
    options: info.options ?? null,
    partial_credit: partialCredit,
    preferences_schema: info.preferences ?? null,
    qid,
    share_publicly: info.sharePublicly,
    share_source_publicly: info.shareSourcePublicly,
    show_correct_answer: info.showCorrectAnswer,
    single_variant: info.singleVariant,
    sync_errors: null,
    sync_job_sequence_id: null,
    sync_warnings: null,
    template_directory: info.template ?? null,
    title: info.title,
    topic_id: null,
    type: info.type === 'v3' ? 'Freeform' : info.type,
    uuid: info.uuid,
    workspace_args: normalizeWorkspaceArgs(workspaceOptions.args),
    workspace_enable_networking: workspaceOptions.enableNetworking,
    workspace_environment: workspaceOptions.environment,
    workspace_graded_files: workspaceOptions.gradedFiles,
    workspace_home: workspaceOptions.home ?? null,
    workspace_image: workspaceOptions.image ?? null,
    workspace_port: workspaceOptions.port ?? null,
    workspace_url_rewrite: workspaceOptions.rewriteUrl,
  };
}

export function makePreviewVariant(
  variantSeed: string,
  data: {
    broken: boolean;
    options: Record<string, unknown>;
    params: Record<string, unknown>;
    preferences: Record<string, string | number | boolean>;
    true_answer: Record<string, unknown>;
  },
): Variant {
  const now = new Date();

  return {
    authn_user_id: PREVIEW_USER_ID,
    broken: data.broken,
    broken_at: data.broken ? now : null,
    broken_by: data.broken ? PREVIEW_USER_ID : null,
    client_fingerprint_id: null,
    course_id: PREVIEW_COURSE_ID,
    course_instance_id: null,
    date: now,
    duration: null,
    first_duration: null,
    id: PREVIEW_VARIANT_ID,
    instance_question_id: null,
    modified_at: now,
    num_tries: 0,
    number: 1,
    open: true,
    options: data.options,
    params: data.params,
    preferences: data.preferences,
    question_id: PREVIEW_QUESTION_ID,
    team_id: null,
    true_answer: data.true_answer,
    user_id: PREVIEW_USER_ID,
    variant_seed: variantSeed,
    workspace_id: null,
  };
}

function assetUrlPath(pathSegments: string[]) {
  return pathSegments.map(encodeURIComponent).join('/');
}

export function makePreviewGeneratedFilesUrl(urlPrefix: string, renderId: string) {
  return `${urlPrefix}/generatedFilesQuestion/render/${encodeURIComponent(renderId)}`;
}

export function makePreviewLocals(
  urlPrefix: string,
  qid: string,
  renderId?: string,
): questionServers.QuestionRenderRequiredLocals {
  return {
    allowAnswerEditing: true,
    baseUrl: urlPrefix,
    clientFilesCourseUrl: `${urlPrefix}/clientFilesCourse`,
    clientFilesQuestionGeneratedFileUrl:
      renderId == null
        ? `${urlPrefix}/generatedFilesQuestion/variant/${PREVIEW_VARIANT_ID}`
        : makePreviewGeneratedFilesUrl(urlPrefix, renderId),
    clientFilesQuestionUrl: `${urlPrefix}/questions/${assetUrlPath(qid.split('/'))}/files`,
    externalImageCaptureUrl: null,
    questionUrl: `${urlPrefix}/question/${PREVIEW_QUESTION_ID}/`,
    showCorrectAnswer: false,
    urlPrefix,
    workspaceUrl: undefined,
  };
}

export function diagnosticsFromIssues(
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

export function renderQuestionPreviewShellHeadHtml({
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

export function renderQuestionPreviewBodyHtml({
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

export function makeQuestionPreviewSuccessEnvelope({
  bodyHtml,
  diagnostics,
  headHtml,
  variantSeed,
}: {
  bodyHtml: string;
  diagnostics: QuestionPreviewDiagnostic[];
  headHtml: string;
  variantSeed: string;
}): QuestionPreviewSuccessEnvelope {
  return {
    diagnostics,
    ok: true,
    payload: {
      bodyHtml,
      headHtml,
      variant: {
        seed: variantSeed,
      },
    },
  };
}

function makeQuestionPreviewFailureEnvelope(
  diagnostics: QuestionPreviewDiagnostic[],
): QuestionPreviewFailureEnvelope {
  return {
    diagnostics,
    ok: false,
  };
}

function isPathInsideRoot(root: string, filePath: string) {
  const relativePath = path.relative(root, filePath);
  return (
    relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function decodeGeneratedFilePathSegments(encodedPath: string) {
  if (encodedPath.length === 0) return null;

  const decodedSegments: string[] = [];
  for (const segment of encodedPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }

    if (
      decoded.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\0') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      path.isAbsolute(decoded)
    ) {
      return null;
    }

    decodedSegments.push(decoded);
  }

  return decodedSegments;
}

function extractGeneratedFilePathSegments(htmlContent: string, generatedFilesUrl: string) {
  const $ = cheerio.load(htmlContent);
  const generatedFilesPathname = new URL(generatedFilesUrl, 'http://preview.local').pathname;
  const generatedFilesPathPrefix = `${generatedFilesPathname}/`;
  const pathsByName = new Map<string, string[]>();

  $('*').each((_, element) => {
    if (!isTag(element)) return;

    for (const value of Object.values(element.attribs)) {
      let pathname: string;
      try {
        pathname = new URL(value, 'http://preview.local').pathname;
      } catch {
        continue;
      }

      if (!pathname.startsWith(generatedFilesPathPrefix)) continue;

      const segments = decodeGeneratedFilePathSegments(
        pathname.slice(generatedFilesPathPrefix.length),
      );
      if (segments == null) continue;

      pathsByName.set(segments.join('/'), segments);
    }
  });

  return [...pathsByName.values()];
}

async function writeGeneratedPreviewFiles({
  caller,
  course,
  generatedFiles,
  generatedFilesUrl,
  htmlContent,
  question,
  questionServer,
  sanitizePaths,
  variant,
}: {
  caller: QuestionCaller;
  course: Course;
  generatedFiles: QuestionPreviewGeneratedFilesOptions;
  generatedFilesUrl: string;
  htmlContent: string;
  question: Question;
  questionServer: questionServers.QuestionServer;
  sanitizePaths: string[];
  variant: Variant;
}) {
  const generatedFilePaths = extractGeneratedFilePathSegments(htmlContent, generatedFilesUrl);
  if (generatedFilePaths.length === 0) return [];

  if (questionServer.file == null) {
    return [
      {
        fatal: true,
        message:
          'Question preview generated-file URL found, but the question type has no file() handler.',
        name: 'Error',
        phase: 'render' as const,
      },
    ];
  }

  const renderRoot = path.resolve(generatedFiles.root, generatedFiles.renderId);
  const diagnostics: QuestionPreviewDiagnostic[] = [];

  for (const fileSegments of generatedFilePaths) {
    const outputPath = path.resolve(renderRoot, ...fileSegments);
    if (!isPathInsideRoot(renderRoot, outputPath)) {
      diagnostics.push({
        data: { filename: fileSegments.join('/') },
        fatal: true,
        message: 'Generated file path resolves outside the render-scoped generated-file directory.',
        name: 'Error',
        phase: 'render',
      });
      continue;
    }

    const fileResult = await questionServer.file(
      fileSegments.join('/'),
      variant,
      question,
      course,
      caller,
    );
    const fileDiagnostics = diagnosticsFromIssues(fileResult.courseIssues, 'render', {
      sanitizePaths,
    });
    diagnostics.push(...fileDiagnostics);

    if (fileResult.courseIssues.some((issue) => issue.fatal)) continue;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, fileResult.data);
  }

  return diagnostics;
}

function validateQuestionPreviewQid(qid: string) {
  const segments = qid.split('/');

  if (
    qid.length === 0 ||
    qid.startsWith('/') ||
    qid.includes('\\') ||
    qid.includes('\0') ||
    path.isAbsolute(qid) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new ExpectedQuestionPreviewError(
      'Invalid question id. Expected a relative qid below the course questions directory.',
      {
        data: { qid },
        phase: 'input',
      },
    );
  }
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

async function readQuestionInfo(courseDir: string, qid: string): Promise<QuestionJson> {
  const infoPath = path.join(courseDir, 'questions', qid, 'info.json');
  let contents: string;

  try {
    contents = await fs.readFile(infoPath, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new ExpectedQuestionPreviewError(`Question "${qid}" is missing info.json.`, {
        data: { qid },
        phase: 'metadata',
      });
    }

    throw err;
  }

  let rawInfo: unknown;
  try {
    rawInfo = JSON.parse(contents);
  } catch {
    throw new ExpectedQuestionPreviewError(`Question "${qid}" has invalid info.json JSON.`, {
      data: { qid },
      phase: 'metadata',
    });
  }

  const parsed = QuestionJsonSchema.safeParse(rawInfo);
  if (!parsed.success) {
    throw new ExpectedQuestionPreviewError(`Question "${qid}" has invalid info.json metadata.`, {
      data: { issues: parsed.error.issues, qid },
      phase: 'metadata',
    });
  }

  return parsed.data;
}

async function initPrairieLearnForQuestionPreview({
  cacheType = 'none',
  devMode = false,
  mode,
  prewarmWorkers = false,
  questionTimeoutMilliseconds = 5000,
  workersCount = 1,
}: {
  cacheType?: QuestionPreviewCacheType;
  devMode?: boolean;
  mode: QuestionPreviewWorkersExecutionMode;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  workersCount?: number;
}) {
  validateQuestionPreviewWorkersExecutionMode(mode);

  config.cacheType = cacheType;
  config.chunksConsumer = false;
  config.devMode = devMode;
  config.ensureExecutorImageAtStartup = mode === 'container';
  config.questionTimeoutMilliseconds = questionTimeoutMilliseconds;
  config.reportIntervalSec = 0;
  config.workersCount = workersCount;
  config.workersExecutionMode = mode;

  await cache.init({
    keyPrefix: config.cacheKeyPrefix,
    redisUrl: config.redisUrl,
    type: config.cacheType,
  });
  await assets.init();
  await freeformServer.init();
  await codeCaller.init({ lazyWorkers: !prewarmWorkers });
}

async function closePrairieLearnForQuestionPreview() {
  await codeCaller.finish();
  await assets.close();
  await cache.close();
  load.close();
}

async function renderQuestionPreviewInRuntime({
  courseDir,
  generatedFiles,
  qid,
  urlPrefix,
  variantSeed = '1',
}: QuestionPreviewInternalRenderInput): Promise<QuestionPreviewResult> {
  let phase: QuestionPreviewPhase = 'input';

  try {
    validateQuestionPreviewQid(qid);
    validateQuestionPreviewVariantSeed(variantSeed);

    phase = 'metadata';
    const resolvedCourseDir = path.resolve(courseDir);
    const info = await readQuestionInfo(resolvedCourseDir, qid);
    const course = makePreviewCourse(resolvedCourseDir);
    const caller = makePreviewQuestionCaller(course);
    const question = makePreviewQuestion(qid, info);

    if (question.type !== 'Freeform') {
      throw new ExpectedQuestionPreviewError(
        `Unsupported preview question type: ${question.type ?? 'null'}. Only v3/Freeform questions can be rendered by the local preview server.`,
        {
          data: { qid, questionType: question.type },
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
    const sanitizePaths = [resolvedCourseDir];
    const generateDiagnostics = diagnosticsFromIssues(generateIssues, 'generate', {
      sanitizePaths,
    });
    if (generateIssues.some((issue) => issue.fatal)) {
      return makeQuestionPreviewFailureEnvelope(generateDiagnostics);
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
      return makeQuestionPreviewFailureEnvelope([...generateDiagnostics, ...prepareDiagnostics]);
    }
    const preparedVariant = makePreviewVariant(variantSeed, {
      broken: false,
      options: prepareResult.data.options ?? generatedVariant.options,
      params: prepareResult.data.params,
      preferences,
      true_answer: prepareResult.data.true_answer,
    });

    phase = 'render';
    const generatedFilesUrl =
      generatedFiles == null
        ? null
        : makePreviewGeneratedFilesUrl(urlPrefix, generatedFiles.renderId);
    const renderResult = await questionServer.render({
      course,
      locals: makePreviewLocals(urlPrefix, qid, generatedFiles?.renderId),
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
      return makeQuestionPreviewFailureEnvelope([
        ...generateDiagnostics,
        ...prepareDiagnostics,
        ...renderDiagnostics,
      ]);
    }
    const generatedFileDiagnostics =
      generatedFiles == null || generatedFilesUrl == null
        ? []
        : await writeGeneratedPreviewFiles({
            caller,
            course,
            generatedFiles,
            generatedFilesUrl,
            htmlContent: [renderResult.data.extraHeadersHtml, renderResult.data.questionHtml].join(
              '\n',
            ),
            question,
            questionServer,
            sanitizePaths,
            variant: preparedVariant,
          });
    if (generatedFileDiagnostics.some((diagnostic) => diagnostic.fatal)) {
      return makeQuestionPreviewFailureEnvelope([
        ...generateDiagnostics,
        ...prepareDiagnostics,
        ...renderDiagnostics,
        ...generatedFileDiagnostics,
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

    return makeQuestionPreviewSuccessEnvelope({
      bodyHtml,
      diagnostics: [
        ...generateDiagnostics,
        ...prepareDiagnostics,
        ...renderDiagnostics,
        ...generatedFileDiagnostics,
      ],
      headHtml: shellHeadHtml,
      variantSeed: preparedVariant.variant_seed,
    });
  } catch (err) {
    return makeQuestionPreviewFailureEnvelope([diagnosticFromError(err, { phase })]);
  }
}

class InitializedQuestionPreviewRuntime implements QuestionPreviewRuntime {
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly courseDir: string,
    private readonly urlPrefix: string,
  ) {}

  async render(
    input: QuestionPreviewRuntimeRenderInput,
    options?: QuestionPreviewRuntimeRenderOptions,
  ): Promise<QuestionPreviewResult> {
    if (this.closed) {
      throw new Error('Question preview runtime is already closed.');
    }

    const processScopedFields = [
      'cacheType',
      'courseDir',
      'devMode',
      'prewarmWorkers',
      'questionTimeoutMilliseconds',
      'urlPrefix',
      'workersCount',
      'workersExecutionMode',
    ].filter((field) => Object.hasOwn(input, field));
    if (processScopedFields.length > 0) {
      return makeQuestionPreviewFailureEnvelope([
        {
          data: { fields: processScopedFields },
          fatal: true,
          message: `Render requests cannot override startup-scoped preview configuration: ${processScopedFields.join(', ')}.`,
          name: 'Error',
          phase: 'input',
        },
      ]);
    }

    return renderQuestionPreviewInRuntime({
      ...input,
      courseDir: this.courseDir,
      generatedFiles: options?.generatedFiles,
      urlPrefix: this.urlPrefix,
    });
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = closePrairieLearnForQuestionPreview();
    }

    return this.closePromise;
  }
}

export async function createQuestionPreviewRuntime({
  cacheType = 'none',
  courseDir,
  devMode = false,
  prewarmWorkers = false,
  questionTimeoutMilliseconds = 5000,
  urlPrefix = DEFAULT_PREVIEW_URL_PREFIX,
  workersCount = 1,
  workersExecutionMode = 'native',
}: QuestionPreviewRuntimeOptions): Promise<QuestionPreviewRuntime> {
  validateQuestionPreviewWorkersExecutionMode(workersExecutionMode);
  await initPrairieLearnForQuestionPreview({
    cacheType,
    devMode,
    mode: workersExecutionMode,
    prewarmWorkers,
    questionTimeoutMilliseconds,
    workersCount,
  });
  return new InitializedQuestionPreviewRuntime(path.resolve(courseDir), urlPrefix);
}

export async function renderQuestionPreview(
  input: QuestionPreviewInput,
): Promise<QuestionPreviewResult> {
  const runtime = await createQuestionPreviewRuntime({
    cacheType: input.cacheType,
    courseDir: input.courseDir,
    devMode: input.devMode,
    prewarmWorkers: input.prewarmWorkers,
    questionTimeoutMilliseconds: input.questionTimeoutMilliseconds,
    urlPrefix: input.urlPrefix,
    workersCount: input.workersCount,
    workersExecutionMode: input.workersExecutionMode,
  });

  try {
    return await runtime.render({
      qid: input.qid,
      variantSeed: input.variantSeed,
    });
  } finally {
    await runtime.close();
  }
}
