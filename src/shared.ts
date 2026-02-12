import type { InboundMessage } from 'ably';
import type { UIMessage } from 'ai';

export function parseData(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  return String(data);
}

export function parseJsonData(data: unknown): Record<string, unknown> {
  const str = parseData(data);
  if (str === '') return {};
  return JSON.parse(str) as Record<string, unknown>;
}

/** Terminal message names that signal the end of a stream. */
export const TERMINAL_NAMES = new Set(['finish', 'error', 'abort']);

/** Names to skip when reconstructing messages. */
const SKIP_NAMES = new Set(['step-finish', 'metadata', 'user-abort']);

/**
 * Reconstruct UIMessage[] from a chronological list of Ably history messages.
 *
 * Walks the messages oldest-first, grouping them into user/assistant UIMessage
 * objects. User messages are extracted from `chat-message` events. Assistant
 * content is accumulated from `text:`, `reasoning:`, `tool:`, `tool-output:`,
 * and `tool-error:` messages.
 */
export function reconstructMessages(chronological: InboundMessage[]): UIMessage[] {
  const messages: UIMessage[] = [];
  let currentAssistant: UIMessage | null = null;

  function finalizeAssistant() {
    if (currentAssistant && currentAssistant.parts.length > 0) {
      messages.push(currentAssistant);
    }
    currentAssistant = null;
  }

  function ensureAssistant(): UIMessage {
    if (!currentAssistant) {
      currentAssistant = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [],
      };
    }
    return currentAssistant;
  }

  for (const msg of chronological) {
    const name = msg.name ?? '';
    const data = parseData(msg.data);

    // ── User message ──────────────────────────────
    if (name === 'chat-message') {
      finalizeAssistant();
      const parsed = parseJsonData(msg.data);
      const userMsg = parsed.message as UIMessage | undefined;
      if (userMsg) {
        messages.push({
          id: userMsg.id ?? crypto.randomUUID(),
          role: 'user',
          parts: userMsg.parts ?? [{ type: 'text', text: '' }],
        });
      }
      continue;
    }

    // ── Regenerate: remove last assistant message ─
    if (name === 'regenerate') {
      finalizeAssistant();
      // Remove the last assistant message (mirrors server behavior)
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          messages.splice(i, 1);
          break;
        }
      }
      continue;
    }

    // ── Skip control messages ─────────────────────
    if (SKIP_NAMES.has(name)) continue;

    // ── Terminal messages: finalize assistant ──────
    if (TERMINAL_NAMES.has(name)) {
      finalizeAssistant();
      continue;
    }

    // ── Text content ──────────────────────────────
    if (name.startsWith('text:')) {
      const id = name.slice(5);
      const assistant = ensureAssistant();
      // Use the text ID as the assistant message ID if this is the first text part
      if (assistant.parts.length === 0) {
        assistant.id = id;
      }
      if (data.length > 0) {
        assistant.parts.push({ type: 'text', text: data });
      }
      // Mark content complete if version metadata has text-end
      const event = (msg as any).version?.metadata?.event;
      if (event === 'text-end') {
        assistant.metadata = { ...(assistant.metadata as any), contentComplete: true };
      }
      continue;
    }

    // ── Reasoning content ─────────────────────────
    if (name.startsWith('reasoning:')) {
      const assistant = ensureAssistant();
      if (data.length > 0) {
        assistant.parts.push({ type: 'reasoning', text: data, providerMetadata: {} });
      }
      const event = (msg as any).version?.metadata?.event;
      if (event === 'reasoning-end') {
        assistant.metadata = { ...(assistant.metadata as any), contentComplete: true };
      }
      continue;
    }

    // ── Tool call ─────────────────────────────────
    if (name.startsWith('tool:')) {
      const parts = name.split(':');
      const toolCallId = parts[1];
      const toolName = parts.slice(2).join(':');
      const assistant = ensureAssistant();

      let input: unknown = {};
      if (data.length > 0) {
        try {
          input = JSON.parse(data);
        } catch {
          input = {};
        }
      }

      assistant.parts.push({
        type: 'tool-invocation',
        toolInvocation: {
          state: 'call',
          toolCallId,
          toolName,
          args: input as Record<string, unknown>,
        },
      } as any);
      const event = (msg as any).version?.metadata?.event;
      if (event === 'tool-input-end') {
        assistant.metadata = { ...(assistant.metadata as any), contentComplete: true };
      }
      continue;
    }

    // ── Tool output ───────────────────────────────
    if (name.startsWith('tool-output:')) {
      const toolCallId = name.slice(12);
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();

      // Find and update the matching tool-invocation part
      for (const part of assistant.parts) {
        const p = part as any;
        if (p.type === 'tool-invocation' && p.toolInvocation.toolCallId === toolCallId) {
          p.toolInvocation = {
            ...p.toolInvocation,
            state: 'result',
            result: parsed.output,
          };
          break;
        }
      }
      continue;
    }

    // ── Tool error ────────────────────────────────
    if (name.startsWith('tool-error:')) {
      const toolCallId = name.slice(11);
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();

      for (const part of assistant.parts) {
        const p = part as any;
        if (p.type === 'tool-invocation' && p.toolInvocation.toolCallId === toolCallId) {
          p.toolInvocation = {
            ...p.toolInvocation,
            state: 'result',
            result: (parsed.errorText as string) ?? 'Unknown tool error',
          };
          break;
        }
      }
      continue;
    }
  }

  // Finalize any trailing assistant message
  finalizeAssistant();

  return messages;
}
