import fs from 'node:fs/promises';

import { assert, describe, it } from 'vitest';

describe('local preview package entrypoint', () => {
  it('exposes the HTTP preview server without the obsolete render CLI scripts', async () => {
    const packageJsonPath = new URL('../../package.json', import.meta.url);
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    assert.equal(scripts['preview:server'], 'node dist/preview-server.js');
    assert.notProperty(scripts, 'preview:render');
    assert.notProperty(scripts, 'preview:render:benchmark');

    for (const [name, command] of Object.entries(scripts)) {
      assert.notMatch(`${name} ${command}`, /dist\/cli\/preview-render/);
    }
  });
});
