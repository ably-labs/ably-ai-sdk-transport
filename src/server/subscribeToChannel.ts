import type * as Ably from 'ably';
import type { UIMessage, UIMessageChunk } from 'ai';
import { readUIMessageStream } from 'ai';
import { reconstructMessages } from '../shared';
import { publishToAbly } from './publishToAbly';
import { noopLogger } from '../logger';
import type { Logger } from '../logger';

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
  /**
   * If provided, enter presence on the channel so clients can detect the agent is online.
   * Uses `enterClient` (suitable for API-key auth without a connection-level clientId).
   */
  presence?: {
    /** The clientId to enter presence with. Defaults to `'agent'`. */
    clientId?: string;
    /** Additional data to merge with `{ type: 'agent' }`. */
    data?: Record<string, unknown>;
  };
  logger?: Logger;
}

export async function subscribeToChannel(
  options: SubscribeToChannelOptions,
): Promise<() => Promise<void>> {
  const {
    channel,
    handler,
    historyLimit = 100,
    initialMessages = [],
    presence,
    logger = noopLogger,
  } = options;

  /** Single conversation state for this channel. */
  const messages: UIMessage[] = [...initialMessages];

  /** In-flight generation: abort controller + publish promise. */
  let inflight: { controller: AbortController; done: Promise<void> } | null = null;

  // Gate message handling until history is seeded to avoid processing messages
  // with incomplete conversation state.
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  const handleChatMessage = async (message: Ably.InboundMessage) => {
    await ready;

    if (inflight) {
      logger.debug('Aborting in-flight generation due to new chat message');
      inflight.controller.abort();
      await inflight.done.catch(() => {});
    }

    const { message: userMessage } = JSON.parse(message.data as string) as {
      message: UIMessage;
    };

    const promptId = message.extras?.headers?.promptId as string | undefined;
    const abortController = new AbortController();
    const messageCountBefore = messages.length;

    // Push user message before calling handler so it's included in the snapshot
    messages.push(userMessage);

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
        logger,
      });

      const assistantMessages = await accumulateMessages(chunks);
      messages.push(...assistantMessages);
    })();

    inflight = { controller: abortController, done: publishPromise };

    try {
      await publishPromise;
    } catch (err) {
      // Roll back to pre-message state so conversation isn't left inconsistent
      messages.length = messageCountBefore;
      throw err;
    } finally {
      if (inflight?.done === publishPromise) {
        inflight = null;
      }
    }
  };

  const handleRegenerate = async (message: Ably.InboundMessage) => {
    await ready;

    const { messageId } = JSON.parse(message.data as string) as {
      messageId?: string;
    };

    // Snapshot for rollback on failure
    const snapshot = [...messages];

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
        logger,
      });

      const assistantMessages = await accumulateMessages(chunks);
      messages.push(...assistantMessages.filter((m) => m.parts.length > 0));
    })();

    inflight = { controller: abortController, done: publishPromise };

    try {
      await publishPromise;
    } catch (err) {
      // Roll back to pre-regenerate state
      messages.length = 0;
      messages.push(...snapshot);
      throw err;
    } finally {
      if (inflight?.done === publishPromise) {
        inflight = null;
      }
    }
  };

  const handleAbort = () => {
    logger.debug('Abort signal received from client');
    inflight?.controller.abort();
  };

  // Subscribe to client events — filter by role header to skip our own echoes.
  await channel.subscribe((message: Ably.InboundMessage) => {
    // Only process client-published messages (role: "user")
    const role = message.extras?.headers?.role;
    if (role !== 'user') return;
    logger.debug('Conversation state:', messages.length, 'messages');
    logger.debug('Prompt received:', message.name, message.extras?.headers?.promptId);

    switch (message.name) {
      case 'chat-message':
        handleChatMessage(message).catch((err) => {
          logger.error('Error handling chat-message:', err);
        });
        break;
      case 'regenerate':
        handleRegenerate(message).catch((err) => {
          logger.error('Error handling regenerate:', err);
        });
        break;
      case 'user-abort':
        handleAbort();
        break;
    }
  });

  // Channel is now attached — seed conversation from history before unblocking
  // message handling. This prevents processing messages with incomplete state.
  try {
    const result = await channel.history({ untilAttach: true, limit: historyLimit });
    const items = result.items;
    if (items.length > 0) {
      const chronological = [...items].reverse();
      const seeded = reconstructMessages(chronological);
      const existingIds = new Set(messages.map((m) => m.id));
      messages.push(...seeded.filter((m) => !existingIds.has(m.id)));
    }
  } catch (err) {
    logger.warn('Failed to load channel history for seeding:', err);
  } finally {
    resolveReady!();
  }

  // Enter presence if configured (channel is attached after subscribe resolves)
  const presenceClientId = presence?.clientId ?? 'agent';
  const presenceData = presence ? { type: 'agent', ...presence.data } : undefined;
  if (presence) {
    await channel.presence.enterClient(presenceClientId, presenceData);
  }

  // Return async cleanup function that waits for in-flight generation to finish
  return async () => {
    channel.unsubscribe();
    if (presence) {
      channel.presence.leaveClient(presenceClientId, presenceData).catch(() => {});
    }
    if (inflight) {
      inflight.controller.abort();
      await inflight.done.catch(() => {});
      inflight = null;
    }
  };
}

async function accumulateMessages(chunks: UIMessageChunk[]): Promise<UIMessage[]> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  const byId = new Map<string, UIMessage>();
  for await (const msg of readUIMessageStream({ stream })) {
    byId.set(msg.id, msg);
  }

  return Array.from(byId.values());
}
