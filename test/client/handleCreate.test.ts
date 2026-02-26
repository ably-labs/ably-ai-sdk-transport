import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreate } from '../../src/client/handlers/handleCreate.js';
import type { HandlerContext } from '../../src/client/types.js';
import { buildInboundMessage } from '../helpers/messageBuilders.js';
import { createHandlerContext, type MockController } from '../helpers/contextBuilder.js';

describe('handleCreate', () => {
  let controller: MockController;
  let ensureStarted: ReturnType<typeof vi.fn>;
  let ctx: HandlerContext;

  beforeEach(() => {
    ({ ctx, controller, ensureStarted } = createHandlerContext());
  });

  // ── Streaming message type routing ────────────────────────────────────

  it.each([
    {
      label: 'text',
      name: 'text:part-1',
      serial: 'ser-1',
      expectedTracker: { type: 'text', id: 'part-1', accumulated: '' },
      expectedChunk: { type: 'text-start', id: 'part-1' },
    },
    {
      label: 'reasoning',
      name: 'reasoning:reason-1',
      serial: 'ser-2',
      expectedTracker: { type: 'reasoning', id: 'reason-1', accumulated: '' },
      expectedChunk: { type: 'reasoning-start', id: 'reason-1' },
    },
    {
      label: 'tool',
      name: 'tool:call-1:myTool',
      serial: 'ser-3',
      expectedTracker: { type: 'tool-input', id: 'call-1', toolName: 'myTool', accumulated: '' },
      expectedChunk: { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'myTool' },
    },
  ])(
    '$label:{id} — registers serial state, calls ensureStarted, enqueues start chunk',
    ({ name, serial, expectedTracker, expectedChunk }) => {
      const msg = buildInboundMessage({ name, serial });

      handleCreate(msg, ctx);

      expect(ensureStarted).toHaveBeenCalledOnce();
      expect(ctx.serialState.get(serial)).toEqual(expectedTracker);
      expect(controller.chunks).toEqual([expectedChunk]);
    },
  );

  // 4. tool:{callId}:{toolName} with tool-input-available (non-streaming)
  it('tool:{callId}:{toolName} with tool-input-available — enqueues only tool-input-available with parsed input (no tool-input-start)', () => {
    const inputData = { query: 'hello' };
    const msg = buildInboundMessage({
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
      { type: 'tool-input-available', toolCallId: 'call-2', toolName: 'search', input: inputData },
    ]);
  });

  // 5. step-finish
  it('step-finish — enqueues finish-step and resets emitState.hasEmittedStepStart', () => {
    ctx.emitState.hasEmittedStepStart = true;
    const msg = buildInboundMessage({ name: 'step-finish' });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([{ type: 'finish-step' }]);
    expect(ensureStarted).not.toHaveBeenCalled();
    expect(ctx.emitState.hasEmittedStepStart).toBe(false);
  });

  // ── Terminal messages ─────────────────────────────────────────────────

  it.each([
    {
      label: 'finish',
      name: 'finish',
      data: JSON.stringify({ finishReason: 'stop' }),
      expectedChunk: { type: 'finish', finishReason: 'stop' },
    },
    {
      label: 'error',
      name: 'error',
      data: JSON.stringify({ errorText: 'Something went wrong' }),
      expectedChunk: { type: 'error', errorText: 'Something went wrong' },
    },
    {
      label: 'abort',
      name: 'abort',
      data: undefined,
      expectedChunk: { type: 'abort' },
    },
  ])('$label — enqueues chunk and closes controller', ({ name, data, expectedChunk }) => {
    const msg = buildInboundMessage({ name, data });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([expectedChunk]);
    expect(controller.closed).toBe(true);
  });

  // 8. finish with messageMetadata
  it('finish with messageMetadata — includes messageMetadata in chunk', () => {
    const metadata = { tokensUsed: 42 };
    const msg = buildInboundMessage({
      name: 'finish',
      data: JSON.stringify({ finishReason: 'stop', messageMetadata: metadata }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([
      { type: 'finish', finishReason: 'stop', messageMetadata: metadata },
    ]);
    expect(controller.closed).toBe(true);
  });

  // 11. metadata
  it('metadata — enqueues message-metadata', () => {
    const msgMeta = { model: 'gpt-4' };
    const msg = buildInboundMessage({
      name: 'metadata',
      data: JSON.stringify({ messageMetadata: msgMeta }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([{ type: 'message-metadata', messageMetadata: msgMeta }]);
    expect(controller.closed).toBe(false);
  });

  // ── Discrete events ───────────────────────────────────────────────────

  it.each([
    {
      label: 'file',
      name: 'file',
      data: { url: 'https://example.com/img.png', mediaType: 'image/png' },
      expectedChunk: { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
    },
    {
      label: 'source-url',
      name: 'source-url',
      data: { sourceId: 'src-1', url: 'https://example.com', title: 'Example' },
      expectedChunk: {
        type: 'source-url',
        sourceId: 'src-1',
        url: 'https://example.com',
        title: 'Example',
      },
    },
    {
      label: 'source-document',
      name: 'source-document',
      data: {
        sourceId: 'doc-1',
        mediaType: 'application/pdf',
        title: 'My Doc',
        filename: 'doc.pdf',
      },
      expectedChunk: {
        type: 'source-document',
        sourceId: 'doc-1',
        mediaType: 'application/pdf',
        title: 'My Doc',
        filename: 'doc.pdf',
      },
    },
  ])('$label — enqueues chunk, calls ensureStarted', ({ name, data, expectedChunk }) => {
    const msg = buildInboundMessage({ name, data: JSON.stringify(data) });

    handleCreate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalledOnce();
    expect(controller.chunks).toEqual([expectedChunk]);
  });

  // 15. data-custom (separate because of transient/extras logic)
  it('data-custom — enqueues data-custom chunk', () => {
    const msg = buildInboundMessage({
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

  // ── Tool approval ───────────────────────────────────────────────────

  it('tool-approval — enqueues tool-approval-request chunk', () => {
    const msg = buildInboundMessage({
      name: 'tool-approval:call-99',
      data: JSON.stringify({ approvalId: 'apr-1' }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([
      { type: 'tool-approval-request', toolCallId: 'call-99', approvalId: 'apr-1' },
    ]);
  });

  // ── Optional field extraction ───────────────────────────────────────

  it('text-start — extracts providerMetadata from extras.headers', () => {
    const msg = buildInboundMessage({
      name: 'text:part-1',
      serial: 'ser-1',
      extras: { headers: { providerMetadata: '{"openai":{"cached":true}}' } },
    });

    handleCreate(msg, ctx);

    expect(controller.chunks[0]).toMatchObject({
      type: 'text-start',
      id: 'part-1',
      providerMetadata: { openai: { cached: true } },
    });
  });

  it('abort — extracts reason from data', () => {
    const msg = buildInboundMessage({
      name: 'abort',
      data: JSON.stringify({ reason: 'user cancelled' }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks[0]).toMatchObject({
      type: 'abort',
      reason: 'user cancelled',
    });
  });

  it('file — extracts providerMetadata from data', () => {
    const msg = buildInboundMessage({
      name: 'file',
      data: JSON.stringify({
        url: 'https://example.com/img.png',
        mediaType: 'image/png',
        providerMetadata: { custom: 'meta' },
      }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks[0]).toMatchObject({
      type: 'file',
      url: 'https://example.com/img.png',
      mediaType: 'image/png',
      providerMetadata: { custom: 'meta' },
    });
  });

  it('tool — extracts optional fields from extras.headers for non-streaming tool', () => {
    const msg = buildInboundMessage({
      name: 'tool:call-5:myTool',
      serial: 'ser-5',
      data: JSON.stringify({ q: 'test' }),
      extras: {
        headers: {
          event: 'tool-input-available',
          dynamic: 'true',
          title: '"My Tool"',
          providerMetadata: '{"x":1}',
        },
      },
    });

    handleCreate(msg, ctx);

    expect(controller.chunks[0]).toMatchObject({
      type: 'tool-input-available',
      toolCallId: 'call-5',
      toolName: 'myTool',
      input: { q: 'test' },
      dynamic: true,
      title: 'My Tool',
      providerMetadata: { x: 1 },
    });
  });

  // ── Start message ───────────────────────────────────────────────────

  it('start — emits start chunk with messageId and sets hasEmittedStart', () => {
    const msg = buildInboundMessage({
      name: 'start',
      data: JSON.stringify({ messageId: 'msg-42', messageMetadata: { model: 'gpt-4' } }),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([
      { type: 'start', messageId: 'msg-42', messageMetadata: { model: 'gpt-4' } },
    ]);
    expect(ctx.emitState.hasEmittedStart).toBe(true);
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  it('start — emits start chunk without optional fields when absent', () => {
    const msg = buildInboundMessage({
      name: 'start',
      data: JSON.stringify({}),
    });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([{ type: 'start' }]);
    expect(ctx.emitState.hasEmittedStart).toBe(true);
  });

  // 16. unknown message name
  it('unknown message name — does nothing (no enqueue)', () => {
    const msg = buildInboundMessage({ name: 'totally-unknown' });

    handleCreate(msg, ctx);

    expect(controller.chunks).toEqual([]);
    expect(controller.closed).toBe(false);
    expect(ensureStarted).not.toHaveBeenCalled();
  });
});
