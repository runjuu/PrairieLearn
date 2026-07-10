import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, standaloneTest as test } from './fixtures.js';

const fixtureCourseDir = fileURLToPath(
  new URL('fixtures/standalone-preview-course', import.meta.url),
);
const previewEntrypoint = fileURLToPath(
  new URL('../../../dist/preview-server.js', import.meta.url),
);
const sourceQuestionTypeCases = [
  ['freeform/v3', 'Freeform browser contract'],
  ['legacy/calculation', 'Define the vector'],
  ['legacy/multiple-choice', 'What is two plus two?'],
  ['legacy/checkbox', 'Select the true statement.'],
  ['legacy/file', 'Upload the starter file.'],
  ['legacy/multiple-true-false', 'Classify each arithmetic statement.'],
] as const;

async function startCompiledPreviewServer(args: string[] = []) {
  const child = spawn(
    process.execPath,
    [
      previewEntrypoint,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--workers-execution-mode',
      'native',
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out starting compiled preview server.\n${stderr}`));
    }, 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const match = chunk.match(/listening on (?<origin>http:\/\/[^\s]+)/);
      if (match?.groups?.origin == null) return;
      clearTimeout(timeout);
      resolve(match.groups.origin);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Compiled preview server exited with code ${code}.\n${stderr}`));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return {
    close: async () => {
      if (child.exitCode != null) return;
      const exited = new Promise<void>((resolve, reject) => {
        child.once('exit', (code, signal) => {
          if (code === 0 || signal === 'SIGTERM') {
            resolve();
          } else {
            reject(new Error(`Compiled preview server exited with code ${code}.\n${stderr}`));
          }
        });
      });
      child.kill('SIGTERM');
      await exited;
    },
    origin,
  };
}

test('creates a runtime Local Preview Session and hydrates every Source Question Type', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer();

  try {
    const health = await request.get(`${server.origin}/health`);
    expect(health.status()).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const created = await request.post(`${server.origin}/preview-sessions`, {
      data: { courseDir: fixtureCourseDir },
    });
    expect(created.status()).toBe(201);
    const session = (await created.json()) as {
      courseDir: string;
      previewSessionId: string;
    };

    for (const [qid, visibleText] of sourceQuestionTypeCases) {
      await page.goto(
        `${server.origin}/preview-sessions/${session.previewSessionId}/questions/${qid}?variant=1`,
      );
      await expect(page.getByText(visibleText)).toBeVisible();
    }
  } finally {
    await server.close();
  }
});

test('refreshes a startup Local Preview Session and grades both native submission contracts', async ({
  page,
  request,
}) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-standalone-preview-browser-'));
  const courseDir = path.join(tempRoot, 'course');
  await fs.cp(fixtureCourseDir, courseDir, { recursive: true });
  const server = await startCompiledPreviewServer([
    '--course-dir',
    courseDir,
    '--render-mode',
    'full',
  ]);

  try {
    const listed = await request.get(`${server.origin}/preview-sessions`);
    expect(listed.status()).toBe(200);
    const listedBody = (await listed.json()) as {
      previewSessions: { previewSessionId: string }[];
    };
    expect(listedBody.previewSessions).toHaveLength(1);
    const session = listedBody.previewSessions[0];
    expect(session).toBeDefined();
    const sessionUrl = `${server.origin}/preview-sessions/${session.previewSessionId}`;

    for (const [qid, visibleText] of sourceQuestionTypeCases) {
      await page.goto(`${sessionUrl}/questions/${qid}?variant=1`);
      await expect(page.getByText(visibleText).last()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save & Grade' })).toBeVisible();
    }

    const freeformUrl = `${sessionUrl}/questions/freeform/v3?variant=1`;
    await page.goto(freeformUrl);
    await expect(page.getByText('Variant seed 1')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Variant seed 1')).toBeVisible();
    await page.goto(`${sessionUrl}/questions/freeform/v3?variant=2`);
    await expect(page.getByText('Variant seed 2')).toBeVisible();

    await fs.writeFile(
      path.join(courseDir, 'questions/freeform/v3/question.html'),
      '<p>Refreshed source for variant seed {{params.seed}}</p>\n' +
        '<pl-number-input answers-name="ans" label="$x =$"></pl-number-input>\n',
    );
    await page.goto(freeformUrl);
    await expect(page.getByText('Refreshed source for variant seed 1')).toBeVisible();

    await page.getByRole('textbox').fill('2');
    await page.getByRole('button', { name: 'Save & Grade' }).click();
    await expect(page.getByTestId('submission-status').getByText('100%')).toBeVisible();

    await page.goto(`${sessionUrl}/questions/legacy/multiple-choice?variant=1`);
    await page.getByLabel('Four').check();
    await page.getByRole('button', { name: 'Save & Grade' }).click();
    await expect(page.getByTestId('submission-status').getByText('100%')).toBeVisible();

    await page.goto(`${freeformUrl}&render-mode=question-only`);
    await expect(page.getByText('Refreshed source for variant seed 1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save & Grade' })).toHaveCount(0);
  } finally {
    await server.close();
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
});

test('renders browser-safe errors for unknown and deleted Local Preview Sessions', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer();

  try {
    const unknownResponse = await page.goto(
      `${server.origin}/preview-sessions/pvs_0000000000000000000000/questions/freeform/v3`,
    );
    expect(unknownResponse?.status()).toBe(404);
    expect(unknownResponse?.headers()['content-type']).toContain('text/html');
    await expect(page.getByRole('heading', { name: 'Question preview failed' })).toBeVisible();

    const created = await request.post(`${server.origin}/preview-sessions`, {
      data: { courseDir: fixtureCourseDir },
    });
    const session = (await created.json()) as { previewSessionId: string };
    const deleted = await request.delete(
      `${server.origin}/preview-sessions/${session.previewSessionId}`,
    );
    expect(deleted.status()).toBe(204);

    const deletedResponse = await page.goto(
      `${server.origin}/preview-sessions/${session.previewSessionId}/questions/freeform/v3`,
    );
    expect(deletedResponse?.status()).toBe(404);
    expect(deletedResponse?.headers()['content-type']).toContain('text/html');
    await expect(page.getByRole('heading', { name: 'Question preview failed' })).toBeVisible();
  } finally {
    await server.close();
  }
});

test('keeps session-owned browser resources scoped while PrairieLearn assets stay global', async ({
  page,
  request,
}) => {
  const server = await startCompiledPreviewServer(['--render-mode', 'full']);

  try {
    const createSession = async () => {
      const response = await request.post(`${server.origin}/preview-sessions`, {
        data: { courseDir: fixtureCourseDir },
      });
      expect(response.status()).toBe(201);
      return (await response.json()) as { previewSessionId: string };
    };
    const owner = await createSession();
    const other = await createSession();
    const questionUrl = `${server.origin}/preview-sessions/${owner.previewSessionId}/questions/freeform/resources?variant=1`;

    await page.goto(questionUrl);
    const courseHref = await page.getByRole('link', { name: 'course.txt' }).getAttribute('href');
    const questionHref = await page
      .getByRole('link', { name: 'question.txt' })
      .getAttribute('href');
    const generatedHref = await page
      .getByRole('link', { name: 'generated.txt' })
      .getAttribute('href');

    expect(courseHref).toBe(
      `/preview-sessions/${owner.previewSessionId}/preview-render/clientFilesCourse/course.txt`,
    );
    expect(questionHref).toBe(
      `/preview-sessions/${owner.previewSessionId}/preview-render/questions/freeform/resources/files/question.txt`,
    );
    expect(generatedHref).toMatch(
      new RegExp(
        `^/preview-sessions/${owner.previewSessionId}/preview-render/generatedFilesQuestion/variant/[^/]+/generated\\.txt$`,
      ),
    );

    for (const [href, expectedBody] of [
      [courseHref, 'course resource\n'],
      [questionHref, 'question resource\n'],
      [generatedHref, 'generated resource for seed 1'],
    ] as const) {
      const response = await request.get(`${server.origin}${href}`);
      expect(response.status()).toBe(200);
      expect(await response.text()).toBe(expectedBody);
    }

    const globalAsset = await request.get(
      `${server.origin}/assets/public/cache/localscripts/question.js`,
    );
    expect(globalAsset.status()).toBe(200);

    const crossSessionGenerated = await request.get(
      `${server.origin}${generatedHref?.replace(owner.previewSessionId, other.previewSessionId)}`,
    );
    expect(crossSessionGenerated.status()).toBe(404);

    const answerName = `_file_editor_${createHash('sha1').update('solution.py').digest('hex')}`;
    const graded = await request.post(questionUrl, {
      form: {
        __action: 'grade',
        [answerName]: Buffer.from('print("session owned")\n').toString('base64'),
      },
    });
    expect(graded.status()).toBe(200);
    const submissionPath = (await graded.text()).match(
      /data-submission-files-url="(?<path>\/preview-sessions\/[^"?#]+\/file)"/,
    )?.groups?.path;
    expect(submissionPath).toContain(`/preview-sessions/${owner.previewSessionId}/`);
    const submissionFile = await request.get(`${server.origin}${submissionPath}/solution.py`);
    expect(submissionFile.status()).toBe(200);
    expect(await submissionFile.text()).toBe('print("session owned")\n');
  } finally {
    await server.close();
  }
});
