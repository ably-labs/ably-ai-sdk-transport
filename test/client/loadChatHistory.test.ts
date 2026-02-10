import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AblyChatTransport } from '../../src/client/AblyChatTransport.js';
import {
  createMockAbly,
  createMockChannel,
  resetSerialCounter,
} from '../helpers/mockAbly.js';
import type * as Ably from 'ably';

function makeHistoryResult(items: Partial<Ably.InboundMessage>[]): Ably.PaginatedResult<Ably.InboundMessage> {
  const fullItems = items.map((item, i) => ({
    id: item.id ?? `id-${i}`,
    name: item.name ?? '',
    data: item.data ?? '',
    action: item.action ?? ('message.create' as const),
    serial: item.serial ?? `S${i}`,
    timestamp: item.timestamp ?? Date.now(),
    version: item.version ?? { serial: `v${i}`, timestamp: Date.now() },
    annotations: item.annotations ?? { summary: {} },
    ...item,
  })) as Ably.InboundMessage[];

  return {
    items: fullItems,
    hasNext: () => false,
    isLast: () => true,
    next: () => Promise.resolve(null as any),
    current: () => Promise.resolve({ items: fullItems } as any),
    first: () => Promise.resolve({ items: fullItems } as any),
  } as Ably.PaginatedResult<Ably.InboundMessage>;
}

describe('loadChatHistory', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let mockAbly: ReturnType<typeof createMockAbly>;
  let transport: AblyChatTransport;

  beforeEach(() => {
    resetSerialCounter();
    mockChannel = createMockChannel();
    mockAbly = createMockAbly(mockChannel);
    transport = new AblyChatTransport({
      ably: mockAbly,
      channelName: 'test-channel', // string → eager mode
    });
  });

  it('returns empty messages for empty history', async () => {
    (mockChannel as any).history = () => Promise.resolve(makeHistoryResult([]));

    const result = await transport.loadChatHistory();
    expect(result.messages).toEqual([]);
    expect(result.hasActiveStream).toBe(false);
  });

  it('reconstructs a single user message', async () => {
    // History is newest-first
    (mockChannel as any).history = () =>
      Promise.resolve(
        makeHistoryResult([
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hello' }],
              },
              chatId: 'chat-1',
            }),
          },
        ]),
      );

    const result = await transport.loadChatHistory();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].id).toBe('user-1');
    expect(result.messages[0].parts[0]).toEqual({ type: 'text', text: 'Hello' });
    // A lone user message with no terminal means the assistant response
    // may still be in-flight
    expect(result.hasActiveStream).toBe(true);
  });

  it('reconstructs user + completed assistant text', async () => {
    // History newest-first: finish, text:t0, chat-message
    (mockChannel as any).history = () =>
      Promise.resolve(
        makeHistoryResult([
          // Newest first
          {
            name: 'finish',
            data: '{"finishReason":"stop"}',
            serial: 'S3',
          },
          {
            name: 'text:t0',
            data: 'Hello there!',
            serial: 'S2',
          },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hi' }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S1',
          },
        ]),
      );

    const result = await transport.loadChatHistory();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].id).toBe('user-1');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].id).toBe('t0');
    expect(result.messages[1].parts).toEqual([
      { type: 'text', text: 'Hello there!' },
    ]);
    expect(result.hasActiveStream).toBe(false);
  });

  it('reconstructs multiple conversation turns', async () => {
    // Two user messages with two completed assistant responses
    (mockChannel as any).history = () =>
      Promise.resolve(
        makeHistoryResult([
          // Newest first
          { name: 'finish', data: '{"finishReason":"stop"}', serial: 'S6' },
          { name: 'text:t1', data: 'Fine thanks', serial: 'S5' },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-2',
                role: 'user',
                parts: [{ type: 'text', text: 'How are you?' }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S4',
          },
          { name: 'finish', data: '{"finishReason":"stop"}', serial: 'S3' },
          { name: 'text:t0', data: 'Hello!', serial: 'S2' },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hi' }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S1',
          },
        ]),
      );

    const result = await transport.loadChatHistory();
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toMatchObject({ role: 'user', id: 'user-1' });
    expect(result.messages[1]).toMatchObject({ role: 'assistant', id: 't0' });
    expect(result.messages[2]).toMatchObject({ role: 'user', id: 'user-2' });
    expect(result.messages[3]).toMatchObject({ role: 'assistant', id: 't1' });
    expect(result.hasActiveStream).toBe(false);
  });

  it('detects in-progress stream and drops trailing assistant', async () => {
    // Newest message is text (not terminal) → active stream
    (mockChannel as any).history = () =>
      Promise.resolve(
        makeHistoryResult([
          // Newest first — note: no 'finish' at the top
          { name: 'text:t0', data: 'Hello par', serial: 'S2' },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hi' }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S1',
          },
        ]),
      );

    const result = await transport.loadChatHistory();
    expect(result.hasActiveStream).toBe(true);
    // Trailing in-progress assistant is kept so AI SDK can reuse it during resumeStream
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('handles regenerate flow: removes original assistant', async () => {
    (mockChannel as any).history = () =>
      Promise.resolve(
        makeHistoryResult([
          // Newest first
          { name: 'finish', data: '{"finishReason":"stop"}', serial: 'S6' },
          { name: 'text:t1', data: 'Better answer', serial: 'S5' },
          { name: 'regenerate', data: '{"chatId":"chat-1"}', serial: 'S4' },
          { name: 'finish', data: '{"finishReason":"stop"}', serial: 'S3' },
          { name: 'text:t0', data: 'Bad answer', serial: 'S2' },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hi' }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S1',
          },
        ]),
      );

    const result = await transport.loadChatHistory();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ role: 'user', id: 'user-1' });
    // Should be the regenerated answer, not the original
    expect(result.messages[1]).toMatchObject({ role: 'assistant', id: 't1' });
    expect(result.messages[1].parts[0]).toEqual({ type: 'text', text: 'Better answer' });
  });

  it('handles tool call with output', async () => {
    (mockChannel as any).history = () =>
      Promise.resolve(
        makeHistoryResult([
          // Newest first
          { name: 'finish', data: '{"finishReason":"stop"}', serial: 'S5' },
          { name: 'text:t1', data: 'The weather is sunny.', serial: 'S4' },
          {
            name: 'tool-output:tool-1',
            data: JSON.stringify({ output: { temp: 72 } }),
            serial: 'S3',
          },
          {
            name: 'tool:tool-1:getWeather',
            data: JSON.stringify({ city: 'SF' }),
            serial: 'S2',
          },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: "What's the weather?" }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S1',
          },
        ]),
      );

    const result = await transport.loadChatHistory();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');

    const assistantParts = result.messages[1].parts;
    // Should have tool-invocation and text parts
    const toolPart = assistantParts.find((p) => p.type === 'tool-invocation');
    expect(toolPart).toBeDefined();
    expect(toolPart).toMatchObject({
      type: 'tool-invocation',
      toolInvocation: {
        state: 'result',
        toolCallId: 'tool-1',
        toolName: 'getWeather',
        args: { city: 'SF' },
        result: { temp: 72 },
      },
    });

    const textPart = assistantParts.find((p) => p.type === 'text');
    expect(textPart).toMatchObject({ type: 'text', text: 'The weather is sunny.' });
  });

  it('retains content-complete assistant when finish has not arrived', async () => {
    // Two turns: first is fully complete (has finish), second has text-end
    // version metadata and step-finish but no finish message yet.
    (mockChannel as any).history = () =>
      Promise.resolve(
        makeHistoryResult([
          // Newest first — no 'finish' at top → hasActiveStream = true
          { name: 'step-finish', data: '', serial: 'S7' },
          {
            name: 'text:t1',
            data: 'I am doing well!',
            serial: 'S6',
            version: {
              serial: 'v6',
              timestamp: Date.now(),
              metadata: { event: 'text-end' },
            },
          },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-2',
                role: 'user',
                parts: [{ type: 'text', text: 'How are you?' }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S5',
          },
          { name: 'finish', data: '{"finishReason":"stop"}', serial: 'S4' },
          { name: 'text:t0', data: 'Hello!', serial: 'S3' },
          {
            name: 'chat-message',
            data: JSON.stringify({
              message: {
                id: 'user-1',
                role: 'user',
                parts: [{ type: 'text', text: 'Hi' }],
              },
              chatId: 'chat-1',
            }),
            serial: 'S2',
          },
        ]),
      );

    const result = await transport.loadChatHistory();
    // Stream is active (no finish for second turn)
    expect(result.hasActiveStream).toBe(true);
    // All 4 messages retained because last assistant is content-complete
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toMatchObject({ role: 'user', id: 'user-1' });
    expect(result.messages[1]).toMatchObject({ role: 'assistant', id: 't0' });
    expect(result.messages[2]).toMatchObject({ role: 'user', id: 'user-2' });
    expect(result.messages[3]).toMatchObject({ role: 'assistant', id: 't1' });
    expect(result.messages[3].parts[0]).toEqual({ type: 'text', text: 'I am doing well!' });
    expect((result.messages[3].metadata as any)?.contentComplete).toBe(true);
  });

  it('passes limit parameter to channel.history()', async () => {
    const historySpy = vi.fn().mockResolvedValue(makeHistoryResult([]));
    (mockChannel as any).history = historySpy;

    await transport.loadChatHistory({ limit: 50 });

    expect(historySpy).toHaveBeenCalledWith({
      untilAttach: true,
      limit: 50,
    });
  });

  it('uses historyLimit as default limit', async () => {
    const customTransport = new AblyChatTransport({
      ably: mockAbly,
      channelName: 'test-channel',
      historyLimit: 200,
    });

    const historySpy = vi.fn().mockResolvedValue(makeHistoryResult([]));
    (mockChannel as any).history = historySpy;

    await customTransport.loadChatHistory();

    expect(historySpy).toHaveBeenCalledWith({
      untilAttach: true,
      limit: 200,
    });
  });
});
