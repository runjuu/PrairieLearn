import { assert, describe, it } from 'vitest';

import { LocalPreviewSubmissionFiles } from './submission-files.js';

function submissionFileUrl(submissionId: string, fileName: string) {
  return `/preview/question/1/submission/${submissionId}/file/${fileName}`;
}

describe('local preview submission files', () => {
  it('mints distinct per-render submission ids', () => {
    const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' });

    assert.equal(localPreviewSubmissionFiles.createSubmissionId(), '1');
    assert.equal(localPreviewSubmissionFiles.createSubmissionId(), '2');
    assert.equal(localPreviewSubmissionFiles.createSubmissionId(), '3');
  });

  it('registers and resolves a submission file to its decoded bytes', () => {
    const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' });
    const id = localPreviewSubmissionFiles.createSubmissionId();

    localPreviewSubmissionFiles.registerFiles({
      files: [{ contents: Buffer.from('print("hi")\n').toString('base64'), name: 'solution.py' }],
      id,
    });

    const resolved = localPreviewSubmissionFiles.resolveRequest(
      submissionFileUrl(id, 'solution.py'),
    );

    assert.equal(resolved?.found, true);
    if (resolved?.found !== true) throw new Error('Expected submission file to be found.');
    assert.equal(resolved.filename, 'solution.py');
    assert.equal(resolved.contents.toString(), 'print("hi")\n');
  });

  it('resolves a submission file at a nested path', () => {
    const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' });
    const id = localPreviewSubmissionFiles.createSubmissionId();

    localPreviewSubmissionFiles.registerFiles({
      files: [{ contents: Buffer.from('nested').toString('base64'), name: 'src/solution.py' }],
      id,
    });

    const resolved = localPreviewSubmissionFiles.resolveRequest(
      submissionFileUrl(id, 'src/solution.py'),
    );

    assert.equal(resolved?.found, true);
    if (resolved?.found !== true) throw new Error('Expected submission file to be found.');
    assert.equal(resolved.filename, 'src/solution.py');
    assert.equal(resolved.contents.toString(), 'nested');
  });

  it('reports a miss for an unknown submission id and an unknown file name', () => {
    const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' });
    const id = localPreviewSubmissionFiles.createSubmissionId();
    localPreviewSubmissionFiles.registerFiles({
      files: [{ contents: Buffer.from('data').toString('base64'), name: 'solution.py' }],
      id,
    });

    assert.deepEqual(
      localPreviewSubmissionFiles.resolveRequest(submissionFileUrl('999', 'solution.py')),
      {
        found: false,
      },
    );
    assert.deepEqual(
      localPreviewSubmissionFiles.resolveRequest(submissionFileUrl(id, 'missing.py')),
      {
        found: false,
      },
    );
  });

  it('returns null for a path that is not a submission-file route', () => {
    const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' });

    assert.isNull(
      localPreviewSubmissionFiles.resolveRequest('/preview/clientFilesCourse/style.css'),
    );
    assert.isNull(
      localPreviewSubmissionFiles.resolveRequest('/preview/question/1/submission/1/file'),
    );
  });

  it('evicts the least recently registered submission when the registry is full', () => {
    const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({
      max: 1,
      urlPrefix: '/preview',
    });

    const firstId = localPreviewSubmissionFiles.createSubmissionId();
    localPreviewSubmissionFiles.registerFiles({
      files: [{ contents: Buffer.from('first').toString('base64'), name: 'solution.py' }],
      id: firstId,
    });

    const secondId = localPreviewSubmissionFiles.createSubmissionId();
    localPreviewSubmissionFiles.registerFiles({
      files: [{ contents: Buffer.from('second').toString('base64'), name: 'solution.py' }],
      id: secondId,
    });

    assert.deepEqual(
      localPreviewSubmissionFiles.resolveRequest(submissionFileUrl(firstId, 'solution.py')),
      { found: false },
    );

    const retained = localPreviewSubmissionFiles.resolveRequest(
      submissionFileUrl(secondId, 'solution.py'),
    );
    assert.equal(retained?.found, true);
    if (retained?.found !== true) throw new Error('Expected retained submission file to be found.');
    assert.equal(retained.contents.toString(), 'second');
  });

  it('exposes a route pattern scoped to the preview question path', () => {
    const localPreviewSubmissionFiles = new LocalPreviewSubmissionFiles({ urlPrefix: '/preview' });
    assert.equal(localPreviewSubmissionFiles.routePattern, '/preview/question/*');
  });
});
