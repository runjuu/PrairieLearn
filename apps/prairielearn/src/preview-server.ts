#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { createQuestionPreviewRuntime } from './lib/question-preview-render.js';
import { startQuestionPreviewServer } from './lib/question-preview-server.js';

async function main() {
  const started = await startQuestionPreviewServer({
    argv: process.argv.slice(2),
    createRuntime: createQuestionPreviewRuntime,
  });
  const address = started.server.address();
  const port = typeof address === 'object' && address != null ? address.port : started.options.port;
  console.log(`PrairieLearn preview server listening on http://${started.options.host}:${port}`);
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
