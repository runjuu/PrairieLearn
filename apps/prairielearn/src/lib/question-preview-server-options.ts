import fs from 'node:fs/promises';
import path from 'node:path';

import minimist from 'minimist';
import { z } from 'zod';

import {
  type QuestionPreviewCacheType,
  type QuestionPreviewWorkersExecutionMode,
} from './question-preview-render.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4310;
const DEFAULT_QUESTION_TIMEOUT_MS = 5000;
const DEFAULT_RENDER_TIMEOUT_MS = 10000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_CORS_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];

const SUPPORTED_FLAGS = new Set([
  '_',
  'cache-type',
  'cors-origin',
  'course-dir',
  'dev-mode',
  'host',
  'port',
  'question-timeout-ms',
  'render-timeout-ms',
  'startup-timeout-ms',
  'workers-count',
  'workers-execution-mode',
]);

export interface QuestionPreviewServerOptions {
  cacheType: QuestionPreviewCacheType;
  corsOrigins: string[];
  courseDir: string;
  devMode: boolean;
  host: string;
  port: number;
  questionTimeoutMilliseconds: number;
  renderTimeoutMilliseconds: number;
  startupTimeoutMilliseconds: number;
  workersCount: number;
  workersExecutionMode: QuestionPreviewWorkersExecutionMode;
}

function addIssue(ctx: z.RefinementCtx, message: string): never {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  return z.NEVER as never;
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

function stringArrayFlagSchema(flagName: string) {
  return z.unknown().transform((value, ctx) => {
    if (value == null) return undefined;

    const values = Array.isArray(value) ? value : [value];
    if (
      values.length === 0 ||
      values.some((item) => typeof item !== 'string' || item.length === 0)
    ) {
      return addIssue(ctx, `Invalid --${flagName}. Expected one or more non-empty values.`);
    }

    return values as string[];
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
  const mode = value ?? 'native';
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

function parseCorsOrigins(values: string[] | undefined, ctx: z.RefinementCtx) {
  const rawOrigins = values ?? DEFAULT_CORS_ORIGINS;
  const origins = rawOrigins.flatMap((value) => value.split(',').map((origin) => origin.trim()));
  const parsedOrigins: string[] = [];

  for (const origin of origins) {
    if (origin.length === 0) {
      return addIssue(ctx, 'Invalid --cors-origin "". Expected an HTTP(S) origin.');
    }

    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
      parsedOrigins.push(url.origin);
    } catch {
      return addIssue(ctx, `Invalid --cors-origin "${origin}". Expected an HTTP(S) origin.`);
    }
  }

  return [...new Set(parsedOrigins)];
}

const QuestionPreviewServerOptionsSchema = z.object({
  cacheType: singleStringFlagSchema('cache-type').transform(parseCacheType),
  corsOrigins: stringArrayFlagSchema('cors-origin').transform(parseCorsOrigins),
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
  renderTimeoutMilliseconds: singleStringFlagSchema('render-timeout-ms').transform((value, ctx) =>
    parsePositiveInteger(value, 'render-timeout-ms', DEFAULT_RENDER_TIMEOUT_MS, ctx),
  ),
  startupTimeoutMilliseconds: singleStringFlagSchema('startup-timeout-ms').transform((value, ctx) =>
    parsePositiveInteger(value, 'startup-timeout-ms', DEFAULT_STARTUP_TIMEOUT_MS, ctx),
  ),
  workersCount: singleStringFlagSchema('workers-count').transform((value, ctx) =>
    parsePositiveInteger(value, 'workers-count', 1, ctx),
  ),
  workersExecutionMode:
    singleStringFlagSchema('workers-execution-mode').transform(parseWorkersExecutionMode),
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
    boolean: ['dev-mode'],
    string: [
      'cache-type',
      'cors-origin',
      'course-dir',
      'host',
      'port',
      'question-timeout-ms',
      'render-timeout-ms',
      'startup-timeout-ms',
      'workers-count',
      'workers-execution-mode',
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
    corsOrigins: argv['cors-origin'],
    courseDir: argv['course-dir'],
    devMode: argv['dev-mode'],
    host: argv.host,
    port: argv.port,
    questionTimeoutMilliseconds: argv['question-timeout-ms'],
    renderTimeoutMilliseconds: argv['render-timeout-ms'],
    startupTimeoutMilliseconds: argv['startup-timeout-ms'],
    workersCount: argv['workers-count'],
    workersExecutionMode: argv['workers-execution-mode'],
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('\n'));
  }

  await assertValidCourseDir(parsed.data.courseDir);
  return parsed.data;
}
