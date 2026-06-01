#!/usr/bin/env node

import path from 'node:path';
import { createInterface } from 'node:readline';

import minimist from 'minimist';

import {
  createQuestionPreviewRuntime,
  renderQuestionPreview,
  type QuestionPreviewDiagnostic,
  type QuestionPreviewInput,
  type QuestionPreviewRuntimeRenderInput,
  type QuestionPreviewResult,
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
  --serve                             Warm runtime mode: JSON Lines over stdin/stdout
  -h, --help                          Display this help and exit

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

function parseWorkersExecutionMode(value: string | undefined): QuestionPreviewWorkersExecutionMode {
  const mode = value ?? process.env.PL_PREVIEW_WORKERS_EXECUTION_MODE ?? 'native';
  if (mode !== 'native' && mode !== 'container') {
    throw new Error(`Invalid workers execution mode "${mode}". Expected "native" or "container".`);
  }
  return mode;
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
      message: err.message,
      name: err.name,
      stack: err.stack,
    };
  }

  return {
    message: String(err),
    name: 'Error',
  };
}

interface ServeRequest {
  id?: unknown;
  input: QuestionPreviewRuntimeRenderInput;
}

type ServeResponse =
  | {
      durationMs: number;
      id?: unknown;
      ok: true;
      result: QuestionPreviewResult;
    }
  | {
      durationMs: number;
      error: QuestionPreviewDiagnostic;
      id?: unknown;
      ok: false;
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

  if (parsed.workersExecutionMode != null || parsed['workers-execution-mode'] != null) {
    throw new Error('workersExecutionMode is fixed for --serve; set it when starting the process.');
  }

  return {
    id: parsed.id,
    input: {
      courseDir: stringField(parsed, 'courseDir', ['course-dir']) ?? defaults.courseDir,
      qid: stringField(parsed, 'qid') ?? defaults.qid,
      urlPrefix: stringField(parsed, 'urlPrefix', ['url-prefix']) ?? defaults.urlPrefix,
      variantSeed: stringField(parsed, 'variantSeed', ['variant-seed']) ?? defaults.variantSeed,
    },
  };
}

function writeJsonLine(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function serveQuestionPreview({
  defaults,
  runtimeOptions,
}: {
  defaults: QuestionPreviewRuntimeRenderInput;
  runtimeOptions: Pick<QuestionPreviewInput, 'urlPrefix' | 'workersExecutionMode'>;
}) {
  const runtime = await createQuestionPreviewRuntime({
    ...runtimeOptions,
    prewarmWorkers: true,
  });
  writeJsonLine({ ok: true, ready: true });
  const lines = createInterface({
    crlfDelay: Infinity,
    input: process.stdin,
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
        writeJsonLine({
          durationMs: performance.now() - startedAt,
          id,
          ok: true,
          result,
        } satisfies ServeResponse);
      } catch (err) {
        writeJsonLine({
          durationMs: performance.now() - startedAt,
          error: diagnosticFromError(err),
          id,
          ok: false,
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
    boolean: ['help', 'serve'],
    string: [
      'course-dir',
      'courseDir',
      'mode',
      'qid',
      'url-prefix',
      'variant-seed',
      'variantSeed',
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

  if (argv.serve) {
    await serveQuestionPreview({
      defaults: {
        courseDir,
        qid,
        urlPrefix,
        variantSeed,
      },
      runtimeOptions: {
        urlPrefix,
        workersExecutionMode,
      },
    });
    return;
  }

  const result = await renderQuestionPreview({
    courseDir,
    qid,
    urlPrefix,
    variantSeed,
    workersExecutionMode,
  });

  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
