import fs from 'node:fs/promises';
import path from 'node:path';

import * as workspaceUtils from '@prairielearn/workspace-utils';

import { generateWorkspaceFiles } from '../workspace.js';

import type { PreviewWorkspaceFileGenerationError } from './workspace-registry.js';

interface PreviewWorkspaceGradedFile {
  /** Base64-encoded file contents, matching `submitted_answer._files` entries. */
  contents: string;
  name: string;
}

export type PreviewWorkspaceGradedFilesResult =
  | { files: PreviewWorkspaceGradedFile[]; ok: true }
  | { formatError: string; ok: false };

export interface PreviewWorkspaceGradedFilesLimits {
  maxFiles: number;
  maxSize: number;
}

/**
 * Mirrors the production home directory layout
 * (`<root>/workspace-<id>-<version>/current`) so images and debugging
 * expectations carry over.
 */
export function makePreviewWorkspaceHomeDir(homeRoot: string, id: string, version: number) {
  return path.join(homeRoot, `workspace-${id}-${version}`, 'current');
}

/**
 * Generates the workspace home directory contents (static files, rendered
 * templates, and dynamic `_workspace_files`) for a preview workspace, then
 * makes the tree world-accessible so container users other than the host user
 * can read and write it.
 */
export async function generatePreviewWorkspaceFiles({
  courseDir,
  homeDir,
  params,
  qid,
  trueAnswer,
}: {
  courseDir: string;
  homeDir: string;
  params: Record<string, unknown>;
  qid: string;
  trueAnswer: Record<string, unknown>;
}): Promise<{ fileGenerationErrors: PreviewWorkspaceFileGenerationError[] }> {
  const { fileGenerationErrors } = await generateWorkspaceFiles({
    correctAnswers: trueAnswer,
    params,
    questionBasePath: path.join(courseDir, 'questions', qid),
    serverFilesCoursePath: path.join(courseDir, 'serverFilesCourse'),
    targetPath: homeDir,
  });
  await makeTreeWorldAccessible(homeDir);

  return {
    fileGenerationErrors: fileGenerationErrors.map(({ file, msg }) => ({ file, msg })),
  };
}

async function makeTreeWorldAccessible(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const paths = [root, ...entries.map((entry) => path.join(entry.parentPath, entry.name))];

  for (const entryPath of paths) {
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) continue;

    const executable = stats.isDirectory() || (stats.mode & 0o111) !== 0;
    await fs.chmod(entryPath, stats.mode | 0o666 | (executable ? 0o111 : 0));
  }
}

/**
 * Collects the question's graded files from the workspace home directory as
 * base64 `_files` entries. A missing home directory yields an empty list: the
 * `pl-workspace` element's required-file check reports what is missing.
 * Limit violations become a submission format error, mirroring how the full
 * server handles `SubmissionFormatError`.
 */
export async function collectPreviewWorkspaceGradedFiles({
  gradedFiles,
  homeDir,
  limits,
}: {
  gradedFiles: string[];
  homeDir: string;
  limits: PreviewWorkspaceGradedFilesLimits;
}): Promise<PreviewWorkspaceGradedFilesResult> {
  if (gradedFiles.length === 0) return { files: [], ok: true };

  try {
    await fs.access(homeDir);
  } catch {
    return { files: [], ok: true };
  }

  let entries;
  try {
    entries = await workspaceUtils.getWorkspaceGradedFiles(homeDir, gradedFiles, limits);
  } catch (err) {
    return { formatError: err instanceof Error ? err.message : String(err), ok: false };
  }

  const files: PreviewWorkspaceGradedFile[] = [];
  for (const entry of entries) {
    const contents = await fs.readFile(path.join(homeDir, entry.path));
    files.push({ contents: contents.toString('base64'), name: entry.path });
  }

  return { files, ok: true };
}
