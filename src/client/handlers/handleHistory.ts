import type { InboundMessage } from 'ably';
import type { UIMessageChunk } from 'ai';
import type { HandlerContext } from '../types.js';
import { parseData, parseJsonData } from '../utils.js';

type FinishChunk = Extract<UIMessageChunk, { type: 'finish' }>;

export function handleHistory(message: InboundMessage, ctx: HandlerContext): void {
  const name = message.name ?? '';
  const data = parseData(message.data);

  // ── Text messages ───────────────────────────────
  if (name.startsWith('text:')) {
    const id = name.slice(5);
    ctx.ensureStarted();
    ctx.controller.enqueue({ type: 'text-start', id });

    if (data.length > 0) {
      ctx.controller.enqueue({ type: 'text-delta', id, delta: data });
    }

    // Check if this text message has been finalized
    const lastEvent = message.version?.metadata?.event;
    if (lastEvent === 'text-end') {
      ctx.controller.enqueue({ type: 'text-end', id });
    } else {
      // Still streaming — track for live continuation
      ctx.serialState.set(message.serial!, {
        type: 'text',
        id,
        accumulated: data,
      });
    }
    return;
  }

  // ── Reasoning messages ──────────────────────────
  if (name.startsWith('reasoning:')) {
    const id = name.slice(10);
    ctx.ensureStarted();
    ctx.controller.enqueue({ type: 'reasoning-start', id });

    if (data.length > 0) {
      ctx.controller.enqueue({ type: 'reasoning-delta', id, delta: data });
    }

    const lastEvent = message.version?.metadata?.event;
    if (lastEvent === 'reasoning-end') {
      ctx.controller.enqueue({ type: 'reasoning-end', id });
    } else {
      ctx.serialState.set(message.serial!, {
        type: 'reasoning',
        id,
        accumulated: data,
      });
    }
    return;
  }

  // ── Tool messages (various states) ──────────────
  if (name.startsWith('tool:')) {
    const parts = name.split(':');
    const toolCallId = parts[1];
    const toolName = parts.slice(2).join(':');
    ctx.ensureStarted();

    ctx.controller.enqueue({
      type: 'tool-input-start',
      toolCallId,
      toolName,
    });

    if (data.length > 0) {
      ctx.controller.enqueue({
        type: 'tool-input-delta',
        toolCallId,
        inputTextDelta: data,
      });

      try {
        const input = JSON.parse(data);
        ctx.controller.enqueue({
          type: 'tool-input-available',
          toolCallId,
          toolName,
          input,
        });
      } catch {
        // Input not yet complete (still streaming) — track for live continuation
        ctx.serialState.set(message.serial!, {
          type: 'tool-input',
          id: toolCallId,
          toolName,
          accumulated: data,
        });
      }
    }
    return;
  }

  if (name.startsWith('tool-output:')) {
    const toolCallId = name.slice(12);
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'tool-output-available',
      toolCallId,
      output: parsed.output,
    });
    return;
  }

  if (name.startsWith('tool-error:')) {
    const toolCallId = name.slice(11);
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'tool-output-error',
      toolCallId,
      errorText: (parsed.errorText as string) ?? 'Unknown tool error',
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
    ctx.controller.enqueue({
      type: 'finish',
      finishReason: parsed.finishReason as FinishChunk['finishReason'],
      ...(parsed.messageMetadata != null ? { messageMetadata: parsed.messageMetadata } : {}),
    });
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
      ...(parsed.filename != null ? { filename: parsed.filename as string } : {}),
    });
    return;
  }

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
