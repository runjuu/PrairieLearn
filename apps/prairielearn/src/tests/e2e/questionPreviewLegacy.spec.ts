import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { REPOSITORY_ROOT_PATH } from '../../lib/paths.js';
import { createQuestionPreviewRuntime } from '../../lib/question-preview/render.js';
import { startQuestionPreviewServer } from '../../lib/question-preview/server.js';

import { expect, standaloneTest as test } from './fixtures.js';

async function writeFile(root: string, relativePath: string, contents: string) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function writeQuestion(
  courseDir: string,
  qid: string,
  info: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  await writeFile(courseDir, `questions/${qid}/info.json`, JSON.stringify(info));
  for (const [filename, contents] of Object.entries(files)) {
    await writeFile(courseDir, `questions/${qid}/${filename}`, contents);
  }
}

test('hydrates every Source Question Type and grades through the native browser contract', async ({
  page,
}) => {
  const courseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-preview-legacy-browser-'));
  await writeFile(
    courseDir,
    'infoCourse.json',
    JSON.stringify({
      name: 'TST 101',
      title: 'Legacy browser contract',
      topics: [{ color: 'blue1', name: 'Testing' }],
    }),
  );
  await fs.mkdir(path.join(courseDir, 'questions'));
  await fs.cp(
    path.join(REPOSITORY_ROOT_PATH, 'testCourse/questions/addVectors'),
    path.join(courseDir, 'questions/legacy/calculation'),
    { recursive: true },
  );
  await writeQuestion(courseDir, 'legacy/multiple-choice', {
    options: {
      correctAnswers: ['Four'],
      incorrectAnswers: ['Three', 'Five'],
      numberAnswers: 3,
      text: 'What is two plus two?',
    },
    title: 'Multiple choice preview',
    topic: 'Testing',
    type: 'MultipleChoice',
    uuid: '11111111-1111-4111-8111-111111111220',
  });
  await writeQuestion(courseDir, 'legacy/checkbox', {
    options: {
      correctAnswers: ['True'],
      incorrectAnswers: ['False'],
      numberAnswers: 2,
      text: 'Select the true statement.',
    },
    title: 'Checkbox preview',
    topic: 'Testing',
    type: 'Checkbox',
    uuid: '11111111-1111-4111-8111-111111111221',
  });
  await writeQuestion(
    courseDir,
    'legacy/file',
    {
      options: { fileName: 'starter.txt' },
      title: 'File preview',
      topic: 'Testing',
      type: 'File',
      uuid: '11111111-1111-4111-8111-111111111222',
    },
    {
      'answer.html': '<p>Any file is accepted.</p>',
      'question.html': '<p>Upload the starter file.</p><input id="fileUpload" type="file">',
      'starter.txt': 'starter contents',
    },
  );
  await writeQuestion(courseDir, 'legacy/multiple-true-false', {
    options: {
      falseStatements: ['Two plus two is five.'],
      text: 'Classify each arithmetic statement.',
      trueStatements: ['Two plus two is four.'],
    },
    title: 'Multiple true false preview',
    topic: 'Testing',
    type: 'MultipleTrueFalse',
    uuid: '11111111-1111-4111-8111-111111111223',
  });
  await writeQuestion(
    courseDir,
    'freeform/v3',
    {
      title: 'Freeform preview',
      topic: 'Testing',
      type: 'v3',
      uuid: '11111111-1111-4111-8111-111111111224',
    },
    {
      'question.html':
        '<p>Freeform hydrated</p><pl-number-input answers-name="ans"></pl-number-input>',
      'server.py': 'def generate(data):\n    data["correct_answers"]["ans"] = 2\n',
    },
  );

  const started = await startQuestionPreviewServer({
    argv: [
      '--course-dir',
      courseDir,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--workers-execution-mode',
      'native',
      '--no-workspaces',
    ],
    createRuntime: createQuestionPreviewRuntime,
  });
  const address = started.server.address();
  if (address == null || typeof address === 'string') throw new Error('Expected a TCP server.');
  const origin = `http://${address.address}:${address.port}`;

  try {
    const cases = [
      ['legacy/calculation', 'Define the vector'],
      ['legacy/multiple-choice', 'What is two plus two?'],
      ['legacy/checkbox', 'Select the true statement.'],
      ['legacy/file', 'Upload the starter file.'],
      ['legacy/multiple-true-false', 'Classify each arithmetic statement.'],
      ['freeform/v3', 'Freeform hydrated'],
    ] as const;
    for (const [qid, visibleText] of cases) {
      await page.goto(`${origin}/questions/${qid}?variant=1`);
      await expect(page.getByText(visibleText)).toBeVisible();
    }

    await page.goto(`${origin}/questions/legacy/multiple-choice?variant=1`);
    await page.getByLabel(/Four/).check();
    await page.getByRole('button', { name: 'Save & Grade' }).click();
    await expect(page.getByText('100%')).toBeVisible();
  } finally {
    await started.close();
    await fs.rm(courseDir, { force: true, recursive: true });
  }
});
