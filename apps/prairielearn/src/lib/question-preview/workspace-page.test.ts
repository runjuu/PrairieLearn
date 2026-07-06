import { assert, beforeAll, describe, it } from 'vitest';

import * as assets from '../assets.js';

import {
  makePreviewWorkspaceStatusJson,
  renderPreviewWorkspacePageHtml,
  renderPreviewWorkspaceUnavailableHtml,
} from './workspace-page.js';
import type { PreviewWorkspaceEntry } from './workspace-registry.js';

beforeAll(async () => {
  await assets.init();
});

const URLS = {
  containerUrl: '/workspace/1/container/',
  statusUrl: '/workspace/1/status',
};

function makeEntry(overrides: Partial<PreviewWorkspaceEntry> = {}): PreviewWorkspaceEntry {
  return {
    fileGenerationErrors: [],
    id: '1',
    lastActivityAt: 0,
    launchGeneration: 1,
    message: 'Launching',
    spec: {
      params: {},
      qid: 'demo/workspace',
      settings: {
        args: null,
        enableNetworking: false,
        environment: {},
        gradedFiles: [],
        home: '/home/user',
        image: 'workspace-image',
        port: 8080,
        rewriteUrl: true,
      },
      trueAnswer: {},
      variantSeed: '1',
    },
    state: 'launching',
    target: null,
    version: 1,
    ...overrides,
  };
}

describe('makePreviewWorkspaceStatusJson', () => {
  it('exposes the iframe source only when the workspace is running', () => {
    const running = makePreviewWorkspaceStatusJson(
      makeEntry({
        message: 'Running',
        state: 'running',
        target: { host: '127.0.0.1', port: 40100 },
      }),
      { containerUrl: URLS.containerUrl },
    );
    assert.deepEqual(running, {
      iframeSrc: '/workspace/1/container/',
      message: 'Running',
      state: 'running',
      version: 1,
    });

    const launching = makePreviewWorkspaceStatusJson(makeEntry(), {
      containerUrl: URLS.containerUrl,
    });
    assert.isNull(launching.iframeSrc);
    assert.equal(launching.state, 'launching');
  });
});

describe('renderPreviewWorkspacePageHtml', () => {
  it('renders the launching state with a waiting panel and no iframe source', () => {
    const documentHtml = renderPreviewWorkspacePageHtml({ entry: makeEntry(), urls: URLS });

    assert.include(documentHtml, 'data-state="launching"');
    assert.include(documentHtml, 'data-status-url="/workspace/1/status"');
    assert.include(documentHtml, 'Launching');
    assert.include(documentHtml, 'id="workspace-waiting-panel"');
    assert.notInclude(documentHtml, 'src="/workspace/1/container/"');
  });

  it('renders a running workspace with the iframe pointed at the container', () => {
    const documentHtml = renderPreviewWorkspacePageHtml({
      entry: makeEntry({
        message: 'Running',
        state: 'running',
        target: { host: '127.0.0.1', port: 40100 },
      }),
      urls: URLS,
    });

    assert.include(documentHtml, 'data-state="running"');
    assert.include(documentHtml, 'src="/workspace/1/container/"');
  });

  it('renders no in-page controls, since the embedding host owns them', () => {
    const documentHtml = renderPreviewWorkspacePageHtml({ entry: makeEntry(), urls: URLS });

    assert.notInclude(documentHtml, 'pv-toolbar');
    assert.notInclude(documentHtml, '__action');
    assert.notInclude(documentHtml, 'aria-label="Reboot workspace"');
    assert.notInclude(documentHtml, 'aria-label="Reset workspace"');
  });

  it('lists file generation errors', () => {
    const documentHtml = renderPreviewWorkspacePageHtml({
      entry: makeEntry({
        fileGenerationErrors: [{ file: 'starter.py', msg: 'Error rendering template' }],
      }),
      urls: URLS,
    });

    assert.include(documentHtml, 'Workspace file errors');
    assert.include(documentHtml, 'starter.py');
    assert.include(documentHtml, 'Error rendering template');
  });

  it('escapes HTML in workspace messages', () => {
    const documentHtml = renderPreviewWorkspacePageHtml({
      entry: makeEntry({ message: '<script>alert(1)</script>' }),
      urls: URLS,
    });

    assert.notInclude(documentHtml, '<script>alert(1)</script>');
    assert.include(documentHtml, '&lt;script&gt;');
  });
});

describe('renderPreviewWorkspaceUnavailableHtml', () => {
  it('renders the reason', () => {
    const documentHtml = renderPreviewWorkspaceUnavailableHtml({
      reason: 'Workspaces are disabled on this preview server.',
    });

    assert.include(documentHtml, 'Workspace unavailable');
    assert.include(documentHtml, 'Workspaces are disabled on this preview server.');
  });
});
