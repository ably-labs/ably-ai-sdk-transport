import type { InboundMessage } from 'ably';
import type { HandlerContext } from '../types.js';
import { parseData, createTrackerFromName } from '../utils.js';

export function handleAppend(
  message: InboundMessage,
  ctx: HandlerContext,
): void {
  const data = parseData(message.data);
  const event = message.version?.metadata?.event;

  // Find tracker by serial — appends carry the original message's serial
  let tracker = ctx.serialState.get(message.serial!);
  if (!tracker) {
    // Orphan append — the create was in history, not in the buffer.
    // Auto-create a tracker from the message name so the stream can continue.
    const created = createTrackerFromName(message.name ?? '');
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

  // ── Text append ─────────────────────────────────
  if (tracker.type === 'text') {
    if (event === 'text-end') {
      if (data.length > 0) {
        tracker.accumulated += data;
        ctx.controller.enqueue({
          type: 'text-delta',
          id: tracker.id,
          delta: data,
        });
      }
      ctx.controller.enqueue({ type: 'text-end', id: tracker.id });
      ctx.serialState.delete(message.serial!);
      return;
    }

    if (data.length > 0) {
      tracker.accumulated += data;
      ctx.controller.enqueue({
        type: 'text-delta',
        id: tracker.id,
        delta: data,
      });
    }
    return;
  }

  // ── Reasoning append ────────────────────────────
  if (tracker.type === 'reasoning') {
    if (event === 'reasoning-end') {
      if (data.length > 0) {
        tracker.accumulated += data;
        ctx.controller.enqueue({
          type: 'reasoning-delta',
          id: tracker.id,
          delta: data,
        });
      }
      ctx.controller.enqueue({ type: 'reasoning-end', id: tracker.id });
      ctx.serialState.delete(message.serial!);
      return;
    }

    if (data.length > 0) {
      tracker.accumulated += data;
      ctx.controller.enqueue({
        type: 'reasoning-delta',
        id: tracker.id,
        delta: data,
      });
    }
    return;
  }

  // ── Tool input append ───────────────────────────
  if (tracker.type === 'tool-input') {
    if (event === 'tool-input-end') {
      if (data.length > 0) {
        tracker.accumulated += data;
        ctx.controller.enqueue({
          type: 'tool-input-delta',
          toolCallId: tracker.id,
          inputTextDelta: data,
        });
      }

      const input = JSON.parse(tracker.accumulated);
      ctx.controller.enqueue({
        type: 'tool-input-available',
        toolCallId: tracker.id,
        toolName: tracker.toolName!,
        input,
      });
      // Don't delete from serialState — need serial for tool-output update
      return;
    }

    if (data.length > 0) {
      tracker.accumulated += data;
      ctx.controller.enqueue({
        type: 'tool-input-delta',
        toolCallId: tracker.id,
        inputTextDelta: data,
      });
    }
    return;
  }
}
