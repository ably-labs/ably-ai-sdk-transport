import { describe, it, expect } from 'vitest';
import { handleAppend } from '../../src/client/handlers/handleAppend.js';
import type { SerialTracker } from '../../src/client/types.js';
import { buildInboundMessage } from '../helpers/messageBuilders.js';
import { createHandlerContext } from '../helpers/contextBuilder.js';

function buildAppendMessage(opts: { serial: string; data?: string; event?: string }) {
  return buildInboundMessage({
    action: 'message.append',
    serial: opts.serial,
    data: opts.data ?? '',
    version: {
      serial: 'v-001',
      timestamp: Date.now(),
      ...(opts.event ? { metadata: { event: opts.event } } : {}),
    },
  });
}

describe('handleAppend', () => {
  // 1. Unknown serial
  it('returns without enqueuing when the serial is unknown', () => {
    const { ctx, enqueued, ensureStarted } = createHandlerContext();

    handleAppend(buildAppendMessage({ serial: 'unknown-serial', data: 'hi' }), ctx);

    expect(enqueued).toHaveLength(0);
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  // ── Delta by type ─────────────────────────────────────────────────────

  it.each([
    {
      label: 'text',
      tracker: { type: 'text' as const, id: 'txt-1', accumulated: '' },
      data: 'hello',
      expectedChunk: { type: 'text-delta', id: 'txt-1', delta: 'hello' },
    },
    {
      label: 'reasoning',
      tracker: { type: 'reasoning' as const, id: 'r-1', accumulated: '' },
      data: 'think',
      expectedChunk: { type: 'reasoning-delta', id: 'r-1', delta: 'think' },
    },
    {
      label: 'tool-input',
      tracker: { type: 'tool-input' as const, id: 'tool-1', toolName: 'myTool', accumulated: '' },
      data: '{"a":',
      expectedChunk: { type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"a":' },
    },
  ])(
    '$label delta — enqueues delta and updates accumulated',
    ({ tracker, data, expectedChunk }) => {
      const { ctx, enqueued } = createHandlerContext({ trackers: [['s1', { ...tracker }]] });

      handleAppend(buildAppendMessage({ serial: 's1', data }), ctx);

      expect(enqueued).toEqual([expectedChunk]);
      expect(ctx.serialState.get('s1')!.accumulated).toBe(data);
    },
  );

  // 3. Text delta with empty data
  it('does not enqueue when text delta data is empty', () => {
    const tracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: 'prev' };
    const { ctx, enqueued } = createHandlerContext({ trackers: [['s1', tracker]] });

    handleAppend(buildAppendMessage({ serial: 's1', data: '' }), ctx);

    expect(enqueued).toHaveLength(0);
    expect(tracker.accumulated).toBe('prev');
  });

  // 4. Text end with empty data
  it('enqueues text-end only when text-end event has empty data, and removes tracker', () => {
    const tracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: 'prev' };
    const { ctx, enqueued } = createHandlerContext({ trackers: [['s1', tracker]] });

    handleAppend(buildAppendMessage({ serial: 's1', data: '', event: 'text-end' }), ctx);

    expect(enqueued).toEqual([{ type: 'text-end', id: 'txt-1' }]);
    expect(ctx.serialState.has('s1')).toBe(false);
  });

  // 5. Text end with non-empty data (conflation)
  it('enqueues text-delta then text-end when text-end has data', () => {
    const tracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: '' };
    const { ctx, enqueued } = createHandlerContext({ trackers: [['s1', tracker]] });

    handleAppend(buildAppendMessage({ serial: 's1', data: 'final', event: 'text-end' }), ctx);

    expect(enqueued).toEqual([
      { type: 'text-delta', id: 'txt-1', delta: 'final' },
      { type: 'text-end', id: 'txt-1' },
    ]);
    expect(tracker.accumulated).toBe('final');
    expect(ctx.serialState.has('s1')).toBe(false);
  });

  // 7. Reasoning end
  it('enqueues reasoning-end and removes tracker on reasoning-end event', () => {
    const tracker: SerialTracker = { type: 'reasoning', id: 'r-1', accumulated: 'prior' };
    const { ctx, enqueued } = createHandlerContext({ trackers: [['s1', tracker]] });

    handleAppend(buildAppendMessage({ serial: 's1', data: '', event: 'reasoning-end' }), ctx);

    expect(enqueued).toEqual([{ type: 'reasoning-end', id: 'r-1' }]);
    expect(ctx.serialState.has('s1')).toBe(false);
  });

  // 9. Tool input end — emits tool-input-available with parsed JSON, does NOT remove from serialState
  it('enqueues tool-input-available with parsed JSON on tool-input-end', () => {
    const tracker: SerialTracker = {
      type: 'tool-input',
      id: 'tool-1',
      toolName: 'myTool',
      accumulated: '{"a":1}',
    };
    const { ctx, enqueued } = createHandlerContext({ trackers: [['s1', tracker]] });

    handleAppend(buildAppendMessage({ serial: 's1', data: '', event: 'tool-input-end' }), ctx);

    expect(enqueued).toEqual([
      {
        type: 'tool-input-available',
        toolCallId: 'tool-1',
        toolName: 'myTool',
        input: { a: 1 },
      },
    ]);
    // Must NOT be deleted — serial is needed for tool-output update
    expect(ctx.serialState.has('s1')).toBe(true);
  });

  // 10. Tool input end with remaining data
  it('enqueues tool-input-delta then tool-input-available when tool-input-end has data', () => {
    const tracker: SerialTracker = {
      type: 'tool-input',
      id: 'tool-1',
      toolName: 'myTool',
      accumulated: '{"b":',
    };
    const { ctx, enqueued } = createHandlerContext({ trackers: [['s1', tracker]] });

    handleAppend(buildAppendMessage({ serial: 's1', data: '2}', event: 'tool-input-end' }), ctx);

    expect(enqueued).toEqual([
      { type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '2}' },
      {
        type: 'tool-input-available',
        toolCallId: 'tool-1',
        toolName: 'myTool',
        input: { b: 2 },
      },
    ]);
    expect(tracker.accumulated).toBe('{"b":2}');
    expect(ctx.serialState.has('s1')).toBe(true);
  });

  // 11. ensureStarted is called whenever a tracker is found
  it('calls ensureStarted for every append where a tracker exists', () => {
    const textTracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: '' };
    const reasoningTracker: SerialTracker = { type: 'reasoning', id: 'r-1', accumulated: '' };
    const toolTracker: SerialTracker = {
      type: 'tool-input',
      id: 'tool-1',
      toolName: 'myTool',
      accumulated: '{}',
    };
    const { ctx, ensureStarted } = createHandlerContext({
      trackers: [
        ['s1', textTracker],
        ['s2', reasoningTracker],
        ['s3', toolTracker],
      ],
    });

    handleAppend(buildAppendMessage({ serial: 's1', data: 'a' }), ctx);
    handleAppend(buildAppendMessage({ serial: 's2', data: 'b' }), ctx);
    handleAppend(buildAppendMessage({ serial: 's3', data: 'c' }), ctx);

    expect(ensureStarted).toHaveBeenCalledTimes(3);
  });
});
