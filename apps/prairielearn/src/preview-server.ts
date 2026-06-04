#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { startQuestionPreviewServer } from './lib/question-preview-server.js';

async function main() {
  await startQuestionPreviewServer({
    onReady(started) {
      const address = started.server.address();
      const port =
        typeof address === 'object' && address != null ? address.port : started.options.port;
      console.log(
        `PrairieLearn preview server listening on http://${started.options.host}:${port}`,
      );
    },
  });
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
