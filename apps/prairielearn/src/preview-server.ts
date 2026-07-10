#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { startQuestionPreviewServer } from './lib/question-preview/server.js';

function logStartupProgress(message: string) {
  process.stderr.write(`${message}\n`);
}

async function main() {
  logStartupProgress('Starting PrairieLearn preview server.');

  const started = await startQuestionPreviewServer({
    argv: process.argv.slice(2),
    startupLogger: logStartupProgress,
  });
  const address = started.server.address();
  const port = typeof address === 'object' && address != null ? address.port : started.options.port;
  process.stdout.write(
    `PrairieLearn preview server listening on http://${started.options.host}:${port}\n`,
  );
  for (const session of started.startupSessions) {
    process.stdout.write(
      `Local Preview Session ${session.previewSessionId}: ${session.courseDir}\n`,
    );
  }

  // Workspace containers are cleaned up by close(), so shut down gracefully
  // on Ctrl-C instead of leaking them until the next orphan-pruning startup.
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      logStartupProgress('Stopping PrairieLearn preview server.');
      started
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err);
          process.exit(1);
        });
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
