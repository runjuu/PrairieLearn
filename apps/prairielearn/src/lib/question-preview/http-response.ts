import { QUESTION_PREVIEW_ERROR_DOCUMENT, type QuestionPreviewDocumentResult } from './document.js';
import type { QuestionPreviewGeneratedFile } from './generated-files.js';

export type QuestionPreviewHttpResponse =
  | {
      kind: 'attachment';
      data: Buffer | string;
      filename: string;
      status: 200;
    }
  | {
      kind: 'empty';
      status: number;
    }
  | {
      filePath: string;
      headers: Record<string, string>;
      kind: 'file';
      status: 200;
    }
  | {
      html: string;
      kind: 'html';
      status: number;
    }
  | {
      body: unknown;
      kind: 'json';
      status: number;
    }
  | {
      kind: 'redirect';
      location: string;
      status: 303;
    };

export interface QuestionPreviewHttpLogEntry {
  details: unknown;
  message: string;
}

export interface QuestionPreviewHttpAction {
  logs: QuestionPreviewHttpLogEntry[];
  response: QuestionPreviewHttpResponse;
}

export type QuestionPreviewGeneratedFileHttpResult =
  | {
      found: false;
    }
  | {
      filename: string;
      found: true;
      generatedFile: QuestionPreviewGeneratedFile;
    };

function action(
  response: QuestionPreviewHttpResponse,
  logs: QuestionPreviewHttpLogEntry[] = [],
): QuestionPreviewHttpAction {
  return { logs, response };
}

function errorStatusCode(err: unknown) {
  if (typeof err !== 'object' || err == null || Array.isArray(err)) return null;
  const status = (err as Record<string, unknown>).status;
  return Number.isInteger(status) && (status as number) >= 400 && (status as number) < 600
    ? (status as number)
    : null;
}

export function mapQuestionPreviewInvalidQidResponse(): QuestionPreviewHttpAction {
  return action({
    html: QUESTION_PREVIEW_ERROR_DOCUMENT,
    kind: 'html',
    status: 422,
  });
}

export function mapQuestionPreviewInvalidSubmissionActionResponse(
  submissionAction: unknown,
): QuestionPreviewHttpAction {
  return action(
    {
      html: QUESTION_PREVIEW_ERROR_DOCUMENT,
      kind: 'html',
      status: 400,
    },
    [
      {
        details: { action: submissionAction },
        message: 'Question preview submission rejected: expected __action to be "grade".',
      },
    ],
  );
}

export function mapQuestionPreviewDocumentResponse(
  result: QuestionPreviewDocumentResult,
): QuestionPreviewHttpAction {
  if (result.ok) {
    return action({
      html: result.documentHtml,
      kind: 'html',
      status: 200,
    });
  }

  return action(
    {
      html: result.documentHtml,
      kind: 'html',
      status: 422,
    },
    [{ details: result.diagnostics, message: 'Question preview render failed:' }],
  );
}

export function mapQuestionPreviewGeneratedFileResponse(
  result: QuestionPreviewGeneratedFileHttpResult,
): QuestionPreviewHttpAction {
  if (!result.found) {
    return action({ kind: 'empty', status: 404 });
  }

  if (result.generatedFile.issues.some((issue) => issue.fatal)) {
    return action({ kind: 'empty', status: 422 }, [
      {
        details: result.generatedFile.issues,
        message: 'Question preview generated-file request failed:',
      },
    ]);
  }

  return action({
    data: result.generatedFile.data,
    filename: result.filename,
    kind: 'attachment',
    status: 200,
  });
}

export function mapQuestionPreviewAssetFileResponse(
  filePath: string | null,
): QuestionPreviewHttpAction {
  if (filePath == null) {
    return action({ kind: 'empty', status: 404 });
  }

  return action({
    filePath,
    headers: { 'cache-control': 'no-store' },
    kind: 'file',
    status: 200,
  });
}

export function mapQuestionPreviewWorkspacePageResponse({
  html,
  status,
}: {
  html: string;
  status: 200 | 404;
}): QuestionPreviewHttpAction {
  return action({ html, kind: 'html', status });
}

export function mapQuestionPreviewWorkspaceStatusResponse(
  statusJson: unknown,
): QuestionPreviewHttpAction {
  if (statusJson == null) {
    return action({ kind: 'empty', status: 404 });
  }

  return action({ body: statusJson, kind: 'json', status: 200 });
}

export function mapQuestionPreviewWorkspaceActionResponse(
  input: { kind: 'invalid-action'; action: unknown } | { kind: 'redirect'; location: string },
): QuestionPreviewHttpAction {
  if (input.kind === 'invalid-action') {
    return action({ kind: 'empty', status: 400 }, [
      {
        details: { action: input.action },
        message: 'Workspace action rejected: expected __action to be "reboot" or "reset".',
      },
    ]);
  }

  return action({ kind: 'redirect', location: input.location, status: 303 });
}

export function mapQuestionPreviewRouteErrorResponse(err: unknown): QuestionPreviewHttpAction {
  const status = errorStatusCode(err);
  if (status != null && status < 500) {
    return action({ kind: 'empty', status });
  }

  return action(
    {
      html: QUESTION_PREVIEW_ERROR_DOCUMENT,
      kind: 'html',
      status: 500,
    },
    [{ details: err, message: 'Question preview request failed:' }],
  );
}
