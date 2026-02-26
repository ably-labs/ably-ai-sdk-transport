import type * as Ably from 'ably';
import type { UIMessageChunk } from 'ai';
import { noopLogger } from '../logger';
import type { Logger } from '../logger';

export interface PublishToAblyOptions {
  channel: Ably.RealtimeChannel;
  stream: ReadableStream<UIMessageChunk>;
  abortSignal?: AbortSignal;
  promptId?: string;
  logger?: Logger;
}

interface SerialState {
  serial: string;
  type: 'text' | 'reasoning' | 'tool-input';
}

export async function publishToAbly(options: PublishToAblyOptions): Promise<UIMessageChunk[]> {
  const { channel, stream, abortSignal, promptId, logger = noopLogger } = options;

  const serials = new Map<string, SerialState>();
  const pendingAppends: Promise<unknown>[] = [];
  const extras = makeExtras(promptId);
  const chunks: UIMessageChunk[] = [];

  const reader = stream.getReader();
  let terminalPublished = false; // Terminal is a marker for the complete end of the stream: finish, error, or abort

  async function flushAppends() {
    await Promise.all(pendingAppends);
    pendingAppends.length = 0;
  }

  async function publishAbortSequence(reason?: string) {
    await flushAppends();

    if (!terminalPublished) {
      await channel.publish({
        name: 'abort',
        data: JSON.stringify(reason != null ? { reason } : {}),
        extras,
      });
    }
  }

  const onAbort = () => reader.cancel();
  if (abortSignal?.aborted) {
    reader.cancel();
  } else {
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
      logger.debug('Chunk:', chunk.type, chunk);

      switch (chunk.type) {
        // ── Lifecycle ─────────────────────────────────
        case 'start': {
          const startData: Record<string, unknown> = {};
          if (chunk.messageId != null) startData.messageId = chunk.messageId;
          if (chunk.messageMetadata != null) startData.messageMetadata = chunk.messageMetadata;
          if (Object.keys(startData).length > 0) {
            await channel.publish({
              name: 'start',
              data: JSON.stringify(startData),
              extras,
            });
          }
          break;
        }

        case 'start-step': {
          // Client synthesizes all step-starts — nothing to publish
          break;
        }

        case 'finish-step': {
          logger.debug(`[publish] finish-step — flushing ${pendingAppends.length} pending appends`);
          await flushAppends();
          await channel.publish({ name: 'step-finish', data: '{}', extras });
          break;
        }

        case 'finish': {
          logger.debug(`[publish] finish — flushing ${pendingAppends.length} pending appends`);
          await flushAppends();
          terminalPublished = true;
          await channel.publish({
            name: 'finish',
            data: JSON.stringify({
              finishReason: chunk.finishReason,
              ...(chunk.messageMetadata != null ? { messageMetadata: chunk.messageMetadata } : {}),
            }),
            extras,
          });
          break;
        }

        case 'abort': {
          await publishAbortSequence((chunk as any).reason);
          terminalPublished = true;
          break;
        }

        case 'error': {
          await flushAppends();
          terminalPublished = true;
          await channel.publish({
            name: 'error',
            data: JSON.stringify({ errorText: chunk.errorText }),
            extras,
          });
          break;
        }

        case 'message-metadata': {
          await channel.publish({
            name: 'metadata',
            data: JSON.stringify({
              messageMetadata: chunk.messageMetadata,
            }),
            extras,
          });
          break;
        }

        // ── Text streaming ────────────────────────────
        case 'text-start': {
          const uniqueId = crypto.randomUUID();
          const result = await channel.publish({
            name: `text:${uniqueId}`,
            data: '',
            extras: withOptionalHeaders(extras, {
              providerMetadata: (chunk as any).providerMetadata,
            }),
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
          pendingAppends.push(
            channel.appendMessage(
              {
                serial: state.serial,
                data: chunk.delta,
                extras: withOptionalHeaders(extras, {
                  providerMetadata: (chunk as any).providerMetadata,
                }),
              },
              { metadata: { event: 'text-delta' } },
            ),
          );
          break;
        }

        case 'text-end': {
          const state = serials.get(chunk.id);
          if (!state) throw new Error(`No serial for text ${chunk.id}`);
          pendingAppends.push(
            channel.appendMessage(
              {
                serial: state.serial,
                data: '',
                extras: withOptionalHeaders(extras, {
                  providerMetadata: (chunk as any).providerMetadata,
                }),
              },
              { metadata: { event: 'text-end' } },
            ),
          );
          serials.delete(chunk.id);
          break;
        }

        // ── Reasoning streaming ───────────────────────
        case 'reasoning-start': {
          const uniqueId = crypto.randomUUID();
          const result = await channel.publish({
            name: `reasoning:${uniqueId}`,
            data: '',
            extras: withOptionalHeaders(extras, {
              providerMetadata: (chunk as any).providerMetadata,
            }),
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
          pendingAppends.push(
            channel.appendMessage(
              {
                serial: state.serial,
                data: chunk.delta,
                extras: withOptionalHeaders(extras, {
                  providerMetadata: (chunk as any).providerMetadata,
                }),
              },
              { metadata: { event: 'reasoning-delta' } },
            ),
          );
          break;
        }

        case 'reasoning-end': {
          const state = serials.get(chunk.id);
          if (!state) throw new Error(`No serial for reasoning ${chunk.id}`);
          pendingAppends.push(
            channel.appendMessage(
              {
                serial: state.serial,
                data: '',
                extras: withOptionalHeaders(extras, {
                  providerMetadata: (chunk as any).providerMetadata,
                }),
              },
              { metadata: { event: 'reasoning-end' } },
            ),
          );
          serials.delete(chunk.id);
          break;
        }

        // ── Tool lifecycle ────────────────────────────
        case 'tool-input-start': {
          const result = await channel.publish({
            name: `tool:${chunk.toolCallId}:${chunk.toolName}`,
            data: '',
            extras: withOptionalHeaders(extras, {
              dynamic: (chunk as any).dynamic,
              title: (chunk as any).title,
              providerExecuted: (chunk as any).providerExecuted,
              providerMetadata: (chunk as any).providerMetadata,
            }),
          });
          serials.set(chunk.toolCallId, {
            serial: result.serials[0]!,
            type: 'tool-input',
          });
          break;
        }

        case 'tool-input-delta': {
          const state = serials.get(chunk.toolCallId);
          if (!state) throw new Error(`No serial for tool ${chunk.toolCallId}`);
          pendingAppends.push(
            channel.appendMessage(
              { serial: state.serial, data: chunk.inputTextDelta, extras },
              { metadata: { event: 'tool-input-delta' } },
            ),
          );
          break;
        }

        case 'tool-input-available': {
          const state = serials.get(chunk.toolCallId);
          if (state) {
            // Streaming tool call: send end signal
            pendingAppends.push(
              channel.appendMessage(
                { serial: state.serial, data: '', extras },
                { metadata: { event: 'tool-input-end' } },
              ),
            );
          } else {
            // Non-streaming tool call: publish full input
            const result = await channel.publish({
              name: `tool:${chunk.toolCallId}:${chunk.toolName}`,
              data: JSON.stringify(chunk.input),
              extras: withOptionalHeaders(
                makeExtras(promptId, { event: 'tool-input-available' }),
                {
                  dynamic: (chunk as any).dynamic,
                  title: (chunk as any).title,
                  providerExecuted: (chunk as any).providerExecuted,
                  providerMetadata: (chunk as any).providerMetadata,
                },
              ),
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
          if (!state) throw new Error(`No serial for tool ${chunk.toolCallId}`);
          await channel.updateMessage({
            serial: state.serial,
            name: `tool-output:${chunk.toolCallId}`,
            data: JSON.stringify(withOptionalData(
              { output: chunk.output },
              {
                preliminary: (chunk as any).preliminary,
                dynamic: (chunk as any).dynamic,
                providerExecuted: (chunk as any).providerExecuted,
              },
            )),
            extras,
          });
          break;
        }

        case 'tool-output-error': {
          const state = serials.get(chunk.toolCallId);
          if (!state) throw new Error(`No serial for tool ${chunk.toolCallId}`);
          await channel.updateMessage({
            serial: state.serial,
            name: `tool-error:${chunk.toolCallId}`,
            data: JSON.stringify(withOptionalData(
              { errorText: chunk.errorText },
              {
                dynamic: (chunk as any).dynamic,
                providerExecuted: (chunk as any).providerExecuted,
              },
            )),
            extras,
          });
          break;
        }

        case 'tool-input-error': {
          const state = serials.get(chunk.toolCallId);
          if (state) {
            await channel.updateMessage({
              serial: state.serial,
              name: `tool-error:${chunk.toolCallId}`,
              data: JSON.stringify(withOptionalData(
                { errorText: chunk.errorText },
                {
                  dynamic: (chunk as any).dynamic,
                  providerExecuted: (chunk as any).providerExecuted,
                  providerMetadata: (chunk as any).providerMetadata,
                  title: (chunk as any).title,
                },
              )),
              extras,
            });
          }
          break;
        }

        // ── Tool approval/denial ────────────────────────
        case 'tool-approval-request': {
          const c = chunk as any;
          await channel.publish({
            name: `tool-approval:${c.toolCallId}`,
            data: JSON.stringify({ approvalId: c.approvalId }),
            extras,
          });
          break;
        }

        case 'tool-output-denied': {
          const c = chunk as any;
          const state = serials.get(c.toolCallId);
          if (state) {
            await channel.updateMessage({
              serial: state.serial,
              name: `tool-denied:${c.toolCallId}`,
              data: '{}',
              extras,
            });
          }
          break;
        }

        // ── Discrete events ───────────────────────────
        case 'file': {
          await channel.publish({
            name: 'file',
            data: JSON.stringify(withOptionalData(
              { url: chunk.url, mediaType: chunk.mediaType },
              { providerMetadata: (chunk as any).providerMetadata },
            )),
            extras,
          });
          break;
        }

        case 'source-url': {
          await channel.publish({
            name: 'source-url',
            data: JSON.stringify(withOptionalData(
              {
                sourceId: chunk.sourceId,
                url: chunk.url,
                ...(chunk.title != null ? { title: chunk.title } : {}),
              },
              { providerMetadata: (chunk as any).providerMetadata },
            )),
            extras,
          });
          break;
        }

        case 'source-document': {
          await channel.publish({
            name: 'source-document',
            data: JSON.stringify(withOptionalData(
              {
                sourceId: chunk.sourceId,
                mediaType: chunk.mediaType,
                title: chunk.title,
                ...(chunk.filename != null ? { filename: chunk.filename } : {}),
              },
              { providerMetadata: (chunk as any).providerMetadata },
            )),
            extras,
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
                ? { extras: { ephemeral: true, ...makeExtras(promptId) } }
                : { extras }),
            });
          }
          break;
        }
      }
    }

    if (abortSignal?.aborted) {
      await publishAbortSequence();
    }

    return chunks;
  } catch (err) {
    if (!terminalPublished) {
      const errorText = err instanceof Error ? err.message : 'Unknown stream error';
      await channel.publish({
        name: 'error',
        data: JSON.stringify({ errorText }),
        extras,
      });
    }
    throw err;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function makeExtras(promptId?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = { role: 'assistant' };
  if (promptId) headers.promptId = promptId;
  if (extra) Object.assign(headers, extra);
  return { headers };
}

/** Merge optional fields into extras.headers, JSON-encoding non-string values. */
function withOptionalHeaders(
  base: { headers: Record<string, string> },
  fields: Record<string, unknown>,
): { headers: Record<string, string> } {
  const headers = { ...base.headers };
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) {
      headers[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  return { headers };
}

/** Conditionally include optional fields in a data object. */
function withOptionalData(
  base: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) result[key] = value;
  }
  return result;
}
