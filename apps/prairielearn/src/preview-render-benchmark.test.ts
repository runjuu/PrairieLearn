import { assert, describe, it } from 'vitest';

import {
  formatBenchmarkReport,
  validateOneShotOutput,
  validateWarmOutput,
} from './preview-render-benchmark.js';

describe('preview render benchmark guardrail helpers', () => {
  it('validates one-shot output as exactly one successful JSON envelope', () => {
    const envelope = validateOneShotOutput(
      JSON.stringify({
        diagnostics: [],
        ok: true,
        payload: {
          bodyHtml: '<div class="question-container"></div>',
          headHtml: '<script src="/assets/build/scripts/question-test.js"></script>',
          variant: { seed: '1' },
        },
      }),
    );

    assert.equal(envelope.ok, true);
    assert.throws(
      () =>
        validateOneShotOutput(
          `${JSON.stringify({ ok: true, payload: {}, diagnostics: [] })}\n${JSON.stringify({
            ok: true,
          })}`,
        ),
      /exactly one JSON line/,
    );
  });

  it('validates warm output as ready plus successful typed responses', () => {
    const warm = validateWarmOutput(
      [
        JSON.stringify({ ok: true, type: 'ready' }),
        JSON.stringify({
          diagnostics: [],
          durationMs: 12,
          id: 'warm-1',
          ok: true,
          payload: { bodyHtml: '<p>one</p>', headHtml: '', variant: { seed: '1' } },
          type: 'response',
        }),
        JSON.stringify({
          diagnostics: [],
          durationMs: 8,
          id: 'warm-2',
          ok: true,
          payload: { bodyHtml: '<p>two</p>', headHtml: '', variant: { seed: '2' } },
          type: 'response',
        }),
      ].join('\n'),
      2,
    );

    assert.equal(warm.responses.length, 2);
    assert.deepEqual(
      warm.responses.map((response) => response.id),
      ['warm-1', 'warm-2'],
    );
    assert.throws(
      () => validateWarmOutput(JSON.stringify({ ok: true, ready: true }), 2),
      /ready event/,
    );
  });

  it('formats output as a development guardrail rather than a production performance gate', () => {
    const report = formatBenchmarkReport({
      courseDir: '/course',
      oneShotMs: 1000,
      qid: 'demo/question',
      warmResponses: [
        { durationMs: 20, id: 'warm-1' },
        { durationMs: 10, id: 'warm-2' },
      ],
      warmTotalMs: 1200,
    });

    assert.match(report, /development guardrail/i);
    assert.match(report, /not a production deployment performance gate/i);
    assert.match(report, /one-shot/i);
    assert.match(report, /warm render 1/i);
  });
});
