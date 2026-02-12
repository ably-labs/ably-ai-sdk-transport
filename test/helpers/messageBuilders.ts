import type { InboundMessage } from 'ably';
import type { UIMessage } from 'ai';

/**
 * Build an InboundMessage with sensible defaults, overridden by caller.
 */
export function buildInboundMessage(
  overrides: Partial<InboundMessage> & {
    name?: string;
    data?: any;
    serial?: string;
    extras?: any;
  } = {},
): InboundMessage {
  return {
    id: 'msg-id',
    timestamp: Date.now(),
    action: 'message.create',
    version: overrides.version ?? { serial: 'v1', timestamp: Date.now() },
    annotations: { summary: {} },
    serial: 'serial-1',
    name: '',
    data: undefined,
    extras: undefined,
    ...overrides,
  } as InboundMessage;
}

/**
 * Build a completed message (has a terminal event in version.metadata).
 */
export function buildCompletedMessage(
  name: string,
  data: string,
  eventType: string,
): InboundMessage {
  return buildInboundMessage({
    name,
    data,
    version: { metadata: { event: eventType } } as any,
  });
}

/**
 * Build a UIMessage for use in transport-level tests.
 */
export function makeUserMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}
