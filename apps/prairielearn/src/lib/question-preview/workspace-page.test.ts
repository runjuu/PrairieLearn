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
  actionUrl: '/workspace/1',
  containerUrl: '/workspace/1/container/',
  questionUrl: '/questions/demo/workspace?variant=1',
  statusUrl: '/workspace/1/status',
};

function makeEntry(overrides: Partial<PreviewWorkspaceEntry> = {}): PreviewWorkspaceEntry {
  return {
    fileGenerationErrors: [],
    hostPort: null,
    id: '1',
    lastActivityAt: 0,
    launchGeneration: 1,
    message: 'Launching workspace.',
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
    version: 1,
    ...overrides,
  };
}

describe('makePreviewWorkspaceStatusJson', () => {
  it('exposes the iframe source only when the workspace is running', () => {
    const running = makePreviewWorkspaceStatusJson(
      makeEntry({ hostPort: 40100, message: 'Workspace is running.', state: 'running' }),
      { containerUrl: URLS.containerUrl },
    );
    assert.deepEqual(running, {
      iframeSrc: '/workspace/1/container/',
      message: 'Workspace is running.',
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
    assert.include(documentHtml, 'Launching workspace.');
    assert.include(documentHtml, 'id="workspace-waiting-panel"');
    assert.notInclude(documentHtml, 'src="/workspace/1/container/"');
  });

  it('renders a running workspace with the iframe pointed at the container', () => {
    const documentHtml = renderPreviewWorkspacePageHtml({
      entry: makeEntry({ hostPort: 40100, message: 'Workspace is running.', state: 'running' }),
      urls: URLS,
    });

    assert.include(documentHtml, 'data-state="running"');
    assert.include(documentHtml, 'src="/workspace/1/container/"');
  });

  it('renders reboot and reset forms posting back to the workspace page', () => {
    const documentHtml = renderPreviewWorkspacePageHtml({ entry: makeEntry(), urls: URLS });

    assert.include(documentHtml, 'action="/workspace/1"');
    assert.include(documentHtml, 'value="reboot"');
    assert.include(documentHtml, 'value="reset"');
    assert.include(documentHtml, `href="${URLS.questionUrl}"`);
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
