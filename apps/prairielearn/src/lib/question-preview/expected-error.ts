export type QuestionPreviewPhase =
  | 'input'
  | 'metadata'
  | 'generate'
  | 'prepare'
  | 'parse'
  | 'grade'
  | 'render';

export class ExpectedQuestionPreviewError extends Error {
  data?: unknown;
  fatal = true;
  phase: QuestionPreviewPhase;

  constructor(message: string, { data, phase }: { data?: unknown; phase: QuestionPreviewPhase }) {
    super(message);
    this.data = data;
    this.phase = phase;
  }
}
