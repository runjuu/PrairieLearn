#!/usr/bin/env node

import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import minimist from 'minimist';

import {
  createQuestionPreviewRuntime,
  renderQuestionPreview,
  type QuestionPreviewCacheType,
  type QuestionPreviewDiagnostic,
  type QuestionPreviewPayload,
  type QuestionPreviewRuntimeRenderInput,
  type QuestionPreviewRuntimeOptions,
  type QuestionPreviewWorkersExecutionMode,
} from './lib/question-preview-render.js';
import { REPOSITORY_ROOT_PATH } from './lib/paths.js';

const DEFAULT_QID = 'template/number-input/random';
const DEFAULT_VARIANT_SEED = '1';

function usage() {
  return `PrairieLearn render-only question preview:
  --course-dir <path>                 Course directory containing questions/
  --qid <qid>                         Question id relative to questions/
  --variant-seed <seed>               Variant seed (default: ${DEFAULT_VARIANT_SEED})
  --url-prefix <prefix>               URL prefix used in rendered question asset URLs
  --workers-execution-mode <mode>     native or container (default: native)
  --workers-count <count>             Worker process count (default: 1)
  --prewarm-workers                   Start workers during runtime initialization
  --cache-type <type>                 none, memory, or redis (default: none)
  --dev-mode                          Enable PrairieLearn dev-mode diagnostics
  --question-timeout-ms <ms>          Question worker timeout (default: 5000)
  --serve                             Warm runtime mode: JSON Lines over stdin/stdout
  -h, --help                          Display this help and exit

Warm mode lifecycle:
  Requests are processed sequentially. Closing stdin shuts down the runtime.
  Hard wall-clock timeouts and process-tree termination are supervisor responsibilities.

Render-only contract:
  The CLI only renders question fragments and Stable Preview Variant seed metadata.
  It does not parse, grade, accept submissions, render assessment panels, bind HTTP ports,
  or serve PrairieLearn assets. Asset URLs in the payload must be served by the caller.

Compatibility aliases:
  --courseDir, --variantSeed, --mode
`;
}

function stringArg(argv: Record<string, unknown>, primary: string, aliases: string[] = []) {
  for (const key of [primary, ...aliases]) {
    const value = argv[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function booleanArg(argv: Record<string, unknown>, primary: string, aliases: string[] = []) {
  for (const key of [primary, ...aliases]) {
    const value = argv[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function booleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value == null || value.length === 0) return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error(`Invalid ${name} value "${value}". Expected true/false or 1/0.`);
}

function positiveIntegerArg({
  argv,
  defaultValue,
  envName,
  label,
  primary,
}: {
  argv: Record<string, unknown>;
  defaultValue: number;
  envName: string;
  label: string;
  primary: string;
}) {
  const rawValue = stringArg(argv, primary) ?? process.env[envName];
  if (rawValue == null) return defaultValue;
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value.toString() !== rawValue) {
    throw new Error(`Invalid ${label} "${rawValue}". Expected a positive integer.`);
  }
  return value;
}

function parseWorkersExecutionMode(value: string | undefined): QuestionPreviewWorkersExecutionMode {
  const mode = value ?? process.env.PL_PREVIEW_WORKERS_EXECUTION_MODE ?? 'native';
  if (mode !== 'native' && mode !== 'container') {
    throw new Error(`Invalid workers execution mode "${mode}". Expected "native" or "container".`);
  }
  return mode;
}

function parseCacheType(value: string | undefined): QuestionPreviewCacheType {
  const cacheType = value ?? process.env.PL_PREVIEW_CACHE_TYPE ?? 'none';
  if (cacheType !== 'none' && cacheType !== 'memory' && cacheType !== 'redis') {
    throw new Error(`Invalid cache type "${cacheType}". Expected "none", "memory", or "redis".`);
  }
  return cacheType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  input: Record<string, unknown>,
  primary: string,
  aliases: string[] = [],
): string | undefined {
  for (const key of [primary, ...aliases]) {
    const value = input[key];
    if (value == null) continue;
    if (typeof value === 'string' && value.length > 0) return value;
    throw new Error(`Invalid request field "${key}". Expected a non-empty string.`);
  }
  return undefined;
}

function diagnosticFromError(err: unknown): QuestionPreviewDiagnostic {
  if (err instanceof Error) {
    return {
      data: isRecord(err) ? err.data : undefined,
      fatal: true,
      message: err.message,
      name: err.name,
    };
  }

  return {
    fatal: true,
    message: String(err),
    name: 'Error',
  };
}

interface ServeRequest {
  id?: unknown;
  input: QuestionPreviewRuntimeRenderInput;
}

class ServeRequestError extends Error {
  id?: unknown;

  constructor(message: string, { id }: { id?: unknown } = {}) {
    super(message);
    this.id = id;
  }
}

type ServeResponse =
  | {
      diagnostics: QuestionPreviewDiagnostic[];
      durationMs: number;
      id?: unknown;
      ok: true;
      payload: QuestionPreviewPayload;
      type: 'response';
    }
  | {
      diagnostics: QuestionPreviewDiagnostic[];
      durationMs: number;
      id?: unknown;
      ok: false;
      type: 'response';
    };

function parseServeRequest(
  line: string,
  defaults: QuestionPreviewRuntimeRenderInput,
): ServeRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`Invalid JSON request line: ${diagnosticFromError(err).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid request line. Expected a JSON object.');
  }

  const id = parsed.id;
  const startupScopedFields = [
    'cacheType',
    'cache-type',
    'courseDir',
    'course-dir',
    'devMode',
    'dev-mode',
    'prewarmWorkers',
    'prewarm-workers',
    'questionTimeoutMilliseconds',
    'question-timeout-ms',
    'urlPrefix',
    'url-prefix',
    'workersCount',
    'workers-count',
    'workersExecutionMode',
    'workers-execution-mode',
  ].filter((field) => parsed[field] != null);
  if (startupScopedFields.length > 0) {
    throw new ServeRequestError(
      `Render requests cannot override startup-scoped preview configuration: ${startupScopedFields.join(', ')}.`,
      { id },
    );
  }

  const renderRequestFields = new Set(['id', 'qid', 'variantSeed', 'variant-seed']);
  const unsupportedFields = Object.keys(parsed).filter((field) => !renderRequestFields.has(field));
  if (unsupportedFields.length > 0) {
    throw new ServeRequestError(
      `Warm render requests are render-only and may only include id, qid, and variantSeed. Unsupported field(s): ${unsupportedFields.join(', ')}.`,
      { id },
    );
  }

  return {
    id,
    input: {
      qid: stringField(parsed, 'qid') ?? defaults.qid,
      variantSeed: stringField(parsed, 'variantSeed', ['variant-seed']) ?? defaults.variantSeed,
    },
  };
}

function writeJsonLine(output: NodeJS.WritableStream, value: unknown) {
  output.write(`${JSON.stringify(value)}\n`);
}

export async function serveQuestionPreview({
  defaults,
  input = process.stdin,
  output = process.stdout,
  runtimeOptions,
}: {
  defaults: QuestionPreviewRuntimeRenderInput;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runtimeOptions: QuestionPreviewRuntimeOptions;
}) {
  const runtime = await createQuestionPreviewRuntime(runtimeOptions);
  writeJsonLine(output, { ok: true, type: 'ready' });
  const lines = createInterface({
    crlfDelay: Infinity,
    input,
    terminal: false,
  });

  try {
    for await (const line of lines) {
      const startedAt = performance.now();
      let id: unknown;

      try {
        const request = parseServeRequest(line, defaults);
        id = request.id;

        const result = await runtime.render(request.input);
        const baseResponse = {
          diagnostics: result.diagnostics,
          durationMs: performance.now() - startedAt,
          id,
          type: 'response',
        } as const;
        writeJsonLine(
          output,
          result.ok
            ? ({
                ...baseResponse,
                ok: true,
                payload: result.payload,
              } satisfies ServeResponse)
            : ({
                ...baseResponse,
                ok: false,
              } satisfies ServeResponse),
        );
      } catch (err) {
        if (err instanceof ServeRequestError) {
          id = err.id;
        }

        writeJsonLine(output, {
          diagnostics: [diagnosticFromError(err)],
          durationMs: performance.now() - startedAt,
          id,
          ok: false,
          type: 'response',
        } satisfies ServeResponse);
      }
    }
  } finally {
    await runtime.close();
  }
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    alias: {
      h: 'help',
    },
    boolean: ['dev-mode', 'help', 'prewarm-workers', 'serve'],
    string: [
      'cache-type',
      'course-dir',
      'courseDir',
      'mode',
      'qid',
      'question-timeout-ms',
      'url-prefix',
      'variant-seed',
      'variantSeed',
      'workers-count',
      'workers-execution-mode',
    ],
  });

  if (argv.help) {
    console.log(usage());
    return;
  }

  if (argv._.length > 0) {
    throw new Error(`Unexpected positional arguments: ${argv._.join(' ')}`);
  }

  const supportedFlags = new Set([
    '_',
    'cache-type',
    'course-dir',
    'courseDir',
    'dev-mode',
    'h',
    'help',
    'mode',
    'prewarm-workers',
    'qid',
    'question-timeout-ms',
    'serve',
    'url-prefix',
    'variant-seed',
    'variantSeed',
    'workers-count',
    'workers-execution-mode',
  ]);
  const unsupportedFlags = Object.keys(argv).filter((flag) => !supportedFlags.has(flag));
  if (unsupportedFlags.length > 0) {
    throw new Error(
      `Unsupported preview-render flag(s): ${unsupportedFlags.join(', ')}. The preview CLI is render-only and does not expose parse, grade, submission, saved-answer, answer-panel, submission-panel, correct-answer-panel, HTTP port, or asset-serving APIs.`,
    );
  }

  const defaultCourseDir = path.resolve(REPOSITORY_ROOT_PATH, '..', 'exampleCourse');
  const courseDir =
    stringArg(argv, 'course-dir', ['courseDir']) ??
    process.env.PL_PREVIEW_COURSE_DIR ??
    defaultCourseDir;
  const qid = stringArg(argv, 'qid') ?? process.env.PL_PREVIEW_QID ?? DEFAULT_QID;
  const variantSeed =
    stringArg(argv, 'variant-seed', ['variantSeed']) ??
    process.env.PL_PREVIEW_VARIANT_SEED ??
    DEFAULT_VARIANT_SEED;
  const urlPrefix =
    stringArg(argv, 'url-prefix') ?? process.env.PL_PREVIEW_URL_PREFIX ?? '/preview-render';
  const workersExecutionMode = parseWorkersExecutionMode(
    stringArg(argv, 'workers-execution-mode', ['mode']),
  );
  const workersCount = positiveIntegerArg({
    argv,
    defaultValue: 1,
    envName: 'PL_PREVIEW_WORKERS_COUNT',
    label: 'workers count',
    primary: 'workers-count',
  });
  const questionTimeoutMilliseconds = positiveIntegerArg({
    argv,
    defaultValue: 5000,
    envName: 'PL_PREVIEW_QUESTION_TIMEOUT_MS',
    label: 'question timeout',
    primary: 'question-timeout-ms',
  });
  const prewarmWorkers =
    booleanArg(argv, 'prewarm-workers') ??
    booleanEnv('PL_PREVIEW_PREWARM_WORKERS') ??
    Boolean(argv.serve);
  const devMode = booleanArg(argv, 'dev-mode') ?? booleanEnv('PL_PREVIEW_DEV_MODE') ?? false;
  const cacheType = parseCacheType(stringArg(argv, 'cache-type'));
  const runtimeOptions: QuestionPreviewRuntimeOptions = {
    cacheType,
    courseDir,
    devMode,
    prewarmWorkers,
    questionTimeoutMilliseconds,
    urlPrefix,
    workersCount,
    workersExecutionMode,
  };

  if (argv.serve) {
    await serveQuestionPreview({
      defaults: {
        qid,
        variantSeed,
      },
      runtimeOptions,
    });
    return;
  }

  const result = await renderQuestionPreview({
    qid,
    variantSeed,
    ...runtimeOptions,
  });

  console.log(JSON.stringify(result));
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
