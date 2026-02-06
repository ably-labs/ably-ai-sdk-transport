import type * as Ably from 'ably';
import type { UIMessageChunk } from 'ai';

export interface PublishToAblyOptions {
  channel: Ably.RealtimeChannel;
  stream: ReadableStream<UIMessageChunk>;
  abortSignal?: AbortSignal;
}

interface SerialState {
  serial: string;
  type: 'text' | 'reasoning' | 'tool-input';
}

export async function publishToAbly(options: PublishToAblyOptions): Promise<void> {
  const { channel, stream, abortSignal } = options;

  const serials = new Map<string, SerialState>();

  const reader = stream.getReader();

  try {
    while (true) {
      if (abortSignal?.aborted) {
        await channel.publish({ name: 'abort', data: '{}' });
        break;
      }

      const { done, value: chunk } = await reader.read();
      if (done) break;

      switch (chunk.type) {
        // ── Lifecycle ─────────────────────────────────
        case 'start': {
          // Client synthesizes 'start' — nothing to publish
          break;
        }

        case 'start-step': {
          // Client synthesizes all step-starts — nothing to publish
          break;
        }

        case 'finish-step': {
          await channel.publish({ name: 'step-finish', data: '{}' });
          break;
        }

        case 'finish': {
          await channel.publish({
            name: 'finish',
            data: JSON.stringify({
              finishReason: chunk.finishReason ?? 'stop',
              ...(chunk.messageMetadata != null
                ? { messageMetadata: chunk.messageMetadata }
                : {}),
            }),
          });
          break;
        }

        case 'abort': {
          await channel.publish({
            name: 'abort',
            data: '{}',
          });
          break;
        }

        case 'error': {
          await channel.publish({
            name: 'error',
            data: JSON.stringify({ errorText: chunk.errorText }),
          });
          break;
        }

        case 'message-metadata': {
          await channel.publish({
            name: 'metadata',
            data: JSON.stringify({
              messageMetadata: chunk.messageMetadata,
            }),
          });
          break;
        }

        // ── Text streaming ────────────────────────────
        case 'text-start': {
          const result = await channel.publish({
            name: `text:${chunk.id}`,
            data: '',
          });
          serials.set(chunk.id, {
            serial: result.serials[0]!,
            type: 'text',
          });
          break;
        }

        case 'text-delta': {
          const state = serials.get(chunk.id);
          if (!state) throw new Error(`No serial for text ${chunk.id}`);
          // Pipelined — not awaited
          channel.appendMessage(
            { serial: state.serial, data: chunk.delta },
            { metadata: { event: 'text-delta' } },
          );
          break;
        }

        case 'text-end': {
          const state = serials.get(chunk.id);
          if (!state) throw new Error(`No serial for text ${chunk.id}`);
          channel.appendMessage(
            { serial: state.serial, data: '' },
            { metadata: { event: 'text-end' } },
          );
          serials.delete(chunk.id);
          break;
        }

        // ── Reasoning streaming ───────────────────────
        case 'reasoning-start': {
          const result = await channel.publish({
            name: `reasoning:${chunk.id}`,
            data: '',
          });
          serials.set(chunk.id, {
            serial: result.serials[0]!,
            type: 'reasoning',
          });
          break;
        }

        case 'reasoning-delta': {
          const state = serials.get(chunk.id);
          if (!state) throw new Error(`No serial for reasoning ${chunk.id}`);
          channel.appendMessage(
            { serial: state.serial, data: chunk.delta },
            { metadata: { event: 'reasoning-delta' } },
          );
          break;
        }

        case 'reasoning-end': {
          const state = serials.get(chunk.id);
          if (!state) throw new Error(`No serial for reasoning ${chunk.id}`);
          channel.appendMessage(
            { serial: state.serial, data: '' },
            { metadata: { event: 'reasoning-end' } },
          );
          serials.delete(chunk.id);
          break;
        }

        // ── Tool lifecycle ────────────────────────────
        case 'tool-input-start': {
          const result = await channel.publish({
            name: `tool:${chunk.toolCallId}:${chunk.toolName}`,
            data: '',
          });
          serials.set(chunk.toolCallId, {
            serial: result.serials[0]!,
            type: 'tool-input',
          });
          break;
        }

        case 'tool-input-delta': {
          const state = serials.get(chunk.toolCallId);
          if (!state)
            throw new Error(`No serial for tool ${chunk.toolCallId}`);
          channel.appendMessage(
            { serial: state.serial, data: chunk.inputTextDelta },
            { metadata: { event: 'tool-input-delta' } },
          );
          break;
        }

        case 'tool-input-available': {
          const state = serials.get(chunk.toolCallId);
          if (state) {
            // Streaming tool call: send end signal
            channel.appendMessage(
              { serial: state.serial, data: '' },
              { metadata: { event: 'tool-input-end' } },
            );
          } else {
            // Non-streaming tool call: publish full input
            const result = await channel.publish({
              name: `tool:${chunk.toolCallId}:${chunk.toolName}`,
              data: JSON.stringify(chunk.input),
              extras: {
                headers: { event: 'tool-input-available' },
              },
            });
            serials.set(chunk.toolCallId, {
              serial: result.serials[0]!,
              type: 'tool-input',
            });
          }
          break;
        }

        case 'tool-output-available': {
          const state = serials.get(chunk.toolCallId);
          if (!state)
            throw new Error(`No serial for tool ${chunk.toolCallId}`);
          await channel.updateMessage({
            serial: state.serial,
            name: `tool-output:${chunk.toolCallId}`,
            data: JSON.stringify({ output: chunk.output }),
          });
          break;
        }

        case 'tool-output-error': {
          const state = serials.get(chunk.toolCallId);
          if (!state)
            throw new Error(`No serial for tool ${chunk.toolCallId}`);
          await channel.updateMessage({
            serial: state.serial,
            name: `tool-error:${chunk.toolCallId}`,
            data: JSON.stringify({ errorText: chunk.errorText }),
          });
          break;
        }

        case 'tool-input-error': {
          const state = serials.get(chunk.toolCallId);
          if (state) {
            await channel.updateMessage({
              serial: state.serial,
              name: `tool-error:${chunk.toolCallId}`,
              data: JSON.stringify({ errorText: chunk.errorText }),
            });
          }
          break;
        }

        // ── Discrete events ───────────────────────────
        case 'file': {
          await channel.publish({
            name: 'file',
            data: JSON.stringify({
              url: chunk.url,
              mediaType: chunk.mediaType,
            }),
          });
          break;
        }

        case 'source-url': {
          await channel.publish({
            name: 'source-url',
            data: JSON.stringify({
              sourceId: chunk.sourceId,
              url: chunk.url,
              ...(chunk.title != null ? { title: chunk.title } : {}),
            }),
          });
          break;
        }

        case 'source-document': {
          await channel.publish({
            name: 'source-document',
            data: JSON.stringify({
              sourceId: chunk.sourceId,
              mediaType: chunk.mediaType,
              title: chunk.title,
              ...(chunk.filename != null
                ? { filename: chunk.filename }
                : {}),
            }),
          });
          break;
        }

        default: {
          // Handle data-* chunks
          const chunkType = (chunk as { type: string }).type;
          if (chunkType.startsWith('data-')) {
            const dataChunk = chunk as {
              type: string;
              data: unknown;
              id?: string;
              transient?: boolean;
            };
            await channel.publish({
              name: dataChunk.type,
              data: JSON.stringify({
                data: dataChunk.data,
                ...(dataChunk.id != null ? { id: dataChunk.id } : {}),
              }),
              ...(dataChunk.transient
                ? { extras: { ephemeral: true } }
                : {}),
            });
          }
          break;
        }
      }
    }
  } catch (err) {
    const errorText = err instanceof Error ? err.message : 'Unknown stream error';
    await channel.publish({
      name: 'error',
      data: JSON.stringify({ errorText }),
    });
    throw err;
  } finally {
    reader.releaseLock();
  }
}
