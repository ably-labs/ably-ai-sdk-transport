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
      data: JSON.stringify({ message: userMsg, chatId: 'chat-1' }),
      extras: { headers: { role: 'user' } },
    });

    // Wait for async handler to be called
    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledOnce();
    const callArgs = handler.mock.calls[0][0];
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].id).toBe('msg-1');
    expect(callArgs.trigger).toBe('submit-message');
    expect(callArgs.chatId).toBe('chat-1');
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
        chatId: 'chat-1',
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
        chatId: 'chat-1',
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
      data: JSON.stringify({ message: userMsg, chatId: 'chat-1' }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S2',
      data: JSON.stringify({ message: userMsg, chatId: 'chat-1' }),
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
        chatId: 'chat-1',
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Now send regenerate
    channel.simulateMessage({
      name: 'regenerate',
      action: 'message.create',
      serial: 'S2',
      data: JSON.stringify({ chatId: 'chat-1' }),
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
        chatId: 'chat-1',
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
      data: JSON.stringify({ chatId: 'chat-1' }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('isolates conversations by chatId', async () => {
    const handler = vi.fn().mockImplementation(() =>
      Promise.resolve(makeAssistantStream('Response')),
    );

    subscribeToChannel({ channel, handler });

    // Message to chat-1
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'Hello from chat 1'),
        chatId: 'chat-1',
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    // Message to chat-2
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S2',
      data: JSON.stringify({
        message: makeUserMessage('msg-2', 'Hello from chat 2'),
        chatId: 'chat-2',
      }),
      extras: { headers: { role: 'user' } },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handler).toHaveBeenCalledTimes(2);
    // chat-1 should have 1 message
    expect(handler.mock.calls[0][0].messages).toHaveLength(1);
    expect(handler.mock.calls[0][0].chatId).toBe('chat-1');
    // chat-2 should have 1 message (separate store)
    expect(handler.mock.calls[1][0].messages).toHaveLength(1);
    expect(handler.mock.calls[1][0].chatId).toBe('chat-2');
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

    const cleanup = subscribeToChannel({ channel, handler });

    // Start a generation
    channel.simulateMessage({
      name: 'chat-message',
      action: 'message.create',
      serial: 'S1',
      data: JSON.stringify({
        message: makeUserMessage('msg-1', 'Hello'),
        chatId: 'chat-1',
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
});
