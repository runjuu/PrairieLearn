import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('./publish-quesal-image.yml', import.meta.url);

test('manual releases build and tag an explicit source without moving latest', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /source_ref:\n\s+description:/);
  assert.match(workflow, /release_tag:\n\s+description:/);
  assert.match(workflow, /ref: \$\{\{ needs\.prepare\.outputs\.source_sha \}\}/);
  assert.match(
    workflow,
    /org\.opencontainers\.image\.revision=\$\{\{ needs\.prepare\.outputs\.source_sha \}\}/,
  );
  assert.match(
    workflow,
    /type=raw,value=latest,enable=\$\{\{ github\.event_name == 'push' \}\}/,
  );
  assert.match(
    workflow,
    /type=raw,value=\$\{\{ inputs\.release_tag \}\},enable=\$\{\{ github\.event_name == 'workflow_dispatch' \}\}/,
  );
});
