import type * as Ably from 'ably';
import type { UIMessage, UIMessageChunk } from 'ai';
import { publishToAbly } from './publishToAbly.js';

export interface SubscribeToChannelOptions {
  channel: Ably.RealtimeChannel;
  handler: (options: {
    messages: UIMessage[];
    trigger: 'submit-message' | 'regenerate-message';
    chatId: string;
    abortSignal: AbortSignal;
  }) => Promise<ReadableStream<UIMessageChunk>>;
}

export function subscribeToChannel(options: SubscribeToChannelOptions): () => void {
  const { channel, handler } = options;

  /** Conversation store: chatId → UIMessage[] */
  const conversations = new Map<string, UIMessage[]>();

  /** In-flight generation abort controllers: chatId → AbortController */
  const inflight = new Map<string, AbortController>();

  const handleChatMessage = async (message: Ably.InboundMessage) => {
    const { message: userMessage, chatId } = JSON.parse(message.data as string) as {
      message: UIMessage;
      chatId: string;
    };

    // Get or create conversation
    let messages = conversations.get(chatId);
    if (!messages) {
      messages = [];
      conversations.set(chatId, messages);
    }

    // Dedup by message ID
    if (!messages.some((m) => m.id === userMessage.id)) {
      messages.push(userMessage);
    }

    // Abort any in-flight generation for this chat
    inflight.get(chatId)?.abort();

    const abortController = new AbortController();
    inflight.set(chatId, abortController);

    try {
      const stream = await handler({
        messages: [...messages],
        trigger: 'submit-message',
        chatId,
        abortSignal: abortController.signal,
      });

      await publishToAbly({
        channel,
        stream,
        abortSignal: abortController.signal,
      });
    } finally {
      // Only clean up if this is still the current controller
      if (inflight.get(chatId) === abortController) {
        inflight.delete(chatId);
      }
    }
  };

  const handleRegenerate = async (message: Ably.InboundMessage) => {
    const { chatId, messageId } = JSON.parse(message.data as string) as {
      chatId: string;
      messageId?: string;
    };

    const messages = conversations.get(chatId);
    if (!messages) return;

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

    // Abort any in-flight generation for this chat
    inflight.get(chatId)?.abort();

    const abortController = new AbortController();
    inflight.set(chatId, abortController);

    try {
      const stream = await handler({
        messages: [...messages],
        trigger: 'regenerate-message',
        chatId,
        abortSignal: abortController.signal,
      });

      await publishToAbly({
        channel,
        stream,
        abortSignal: abortController.signal,
      });
    } finally {
      if (inflight.get(chatId) === abortController) {
        inflight.delete(chatId);
      }
    }
  };

  const handleAbort = (message: Ably.InboundMessage) => {
    const { chatId } = JSON.parse(message.data as string) as { chatId: string };
    const controller = inflight.get(chatId);
    if (controller) {
      controller.abort();
      inflight.delete(chatId);
    }
  };

  // Subscribe to client events — filter by role header to skip our own echoes
  channel.subscribe((message: Ably.InboundMessage) => {
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
        handleAbort(message);
        break;
    }
  });

  // Return cleanup function
  return () => {
    channel.unsubscribe();
    for (const controller of inflight.values()) {
      controller.abort();
    }
    inflight.clear();
    conversations.clear();
  };
}
