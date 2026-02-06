import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage } from 'ably';
import type { UIMessageChunk } from 'ai';
import type { HandlerContext, SerialTracker } from '../../src/client/types.js';
import { handleHistory } from '../../src/client/handlers/handleHistory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  overrides: Partial<InboundMessage> & { name: string },
): InboundMessage {
  return {
    id: 'msg-1',
    timestamp: Date.now(),
    clientId: 'client-1',
    connectionId: 'conn-1',
    encoding: null,
    extras: undefined as any,
    serial: overrides.serial ?? 'serial-1',
    version: overrides.version ?? undefined,
    data: overrides.data ?? '',
    name: overrides.name,
    action: undefined as any,
    createdAt: undefined as any,
    updatedAt: undefined as any,
    ...overrides,
  } as unknown as InboundMessage;
}

function makeCompletedMessage(
  name: string,
  data: string,
  eventType: string,
): InboundMessage {
  return makeMessage({
    name,
    data,
    version: { metadata: { event: eventType } } as any,
  });
}

function createContext(): {
  ctx: HandlerContext;
  enqueued: UIMessageChunk[];
  ensureStarted: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const enqueued: UIMessageChunk[] = [];
  const close = vi.fn();
  const ensureStarted = vi.fn();

  const controller = {
    enqueue: (chunk: UIMessageChunk) => enqueued.push(chunk),
    close,
  } as unknown as ReadableStreamDefaultController<UIMessageChunk>;

  const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };
  const ctx: HandlerContext = {
    controller,
    serialState: new Map<string, SerialTracker>(),
    ensureStarted,
    emitState,
  };

  return { ctx, enqueued, ensureStarted, close };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleHistory', () => {
  let ctx: HandlerContext;
  let enqueued: UIMessageChunk[];
  let ensureStarted: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ ctx, enqueued, ensureStarted, close } = createContext());
  });

  // ── Text messages ─────────────────────────────────────────────────────

  describe('text messages', () => {
    it('completed text emits text-start + text-delta + text-end', () => {
      const msg = makeCompletedMessage('text:t1', 'Hello world', 'text-end');
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello world' },
        { type: 'text-end', id: 't1' },
      ]);
      expect(ctx.serialState.size).toBe(0);
    });

    it('empty completed text emits text-start + text-end with no delta', () => {
      const msg = makeCompletedMessage('text:t2', '', 'text-end');
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'text-start', id: 't2' },
        { type: 'text-end', id: 't2' },
      ]);
      expect(ctx.serialState.size).toBe(0);
    });

    it('in-flight text (no text-end event) emits text-start + text-delta and registers in serialState', () => {
      const msg = makeMessage({
        name: 'text:t3',
        data: 'partial text',
        serial: 'ser-t3',
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'text-start', id: 't3' },
        { type: 'text-delta', id: 't3', delta: 'partial text' },
      ]);
      expect(ctx.serialState.get('ser-t3')).toEqual({
        type: 'text',
        id: 't3',
        accumulated: 'partial text',
      });
    });
  });

  // ── Reasoning messages ────────────────────────────────────────────────

  describe('reasoning messages', () => {
    it('completed reasoning emits reasoning-start + reasoning-delta + reasoning-end', () => {
      const msg = makeCompletedMessage(
        'reasoning:r1',
        'Think about it',
        'reasoning-end',
      );
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Think about it' },
        { type: 'reasoning-end', id: 'r1' },
      ]);
      expect(ctx.serialState.size).toBe(0);
    });

    it('in-flight reasoning registers in serialState', () => {
      const msg = makeMessage({
        name: 'reasoning:r2',
        data: 'partial reason',
        serial: 'ser-r2',
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'reasoning-start', id: 'r2' },
        { type: 'reasoning-delta', id: 'r2', delta: 'partial reason' },
      ]);
      expect(ctx.serialState.get('ser-r2')).toEqual({
        type: 'reasoning',
        id: 'r2',
        accumulated: 'partial reason',
      });
    });
  });

  // ── Tool input messages ───────────────────────────────────────────────

  describe('tool messages', () => {
    it('completed tool input (parseable JSON) emits tool-input-start + tool-input-delta + tool-input-available', () => {
      const inputData = JSON.stringify({ query: 'weather' });
      const msg = makeMessage({
        name: 'tool:call1:searchTool',
        data: inputData,
        serial: 'ser-tool1',
      });
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        { type: 'tool-input-start', toolCallId: 'call1', toolName: 'searchTool' },
        { type: 'tool-input-delta', toolCallId: 'call1', inputTextDelta: inputData },
        {
          type: 'tool-input-available',
          toolCallId: 'call1',
          toolName: 'searchTool',
          input: { query: 'weather' },
        },
      ]);
      expect(ctx.serialState.size).toBe(0);
    });

    it('in-flight tool input (unparseable JSON) emits tool-input-start + tool-input-delta and registers in serialState', () => {
      const partialJson = '{"query": "wea';
      const msg = makeMessage({
        name: 'tool:call2:myTool',
        data: partialJson,
        serial: 'ser-tool2',
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'tool-input-start', toolCallId: 'call2', toolName: 'myTool' },
        { type: 'tool-input-delta', toolCallId: 'call2', inputTextDelta: partialJson },
      ]);
      expect(ctx.serialState.get('ser-tool2')).toEqual({
        type: 'tool-input',
        id: 'call2',
        toolName: 'myTool',
        accumulated: partialJson,
      });
    });

    it('tool with no data emits only tool-input-start', () => {
      const msg = makeMessage({
        name: 'tool:call3:emptyTool',
        data: '',
        serial: 'ser-tool3',
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'tool-input-start', toolCallId: 'call3', toolName: 'emptyTool' },
      ]);
      expect(ctx.serialState.size).toBe(0);
    });
  });

  // ── Tool output / error ───────────────────────────────────────────────

  describe('tool-output and tool-error', () => {
    it('tool-output emits tool-output-available', () => {
      const msg = makeMessage({
        name: 'tool-output:call1',
        data: JSON.stringify({ output: 'Sunny, 72F' }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'tool-output-available', toolCallId: 'call1', output: 'Sunny, 72F' },
      ]);
    });

    it('tool-error emits tool-output-error', () => {
      const msg = makeMessage({
        name: 'tool-error:call2',
        data: JSON.stringify({ errorText: 'timeout' }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'tool-output-error', toolCallId: 'call2', errorText: 'timeout' },
      ]);
    });
  });

  // ── Control messages ──────────────────────────────────────────────────

  describe('control messages', () => {
    it('step-finish emits finish-step and resets emitState.hasEmittedStepStart', () => {
      ctx.emitState.hasEmittedStepStart = true;
      const msg = makeMessage({ name: 'step-finish' });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([{ type: 'finish-step' }]);
      expect(ctx.emitState.hasEmittedStepStart).toBe(false);
    });

    it('finish emits finish chunk and closes controller', () => {
      const msg = makeMessage({
        name: 'finish',
        data: JSON.stringify({ finishReason: 'stop' }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'finish', finishReason: 'stop' },
      ]);
      expect(close).toHaveBeenCalledOnce();
    });

    it('finish includes messageMetadata when present', () => {
      const metadata = { usage: { inputTokens: 10, outputTokens: 20 } };
      const msg = makeMessage({
        name: 'finish',
        data: JSON.stringify({ finishReason: 'stop', messageMetadata: metadata }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'finish', finishReason: 'stop', messageMetadata: metadata },
      ]);
      expect(close).toHaveBeenCalledOnce();
    });

    it('metadata emits message-metadata', () => {
      const messageMetadata = { model: 'gpt-4' };
      const msg = makeMessage({
        name: 'metadata',
        data: JSON.stringify({ messageMetadata }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'message-metadata', messageMetadata },
      ]);
    });
  });

  // ── Discrete events ───────────────────────────────────────────────────

  describe('discrete events', () => {
    it('file emits file chunk', () => {
      const msg = makeMessage({
        name: 'file',
        data: JSON.stringify({ url: 'https://example.com/image.png', mediaType: 'image/png' }),
      });
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        { type: 'file', url: 'https://example.com/image.png', mediaType: 'image/png' },
      ]);
    });

    it('source-url emits source-url chunk', () => {
      const msg = makeMessage({
        name: 'source-url',
        data: JSON.stringify({ sourceId: 's1', url: 'https://example.com', title: 'Example' }),
      });
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        { type: 'source-url', sourceId: 's1', url: 'https://example.com', title: 'Example' },
      ]);
    });

    it('source-document emits source-document chunk', () => {
      const msg = makeMessage({
        name: 'source-document',
        data: JSON.stringify({
          sourceId: 's2',
          mediaType: 'application/pdf',
          title: 'Doc',
          filename: 'doc.pdf',
        }),
      });
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        {
          type: 'source-document',
          sourceId: 's2',
          mediaType: 'application/pdf',
          title: 'Doc',
          filename: 'doc.pdf',
        },
      ]);
    });

    it('data-custom emits data chunk', () => {
      const msg = makeMessage({
        name: 'data-custom',
        data: JSON.stringify({ data: { key: 'value' }, id: 'dc1', transient: true }),
      });
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        { type: 'data-custom', data: { key: 'value' }, id: 'dc1', transient: true },
      ]);
    });

    it('data-custom without optional fields omits them', () => {
      const msg = makeMessage({
        name: 'data-metrics',
        data: JSON.stringify({ data: [1, 2, 3] }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'data-metrics', data: [1, 2, 3] },
      ]);
    });
  });

  // ── Tool name with colons ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('tool name containing colons is preserved', () => {
      const inputData = JSON.stringify({ x: 1 });
      const msg = makeMessage({
        name: 'tool:call9:my:namespaced:tool',
        data: inputData,
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'tool-input-start', toolCallId: 'call9', toolName: 'my:namespaced:tool' },
        { type: 'tool-input-delta', toolCallId: 'call9', inputTextDelta: inputData },
        {
          type: 'tool-input-available',
          toolCallId: 'call9',
          toolName: 'my:namespaced:tool',
          input: { x: 1 },
        },
      ]);
    });
  });
});
