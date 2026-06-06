import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assert, describe, it } from 'vitest';

import {
  type QuestionPreviewDocumentRenderer,
  createQuestionPreviewDocumentRenderer,
} from './document.js';
import { LocalPreviewGeneratedFiles } from './generated-files.js';
import { type QuestionPreviewQid, parseQuestionPreviewQid } from './qid.js';
import { createQuestionPreviewRuntime } from './render.js';

async function makeTempCourse() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-document-'));
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
) {
  const localPreviewGeneratedFiles = new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' });
  const runtime = await createQuestionPreviewRuntime({
    courseDir,
    localPreviewGeneratedFiles,
    urlPrefix: '/preview',
  });
  const renderer = createQuestionPreviewDocumentRenderer({
    courseDir,
    localPreviewGeneratedFiles,
    urlPrefix: '/preview',
  });

  try {
    return await callback(renderer);
  } finally {
    await runtime.close();
  }
}

describe('question preview document', () => {
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
        assert.match(result.documentHtml, /document\.urlPrefix = '\/preview'/);
        assert.match(result.documentHtml, /\/assets\//);
        assert.match(result.documentHtml, /<body>/);
        assert.match(result.documentHtml, /class="question-container"/);
        assert.match(result.documentHtml, /class="question-form"/);
        assert.match(result.documentHtml, /class="[^"]*question-body[^"]*"/);
        assert.match(result.documentHtml, /data-grading-method="Internal"/);
        assert.match(result.documentHtml, /data-variant-id="1"/);
        assert.match(result.documentHtml, /data-variant-token="[^"]+"/);
        assert.match(result.documentHtml, /Rendered preview/);
        assert.notMatch(result.documentHtml, /question-block/);
        assert.notMatch(result.documentHtml, /card-header/);
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
    const renderer = createQuestionPreviewDocumentRenderer({
      courseDir: '/tmp/pl-preview-render-test-course',
      localPreviewGeneratedFiles: new LocalPreviewGeneratedFiles({ urlPrefix: '/preview' }),
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
});
