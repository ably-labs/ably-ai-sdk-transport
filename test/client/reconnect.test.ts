import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AblyChatTransport } from '../../src/client/AblyChatTransport.js';
import {
  createMockAbly,
  createMockChannel,
  resetSerialCounter,
} from '../helpers/mockAbly.js';
import { collectChunks } from '../helpers/streamHelpers.js';
import type { InboundMessage } from 'ably';

describe('AblyChatTransport reconnect scenarios', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let mockAbly: ReturnType<typeof createMockAbly>;
  let transport: AblyChatTransport;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetSerialCounter();
    mockChannel = createMockChannel();
    mockAbly = createMockAbly(mockChannel);
    mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 202 }),
    );
    transport = new AblyChatTransport({
      ably: mockAbly,
      fetch: mockFetch,
    });
  });

  function makeHistoryMsg(
    overrides: Partial<InboundMessage>,
  ): InboundMessage {
    return {
      id: overrides.id ?? 'id-' + Math.random().toString(36).slice(2),
      name: overrides.name ?? '',
      data: overrides.data ?? '',
      action: overrides.action ?? 'message.update',
      serial: overrides.serial ?? 'S-' + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      version: overrides.version ?? { serial: 'v1', timestamp: Date.now() },
      annotations: { summary: {} },
      ...overrides,
    } as InboundMessage;
  }

  it('returns null for abort as last message', async () => {
    (mockChannel as any).history = () =>
      Promise.resolve({
        items: [
          makeHistoryMsg({
            name: 'abort',
            data: '{}',
            action: 'message.create',
            serial: 'S5',
          }),
        ],
        hasNext: () => false,
        isLast: () => true,
        next: () => Promise.resolve(null),
        current: () => Promise.resolve(null),
        first: () => Promise.resolve(null),
      });

    const result = await transport.reconnectToStream({ chatId: 'c1' });
    expect(result).toBeNull();
  });

  it('reconnects to in-flight text stream from history', async () => {
    // History shows text being streamed (no text-end event)
    const historyItems = [
      makeHistoryMsg({
        name: 'text:t0',
        data: 'Hello wor',
        serial: 'S1',
        action: 'message.update',
        version: {
          serial: 'v2',
          timestamp: Date.now(),
          metadata: { event: 'text-delta' }, // not text-end
        },
      }),
    ];

    (mockChannel as any).history = () =>
      Promise.resolve({
        items: historyItems,
        hasNext: () => false,
        isLast: () => true,
        next: () => Promise.resolve(null),
        current: () => Promise.resolve(null),
        first: () => Promise.resolve(null),
      });

    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    // Simulate live continuation
    await new Promise((r) => setTimeout(r, 10));

    mockChannel.simulateMessage({
      name: 'text:t0',
      action: 'message.append',
      serial: 'S1',
      data: 'ld!',
      version: {
        serial: 'v3',
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
        serial: 'v4',
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

    // History replay should emit text-start + text-delta (accumulated)
    // Live messages continue with more text-delta + text-end + finish
    expect(types).toContain('start');
    expect(types).toContain('text-start');
    expect(types).toContain('text-end');
    expect(types).toContain('finish');

    // Verify accumulated text from history was emitted as delta
    const deltas = chunks.filter((c) => c.type === 'text-delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    // First delta is the history replay of accumulated text
    expect((deltas[0] as any).delta).toBe('Hello wor');
  });

  it('reconnects to completed text and in-flight tool', async () => {
    // History shows: completed text + in-progress tool
    const historyItems = [
      // Newest first
      makeHistoryMsg({
        name: 'tool:call-1:search',
        data: '{"q":"te', // incomplete JSON — still streaming
        serial: 'S2',
        action: 'message.update',
        version: {
          serial: 'v3',
          timestamp: Date.now(),
          metadata: { event: 'tool-input-delta' },
        },
      }),
      makeHistoryMsg({
        name: 'text:t0',
        data: 'Let me search.',
        serial: 'S1',
        action: 'message.update',
        version: {
          serial: 'v2',
          timestamp: Date.now(),
          metadata: { event: 'text-end' },
        },
      }),
    ];

    (mockChannel as any).history = () =>
      Promise.resolve({
        items: historyItems,
        hasNext: () => false,
        isLast: () => true,
        next: () => Promise.resolve(null),
        current: () => Promise.resolve(null),
        first: () => Promise.resolve(null),
      });

    const stream = await transport.reconnectToStream({ chatId: 'c1' });
    expect(stream).not.toBeNull();

    // Simulate live continuation of tool input
    await new Promise((r) => setTimeout(r, 10));

    mockChannel.simulateMessage({
      name: 'tool:call-1:search',
      action: 'message.append',
      serial: 'S2',
      data: 'st"}',
      version: {
        serial: 'v4',
        timestamp: Date.now(),
        metadata: { event: 'tool-input-delta' },
      },
    });

    mockChannel.simulateMessage({
      name: 'tool:call-1:search',
      action: 'message.append',
      serial: 'S2',
      data: '',
      version: {
        serial: 'v5',
        timestamp: Date.now(),
        metadata: { event: 'tool-input-end' },
      },
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

    // Should have text (completed) + tool (continued from history)
    expect(types).toContain('text-start');
    expect(types).toContain('text-end');
    expect(types).toContain('tool-input-start');
    expect(types).toContain('tool-input-delta');
    expect(types).toContain('tool-input-available');
    expect(types).toContain('tool-output-available');
    expect(types).toContain('finish');
  });

  it('handles history query failure gracefully', async () => {
    (mockChannel as any).history = () =>
      Promise.reject(new Error('History unavailable'));

    const result = await transport.reconnectToStream({ chatId: 'c1' });
    expect(result).toBeNull();
  });
});
