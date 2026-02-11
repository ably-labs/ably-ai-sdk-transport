import type * as Ably from 'ably';
import type {
  ChatTransport,
  UIMessage,
  UIMessageChunk,
  ChatRequestOptions,
} from 'ai';
import type { SerialTracker, HandlerContext } from './types';
import { createEnsureStarted, reconstructMessages, TERMINAL_NAMES } from './utils';
import { handleCreate } from './handlers/handleCreate';
import { handleAppend } from './handlers/handleAppend';
import { handleUpdate } from './handlers/handleUpdate';

/** Names of messages published by the client — used for echo filtering. */
const CLIENT_MESSAGE_NAMES = new Set(['chat-message', 'regenerate', 'user-abort']);

export interface AblyChatTransportOptions {
  ably: Ably.Realtime;
  channelName: string;
  historyLimit?: number;
}

export interface LoadChatHistoryResult {
  messages: UIMessage[];
  hasActiveStream: boolean;
}

/**
 * Simple async push/pull queue for buffering Ably messages.
 */
class MessageBuffer {
  private queue: Ably.InboundMessage[] = [];
  private resolver: ((msg: Ably.InboundMessage | null) => void) | null = null;

  push(msg: Ably.InboundMessage): void {
    if (this.resolver) {
      this.resolver(msg);
      this.resolver = null;
    } else {
      this.queue.push(msg);
    }
  }

  async pull(): Promise<Ably.InboundMessage | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  cancel(): void {
    if (this.resolver) {
      this.resolver(null);
      this.resolver = null;
    }
  }
}

export class AblyChatTransport implements ChatTransport<UIMessage> {
  private readonly channel: Ably.RealtimeChannel;
  private readonly buffer = new MessageBuffer();
  private readonly historyLimit: number;
  private readonly attached: Promise<unknown>;
  private readonly listener: (msg: Ably.InboundMessage) => void;
  private _hasActiveStream = false;
  private activeDrainCtx: HandlerContext | null = null;

  constructor(options: AblyChatTransportOptions) {
    this.historyLimit = options.historyLimit ?? 100;
    this.channel = options.ably.channels.get(options.channelName);
    this.listener = (msg: Ably.InboundMessage) => {
      if (msg.name && CLIENT_MESSAGE_NAMES.has(msg.name)) return;
      console.log('client received message', JSON.stringify(msg));
      this.buffer.push(msg);
    };
    // subscribe() returns a promise that resolves once the channel is attached
    this.attached = this.channel.subscribe(this.listener);
  }

  /**
   * Load chat history from the channel using `history({untilAttach:true})`.
   *
   * Returns reconstructed UIMessage[] and whether a stream is currently active.
   */
  async loadChatHistory(options?: { limit?: number }): Promise<LoadChatHistoryResult> {
    const limit = options?.limit ?? this.historyLimit;
    const empty: LoadChatHistoryResult = { messages: [], hasActiveStream: false };

    await this.attached;

    let items: Ably.InboundMessage[];
    try {
      const history = await this.channel.history({ untilAttach: true, limit });
      items = history.items;
    } catch {
      // Ably throws when the channel has no history (empty response body).
      this._hasActiveStream = false;
      return empty;
    }

    if (items.length === 0) {
      this._hasActiveStream = false;
      return empty;
    }

    // Check if stream is active: newest message is not terminal
    const newest = items[0]; // history returns newest-first
    const newestName = newest.name ?? '';
    const hasActiveStream = !TERMINAL_NAMES.has(newestName);
    this._hasActiveStream = hasActiveStream;

    // Sort chronologically by serial (history returns newest-first)
    const chronological = [...items].sort((a, b) => ((a.serial ?? '') > (b.serial ?? '') ? 1 : -1));
    console.log('loaded history', chronological)

    // Reconstruct UIMessage[]
    const messages = reconstructMessages(chronological);

    return { messages, hasActiveStream };
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
    const { trigger, messageId, messages, abortSignal } = options;
    const promptId = crypto.randomUUID();

    const extras = { headers: { role: 'user', promptId } };

    // Publish the trigger message
    if (trigger === 'submit-message') {
      await this.channel.publish({
        name: 'chat-message',
        data: JSON.stringify({
          message: messages[messages.length - 1],
        }),
        extras,
      });
    } else if (trigger === 'regenerate-message') {
      await this.channel.publish({
        name: 'regenerate',
        data: JSON.stringify({
          ...(messageId != null ? { messageId } : {}),
        }),
        extras,
      });
    }

    // Return a stream that drains the buffer until 'finish'
    return this.createDrainStream(abortSignal, promptId);
  }

  async reconnectToStream(
    _options: {
      chatId: string;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    if (!this._hasActiveStream && this.buffer.isEmpty) return null;
    this._hasActiveStream = false;
    return this.createDrainStream();
  }

  close(): void {
    this.activeDrainCtx = null;
    this.buffer.cancel();
    this.channel.unsubscribe(this.listener);
  }

  private createDrainStream(
    abortSignal?: AbortSignal,
    promptId?: string,
  ): ReadableStream<UIMessageChunk> {
    const channel = this.channel;

    // Cancel any previous active drain — use finish (not abort) to avoid
    // corrupting the AI SDK's internal response-tracking state.
    if (this.activeDrainCtx && !this.activeDrainCtx.closed) {
      const prev = this.activeDrainCtx;
      prev.closed = true;
      this.buffer.cancel(); // Unblock old drain's pending pull()
      try {
        if (prev.emitState.hasEmittedStepStart) {
          prev.controller.enqueue({ type: 'finish-step' });
        }
        if (prev.emitState.hasEmittedStart) {
          prev.controller.enqueue({ type: 'finish', finishReason: 'other' });
        }
        prev.controller.close();
      } catch { /* already closed */ }
    }

    const serialState = new Map<string, SerialTracker>();
    const emitState = { hasEmittedStart: false, hasEmittedStepStart: false };

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const ensureStarted = createEnsureStarted(controller, emitState);
        const ctx: HandlerContext = { controller, serialState, ensureStarted, emitState, closed: false };

        // Track this drain as the active one
        this.activeDrainCtx = ctx;

        abortSignal?.addEventListener('abort', () => {
          if (ctx.closed) return;
          channel.publish({
            name: 'user-abort',
            extras: { headers: { role: 'user', ...(promptId ? { promptId } : {}) } },
          });
        });

        // Async drain loop
        const drain = async () => {
          while (!ctx.closed) {
            const msg = await this.buffer.pull();
            if (msg === null) {
              // Buffer was cancelled (e.g. transport.close())
              if (!ctx.closed) {
                ctx.closed = true;
                try { controller.close(); } catch { /* already closed */ }
              }
              break;
            }

            // Filter by promptId: skip messages from a different prompt
            const msgPromptId = msg.extras?.headers?.promptId;
            if (promptId && msgPromptId && msgPromptId !== promptId) {
              continue;
            }

            try {
              this.routeMessage(msg, ctx);
            } catch (err) {
              if (ctx.closed) return;
              ctx.closed = true;
              controller.enqueue({
                type: 'error',
                errorText:
                  err instanceof Error ? err.message : 'Unknown transport error',
              });
              controller.close();
            }
          }
        };
        drain();
      },

      cancel: () => {
        this.buffer.cancel(); // unblock pending pull
      },
    });
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
