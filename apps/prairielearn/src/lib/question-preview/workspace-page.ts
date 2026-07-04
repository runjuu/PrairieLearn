import { html, unsafeHtml } from '@prairielearn/html';

import { HeadContents } from '../../components/HeadContents.js';

import type { PreviewWorkspaceEntry, PreviewWorkspaceState } from './workspace-registry.js';

export interface PreviewWorkspacePageUrls {
  actionUrl: string;
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
 * Scoped styles for the workspace control bar. Kept inline for the same reason
 * as the client script below: the preview page has no compiled asset bundle.
 * The bar is a refined dark toolbar that blends with the workspace iframe. The
 * title and status share one row with the actions and truncate as space gets
 * tight, so the buttons stay in place instead of wrapping below; only on the
 * narrowest screens do the buttons collapse to icons and the muted path line
 * hide. All selectors are prefixed `pv-` so they cannot collide with Bootstrap.
 */
const WORKSPACE_PAGE_STYLE = `
  .pv-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem 0.8rem;
    flex: 0 0 auto;
    padding: 0.4rem 0.85rem;
    background: #1e222a;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    color: #e9ecef;
  }
  .pv-toolbar__header {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    flex: 1 1 0;
  }
  .pv-toolbar__identity {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    flex: 0 1 auto;
  }
  .pv-toolbar__titles {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.2;
  }
  .pv-toolbar__preview {
    font-weight: 400;
    font-size: 0.85em;
    color: #8b95a5;
  }
  .pv-toolbar__path {
    font-size: 0.75rem;
    color: #8b95a5;
  }
  .pv-toolbar__message {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #cdd4de;
  }
  .pv-toolbar__actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 0 0 auto;
  }

  .pv-status {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    flex: 0 1 auto;
    font-size: 0.82rem;
    font-weight: 500;
  }
  .pv-status::before {
    content: '';
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: currentColor;
    flex: 0 0 auto;
  }
  .pv-status--running {
    color: #4ade80;
  }
  .pv-status--failed {
    color: #f87171;
  }
  .pv-status--launching,
  .pv-status--uninitialized {
    color: #fbbf24;
  }
  .pv-status--launching::before {
    animation: pv-pulse 1s ease-in-out infinite;
  }
  .pv-status--stopped {
    color: #9aa4b2;
  }
  .pv-status--failed .pv-toolbar__message {
    color: #f0a5a5;
  }
  @keyframes pv-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  .pv-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.6rem;
    font-size: 0.78rem;
    font-weight: 500;
    line-height: 1.4;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.04);
    color: #e9ecef;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 0.12s,
      border-color 0.12s;
  }
  .pv-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.32);
    color: #fff;
  }
  .pv-btn:focus-visible {
    outline: 2px solid #6ea8fe;
    outline-offset: 1px;
  }
  .pv-btn i {
    font-size: 0.9rem;
  }
  .pv-btn--danger {
    color: #ff9b9b;
    border-color: rgba(239, 68, 68, 0.4);
  }
  .pv-btn--danger:hover {
    background: rgba(220, 53, 69, 0.2);
    border-color: #dc3545;
    color: #ffb0b0;
  }

  /* Narrow: buttons collapse to icons, and the muted path line is hidden. */
  @media (max-width: 480px) {
    .pv-btn__label {
      display: none;
    }
    .pv-btn {
      padding: 0.3rem 0.45rem;
    }
    .pv-toolbar__path {
      display: none;
    }
  }
`;

/**
 * Client logic for the workspace page. Kept as an inline script instead of a
 * compiled asset bundle so the page has no build-time dependencies: it polls
 * the status endpoint while the workspace launches, points the iframe at the
 * container once it is running, and then sends visibility-gated heartbeats so
 * an open workspace does not idle out.
 */
const WORKSPACE_PAGE_SCRIPT = `
(() => {
  const POLL_INTERVAL_MS = 1000;
  const HEARTBEAT_INTERVAL_MS = 60000;

  const root = document.getElementById('workspace-root');
  const iframe = document.getElementById('workspace-frame');
  const statusEl = document.getElementById('workspace-status');
  const messageText = document.getElementById('workspace-message');
  const waitingPanel = document.getElementById('workspace-waiting-panel');
  const stoppedPanel = document.getElementById('workspace-stopped-panel');
  const stoppedMessage = document.getElementById('workspace-stopped-message');

  let lastHeartbeatAt = Date.now();

  function applyStatus(status) {
    root.dataset.state = status.state;
    statusEl.className = 'pv-status pv-status--' + status.state;
    messageText.textContent = status.message;

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
  const qidName = entry.spec.qid.split('/').pop() || entry.spec.qid;

  return html`
    <!doctype html>
    <html lang="en" class="h-100">
      <head>
        ${HeadContents({ pageTitle: `Workspace preview: ${entry.spec.qid}`, resLocals: {} })}
        <style>
          ${unsafeHtml(WORKSPACE_PAGE_STYLE)}
        </style>
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
          <nav class="pv-toolbar" aria-label="Workspace controls">
            <div class="pv-toolbar__header">
              <div class="pv-toolbar__identity" title="${entry.spec.qid}">
                <span class="pv-toolbar__titles">
                  <span class="pv-toolbar__name text-truncate">
                    ${qidName} <span class="pv-toolbar__preview">(Preview)</span>
                  </span>
                  <span class="pv-toolbar__path text-truncate">${entry.spec.qid}</span>
                </span>
              </div>
              <span
                id="workspace-status"
                class="pv-status pv-status--${entry.state}"
                role="status"
                aria-live="polite"
              >
                <span id="workspace-message" class="pv-toolbar__message">${entry.message}</span>
              </span>
            </div>
            <div class="pv-toolbar__actions">
              <form method="POST" action="${urls.actionUrl}">
                <button
                  type="submit"
                  class="pv-btn"
                  name="__action"
                  value="reboot"
                  aria-label="Reboot workspace"
                  onclick="return confirm('Reboot the workspace? Files are kept.');"
                >
                  <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
                  <span class="pv-btn__label">Reboot</span>
                </button>
              </form>
              <form method="POST" action="${urls.actionUrl}">
                <button
                  type="submit"
                  class="pv-btn pv-btn--danger"
                  name="__action"
                  value="reset"
                  aria-label="Reset workspace"
                  onclick="return confirm('Reset the workspace? All changes to its files are discarded.');"
                >
                  <i class="bi bi-trash3" aria-hidden="true"></i>
                  <span class="pv-btn__label">Reset</span>
                </button>
              </form>
            </div>
          </nav>
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
