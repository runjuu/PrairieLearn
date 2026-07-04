import path from 'node:path';

import { LRUCache } from 'lru-cache';

const GENERATED_FILES_PATH_PREFIX = '/generatedFilesQuestion/variant/';
const DEFAULT_LOCAL_PREVIEW_VARIANT_REGISTRY_MAX = 256;

const localPreviewVariantIdentityBrand: unique symbol = Symbol('LocalPreviewVariantIdentity');

export interface LocalPreviewVariantIdentity {
  readonly [localPreviewVariantIdentityBrand]: true;
  readonly generatedFilesUrl: string;
  readonly id: string;
}

interface QuestionPreviewGeneratedFileIssue {
  data?: unknown;
  fatal: boolean;
  message: string;
  name: string;
}

export interface QuestionPreviewGeneratedFile {
  data: Buffer | string;
  issues: QuestionPreviewGeneratedFileIssue[];
}

interface GeneratedFileRequest {
  filename: string;
  variantId: string;
}

type QuestionPreviewGeneratedFileProvider = (
  filename: string,
) => Promise<QuestionPreviewGeneratedFile>;

export type QuestionPreviewGeneratedFileAdapter = (filename: string) => Promise<{
  courseIssues: (Error & { fatal?: boolean; data?: unknown })[];
  data: Buffer | string;
}>;

function decodeSafeUrlPathSegments(encodedPath: string) {
  if (encodedPath.length === 0) return null;

  const decodedSegments: string[] = [];
  for (const segment of encodedPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }

    if (
      decoded.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\0') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      path.isAbsolute(decoded)
    ) {
      return null;
    }

    decodedSegments.push(decoded);
  }

  return decodedSegments;
}

function generatedFileRequestFromPathname({
  pathname,
  urlPrefix,
}: {
  pathname: string;
  urlPrefix: string;
}): GeneratedFileRequest | null {
  const routePrefix = `${urlPrefix}${GENERATED_FILES_PATH_PREFIX}`;
  if (!pathname.startsWith(routePrefix)) return null;

  const segments = decodeSafeUrlPathSegments(pathname.slice(routePrefix.length));
  if (segments == null || segments.length < 2) return null;

  const [variantId, ...fileSegments] = segments;

  return {
    filename: fileSegments.join('/'),
    variantId,
  };
}

function generatedFileIssuesFromCourseIssues(
  courseIssues: (Error & { fatal?: boolean; data?: unknown })[],
): QuestionPreviewGeneratedFileIssue[] {
  return courseIssues.map((issue) => ({
    data: issue.data,
    fatal: issue.fatal ?? false,
    message: issue.message,
    name: issue.name,
  }));
}

export class LocalPreviewGeneratedFiles {
  private nextVariantId = 1;
  private readonly entries: LRUCache<string, QuestionPreviewGeneratedFileProvider>;
  private readonly urlPrefix: string;

  constructor({
    max = DEFAULT_LOCAL_PREVIEW_VARIANT_REGISTRY_MAX,
    urlPrefix,
  }: {
    max?: number;
    urlPrefix: string;
  }) {
    this.entries = new LRUCache({ max });
    this.urlPrefix = urlPrefix;
  }

  get routePattern() {
    return `${this.urlPrefix}${GENERATED_FILES_PATH_PREFIX}*`;
  }

  createVariantIdentity(): LocalPreviewVariantIdentity {
    const id = String(this.nextVariantId++);
    const identity: LocalPreviewVariantIdentity = {
      [localPreviewVariantIdentityBrand]: true,
      generatedFilesUrl: this.generatedFilesUrl(id),
      id,
    };

    Object.defineProperty(identity, localPreviewVariantIdentityBrand, { enumerable: false });
    return Object.freeze(identity);
  }

  private generatedFilesUrl(variantId: string) {
    return `${this.urlPrefix}${GENERATED_FILES_PATH_PREFIX}${encodeURIComponent(variantId)}`;
  }

  registerVariantFiles({
    file,
    identity,
  }: {
    file: QuestionPreviewGeneratedFileAdapter | null;
    identity: LocalPreviewVariantIdentity;
  }) {
    this.entries.set(identity.id, async (filename) => {
      if (file == null) {
        return {
          data: '',
          issues: [
            {
              fatal: true,
              message:
                'Question preview generated-file URL requested, but the question type has no file() handler.',
              name: 'Error',
            },
          ],
        };
      }

      const fileResult = await file(filename);

      return {
        data: fileResult.data,
        issues: generatedFileIssuesFromCourseIssues(fileResult.courseIssues),
      };
    });
  }

  async resolveRequest(pathname: string) {
    const generatedFileRequest = generatedFileRequestFromPathname({
      pathname,
      urlPrefix: this.urlPrefix,
    });
    if (generatedFileRequest == null) return null;

    const generatedFile = await this.entries.get(generatedFileRequest.variantId)?.(
      generatedFileRequest.filename,
    );
    if (generatedFile == null) return { found: false as const };

    return {
      filename: generatedFileRequest.filename,
      found: true as const,
      generatedFile,
    };
  }
}
