import path from 'node:path';

import type { LocalPreviewCourseResource, LocalPreviewCourseSource } from './course-source.js';
import type { LocalPreviewGeneratedFiles } from './generated-files.js';
import { type QuestionPreviewQid, questionPreviewQidFromPathSegments } from './qid.js';

const STARTUP_COURSE_ASSET_ROUTES = [
  {
    pathPrefix: '/clientFilesCourse/',
    resourceKind: 'course-client-file',
    stripCachebuster: false,
  },
  {
    pathPrefix: '/elements/',
    resourceKind: 'element-file',
    stripCachebuster: false,
  },
  {
    pathPrefix: '/cacheableElements/',
    resourceKind: 'element-file',
    stripCachebuster: true,
  },
  {
    pathPrefix: '/elementExtensions/',
    resourceKind: 'element-extension-file',
    stripCachebuster: false,
  },
  {
    pathPrefix: '/cacheableElementExtensions/',
    resourceKind: 'element-extension-file',
    stripCachebuster: true,
  },
] as const;
const QUESTION_FILES_PATH_PREFIX = '/questions/';

export interface QuestionPreviewAssetUrls {
  clientFilesCourseUrl: string;
  clientFilesQuestionGeneratedFileUrl: string;
  clientFilesQuestionUrl: string;
}

interface MakeQuestionPreviewAssetUrlsParams {
  clientFilesQuestionGeneratedFileUrl: string;
  qid: QuestionPreviewQid;
  urlPrefix: string;
}

export function makeQuestionPreviewAssetUrls({
  clientFilesQuestionGeneratedFileUrl,
  qid,
  urlPrefix,
}: MakeQuestionPreviewAssetUrlsParams): QuestionPreviewAssetUrls {
  return {
    clientFilesCourseUrl: `${urlPrefix}/clientFilesCourse`,
    clientFilesQuestionGeneratedFileUrl,
    clientFilesQuestionUrl: `${urlPrefix}/questions/${qid.encodedPath}/files`,
  };
}

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

type BoundedAssetRequest =
  | { resource: LocalPreviewCourseResource }
  | { legacyQuestionFile: { filename: string; qid: QuestionPreviewQid } };

function withUrlPrefix(urlPrefix: string, pathPrefix: string) {
  return `${urlPrefix}${pathPrefix}`;
}

function startupCourseAssetRequestFromPathname({
  pathname,
  urlPrefix,
}: {
  pathname: string;
  urlPrefix: string;
}): BoundedAssetRequest | null {
  for (const route of STARTUP_COURSE_ASSET_ROUTES) {
    const routePrefix = withUrlPrefix(urlPrefix, route.pathPrefix);
    if (!pathname.startsWith(routePrefix)) continue;

    const segments = decodeSafeUrlPathSegments(pathname.slice(routePrefix.length));
    if (segments == null) return null;

    const fileSegments = route.stripCachebuster ? segments.slice(1) : segments;
    if (fileSegments.length === 0) return null;

    return {
      resource: { filePathSegments: fileSegments, kind: route.resourceKind },
    };
  }

  const questionFilesPrefix = withUrlPrefix(urlPrefix, QUESTION_FILES_PATH_PREFIX);
  if (pathname.startsWith(questionFilesPrefix)) {
    const segments = decodeSafeUrlPathSegments(pathname.slice(questionFilesPrefix.length));
    if (segments == null) return null;

    const legacyFilesSegmentIndex = segments.lastIndexOf('legacy-files');
    if (legacyFilesSegmentIndex > 0 && legacyFilesSegmentIndex === segments.length - 2) {
      const qidResult = questionPreviewQidFromPathSegments(
        segments.slice(0, legacyFilesSegmentIndex),
      );
      if (!qidResult.ok) return null;
      return {
        legacyQuestionFile: {
          filename: segments[legacyFilesSegmentIndex + 1],
          qid: qidResult.qid,
        },
      };
    }

    const filesSegmentIndex = segments.lastIndexOf('files');
    if (filesSegmentIndex <= 0 || filesSegmentIndex === segments.length - 1) return null;

    const qidSegments = segments.slice(0, filesSegmentIndex);
    const fileSegments = segments.slice(filesSegmentIndex + 1);
    const qidResult = questionPreviewQidFromPathSegments(qidSegments);
    if (!qidResult.ok) return null;

    return {
      resource: {
        filePathSegments: fileSegments,
        kind: 'question-client-file',
        qid: qidResult.qid,
      },
    };
  }

  return null;
}

interface CreateQuestionPreviewAssetResolverParams {
  courseSource: LocalPreviewCourseSource;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  urlPrefix: string;
}

export function createQuestionPreviewAssetResolver({
  courseSource,
  localPreviewGeneratedFiles,
  urlPrefix,
}: CreateQuestionPreviewAssetResolverParams) {
  return {
    routePatterns: [
      ...STARTUP_COURSE_ASSET_ROUTES.map(
        (route) => `${withUrlPrefix(urlPrefix, route.pathPrefix)}*`,
      ),
      `${withUrlPrefix(urlPrefix, QUESTION_FILES_PATH_PREFIX)}*`,
      localPreviewGeneratedFiles.routePattern,
    ],
    async resolve(pathname: string) {
      const assetRequest = startupCourseAssetRequestFromPathname({
        pathname,
        urlPrefix,
      });

      if (assetRequest == null) return null;
      if ('legacyQuestionFile' in assetRequest) {
        const { filename, qid } = assetRequest.legacyQuestionFile;
        const info = await courseSource.readQuestionInfo(qid);
        if (info.type === 'v3' || !info.clientFiles.includes(filename)) return null;
        return (
          await courseSource.resolveLegacyQuestionFile({
            filename,
            info,
            qid,
          })
        ).fullPath;
      }
      return courseSource.resolveResource(assetRequest.resource);
    },
    async resolveGeneratedFile(pathname: string) {
      return localPreviewGeneratedFiles.resolveRequest(pathname);
    },
  };
}
