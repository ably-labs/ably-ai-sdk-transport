import type { UIMessageChunk } from 'ai';

export interface SerialTracker {
  type: 'text' | 'reasoning' | 'tool-input';
  id: string;
  toolName?: string;
  accumulated: string;
}

export interface EmitState {
  hasEmittedStart: boolean;
  hasEmittedStepStart: boolean;
}

export interface HandlerContext {
  controller: ReadableStreamDefaultController<UIMessageChunk>;
  serialState: Map<string, SerialTracker>;
  ensureStarted: () => void;
  emitState: EmitState;
}
