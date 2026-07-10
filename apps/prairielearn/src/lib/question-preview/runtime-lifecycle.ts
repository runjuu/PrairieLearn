import type { LocalPreviewCourseSource } from './course-source.js';
import type { QuestionPreviewDocumentInput, QuestionPreviewRenderMode } from './document.js';
import type { QuestionPreviewEngineLifecycle } from './engine.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import type {
  QuestionPreviewCacheType,
  QuestionPreviewRuntime,
  QuestionPreviewRuntimeStartupOptions,
  QuestionPreviewStartupLogger,
  QuestionPreviewWorkersExecutionMode,
} from './render.js';
import { LocalPreviewSubmissionFiles } from './submission-files.js';
import type { PreviewWorkspaceAllocator } from './workspace-launcher.js';

const QUESTION_PREVIEW_URL_PREFIX = '/preview-render';

export type QuestionPreviewRuntimeFactory = (
  options: QuestionPreviewRuntimeStartupOptions,
) => Promise<QuestionPreviewRuntime>;

export interface QuestionPreviewRuntimeLifecycleStartupOptions {
  cacheType?: QuestionPreviewCacheType;
  courseDir: string;
  courseSource?: LocalPreviewCourseSource;
  devMode?: boolean;
  prewarmWorkers?: boolean;
  questionTimeoutMilliseconds?: number;
  renderMode?: QuestionPreviewRenderMode;
  startupLogger?: QuestionPreviewStartupLogger;
  workersCount?: number;
  workersExecutionMode?: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewRuntimeLifecycle extends QuestionPreviewRuntime {
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewSubmissionFiles: LocalPreviewSubmissionFiles;
  localPreviewWorkspaces: PreviewWorkspaceAllocator | null;
  urlPrefix: string;
}

interface CreateQuestionPreviewRuntimeLifecycleParams {
  createRuntime: QuestionPreviewRuntimeFactory;
  localPreviewGeneratedFilesMax?: number;
  localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
  runtimeOptions: QuestionPreviewRuntimeLifecycleStartupOptions;
  urlPrefix?: string;
}

interface CreateQuestionPreviewCourseRuntimeLifecycleParams {
  courseSource: LocalPreviewCourseSource;
  engine: QuestionPreviewEngineLifecycle;
  localPreviewGeneratedFilesMax?: number;
  localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
  renderMode: QuestionPreviewRenderMode;
  urlPrefix: string;
}

function makeRuntimeStartupOptions({
  localPreviewGeneratedFiles,
  localPreviewSubmissionFiles,
  localPreviewWorkspaces,
  runtimeOptions,
  urlPrefix,
}: {
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  localPreviewSubmissionFiles: LocalPreviewSubmissionFiles;
  localPreviewWorkspaces: PreviewWorkspaceAllocator | null;
  runtimeOptions: QuestionPreviewRuntimeLifecycleStartupOptions;
  urlPrefix: string;
}): QuestionPreviewRuntimeStartupOptions {
  return {
    ...runtimeOptions,
    localPreviewGeneratedFiles,
    localPreviewSubmissionFiles,
    localPreviewWorkspaces,
    prewarmWorkers: runtimeOptions.prewarmWorkers ?? true,
    urlPrefix,
  };
}

export async function createQuestionPreviewRuntimeLifecycle({
  createRuntime,
  localPreviewGeneratedFilesMax,
  localPreviewWorkspaces = null,
  runtimeOptions,
  urlPrefix = QUESTION_PREVIEW_URL_PREFIX,
}: CreateQuestionPreviewRuntimeLifecycleParams): Promise<QuestionPreviewRuntimeLifecycle> {
  const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({
    max: localPreviewGeneratedFilesMax,
    urlPrefix,
  });
  const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({
    urlPrefix,
  });
  const runtimeStartupOptions = makeRuntimeStartupOptions({
    localPreviewGeneratedFiles,
    localPreviewSubmissionFiles,
    localPreviewWorkspaces,
    runtimeOptions,
    urlPrefix,
  });

  const runtime = await createRuntime(runtimeStartupOptions);
  return {
    close: () => runtime.close(),
    localPreviewGeneratedFiles,
    localPreviewSubmissionFiles,
    localPreviewWorkspaces,
    render: (input: QuestionPreviewDocumentInput) => runtime.render(input),
    urlPrefix,
  };
}

export function createQuestionPreviewCourseRuntimeLifecycle({
  courseSource,
  engine,
  localPreviewGeneratedFilesMax,
  localPreviewWorkspaces = null,
  renderMode,
  urlPrefix,
}: CreateQuestionPreviewCourseRuntimeLifecycleParams): QuestionPreviewRuntimeLifecycle {
  const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({
    max: localPreviewGeneratedFilesMax,
    urlPrefix,
  });
  const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({ urlPrefix });
  const courseRenderer = engine.createCourseRenderer({
    courseSource,
    localPreviewGeneratedFiles,
    localPreviewSubmissionFiles,
    localPreviewWorkspaces,
    renderMode,
    urlPrefix,
  });

  return {
    close: () => courseRenderer.close(),
    localPreviewGeneratedFiles,
    localPreviewSubmissionFiles,
    localPreviewWorkspaces,
    render: (input) => courseRenderer.render(input),
    urlPrefix,
  };
}
