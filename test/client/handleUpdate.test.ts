import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage } from 'ably';
import type { UIMessageChunk } from 'ai';
import { handleUpdate } from '../../src/client/handlers/handleUpdate.js';
import type { HandlerContext, SerialTracker } from '../../src/client/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUpdateMessage(
  overrides: Partial<InboundMessage> & { data?: unknown } = {},
): InboundMessage {
  return {
    id: overrides.id ?? 'msg-id',
    name: overrides.name ?? '',
    data: overrides.data ?? '',
    action: 'message.update',
    serial: overrides.serial ?? 'serial-0001',
    timestamp: overrides.timestamp ?? Date.now(),
    extras: overrides.extras ?? undefined,
    version: overrides.version ?? {
      serial: 'version-0001',
      timestamp: Date.now(),
    },
    annotations: overrides.annotations ?? { summary: {} },
    ...overrides,
  } as InboundMessage;
}

function createContext(): HandlerContext & { enqueued: UIMessageChunk[] } {
  const enqueued: UIMessageChunk[] = [];
  const controller = {
    enqueue: vi.fn((chunk: UIMessageChunk) => enqueued.push(chunk)),
  } as unknown as ReadableStreamDefaultController<UIMessageChunk>;

  const serialState = new Map<string, SerialTracker>();

  return {
    controller,
    serialState,
    ensureStarted: vi.fn(),
    emitState: { hasEmittedStart: false, hasEmittedStepStart: false },
    enqueued,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleUpdate', () => {
  let ctx: ReturnType<typeof createContext>;

  beforeEach(() => {
    ctx = createContext();
  });

  // ─── 1. tool-output update ──────────────────────────────────────────

  it('enqueues tool-output-available for a tool-output update and cleans serial state', () => {
    const toolCallId = 'call-42';
    // Seed serial state with the matching tool-input tracker
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

    expect(ctx.ensureStarted).toHaveBeenCalled();
    expect(ctx.enqueued).toEqual([
      {
        type: 'tool-output-available',
        toolCallId,
        output: { result: 'ok' },
      },
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

    expect(ctx.ensureStarted).toHaveBeenCalled();
    expect(ctx.enqueued).toEqual([
      {
        type: 'tool-output-error',
        toolCallId,
        errorText: 'something went wrong',
      },
    ]);
    expect(ctx.serialState.has('serial-err')).toBe(false);
  });

  // ─── 3. Conflated text delta ────────────────────────────────────────

  it('extracts delta by diffing accumulated text and enqueues text-delta', () => {
    const serial = 'serial-txt';
    ctx.serialState.set(serial, {
      type: 'text',
      id: 'text-1',
      accumulated: 'Hello',
    });

    const msg = makeUpdateMessage({
      serial,
      data: 'Hello, world',
      version: {
        serial: 'v2',
        timestamp: Date.now(),
        metadata: { event: 'text-delta' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.ensureStarted).toHaveBeenCalled();
    expect(ctx.enqueued).toEqual([
      { type: 'text-delta', id: 'text-1', delta: ', world' },
    ]);
    // Accumulated should have been updated
    expect(ctx.serialState.get(serial)!.accumulated).toBe('Hello, world');
  });

  // ─── 4. Conflated text end with new data ────────────────────────────

  it('emits remaining delta and text-end on conflated text-end event', () => {
    const serial = 'serial-txt-end';
    ctx.serialState.set(serial, {
      type: 'text',
      id: 'text-2',
      accumulated: 'Hel',
    });

    const msg = makeUpdateMessage({
      serial,
      data: 'Hello!',
      version: {
        serial: 'v3',
        timestamp: Date.now(),
        metadata: { event: 'text-end' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.enqueued).toEqual([
      { type: 'text-delta', id: 'text-2', delta: 'lo!' },
      { type: 'text-end', id: 'text-2' },
    ]);
    expect(ctx.serialState.has(serial)).toBe(false);
  });

  // ─── 5. Conflated text end with no new data ─────────────────────────

  it('emits only text-end when accumulated already matches full text', () => {
    const serial = 'serial-txt-end2';
    ctx.serialState.set(serial, {
      type: 'text',
      id: 'text-3',
      accumulated: 'done',
    });

    const msg = makeUpdateMessage({
      serial,
      data: 'done',
      version: {
        serial: 'v4',
        timestamp: Date.now(),
        metadata: { event: 'text-end' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.enqueued).toEqual([{ type: 'text-end', id: 'text-3' }]);
    expect(ctx.serialState.has(serial)).toBe(false);
  });

  // ─── 6. Conflated reasoning delta ──────────────────────────────────

  it('extracts delta for reasoning and enqueues reasoning-delta', () => {
    const serial = 'serial-reason';
    ctx.serialState.set(serial, {
      type: 'reasoning',
      id: 'reason-1',
      accumulated: 'Think',
    });

    const msg = makeUpdateMessage({
      serial,
      data: 'Thinking hard',
      version: {
        serial: 'v5',
        timestamp: Date.now(),
        metadata: { event: 'reasoning-delta' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.enqueued).toEqual([
      { type: 'reasoning-delta', id: 'reason-1', delta: 'ing hard' },
    ]);
    expect(ctx.serialState.get(serial)!.accumulated).toBe('Thinking hard');
  });

  // ─── 7. Conflated reasoning end ────────────────────────────────────

  it('emits remaining delta and reasoning-end on conflated reasoning-end event', () => {
    const serial = 'serial-reason-end';
    ctx.serialState.set(serial, {
      type: 'reasoning',
      id: 'reason-2',
      accumulated: 'Rea',
    });

    const msg = makeUpdateMessage({
      serial,
      data: 'Reason!',
      version: {
        serial: 'v6',
        timestamp: Date.now(),
        metadata: { event: 'reasoning-end' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.enqueued).toEqual([
      { type: 'reasoning-delta', id: 'reason-2', delta: 'son!' },
      { type: 'reasoning-end', id: 'reason-2' },
    ]);
    expect(ctx.serialState.has(serial)).toBe(false);
  });

  // ─── 8. Conflated tool-input delta ─────────────────────────────────

  it('extracts delta for tool-input and enqueues tool-input-delta', () => {
    const serial = 'serial-tool-in';
    ctx.serialState.set(serial, {
      type: 'tool-input',
      id: 'tool-1',
      toolName: 'search',
      accumulated: '{"q',
    });

    const msg = makeUpdateMessage({
      serial,
      data: '{"query',
      version: {
        serial: 'v7',
        timestamp: Date.now(),
        metadata: { event: 'tool-input-delta' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.enqueued).toEqual([
      { type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: 'uery' },
    ]);
    expect(ctx.serialState.get(serial)!.accumulated).toBe('{"query');
  });

  // ─── 9. Conflated tool-input end ───────────────────────────────────

  it('emits remaining delta and tool-input-available on conflated tool-input-end', () => {
    const serial = 'serial-tool-end';
    ctx.serialState.set(serial, {
      type: 'tool-input',
      id: 'tool-2',
      toolName: 'calculate',
      accumulated: '{"x":',
    });

    const fullJson = '{"x":42}';
    const msg = makeUpdateMessage({
      serial,
      data: fullJson,
      version: {
        serial: 'v8',
        timestamp: Date.now(),
        metadata: { event: 'tool-input-end' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.enqueued).toEqual([
      { type: 'tool-input-delta', toolCallId: 'tool-2', inputTextDelta: '42}' },
      {
        type: 'tool-input-available',
        toolCallId: 'tool-2',
        toolName: 'calculate',
        input: { x: 42 },
      },
    ]);
  });

  // ─── 10. Unknown serial in conflation case ─────────────────────────

  it('returns silently when serial is not found in serialState', () => {
    const msg = makeUpdateMessage({
      serial: 'unknown-serial',
      data: 'some data',
      version: {
        serial: 'v9',
        timestamp: Date.now(),
        metadata: { event: 'text-delta' },
      },
    });

    handleUpdate(msg, ctx);

    expect(ctx.ensureStarted).not.toHaveBeenCalled();
    expect(ctx.enqueued).toEqual([]);
  });

  // ─── 11. tool-output cleans up the correct serial ──────────────────

  it('tool-output removes only the serial whose tracker matches the toolCallId', () => {
    const toolCallId = 'call-A';
    // Two tool-input trackers in state; only the matching one should be removed
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

    // serial-A removed, serial-B still present
    expect(ctx.serialState.has('serial-A')).toBe(false);
    expect(ctx.serialState.has('serial-B')).toBe(true);
  });
});
