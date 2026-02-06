import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AblyChatTransport } from '../../src/client/AblyChatTransport.js';
import {
  createMockAbly,
  createMockChannel,
  resetSerialCounter,
} from '../helpers/mockAbly.js';
import { collectChunks } from '../helpers/streamHelpers.js';
import type { UIMessage } from 'ai';

describe('AblyChatTransport', () => {
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
      api: '/api/chat',
      fetch: mockFetch,
    });
  });

  const makeMessages = (): UIMessage[] => [
    { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
  ];

  describe('sendMessages', () => {
    it('subscribes to channel and sends HTTP POST', async () => {
      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      // Simulate a complete response
      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.create',
        serial: 'S1',
      });
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: 'Hello',
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

      const stream = await streamPromise;
      const chunks = await collectChunks(stream);

      expect(mockFetch).toHaveBeenCalledOnce();
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe('/api/chat');
      expect(fetchCall[1].method).toBe('POST');

      const body = JSON.parse(fetchCall[1].body);
      expect(body.id).toBe('chat-123');
      expect(body.trigger).toBe('submit-message');
      expect(body.messages).toHaveLength(1);

      // Verify chunk sequence
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

    it('throws on non-2xx response', async () => {
      mockFetch.mockResolvedValue(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' }),
      );

      await expect(
        transport.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-123',
          messageId: undefined,
          messages: makeMessages(),
          abortSignal: undefined,
        }),
      ).rejects.toThrow('Chat request failed: 400 Bad Request');
    });

    it('uses custom channelName function', async () => {
      const customTransport = new AblyChatTransport({
        ably: mockAbly,
        channelName: (chatId) => `custom:${chatId}`,
        fetch: mockFetch,
      });

      const getSpy = vi.spyOn(mockAbly.channels, 'get');

      const promise = customTransport.sendMessages({
        trigger: 'submit-message',
        chatId: 'test-id',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      // Complete the stream quickly
      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S1',
        data: '{"finishReason":"stop"}',
      });

      await promise;
      expect(getSpy).toHaveBeenCalledWith('custom:test-id');
    });

    it('includes custom headers and body', async () => {
      const customTransport = new AblyChatTransport({
        ably: mockAbly,
        headers: { 'X-Custom': 'value' },
        fetch: mockFetch,
      });

      const promise = customTransport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: 'msg-id',
        messages: makeMessages(),
        abortSignal: undefined,
        headers: { Authorization: 'Bearer token' },
        body: { extraField: 'extra' },
      });

      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S1',
        data: '{"finishReason":"stop"}',
      });

      await promise;

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers['X-Custom']).toBe('value');
      expect(fetchCall[1].headers['Authorization']).toBe('Bearer token');

      const body = JSON.parse(fetchCall[1].body);
      expect(body.messageId).toBe('msg-id');
      expect(body.extraField).toBe('extra');
    });

    it('handles channel failure state', async () => {
      const promise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateStateChange({
        current: 'failed',
        reason: { message: 'auth error' } as any,
      });

      const stream = await promise;
      const chunks = await collectChunks(stream);
      const errorChunk = chunks.find((c) => c.type === 'error');
      expect(errorChunk).toBeDefined();
      expect((errorChunk as any).errorText).toContain('auth error');
    });

    it('handles abort signal', async () => {
      const controller = new AbortController();

      const promise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: controller.signal,
      });

      // Need to mock fetch to not actually abort
      mockFetch.mockImplementation(() => {
        return new Promise((resolve) => {
          setTimeout(() => resolve(new Response(null, { status: 202 })), 5);
        });
      });

      const stream = await promise;

      // Abort after getting the stream
      controller.abort();
      await new Promise((r) => setTimeout(r, 10));

      // Stream should be closed
      const reader = stream.getReader();
      const { done } = await reader.read();
      expect(done).toBe(true);
    });
  });

  describe('reconnectToStream', () => {
    it('returns null for empty history', async () => {
      // Override the mock channel to return empty history
      mockChannel.publishedMessages.length = 0;
      (mockChannel as any).history = () =>
        Promise.resolve({
          items: [],
          hasNext: () => false,
          isLast: () => true,
          next: () => Promise.resolve(null),
          current: () => Promise.resolve({ items: [] }),
          first: () => Promise.resolve({ items: [] }),
        });

      const result = await transport.reconnectToStream({
        chatId: 'chat-123',
      });

      expect(result).toBeNull();
    });

    it('returns null when last message is finish', async () => {
      (mockChannel as any).history = () =>
        Promise.resolve({
          items: [
            {
              name: 'finish',
              data: '{"finishReason":"stop"}',
              serial: 'S10',
              action: 'message.create',
              id: 'id-10',
              timestamp: Date.now(),
              version: { serial: 'v10', timestamp: Date.now() },
              annotations: { summary: {} },
            },
            {
              name: 'text:t0',
              data: 'Hello',
              serial: 'S1',
              action: 'message.update',
              id: 'id-1',
              timestamp: Date.now(),
              version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-end' } },
              annotations: { summary: {} },
            },
          ],
          hasNext: () => false,
          isLast: () => true,
          next: () => Promise.resolve(null),
          current: () => Promise.resolve(null),
          first: () => Promise.resolve(null),
        });

      const result = await transport.reconnectToStream({
        chatId: 'chat-123',
      });

      expect(result).toBeNull();
    });

    it('returns null when last message is error', async () => {
      (mockChannel as any).history = () =>
        Promise.resolve({
          items: [
            {
              name: 'error',
              data: '{"errorText":"rate limit"}',
              serial: 'S5',
              action: 'message.create',
              id: 'id-5',
              timestamp: Date.now(),
              version: { serial: 'v5', timestamp: Date.now() },
              annotations: { summary: {} },
            },
          ],
          hasNext: () => false,
          isLast: () => true,
          next: () => Promise.resolve(null),
          current: () => Promise.resolve(null),
          first: () => Promise.resolve(null),
        });

      const result = await transport.reconnectToStream({
        chatId: 'chat-123',
      });

      expect(result).toBeNull();
    });

    it('replays active stream history and subscribes for live', async () => {
      const historyItems = [
        // Newest first
        {
          name: 'text:t0',
          data: 'Hello wor',
          serial: 'S1',
          action: 'message.update' as const,
          id: 'id-1',
          timestamp: Date.now(),
          version: {
            serial: 'v3',
            timestamp: Date.now(),
            metadata: { event: 'text-delta' },
          },
          annotations: { summary: {} },
        },
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

      const stream = await transport.reconnectToStream({
        chatId: 'chat-123',
      });

      expect(stream).not.toBeNull();

      // Simulate remaining live messages after stream is returned
      await new Promise((r) => setTimeout(r, 10));

      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: 'ld',
        version: {
          serial: 'v4',
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
          serial: 'v5',
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

      // Should include history replay + live messages
      expect(types).toContain('start');
      expect(types).toContain('text-start');
      expect(types).toContain('text-delta');
      expect(types).toContain('finish');
    });

    it('passes untilAttach: true to history()', async () => {
      const historyItems = [
        {
          name: 'text:t0',
          data: 'Hello',
          serial: 'S1',
          action: 'message.update' as const,
          id: 'id-1',
          timestamp: Date.now(),
          version: {
            serial: 'v2',
            timestamp: Date.now(),
            metadata: { event: 'text-delta' },
          },
          annotations: { summary: {} },
        },
      ];

      const historySpy = vi.fn().mockResolvedValue({
        items: historyItems,
        hasNext: () => false,
        isLast: () => true,
        next: () => Promise.resolve(null),
        current: () => Promise.resolve(null),
        first: () => Promise.resolve(null),
      });
      (mockChannel as any).history = historySpy;

      const stream = await transport.reconnectToStream({
        chatId: 'chat-123',
      });
      expect(stream).not.toBeNull();

      expect(historySpy).toHaveBeenCalledWith({
        untilAttach: true,
        limit: 100,
      });

      // Complete the stream
      await new Promise((r) => setTimeout(r, 10));
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

      await collectChunks(stream!);
    });

    it('uses custom reconnectHistoryLimit', async () => {
      const customTransport = new AblyChatTransport({
        ably: mockAbly,
        fetch: mockFetch,
        reconnectHistoryLimit: 50,
      });

      const historyItems = [
        {
          name: 'text:t0',
          data: 'Hello',
          serial: 'S1',
          action: 'message.update' as const,
          id: 'id-1',
          timestamp: Date.now(),
          version: {
            serial: 'v2',
            timestamp: Date.now(),
            metadata: { event: 'text-delta' },
          },
          annotations: { summary: {} },
        },
      ];

      const historySpy = vi.fn().mockResolvedValue({
        items: historyItems,
        hasNext: () => false,
        isLast: () => true,
        next: () => Promise.resolve(null),
        current: () => Promise.resolve(null),
        first: () => Promise.resolve(null),
      });
      (mockChannel as any).history = historySpy;

      const stream = await customTransport.reconnectToStream({
        chatId: 'chat-123',
      });
      expect(stream).not.toBeNull();

      expect(historySpy).toHaveBeenCalledWith({
        untilAttach: true,
        limit: 50,
      });

      // Complete the stream
      await new Promise((r) => setTimeout(r, 10));
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

      await collectChunks(stream!);
    });
  });
});
