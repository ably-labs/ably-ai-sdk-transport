import { describe, it, expect, beforeEach } from 'vitest';
import { publishToAbly } from '../../src/server/publishToAbly.js';
import { handleCreate } from '../../src/client/handlers/handleCreate.js';
import { handleAppend } from '../../src/client/handlers/handleAppend.js';
import { handleUpdate } from '../../src/client/handlers/handleUpdate.js';
import { createChunkStream, collectChunks } from '../helpers/streamHelpers.js';
import { createMockChannel, resetSerialCounter } from '../helpers/mockAbly.js';
import type { UIMessageChunk } from 'ai';
import type { InboundMessage } from 'ably';
import type { SerialTracker, HandlerContext } from '../../src/client/types.js';

/**
 * Integration test: verifies that chunks published by publishToAbly
 * can be reconstructed by the client handlers into matching chunks.
 *
 * We hook into the mock channel to intercept Ably operations (publish,
 * append, update) and route them through the client handlers, then
 * compare the output chunks against the original input.
 */
describe('roundtrip: publishToAbly → client handlers', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    resetSerialCounter();
    channel = createMockChannel();
  });

  function createClientStream(
    channel: ReturnType<typeof createMockChannel>,
  ): ReadableStream<UIMessageChunk> {
    const serialState = new Map<string, SerialTracker>();
    const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const ensureStarted = () => {
          if (!emitState.hasEmittedStart) {
            emitState.hasEmittedStart = true;
            controller.enqueue({ type: 'start' });
          }
          if (!emitState.hasEmittedStepStart) {
            emitState.hasEmittedStepStart = true;
            controller.enqueue({ type: 'start-step' });
          }
        };

        const ctx: HandlerContext = { controller, serialState, ensureStarted, emitState };

        channel.subscribe((message: InboundMessage) => {
          const action = message.action;
          if (action === 'message.create') {
            handleCreate(message, ctx);
          } else if (action === 'message.append') {
            handleAppend(message, ctx);
          } else if (action === 'message.update') {
            handleUpdate(message, ctx);
          }
        });
      },
    });
  }

  /**
   * Wires the mock channel so that publish/append/update calls
   * simulate delivering messages to subscribers.
   *
   * When `conflateAfter` is set, only the first N appends per serial are
   * delivered as `message.append`. Subsequent appends are buffered and
   * flushed as a single `message.update` when the terminal event arrives
   * (event name ending with `-end`).
   */
  function wireChannelToSubscribers(
    ch: ReturnType<typeof createMockChannel>,
    options?: { conflateAfter?: number },
  ) {
    const origPublish = ch.publish.bind(ch);
    const origAppend = ch.appendMessage.bind(ch);
    const origUpdate = ch.updateMessage.bind(ch);

    // Track serials for lookup
    const serialToName = new Map<string, string>();

    const conflateAfter = options?.conflateAfter;
    const conflationState = new Map<string, { appendCount: number; accumulated: string }>();

    ch.publish = (async (nameOrMsg: any) => {
      const result = await origPublish(nameOrMsg);
      const msg = typeof nameOrMsg === 'object' ? nameOrMsg : { name: nameOrMsg };
      const serial = result.serials[0]!;
      serialToName.set(serial, msg.name);

      if (conflateAfter !== undefined) {
        conflationState.set(serial, {
          appendCount: 0,
          accumulated: (msg.data as string) ?? '',
        });
      }

      ch.simulateMessage({
        name: msg.name,
        data: msg.data ?? '',
        action: 'message.create',
        serial,
        extras: msg.extras,
      });

      return result;
    }) as any;

    ch.appendMessage = ((msg: any, op: any) => {
      const result = origAppend(msg, op);
      const name = serialToName.get(msg.serial) ?? '';
      const state = conflationState.get(msg.serial);

      if (state) {
        state.appendCount++;
        state.accumulated += (msg.data as string) ?? '';
        const event: string = op?.metadata?.event ?? '';

        if (state.appendCount <= conflateAfter!) {
          // Within threshold — deliver normally as message.append
          ch.simulateMessage({
            name,
            data: msg.data ?? '',
            action: 'message.append',
            serial: msg.serial,
            version: {
              serial: `v-${Date.now()}`,
              timestamp: Date.now(),
              metadata: op?.metadata,
            },
          });
        } else if (event.endsWith('-end')) {
          // Terminal event — flush as a single message.update
          ch.simulateMessage({
            name,
            data: state.accumulated,
            action: 'message.update',
            serial: msg.serial,
            version: {
              serial: `v-${Date.now()}`,
              timestamp: Date.now(),
              metadata: op?.metadata,
            },
          });
          conflationState.delete(msg.serial);
        }
        // Otherwise: buffer silently (don't deliver to subscribers)
      } else {
        // No conflation — deliver normally
        ch.simulateMessage({
          name,
          data: msg.data ?? '',
          action: 'message.append',
          serial: msg.serial,
          version: {
            serial: `v-${Date.now()}`,
            timestamp: Date.now(),
            metadata: op?.metadata,
          },
        });
      }

      return result;
    }) as any;

    ch.updateMessage = (async (msg: any, op: any) => {
      const result = await origUpdate(msg, op);
      if (msg.name) {
        serialToName.set(msg.serial, msg.name);
      }

      ch.simulateMessage({
        name: msg.name ?? serialToName.get(msg.serial) ?? '',
        data: msg.data ?? '',
        action: 'message.update',
        serial: msg.serial,
        version: {
          serial: `v-${Date.now()}`,
          timestamp: Date.now(),
          metadata: op?.metadata,
        },
      });

      return result;
    }) as any;
  }

  it('round-trips a simple text response', async () => {
    wireChannelToSubscribers(channel);
    const clientStream = createClientStream(channel);

    const serverChunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Hello' },
      { type: 'text-delta', id: 'text-0', delta: ', world!' },
      { type: 'text-end', id: 'text-0' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];

    const serverStream = createChunkStream(serverChunks);
    await publishToAbly({ channel, stream: serverStream });

    const clientChunks = await collectChunks(clientStream);
    const types = clientChunks.map((c) => c.type);

    expect(types).toEqual([
      'start', // synthesized
      'start-step', // synthesized
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    // Verify text content
    const deltas = clientChunks.filter((c) => c.type === 'text-delta');
    expect((deltas[0] as any).delta).toBe('Hello');
    expect((deltas[1] as any).delta).toBe(', world!');

    const finish = clientChunks.find((c) => c.type === 'finish');
    expect((finish as any).finishReason).toBe('stop');
  });

  it('round-trips a streaming tool call with output', async () => {
    wireChannelToSubscribers(channel);
    const clientStream = createClientStream(channel);

    const serverChunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'search' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"q":' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '"ai"}' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'search',
        input: { q: 'ai' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'c1',
        output: { results: ['result1'] },
      },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];

    await publishToAbly({ channel, stream: createChunkStream(serverChunks) });

    const clientChunks = await collectChunks(clientStream);
    const types = clientChunks.map((c) => c.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-delta',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'finish',
    ]);

    const available = clientChunks.find((c) => c.type === 'tool-input-available') as any;
    expect(available.input).toEqual({ q: 'ai' });

    const output = clientChunks.find((c) => c.type === 'tool-output-available') as any;
    expect(output.output).toEqual({ results: ['result1'] });
  });

  it('round-trips a non-streaming tool call', async () => {
    wireChannelToSubscribers(channel);
    const clientStream = createClientStream(channel);

    const serverChunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      {
        type: 'tool-input-available',
        toolCallId: 'c2',
        toolName: 'getTime',
        input: { tz: 'UTC' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'c2',
        output: { time: '10:30' },
      },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];

    await publishToAbly({ channel, stream: createChunkStream(serverChunks) });

    const clientChunks = await collectChunks(clientStream);
    const types = clientChunks.map((c) => c.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'finish',
    ]);
  });

  it('round-trips a multi-step agent loop', async () => {
    wireChannelToSubscribers(channel);
    const clientStream = createClientStream(channel);

    const serverChunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Let me search.' },
      { type: 'text-end', id: 'text-0' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'search' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"q":"test"}' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'search',
        input: { q: 'test' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'c1',
        output: ['result'],
      },
      { type: 'finish-step' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Found it.' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];

    await publishToAbly({ channel, stream: createChunkStream(serverChunks) });

    const clientChunks = await collectChunks(clientStream);
    const types = clientChunks.map((c) => c.type);

    // Second step-start is client-synthesized (ensureStarted re-fires after step-finish resets emitState)
    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'start-step', // synthesized by client
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
  });

  it('round-trips an error mid-stream', async () => {
    wireChannelToSubscribers(channel);
    const clientStream = createClientStream(channel);

    const serverChunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Working...' },
      { type: 'error', errorText: 'Rate limit exceeded' },
    ];

    await publishToAbly({ channel, stream: createChunkStream(serverChunks) });

    const clientChunks = await collectChunks(clientStream);
    const types = clientChunks.map((c) => c.type);

    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('error');

    const errorChunk = clientChunks.find((c) => c.type === 'error') as any;
    expect(errorChunk.errorText).toBe('Rate limit exceeded');
  });

  it('round-trips with partial conflation (conflateAfter: 1)', async () => {
    wireChannelToSubscribers(channel, { conflateAfter: 1 });
    const clientStream = createClientStream(channel);

    const serverChunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Hello' },
      { type: 'text-delta', id: 'text-0', delta: ', ' },
      { type: 'text-delta', id: 'text-0', delta: 'world!' },
      { type: 'text-end', id: 'text-0' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];

    await publishToAbly({ channel, stream: createChunkStream(serverChunks) });

    const clientChunks = await collectChunks(clientStream);
    const types = clientChunks.map((c) => c.type);

    // First delta delivered as message.append (within threshold).
    // Remaining deltas + text-end conflated into one message.update,
    // which the client reconstructs via delta diffing.
    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta', // 'Hello' from message.append
      'text-delta', // ', world!' from message.update (delta diffed)
      'text-end', // from same message.update
      'finish-step',
      'finish',
    ]);

    const deltas = clientChunks.filter((c) => c.type === 'text-delta');
    expect((deltas[0] as any).delta).toBe('Hello');
    expect((deltas[1] as any).delta).toBe(', world!');
  });

  it('round-trips with full conflation (conflateAfter: 0)', async () => {
    wireChannelToSubscribers(channel, { conflateAfter: 0 });
    const clientStream = createClientStream(channel);

    const serverChunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Hello' },
      { type: 'text-delta', id: 'text-0', delta: ', world!' },
      { type: 'text-end', id: 'text-0' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];

    await publishToAbly({ channel, stream: createChunkStream(serverChunks) });

    const clientChunks = await collectChunks(clientStream);
    const types = clientChunks.map((c) => c.type);

    // All appends conflated — client never sees message.append.
    // Single message.update delivers the full text as a delta.
    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta', // 'Hello, world!' from message.update (full text as delta)
      'text-end', // from same message.update
      'finish-step',
      'finish',
    ]);

    const deltas = clientChunks.filter((c) => c.type === 'text-delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as any).delta).toBe('Hello, world!');
  });
});
