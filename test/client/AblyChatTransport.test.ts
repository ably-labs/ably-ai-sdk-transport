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

  beforeEach(() => {
    resetSerialCounter();
    mockChannel = createMockChannel();
    mockAbly = createMockAbly(mockChannel);
    transport = new AblyChatTransport({
      ably: mockAbly,
    });
  });

  const makeMessages = (): UIMessage[] => [
    { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
  ];

  describe('sendMessages', () => {
    it('subscribes to channel and publishes chat-message', async () => {
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

      // Verify channel.publish was called with chat-message
      const chatMessageCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'chat-message',
      );
      expect(chatMessageCall).toBeDefined();
      const publishData = JSON.parse(chatMessageCall!.message.data);
      expect(publishData.chatId).toBe('chat-123');
      expect(publishData.message.id).toBe('msg-1');
      expect(chatMessageCall!.message.extras).toEqual({
        headers: { role: 'user' },
      });

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

    it('publishes regenerate event for regenerate-message trigger', async () => {
      const streamPromise = transport.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-123',
        messageId: 'msg-to-regen',
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

      await streamPromise;

      const regenCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'regenerate',
      );
      expect(regenCall).toBeDefined();
      const regenData = JSON.parse(regenCall!.message.data);
      expect(regenData.chatId).toBe('chat-123');
      expect(regenData.messageId).toBe('msg-to-regen');
      expect(regenCall!.message.extras).toEqual({
        headers: { role: 'user' },
      });
    });

    it('publishes only the last message for submit-message', async () => {
      const messages: UIMessage[] = [
        { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'First' }] },
        { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] },
        { id: 'msg-3', role: 'user', parts: [{ type: 'text', text: 'Second' }] },
      ];

      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages,
        abortSignal: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S1',
        data: '{"finishReason":"stop"}',
      });

      await streamPromise;

      const chatMessageCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'chat-message',
      );
      const publishData = JSON.parse(chatMessageCall!.message.data);
      expect(publishData.message.id).toBe('msg-3');
      expect(publishData.message.parts[0].text).toBe('Second');
    });

    it('filters out echo messages (chat-message, regenerate, user-abort)', async () => {
      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Simulate echo messages — these should be filtered out
      mockChannel.simulateMessage({
        name: 'chat-message',
        action: 'message.create',
        serial: 'ECHO1',
        data: '{"message":{},"chatId":"chat-123"}',
      });
      mockChannel.simulateMessage({
        name: 'regenerate',
        action: 'message.create',
        serial: 'ECHO2',
        data: '{"chatId":"chat-123"}',
      });
      mockChannel.simulateMessage({
        name: 'user-abort',
        action: 'message.create',
        serial: 'ECHO3',
        data: '{"chatId":"chat-123"}',
      });

      // Now simulate real assistant messages
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.create',
        serial: 'S1',
      });
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: 'Hi',
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

      // Should only contain assistant message chunks, no echo artifacts
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

    it('uses custom channelName function', async () => {
      const customTransport = new AblyChatTransport({
        ably: mockAbly,
        channelName: (chatId) => `custom:${chatId}`,
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

    it('publishes user-abort on abort signal', async () => {
      const controller = new AbortController();

      const promise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: controller.signal,
      });

      const stream = await promise;
      await new Promise((r) => setTimeout(r, 10));

      // Abort after getting the stream
      controller.abort();
      await new Promise((r) => setTimeout(r, 10));

      // Verify user-abort was published
      const abortCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'user-abort',
      );
      expect(abortCall).toBeDefined();
      const abortData = JSON.parse(abortCall!.message.data);
      expect(abortData.chatId).toBe('chat-123');
      expect(abortCall!.message.extras).toEqual({
        headers: { role: 'user' },
      });

      // Complete the stream to avoid hanging
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S99',
        data: '{"finishReason":"stop"}',
      });
      await collectChunks(stream);
    });

    it('handles channel.publish failure', async () => {
      // Override publish to reject
      const publishSpy = vi.spyOn(mockChannel, 'publish').mockRejectedValueOnce(
        new Error('Channel publish failed'),
      );

      await expect(
        transport.sendMessages({
          trigger: 'submit-message',
          chatId: 'chat-123',
          messageId: undefined,
          messages: makeMessages(),
          abortSignal: undefined,
        }),
      ).rejects.toThrow('Channel publish failed');

      publishSpy.mockRestore();
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
