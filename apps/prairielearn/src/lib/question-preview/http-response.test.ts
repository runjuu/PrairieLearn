import { assert, describe, it } from 'vitest';

import { QUESTION_PREVIEW_ERROR_DOCUMENT, type QuestionPreviewDiagnostic } from './document.js';
import {
  mapQuestionPreviewAssetFileResponse,
  mapQuestionPreviewDocumentResponse,
  mapQuestionPreviewGeneratedFileResponse,
  mapQuestionPreviewGradingDisabledResponse,
  mapQuestionPreviewInvalidQidResponse,
  mapQuestionPreviewInvalidRenderModeResponse,
  mapQuestionPreviewInvalidSubmissionActionResponse,
  mapQuestionPreviewRenderModeUnavailableResponse,
  mapQuestionPreviewRouteErrorResponse,
} from './http-response.js';

function testSuccessDocument() {
  return {
    diagnostics: [],
    documentHtml: '<!doctype html><html><body>Rendered preview</body></html>',
    ok: true as const,
  };
}

function testFailureDocument(diagnostics: QuestionPreviewDiagnostic[] = []) {
  return {
    diagnostics,
    documentHtml: '<!doctype html><html><body>Question preview failed</body></html>',
    ok: false as const,
    reason: 'render-failure' as const,
  };
}

describe('question preview HTTP response mapping', () => {
  it('maps direct preview documents into browser-safe HTML responses and logs failures', () => {
    assert.deepEqual(mapQuestionPreviewDocumentResponse(testSuccessDocument()), {
      logs: [],
      response: {
        html: '<!doctype html><html><body>Rendered preview</body></html>',
        kind: 'html',
        status: 200,
      },
    });

    const diagnostics: QuestionPreviewDiagnostic[] = [
      {
        fatal: true,
        message: 'metadata failed',
        name: 'CourseIssueError',
        phase: 'metadata',
      },
    ];

    assert.deepEqual(mapQuestionPreviewDocumentResponse(testFailureDocument(diagnostics)), {
      logs: [{ details: diagnostics, message: 'Question preview render failed:' }],
      response: {
        html: '<!doctype html><html><body>Question preview failed</body></html>',
        kind: 'html',
        status: 422,
      },
    });

    assert.deepEqual(
      mapQuestionPreviewDocumentResponse({
        ...testFailureDocument(diagnostics),
        reason: 'question-not-found',
      }),
      {
        logs: [],
        response: {
          html: '<!doctype html><html><body>Question preview failed</body></html>',
          kind: 'html',
          status: 404,
        },
      },
    );
  });

  it('maps generated-file results into empty, logged, or attachment responses', () => {
    assert.deepEqual(mapQuestionPreviewGeneratedFileResponse({ found: false }), {
      logs: [],
      response: { kind: 'empty', status: 404 },
    });

    const fatalIssue = {
      fatal: true,
      message: 'Generated file failed.',
      name: 'CourseIssueError',
    };
    assert.deepEqual(
      mapQuestionPreviewGeneratedFileResponse({
        filename: 'data.txt',
        found: true,
        generatedFile: {
          data: '',
          issues: [fatalIssue],
        },
      }),
      {
        logs: [
          {
            details: [fatalIssue],
            message: 'Question preview generated-file request failed:',
          },
        ],
        response: { kind: 'empty', status: 422 },
      },
    );

    assert.deepEqual(
      mapQuestionPreviewGeneratedFileResponse({
        filename: 'data.txt',
        found: true,
        generatedFile: {
          data: 'generated',
          issues: [],
        },
      }),
      {
        logs: [],
        response: {
          data: 'generated',
          filename: 'data.txt',
          kind: 'attachment',
          status: 200,
        },
      },
    );
  });

  it('maps ordinary asset files and route errors without Express response objects', () => {
    assert.deepEqual(mapQuestionPreviewAssetFileResponse(null), {
      logs: [],
      response: { kind: 'empty', status: 404 },
    });
    assert.deepEqual(mapQuestionPreviewAssetFileResponse('/course/clientFilesCourse/app.css'), {
      logs: [],
      response: {
        filePath: '/course/clientFilesCourse/app.css',
        headers: { 'cache-control': 'no-store' },
        kind: 'file',
        status: 200,
      },
    });

    assert.deepEqual(mapQuestionPreviewInvalidQidResponse(), {
      logs: [],
      response: {
        html: QUESTION_PREVIEW_ERROR_DOCUMENT,
        kind: 'html',
        status: 422,
      },
    });

    assert.deepEqual(mapQuestionPreviewInvalidSubmissionActionResponse('save'), {
      logs: [
        {
          details: { action: 'save' },
          message: 'Question preview submission rejected: expected __action to be "grade".',
        },
      ],
      response: {
        html: QUESTION_PREVIEW_ERROR_DOCUMENT,
        kind: 'html',
        status: 400,
      },
    });

    assert.deepEqual(mapQuestionPreviewInvalidRenderModeResponse('bogus'), {
      logs: [
        {
          details: { renderMode: 'bogus' },
          message:
            'Question preview request rejected: invalid render-mode query parameter. Expected "full" or "question-only".',
        },
      ],
      response: {
        html: QUESTION_PREVIEW_ERROR_DOCUMENT,
        kind: 'html',
        status: 400,
      },
    });

    assert.deepEqual(mapQuestionPreviewRenderModeUnavailableResponse(), {
      logs: [
        {
          details: {},
          message:
            'Question preview request rejected: the "full" render mode is unavailable on a question-only preview server.',
        },
      ],
      response: {
        html: QUESTION_PREVIEW_ERROR_DOCUMENT,
        kind: 'html',
        status: 400,
      },
    });

    assert.deepEqual(mapQuestionPreviewGradingDisabledResponse(), {
      logs: [
        {
          details: {},
          message:
            'Question preview submission rejected: grading is disabled in question-only render mode.',
        },
      ],
      response: { kind: 'empty', status: 405 },
    });

    const notFoundError = { status: 404 };
    assert.deepEqual(mapQuestionPreviewRouteErrorResponse(notFoundError), {
      logs: [],
      response: { kind: 'empty', status: 404 },
    });

    const infrastructureError = new Error('runtime crashed');
    const infrastructureResponse = mapQuestionPreviewRouteErrorResponse(infrastructureError);
    assert.deepEqual(infrastructureResponse.logs, [
      { details: infrastructureError, message: 'Question preview request failed:' },
    ]);
    assert.equal(infrastructureResponse.response.kind, 'html');
    assert.equal(infrastructureResponse.response.status, 500);
  });
});
