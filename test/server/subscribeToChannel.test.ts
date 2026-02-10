import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribeToChannel } from '../../src/server/subscribeToChannel.js';
import { createMockChannel, resetSerialCounter } from '../helpers/mockAbly.js';
import { createChunkStream } from '../helpers/streamHelpers.js';
import type { UIMessage, UIMessageChunk } from 'ai';
import type * as Ably from 'ably';

function makeUserMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function makeAssistantStream(text: string): ReadableStream<UIMessageChunk> {
  return createChunkStream([
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: 'text-0' },
    { type: 'text-delta', id: 'text-0', delta: text },
    { type: 'text-end', id: 'text-0' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ]);
}

describe('subscribeToChannel', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    resetSerialCounter();
    channel = createMockChannel();
  });

  it('calls handler with user message on chat-message event', async () => {
    const handler = vi.fn().mockResolvedValue(makeAssistantStream('Hi'));

    subscribeToChannel({ channel, handler });

    const userMsg = makeUserMessage('msg-1', 'Hello');
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({ message: userMsg }),
      extras: { headers: { role: 'user' } },
    });

    // Wait for async handler to be called
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledOnce();
    const callArgs = handler.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].id).toBe('msg-1');
    expect(callArgs.trigger).toBe('submit-message');
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('accumulates messages in conversation store', async () => {
    const handler = vi.fn().mockImplementation(() =>
      Promise.resolve(makeAssistantStream('Response')),
    );

    subscribeToChannel({ channel, handler });

    // First message
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'First'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Second message
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S2',
      data: JSON.stringify({
        message: makeUserMessage('msg-2', 'Second'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(2);
    const secondCallArgs = handler.mock.calls[1][0];
    expect(secondCallArgs.messages).toHaveLength(2);
    expect(secondCallArgs.messages[0].id).toBe('msg-1');
    expect(secondCallArgs.messages[1].id).toBe('msg-2');
  });

  it('deduplicates messages with the same ID', async () => {
    const handler = vi.fn().mockImplementation(() =>
      Promise.resolve(makeAssistantStream('Response')),
    );

    subscribeToChannel({ channel, handler });

    const userMsg = makeUserMessage('msg-1', 'Hello');

    // Send same message twice
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({ message: userMsg }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S2',
      data: JSON.stringify({ message: userMsg }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Second call should still have only 1 message (deduped)
    const secondCallArgs = handler.mock.calls[1][0];
    expect(secondCallArgs.messages).toHaveLength(1);
  });

  it('handles regenerate by truncating messages', async () => {
    const handler = vi.fn().mockImplementation(() =>
      Promise.resolve(makeAssistantStream('Response')),
    );

    subscribeToChannel({ channel, handler });

    // Seed conversation with user + assistant messages
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'Hello'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Now send regenerate
    channel.simulateMessage({
      name: 'regenerate',
      action: 'message.create',
      serial: 'S2',
      data: JSON.stringify({}),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(2);
    const regenCallArgs = handler.mock.calls[1][0];
    expect(regenCallArgs.trigger).toBe('regenerate-message');
    // Messages should still contain msg-1 (no assistant to remove)
    expect(regenCallArgs.messages).toHaveLength(1);
  });

  it('handles user-abort by aborting in-flight generation', async () => {
    let capturedSignal: AbortSignal | undefined;

    const handler = vi.fn().mockImplementation(({ abortSignal }) => {
      capturedSignal = abortSignal;
      // Return a stream that won't complete immediately
      return new Promise<ReadableStream<UIMessageChunk>>((resolve) => {
        setTimeout(() => resolve(makeAssistantStream('Response')), 200);
      });
    });

    subscribeToChannel({ channel, handler });

    // Send a chat message
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'Hello'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Send user-abort
    channel.simulateMessage({
      name: 'user-abort',
      action: 'message.create',
      serial: 'S2',
      data: JSON.stringify({}),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('skips messages without role: user header', async () => {
    const handler = vi.fn().mockResolvedValue(makeAssistantStream('Hi'));

    subscribeToChannel({ channel, handler });

    // Simulate an assistant echo message (role: 'assistant')
    channel.simulateMessage({
      name: 'text:t0',
      action: 'message.create',
      serial: 'S1',
      data: '',
      extras: { headers: { role: 'assistant' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Handler should not have been called
    expect(handler).not.toHaveBeenCalled();
  });

  it('cleanup function unsubscribes and aborts in-flight', async () => {
    let capturedSignal: AbortSignal | undefined;

    const handler = vi.fn().mockImplementation(({ abortSignal }) => {
      capturedSignal = abortSignal;
      return new Promise<ReadableStream<UIMessageChunk>>((resolve) => {
        setTimeout(() => resolve(makeAssistantStream('Response')), 500);
      });
    });

    const cleanup = await subscribeToChannel({ channel, handler });

    // Start a generation
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'Hello'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 20));

    // Cleanup
    cleanup();

    expect(capturedSignal!.aborted).toBe(true);
    // Listeners should be cleared
    expect(channel.listeners).toHaveLength(0);
  });

  it('seeds conversation with initialMessages', async () => {
    const handler = vi.fn().mockResolvedValue(makeAssistantStream('Response'));

    const initial = [
      makeUserMessage('init-1', 'Preloaded message'),
    ];

    subscribeToChannel({ channel, handler, initialMessages: initial });

    // Send a new message
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'Hello'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledOnce();
    const callArgs = handler.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0].id).toBe('init-1');
    expect(callArgs.messages[1].id).toBe('msg-1');
  });

  it('deduplicates history against initialMessages', async () => {
    const handler = vi.fn().mockResolvedValue(makeAssistantStream('Response'));

    const initial = [
      makeUserMessage('hist-1', 'Old message'),
    ];

    // Pre-populate history with the same message ID
    (channel as any).publishedMessages.push(
      {
        name: 'chat-message',
        data: JSON.stringify({
          message: makeUserMessage('hist-1', 'Old message'),
          chatId: 'chat-1',
        }),
        serial: 'H1',
        action: 'message.create',
        id: 'H1',
        timestamp: Date.now(),
        version: { serial: 'H1', timestamp: Date.now() },
        annotations: { summary: {} },
      },
      {
        name: 'finish',
        data: '{"finishReason":"stop"}',
        serial: 'H2',
        action: 'message.create',
        id: 'H2',
        timestamp: Date.now(),
        version: { serial: 'H2', timestamp: Date.now() },
        annotations: { summary: {} },
      },
    );

    subscribeToChannel({ channel, handler, initialMessages: initial });

    // Wait for history seeding
    await new Promise((r) => setTimeout(r, 50));

    // Send a new message
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'New message'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledOnce();
    const callArgs = handler.mock.calls[0][0];
    // Should have init-1 (from initialMessages) + msg-1 (new), NOT a duplicate hist-1
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0].id).toBe('hist-1');
    expect(callArgs.messages[1].id).toBe('msg-1');
  });

  it('seeds conversation from channel history on attach', async () => {
    const handler = vi.fn().mockResolvedValue(makeAssistantStream('Response'));

    // Pre-populate history via the mock channel
    (channel as any).publishedMessages.push(
      {
        name: 'chat-message',
        data: JSON.stringify({
          message: makeUserMessage('hist-1', 'Old message'),
          chatId: 'chat-1',
        }),
        serial: 'H1',
        action: 'message.create',
        id: 'H1',
        timestamp: Date.now(),
        version: { serial: 'H1', timestamp: Date.now() },
        annotations: { summary: {} },
      },
      {
        name: 'text:t0',
        data: 'Old response',
        serial: 'H2',
        action: 'message.create',
        id: 'H2',
        timestamp: Date.now(),
        version: { serial: 'H2', timestamp: Date.now() },
        annotations: { summary: {} },
      },
      {
        name: 'finish',
        data: '{"finishReason":"stop"}',
        serial: 'H3',
        action: 'message.create',
        id: 'H3',
        timestamp: Date.now(),
        version: { serial: 'H3', timestamp: Date.now() },
        annotations: { summary: {} },
      },
    );

    subscribeToChannel({ channel, handler });

    // Wait for subscribe + history seeding
    await new Promise((r) => setTimeout(r, 50));

    // Now send a new message — handler should see the seeded history + new message
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'New message'),
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledOnce();
    const callArgs = handler.mock.calls[0][0];
    // Should have seeded user + assistant + new user = 3 messages
    expect(callArgs.messages).toHaveLength(3);
    expect(callArgs.messages[0].role).toBe('user');
    expect(callArgs.messages[0].id).toBe('hist-1');
    expect(callArgs.messages[1].role).toBe('assistant');
    expect(callArgs.messages[2].role).toBe('user');
    expect(callArgs.messages[2].id).toBe('msg-1');
  });
});
