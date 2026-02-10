import type * as Ably from 'ably';
import type {
  ChatTransport,
  UIMessage,
  UIMessageChunk,
  ChatRequestOptions,
} from 'ai';
import type { SerialTracker, HandlerContext } from './types.js';
import { createEnsureStarted } from './utils.js';
import { handleCreate } from './handlers/handleCreate.js';
import { handleAppend } from './handlers/handleAppend.js';
import { handleUpdate } from './handlers/handleUpdate.js';
import { handleHistory } from './handlers/handleHistory.js';

/** Names of messages published by the client — used for echo filtering. */
const CLIENT_MESSAGE_NAMES = new Set(['chat-message', 'regenerate', 'user-abort']);

export interface AblyChatTransportOptions {
  ably: Ably.Realtime;
  channelName?: (chatId: string) => string;
  reconnectHistoryLimit?: number;
}

export class AblyChatTransport implements ChatTransport<UIMessage> {
  private readonly ably: Ably.Realtime;
  private readonly channelName: (chatId: string) => string;
  private readonly reconnectHistoryLimit: number;

  constructor(options: AblyChatTransportOptions) {
    this.ably = options.ably;
    this.channelName = options.channelName ?? ((chatId) => `ait:${chatId}`);
    this.reconnectHistoryLimit = options.reconnectHistoryLimit ?? 100;
  }

  async sendMessages(
    options: {
      trigger: 'submit-message' | 'regenerate-message';
      chatId: string;
      messageId: string | undefined;
      messages: UIMessage[];
      abortSignal: AbortSignal | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const { trigger, chatId, messageId, messages, abortSignal } = options;

    const channel = this.ably.channels.get(this.channelName(chatId));

    const serialState = new Map<string, SerialTracker>();
    const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };

    const extras = { headers: { role: 'user' } };

    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const ensureStarted = createEnsureStarted(controller, emitState);

        const ctx = { controller, serialState, ensureStarted, emitState, closed: false };

        channel.subscribe((message: Ably.InboundMessage) => {
          if (ctx.closed) return;
          // Echo filtering: skip messages published by the client
          if (message.name && CLIENT_MESSAGE_NAMES.has(message.name)) return;
          try {
            this.routeMessage(message, ctx);
          } catch (err) {
            if (ctx.closed) return;
            ctx.closed = true;
            controller.enqueue({
              type: 'error',
              errorText:
                err instanceof Error ? err.message : 'Unknown transport error',
            });
            controller.close();
            channel.unsubscribe();
          }
        });

        channel.on('failed', (stateChange: Ably.ChannelStateChange) => {
          if (ctx.closed) return;
          ctx.closed = true;
          controller.enqueue({
            type: 'error',
            errorText: `Channel error: ${stateChange.reason?.message ?? 'unknown'}`,
          });
          controller.close();
        });

        abortSignal?.addEventListener('abort', () => {
          if (ctx.closed) return;
          // Publish user-abort to notify the server, but don't close the stream
          // — the server may still send final messages.
          channel.publish({
            name: 'user-abort',
            data: JSON.stringify({ chatId }),
            extras,
          });
        });
      },

      cancel: () => {
        channel.unsubscribe();
        channel.detach();
      },
    });

    // Publish the trigger message via Ably channel (replacing the old HTTP POST)
    if (trigger === 'submit-message') {
      await channel.publish({
        name: 'chat-message',
        data: JSON.stringify({
          message: messages[messages.length - 1],
          chatId,
        }),
        extras,
      });
    } else if (trigger === 'regenerate-message') {
      await channel.publish({
        name: 'regenerate',
        data: JSON.stringify({
          chatId,
          ...(messageId != null ? { messageId } : {}),
        }),
        extras,
      });
    }

    return stream;
  }

  async reconnectToStream(
    options: {
      chatId: string;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const { chatId } = options;
    const channel = this.ably.channels.get(this.channelName(chatId));

    try {
      // Step 1: Subscribe first — buffer live messages while querying history
      const liveBuffer: Ably.InboundMessage[] = [];
      let replayingHistory = true;

      // These will be set in the stream's start() callback
      let ctx: HandlerContext;

      await channel.subscribe((message: Ably.InboundMessage) => {
        // Echo filtering: skip client-published messages
        if (message.name && CLIENT_MESSAGE_NAMES.has(message.name)) return;

        if (replayingHistory) {
          // If we are still replaying history, buffer live messages until
          // we have processed the history backlog
          liveBuffer.push(message);
        } else {
          if (ctx.closed) return;
          try {
            this.routeMessage(message, ctx);
          } catch (err) {
            if (ctx.closed) return;
            ctx.closed = true;
            ctx.controller.enqueue({
              type: 'error',
              errorText:
                err instanceof Error ? err.message : 'Unknown transport error',
            });
            ctx.controller.close();
            channel.unsubscribe();
          }
        }
      });

      // Step 2: Query history with untilAttach to align boundary with attach point
      const history = await channel.history({
        untilAttach: true,
        limit: this.reconnectHistoryLimit,
      });
      const historyMessages = history.items;

      if (historyMessages.length === 0) {
        channel.unsubscribe();
        channel.detach();
        return null;
      }

      // Check if the stream is complete
      const lastMsg = historyMessages[0]; // history is newest-first
      if (
        lastMsg.name === 'finish' ||
        lastMsg.name === 'error' ||
        lastMsg.name === 'abort'
      ) {
        channel.unsubscribe();
        channel.detach();
        return null;
      }

      // Create the stream
      const serialState = new Map<string, SerialTracker>();
      const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };

      return new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          const ensureStarted = createEnsureStarted(controller, emitState);
          ctx = { controller, serialState, ensureStarted, emitState, closed: false };

          // Replay history (oldest first)
          const oldest = [...historyMessages].reverse();
          for (const msg of oldest) {
            if (ctx.closed) return;
            handleHistory(msg, ctx);
          }

          // Flush buffered live messages (untilAttach guarantees no overlap)
          replayingHistory = false;
          for (const msg of liveBuffer) {
            if (ctx.closed) return;
            try {
              this.routeMessage(msg, ctx);
            } catch (err) {
              if (ctx.closed) return;
              ctx.closed = true;
              controller.enqueue({
                type: 'error',
                errorText:
                  err instanceof Error
                    ? err.message
                    : 'Unknown transport error',
              });
              controller.close();
              channel.unsubscribe();
              return;
            }
          }
          liveBuffer.length = 0;
        },

        cancel: () => {
          if (ctx) ctx.closed = true;
          channel.unsubscribe();
          channel.detach();
        },
      });
    } catch {
      channel.unsubscribe();
      channel.detach();
      return null;
    }
  }

  private routeMessage(
    message: Ably.InboundMessage,
    ctx: HandlerContext,
  ): void {
    const action = message.action;

    if (action === 'message.create') {
      handleCreate(message, ctx);
      return;
    }

    if (action === 'message.append') {
      handleAppend(message, ctx);
      return;
    }

    if (action === 'message.update') {
      handleUpdate(message, ctx);
      return;
    }
  }
}
