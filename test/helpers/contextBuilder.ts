import { vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { HandlerContext, SerialTracker } from '../../src/client/types.js';

export interface MockController {
  chunks: UIMessageChunk[];
  closed: boolean;
  enqueue(chunk: UIMessageChunk): void;
  close(): void;
}

/**
 * Create a HandlerContext backed by an array-collecting mock controller.
 */
export function createHandlerContext(opts?: {
  trackers?: [string, SerialTracker][];
  overrides?: Partial<HandlerContext>;
}): {
  ctx: HandlerContext;
  controller: MockController;
  enqueued: UIMessageChunk[];
  ensureStarted: ReturnType<typeof vi.fn>;
} {
  const enqueued: UIMessageChunk[] = [];
  const controller: MockController = {
    chunks: enqueued,
    closed: false,
    enqueue(chunk: UIMessageChunk) {
      enqueued.push(chunk);
    },
    close() {
      this.closed = true;
    },
  };

  const ensureStarted = vi.fn();
  const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };
  const ctx: HandlerContext = {
    controller: controller as unknown as ReadableStreamDefaultController<UIMessageChunk>,
    serialState: new Map<string, SerialTracker>(opts?.trackers),
    ensureStarted,
    emitState,
    closed: false,
    ...opts?.overrides,
  };

  return { ctx, controller, enqueued, ensureStarted };
}
