import { html, unsafeHtml } from '@prairielearn/html';

import { HeadContents } from '../../components/HeadContents.js';

import type { PreviewWorkspaceEntry, PreviewWorkspaceState } from './workspace-registry.js';

export interface PreviewWorkspacePageUrls {
  containerUrl: string;
  statusUrl: string;
}

export interface PreviewWorkspaceStatusJson {
  iframeSrc: string | null;
  message: string;
  state: PreviewWorkspaceState;
  version: number;
}

export function makePreviewWorkspaceStatusJson(
  entry: PreviewWorkspaceEntry,
  { containerUrl }: { containerUrl: string },
): PreviewWorkspaceStatusJson {
  return {
    iframeSrc: entry.state === 'running' ? containerUrl : null,
    message: entry.message,
    state: entry.state,
    version: entry.version,
  };
}

/**
 * Client logic for the workspace page. Kept as an inline script instead of a
 * compiled asset bundle so the page has no build-time dependencies: it polls
 * the status endpoint while the workspace launches, points the iframe at the
 * container once it is running, and then sends visibility-gated heartbeats so
 * an open workspace does not idle out. The page is chromeless — the embedding
 * host (the VS Code preview extension) renders the workspace controls and
 * reflects status by polling the status endpoint itself.
 */
const WORKSPACE_PAGE_SCRIPT = `
(() => {
  const POLL_INTERVAL_MS = 1000;
  const HEARTBEAT_INTERVAL_MS = 60000;

  const root = document.getElementById('workspace-root');
  const iframe = document.getElementById('workspace-frame');
  const waitingPanel = document.getElementById('workspace-waiting-panel');
  const stoppedPanel = document.getElementById('workspace-stopped-panel');
  const stoppedMessage = document.getElementById('workspace-stopped-message');

  let lastHeartbeatAt = Date.now();

  function applyStatus(status) {
    root.dataset.state = status.state;

    const running = status.state === 'running';
    const waiting = status.state === 'launching' || status.state === 'uninitialized';
    if (running && status.iframeSrc && iframe.getAttribute('src') !== status.iframeSrc) {
      iframe.setAttribute('src', status.iframeSrc);
    }
    iframe.classList.toggle('d-none', !running);
    waitingPanel.classList.toggle('d-none', !waiting);
    stoppedPanel.classList.toggle('d-none', running || waiting);
    stoppedMessage.textContent = status.message;
  }

  async function fetchStatus(heartbeat) {
    const url = root.dataset.statusUrl + (heartbeat ? '?heartbeat=1' : '');
    const response = await fetch(url);
    if (!response.ok) return;
    applyStatus(await response.json());
  }

  setInterval(() => {
    if (root.dataset.state !== 'running') {
      fetchStatus(false).catch(() => {});
      return;
    }

    const visible = document.visibilityState === 'visible';
    if (visible && Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = Date.now();
      fetchStatus(true).catch(() => {});
    }
  }, POLL_INTERVAL_MS);
})();
`;

export function renderPreviewWorkspacePageHtml({
  entry,
  urls,
}: {
  entry: PreviewWorkspaceEntry;
  urls: PreviewWorkspacePageUrls;
}): string {
  const running = entry.state === 'running';
  const waiting = entry.state === 'launching' || entry.state === 'uninitialized';

  return html`
    <!doctype html>
    <html lang="en" class="h-100">
      <head>
        ${HeadContents({ pageTitle: `Workspace preview: ${entry.spec.qid}`, resLocals: {} })}
      </head>
      <body class="d-flex flex-column h-100">
        <div
          id="workspace-root"
          class="d-flex flex-column flex-grow-1"
          data-container-url="${urls.containerUrl}"
          data-state="${entry.state}"
          data-status-url="${urls.statusUrl}"
          data-workspace-id="${entry.id}"
        >
          ${entry.fileGenerationErrors.length === 0
            ? ''
            : html`
                <div class="alert alert-warning rounded-0 mb-0" role="alert">
                  <strong>Workspace file errors:</strong>
                  <ul class="mb-0">
                    ${entry.fileGenerationErrors.map(
                      (error) => html`<li><code>${error.file}</code>: ${error.msg}</li>`,
                    )}
                  </ul>
                </div>
              `}
          <div
            id="workspace-waiting-panel"
            class="d-flex flex-column align-items-center justify-content-center flex-grow-1 gap-3 ${waiting
              ? ''
              : 'd-none'}"
          >
            <div class="spinner-border" role="status">
              <span class="visually-hidden">Loading workspace</span>
            </div>
            <p class="text-muted mb-0">
              The workspace is starting. This page updates automatically.
            </p>
          </div>
          <div
            id="workspace-stopped-panel"
            class="d-flex flex-column align-items-center justify-content-center flex-grow-1 gap-3 ${running ||
            waiting
              ? 'd-none'
              : ''}"
          >
            <p id="workspace-stopped-message" class="mb-0">${entry.message}</p>
            <a class="btn btn-primary" href="">Relaunch workspace</a>
          </div>
          <iframe
            id="workspace-frame"
            class="flex-grow-1 border-0 ${running ? '' : 'd-none'}"
            title="Workspace"
            ${running ? html`src="${urls.containerUrl}"` : ''}
          ></iframe>
        </div>
        <script>
          ${unsafeHtml(WORKSPACE_PAGE_SCRIPT)};
        </script>
      </body>
    </html>
  `.toString();
}

export function renderPreviewWorkspaceUnavailableHtml({ reason }: { reason: string }): string {
  return html`
    <!doctype html>
    <html lang="en">
      <head>
        ${HeadContents({ pageTitle: 'Workspace preview unavailable', resLocals: {} })}
      </head>
      <body>
        <main class="container py-5">
          <div class="alert alert-secondary" role="alert">
            <h1 class="h5">Workspace unavailable</h1>
            <p class="mb-0">${reason}</p>
          </div>
        </main>
      </body>
    </html>
  `.toString();
}
