import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import { assert, describe, it } from 'vitest';

import { serveQuestionPreview } from './preview-render.js';

async function makeTempCourse() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-render-serve-'));
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

async function writeQuestion(courseDir: string, qid: string, title: string, uuid: string) {
  await writeQuestionInfo(courseDir, qid, {
    title,
    topic: 'Testing',
    type: 'v3',
    uuid,
  });
  await writeQuestionFile(courseDir, qid, 'question.html', `<p>${title}</p>`);
}

class CollectingWritable extends Writable {
  chunks: Buffer[] = [];
  private waiters: Array<{ count: number; resolve: () => void }> = [];

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.from(chunk));
    this.flushWaiters();
    callback();
  }

  lines() {
    return Buffer.concat(this.chunks)
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  waitForLines(count: number) {
    if (this.lines().length >= count) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.waiters.push({ count, resolve });
    });
  }

  private flushWaiters() {
    const lineCount = this.lines().length;
    const pending: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (lineCount >= waiter.count) {
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    this.waiters = pending;
  }
}

describe('preview-render serve mode', () => {
  it('emits ready and sequential typed responses for multiple qids', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(
      courseDir,
      'warm/first',
      'Warm first',
      '11111111-1111-4111-8111-111111111117',
    );
    await writeQuestion(
      courseDir,
      'warm/second',
      'Warm second',
      '11111111-1111-4111-8111-111111111118',
    );

    const input = Readable.from([
      `${JSON.stringify({ id: { opaque: 'first' }, qid: 'warm/first', variantSeed: '1' })}\n`,
      `${JSON.stringify({ id: ['second', 2], qid: 'warm/second', variantSeed: '2' })}\n`,
    ]);
    const output = new CollectingWritable();

    await serveQuestionPreview({
      defaults: {
        qid: 'warm/first',
        variantSeed: '1',
      },
      input,
      output,
      runtimeOptions: {
        courseDir,
        prewarmWorkers: true,
        urlPrefix: '/warm-preview',
        workersExecutionMode: 'native',
      },
    });

    const lines = output.lines();

    assert.deepEqual(lines[0], { ok: true, type: 'ready' });
    assert.equal(lines[1].type, 'response');
    assert.equal(lines[1].ok, true);
    assert.deepEqual(lines[1].id, { opaque: 'first' });
    assert.equal(Array.isArray(lines[1].diagnostics), true);
    assert.match(lines[1].payload.bodyHtml, /Warm first/);
    assert.equal('result' in lines[1], false);

    assert.equal(lines[2].type, 'response');
    assert.equal(lines[2].ok, true);
    assert.deepEqual(lines[2].id, ['second', 2]);
    assert.match(lines[2].payload.bodyHtml, /Warm second/);
    assert.equal(lines.length, 3);
  });

  it('renders current question files after mutations between warm requests', async () => {
    const courseDir = await makeTempCourse();
    const qid = 'warm/mutable';
    const info = {
      title: 'Warm mutable',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111123',
    };
    await writeQuestionInfo(courseDir, qid, info);
    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<p>Question HTML marker: first</p><p>Server marker: {{params.marker}}</p>',
    );
    await writeQuestionFile(
      courseDir,
      qid,
      'server.py',
      'def generate(data):\n    data["params"]["marker"] = "server-first"\n',
    );

    const input = new PassThrough();
    const output = new CollectingWritable();
    const serving = serveQuestionPreview({
      defaults: {
        qid,
        variantSeed: '1',
      },
      input,
      output,
      runtimeOptions: {
        courseDir,
        prewarmWorkers: true,
        urlPrefix: '/warm-preview',
        workersExecutionMode: 'native',
      },
    });

    await output.waitForLines(1);

    input.write(`${JSON.stringify({ id: 'initial', qid, variantSeed: '1' })}\n`);
    await output.waitForLines(2);
    let lines = output.lines();
    assert.deepEqual(lines[0], { ok: true, type: 'ready' });
    assert.equal(lines[1].type, 'response');
    assert.equal(lines[1].ok, true);
    assert.match(lines[1].payload.bodyHtml, /Question HTML marker: first/);
    assert.match(lines[1].payload.bodyHtml, /Server marker: server-first/);

    await writeQuestionFile(
      courseDir,
      qid,
      'question.html',
      '<p>Question HTML marker: second</p><p>Server marker: {{params.marker}}</p>',
    );
    input.write(`${JSON.stringify({ id: 'question-html-updated', qid, variantSeed: '1' })}\n`);
    await output.waitForLines(3);
    lines = output.lines();
    assert.equal(lines[2].type, 'response');
    assert.equal(lines[2].ok, true);
    assert.match(lines[2].payload.bodyHtml, /Question HTML marker: second/);
    assert.notMatch(lines[2].payload.bodyHtml, /Question HTML marker: first/);
    assert.match(lines[2].payload.bodyHtml, /Server marker: server-first/);

    await writeQuestionInfo(courseDir, qid, {
      ...info,
      type: 'MultipleChoice',
    });
    input.write(`${JSON.stringify({ id: 'metadata-updated', qid, variantSeed: '1' })}\n`);
    await output.waitForLines(4);
    lines = output.lines();
    assert.equal(lines[3].type, 'response');
    assert.equal(lines[3].ok, false);
    assert.match(lines[3].diagnostics[0].message, /Unsupported preview question type/);

    await writeQuestionInfo(courseDir, qid, info);
    await writeQuestionFile(
      courseDir,
      qid,
      'server.py',
      'def generate(data):\n    data["params"]["marker"] = "server-second"\n',
    );
    input.write(`${JSON.stringify({ id: 'server-py-updated', qid, variantSeed: '1' })}\n`);
    await output.waitForLines(5);
    lines = output.lines();
    assert.equal(lines[4].type, 'response');
    assert.equal(lines[4].ok, true);
    assert.match(lines[4].payload.bodyHtml, /Question HTML marker: second/);
    assert.match(lines[4].payload.bodyHtml, /Server marker: server-second/);
    assert.notMatch(lines[4].payload.bodyHtml, /Server marker: server-first/);

    input.end();
    await serving;
  });

  it('rejects startup-scoped fields in warm render requests', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(
      courseDir,
      'warm/reject',
      'Warm reject',
      '11111111-1111-4111-8111-111111111119',
    );

    const input = Readable.from([
      `${JSON.stringify({
        courseDir: '/tmp/other-course',
        id: { reject: true },
        qid: 'warm/reject',
        urlPrefix: '/other-preview',
      })}\n`,
    ]);
    const output = new CollectingWritable();

    await serveQuestionPreview({
      defaults: {
        qid: 'warm/reject',
        variantSeed: '1',
      },
      input,
      output,
      runtimeOptions: {
        courseDir,
        prewarmWorkers: true,
        urlPrefix: '/warm-preview',
        workersExecutionMode: 'native',
      },
    });

    const lines = output.lines();

    assert.deepEqual(lines[0], { ok: true, type: 'ready' });
    assert.equal(lines[1].type, 'response');
    assert.equal(lines[1].ok, false);
    assert.deepEqual(lines[1].id, { reject: true });
    assert.match(lines[1].diagnostics[0].message, /cannot override startup-scoped/);
    assert.equal('error' in lines[1], false);
    assert.equal('result' in lines[1], false);
    assert.equal(lines.length, 2);
  });

  it('rejects non-render fields in warm render requests', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(
      courseDir,
      'warm/render-only',
      'Warm render only',
      '11111111-1111-4111-8111-111111111122',
    );

    const input = Readable.from([
      `${JSON.stringify({
        grade: true,
        id: 'not-render-only',
        port: 3000,
        qid: 'warm/render-only',
        submission: { answer: 'x' },
      })}\n`,
    ]);
    const output = new CollectingWritable();

    await serveQuestionPreview({
      defaults: {
        qid: 'warm/render-only',
        variantSeed: '1',
      },
      input,
      output,
      runtimeOptions: {
        courseDir,
        prewarmWorkers: true,
        urlPrefix: '/warm-preview',
        workersExecutionMode: 'native',
      },
    });

    const lines = output.lines();

    assert.deepEqual(lines[0], { ok: true, type: 'ready' });
    assert.equal(lines[1].type, 'response');
    assert.equal(lines[1].ok, false);
    assert.equal(lines[1].id, 'not-render-only');
    assert.match(lines[1].diagnostics[0].message, /render-only/);
    assert.equal('payload' in lines[1], false);
    assert.equal(lines.length, 2);
  });

  it('keeps serving after malformed JSON and expected preview failures', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(
      courseDir,
      'warm/recovery',
      'Warm recovery',
      '11111111-1111-4111-8111-111111111120',
    );

    const input = Readable.from([
      '{"id":"malformed",\n',
      `${JSON.stringify({ id: 'expected-failure', qid: '../bad', variantSeed: '1' })}\n`,
      `${JSON.stringify({ id: 'valid-after-failure', qid: 'warm/recovery', variantSeed: '1' })}\n`,
    ]);
    const output = new CollectingWritable();

    await serveQuestionPreview({
      defaults: {
        qid: 'warm/recovery',
        variantSeed: '1',
      },
      input,
      output,
      runtimeOptions: {
        courseDir,
        prewarmWorkers: true,
        urlPrefix: '/warm-preview',
        workersExecutionMode: 'native',
      },
    });

    const lines = output.lines();

    assert.deepEqual(lines[0], { ok: true, type: 'ready' });
    assert.equal(lines[1].type, 'response');
    assert.equal(lines[1].ok, false);
    assert.match(lines[1].diagnostics[0].message, /Invalid JSON request line/);
    assert.equal('error' in lines[1], false);

    assert.equal(lines[2].type, 'response');
    assert.equal(lines[2].ok, false);
    assert.equal(lines[2].id, 'expected-failure');
    assert.match(lines[2].diagnostics[0].message, /Invalid question id/);

    assert.equal(lines[3].type, 'response');
    assert.equal(lines[3].ok, true);
    assert.equal(lines[3].id, 'valid-after-failure');
    assert.match(lines[3].payload.bodyHtml, /Warm recovery/);
    assert.equal(lines.length, 4);
  });

  it('shuts down cleanly when stdin closes without requests', async () => {
    const courseDir = await makeTempCourse();
    await writeQuestion(
      courseDir,
      'warm/close',
      'Warm close',
      '11111111-1111-4111-8111-111111111121',
    );

    const output = new CollectingWritable();

    await serveQuestionPreview({
      defaults: {
        qid: 'warm/close',
        variantSeed: '1',
      },
      input: Readable.from([]),
      output,
      runtimeOptions: {
        courseDir,
        prewarmWorkers: true,
        urlPrefix: '/warm-preview',
        workersExecutionMode: 'native',
      },
    });

    assert.deepEqual(output.lines(), [{ ok: true, type: 'ready' }]);
  });
});
