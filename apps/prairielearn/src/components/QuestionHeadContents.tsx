import { html, unsafeHtml, type HtmlSafeString } from '@prairielearn/html';

import { assetPath, compiledScriptTag, nodeModulesAssetPath } from '../lib/assets.js';
import type { Question } from '../lib/db-types.js';

import { CalculatorDrawerHeadScripts } from './CalculatorDrawer.js';

type LegacyScriptSource = 'node_modules' | 'public';

export function QuestionHeadContents({
  afterQuestionScriptHtml = '',
  extraHeadersHtml,
  includeCalculator = false,
  includeLegacyQuestionScripts = true,
  legacyScriptSource = 'node_modules',
  loadMathJaxDeferred = true,
  questionType,
  urlPrefix,
}: {
  afterQuestionScriptHtml?: HtmlSafeString | string;
  extraHeadersHtml: string | null | undefined;
  includeCalculator?: boolean;
  includeLegacyQuestionScripts?: boolean;
  legacyScriptSource?: LegacyScriptSource;
  loadMathJaxDeferred?: boolean;
  questionType: Question['type'];
  urlPrefix: string;
}) {
  return html`
    <meta
      name="mathjax-fonts-path"
      content="${nodeModulesAssetPath('@mathjax/mathjax-newcm-font')}"
    />
    ${compiledScriptTag('question.ts')} ${includeCalculator ? CalculatorDrawerHeadScripts() : ''}
    ${afterQuestionScriptHtml}
    ${loadMathJaxDeferred
      ? html`<script defer src="${nodeModulesAssetPath('mathjax/tex-svg.js')}"></script>`
      : html`<script src="${nodeModulesAssetPath('mathjax/tex-svg.js')}"></script>`}
    <script>
      document.urlPrefix = '${urlPrefix}';
    </script>
    ${includeLegacyQuestionScripts && questionType !== 'Freeform'
      ? legacyQuestionScripts(legacyScriptSource)
      : ''}
    ${unsafeHtml(extraHeadersHtml ?? '')}
  `;
}

function legacyQuestionScripts(source: LegacyScriptSource) {
  const lodashSrc =
    source === 'public'
      ? assetPath('javascripts/lodash.min.js')
      : nodeModulesAssetPath('lodash/lodash.min.js');

  return html`
    <script src="${lodashSrc}"></script>
    <script src="${assetPath('javascripts/require.js')}"></script>
    <script src="${assetPath('localscripts/question.js')}"></script>
    <script src="${assetPath('localscripts/questionCalculation.js')}"></script>
  `;
}
