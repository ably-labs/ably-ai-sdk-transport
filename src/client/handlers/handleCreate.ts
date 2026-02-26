import type { InboundMessage } from 'ably';
import type { UIMessageChunk } from 'ai';
import type { HandlerContext } from '../types.js';
import { parseData, parseJsonData } from '../utils.js';

type FinishChunk = Extract<UIMessageChunk, { type: 'finish' }>;

/** Extract optional JSON-encoded fields from extras.headers. */
function extractOptionalHeaders(
  headers: Record<string, string>,
  keys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (headers[key] != null) {
      try {
        result[key] = JSON.parse(headers[key]);
      } catch {
        result[key] = headers[key];
      }
    }
  }
  return result;
}

export function handleCreate(message: InboundMessage, ctx: HandlerContext): void {
  const name = message.name ?? '';
  const data = parseData(message.data);
  const extras = message.extras?.headers ?? {};

  // ── Start message (messageId / messageMetadata) ─
  if (name === 'start') {
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'start',
      ...(parsed.messageId != null ? { messageId: parsed.messageId as string } : {}),
      ...(parsed.messageMetadata != null ? { messageMetadata: parsed.messageMetadata } : {}),
    } as any);
    ctx.emitState.hasEmittedStart = true;
    return;
  }

  // ── Streaming text ──────────────────────────────
  if (name.startsWith('text:')) {
    const id = name.slice(5);
    ctx.ensureStarted();
    ctx.serialState.set(message.serial!, {
      type: 'text',
      id,
      accumulated: '',
    });
    const optFields = extractOptionalHeaders(extras, ['providerMetadata']);
    ctx.controller.enqueue({ type: 'text-start', id, ...optFields } as any);
    return;
  }

  // ── Streaming reasoning ─────────────────────────
  if (name.startsWith('reasoning:')) {
    const id = name.slice(10);
    ctx.ensureStarted();
    ctx.serialState.set(message.serial!, {
      type: 'reasoning',
      id,
      accumulated: '',
    });
    const optFields = extractOptionalHeaders(extras, ['providerMetadata']);
    ctx.controller.enqueue({ type: 'reasoning-start', id, ...optFields } as any);
    return;
  }

  // ── Tool call ───────────────────────────────────
  if (name.startsWith('tool:')) {
    const parts = name.split(':');
    const toolCallId = parts[1];
    const toolName = parts.slice(2).join(':');
    ctx.ensureStarted();

    const toolOptFields = extractOptionalHeaders(extras, [
      'dynamic', 'title', 'providerExecuted', 'providerMetadata',
    ]);

    // Non-streaming tool call: full input in one create — emit tool-input-available directly
    if (extras.event === 'tool-input-available') {
      ctx.serialState.set(message.serial!, {
        type: 'tool-input',
        id: toolCallId,
        toolName,
        accumulated: data,
      });
      const input = JSON.parse(data || '{}');
      ctx.controller.enqueue({
        type: 'tool-input-available',
        toolCallId,
        toolName,
        input,
        ...toolOptFields,
      } as any);
      return;
    }

    // Streaming tool call — just the start
    ctx.serialState.set(message.serial!, {
      type: 'tool-input',
      id: toolCallId,
      toolName,
      accumulated: '',
    });
    ctx.controller.enqueue({
      type: 'tool-input-start',
      toolCallId,
      toolName,
      ...toolOptFields,
    } as any);
    return;
  }

  // ── Tool approval ──────────────────────────────
  if (name.startsWith('tool-approval:')) {
    const toolCallId = name.slice(14);
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'tool-approval-request',
      toolCallId,
      approvalId: parsed.approvalId as string,
    } as any);
    return;
  }

  // ── Control messages ────────────────────────────
  if (name === 'step-finish') {
    ctx.controller.enqueue({ type: 'finish-step' });
    ctx.emitState.hasEmittedStepStart = false;
    return;
  }

  if (name === 'finish') {
    const parsed = parseJsonData(message.data);
    ctx.closed = true;
    ctx.controller.enqueue({
      type: 'finish',
      finishReason: parsed.finishReason as FinishChunk['finishReason'],
      ...(parsed.messageMetadata != null ? { messageMetadata: parsed.messageMetadata } : {}),
    });
    ctx.controller.close();
    return;
  }

  if (name === 'error') {
    const parsed = parseJsonData(message.data);
    ctx.closed = true;
    ctx.controller.enqueue({
      type: 'error',
      errorText: (parsed.errorText as string) ?? 'Unknown error',
    });
    ctx.controller.close();
    return;
  }

  if (name === 'abort') {
    ctx.closed = true;
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'abort',
      ...(parsed.reason != null ? { reason: parsed.reason as string } : {}),
    } as any);
    ctx.controller.close();
    return;
  }

  if (name === 'metadata') {
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'message-metadata',
      messageMetadata: parsed.messageMetadata,
    });
    return;
  }

  // ── Discrete events ─────────────────────────────
  if (name === 'file') {
    ctx.ensureStarted();
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'file',
      url: parsed.url as string,
      mediaType: parsed.mediaType as string,
      ...(parsed.providerMetadata != null ? { providerMetadata: parsed.providerMetadata } : {}),
    } as any);
    return;
  }

  if (name === 'source-url') {
    ctx.ensureStarted();
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'source-url',
      sourceId: parsed.sourceId as string,
      url: parsed.url as string,
      ...(parsed.title != null ? { title: parsed.title as string } : {}),
      ...(parsed.providerMetadata != null ? { providerMetadata: parsed.providerMetadata } : {}),
    } as any);
    return;
  }

  if (name === 'source-document') {
    ctx.ensureStarted();
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'source-document',
      sourceId: parsed.sourceId as string,
      mediaType: parsed.mediaType as string,
      title: parsed.title as string,
      ...(parsed.filename != null ? { filename: parsed.filename as string } : {}),
      ...(parsed.providerMetadata != null ? { providerMetadata: parsed.providerMetadata } : {}),
    } as any);
    return;
  }

  // ── Data parts ──────────────────────────────────
  if (name.startsWith('data-')) {
    ctx.ensureStarted();
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: name as `data-${string}`,
      data: parsed.data,
      ...(parsed.id != null ? { id: parsed.id as string } : {}),
      ...(message.extras?.ephemeral ? { transient: true } : {}),
    } as any);
    return;
  }
}
