#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import minimist from 'minimist';

import { REPOSITORY_ROOT_PATH } from './lib/paths.js';

interface BenchmarkResponseSummary {
  durationMs: number;
  id?: unknown;
}

interface BenchmarkReportInput {
  courseDir: string;
  oneShotMs: number;
  qid: string;
  warmResponses: BenchmarkResponseSummary[];
  warmTotalMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function requireSuccessfulPayloadEnvelope(value: unknown, label: string) {
  const envelope = requireRecord(value, label);
  if (envelope.ok !== true) {
    throw new Error(`${label} must have ok=true.`);
  }
  if (!Array.isArray(envelope.diagnostics)) {
    throw new Error(`${label} must include diagnostics array.`);
  }
  const payload = requireRecord(envelope.payload, `${label}.payload`);
  if (typeof payload.bodyHtml !== 'string' || typeof payload.headHtml !== 'string') {
    throw new Error(`${label}.payload must include bodyHtml and headHtml strings.`);
  }
  const variant = requireRecord(payload.variant, `${label}.payload.variant`);
  if (typeof variant.seed !== 'string') {
    throw new Error(`${label}.payload.variant.seed must be a string.`);
  }
  if ('result' in envelope || 'error' in envelope) {
    throw new Error(`${label} must not use nested result/error fields.`);
  }
  return envelope;
}

export function validateOneShotOutput(stdout: string) {
  const lines = parseJsonLines(stdout);
  if (lines.length !== 1) {
    throw new Error(`One-shot preview must emit exactly one JSON line; received ${lines.length}.`);
  }
  return requireSuccessfulPayloadEnvelope(lines[0], 'one-shot envelope');
}

export function validateWarmOutput(stdout: string, expectedResponseCount: number) {
  const lines = parseJsonLines(stdout);
  if (lines.length !== expectedResponseCount + 1) {
    throw new Error(
      `Warm preview must emit one ready event and ${expectedResponseCount} response lines; received ${lines.length}.`,
    );
  }

  const ready = requireRecord(lines[0], 'warm ready event');
  if (ready.type !== 'ready' || ready.ok !== true) {
    throw new Error('Warm preview first line must be a ready event with ok=true.');
  }

  const responses = lines.slice(1).map((line, index) => {
    const response = requireSuccessfulPayloadEnvelope(line, `warm response ${index + 1}`);
    if (response.type !== 'response') {
      throw new Error(`warm response ${index + 1} must have type="response".`);
    }
    if (typeof response.durationMs !== 'number') {
      throw new Error(`warm response ${index + 1} must include durationMs.`);
    }
    return response as Record<string, unknown> & { durationMs: number; id?: unknown };
  });

  return { ready, responses };
}

export function formatBenchmarkReport({
  courseDir,
  oneShotMs,
  qid,
  warmResponses,
  warmTotalMs,
}: BenchmarkReportInput): string {
  const responseLines = warmResponses
    .map(
      (response, index) =>
        `  warm render ${index + 1}: ${response.durationMs.toFixed(1)} ms (id=${JSON.stringify(
          response.id,
        )})`,
    )
    .join('\n');

  return `PrairieLearn preview CLI native smoke/benchmark
Development guardrail only: not a production deployment performance gate.

Target:
  courseDir: ${courseDir}
  qid: ${qid}

Timings:
  one-shot: ${oneShotMs.toFixed(1)} ms
  warm process total: ${warmTotalMs.toFixed(1)} ms
${responseLines}
`;
}

function usage() {
  return `PrairieLearn preview CLI native smoke/benchmark:
  --course-dir <path>       Course directory containing the known spike target
  --qid <qid>               Question id to render
  --warm-requests <count>   Sequential warm requests to send (default: 2)
  -h, --help                Display this help and exit

This is a development guardrail only, not a production deployment performance gate.
`;
}

function stringArg(argv: Record<string, unknown>, key: string) {
  const value = argv[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveIntegerArg(argv: Record<string, unknown>, key: string, defaultValue: number) {
  const rawValue = stringArg(argv, key);
  if (rawValue == null) return defaultValue;
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || value.toString() !== rawValue) {
    throw new Error(`Invalid ${key} "${rawValue}". Expected a positive integer.`);
  }
  return value;
}

function runPreviewCli({ args, input }: { args: string[]; input?: string }): {
  elapsedMs: number;
  stderr: string;
  stdout: string;
} {
  const previewRenderPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'preview-render.js',
  );
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [previewRenderPath, ...args], {
    encoding: 'utf8',
    input,
  });
  const elapsedMs = performance.now() - startedAt;

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `preview-render exited with status ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return {
    elapsedMs,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    alias: { h: 'help' },
    boolean: ['help'],
    string: ['course-dir', 'qid', 'warm-requests'],
  });

  if (argv.help) {
    console.log(usage());
    return;
  }

  const defaultCourseDir = path.resolve(REPOSITORY_ROOT_PATH, '..', 'exampleCourse');
  const courseDir =
    stringArg(argv, 'course-dir') ?? process.env.PL_PREVIEW_COURSE_DIR ?? defaultCourseDir;
  const qid =
    stringArg(argv, 'qid') ?? process.env.PL_PREVIEW_QID ?? 'template/number-input/random';
  const warmRequests = positiveIntegerArg(argv, 'warm-requests', 2);

  const oneShot = runPreviewCli({
    args: [
      '--course-dir',
      courseDir,
      '--qid',
      qid,
      '--variant-seed',
      '1',
      '--workers-execution-mode',
      'native',
    ],
  });
  validateOneShotOutput(oneShot.stdout);

  const warmInput = Array.from({ length: warmRequests }, (_value, index) =>
    JSON.stringify({
      id: `warm-${index + 1}`,
      qid,
      variantSeed: (index + 1).toString(),
    }),
  ).join('\n');
  const warm = runPreviewCli({
    args: [
      '--serve',
      '--course-dir',
      courseDir,
      '--qid',
      qid,
      '--variant-seed',
      '1',
      '--workers-execution-mode',
      'native',
    ],
    input: `${warmInput}\n`,
  });
  const warmOutput = validateWarmOutput(warm.stdout, warmRequests);

  console.log(
    formatBenchmarkReport({
      courseDir,
      oneShotMs: oneShot.elapsedMs,
      qid,
      warmResponses: warmOutput.responses.map((response) => ({
        durationMs: response.durationMs,
        id: response.id,
      })),
      warmTotalMs: warm.elapsedMs,
    }),
  );

  if (oneShot.stderr.length > 0 || warm.stderr.length > 0) {
    console.error('preview-render emitted stderr during the smoke/benchmark run.');
    if (oneShot.stderr.length > 0) console.error(oneShot.stderr);
    if (warm.stderr.length > 0) console.error(warm.stderr);
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
