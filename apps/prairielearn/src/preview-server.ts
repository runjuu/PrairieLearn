#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { createQuestionPreviewRuntime } from './lib/question-preview/render.js';
import { startQuestionPreviewServer } from './lib/question-preview/server.js';

function logStartupProgress(message: string) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  logStartupProgress('Starting PrairieLearn preview server.');

  const started = await startQuestionPreviewServer({
    argv: process.argv.slice(2),
    createRuntime: createQuestionPreviewRuntime,
    startupLogger: logStartupProgress,
  });
  const address = started.server.address();
  const port = typeof address === 'object' && address != null ? address.port : started.options.port;
  process.stdout.write(
    `PrairieLearn preview server listening on http://${started.options.host}:${port}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
