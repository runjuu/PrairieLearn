import fs from 'node:fs/promises';
import path from 'node:path';

import minimist from 'minimist';
import { z } from 'zod';

import type { QuestionPreviewRenderMode } from './document.js';
import {
  type QuestionPreviewCacheType,
  type QuestionPreviewWorkersExecutionMode,
} from './render.js';
import type { QuestionPreviewRuntimeLifecycleStartupOptions } from './runtime-lifecycle.js';
import type { PreviewWorkspacePullPolicy } from './workspace-launcher.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;
const DEFAULT_QUESTION_TIMEOUT_MS = 5000;
const DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WORKSPACE_MAX_CONTAINERS = 3;
const DEFAULT_WORKSPACE_START_TIMEOUT_MS = 60 * 1000;

const SUPPORTED_FLAGS = new Set([
  '_',
  'cache-type',
  'course-dir',
  'dev-mode',
  'host',
  'port',
  'question-timeout-ms',
  'render-mode',
  'workers-count',
  'workers-execution-mode',
  'workspace-home-dir',
  'workspace-idle-timeout-ms',
  'workspace-max-containers',
  'workspace-network',
  'workspace-pull-policy',
  'workspace-start-timeout-ms',
  'workspaces',
]);

export interface QuestionPreviewServerHttpOptions {
  courseDir: string;
  host: string;
  port: number;
  renderMode: QuestionPreviewRenderMode;
}

export interface QuestionPreviewServerRuntimeOptions extends QuestionPreviewRuntimeLifecycleStartupOptions {
  cacheType: QuestionPreviewCacheType;
  courseDir: string;
  devMode: boolean;
  questionTimeoutMilliseconds: number;
  renderMode: QuestionPreviewRenderMode;
  workersCount: number;
  workersExecutionMode: QuestionPreviewWorkersExecutionMode;
}

export interface QuestionPreviewServerWorkspaceOptions {
  workspaceHomeDir: string | undefined;
  workspaceIdleTimeoutMs: number;
  workspaceMaxContainers: number;
  workspaceNetwork: string | undefined;
  workspacePullPolicy: PreviewWorkspacePullPolicy;
  workspaceStartTimeoutMs: number;
  workspacesEnabled: boolean;
}

export interface QuestionPreviewServerOptions
  extends
    QuestionPreviewServerHttpOptions,
    QuestionPreviewServerRuntimeOptions,
    QuestionPreviewServerWorkspaceOptions {}

function addIssue(ctx: z.RefinementCtx, message: string): never {
  ctx.addIssue({ code: 'custom', message });
  return z.NEVER;
}

function singleStringFlagSchema(flagName: string) {
  return z.unknown().transform((value, ctx): string | undefined => {
    if (value == null) {
      return undefined;
    }

    if (typeof value !== 'string' || value.length === 0) {
      return addIssue(ctx, `Invalid --${flagName}. Expected exactly one non-empty value.`);
    }

    return value;
  });
}

function requiredSingleStringFlagSchema(flagName: string, missingMessage: string) {
  return z.unknown().transform((value, ctx): string => {
    if (value == null) {
      return addIssue(ctx, missingMessage);
    }

    if (typeof value !== 'string' || value.length === 0) {
      return addIssue(ctx, `Invalid --${flagName}. Expected exactly one non-empty value.`);
    }

    return value;
  });
}

function parsePort(value: string | undefined, ctx: z.RefinementCtx) {
  if (value == null) return DEFAULT_PORT;

  const port = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || String(port) !== value) {
    return addIssue(ctx, `Invalid --port "${value}". Expected an integer from 0 through 65535.`);
  }

  return port;
}

function parsePositiveInteger(
  value: string | undefined,
  flagName: string,
  defaultValue: number,
  ctx: z.RefinementCtx,
) {
  if (value == null) return defaultValue;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    return addIssue(ctx, `Invalid --${flagName} "${value}". Expected a positive integer.`);
  }

  return parsed;
}

function parseWorkersExecutionMode(
  value: string | undefined,
  ctx: z.RefinementCtx,
): QuestionPreviewWorkersExecutionMode {
  const mode = value ?? 'container';
  if (mode !== 'native' && mode !== 'container') {
    return addIssue(
      ctx,
      `Invalid --workers-execution-mode "${mode}". Expected "native" or "container".`,
    );
  }

  return mode;
}

function parseCacheType(value: string | undefined, ctx: z.RefinementCtx): QuestionPreviewCacheType {
  const cacheType = value ?? 'none';
  if (cacheType !== 'none' && cacheType !== 'memory' && cacheType !== 'redis') {
    return addIssue(
      ctx,
      `Invalid --cache-type "${cacheType}". Expected "none", "memory", or "redis".`,
    );
  }

  return cacheType;
}

function parseRenderMode(
  value: string | undefined,
  ctx: z.RefinementCtx,
): QuestionPreviewRenderMode {
  const renderMode = value ?? 'full';
  if (renderMode !== 'full' && renderMode !== 'question-only') {
    return addIssue(
      ctx,
      `Invalid --render-mode "${renderMode}". Expected "full" or "question-only".`,
    );
  }

  return renderMode;
}

function parseWorkspacePullPolicy(
  value: string | undefined,
  ctx: z.RefinementCtx,
): PreviewWorkspacePullPolicy {
  const pullPolicy = value ?? 'missing';
  if (pullPolicy !== 'missing' && pullPolicy !== 'always' && pullPolicy !== 'never') {
    return addIssue(
      ctx,
      `Invalid --workspace-pull-policy "${pullPolicy}". Expected "missing", "always", or "never".`,
    );
  }

  return pullPolicy;
}

const QuestionPreviewServerOptionsSchema = z.object({
  cacheType: singleStringFlagSchema('cache-type').transform(parseCacheType),
  courseDir: requiredSingleStringFlagSchema(
    'course-dir',
    'Missing required --course-dir <path> for the local preview server.',
  ).transform((courseDir) => path.resolve(courseDir)),
  devMode: z.boolean(),
  host: singleStringFlagSchema('host').transform((host) => host ?? DEFAULT_HOST),
  port: singleStringFlagSchema('port').transform(parsePort),
  questionTimeoutMilliseconds: singleStringFlagSchema('question-timeout-ms').transform(
    (value, ctx) =>
      parsePositiveInteger(value, 'question-timeout-ms', DEFAULT_QUESTION_TIMEOUT_MS, ctx),
  ),
  renderMode: singleStringFlagSchema('render-mode').transform(parseRenderMode),
  workersCount: singleStringFlagSchema('workers-count').transform((value, ctx) =>
    parsePositiveInteger(value, 'workers-count', 1, ctx),
  ),
  workersExecutionMode:
    singleStringFlagSchema('workers-execution-mode').transform(parseWorkersExecutionMode),
  workspaceHomeDir: singleStringFlagSchema('workspace-home-dir').transform((workspaceHomeDir) =>
    workspaceHomeDir == null ? undefined : path.resolve(workspaceHomeDir),
  ),
  workspaceIdleTimeoutMs: singleStringFlagSchema('workspace-idle-timeout-ms').transform(
    (value, ctx) =>
      parsePositiveInteger(
        value,
        'workspace-idle-timeout-ms',
        DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
        ctx,
      ),
  ),
  workspaceMaxContainers: singleStringFlagSchema('workspace-max-containers').transform(
    (value, ctx) =>
      parsePositiveInteger(
        value,
        'workspace-max-containers',
        DEFAULT_WORKSPACE_MAX_CONTAINERS,
        ctx,
      ),
  ),
  workspaceNetwork: singleStringFlagSchema('workspace-network'),
  workspacePullPolicy:
    singleStringFlagSchema('workspace-pull-policy').transform(parseWorkspacePullPolicy),
  workspaceStartTimeoutMs: singleStringFlagSchema('workspace-start-timeout-ms').transform(
    (value, ctx) =>
      parsePositiveInteger(
        value,
        'workspace-start-timeout-ms',
        DEFAULT_WORKSPACE_START_TIMEOUT_MS,
        ctx,
      ),
  ),
  workspacesEnabled: z.boolean(),
});

async function assertValidCourseDir(courseDir: string) {
  try {
    const stat = await fs.stat(courseDir);
    if (!stat.isDirectory()) throw new Error('not a directory');
    const questionsStat = await fs.stat(path.join(courseDir, 'questions'));
    if (!questionsStat.isDirectory()) throw new Error('missing questions directory');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid --course-dir "${courseDir}": ${detail}`, { cause: err });
  }
}

export async function parseQuestionPreviewServerOptions(
  argvInput: string[],
): Promise<QuestionPreviewServerOptions> {
  const argv = minimist(argvInput, {
    boolean: ['dev-mode', 'workspaces'],
    default: { workspaces: true },
    string: [
      'cache-type',
      'course-dir',
      'host',
      'port',
      'question-timeout-ms',
      'render-mode',
      'workers-count',
      'workers-execution-mode',
      'workspace-home-dir',
      'workspace-idle-timeout-ms',
      'workspace-max-containers',
      'workspace-network',
      'workspace-pull-policy',
      'workspace-start-timeout-ms',
    ],
  });

  if (argv._.length > 0) {
    throw new Error(`Unexpected positional arguments: ${argv._.join(' ')}`);
  }

  const unsupportedFlags = Object.keys(argv).filter((flag) => !SUPPORTED_FLAGS.has(flag));
  if (unsupportedFlags.length > 0) {
    throw new Error(`Unsupported preview-server flag(s): ${unsupportedFlags.join(', ')}.`);
  }

  const parsed = QuestionPreviewServerOptionsSchema.safeParse({
    cacheType: argv['cache-type'],
    courseDir: argv['course-dir'],
    devMode: argv['dev-mode'],
    host: argv.host,
    port: argv.port,
    questionTimeoutMilliseconds: argv['question-timeout-ms'],
    renderMode: argv['render-mode'],
    workersCount: argv['workers-count'],
    workersExecutionMode: argv['workers-execution-mode'],
    workspaceHomeDir: argv['workspace-home-dir'],
    workspaceIdleTimeoutMs: argv['workspace-idle-timeout-ms'],
    workspaceMaxContainers: argv['workspace-max-containers'],
    workspaceNetwork: argv['workspace-network'],
    workspacePullPolicy: argv['workspace-pull-policy'],
    workspaceStartTimeoutMs: argv['workspace-start-timeout-ms'],
    workspacesEnabled: argv.workspaces,
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('\n'));
  }

  await assertValidCourseDir(parsed.data.courseDir);
  return parsed.data;
}

export function getQuestionPreviewServerHttpOptions(
  options: QuestionPreviewServerOptions,
): QuestionPreviewServerHttpOptions {
  return {
    courseDir: options.courseDir,
    host: options.host,
    port: options.port,
    renderMode: options.renderMode,
  };
}

export function getQuestionPreviewServerRuntimeOptions(
  options: QuestionPreviewServerOptions,
): QuestionPreviewServerRuntimeOptions {
  return {
    cacheType: options.cacheType,
    courseDir: options.courseDir,
    devMode: options.devMode,
    questionTimeoutMilliseconds: options.questionTimeoutMilliseconds,
    renderMode: options.renderMode,
    workersCount: options.workersCount,
    workersExecutionMode: options.workersExecutionMode,
  };
}

export function getQuestionPreviewServerWorkspaceOptions(
  options: QuestionPreviewServerOptions,
): QuestionPreviewServerWorkspaceOptions {
  return {
    workspaceHomeDir: options.workspaceHomeDir,
    workspaceIdleTimeoutMs: options.workspaceIdleTimeoutMs,
    workspaceMaxContainers: options.workspaceMaxContainers,
    workspaceNetwork: options.workspaceNetwork,
    workspacePullPolicy: options.workspacePullPolicy,
    workspaceStartTimeoutMs: options.workspaceStartTimeoutMs,
    workspacesEnabled: options.workspacesEnabled,
  };
}
