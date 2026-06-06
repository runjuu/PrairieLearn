import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalPreviewGeneratedFiles } from './question-preview-generated-files.js';
import {
  type QuestionPreviewQid,
  questionPreviewQidFromPathSegments,
} from './question-preview-qid.js';

const STARTUP_COURSE_ASSET_ROUTES = [
  {
    pathPrefix: '/clientFilesCourse/',
    rootPathSegments: ['clientFilesCourse'],
    stripCachebuster: false,
  },
  {
    pathPrefix: '/elements/',
    rootPathSegments: ['elements'],
    stripCachebuster: false,
  },
  {
    pathPrefix: '/cacheableElements/',
    rootPathSegments: ['elements'],
    stripCachebuster: true,
  },
  {
    pathPrefix: '/elementExtensions/',
    rootPathSegments: ['elementExtensions'],
    stripCachebuster: false,
  },
  {
    pathPrefix: '/cacheableElementExtensions/',
    rootPathSegments: ['elementExtensions'],
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

export function isPathInsideRoot(root: string, filePath: string) {
  const relativePath = path.relative(root, filePath);
  return (
    relativePath.length === 0 || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

export function decodeSafeUrlPathSegments(encodedPath: string) {
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

interface BoundedAssetRequest {
  roots: string[];
  segments: string[];
}

async function resolveBoundedFile(rootInput: string, pathSegments: string[]) {
  const root = path.resolve(rootInput);
  const filePath = path.resolve(root, ...pathSegments);
  if (!isPathInsideRoot(root, filePath)) return null;
  if (!(await fs.stat(root)).isDirectory()) return null;
  if (!(await fs.stat(filePath)).isFile()) return null;

  return filePath;
}

async function resolveBoundedFileFromRoots(roots: string[], pathSegments: string[]) {
  for (const root of roots) {
    try {
      const filePath = await resolveBoundedFile(root, pathSegments);
      if (filePath !== null) return filePath;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') continue;
      throw err;
    }
  }

  return null;
}

function withUrlPrefix(urlPrefix: string, pathPrefix: string) {
  return `${urlPrefix}${pathPrefix}`;
}

function startupCourseAssetRequestFromPathname({
  courseDir,
  pathname,
  urlPrefix,
}: {
  courseDir: string;
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
      roots: [path.join(courseDir, ...route.rootPathSegments)],
      segments: fileSegments,
    };
  }

  const questionFilesPrefix = withUrlPrefix(urlPrefix, QUESTION_FILES_PATH_PREFIX);
  if (pathname.startsWith(questionFilesPrefix)) {
    const segments = decodeSafeUrlPathSegments(pathname.slice(questionFilesPrefix.length));
    if (segments == null) return null;

    const filesSegmentIndex = segments.lastIndexOf('files');
    if (filesSegmentIndex <= 0 || filesSegmentIndex === segments.length - 1) return null;

    const qidSegments = segments.slice(0, filesSegmentIndex);
    const fileSegments = segments.slice(filesSegmentIndex + 1);
    const qidResult = questionPreviewQidFromPathSegments(qidSegments);
    if (!qidResult.ok) return null;

    return {
      roots: [
        path.join(courseDir, 'questions', ...qidResult.qid.pathSegments, 'clientFilesQuestion'),
      ],
      segments: fileSegments,
    };
  }

  return null;
}

interface CreateQuestionPreviewAssetResolverParams {
  courseDir: string;
  localPreviewGeneratedFiles: LocalPreviewGeneratedFiles;
  urlPrefix: string;
}

export function createQuestionPreviewAssetResolver({
  courseDir,
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
        courseDir,
        pathname,
        urlPrefix,
      });

      if (assetRequest == null) return null;
      return resolveBoundedFileFromRoots(assetRequest.roots, assetRequest.segments);
    },
    async resolveGeneratedFile(pathname: string) {
      return localPreviewGeneratedFiles.resolveRequest(pathname);
    },
  };
}
