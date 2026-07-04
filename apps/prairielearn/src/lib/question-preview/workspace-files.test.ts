import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, it } from 'vitest';

import {
  collectPreviewWorkspaceGradedFiles,
  generatePreviewWorkspaceFiles,
  makePreviewWorkspaceHomeDir,
} from './workspace-files.js';

const LIMITS = { maxFiles: 100, maxSize: 100 * 1024 * 1024 };

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-workspace-files-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { force: true, recursive: true });
});

async function makeQuestionDir(qid: string) {
  const questionDir = path.join(tempDir, 'course', 'questions', qid);
  await fs.mkdir(questionDir, { recursive: true });
  return questionDir;
}

describe('makePreviewWorkspaceHomeDir', () => {
  it('mirrors the production workspace home directory layout', () => {
    assert.equal(
      makePreviewWorkspaceHomeDir('/tmp/homes', '7', 2),
      path.join('/tmp/homes', 'workspace-7-2', 'current'),
    );
  });
});

describe('generatePreviewWorkspaceFiles', () => {
  it('composes static, template, and dynamic files into the home directory', async () => {
    const questionDir = await makeQuestionDir('demo/workspace');
    await fs.mkdir(path.join(questionDir, 'workspace'), { recursive: true });
    await fs.writeFile(path.join(questionDir, 'workspace', 'static.txt'), 'static contents');
    await fs.mkdir(path.join(questionDir, 'workspaceTemplates'), { recursive: true });
    await fs.writeFile(
      path.join(questionDir, 'workspaceTemplates', 'starter.py.mustache'),
      'answer = {{ params.answer }}',
    );

    const homeDir = makePreviewWorkspaceHomeDir(path.join(tempDir, 'homes'), '1', 1);
    const { fileGenerationErrors } = await generatePreviewWorkspaceFiles({
      courseDir: path.join(tempDir, 'course'),
      homeDir,
      params: {
        _workspace_files: [{ contents: 'dynamic contents', name: 'dynamic.txt' }],
        answer: 42,
      },
      qid: 'demo/workspace',
      trueAnswer: {},
    });

    assert.deepEqual(fileGenerationErrors, []);
    assert.equal(await fs.readFile(path.join(homeDir, 'static.txt'), 'utf8'), 'static contents');
    assert.equal(await fs.readFile(path.join(homeDir, 'starter.py'), 'utf8'), 'answer = 42');
    assert.equal(await fs.readFile(path.join(homeDir, 'dynamic.txt'), 'utf8'), 'dynamic contents');
  });

  it('makes generated files world-readable and world-writable', async () => {
    const questionDir = await makeQuestionDir('demo/workspace');
    await fs.mkdir(path.join(questionDir, 'workspace', 'nested'), { recursive: true });
    await fs.writeFile(path.join(questionDir, 'workspace', 'nested', 'file.txt'), 'contents');

    const homeDir = makePreviewWorkspaceHomeDir(path.join(tempDir, 'homes'), '1', 1);
    await generatePreviewWorkspaceFiles({
      courseDir: path.join(tempDir, 'course'),
      homeDir,
      params: {},
      qid: 'demo/workspace',
      trueAnswer: {},
    });

    const fileMode = (await fs.stat(path.join(homeDir, 'nested', 'file.txt'))).mode & 0o777;
    const dirMode = (await fs.stat(path.join(homeDir, 'nested'))).mode & 0o777;
    assert.equal(fileMode & 0o666, 0o666);
    assert.equal(dirMode & 0o777, 0o777);
  });

  it('reports file generation errors without failing', async () => {
    const questionDir = await makeQuestionDir('demo/workspace');
    await fs.mkdir(questionDir, { recursive: true });

    const homeDir = makePreviewWorkspaceHomeDir(path.join(tempDir, 'homes'), '1', 1);
    const { fileGenerationErrors } = await generatePreviewWorkspaceFiles({
      courseDir: path.join(tempDir, 'course'),
      homeDir,
      params: { _workspace_files: [{ contents: 'orphan' }] },
      qid: 'demo/workspace',
      trueAnswer: {},
    });

    assert.lengthOf(fileGenerationErrors, 1);
    assert.equal(fileGenerationErrors[0].file, 'Dynamic file 0');
    assert.match(fileGenerationErrors[0].msg, /does not include a name/);
  });
});

describe('collectPreviewWorkspaceGradedFiles', () => {
  it('collects matching files as base64 entries', async () => {
    const homeDir = path.join(tempDir, 'home');
    await fs.mkdir(path.join(homeDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(homeDir, 'starter.py'), 'answer = 42');
    await fs.writeFile(path.join(homeDir, 'src', 'main.c'), 'int main() {}');
    await fs.writeFile(path.join(homeDir, 'ignored.txt'), 'not graded');

    const result = await collectPreviewWorkspaceGradedFiles({
      gradedFiles: ['starter.py', 'src/*.c'],
      homeDir,
      limits: LIMITS,
    });

    assert.isTrue(result.ok);
    assert.deepEqual(result.files.map((file) => file.name).sort(), ['src/main.c', 'starter.py']);
    const starter = result.files.find((file) => file.name === 'starter.py');
    assert.equal(Buffer.from(starter!.contents, 'base64').toString(), 'answer = 42');
  });

  it('returns an empty list when the home directory does not exist yet', async () => {
    const result = await collectPreviewWorkspaceGradedFiles({
      gradedFiles: ['starter.py'],
      homeDir: path.join(tempDir, 'missing'),
      limits: LIMITS,
    });

    assert.deepEqual(result, { files: [], ok: true });
  });

  it('returns an empty list when the question has no graded files', async () => {
    const result = await collectPreviewWorkspaceGradedFiles({
      gradedFiles: [],
      homeDir: path.join(tempDir, 'missing'),
      limits: LIMITS,
    });

    assert.deepEqual(result, { files: [], ok: true });
  });

  it('turns limit violations into a submission format error', async () => {
    const homeDir = path.join(tempDir, 'home');
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(path.join(homeDir, 'a.txt'), 'a');
    await fs.writeFile(path.join(homeDir, 'b.txt'), 'b');

    const result = await collectPreviewWorkspaceGradedFiles({
      gradedFiles: ['*.txt'],
      homeDir,
      limits: { maxFiles: 1, maxSize: LIMITS.maxSize },
    });

    assert.isFalse(result.ok);
    assert.match(result.formatError, /Cannot submit more than 1 files/);
  });
});
