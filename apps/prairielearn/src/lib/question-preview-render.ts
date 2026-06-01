import fs from 'node:fs/promises';
import path from 'node:path';

import { cache } from '@prairielearn/cache';
import { html, unsafeHtml } from '@prairielearn/html';
import { generateSignedToken } from '@prairielearn/signed-token';

import { HeadContents } from '../components/HeadContents.js';
import { QuestionHeadContents } from '../components/QuestionHeadContents.js';
import * as questionServers from '../question-servers/index.js';
import * as freeformServer from '../question-servers/freeform.js';
import {
  defaultWorkspaceOptions,
  QuestionJsonSchema,
  type QuestionJson,
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

export interface QuestionPreviewInput {
  courseDir: string;
  qid: string;
  variantSeed?: string;
  urlPrefix?: string;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export type QuestionPreviewRuntimeRenderInput = Omit<QuestionPreviewInput, 'workersExecutionMode'>;

export interface QuestionPreviewRuntimeOptions {
  prewarmWorkers?: boolean;
  urlPrefix?: string;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewRuntime {
  close(): Promise<void>;
  render(input: QuestionPreviewRuntimeRenderInput): Promise<QuestionPreviewResult>;
}

export interface QuestionPreviewDiagnostic {
  data?: unknown;
  fatal?: boolean;
  message: string;
  name: string;
  stack?: string;
}

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

export type QuestionPreviewResult = QuestionPreviewSuccessEnvelope;

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
    workspace_environment: workspaceOptions.environment ?? null,
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

export function makePreviewLocals(urlPrefix: string): questionServers.QuestionRenderRequiredLocals {
  return {
    allowAnswerEditing: true,
    baseUrl: urlPrefix,
    clientFilesCourseUrl: `${urlPrefix}/clientFilesCourse`,
    clientFilesQuestionGeneratedFileUrl: `${urlPrefix}/generatedFilesQuestion/variant/${PREVIEW_VARIANT_ID}`,
    clientFilesQuestionUrl: `${urlPrefix}/clientFilesQuestion`,
    externalImageCaptureUrl: null,
    questionUrl: `${urlPrefix}/question/${PREVIEW_QUESTION_ID}/`,
    showCorrectAnswer: false,
    urlPrefix,
    workspaceUrl: undefined,
  };
}

export function diagnosticsFromIssues(
  issues: (Error & { fatal?: boolean; data?: unknown })[],
): QuestionPreviewDiagnostic[] {
  return issues.map((issue) => ({
    data: issue.data,
    fatal: issue.fatal,
    message: issue.message,
    name: issue.name,
    stack: issue.stack,
  }));
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

async function readQuestionInfo(courseDir: string, qid: string): Promise<QuestionJson> {
  const infoPath = path.join(courseDir, 'questions', qid, 'info.json');
  const rawInfo = JSON.parse(await fs.readFile(infoPath, 'utf8'));
  return QuestionJsonSchema.parse(rawInfo);
}

async function initPrairieLearnForQuestionPreview({
  mode,
  prewarmWorkers = false,
}: {
  mode: QuestionPreviewWorkersExecutionMode;
  prewarmWorkers?: boolean;
}) {
  validateQuestionPreviewWorkersExecutionMode(mode);

  config.cacheType = 'none';
  config.chunksConsumer = false;
  config.devMode = false;
  config.ensureExecutorImageAtStartup = mode === 'container';
  config.questionTimeoutMilliseconds = 5000;
  config.reportIntervalSec = 0;
  config.workersCount = 1;
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
  qid,
  urlPrefix,
  variantSeed = '1',
}: QuestionPreviewRuntimeRenderInput & {
  urlPrefix: string;
  workersExecutionMode: QuestionPreviewWorkersExecutionMode;
}): Promise<QuestionPreviewResult> {
  const resolvedCourseDir = path.resolve(courseDir);
  const info = await readQuestionInfo(resolvedCourseDir, qid);
  const course = makePreviewCourse(resolvedCourseDir);
  const question = makePreviewQuestion(qid, info);

  if (question.type !== 'Freeform') {
    throw new Error(`Unsupported preview question type: ${question.type ?? 'null'}`);
  }

  const questionServer = questionServers.getModule(question.type);
  const preferences: Record<string, string | number | boolean> = {};

  const generateResult = await questionServer.generate(question, course, variantSeed, preferences);
  const generateIssues = generateResult.courseIssues;
  const generatedVariant = {
    broken: generateIssues.some((issue) => issue.fatal),
    options: generateResult.data.options ?? {},
    params: generateResult.data.params ?? {},
    preferences,
    true_answer: generateResult.data.true_answer ?? {},
    variant_seed: variantSeed,
  };

  const prepareResult = generatedVariant.broken
    ? null
    : await questionServer.prepare(question, course, generatedVariant);
  const prepareIssues = prepareResult?.courseIssues ?? [];
  const allPreRenderIssues = [...generateIssues, ...prepareIssues];
  const preparedVariant = makePreviewVariant(variantSeed, {
    broken: allPreRenderIssues.some((issue) => issue.fatal),
    options: prepareResult?.data.options ?? generatedVariant.options,
    params: prepareResult?.data.params ?? generatedVariant.params,
    preferences,
    true_answer: prepareResult?.data.true_answer ?? generatedVariant.true_answer,
  });

  const renderResult = await questionServer.render({
    course,
    locals: makePreviewLocals(urlPrefix),
    question,
    renderSelection: { question: true },
    submission: null,
    submissions: [],
    variant: preparedVariant,
  });

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
    variantToken: generateSignedToken({ variantId: preparedVariant.id.toString() }, config.secretKey),
  });

  return makeQuestionPreviewSuccessEnvelope({
    bodyHtml,
    diagnostics: diagnosticsFromIssues([...allPreRenderIssues, ...renderResult.courseIssues]),
    headHtml: shellHeadHtml,
    variantSeed: preparedVariant.variant_seed,
  });
}

class InitializedQuestionPreviewRuntime implements QuestionPreviewRuntime {
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly urlPrefix: string,
    private readonly workersExecutionMode: QuestionPreviewWorkersExecutionMode,
  ) {}

  async render(input: QuestionPreviewRuntimeRenderInput): Promise<QuestionPreviewResult> {
    if (this.closed) {
      throw new Error('Question preview runtime is already closed.');
    }

    return renderQuestionPreviewInRuntime({
      ...input,
      urlPrefix: input.urlPrefix ?? this.urlPrefix,
      workersExecutionMode: this.workersExecutionMode,
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
  prewarmWorkers = false,
  urlPrefix = DEFAULT_PREVIEW_URL_PREFIX,
  workersExecutionMode = 'native',
}: QuestionPreviewRuntimeOptions = {}): Promise<QuestionPreviewRuntime> {
  validateQuestionPreviewWorkersExecutionMode(workersExecutionMode);
  await initPrairieLearnForQuestionPreview({
    mode: workersExecutionMode,
    prewarmWorkers,
  });
  return new InitializedQuestionPreviewRuntime(urlPrefix, workersExecutionMode);
}

export async function renderQuestionPreview(
  input: QuestionPreviewInput,
): Promise<QuestionPreviewResult> {
  const runtime = await createQuestionPreviewRuntime({
    urlPrefix: input.urlPrefix,
    workersExecutionMode: input.workersExecutionMode,
  });

  try {
    return await runtime.render(input);
  } finally {
    await runtime.close();
  }
}
