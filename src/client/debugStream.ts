import type { UIMessageChunk } from 'ai';

/**
 * Wraps a ReadableStream<UIMessageChunk> with a pass-through that logs each
 * chunk as JSON to the console. Useful for debugging the stream of UI chunks
 * produced by AblyChatTransport.
 *
 * Usage:
 *   import { debugStream } from '@ably/ai-sdk-transport';
 *   const transport = new AblyChatTransport({ ... });
 *   const logged = new AblyChatTransport({ ... });
 *   // — or wrap manually:
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
      console.log(
        `[${label}] #${index++} ${chunk.type}`,
        JSON.stringify(chunk, null, 2),
      );
      controller.enqueue(chunk);
    },
  });

  return stream.pipeThrough(transform);
}
