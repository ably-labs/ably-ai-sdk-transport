import type { UIMessageChunk } from 'ai';

export function parseData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  return String(data);
}

export function parseJsonData(data: unknown): Record<string, unknown> {
  const str = parseData(data);
  if (str === '') return {};
  return JSON.parse(str) as Record<string, unknown>;
}

export function createEnsureStarted(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: { hasEmittedStart: boolean; hasEmittedStepStart: boolean },
): () => void {
  return function ensureStarted() {
    if (!state.hasEmittedStart) {
      state.hasEmittedStart = true;
      controller.enqueue({ type: 'start' });
    }
    if (!state.hasEmittedStepStart) {
      state.hasEmittedStepStart = true;
      controller.enqueue({ type: 'start-step' });
    }
  };
}
