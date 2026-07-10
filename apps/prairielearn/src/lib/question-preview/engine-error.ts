/**
 * Signals that the process-wide question-code worker generation is unusable.
 * Ordinary course and render failures must stay structured document results.
 */
export class QuestionPreviewEngineGenerationError extends Error {
  override name = 'QuestionPreviewEngineGenerationError';
}
