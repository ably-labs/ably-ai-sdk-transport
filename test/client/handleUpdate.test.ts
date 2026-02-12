import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdate } from '../../src/client/handlers/handleUpdate.js';
import type { HandlerContext } from '../../src/client/types.js';
import { buildInboundMessage } from '../helpers/messageBuilders.js';
import { createHandlerContext } from '../helpers/contextBuilder.js';

describe('handleUpdate', () => {
  let ctx: HandlerContext;
  let enqueued: ReturnType<typeof createHandlerContext>['enqueued'];
  let ensureStarted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ ctx, enqueued, ensureStarted } = createHandlerContext());
  });

  function makeUpdateMessage(overrides: Partial<Parameters<typeof buildInboundMessage>[0]> = {}) {
    return buildInboundMessage({ action: 'message.update', ...overrides });
  }

  // ─── 1. tool-output update ──────────────────────────────────────────

  it('enqueues tool-output-available for a tool-output update and cleans serial state', () => {
    const toolCallId = 'call-42';
    ctx.serialState.set('serial-tool', {
      type: 'tool-input',
      id: toolCallId,
      toolName: 'myTool',
      accumulated: '{"a":1}',
    });

    const msg = makeUpdateMessage({
      name: `tool-output:${toolCallId}`,
      data: JSON.stringify({ output: { result: 'ok' } }),
    });

    handleUpdate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalled();
    expect(enqueued).toEqual([
      { type: 'tool-output-available', toolCallId, output: { result: 'ok' } },
    ]);
    expect(ctx.serialState.has('serial-tool')).toBe(false);
  });

  // ─── 2. tool-error update ──────────────────────────────────────────

  it('enqueues tool-output-error for a tool-error update and cleans serial state', () => {
    const toolCallId = 'call-99';
    ctx.serialState.set('serial-err', {
      type: 'tool-input',
      id: toolCallId,
      toolName: 'failTool',
      accumulated: '{}',
    });

    const msg = makeUpdateMessage({
      name: `tool-error:${toolCallId}`,
      data: JSON.stringify({ errorText: 'something went wrong' }),
    });

    handleUpdate(msg, ctx);

    expect(ensureStarted).toHaveBeenCalled();
    expect(enqueued).toEqual([
      { type: 'tool-output-error', toolCallId, errorText: 'something went wrong' },
    ]);
    expect(ctx.serialState.has('serial-err')).toBe(false);
  });

  // ─── 3–9. Conflated delta + end by type ─────────────────────────────

  it.each([
    {
      label: 'text delta',
      trackerType: 'text' as const,
      id: 'text-1',
      accumulated: 'Hello',
      newData: 'Hello, world',
      event: 'text-delta',
      expectedChunks: [{ type: 'text-delta', id: 'text-1', delta: ', world' }],
      removesTracker: false,
    },
    {
      label: 'text end with new data',
      trackerType: 'text' as const,
      id: 'text-2',
      accumulated: 'Hel',
      newData: 'Hello!',
      event: 'text-end',
      expectedChunks: [
        { type: 'text-delta', id: 'text-2', delta: 'lo!' },
        { type: 'text-end', id: 'text-2' },
      ],
      removesTracker: true,
    },
    {
      label: 'text end with no new data',
      trackerType: 'text' as const,
      id: 'text-3',
      accumulated: 'done',
      newData: 'done',
      event: 'text-end',
      expectedChunks: [{ type: 'text-end', id: 'text-3' }],
      removesTracker: true,
    },
    {
      label: 'reasoning delta',
      trackerType: 'reasoning' as const,
      id: 'reason-1',
      accumulated: 'Think',
      newData: 'Thinking hard',
      event: 'reasoning-delta',
      expectedChunks: [{ type: 'reasoning-delta', id: 'reason-1', delta: 'ing hard' }],
      removesTracker: false,
    },
    {
      label: 'reasoning end',
      trackerType: 'reasoning' as const,
      id: 'reason-2',
      accumulated: 'Rea',
      newData: 'Reason!',
      event: 'reasoning-end',
      expectedChunks: [
        { type: 'reasoning-delta', id: 'reason-2', delta: 'son!' },
        { type: 'reasoning-end', id: 'reason-2' },
      ],
      removesTracker: true,
    },
    {
      label: 'tool-input delta',
      trackerType: 'tool-input' as const,
      id: 'tool-1',
      toolName: 'search',
      accumulated: '{"q',
      newData: '{"query',
      event: 'tool-input-delta',
      expectedChunks: [{ type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: 'uery' }],
      removesTracker: false,
    },
    {
      label: 'tool-input end',
      trackerType: 'tool-input' as const,
      id: 'tool-2',
      toolName: 'calculate',
      accumulated: '{"x":',
      newData: '{"x":42}',
      event: 'tool-input-end',
      expectedChunks: [
        { type: 'tool-input-delta', toolCallId: 'tool-2', inputTextDelta: '42}' },
        {
          type: 'tool-input-available',
          toolCallId: 'tool-2',
          toolName: 'calculate',
          input: { x: 42 },
        },
      ],
      removesTracker: false,
    },
  ])(
    'conflated $label — extracts delta and enqueues correct chunks',
    ({
      trackerType,
      id,
      accumulated,
      newData,
      event,
      expectedChunks,
      removesTracker,
      toolName,
    }) => {
      const serial = 'serial-test';
      const tracker =
        trackerType === 'tool-input'
          ? { type: trackerType, id, toolName: toolName!, accumulated }
          : { type: trackerType, id, accumulated };
      ctx.serialState.set(serial, tracker);

      const msg = makeUpdateMessage({
        serial,
        data: newData,
        version: { serial: 'v-test', timestamp: Date.now(), metadata: { event } },
      });

      handleUpdate(msg, ctx);

      expect(ensureStarted).toHaveBeenCalled();
      expect(enqueued).toEqual(expectedChunks);
      if (removesTracker) {
        expect(ctx.serialState.has(serial)).toBe(false);
      } else {
        expect(ctx.serialState.get(serial)!.accumulated).toBe(newData);
      }
    },
  );

  // ─── 10. Unknown serial in conflation case ─────────────────────────

  it('returns silently when serial is not found in serialState', () => {
    const msg = makeUpdateMessage({
      serial: 'unknown-serial',
      data: 'some data',
      version: { serial: 'v9', timestamp: Date.now(), metadata: { event: 'text-delta' } },
    });

    handleUpdate(msg, ctx);

    expect(ensureStarted).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });

  // ─── 11. tool-output cleans up the correct serial ──────────────────

  it('tool-output removes only the serial whose tracker matches the toolCallId', () => {
    const toolCallId = 'call-A';
    ctx.serialState.set('serial-A', {
      type: 'tool-input',
      id: toolCallId,
      toolName: 'toolA',
      accumulated: '{}',
    });
    ctx.serialState.set('serial-B', {
      type: 'tool-input',
      id: 'call-B',
      toolName: 'toolB',
      accumulated: '{}',
    });

    const msg = makeUpdateMessage({
      name: `tool-output:${toolCallId}`,
      data: JSON.stringify({ output: 'done' }),
    });

    handleUpdate(msg, ctx);

    expect(ctx.serialState.has('serial-A')).toBe(false);
    expect(ctx.serialState.has('serial-B')).toBe(true);
  });
});
