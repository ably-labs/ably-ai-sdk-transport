import type { InboundMessage } from 'ably';
import type { UIMessageChunk } from 'ai';
import type { HandlerContext } from '../types.js';
import { parseData, parseJsonData } from '../utils.js';

type FinishChunk = Extract<UIMessageChunk, { type: 'finish' }>;

export function handleCreate(
  message: InboundMessage,
  ctx: HandlerContext,
): void {
  const name = message.name ?? '';
  const data = parseData(message.data);
  const extras = message.extras?.headers ?? {};

  // ── Streaming text ──────────────────────────────
  if (name.startsWith('text:')) {
    const id = name.slice(5);
    ctx.ensureStarted();
    ctx.serialState.set(message.serial!, {
      type: 'text',
      id,
      accumulated: '',
    });
    ctx.controller.enqueue({ type: 'text-start', id });
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
    ctx.controller.enqueue({ type: 'reasoning-start', id });
    return;
  }

  // ── Tool call ───────────────────────────────────
  if (name.startsWith('tool:')) {
    const parts = name.split(':');
    const toolCallId = parts[1];
    const toolName = parts.slice(2).join(':');
    ctx.ensureStarted();

    // Non-streaming tool call: full input in one create
    if (extras.event === 'tool-input-available') {
      ctx.serialState.set(message.serial!, {
        type: 'tool-input',
        id: toolCallId,
        toolName,
        accumulated: data,
      });
      ctx.controller.enqueue({
        type: 'tool-input-start',
        toolCallId,
        toolName,
      });
      const input = JSON.parse(data || '{}');
      ctx.controller.enqueue({
        type: 'tool-input-available',
        toolCallId,
        toolName,
        input,
      });
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
    });
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
      ...(parsed.messageMetadata != null
        ? { messageMetadata: parsed.messageMetadata }
        : {}),
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
    ctx.controller.enqueue({ type: 'abort' });
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
    });
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
    });
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
      ...(parsed.filename != null
        ? { filename: parsed.filename as string }
        : {}),
    });
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
      ...(parsed.transient ? { transient: true } : {}),
    } as any);
    return;
  }
}
