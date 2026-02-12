import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerContext } from '../../src/client/types.js';
import { handleHistory } from '../../src/client/handlers/handleHistory.js';
import { buildInboundMessage, buildCompletedMessage } from '../helpers/messageBuilders.js';
import { createHandlerContext } from '../helpers/contextBuilder.js';

describe('handleHistory', () => {
  let ctx: HandlerContext;
  let enqueued: ReturnType<typeof createHandlerContext>['enqueued'];
  let ensureStarted: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const result = createHandlerContext();
    ctx = result.ctx;
    enqueued = result.enqueued;
    ensureStarted = result.ensureStarted;
    close = vi.fn();
    // Patch controller.close for history tests that check close
    (result.controller as any).close = close;
    ctx.controller = result.controller as any;
  });

  // ── Completed streaming messages ──────────────────────────────────────

  it.each([
    {
      label: 'text',
      name: 'text:t1',
      data: 'Hello world',
      event: 'text-end',
      expectedChunks: [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello world' },
        { type: 'text-end', id: 't1' },
      ],
    },
    {
      label: 'reasoning',
      name: 'reasoning:r1',
      data: 'Think about it',
      event: 'reasoning-end',
      expectedChunks: [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Think about it' },
        { type: 'reasoning-end', id: 'r1' },
      ],
    },
  ])('completed $label emits start + delta + end', ({ name, data, event, expectedChunks }) => {
    const msg = buildCompletedMessage(name, data, event);
    handleHistory(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(enqueued).toEqual(expectedChunks);
    expect(ctx.serialState.size).toBe(0);
  });

  it('empty completed text emits text-start + text-end with no delta', () => {
    const msg = buildCompletedMessage('text:t2', '', 'text-end');
    handleHistory(msg, ctx);

    expect(enqueued).toEqual([
      { type: 'text-start', id: 't2' },
      { type: 'text-end', id: 't2' },
    ]);
    expect(ctx.serialState.size).toBe(0);
  });

  it('in-flight text (no text-end event) emits text-start + text-delta and registers in serialState', () => {
    const msg = buildInboundMessage({
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

  it('in-flight reasoning registers in serialState', () => {
    const msg = buildInboundMessage({
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

  // ── Tool input messages ───────────────────────────────────────────────

  describe('tool messages', () => {
    it('completed tool input (parseable JSON) emits tool-input-start + tool-input-delta + tool-input-available', () => {
      const inputData = JSON.stringify({ query: 'weather' });
      const msg = buildInboundMessage({
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
      const msg = buildInboundMessage({
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
      const msg = buildInboundMessage({
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
      const msg = buildInboundMessage({
        name: 'tool-output:call1',
        data: JSON.stringify({ output: 'Sunny, 72F' }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([
        { type: 'tool-output-available', toolCallId: 'call1', output: 'Sunny, 72F' },
      ]);
    });

    it('tool-error emits tool-output-error', () => {
      const msg = buildInboundMessage({
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
      const msg = buildInboundMessage({ name: 'step-finish' });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([{ type: 'finish-step' }]);
      expect(ctx.emitState.hasEmittedStepStart).toBe(false);
    });

    it('finish emits finish chunk and closes controller', () => {
      const msg = buildInboundMessage({
        name: 'finish',
        data: JSON.stringify({ finishReason: 'stop' }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([{ type: 'finish', finishReason: 'stop' }]);
      expect(close).toHaveBeenCalledOnce();
    });

    it('finish includes messageMetadata when present', () => {
      const metadata = { usage: { inputTokens: 10, outputTokens: 20 } };
      const msg = buildInboundMessage({
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
      const msg = buildInboundMessage({
        name: 'metadata',
        data: JSON.stringify({ messageMetadata }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([{ type: 'message-metadata', messageMetadata }]);
    });
  });

  // ── Discrete events ───────────────────────────────────────────────────

  describe('discrete events', () => {
    it.each([
      {
        label: 'file',
        name: 'file',
        data: { url: 'https://example.com/image.png', mediaType: 'image/png' },
        expectedChunk: {
          type: 'file',
          url: 'https://example.com/image.png',
          mediaType: 'image/png',
        },
      },
      {
        label: 'source-url',
        name: 'source-url',
        data: { sourceId: 's1', url: 'https://example.com', title: 'Example' },
        expectedChunk: {
          type: 'source-url',
          sourceId: 's1',
          url: 'https://example.com',
          title: 'Example',
        },
      },
      {
        label: 'source-document',
        name: 'source-document',
        data: { sourceId: 's2', mediaType: 'application/pdf', title: 'Doc', filename: 'doc.pdf' },
        expectedChunk: {
          type: 'source-document',
          sourceId: 's2',
          mediaType: 'application/pdf',
          title: 'Doc',
          filename: 'doc.pdf',
        },
      },
    ])('$label emits chunk', ({ name, data, expectedChunk }) => {
      const msg = buildInboundMessage({ name, data: JSON.stringify(data) });
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([expectedChunk]);
    });

    it('data-custom emits data chunk', () => {
      const msg = buildInboundMessage({
        name: 'data-custom',
        data: JSON.stringify({ data: { key: 'value' }, id: 'dc1' }),
        extras: { ephemeral: true },
      });
      handleHistory(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(enqueued).toEqual([
        { type: 'data-custom', data: { key: 'value' }, id: 'dc1', transient: true },
      ]);
    });

    it('data-custom without optional fields omits them', () => {
      const msg = buildInboundMessage({
        name: 'data-metrics',
        data: JSON.stringify({ data: [1, 2, 3] }),
      });
      handleHistory(msg, ctx);

      expect(enqueued).toEqual([{ type: 'data-metrics', data: [1, 2, 3] }]);
    });
  });

  // ── Tool name with colons ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('tool name containing colons is preserved', () => {
      const inputData = JSON.stringify({ x: 1 });
      const msg = buildInboundMessage({
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
