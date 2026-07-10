import nodeAssert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import { type LocalPreviewCourseSource, createLocalPreviewCourseSource } from './course-source.js';
import {
  type QuestionPreviewDocumentRenderer,
  type QuestionPreviewRenderMode,
  createQuestionPreviewDocumentRenderer,
} from './document.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { type QuestionPreviewQid, parseQuestionPreviewQid } from './qid.js';
import { createQuestionPreviewRuntime } from './render.js';
import { LocalPreviewSubmissionFiles } from './submission-files.js';
import type { PreviewWorkspaceGradedFilesResult } from './workspace-files.js';
import type { PreviewWorkspaceAllocator } from './workspace-launcher.js';
import { LocalPreviewWorkspaces, type PreviewWorkspaceSpec } from './workspace-registry.js';

async function makeTempCourse() {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-document-'));
  await fs.writeFile(
    path.join(courseDir, 'infoCourse.json'),
    JSON.stringify({
      name: 'TST 101',
      title: 'Question preview tests',
      topics: [{ color: 'blue1', name: 'Testing' }],
    }),
  );
  await fs.mkdir(path.join(courseDir, 'questions'));
  return courseDir;
}

async function writeQuestionFile(
  courseDir: string,
  qid: string,
  filename: string,
  contents: string,
) {
  const questionDir = path.join(courseDir, 'questions', qid);
  await fs.mkdir(questionDir, { recursive: true });
  await fs.writeFile(path.join(questionDir, filename), contents);
}

async function writeQuestionInfo(courseDir: string, qid: string, info: Record<string, unknown>) {
  await writeQuestionFile(courseDir, qid, 'info.json', JSON.stringify(info));
}

async function writeGradableQuestion(
  courseDir: string,
  qid: string,
  uuid: string,
  { info = {}, serverPy }: { info?: Record<string, unknown>; serverPy?: string } = {},
) {
  await writeQuestionInfo(courseDir, qid, {
    title: 'Gradable question',
    topic: 'Testing',
    type: 'v3',
    uuid,
    ...info,
  });
  await writeQuestionFile(
    courseDir,
    qid,
    'question.html',
    '<pl-question-panel><p>1 + 1 = ?</p></pl-question-panel><pl-number-input answers-name="ans"></pl-number-input>',
  );
  await writeQuestionFile(
    courseDir,
    qid,
    'server.py',
    serverPy ?? 'def generate(data):\n    data["correct_answers"]["ans"] = 2\n',
  );
}

function parsePreviewQid(qid: string): QuestionPreviewQid {
  const result = parseQuestionPreviewQid(qid);
  if (!result.ok) throw new Error(result.error.message);
  return result.qid;
}

function assertGenericFailureDocument(documentHtml: string) {
  assert.match(documentHtml, /^<!doctype html>/i);
  assert.match(documentHtml, /Question preview failed/);
  assert.match(documentHtml, /preview server console/);
}

async function withInitializedDocumentRenderer<T>(
  courseDir: string,
  callback: (renderer: QuestionPreviewDocumentRenderer) => Promise<T>,
  {
    localPreviewWorkspaces = null,
    renderMode,
  }: {
    localPreviewWorkspaces?: PreviewWorkspaceAllocator | null;
    renderMode?: QuestionPreviewRenderMode;
  } = {},
) {
  const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
  const courseSource = await createLocalPreviewCourseSource(courseDir);
  const runtime = await createQuestionPreviewRuntime({
    courseDir,
    localPreviewGeneratedFiles,
    urlPrefix: '/preview',
    workersExecutionMode: 'native',
  });
  const renderer = createQuestionPreviewDocumentRenderer({
    courseSource,
    localPreviewGeneratedFiles,
    localPreviewSubmissionFiles: new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' }),
    localPreviewWorkspaces,
    renderMode,
    urlPrefix: '/preview',
  });

  try {
    return await callback(renderer);
  } finally {
    await runtime.close();
  }
}

async function writeWorkspaceQuestion(courseDir: string, qid: string, uuid: string) {
  await writeQuestionInfo(courseDir, qid, {
    title: 'Workspace question',
    topic: 'Testing',
    type: 'v3',
    uuid,
    workspaceOptions: {
      gradedFiles: ['starter.py'],
      home: '/home/user',
      image: 'workspace-image',
      port: 8080,
    },
  });
  await writeQuestionFile(
    courseDir,
    qid,
    'question.html',
    '<pl-workspace></pl-workspace><pl-number-input answers-name="ans"></pl-number-input>',
  );
  await writeQuestionFile(
    courseDir,
    qid,
    'server.py',
    'def generate(data):\n    data["correct_answers"]["ans"] = 2\n',
  );
}

interface FakeWorkspaceAllocator extends PreviewWorkspaceAllocator {
  collectCalls: { qid: string; variantSeed: string }[];
  ensureCalls: PreviewWorkspaceSpec[];
}

function makeFakeWorkspaceAllocator(
  gradedFilesResult: PreviewWorkspaceGradedFilesResult = { files: [], ok: true },
): FakeWorkspaceAllocator {
  const workspaces = new LocalPreviewWorkspaces();
  const collectCalls: { qid: string; variantSeed: string }[] = [];
  const ensureCalls: PreviewWorkspaceSpec[] = [];

  return {
    collectCalls,
    async collectGradedFiles(input) {
      collectCalls.push(input);
      return gradedFilesResult;
    },
    ensureCalls,
    ensureWorkspace(spec) {
      ensureCalls.push(spec);
      return workspaces.ensureWorkspace(spec);
    },
  };
}

describe('question preview document', () => {
  it('propagates unexpected engine failures to the engine lifecycle', async () => {
    const courseSource: LocalPreviewCourseSource = {
      courseDir: '/course',
      courseMetadata: {
        name: 'TST 101',
        options: {},
        timezone: 'UTC',
        title: 'Question preview tests',
      },
      readQuestionInfo: async () => {
        throw new Error('worker-pool generation failed');
      },
      readTemplateInfo: async () => {
        throw new Error('not used');
      },
      resolveFile: async () => null,
    };
    const renderer = createQuestionPreviewDocumentRenderer({
      courseSource,
      localPreviewGeneratedFiles: new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' }),
      localPreviewSubmissionFiles: new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' }),
      urlPrefix: '/preview',
    });

    await nodeAssert.rejects(
      renderer.render({ qid: parsePreviewQid('demo/question') }),
      /worker-pool generation failed/,
    );
  });

  it('renders a complete Question preview document through the document seam', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'demo/preview', {
      title: 'Preview test',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111111',
    });
    await writeQuestionFile(
      courseDir,
      'demo/preview',
      'question.html',
      '<p>Rendered preview</p><pl-number-input answers-name="x"></pl-number-input>',
    );

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('demo/preview'),
          variantSeed: '123',
        });

        assert.equal(result.ok, true);
        assert.deepEqual(Object.keys(result).sort(), ['diagnostics', 'documentHtml', 'ok']);
        assert.deepEqual(result.diagnostics, []);
        assert.match(result.documentHtml, /^<!doctype html>/i);
        assert.match(result.documentHtml, /<head>/);
        assert.match(result.documentHtml, /<title>\s*Preview test/);
        assert.match(result.documentHtml, /document\.urlPrefix = '\/preview'/);
        assert.match(result.documentHtml, /\/assets\//);
        assert.match(result.documentHtml, /<body>/);
        assert.match(result.documentHtml, /class="question-container mb-4"/);
        assert.match(result.documentHtml, /class="question-form"/);
        assert.match(result.documentHtml, /class="card mb-3 question-block"/);
        assert.match(result.documentHtml, /card-header bg-primary text-white/);
        assert.match(result.documentHtml, /<h1>\s*Preview test\s*<\/h1>/);
        assert.match(result.documentHtml, /class="[^"]*question-body[^"]*"/);
        assert.match(result.documentHtml, /data-grading-method="Internal"/);
        assert.match(result.documentHtml, /data-variant-id="1"/);
        assert.match(result.documentHtml, /data-variant-token="[^"]+"/);
        assert.match(result.documentHtml, /Rendered preview/);
        assert.match(result.documentHtml, /name="__action"/);
        assert.match(result.documentHtml, /value="grade"/);
        assert.match(result.documentHtml, /disable-on-submit/);
        assert.match(result.documentHtml, /Save &amp; Grade/);
        assert.match(result.documentHtml, /class="card mb-3 grading-block d-none"/);
        assert.notMatch(result.documentHtml, /Check answer/);
        assert.notMatch(result.documentHtml, /Save only/);
        assert.notMatch(result.documentHtml, /New variant/);
        assert.notMatch(result.documentHtml, /submission-block/);
        assert.equal('payload' in result, false);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics only for fatal PrairieLearn prepare issues', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'broken/render', {
      title: 'Broken render',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111112',
    });

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('broken/render'),
          variantSeed: '1',
        });

        assert.equal(result.ok, false);
        assert.equal('payload' in result, false);
        assertGenericFailureDocument(result.documentHtml);
        assert.notMatch(result.documentHtml, /question\.html/);
        assert.equal(result.diagnostics.length, 1);
        assert.equal(result.diagnostics[0].name, 'CourseIssueError');
        assert.equal(result.diagnostics[0].fatal, true);
        assert.equal(result.diagnostics[0].phase, 'prepare');
        assert.match(result.diagnostics[0].message, /question\.html/);
        assert.equal('stack' in result.diagnostics[0], false);
        assert.equal(JSON.stringify(result.diagnostics[0]).includes(courseDir), false);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics for unsupported non-Freeform question types', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'legacy/multiple-choice', {
      title: 'Legacy question',
      topic: 'Testing',
      type: 'MultipleChoice',
      uuid: '11111111-1111-4111-8111-111111111113',
    });

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('legacy/multiple-choice'),
          variantSeed: '1',
        });

        assert.equal(result.ok, false);
        assert.equal('payload' in result, false);
        assertGenericFailureDocument(result.documentHtml);
        assert.notMatch(result.documentHtml, /Unsupported preview question type/);
        assert.equal(result.diagnostics[0].fatal, true);
        assert.equal(result.diagnostics[0].phase, 'metadata');
        assert.match(
          result.diagnostics[0].message,
          /Unsupported preview question type: MultipleChoice/,
        );
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics for missing question metadata', async () => {
    const courseDir = await makeTempCourse();

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('missing/question'),
          variantSeed: '1',
        });

        assert.equal(result.ok, false);
        assert.equal('payload' in result, false);
        assertGenericFailureDocument(result.documentHtml);
        assert.notMatch(result.documentHtml, /missing info\.json/);
        assert.equal(result.diagnostics[0].fatal, true);
        assert.equal(result.diagnostics[0].phase, 'metadata');
        assert.match(result.diagnostics[0].message, /missing info\.json/);
        assert.equal(JSON.stringify(result.diagnostics[0]).includes(courseDir), false);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics for invalid question metadata', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'invalid/metadata', {
      title: 'Invalid metadata',
      topic: 'Testing',
      type: 'v3',
    });

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('invalid/metadata'),
          variantSeed: '1',
        });

        assert.equal(result.ok, false);
        assert.equal('payload' in result, false);
        assertGenericFailureDocument(result.documentHtml);
        assert.equal(result.diagnostics[0].fatal, true);
        assert.equal(result.diagnostics[0].phase, 'metadata');
        assert.match(result.diagnostics[0].message, /invalid info\.json metadata/);
        assert.equal('stack' in result.diagnostics[0], false);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics for invalid variant seeds', async () => {
    const courseSource: LocalPreviewCourseSource = {
      courseDir: '/tmp/pl-preview-render-test-course',
      courseMetadata: {
        name: 'TST 101',
        options: {},
        timezone: 'UTC',
        title: 'Question preview tests',
      },
      readQuestionInfo: async () => {
        throw new Error('question lookup should not occur for an invalid seed');
      },
      readTemplateInfo: async () => {
        throw new Error('template lookup should not occur for an invalid seed');
      },
      resolveFile: async () => null,
    };
    const renderer = createQuestionPreviewDocumentRenderer({
      courseSource,
      localPreviewGeneratedFiles: new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' }),
      localPreviewSubmissionFiles: new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' }),
      urlPrefix: '/preview',
    });

    const result = await renderer.render({
      qid: parsePreviewQid('valid/qid'),
      variantSeed: '!',
    });

    assert.equal(result.ok, false);
    assert.equal('payload' in result, false);
    assertGenericFailureDocument(result.documentHtml);
    assert.equal(result.diagnostics[0].fatal, true);
    assert.equal(result.diagnostics[0].phase, 'input');
    assert.match(result.diagnostics[0].message, /Invalid variant seed/);
  });

  it('returns diagnostics only for fatal PrairieLearn generate issues', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'broken/generate', {
      title: 'Broken generate',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111114',
    });
    await writeQuestionFile(
      courseDir,
      'broken/generate',
      'question.html',
      '<p>Broken generate</p>',
    );
    await writeQuestionFile(
      courseDir,
      'broken/generate',
      'server.py',
      'def generate(data):\n    raise Exception("preview generate failed")\n',
    );

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('broken/generate'),
          variantSeed: '1',
        });

        assert.equal(result.ok, false);
        assert.equal('payload' in result, false);
        assertGenericFailureDocument(result.documentHtml);
        assert.notMatch(result.documentHtml, /server\.py/);
        assert.equal(result.diagnostics[0].name, 'CourseIssueError');
        assert.equal(result.diagnostics[0].fatal, true);
        assert.equal(result.diagnostics[0].phase, 'generate');
        assert.match(result.diagnostics[0].message, /server\.py/);
        assert.equal(JSON.stringify(result.diagnostics[0]).includes(courseDir), false);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns successful documents with diagnostics for nonfatal PrairieLearn issues', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'warning/generate', {
      title: 'Warning generate',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111115',
    });
    await writeQuestionFile(
      courseDir,
      'warning/generate',
      'question.html',
      '<p>Warning generate</p>',
    );
    await writeQuestionFile(
      courseDir,
      'warning/generate',
      'server.py',
      'def generate(data):\n    print("preview warning")\n',
    );

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('warning/generate'),
          variantSeed: '1',
        });

        assert.equal(result.ok, true);
        assert.match(result.documentHtml, /^<!doctype html>/i);
        assert.match(result.documentHtml, /Warning generate/);
        assert.equal('payload' in result, false);
        assert.equal(result.diagnostics.length, 1);
        assert.equal(result.diagnostics[0].name, 'CourseIssueError');
        assert.equal(result.diagnostics[0].fatal, false);
        assert.equal(result.diagnostics[0].phase, 'generate');
        assert.match(result.diagnostics[0].message, /output logged on console/);
        assert.equal('stack' in result.diagnostics[0], false);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('grades submissions through the document seam', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(courseDir, 'demo/gradable', '11111111-1111-4111-8111-111111111116');

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const qid = parsePreviewQid('demo/gradable');

        const correct = await renderer.render({
          qid,
          variantSeed: '1',
          submission: { rawSubmittedAnswer: { ans: '2' } },
        });
        assert.equal(correct.ok, true);
        assert.deepEqual(correct.diagnostics, []);
        assert.match(correct.documentHtml, /data-testid="submission-block"/);
        assert.match(correct.documentHtml, /data-testid="submission-with-feedback"/);
        assert.match(correct.documentHtml, /Submitted answer/);
        assert.match(correct.documentHtml, /text-bg-success/);
        assert.match(correct.documentHtml, /100%/);
        assert.match(correct.documentHtml, /Save &amp; Grade/);
        assert.match(correct.documentHtml, /class="card mb-3 grading-block"/);
        assert.match(correct.documentHtml, /Correct answer/);

        const wrong = await renderer.render({
          qid,
          variantSeed: '1',
          submission: { rawSubmittedAnswer: { ans: '3' } },
        });
        assert.equal(wrong.ok, true);
        assert.match(wrong.documentHtml, /data-testid="submission-block"/);
        assert.match(wrong.documentHtml, /text-bg-danger/);
        assert.match(wrong.documentHtml, /0%/);

        const invalid = await renderer.render({
          qid,
          variantSeed: '1',
          submission: { rawSubmittedAnswer: { ans: 'banana' } },
        });
        assert.equal(invalid.ok, true);
        assert.match(invalid.documentHtml, /data-testid="submission-block"/);
        assert.match(invalid.documentHtml, /invalid, not gradable/);
        assert.notMatch(invalid.documentHtml, /text-bg-success/);

        const refreshed = await renderer.render({ qid, variantSeed: '1' });
        assert.equal(refreshed.ok, true);
        assert.notMatch(refreshed.documentHtml, /submission-block/);
        assert.match(refreshed.documentHtml, /class="card mb-3 grading-block d-none"/);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('allocates a workspace and injects its URL for workspace questions', async () => {
    const courseDir = await makeTempCourse();
    await writeWorkspaceQuestion(
      courseDir,
      'demo/workspace',
      '11111111-1111-4111-8111-111111111121',
    );
    const localPreviewWorkspaces = makeFakeWorkspaceAllocator();

    try {
      await withInitializedDocumentRenderer(
        courseDir,
        async (renderer) => {
          const result = await renderer.render({
            qid: parsePreviewQid('demo/workspace'),
            variantSeed: '7',
          });

          assert.equal(result.ok, true);
          assert.deepEqual(result.diagnostics, []);
          assert.match(result.documentHtml, /href="\/workspace\/1"/);
          assert.match(result.documentHtml, /data-workspace-id="1"/);

          assert.lengthOf(localPreviewWorkspaces.ensureCalls, 1);
          const spec = localPreviewWorkspaces.ensureCalls[0];
          assert.equal(spec.qid, 'demo/workspace');
          assert.equal(spec.variantSeed, '7');
          assert.deepEqual(spec.settings, {
            args: null,
            enableNetworking: false,
            environment: {},
            gradedFiles: ['starter.py'],
            home: '/home/user',
            image: 'workspace-image',
            port: 8080,
            rewriteUrl: true,
          });
          assert.deepEqual(spec.params._workspace_required_file_names, ['starter.py']);
          assert.deepEqual(spec.params._required_file_names, ['starter.py']);
        },
        { localPreviewWorkspaces },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('renders a placeholder workspace link when workspaces are unavailable', async () => {
    const courseDir = await makeTempCourse();
    await writeWorkspaceQuestion(
      courseDir,
      'demo/workspace',
      '11111111-1111-4111-8111-111111111122',
    );

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('demo/workspace'),
          variantSeed: '1',
        });

        assert.equal(result.ok, true);
        assert.deepEqual(result.diagnostics, []);
        assert.match(result.documentHtml, /href="#"/);
        assert.match(result.documentHtml, /data-workspace-id=""/);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('injects workspace graded files into graded submissions', async () => {
    const courseDir = await makeTempCourse();
    await writeWorkspaceQuestion(
      courseDir,
      'demo/workspace',
      '11111111-1111-4111-8111-111111111123',
    );
    const localPreviewWorkspaces = makeFakeWorkspaceAllocator({
      files: [{ contents: Buffer.from('answer = 2').toString('base64'), name: 'starter.py' }],
      ok: true,
    });

    try {
      await withInitializedDocumentRenderer(
        courseDir,
        async (renderer) => {
          const result = await renderer.render({
            qid: parsePreviewQid('demo/workspace'),
            variantSeed: '1',
            submission: { rawSubmittedAnswer: { ans: '2' } },
          });

          assert.equal(result.ok, true);
          assert.deepEqual(result.diagnostics, []);
          assert.match(result.documentHtml, /data-testid="submission-block"/);
          assert.match(result.documentHtml, /text-bg-success/);
          assert.match(result.documentHtml, /100%/);
          assert.deepEqual(localPreviewWorkspaces.collectCalls, [
            { qid: 'demo/workspace', variantSeed: '1' },
          ]);
        },
        { localPreviewWorkspaces },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('marks submissions not gradable when workspace graded files are missing', async () => {
    const courseDir = await makeTempCourse();
    await writeWorkspaceQuestion(
      courseDir,
      'demo/workspace',
      '11111111-1111-4111-8111-111111111124',
    );
    const localPreviewWorkspaces = makeFakeWorkspaceAllocator({ files: [], ok: true });

    try {
      await withInitializedDocumentRenderer(
        courseDir,
        async (renderer) => {
          const result = await renderer.render({
            qid: parsePreviewQid('demo/workspace'),
            variantSeed: '1',
            submission: { rawSubmittedAnswer: { ans: '2' } },
          });

          assert.equal(result.ok, true);
          assert.match(result.documentHtml, /invalid, not gradable/);
          assert.notMatch(result.documentHtml, /text-bg-success/);
        },
        { localPreviewWorkspaces },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('turns workspace graded-file failures into submission format errors', async () => {
    const courseDir = await makeTempCourse();
    await writeWorkspaceQuestion(
      courseDir,
      'demo/workspace',
      '11111111-1111-4111-8111-111111111125',
    );
    const localPreviewWorkspaces = makeFakeWorkspaceAllocator({
      formatError: 'Cannot submit more than 100 files from the workspace.',
      ok: false,
    });

    try {
      await withInitializedDocumentRenderer(
        courseDir,
        async (renderer) => {
          const result = await renderer.render({
            qid: parsePreviewQid('demo/workspace'),
            variantSeed: '1',
            submission: { rawSubmittedAnswer: { ans: '2' } },
          });

          assert.equal(result.ok, true);
          assert.match(result.documentHtml, /invalid, not gradable/);
        },
        { localPreviewWorkspaces },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics only for fatal PrairieLearn parse issues', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(courseDir, 'broken/parse', '11111111-1111-4111-8111-111111111117', {
      serverPy:
        'def generate(data):\n' +
        '    data["correct_answers"]["ans"] = 2\n' +
        'def parse(data):\n' +
        '    raise Exception("preview parse failed")\n',
    });

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('broken/parse'),
          variantSeed: '1',
          submission: { rawSubmittedAnswer: { ans: '2' } },
        });

        assert.equal(result.ok, false);
        assertGenericFailureDocument(result.documentHtml);
        assert.equal(result.diagnostics[0].name, 'CourseIssueError');
        assert.equal(result.diagnostics[0].fatal, true);
        assert.equal(result.diagnostics[0].phase, 'parse');
        assert.match(result.diagnostics[0].message, /server\.py/);
        assert.equal(JSON.stringify(result.diagnostics[0]).includes(courseDir), false);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('returns diagnostics only for fatal PrairieLearn grade issues', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(courseDir, 'broken/grade', '11111111-1111-4111-8111-111111111118', {
      serverPy:
        'def generate(data):\n' +
        '    data["correct_answers"]["ans"] = 2\n' +
        'def grade(data):\n' +
        '    raise Exception("preview grade failed")\n',
    });

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('broken/grade'),
          variantSeed: '1',
          submission: { rawSubmittedAnswer: { ans: '2' } },
        });

        assert.equal(result.ok, false);
        assertGenericFailureDocument(result.documentHtml);
        assert.equal(result.diagnostics[0].name, 'CourseIssueError');
        assert.equal(result.diagnostics[0].fatal, true);
        assert.equal(result.diagnostics[0].phase, 'grade');
        assert.match(result.diagnostics[0].message, /server\.py/);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('skips grading for questions without Internal grading', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(
      courseDir,
      'external/gradable',
      '11111111-1111-4111-8111-111111111119',
      { info: { gradingMethod: 'External' } },
    );

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const qid = parsePreviewQid('external/gradable');

        const rendered = await renderer.render({ qid, variantSeed: '1' });
        assert.equal(rendered.ok, true);
        assert.notMatch(rendered.documentHtml, /question-grade/);
        assert.match(rendered.documentHtml, /Save &amp; Grade is unavailable/);
        assert.match(rendered.documentHtml, /External\s+grading/);

        const submitted = await renderer.render({
          qid,
          variantSeed: '1',
          submission: { rawSubmittedAnswer: { ans: '2' } },
        });
        assert.equal(submitted.ok, true);
        assert.deepEqual(submitted.diagnostics, []);
        assert.match(submitted.documentHtml, /alert-secondary/);
        assert.match(submitted.documentHtml, /External grading, which is not supported/);
        assert.match(submitted.documentHtml, /Only internally graded questions/);
        assert.notMatch(submitted.documentHtml, /submission-block/);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('keeps the correct answer panel hidden when the question disables it', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(
      courseDir,
      'demo/no-correct-answer',
      '11111111-1111-4111-8111-111111111126',
      { info: { showCorrectAnswer: false } },
    );

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('demo/no-correct-answer'),
          variantSeed: '1',
          submission: { rawSubmittedAnswer: { ans: '2' } },
        });

        assert.equal(result.ok, true);
        assert.match(result.documentHtml, /data-testid="submission-block"/);
        assert.match(result.documentHtml, /100%/);
        assert.match(result.documentHtml, /class="card mb-3 grading-block d-none"/);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('falls back to the QID when the question has no title', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(
      courseDir,
      'demo/untitled',
      '11111111-1111-4111-8111-111111111127',
      {
        info: { title: ' ' },
      },
    );

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const result = await renderer.render({
          qid: parsePreviewQid('demo/untitled'),
          variantSeed: '1',
        });

        assert.equal(result.ok, true);
        assert.match(result.documentHtml, /<title>\s*demo\/untitled/);
        assert.match(
          result.documentHtml,
          /<h1>\s*<span class="font-monospace">demo\/untitled<\/span>\s*<\/h1>/,
        );
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('renders a bare question body in question-only render mode', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestionInfo(courseDir, 'demo/preview', {
      title: 'Preview test',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111128',
    });
    await writeQuestionFile(
      courseDir,
      'demo/preview',
      'question.html',
      '<p>Rendered preview</p><pl-number-input answers-name="x"></pl-number-input>',
    );

    try {
      await withInitializedDocumentRenderer(
        courseDir,
        async (renderer) => {
          const result = await renderer.render({
            qid: parsePreviewQid('demo/preview'),
            variantSeed: '123',
          });

          assert.equal(result.ok, true);
          assert.deepEqual(result.diagnostics, []);
          assert.match(result.documentHtml, /<title>\s*Preview test/);
          assert.match(result.documentHtml, /document\.urlPrefix = '\/preview'/);
          assert.match(result.documentHtml, /\/assets\//);
          assert.match(result.documentHtml, /class="question-container"/);
          assert.match(result.documentHtml, /class="question-body"/);
          assert.match(result.documentHtml, /data-variant-id="1"/);
          assert.match(result.documentHtml, /Rendered preview/);
          assert.notMatch(result.documentHtml, /question-form/);
          assert.notMatch(result.documentHtml, /question-block/);
          assert.notMatch(result.documentHtml, /grading-block/);
          assert.notMatch(result.documentHtml, /__action/);
          assert.notMatch(result.documentHtml, /data-grading-method/);
          assert.notMatch(result.documentHtml, /data-variant-token/);
          assert.notMatch(result.documentHtml, /<h1/);
        },
        { renderMode: 'question-only' },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('honors a per-render render mode override', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(courseDir, 'demo/override', '11111111-1111-4111-8111-111111111130');

    try {
      await withInitializedDocumentRenderer(courseDir, async (renderer) => {
        const qid = parsePreviewQid('demo/override');

        const overridden = await renderer.render({
          qid,
          variantSeed: '1',
          renderMode: 'question-only',
        });
        assert.equal(overridden.ok, true);
        assert.match(overridden.documentHtml, /class="question-body"/);
        assert.notMatch(overridden.documentHtml, /question-form/);
        assert.notMatch(overridden.documentHtml, /question-block/);

        const unchanged = await renderer.render({ qid, variantSeed: '1' });
        assert.equal(unchanged.ok, true);
        assert.match(unchanged.documentHtml, /question-form/);
        assert.match(unchanged.documentHtml, /Save &amp; Grade/);
      });
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });

  it('rejects submissions in question-only render mode', async () => {
    const courseDir = await makeTempCourse();
    await writeGradableQuestion(courseDir, 'demo/gradable', '11111111-1111-4111-8111-111111111129');

    try {
      await withInitializedDocumentRenderer(
        courseDir,
        async (renderer) => {
          const result = await renderer.render({
            qid: parsePreviewQid('demo/gradable'),
            variantSeed: '1',
            submission: { rawSubmittedAnswer: { ans: '2' } },
          });

          assert.equal(result.ok, false);
          assertGenericFailureDocument(result.documentHtml);
          assert.equal(result.diagnostics[0].fatal, true);
          assert.equal(result.diagnostics[0].phase, 'input');
          assert.match(
            result.diagnostics[0].message,
            /Submissions are not supported in question-only render mode/,
          );
        },
        { renderMode: 'question-only' },
      );
    } finally {
      await fs.rm(courseDir, { force: true, recursive: true });
    }
  });
});
