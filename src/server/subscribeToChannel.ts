import type * as Ably from 'ably';
import type { UIMessage, UIMessageChunk } from 'ai';
import { readUIMessageStream } from 'ai';
import { reconstructMessages } from '../shared';
import { publishToAbly } from './publishToAbly';

export interface SubscribeToChannelOptions {
  channel: Ably.RealtimeChannel;
  handler: (options: {
    messages: UIMessage[];
    trigger: 'submit-message' | 'regenerate-message';
    abortSignal: AbortSignal;
  }) => Promise<ReadableStream<UIMessageChunk>>;
  /** Maximum number of history messages to fetch when seeding the conversation. Defaults to 100. */
  historyLimit?: number;
  /** Messages to seed the conversation with before history is loaded. */
  initialMessages?: UIMessage[];
}

export async function subscribeToChannel(options: SubscribeToChannelOptions): Promise<() => void> {
  const { channel, handler, historyLimit = 100, initialMessages = [] } = options;

  /** Single conversation state for this channel. */
  const messages: UIMessage[] = [...initialMessages];

  /** In-flight generation: abort controller + publish promise. */
  let inflight: { controller: AbortController; done: Promise<void> } | null = null;

  const handleChatMessage = async (message: Ably.InboundMessage) => {
    const { message: userMessage } = JSON.parse(message.data as string) as {
      message: UIMessage;
    };
    messages.push(userMessage);

    if (inflight) {
      inflight.controller.abort();
      await inflight.done.catch(() => {});
    }

    const promptId = message.extras?.headers?.promptId as string | undefined;
    const abortController = new AbortController();

    const publishPromise = (async () => {
      const stream = await handler({
        messages: [...messages],
        trigger: 'submit-message',
        abortSignal: abortController.signal,
      });

      const chunks = await publishToAbly({
        channel,
        stream,
        abortSignal: abortController.signal,
        promptId,
      });

      const assistantMessages = await accumulateMessages(chunks);
      messages.push(...assistantMessages.filter((m) => m.parts.length > 0));
    })();

    inflight = { controller: abortController, done: publishPromise };

    try {
      await publishPromise;
    } finally {
      if (inflight?.done === publishPromise) {
        inflight = null;
      }
    }
  };

  const handleRegenerate = async (message: Ably.InboundMessage) => {
    const { messageId } = JSON.parse(message.data as string) as {
      messageId?: string;
    };

    // Remove the last assistant message (or the one identified by messageId)
    if (messageId) {
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        messages.splice(idx);
      }
    } else {
      // Remove from the last assistant message onward
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          messages.splice(i);
          break;
        }
      }
    }

    // Abort and await any in-flight generation
    if (inflight) {
      inflight.controller.abort();
      await inflight.done.catch(() => {});
    }

    const promptId = message.extras?.headers?.promptId as string | undefined;
    const abortController = new AbortController();

    const publishPromise = (async () => {
      const stream = await handler({
        messages: [...messages],
        trigger: 'regenerate-message',
        abortSignal: abortController.signal,
      });

      const chunks = await publishToAbly({
        channel,
        stream,
        abortSignal: abortController.signal,
        promptId,
      });

      const assistantMessages = await accumulateMessages(chunks);
      messages.push(...assistantMessages.filter((m) => m.parts.length > 0));
    })();

    inflight = { controller: abortController, done: publishPromise };

    try {
      await publishPromise;
    } finally {
      if (inflight?.done === publishPromise) {
        inflight = null;
      }
    }
  };

  const handleAbort = () => {
    console.log('Abort signal received from client');
    inflight?.controller.abort();
  };

  // Subscribe to client events — filter by role header to skip our own echoes.
  // channel.subscribe() resolves once attached, then we seed from history.
  await channel.subscribe((message: Ably.InboundMessage) => {
    // Only process client-published messages (role: "user")
    const role = message.extras?.headers?.role;
    if (role !== 'user') return;
    console.log('Prompt received from client:', JSON.stringify(message));
    console.log('Current conversation state messages before processing this prompt:');
    for (const msg of messages) {
      console.log('    - ', JSON.stringify(msg));
    }

    switch (message.name) {
      case 'chat-message':
        handleChatMessage(message).catch((err) => {
          console.error('Error handling chat-message:', err);
        });
        break;
      case 'regenerate':
        handleRegenerate(message).catch((err) => {
          console.error('Error handling regenerate:', err);
        });
        break;
      case 'user-abort':
        handleAbort();
        break;
    }
  }).then(async () => {
    // Channel is now attached — seed conversation from history.
    // Ably throws when the channel has no history (empty response body),
    // so we catch and treat it as an empty result.
    let items: Ably.InboundMessage[];
    try {
      const result = await channel.history({ untilAttach: true, limit: historyLimit });
      items = result.items;
    } catch {
      return; // No history to seed
    }
    if (items.length === 0) return;

    // History returns newest-first; reverse to chronological
    const chronological = [...items].reverse();
    const seeded = reconstructMessages(chronological);

    // Dedup against initialMessages
    const existingIds = new Set(messages.map((m) => m.id));
    messages.push(...seeded.filter((m) => !existingIds.has(m.id)));
  });

  // Return cleanup function
  return () => {
    channel.unsubscribe();
    if (inflight) {
      inflight.controller.abort();
      inflight = null;
    }
  };
}

/** Replay collected chunks through readUIMessageStream to build UIMessages. */
async function accumulateMessages(chunks: UIMessageChunk[]): Promise<UIMessage[]> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const messages: UIMessage[] = []
  for await (const msg of readUIMessageStream({ stream })) {
      messages.push(msg);
  }
  return messages
}

