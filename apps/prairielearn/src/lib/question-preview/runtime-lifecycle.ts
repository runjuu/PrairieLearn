import type { QuestionPreviewDocumentInput } from './document.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import type {
  QuestionPreviewCacheType,
  QuestionPreviewRuntime,
  QuestionPreviewRuntimeStartupOptions,
  QuestionPreviewStartupLogger,
  QuestionPreviewWorkersExecutionMode,
} from './render.js';
import type { PreviewWorkspaceAllocator } from './workspace-launcher.js';

const QUESTION_PREVIEW_URL_PREFIX = '/preview-render';

export type QuestionPreviewRuntimeFactory = (
  options: QuestionPreviewRuntimeStartupOptions,
) => Promise<QuestionPreviewRuntime>;

export interface QuestionPreviewRuntimeLifecycleStartupOptions {
  cacheType?: QuestionPreviewCacheType;
  courseDir: string;
  devMode?: boolean;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  startupLogger?: QuestionPreviewStartupLogger;
  workersCount?: number;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewRuntimeLifecycle extends QuestionPreviewRuntime {
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewWorkspaces: PreviewWorkspaceAllocator | null;
  urlPrefix: string;
}

interface CreateQuestionPreviewRuntimeLifecycleParams {
  createRuntime: QuestionPreviewRuntimeFactory;
  localPreviewGeneratedFilesMax?: number;
  localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
  runtimeOptions: QuestionPreviewRuntimeLifecycleStartupOptions;
}

function makeRuntimeStartupOptions({
  localPreviewGeneratedFiles,
  localPreviewWorkspaces,
  runtimeOptions,
  urlPrefix,
}: {
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewWorkspaces: PreviewWorkspaceAllocator | null;
  runtimeOptions: QuestionPreviewRuntimeLifecycleStartupOptions;
  urlPrefix: string;
}): QuestionPreviewRuntimeStartupOptions {
  return {
    ...runtimeOptions,
    localPreviewGeneratedFiles,
    localPreviewWorkspaces,
    prewarmWorkers: runtimeOptions.prewarmWorkers ?? true,
    urlPrefix,
  };
}

/**
 * Wraps a preview runtime so infrastructure failures discard the current
 * runtime and allow a later request to create a fresh one.
 */
class ReplaceableQuestionPreviewRuntime implements QuestionPreviewRuntimeLifecycle {
  private currentRuntime: QuestionPreviewRuntime | null;
  private nextRuntimePromise: Promise<QuestionPreviewRuntime> | null = null;

  constructor(
    initialRuntime: QuestionPreviewRuntime,
    private readonly createRuntime: QuestionPreviewRuntimeFactory,
    private readonly runtimeOptions: QuestionPreviewRuntimeStartupOptions,
    readonly localPreviewGeneratedFiles: LocalPreviewGeneratedFiles,
    readonly localPreviewWorkspaces: PreviewWorkspaceAllocator | null,
    readonly urlPrefix: string,
  ) {
    this.currentRuntime = initialRuntime;
  }

  private async getRuntime() {
    if (this.currentRuntime != null) return this.currentRuntime;

    this.nextRuntimePromise ??= this.createRuntime(this.runtimeOptions).finally(() => {
      this.nextRuntimePromise = null;
    });
    this.currentRuntime = await this.nextRuntimePromise;
    return this.currentRuntime;
  }

  private async discardRuntime(runtime: QuestionPreviewRuntime) {
    if (this.currentRuntime !== runtime) return;
    this.currentRuntime = null;

    try {
      await runtime.close();
    } catch {
      // The runtime has already failed. A close failure should not prevent
      // the request from reporting the original infrastructure failure.
    }
  }

  async render(input: QuestionPreviewDocumentInput) {
    const runtime = await this.getRuntime();

    try {
      return await runtime.render(input);
    } catch (err) {
      await this.discardRuntime(runtime);
      throw err;
    }
  }

  async close() {
    const pendingRuntime = this.nextRuntimePromise;
    if (pendingRuntime != null) {
      await pendingRuntime.catch(() => null);
    }

    const runtime = this.currentRuntime;
    this.currentRuntime = null;
    await runtime?.close();
  }
}

export async function createQuestionPreviewRuntimeLifecycle({
  createRuntime,
  localPreviewGeneratedFilesMax,
  localPreviewWorkspaces = null,
  runtimeOptions,
}: CreateQuestionPreviewRuntimeLifecycleParams): Promise<QuestionPreviewRuntimeLifecycle> {
  const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({
    max: localPreviewGeneratedFilesMax,
    urlPrefix: QUESTION_PREVIEW_URL_PREFIX,
  });
  const runtimeStartupOptions = makeRuntimeStartupOptions({
    localPreviewGeneratedFiles,
    localPreviewWorkspaces,
    runtimeOptions,
    urlPrefix: QUESTION_PREVIEW_URL_PREFIX,
  });

  return new ReplaceableQuestionPreviewRuntime(
    await createRuntime(runtimeStartupOptions),
    createRuntime,
    runtimeStartupOptions,
    localPreviewGeneratedFiles,
    localPreviewWorkspaces,
    QUESTION_PREVIEW_URL_PREFIX,
  );
}
