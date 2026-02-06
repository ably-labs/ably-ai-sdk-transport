import { describe, it, expect, vi } from 'vitest';
import type { InboundMessage } from 'ably';
import type { UIMessageChunk } from 'ai';
import { handleAppend } from '../../src/client/handlers/handleAppend.js';
import type { HandlerContext, SerialTracker } from '../../src/client/types.js';

// ---------------------------------------------------------------------------
// Helper: build an InboundMessage with action = 'message.append'
// ---------------------------------------------------------------------------
function buildAppendMessage(opts: {
  serial: string;
  data?: string;
  event?: string;
}): InboundMessage {
  return {
    id: 'msg-id',
    name: '',
    data: opts.data ?? '',
    action: 'message.append',
    serial: opts.serial,
    timestamp: Date.now(),
    version: {
      serial: 'v-001',
      timestamp: Date.now(),
      ...(opts.event ? { metadata: { event: opts.event } } : {}),
    },
    annotations: { summary: {} },
  } as InboundMessage;
}

// ---------------------------------------------------------------------------
// Helper: build a HandlerContext backed by an array collector
// ---------------------------------------------------------------------------
function createTestContext(trackers?: [string, SerialTracker][]) {
  const enqueued: UIMessageChunk[] = [];
  const controller = {
    enqueue: vi.fn((chunk: UIMessageChunk) => enqueued.push(chunk)),
  } as unknown as ReadableStreamDefaultController<UIMessageChunk>;

  const serialState = new Map<string, SerialTracker>(trackers);
  const ensureStarted = vi.fn();

  const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };
  const ctx: HandlerContext = { controller, serialState, ensureStarted, emitState };
  return { ctx, enqueued, controller, serialState, ensureStarted };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('handleAppend', () => {
  // 1. Unknown serial
  it('returns without enqueuing when the serial is unknown', () => {
    const { ctx, enqueued, ensureStarted } = createTestContext();

    handleAppend(buildAppendMessage({ serial: 'unknown-serial', data: 'hi' }), ctx);

    expect(enqueued).toHaveLength(0);
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  // 2. Text delta
  it('enqueues a text-delta and updates accumulated for a text tracker', () => {
    const tracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: '' };
    const { ctx, enqueued } = createTestContext([['s1', tracker]]);

    handleAppend(buildAppendMessage({ serial: 's1', data: 'hello' }), ctx);

    expect(enqueued).toEqual([{ type: 'text-delta', id: 'txt-1', delta: 'hello' }]);
    expect(tracker.accumulated).toBe('hello');
  });

  // 3. Text delta with empty data
  it('does not enqueue when text delta data is empty', () => {
    const tracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: 'prev' };
    const { ctx, enqueued } = createTestContext([['s1', tracker]]);

    handleAppend(buildAppendMessage({ serial: 's1', data: '' }), ctx);

    expect(enqueued).toHaveLength(0);
    expect(tracker.accumulated).toBe('prev');
  });

  // 4. Text end with empty data
  it('enqueues text-end only when text-end event has empty data, and removes tracker', () => {
    const tracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: 'prev' };
    const { ctx, enqueued, serialState } = createTestContext([['s1', tracker]]);

    handleAppend(buildAppendMessage({ serial: 's1', data: '', event: 'text-end' }), ctx);

    expect(enqueued).toEqual([{ type: 'text-end', id: 'txt-1' }]);
    expect(serialState.has('s1')).toBe(false);
  });

  // 5. Text end with non-empty data (conflation)
  it('enqueues text-delta then text-end when text-end has data', () => {
    const tracker: SerialTracker = { type: 'text', id: 'txt-1', accumulated: '' };
    const { ctx, enqueued, serialState } = createTestContext([['s1', tracker]]);

    handleAppend(buildAppendMessage({ serial: 's1', data: 'final', event: 'text-end' }), ctx);

    expect(enqueued).toEqual([
      { type: 'text-delta', id: 'txt-1', delta: 'final' },
      { type: 'text-end', id: 'txt-1' },
    ]);
    expect(tracker.accumulated).toBe('final');
    expect(serialState.has('s1')).toBe(false);
  });

  // 6. Reasoning delta
  it('enqueues a reasoning-delta for a reasoning tracker', () => {
    const tracker: SerialTracker = { type: 'reasoning', id: 'r-1', accumulated: '' };
    const { ctx, enqueued } = createTestContext([['s1', tracker]]);

    handleAppend(buildAppendMessage({ serial: 's1', data: 'think' }), ctx);

    expect(enqueued).toEqual([{ type: 'reasoning-delta', id: 'r-1', delta: 'think' }]);
    expect(tracker.accumulated).toBe('think');
  });

  // 7. Reasoning end
  it('enqueues reasoning-end and removes tracker on reasoning-end event', () => {
    const tracker: SerialTracker = { type: 'reasoning', id: 'r-1', accumulated: 'prior' };
    const { ctx, enqueued, serialState } = createTestContext([['s1', tracker]]);

    handleAppend(buildAppendMessage({ serial: 's1', data: '', event: 'reasoning-end' }), ctx);

    expect(enqueued).toEqual([{ type: 'reasoning-end', id: 'r-1' }]);
    expect(serialState.has('s1')).toBe(false);
  });

  // 8. Tool input delta
  it('enqueues a tool-input-delta for a tool-input tracker', () => {
    const tracker: SerialTracker = {
      type: 'tool-input',
      id: 'tool-1',
      toolName: 'myTool',
      accumulated: '',
    };
    const { ctx, enqueued } = createTestContext([['s1', tracker]]);

    handleAppend(buildAppendMessage({ serial: 's1', data: '{"a":' }), ctx);

    expect(enqueued).toEqual([
      { type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"a":' },
    ]);
    expect(tracker.accumulated).toBe('{"a":');
  });

  // 9. Tool input end — emits tool-input-available with parsed JSON, does NOT remove from serialState
  it('enqueues tool-input-available with parsed JSON on tool-input-end', () => {
    const tracker: SerialTracker = {
      type: 'tool-input',
      id: 'tool-1',
      toolName: 'myTool',
      accumulated: '{"a":1}',
    };
    const { ctx, enqueued, serialState } = createTestContext([['s1', tracker]]);

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
    expect(serialState.has('s1')).toBe(true);
  });

  // 10. Tool input end with remaining data
  it('enqueues tool-input-delta then tool-input-available when tool-input-end has data', () => {
    const tracker: SerialTracker = {
      type: 'tool-input',
      id: 'tool-1',
      toolName: 'myTool',
      accumulated: '{"b":',
    };
    const { ctx, enqueued, serialState } = createTestContext([['s1', tracker]]);

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
    expect(serialState.has('s1')).toBe(true);
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
    const { ctx, ensureStarted } = createTestContext([
      ['s1', textTracker],
      ['s2', reasoningTracker],
      ['s3', toolTracker],
    ]);

    handleAppend(buildAppendMessage({ serial: 's1', data: 'a' }), ctx);
    handleAppend(buildAppendMessage({ serial: 's2', data: 'b' }), ctx);
    handleAppend(buildAppendMessage({ serial: 's3', data: 'c' }), ctx);

    expect(ensureStarted).toHaveBeenCalledTimes(3);
  });
});
