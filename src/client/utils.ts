import type { UIMessageChunk } from 'ai';
import type { SerialTracker } from './types';

// Re-export shared utilities so existing imports from './utils' keep working
export { parseData, parseJsonData, TERMINAL_NAMES, reconstructMessages } from '../shared';

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

/**
 * Parse a message name and create a SerialTracker for it.
 * Returns null if the name doesn't match a known content type.
 */
export function createTrackerFromName(name: string): SerialTracker | null {
  if (name.startsWith('text:')) {
    return { type: 'text', id: name.slice(5), accumulated: '' };
  }
  if (name.startsWith('reasoning:')) {
    return { type: 'reasoning', id: name.slice(10), accumulated: '' };
  }
  if (name.startsWith('tool:')) {
    const parts = name.split(':');
    const toolCallId = parts[1];
    const toolName = parts.slice(2).join(':');
    return { type: 'tool-input', id: toolCallId, toolName, accumulated: '' };
  }
  return null;
}
