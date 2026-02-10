import { describe, it, expect, beforeEach } from 'vitest';
import { AblyChatTransport } from '../../src/client/AblyChatTransport.js';
import {
  createMockAbly,
  createMockChannel,
  resetSerialCounter,
} from '../helpers/mockAbly.js';
import { collectChunks } from '../helpers/streamHelpers.js';

describe('AblyChatTransport reconnect scenarios', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let mockAbly: ReturnType<typeof createMockAbly>;
  let transport: AblyChatTransport;

  beforeEach(() => {
    resetSerialCounter();
    mockChannel = createMockChannel();
    mockAbly = createMockAbly(mockChannel);
    transport = new AblyChatTransport({
      ably: mockAbly,
      channelName: 'test-channel',
    });
  });

  it('returns null when no active stream and buffer is empty', async () => {
    const result = await transport.reconnectToStream({ chatId: 'c1' });
    expect(result).toBeNull();
  });

  it('drains buffer with in-flight text stream', async () => {
    (transport as any)._hasActiveStream = true;
    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    await new Promise((r) => setTimeout(r, 10));

    // Simulate continuation of an in-flight text stream
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.create',
      serial: 'S1',
    });
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: 'Hello world!',
      version: {
        serial: 'v1',
        timestamp: Date.now(),
        metadata: { event: 'text-delta' },
      },
    });
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: '',
      version: {
        serial: 'v2',
        timestamp: Date.now(),
        metadata: { event: 'text-end' },
      },
    });
    mockChannel.simulateMessage({
      name: 'step-finish',
      action: 'message.create',
      serial: 'S2',
    });
    mockChannel.simulateMessage({
      name: 'finish',
      action: 'message.create',
      serial: 'S3',
      data: '{"finishReason":"stop"}',
    });

    const chunks = await collectChunks(stream!);
    const types = chunks.map((c) => c.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
  });

  it('drains buffer with text and tool call', async () => {
    (transport as any)._hasActiveStream = true;
    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    await new Promise((r) => setTimeout(r, 10));

    // Simulate text + tool call stream
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.create',
      serial: 'S1',
    });
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: 'Let me search.',
      version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-delta' } },
    });
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: '',
      version: { serial: 'v2', timestamp: Date.now(), metadata: { event: 'text-end' } },
    });

    mockChannel.simulateMessage({
      name: 'tool:call-1:search',
      action: 'message.create',
      serial: 'S2',
      extras: { headers: { event: 'tool-input-available' } },
      data: '{"q":"test"}',
    });
    mockChannel.simulateMessage({
      name: 'tool-output:call-1',
      action: 'message.update',
      serial: 'S2',
      data: '{"output":["result"]}',
    });

    mockChannel.simulateMessage({
      name: 'step-finish',
      action: 'message.create',
      serial: 'S3',
    });
    mockChannel.simulateMessage({
      name: 'finish',
      action: 'message.create',
      serial: 'S4',
      data: '{"finishReason":"stop"}',
    });

    const chunks = await collectChunks(stream!);
    const types = chunks.map((c) => c.type);

    expect(types).toContain('text-start');
    expect(types).toContain('text-end');
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');
    expect(types).toContain('finish');
  });

  it('handles messages buffered before drain starts', async () => {
    // Simulate messages arriving before reconnectToStream is called
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.create',
      serial: 'S1',
    });
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: 'Buffered',
      version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-delta' } },
    });

    // Give subscription time to buffer
    await new Promise((r) => setTimeout(r, 10));

    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    // Send remaining messages after drain starts
    await new Promise((r) => setTimeout(r, 10));
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: '',
      version: { serial: 'v2', timestamp: Date.now(), metadata: { event: 'text-end' } },
    });
    mockChannel.simulateMessage({
      name: 'step-finish',
      action: 'message.create',
      serial: 'S2',
    });
    mockChannel.simulateMessage({
      name: 'finish',
      action: 'message.create',
      serial: 'S3',
      data: '{"finishReason":"stop"}',
    });

    const chunks = await collectChunks(stream!);
    const types = chunks.map((c) => c.type);

    expect(types).toContain('text-start');
    expect(types).toContain('text-delta');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');
  });

  it('drains orphan appends when create was in history (not buffer)', async () => {
    (transport as any)._hasActiveStream = true;
    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    await new Promise((r) => setTimeout(r, 10));

    // Buffer only contains appends — the message.create for text:t0 was
    // consumed by history (untilAttach boundary), not present in the buffer.
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: 'Hello ',
      version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-delta' } },
    });
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: 'world!',
      version: { serial: 'v2', timestamp: Date.now(), metadata: { event: 'text-delta' } },
    });
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: '',
      version: { serial: 'v3', timestamp: Date.now(), metadata: { event: 'text-end' } },
    });
    mockChannel.simulateMessage({
      name: 'step-finish',
      action: 'message.create',
      serial: 'S2',
    });
    mockChannel.simulateMessage({
      name: 'finish',
      action: 'message.create',
      serial: 'S3',
      data: '{"finishReason":"stop"}',
    });

    const chunks = await collectChunks(stream!);
    const types = chunks.map((c) => c.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',     // auto-created from orphan append
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    // Verify the deltas contain the right text
    const deltas = chunks.filter((c) => c.type === 'text-delta');
    expect(deltas).toEqual([
      { type: 'text-delta', id: 't0', delta: 'Hello ' },
      { type: 'text-delta', id: 't0', delta: 'world!' },
    ]);
  });

  it('drains orphan updates (conflation) when create was in history', async () => {
    (transport as any)._hasActiveStream = true;
    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    await new Promise((r) => setTimeout(r, 10));

    // Conflated update — Ably collapsed appends into a single update
    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.update',
      serial: 'S1',
      data: 'Hello world!',
      version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-end' } },
    });
    mockChannel.simulateMessage({
      name: 'step-finish',
      action: 'message.create',
      serial: 'S2',
    });
    mockChannel.simulateMessage({
      name: 'finish',
      action: 'message.create',
      serial: 'S3',
      data: '{"finishReason":"stop"}',
    });

    const chunks = await collectChunks(stream!);
    const types = chunks.map((c) => c.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',     // auto-created from orphan update
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const deltas = chunks.filter((c) => c.type === 'text-delta');
    expect(deltas).toEqual([
      { type: 'text-delta', id: 't0', delta: 'Hello world!' },
    ]);
  });

  it('stream can be cancelled', async () => {
    (transport as any)._hasActiveStream = true;
    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    // Cancel the stream immediately
    const reader = stream!.getReader();
    await reader.cancel();

    // Should not hang — cancel() unblocks the buffer pull
  });
});
