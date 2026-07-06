import path from 'node:path';

import { cache } from '@prairielearn/cache';

import * as freeformServer from '../../question-servers/freeform.js';
import * as assets from '../assets.js';
import * as codeCaller from '../code-caller/index.js';
import { config } from '../config.js';
import * as load from '../load.js';

import {
  type QuestionPreviewDocumentInput,
  type QuestionPreviewDocumentRenderer,
  type QuestionPreviewDocumentResult,
  type QuestionPreviewRenderMode,
  createQuestionPreviewDocumentRenderer,
  makeQuestionPreviewDocumentFailureResult,
} from './document.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { parseQuestionPreviewQid } from './qid.js';
import { LocalPreviewSubmissionFiles } from './submission-files.js';
import type { PreviewWorkspaceAllocator } from './workspace-launcher.js';

const DEFAULT_PREVIEW_URL_PREFIX = '/preview-render';

export type QuestionPreviewWorkersExecutionMode = 'native' | 'container';
export type QuestionPreviewCacheType = 'memory' | 'none' | 'redis';
export type QuestionPreviewStartupLogger = (message: string) => void;

export interface QuestionPreviewRuntimeStartupOptions {
  cacheType?: QuestionPreviewCacheType;
  courseDir: string;
  devMode?: boolean;
  localPreviewGeneratedFiles?: LocalPreviewGeneratedFiles;
  localPreviewSubmissionFiles?: LocalPreviewSubmissionFiles;
  localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  renderMode?: QuestionPreviewRenderMode;
  startupLogger?: QuestionPreviewStartupLogger;
  urlPrefix?: string;
  workersCount?: number;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewInput extends Omit<
  QuestionPreviewRuntimeStartupOptions,
  'localPreviewGeneratedFiles' | 'localPreviewSubmissionFiles' | 'localPreviewWorkspaces'
> {
  qid: string;
  variantSeed?: string;
}

export interface QuestionPreviewRuntime {
  close(): Promise<void>;
  render(input: QuestionPreviewDocumentInput): Promise<QuestionPreviewDocumentResult>;
}

function validateQuestionPreviewWorkersExecutionMode(
  mode: string,
): asserts mode is QuestionPreviewWorkersExecutionMode {
  if (mode !== 'native' && mode !== 'container') {
    throw new Error(`Invalid workersExecutionMode "${mode}". Expected "native" or "container".`);
  }
}

async function initPrairieLearnForQuestionPreview({
  cacheType = 'none',
  devMode = false,
  mode,
  prewarmWorkers = false,
  questionTimeoutMilliseconds = 5000,
  startupLogger,
  workersCount = 1,
}: {
  cacheType?: QuestionPreviewCacheType;
  devMode?: boolean;
  mode: QuestionPreviewWorkersExecutionMode;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  startupLogger?: QuestionPreviewStartupLogger;
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

  startupLogger?.(`Initializing preview cache (${cacheType}).`);
  await cache.init({
    keyPrefix: config.cacheKeyPrefix,
    redisUrl: config.redisUrl,
    type: config.cacheType,
  });

  startupLogger?.('Loading PrairieLearn assets.');
  await assets.init();

  startupLogger?.('Loading PrairieLearn elements.');
  await freeformServer.init();

  startupLogger?.(
    prewarmWorkers
      ? `Starting ${workersCount} Python worker${workersCount === 1 ? '' : 's'} (${mode} mode).`
      : `Preparing Python worker pool (${mode} mode, workers start on first request).`,
  );
  await codeCaller.init({ lazyWorkers: !prewarmWorkers });

  startupLogger?.('PrairieLearn runtime initialized.');
}

async function closePrairieLearnForQuestionPreview() {
  await codeCaller.finish();
  await assets.close();
  await cache.close();
  load.close();
}

class InitializedQuestionPreviewRuntime implements QuestionPreviewRuntime {
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly documentRenderer: QuestionPreviewDocumentRenderer) {}

  async render(input: QuestionPreviewDocumentInput): Promise<QuestionPreviewDocumentResult> {
    if (this.closed) {
      throw new Error('Question preview runtime is already closed.');
    }

    return this.documentRenderer.render(input);
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
  localPreviewGeneratedFiles,
  localPreviewSubmissionFiles,
  localPreviewWorkspaces = null,
  prewarmWorkers = false,
  questionTimeoutMilliseconds = 5000,
  renderMode = 'full',
  startupLogger,
  urlPrefix = DEFAULT_PREVIEW_URL_PREFIX,
  workersCount = 1,
  workersExecutionMode = 'container',
}: QuestionPreviewRuntimeStartupOptions): Promise<QuestionPreviewRuntime> {
  validateQuestionPreviewWorkersExecutionMode(workersExecutionMode);
  await initPrairieLearnForQuestionPreview({
    cacheType,
    devMode,
    mode: workersExecutionMode,
    prewarmWorkers,
    questionTimeoutMilliseconds,
    startupLogger,
    workersCount,
  });

  startupLogger?.('Preparing question preview renderer.');
  const runtimeLocalPreviewGeneratedFiles =
    localPreviewGeneratedFiles ?? new LocalPreviewGeneratedFiles({ urlPrefix });
  const runtimeLocalPreviewSubmissionFiles =
    localPreviewSubmissionFiles ?? new LocalPreviewSubmissionFiles({ urlPrefix });
  const documentRenderer = createQuestionPreviewDocumentRenderer({
    courseDir: path.resolve(courseDir),
    localPreviewGeneratedFiles: runtimeLocalPreviewGeneratedFiles,
    localPreviewSubmissionFiles: runtimeLocalPreviewSubmissionFiles,
    localPreviewWorkspaces,
    renderMode,
    urlPrefix,
  });
  startupLogger?.('Question preview renderer initialized.');

  return new InitializedQuestionPreviewRuntime(documentRenderer);
}

export async function renderQuestionPreview(
  input: QuestionPreviewInput,
): Promise<QuestionPreviewDocumentResult> {
  const qidResult = parseQuestionPreviewQid(input.qid);
  if (!qidResult.ok) {
    return makeQuestionPreviewDocumentFailureResult([
      {
        data: { qid: qidResult.error.qid },
        fatal: true,
        message: qidResult.error.message,
        name: 'Error',
        phase: 'input',
      },
    ]);
  }

  const runtime = await createQuestionPreviewRuntime({
    cacheType: input.cacheType,
    courseDir: input.courseDir,
    devMode: input.devMode,
    prewarmWorkers: input.prewarmWorkers,
    questionTimeoutMilliseconds: input.questionTimeoutMilliseconds,
    renderMode: input.renderMode,
    startupLogger: input.startupLogger,
    urlPrefix: input.urlPrefix,
    workersCount: input.workersCount,
    workersExecutionMode: input.workersExecutionMode,
  });

  try {
    return await runtime.render({
      qid: qidResult.qid,
      variantSeed: input.variantSeed,
    });
  } finally {
    await runtime.close();
  }
}
