import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

/**
 * Wraps a ReadableStream<UIMessageChunk> with a pass-through that logs each
 * chunk as JSON to the console. Useful for debugging the stream of UI chunks
 * produced by AblyChatTransport.
 *
 * Usage:
 *   import { debugStream } from '@ably/ai-sdk-transport';
 *   const stream = await transport.sendMessages(opts);
 *   const debugged = debugStream(stream);
 */
export function debugStream(
  stream: ReadableStream<UIMessageChunk>,
  label = 'UIMessageChunk',
): ReadableStream<UIMessageChunk> {
  let index = 0;

  const transform = new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      console.log(`[${label}] #${index++} ${chunk.type}`, JSON.stringify(chunk, null, 2));
      controller.enqueue(chunk);
    },
  });

  return stream.pipeThrough(transform);
}

/**
 * Wraps a ChatTransport so that every stream returned by `sendMessages` and
 * `reconnectToStream` is piped through `debugStream`, logging each chunk.
 *
 * Usage:
 *   import { AblyChatTransport, debugTransport } from '@ably/ai-sdk-transport';
 *   const transport = new AblyChatTransport({ ... });
 *   const { messages } = useChat({ transport: debugTransport(transport) });
 */
export function debugTransport(transport: ChatTransport<UIMessage>): ChatTransport<UIMessage> {
  return {
    sendMessages: async (...args) => {
      const stream = await transport.sendMessages(...args);
      return debugStream(stream, 'send');
    },
    reconnectToStream: async (...args) => {
      const stream = await transport.reconnectToStream(...args);
      return stream ? debugStream(stream, 'reconnect') : null;
    },
  };
}
