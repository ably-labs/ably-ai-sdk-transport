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
const SKIP_NAMES = new Set(['step-finish', 'user-abort']);

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
  let pendingMessageId: string | null = null;
  let pendingMessageMetadata: unknown = null;

  function finalizeAssistant() {
    if (currentAssistant && currentAssistant.parts.length > 0) {
      messages.push(currentAssistant);
    }
    currentAssistant = null;
    pendingMessageId = null;
    pendingMessageMetadata = null;
    assistantIdFromStart = false;
  }

  let assistantIdFromStart = false;

  function ensureAssistant(): UIMessage {
    if (!currentAssistant) {
      assistantIdFromStart = pendingMessageId != null;
      currentAssistant = {
        id: pendingMessageId ?? crypto.randomUUID(),
        role: 'assistant',
        parts: [],
        ...(pendingMessageMetadata != null ? { metadata: pendingMessageMetadata } : {}),
      };
      // Reset pending so they don't leak to a subsequent assistant
      pendingMessageId = null;
      pendingMessageMetadata = null;
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
      // (unless a start message already set a specific ID)
      if (assistant.parts.length === 0 && !assistantIdFromStart) {
        assistant.id = id;
      }
      if (data.length > 0) {
        assistant.parts.push({ type: 'text', text: data, state: 'done' } as any);
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
        assistant.parts.push({ type: 'reasoning', text: data, state: 'done' } as any);
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
        type: `tool-${toolName}`,
        toolCallId,
        state: 'input-available',
        input: input as Record<string, unknown>,
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

      // Find and update the matching tool part
      for (const part of assistant.parts) {
        const p = part as any;
        if (p.toolCallId === toolCallId) {
          p.state = 'output-available';
          p.output = parsed.output;
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
        if (p.toolCallId === toolCallId) {
          p.state = 'output-error';
          p.errorText = (parsed.errorText as string) ?? 'Unknown tool error';
          break;
        }
      }
      continue;
    }

    // ── Tool approval ────────────────────────────────
    if (name.startsWith('tool-approval:')) {
      const toolCallId = name.slice(14);
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();
      // Find the matching tool part and update its state
      for (const part of assistant.parts) {
        const p = part as any;
        if (p.toolCallId === toolCallId) {
          p.state = 'approval-required';
          p.approvalId = parsed.approvalId;
          break;
        }
      }
      continue;
    }

    // ── Tool denied ─────────────────────────────────
    if (name.startsWith('tool-denied:')) {
      const toolCallId = name.slice(12);
      const assistant = ensureAssistant();
      for (const part of assistant.parts) {
        const p = part as any;
        if (p.toolCallId === toolCallId) {
          p.state = 'output-denied';
          break;
        }
      }
      continue;
    }

    // ── File part ───────────────────────────────────
    if (name === 'file') {
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();
      assistant.parts.push({
        type: 'file',
        url: parsed.url as string,
        mediaType: parsed.mediaType as string,
        ...(parsed.providerMetadata != null ? { providerMetadata: parsed.providerMetadata } : {}),
      } as any);
      continue;
    }

    // ── Source URL part ─────────────────────────────
    if (name === 'source-url') {
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();
      assistant.parts.push({
        type: 'source-url',
        sourceId: parsed.sourceId as string,
        url: parsed.url as string,
        ...(parsed.title != null ? { title: parsed.title as string } : {}),
        ...(parsed.providerMetadata != null ? { providerMetadata: parsed.providerMetadata } : {}),
      } as any);
      continue;
    }

    // ── Source document part ────────────────────────
    if (name === 'source-document') {
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();
      assistant.parts.push({
        type: 'source-document',
        sourceId: parsed.sourceId as string,
        mediaType: parsed.mediaType as string,
        title: parsed.title as string,
        ...(parsed.filename != null ? { filename: parsed.filename as string } : {}),
        ...(parsed.providerMetadata != null ? { providerMetadata: parsed.providerMetadata } : {}),
      } as any);
      continue;
    }

    // ── Data parts ──────────────────────────────────
    if (name.startsWith('data-')) {
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();
      assistant.parts.push({
        type: name,
        data: parsed.data,
        ...(parsed.id != null ? { id: parsed.id as string } : {}),
      } as any);
      continue;
    }

    // ── Metadata ────────────────────────────────────
    if (name === 'metadata') {
      const parsed = parseJsonData(msg.data);
      const assistant = ensureAssistant();
      if (parsed.messageMetadata != null) {
        assistant.metadata = { ...(assistant.metadata as any), ...parsed.messageMetadata as any };
      }
      continue;
    }

    // ── Start (messageId) ───────────────────────────
    if (name === 'start') {
      const parsed = parseJsonData(msg.data);
      if (parsed.messageId != null) {
        pendingMessageId = parsed.messageId as string;
      }
      if (parsed.messageMetadata != null) {
        pendingMessageMetadata = parsed.messageMetadata;
      }
      continue;
    }
  }

  // Finalize any trailing assistant message
  finalizeAssistant();

  return messages;
}
