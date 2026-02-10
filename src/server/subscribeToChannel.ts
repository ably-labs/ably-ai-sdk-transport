import type * as Ably from 'ably';
import type { UIMessage, UIMessageChunk } from 'ai';
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

  /** In-flight generation abort controller. */
  let inflight: AbortController | null = null;

  const handleChatMessage = async (message: Ably.InboundMessage) => {
    const { message: userMessage } = JSON.parse(message.data as string) as {
      message: UIMessage;
    };

    // Dedup by message ID
    if (!messages.some((m) => m.id === userMessage.id)) {
      messages.push(userMessage);
    }

    // Abort any in-flight generation
    inflight?.abort();

    const abortController = new AbortController();
    inflight = abortController;

    try {
      const stream = await handler({
        messages: [...messages],
        trigger: 'submit-message',
        abortSignal: abortController.signal,
      });

      await publishToAbly({
        channel,
        stream,
        abortSignal: abortController.signal,
      });
    } finally {
      if (inflight === abortController) {
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

    // Abort any in-flight generation
    inflight?.abort();

    const abortController = new AbortController();
    inflight = abortController;

    try {
      const stream = await handler({
        messages: [...messages],
        trigger: 'regenerate-message',
        abortSignal: abortController.signal,
      });

      await publishToAbly({
        channel,
        stream,
        abortSignal: abortController.signal,
      });
    } finally {
      if (inflight === abortController) {
        inflight = null;
      }
    }
  };

  const handleAbort = () => {
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
  };

  // Subscribe to client events — filter by role header to skip our own echoes.
  // channel.subscribe() resolves once attached, then we seed from history.
  await channel.subscribe((message: Ably.InboundMessage) => {
    // Only process client-published messages (role: "user")
    const role = message.extras?.headers?.role;
    if (role !== 'user') return;

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
    // Channel is now attached — seed conversation from history
    const result = await channel.history({ untilAttach: true, limit: historyLimit });
    // History returns newest-first; reverse to chronological
    const chronological = [...result.items].reverse();
    const seeded = reconstructMessages(chronological);
    // Dedup against initialMessages
    const existingIds = new Set(messages.map((m) => m.id));
    messages.push(...seeded.filter((m) => !existingIds.has(m.id)));
  }).catch((err) => {
    console.error('Error seeding conversation from history:', err);
  });

  // Return cleanup function
  return () => {
    channel.unsubscribe();
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
  };
}
