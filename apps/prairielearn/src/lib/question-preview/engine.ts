import type {
  QuestionPreviewDocumentInput,
  QuestionPreviewDocumentRendererOptions,
  QuestionPreviewDocumentResult,
} from './document.js';

export interface QuestionPreviewEngineGeneration {
  close(): Promise<void>;
  render(
    options: QuestionPreviewDocumentRendererOptions,
    input: QuestionPreviewDocumentInput,
  ): Promise<QuestionPreviewDocumentResult>;
}

export type QuestionPreviewEngineGenerationFactory = () => Promise<QuestionPreviewEngineGeneration>;

export interface QuestionPreviewCourseRenderer {
  close(): Promise<void>;
  render(input: QuestionPreviewDocumentInput): Promise<QuestionPreviewDocumentResult>;
}

export interface QuestionPreviewEngineLifecycle {
  close(): Promise<void>;
  createCourseRenderer(
    options: QuestionPreviewDocumentRendererOptions,
  ): QuestionPreviewCourseRenderer;
}

class InitializedQuestionPreviewCourseRenderer implements QuestionPreviewCourseRenderer {
  private closed = false;

  constructor(
    private readonly engine: InitializedQuestionPreviewEngineLifecycle,
    private readonly options: QuestionPreviewDocumentRendererOptions,
  ) {}

  async render(input: QuestionPreviewDocumentInput) {
    if (this.closed) throw new Error('Question preview course renderer is closed.');
    return this.engine.render(this.options, input);
  }

  async close() {
    this.closed = true;
  }
}

class InitializedQuestionPreviewEngineLifecycle implements QuestionPreviewEngineLifecycle {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private currentGeneration: GenerationState | null;
  private lastStaleClose: Promise<void> = Promise.resolve();
  private replacementPromise: Promise<GenerationState> | null = null;

  constructor(
    generation: QuestionPreviewEngineGeneration,
    private readonly createGeneration: QuestionPreviewEngineGenerationFactory,
  ) {
    this.currentGeneration = makeGenerationState(generation);
  }

  createCourseRenderer(options: QuestionPreviewDocumentRendererOptions) {
    if (this.closed) throw new Error('Question preview engine is closed.');
    return new InitializedQuestionPreviewCourseRenderer(this, options);
  }

  async render(
    options: QuestionPreviewDocumentRendererOptions,
    input: QuestionPreviewDocumentInput,
  ) {
    if (this.closed) throw new Error('Question preview engine is closed.');
    const state = await this.getGeneration();
    state.activeRenders++;

    try {
      return await state.generation.render(options, input);
    } catch (err) {
      this.markGenerationStale(state);
      throw err;
    } finally {
      state.activeRenders--;
      if (state.activeRenders === 0 && state.stale) state.resolveDrained();
    }
  }

  async close() {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.closeEngine();
    }
    return this.closePromise;
  }

  private async getGeneration() {
    if (this.currentGeneration != null) return this.currentGeneration;

    this.replacementPromise ??= this.lastStaleClose
      .catch(() => {})
      .then(this.createGeneration)
      .then(makeGenerationState);
    const replacementPromise = this.replacementPromise;
    try {
      const state = await replacementPromise;
      if (this.closed) {
        this.markGenerationStale(state);
        throw new Error('Question preview engine is closed.');
      }
      this.currentGeneration = state;
      return state;
    } finally {
      if (this.replacementPromise === replacementPromise) this.replacementPromise = null;
    }
  }

  private markGenerationStale(state: GenerationState) {
    if (state.stale) return;
    state.stale = true;
    if (this.currentGeneration === state) this.currentGeneration = null;
    if (state.activeRenders === 0) state.resolveDrained();
    this.lastStaleClose = state.drained.then(() => state.generation.close());
  }

  private async closeEngine() {
    const pendingReplacement = this.replacementPromise;
    if (pendingReplacement != null) await pendingReplacement.catch(() => null);
    const currentGeneration = this.currentGeneration;
    if (currentGeneration != null) this.markGenerationStale(currentGeneration);
    await this.lastStaleClose;
  }
}

interface GenerationState {
  activeRenders: number;
  drained: Promise<void>;
  generation: QuestionPreviewEngineGeneration;
  resolveDrained(): void;
  stale: boolean;
}

function makeGenerationState(generation: QuestionPreviewEngineGeneration): GenerationState {
  let resolveDrained = () => {};
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  return { activeRenders: 0, drained, generation, resolveDrained, stale: false };
}

export async function createQuestionPreviewEngineLifecycle({
  createGeneration,
}: {
  createGeneration: QuestionPreviewEngineGenerationFactory;
}): Promise<QuestionPreviewEngineLifecycle> {
  return new InitializedQuestionPreviewEngineLifecycle(await createGeneration(), createGeneration);
}
