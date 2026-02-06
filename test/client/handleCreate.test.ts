import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage } from 'ably';
import type { UIMessageChunk } from 'ai';
import { handleCreate } from '../../src/client/handlers/handleCreate.js';
import type { HandlerContext, SerialTracker } from '../../src/client/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMessage(
  overrides: Partial<InboundMessage> & { name?: string; data?: any; serial?: string; extras?: any } = {},
): InboundMessage {
  return {
    id: 'msg-id',
    timestamp: Date.now(),
    action: 'message.create',
    version: { serial: 'v1', timestamp: Date.now() },
    annotations: { summary: {} },
    serial: 'serial-1',
    name: '',
    data: undefined,
    extras: undefined,
    ...overrides,
  } as InboundMessage;
}

class MockController {
  chunks: UIMessageChunk[] = [];
  closed = false;

  enqueue(chunk: UIMessageChunk) {
    this.chunks.push(chunk);
  }

  close() {
    this.closed = true;
  }
}

function createContext(overrides?: Partial<HandlerContext>): {
  ctx: HandlerContext;
  controller: MockController;
  ensureStarted: ReturnType<typeof vi.fn>;
} {
  const controller = new MockController();
  const ensureStarted = vi.fn();
  const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };
  const ctx: HandlerContext = {
    controller: controller as unknown as ReadableStreamDefaultController<UIMessageChunk>,
    serialState: new Map<string, SerialTracker>(),
    ensureStarted,
    emitState,
    ...overrides,
  };
  return { ctx, controller, ensureStarted };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleCreate', () => {
  let controller: MockController;
  let ensureStarted: ReturnType<typeof vi.fn>;
  let ctx: HandlerContext;

  beforeEach(() => {
    ({ ctx, controller, ensureStarted } = createContext());
  });

  // 1. text:{id}
  it('text:{id} — registers serial state, calls ensureStarted, enqueues text-start', () => {
    const msg = buildMessage({ name: 'text:part-1', serial: 'ser-1' });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(ctx.serialState.get('ser-1')).toEqual({
      type: 'text',
      id: 'part-1',
      accumulated: '',
    });
    expect(controller.chunks).toEqual([{ type: 'text-start', id: 'part-1' }]);
  });

  // 2. reasoning:{id}
  it('reasoning:{id} — registers serial state, calls ensureStarted, enqueues reasoning-start', () => {
    const msg = buildMessage({ name: 'reasoning:reason-1', serial: 'ser-2' });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(ctx.serialState.get('ser-2')).toEqual({
      type: 'reasoning',
      id: 'reason-1',
      accumulated: '',
    });
    expect(controller.chunks).toEqual([{ type: 'reasoning-start', id: 'reason-1' }]);
  });

  // 3. tool:{callId}:{toolName} — streaming tool call
  it('tool:{callId}:{toolName} — registers serial state, calls ensureStarted, enqueues tool-input-start', () => {
    const msg = buildMessage({ name: 'tool:call-1:myTool', serial: 'ser-3' });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(ctx.serialState.get('ser-3')).toEqual({
      type: 'tool-input',
      id: 'call-1',
      toolName: 'myTool',
      accumulated: '',
    });
    expect(controller.chunks).toEqual([
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'myTool' },
    ]);
  });

  // 4. tool:{callId}:{toolName} with tool-input-available
  it('tool:{callId}:{toolName} with tool-input-available — enqueues tool-input-start + tool-input-available with parsed input', () => {
    const inputData = { query: 'hello' };
    const msg = buildMessage({
      name: 'tool:call-2:search',
      serial: 'ser-4',
      data: JSON.stringify(inputData),
      extras: { headers: { event: 'tool-input-available' } },
    });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(ctx.serialState.get('ser-4')).toEqual({
      type: 'tool-input',
      id: 'call-2',
      toolName: 'search',
      accumulated: JSON.stringify(inputData),
    });
    expect(controller.chunks).toEqual([
      { type: 'tool-input-start', toolCallId: 'call-2', toolName: 'search' },
      { type: 'tool-input-available', toolCallId: 'call-2', toolName: 'search', input: inputData },
    ]);
  });

  // 5. step-finish
  it('step-finish — enqueues finish-step and resets emitState.hasEmittedStepStart', () => {
    ctx.emitState.hasEmittedStepStart = true;
    const msg = buildMessage({ name: 'step-finish' });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([{ type: 'finish-step' }]);
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(ctx.emitState.hasEmittedStepStart).toBe(false);
  });

  // 7. finish
  it('finish — enqueues finish with finishReason, closes controller', () => {
    const msg = buildMessage({
      name: 'finish',
      data: JSON.stringify({ finishReason: 'stop' }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([
      { type: 'finish', finishReason: 'stop' },
    ]);
    expect(controller.closed).toBe(true);
  });

  // 8. finish with messageMetadata
  it('finish with messageMetadata — includes messageMetadata in chunk', () => {
    const metadata = { tokensUsed: 42 };
    const msg = buildMessage({
      name: 'finish',
      data: JSON.stringify({ finishReason: 'stop', messageMetadata: metadata }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([
      { type: 'finish', finishReason: 'stop', messageMetadata: metadata },
    ]);
    expect(controller.closed).toBe(true);
  });

  // 9. error
  it('error — enqueues error with errorText, closes controller', () => {
    const msg = buildMessage({
      name: 'error',
      data: JSON.stringify({ errorText: 'Something went wrong' }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([
      { type: 'error', errorText: 'Something went wrong' },
    ]);
    expect(controller.closed).toBe(true);
  });

  // 10. abort
  it('abort — enqueues abort, closes controller', () => {
    const msg = buildMessage({ name: 'abort' });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([{ type: 'abort' }]);
    expect(controller.closed).toBe(true);
  });

  // 11. metadata
  it('metadata — enqueues message-metadata', () => {
    const msgMeta = { model: 'gpt-4' };
    const msg = buildMessage({
      name: 'metadata',
      data: JSON.stringify({ messageMetadata: msgMeta }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([
      { type: 'message-metadata', messageMetadata: msgMeta },
    ]);
    expect(controller.closed).toBe(false);
  });

  // 12. file
  it('file — enqueues file with url/mediaType, calls ensureStarted', () => {
    const msg = buildMessage({
      name: 'file',
      data: JSON.stringify({ url: 'https://example.com/img.png', mediaType: 'image/png' }),
    });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(controller.chunks).toEqual([
      { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
    ]);
  });

  // 13. source-url
  it('source-url — enqueues source-url', () => {
    const msg = buildMessage({
      name: 'source-url',
      data: JSON.stringify({ sourceId: 'src-1', url: 'https://example.com', title: 'Example' }),
    });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(controller.chunks).toEqual([
      { type: 'source-url', sourceId: 'src-1', url: 'https://example.com', title: 'Example' },
    ]);
  });

  // 14. source-document
  it('source-document — enqueues source-document', () => {
    const msg = buildMessage({
      name: 'source-document',
      data: JSON.stringify({
        sourceId: 'doc-1',
        mediaType: 'application/pdf',
        title: 'My Doc',
        filename: 'doc.pdf',
      }),
    });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(controller.chunks).toEqual([
      {
        type: 'source-document',
        sourceId: 'doc-1',
        mediaType: 'application/pdf',
        title: 'My Doc',
        filename: 'doc.pdf',
      },
    ]);
  });

  // 15. data-custom
  it('data-custom — enqueues data-custom chunk', () => {
    const msg = buildMessage({
      name: 'data-custom',
      data: JSON.stringify({ data: { foo: 'bar' }, id: 'dc-1' }),
      extras: { ephemeral: true },
    });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(controller.chunks).toEqual([
      { type: 'data-custom', data: { foo: 'bar' }, id: 'dc-1', transient: true },
    ]);
  });

  // 16. unknown message name
  it('unknown message name — does nothing (no enqueue)', () => {
    const msg = buildMessage({ name: 'totally-unknown' });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([]);
    expect(controller.closed).toBe(false);
    expect(ensureStarted).not.toHaveBeenCalled();
  });
});
