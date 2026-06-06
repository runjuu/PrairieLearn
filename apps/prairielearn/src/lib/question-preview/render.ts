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
  createQuestionPreviewDocumentRenderer,
  makeQuestionPreviewDocumentFailureResult,
} from './document.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { parseQuestionPreviewQid } from './qid.js';

const DEFAULT_PREVIEW_URL_PREFIX = '/preview-render';

export type QuestionPreviewWorkersExecutionMode = 'native' | 'container';
export type QuestionPreviewCacheType = 'memory' | 'none' | 'redis';

export interface QuestionPreviewRuntimeStartupOptions {
  cacheType?: QuestionPreviewCacheType;
  courseDir: string;
  devMode?: boolean;
  localPreviewGeneratedFiles?: LocalPreviewGeneratedFiles;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  urlPrefix?: string;
  workersCount?: number;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewInput extends Omit<
  QuestionPreviewRuntimeStartupOptions,
  'localPreviewGeneratedFiles'
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
  prewarmWorkers = false,
  questionTimeoutMilliseconds = 5000,
  urlPrefix = DEFAULT_PREVIEW_URL_PREFIX,
  workersCount = 1,
  workersExecutionMode = 'native',
}: QuestionPreviewRuntimeStartupOptions): Promise<QuestionPreviewRuntime> {
  validateQuestionPreviewWorkersExecutionMode(workersExecutionMode);
  await initPrairieLearnForQuestionPreview({
    cacheType,
    devMode,
    mode: workersExecutionMode,
    prewarmWorkers,
    questionTimeoutMilliseconds,
    workersCount,
  });
  const runtimeLocalPreviewGeneratedFiles =
    localPreviewGeneratedFiles ?? new LocalPreviewGeneratedFiles({ urlPrefix });
  const documentRenderer = createQuestionPreviewDocumentRenderer({
    courseDir: path.resolve(courseDir),
    localPreviewGeneratedFiles: runtimeLocalPreviewGeneratedFiles,
    urlPrefix,
  });

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
