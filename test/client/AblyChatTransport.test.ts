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
      channelName: 'test-channel',
    });
  });

  const makeMessages = (): UIMessage[] => [
    { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
  ];

  it('subscribes to channel at construction', () => {
    expect(mockChannel.listeners.length).toBeGreaterThan(0);
  });

  describe('sendMessages', () => {
    it('publishes chat-message and drains buffer until finish', async () => {
      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      const stream = await streamPromise;

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

      const chunks = await collectChunks(stream);

      // Verify channel.publish was called with chat-message
      const chatMessageCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'chat-message',
      );
      expect(chatMessageCall).toBeDefined();
      const publishData = JSON.parse(chatMessageCall!.message.data);
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

      const stream = await streamPromise;

      // Complete the stream
      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S1',
        data: '{"finishReason":"stop"}',
      });

      await collectChunks(stream);

      const regenCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'regenerate',
      );
      expect(regenCall).toBeDefined();
      const regenData = JSON.parse(regenCall!.message.data);
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

      const stream = await streamPromise;

      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S1',
        data: '{"finishReason":"stop"}',
      });

      await collectChunks(stream);

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

      const stream = await streamPromise;

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

    it('clears buffer before publishing', async () => {
      // Simulate a stale message already in the buffer (from another device)
      mockChannel.simulateMessage({
        name: 'text:stale',
        action: 'message.create',
        serial: 'STALE',
      });

      // Give the subscription time to buffer it
      await new Promise((r) => setTimeout(r, 10));

      // Now send a message — buffer should be cleared
      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      const stream = await streamPromise;

      // Simulate the actual response
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
        data: 'Fresh',
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

      const chunks = await collectChunks(stream);
      const types = chunks.map((c) => c.type);

      // Should NOT include the stale 'text:stale' message
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

    it('publishes user-abort on abort signal', async () => {
      const controller = new AbortController();

      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: controller.signal,
      });

      const stream = await streamPromise;
      await new Promise((r) => setTimeout(r, 10));

      // Abort after getting the stream
      controller.abort();
      await new Promise((r) => setTimeout(r, 10));

      // Verify user-abort was published
      const abortCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'user-abort',
      );
      expect(abortCall).toBeDefined();
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
    it('returns null when no active stream and buffer is empty', async () => {
      const result = await transport.reconnectToStream({ chatId: 'chat-123' });
      expect(result).toBeNull();
    });

    it('returns a drain stream that processes buffered messages', async () => {
      // Signal that an active stream was detected (e.g. via loadChatHistory)
      (transport as any)._hasActiveStream = true;

      const stream = await transport.reconnectToStream({
        chatId: 'chat-123',
      });

      expect(stream).not.toBeNull();

      // Simulate messages arriving on the channel
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
        data: 'Resumed',
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
  });
});
