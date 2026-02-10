import type { InboundMessage } from 'ably';
import type { HandlerContext } from '../types.js';
import { parseData, parseJsonData, createTrackerFromName } from '../utils.js';

export function handleUpdate(
  message: InboundMessage,
  ctx: HandlerContext,
): void {
  const name = message.name ?? '';
  const data = parseData(message.data);

  // ── Tool output (intentional update) ────────────
  if (name.startsWith('tool-output:')) {
    const toolCallId = name.slice(12);
    ctx.ensureStarted();
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'tool-output-available',
      toolCallId,
      output: parsed.output,
    });
    // Clean up serial state for this tool
    for (const [serial, state] of ctx.serialState) {
      if (state.type === 'tool-input' && state.id === toolCallId) {
        ctx.serialState.delete(serial);
        break;
      }
    }
    return;
  }

  // ── Tool error (intentional update) ─────────────
  if (name.startsWith('tool-error:')) {
    const toolCallId = name.slice(11);
    ctx.ensureStarted();
    const parsed = parseJsonData(message.data);
    ctx.controller.enqueue({
      type: 'tool-output-error',
      toolCallId,
      errorText: (parsed.errorText as string) ?? 'Unknown tool error',
    });
    for (const [serial, state] of ctx.serialState) {
      if (state.type === 'tool-input' && state.id === toolCallId) {
        ctx.serialState.delete(serial);
        break;
      }
    }
    return;
  }

  // ── Append delivered as update (conflation) ─────
  const event = message.version?.metadata?.event;
  let tracker = ctx.serialState.get(message.serial!);
  if (!tracker) {
    // Orphan update — the create was in history, not in the buffer.
    const created = createTrackerFromName(name);
    if (!created) return;
    tracker = created;
    ctx.serialState.set(message.serial!, tracker);
    ctx.ensureStarted();
    if (tracker.type === 'text') {
      ctx.controller.enqueue({ type: 'text-start', id: tracker.id });
    } else if (tracker.type === 'reasoning') {
      ctx.controller.enqueue({ type: 'reasoning-start', id: tracker.id });
    } else if (tracker.type === 'tool-input') {
      ctx.controller.enqueue({ type: 'tool-input-start', toolCallId: tracker.id, toolName: tracker.toolName! });
    }
  }

  ctx.ensureStarted();

  const fullText = data;
  const delta = fullText.slice(tracker.accumulated.length);

  if (tracker.type === 'text') {
    if (event === 'text-end') {
      if (delta.length > 0) {
        tracker.accumulated = fullText;
        ctx.controller.enqueue({
          type: 'text-delta',
          id: tracker.id,
          delta,
        });
      }
      ctx.controller.enqueue({ type: 'text-end', id: tracker.id });
      ctx.serialState.delete(message.serial!);
    } else if (delta.length > 0) {
      tracker.accumulated = fullText;
      ctx.controller.enqueue({
        type: 'text-delta',
        id: tracker.id,
        delta,
      });
    }
    return;
  }

  if (tracker.type === 'reasoning') {
    if (event === 'reasoning-end') {
      if (delta.length > 0) {
        tracker.accumulated = fullText;
        ctx.controller.enqueue({
          type: 'reasoning-delta',
          id: tracker.id,
          delta,
        });
      }
      ctx.controller.enqueue({ type: 'reasoning-end', id: tracker.id });
      ctx.serialState.delete(message.serial!);
    } else if (delta.length > 0) {
      tracker.accumulated = fullText;
      ctx.controller.enqueue({
        type: 'reasoning-delta',
        id: tracker.id,
        delta,
      });
    }
    return;
  }

  if (tracker.type === 'tool-input') {
    if (event === 'tool-input-end') {
      if (delta.length > 0) {
        tracker.accumulated = fullText;
        ctx.controller.enqueue({
          type: 'tool-input-delta',
          toolCallId: tracker.id,
          inputTextDelta: delta,
        });
      }
      const input = JSON.parse(tracker.accumulated);
      ctx.controller.enqueue({
        type: 'tool-input-available',
        toolCallId: tracker.id,
        toolName: tracker.toolName!,
        input,
      });
    } else if (delta.length > 0) {
      tracker.accumulated = fullText;
      ctx.controller.enqueue({
        type: 'tool-input-delta',
        toolCallId: tracker.id,
        inputTextDelta: delta,
      });
    }
    return;
  }
}
