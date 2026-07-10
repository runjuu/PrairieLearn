import { cache } from '@prairielearn/cache';

import * as freeformServer from '../../question-servers/freeform.js';
import * as assets from '../assets.js';
import * as codeCaller from '../code-caller/index.js';
import { config } from '../config.js';
import * as load from '../load.js';

import { type LocalPreviewCourseSource, createLocalPreviewCourseSource } from './course-source.js';
import {
  type QuestionPreviewDocumentInput,
  type QuestionPreviewDocumentResult,
  type QuestionPreviewRenderMode,
  createQuestionPreviewDocumentRenderer,
  makeQuestionPreviewDocumentFailureResult,
} from './document.js';
import {
  type QuestionPreviewCourseRenderer,
  type QuestionPreviewEngineLifecycle,
  createQuestionPreviewEngineLifecycle,
} from './engine.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { parseQuestionPreviewQid } from './qid.js';
import { LocalPreviewSubmissionFiles } from './submission-files.js';
import type { PreviewWorkspaceAllocator } from './workspace-launcher.js';

const DEFAULT_PREVIEW_URL_PREFIX = '/preview-render';

export type QuestionPreviewWorkersExecutionMode = 'native' | 'container';
export type QuestionPreviewCacheType = 'memory' | 'none' | 'redis';
export type QuestionPreviewStartupLogger = (message: string) => void;

export interface QuestionPreviewEngineStartupOptions {
  cacheType?: QuestionPreviewCacheType;
  devMode?: boolean;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  startupLogger?: QuestionPreviewStartupLogger;
  workersCount?: number;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewRuntimeStartupOptions extends QuestionPreviewEngineStartupOptions {
  courseDir: string;
  courseSource?: LocalPreviewCourseSource;
  localPreviewGeneratedFiles?: LocalPreviewGeneratedFiles;
  localPreviewSubmissionFiles?: LocalPreviewSubmissionFiles;
  localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
  renderMode?: QuestionPreviewRenderMode;
  urlPrefix?: string;
}

export interface QuestionPreviewInput extends Omit<
  QuestionPreviewRuntimeStartupOptions,
  | 'courseSource'
  | 'localPreviewGeneratedFiles'
  | 'localPreviewSubmissionFiles'
  | 'localPreviewWorkspaces'
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

async function initPrairieLearnGlobalsForQuestionPreview({
  cacheType = 'none',
  devMode = false,
  mode,
  questionTimeoutMilliseconds = 5000,
  startupLogger,
  workersCount = 1,
}: {
  cacheType?: QuestionPreviewCacheType;
  devMode?: boolean;
  mode: QuestionPreviewWorkersExecutionMode;
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
}

async function closePrairieLearnGlobalsForQuestionPreview() {
  await assets.close();
  await cache.close();
  load.close();
}

function capturePrairieLearnConfigForQuestionPreview() {
  const previousConfig = {
    cacheType: config.cacheType,
    chunksConsumer: config.chunksConsumer,
    devMode: config.devMode,
    ensureExecutorImageAtStartup: config.ensureExecutorImageAtStartup,
    questionTimeoutMilliseconds: config.questionTimeoutMilliseconds,
    reportIntervalSec: config.reportIntervalSec,
    workersCount: config.workersCount,
    workersExecutionMode: config.workersExecutionMode,
  };

  return () => Object.assign(config, previousConfig);
}

class ProcessOwnedQuestionPreviewEngine implements QuestionPreviewEngineLifecycle {
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly workerLifecycle: QuestionPreviewEngineLifecycle,
    private readonly restoreConfig: () => void,
  ) {}

  createCourseRenderer(
    options: Parameters<QuestionPreviewEngineLifecycle['createCourseRenderer']>[0],
  ) {
    return this.workerLifecycle.createCourseRenderer(options);
  }

  async close() {
    this.closePromise ??= (async () => {
      try {
        await this.workerLifecycle.close();
      } finally {
        try {
          await closePrairieLearnGlobalsForQuestionPreview();
        } finally {
          this.restoreConfig();
        }
      }
    })();
    return this.closePromise;
  }
}

class InitializedQuestionPreviewRuntime implements QuestionPreviewRuntime {
  private closePromise: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly engine: QuestionPreviewEngineLifecycle,
    private readonly courseRenderer: QuestionPreviewCourseRenderer,
  ) {}

  async render(input: QuestionPreviewDocumentInput): Promise<QuestionPreviewDocumentResult> {
    if (this.closed) {
      throw new Error('Question preview runtime is already closed.');
    }

    return this.courseRenderer.render(input);
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = (async () => {
        await this.courseRenderer.close();
        await this.engine.close();
      })();
    }

    return this.closePromise;
  }
}

export async function createQuestionPreviewEngine({
  cacheType = 'none',
  devMode = false,
  prewarmWorkers = false,
  questionTimeoutMilliseconds = 5000,
  startupLogger,
  workersCount = 1,
  workersExecutionMode = 'container',
}: QuestionPreviewEngineStartupOptions): Promise<QuestionPreviewEngineLifecycle> {
  validateQuestionPreviewWorkersExecutionMode(workersExecutionMode);
  const restoreConfig = capturePrairieLearnConfigForQuestionPreview();

  try {
    await initPrairieLearnGlobalsForQuestionPreview({
      cacheType,
      devMode,
      mode: workersExecutionMode,
      questionTimeoutMilliseconds,
      startupLogger,
      workersCount,
    });
    const workerLifecycle = await createQuestionPreviewEngineLifecycle({
      createGeneration: async () => {
        startupLogger?.(
          prewarmWorkers
            ? `Starting ${workersCount} Python worker${workersCount === 1 ? '' : 's'} (${workersExecutionMode} mode).`
            : `Preparing Python worker pool (${workersExecutionMode} mode, workers start on first request).`,
        );
        await codeCaller.init({ lazyWorkers: !prewarmWorkers });

        return {
          close: () => codeCaller.finish(),
          render: (options, input) => createQuestionPreviewDocumentRenderer(options).render(input),
        };
      },
    });
    startupLogger?.('PrairieLearn runtime initialized.');
    return new ProcessOwnedQuestionPreviewEngine(workerLifecycle, restoreConfig);
  } catch (err) {
    try {
      await closePrairieLearnGlobalsForQuestionPreview();
    } finally {
      restoreConfig();
    }
    throw err;
  }
}

export async function createQuestionPreviewRuntime({
  cacheType = 'none',
  courseDir,
  courseSource,
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
  const runtimeCourseSource = courseSource ?? (await createLocalPreviewCourseSource(courseDir));
  const engine = await createQuestionPreviewEngine({
    cacheType,
    devMode,
    prewarmWorkers,
    questionTimeoutMilliseconds,
    startupLogger,
    workersCount,
    workersExecutionMode,
  });

  startupLogger?.('Preparing question preview renderer.');
  const runtimeLocalPreviewGeneratedFiles =
    localPreviewGeneratedFiles ?? new LocalPreviewGeneratedFiles({ urlPrefix });
  const runtimeLocalPreviewSubmissionFiles =
    localPreviewSubmissionFiles ?? new LocalPreviewSubmissionFiles({ urlPrefix });
  const courseRenderer = engine.createCourseRenderer({
    courseSource: runtimeCourseSource,
    localPreviewGeneratedFiles: runtimeLocalPreviewGeneratedFiles,
    localPreviewSubmissionFiles: runtimeLocalPreviewSubmissionFiles,
    localPreviewWorkspaces,
    renderMode,
    urlPrefix,
  });
  startupLogger?.('Question preview renderer initialized.');

  return new InitializedQuestionPreviewRuntime(engine, courseRenderer);
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
