import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AblyChatTransport } from '../../src/client/AblyChatTransport.js';
import {
  createMockAbly,
  createMockChannel,
  resetSerialCounter,
} from '../helpers/mockAbly.js';
import { collectChunks } from '../helpers/streamHelpers.js';
import { makeUserMessage } from '../helpers/messageBuilders.js';
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
    makeUserMessage('msg-1', 'Hello'),
  ];

  /** Extract the promptId from the published trigger message. */
  function getPublishedPromptId(triggerName: string): string {
    const call = mockChannel.publishCalls.find(
      (c) => c.message.name === triggerName,
    );
    return call!.message.extras?.headers?.promptId;
  }

  it('subscribes to channel at construction', () => {
    expect(mockChannel.listeners.length).toBeGreaterThan(0);
  });

  describe('sendMessages', () => {
    it('publishes chat-message with promptId and drains buffer until finish', async () => {
      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      const stream = await streamPromise;

      // Extract promptId from the published trigger
      const promptId = getPublishedPromptId('chat-message');
      expect(promptId).toBeDefined();

      // Verify the trigger message has both role and promptId
      const chatMessageCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'chat-message',
      );
      expect(chatMessageCall).toBeDefined();
      const publishData = JSON.parse(chatMessageCall!.message.data);
      expect(publishData.message.id).toBe('msg-1');
      expect(chatMessageCall!.message.extras).toEqual({
        headers: { role: 'user', promptId },
      });

      // Simulate a complete response with matching promptId
      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.create',
        serial: 'S1',
        extras: { headers: { role: 'assistant', promptId } },
      });
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: 'Hello',
        extras: { headers: { role: 'assistant', promptId } },
        version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-delta' } },
      });
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: '',
        extras: { headers: { role: 'assistant', promptId } },
        version: { serial: 'v2', timestamp: Date.now(), metadata: { event: 'text-end' } },
      });
      mockChannel.simulateMessage({
        name: 'step-finish',
        action: 'message.create',
        serial: 'S2',
        extras: { headers: { role: 'assistant', promptId } },
      });
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S3',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId } },
      });

      const chunks = await collectChunks(stream);

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

    it('publishes regenerate event with promptId', async () => {
      const streamPromise = transport.sendMessages({
        trigger: 'regenerate-message',
        chatId: 'chat-123',
        messageId: 'msg-to-regen',
        messages: makeMessages(),
        abortSignal: undefined,
      });

      const stream = await streamPromise;
      const promptId = getPublishedPromptId('regenerate');

      // Complete the stream
      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S1',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId } },
      });

      await collectChunks(stream);

      const regenCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'regenerate',
      );
      expect(regenCall).toBeDefined();
      const regenData = JSON.parse(regenCall!.message.data);
      expect(regenData.messageId).toBe('msg-to-regen');
      expect(regenCall!.message.extras).toEqual({
        headers: { role: 'user', promptId },
      });
    });

    it('publishes only the last message for submit-message', async () => {
      const messages: UIMessage[] = [
        makeUserMessage('msg-1', 'First'),
        { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] },
        makeUserMessage('msg-3', 'Second'),
      ];

      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages,
        abortSignal: undefined,
      });

      const stream = await streamPromise;
      const promptId = getPublishedPromptId('chat-message');

      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S1',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId } },
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
      const promptId = getPublishedPromptId('chat-message');

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
        extras: { headers: { role: 'assistant', promptId } },
      });
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: 'Hi',
        extras: { headers: { role: 'assistant', promptId } },
        version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-delta' } },
      });
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: '',
        extras: { headers: { role: 'assistant', promptId } },
        version: { serial: 'v2', timestamp: Date.now(), metadata: { event: 'text-end' } },
      });
      mockChannel.simulateMessage({
        name: 'step-finish',
        action: 'message.create',
        serial: 'S2',
        extras: { headers: { role: 'assistant', promptId } },
      });
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S3',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId } },
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

    it('publishes user-abort with promptId on abort signal', async () => {
      const controller = new AbortController();

      const streamPromise = transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: controller.signal,
      });

      const stream = await streamPromise;
      const promptId = getPublishedPromptId('chat-message');
      await new Promise((r) => setTimeout(r, 10));

      // Abort after getting the stream
      controller.abort();
      await new Promise((r) => setTimeout(r, 10));

      // Verify user-abort was published with promptId
      const abortCall = mockChannel.publishCalls.find(
        (c) => c.message.name === 'user-abort',
      );
      expect(abortCall).toBeDefined();
      expect(abortCall!.message.extras).toEqual({
        headers: { role: 'user', promptId },
      });

      // Complete the stream to avoid hanging
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S99',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId } },
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

    it('returns a drain stream that processes all messages (no promptId filter)', async () => {
      // Signal that an active stream was detected (e.g. via loadChatHistory)
      (transport as any)._hasActiveStream = true;

      const stream = await transport.reconnectToStream({
        chatId: 'chat-123',
      });

      expect(stream).not.toBeNull();

      // Simulate messages arriving on the channel — no promptId (reconnecting to existing stream)
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

  describe('concurrent sendMessages', () => {
    it('cancels old drain synchronously and closes the stream', async () => {
      // Start first stream and get some data flowing
      const stream1 = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      const chunks1Promise = collectChunks(stream1);
      await new Promise((r) => setTimeout(r, 10));

      const promptId1 = getPublishedPromptId('chat-message');

      // Simulate partial response
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.create',
        serial: 'S1',
        extras: { headers: { role: 'assistant', promptId: promptId1 } },
      });

      // Let the drain process
      await new Promise((r) => setTimeout(r, 10));

      // Call sendMessages again — this synchronously cancels drain1 then publishes
      const stream2 = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: [makeUserMessage('msg-2', 'Follow up')],
        abortSignal: undefined,
      });

      // Stream1 should be closed (cancelActiveDrain closes the controller)
      const chunks1 = await chunks1Promise;
      const types1 = chunks1.map((c) => c.type);
      // Should have partial data but no finish (stream was cancelled, not completed)
      expect(types1).toContain('start');
      expect(types1).toContain('text-start');
      expect(types1).not.toContain('finish');

      // Complete stream2
      const promptId2 = mockChannel.publishCalls.filter(
        (c) => c.message.name === 'chat-message',
      ).pop()!.message.extras?.headers?.promptId;
      expect(promptId2).toBeDefined();
      expect(promptId2).not.toBe(promptId1);

      await new Promise((r) => setTimeout(r, 10));
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S99',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId: promptId2 } },
      });
      await collectChunks(stream2);
    });

    it('filters stale messages from previous prompt when a second sendMessages is called', async () => {
      // Send first message
      const stream1 = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      const chunks1Promise = collectChunks(stream1);
      await new Promise((r) => setTimeout(r, 10));

      const promptId1 = getPublishedPromptId('chat-message');

      // Start streaming response 1
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.create',
        serial: 'S1',
        extras: { headers: { role: 'assistant', promptId: promptId1 } },
      });
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: 'Hello from response 1',
        extras: { headers: { role: 'assistant', promptId: promptId1 } },
        version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-delta' } },
      });

      // Let the drain loop process
      await new Promise((r) => setTimeout(r, 10));

      // Send a second message before response 1 finishes
      const messages2: UIMessage[] = [
        makeUserMessage('msg-2', 'Second question'),
      ];
      const stream2 = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: messages2,
        abortSignal: undefined,
      });

      // Stream1 should be closed
      const chunks1 = await chunks1Promise;
      expect(chunks1.length).toBeGreaterThan(0);

      const chunks2Promise = collectChunks(stream2);
      await new Promise((r) => setTimeout(r, 10));

      // Get promptId2
      const chatCalls = mockChannel.publishCalls.filter(
        (c) => c.message.name === 'chat-message',
      );
      const promptId2 = chatCalls[chatCalls.length - 1].message.extras?.headers?.promptId;
      expect(promptId2).toBeDefined();
      expect(promptId2).not.toBe(promptId1);

      // Simulate stale messages from response 1 (should be filtered by promptId)
      mockChannel.simulateMessage({
        name: 'text:t0',
        action: 'message.append',
        serial: 'S1',
        data: 'more from response 1',
        extras: { headers: { role: 'assistant', promptId: promptId1 } },
        version: { serial: 'v3', timestamp: Date.now(), metadata: { event: 'text-delta' } },
      });
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S5',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId: promptId1 } },
      });

      // Simulate response 2
      mockChannel.simulateMessage({
        name: 'text:t1',
        action: 'message.create',
        serial: 'S10',
        extras: { headers: { role: 'assistant', promptId: promptId2 } },
      });
      mockChannel.simulateMessage({
        name: 'text:t1',
        action: 'message.append',
        serial: 'S10',
        data: 'Hello from response 2',
        extras: { headers: { role: 'assistant', promptId: promptId2 } },
        version: { serial: 'v1', timestamp: Date.now(), metadata: { event: 'text-delta' } },
      });
      mockChannel.simulateMessage({
        name: 'text:t1',
        action: 'message.append',
        serial: 'S10',
        data: '',
        extras: { headers: { role: 'assistant', promptId: promptId2 } },
        version: { serial: 'v2', timestamp: Date.now(), metadata: { event: 'text-end' } },
      });
      mockChannel.simulateMessage({
        name: 'step-finish',
        action: 'message.create',
        serial: 'S11',
        extras: { headers: { role: 'assistant', promptId: promptId2 } },
      });
      mockChannel.simulateMessage({
        name: 'finish',
        action: 'message.create',
        serial: 'S12',
        data: '{"finishReason":"stop"}',
        extras: { headers: { role: 'assistant', promptId: promptId2 } },
      });

      const chunks2 = await chunks2Promise;
      const types2 = chunks2.map((c) => c.type);

      // Stream 2 should have a clean response — no bleed from response 1
      expect(types2).toEqual([
        'start',
        'start-step',
        'text-start',
        'text-delta',
        'text-end',
        'finish-step',
        'finish',
      ]);

      // Verify the text content is only from response 2
      const textDelta = chunks2.find((c) => c.type === 'text-delta');
      expect((textDelta as any).delta).toBe('Hello from response 2');
    });
  });

  describe('close', () => {
    it('closes active stream and unsubscribes', async () => {
      // Start a stream
      const stream = await transport.sendMessages({
        trigger: 'submit-message',
        chatId: 'chat-123',
        messageId: undefined,
        messages: makeMessages(),
        abortSignal: undefined,
      });

      const chunksPromise = collectChunks(stream);
      await new Promise((r) => setTimeout(r, 10));

      // Close the transport
      transport.close();

      // Stream should end (controller.close() called by cancelActiveDrain)
      const chunks = await chunksPromise;
      expect(Array.isArray(chunks)).toBe(true);

      // Listener should be cleared
      expect(mockChannel.listeners).toHaveLength(0);
    });
  });
});
