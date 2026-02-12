import { describe, it, expect, beforeEach } from 'vitest';
import { publishToAbly } from '../../src/server/publishToAbly.js';
import { createMockChannel, resetSerialCounter } from '../helpers/mockAbly.js';
import { createChunkStream } from '../helpers/streamHelpers.js';
import type { UIMessageChunk } from 'ai';

describe('publishToAbly', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    resetSerialCounter();
    channel = createMockChannel();
  });

  describe('lifecycle events', () => {
    it('skips start chunk (client synthesizes)', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      // start is skipped, first start-step is skipped
      const publishNames = channel.publishCalls.map((c) => c.message.name);
      expect(publishNames).not.toContain('start');
    });

    it('skips first start-step (client synthesizes)', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const publishNames = channel.publishCalls.map((c) => c.message.name);
      // No step-start for the first step
      expect(publishNames).not.toContain('step-start');
      expect(publishNames).toContain('step-finish');
      expect(publishNames).toContain('finish');
    });

    it('skips all step-starts even for subsequent steps (client synthesizes)', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const publishNames = channel.publishCalls.map((c) => c.message.name);
      expect(publishNames).not.toContain('step-start');
      expect(publishNames.filter((n) => n === 'step-finish')).toHaveLength(2);
    });

    it('publishes finish with finishReason', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'length' },
      ]);

      await publishToAbly({ channel, stream });

      const finishCall = channel.publishCalls.find((c) => c.message.name === 'finish');
      expect(finishCall).toBeDefined();
      const data = JSON.parse(finishCall!.message.data);
      expect(data.finishReason).toBe('length');
    });

    it('publishes finish with messageMetadata', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop', messageMetadata: { custom: 'data' } },
      ]);

      await publishToAbly({ channel, stream });

      const finishCall = channel.publishCalls.find((c) => c.message.name === 'finish');
      const data = JSON.parse(finishCall!.message.data);
      expect(data.messageMetadata).toEqual({ custom: 'data' });
    });

    it('publishes abort on abort chunk', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'abort' },
      ]);

      await publishToAbly({ channel, stream });

      const publishNames = channel.publishCalls.map((c) => c.message.name);
      expect(publishNames).toEqual(['abort']);
    });

    it('publishes error', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'error', errorText: 'Something went wrong' },
      ]);

      await publishToAbly({ channel, stream });

      const errorCall = channel.publishCalls.find((c) => c.message.name === 'error');
      expect(errorCall).toBeDefined();
      const data = JSON.parse(errorCall!.message.data);
      expect(data.errorText).toBe('Something went wrong');
    });

    it('publishes message-metadata', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'message-metadata', messageMetadata: { foo: 'bar' } },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const metaCall = channel.publishCalls.find((c) => c.message.name === 'metadata');
      expect(metaCall).toBeDefined();
      const data = JSON.parse(metaCall!.message.data);
      expect(data.messageMetadata).toEqual({ foo: 'bar' });
    });
  });

  describe('text streaming', () => {
    it('publishes text-start as create, deltas as append, end as empty append', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: 'text-0' },
        { type: 'text-delta', id: 'text-0', delta: 'Hello' },
        { type: 'text-delta', id: 'text-0', delta: ' world' },
        { type: 'text-end', id: 'text-0' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      // Verify create
      const createCall = channel.publishCalls.find((c) => c.message.name?.startsWith('text:'));
      expect(createCall).toBeDefined();
      expect(createCall!.message.data).toBe('');

      // Verify appends
      expect(channel.appendCalls).toHaveLength(3); // 2 deltas + 1 end
      expect(channel.appendCalls[0].message.data).toBe('Hello');
      expect(channel.appendCalls[0].operation?.metadata?.event).toBe('text-delta');
      expect(channel.appendCalls[1].message.data).toBe(' world');
      expect(channel.appendCalls[2].message.data).toBe('');
      expect(channel.appendCalls[2].operation?.metadata?.event).toBe('text-end');
    });
  });

  describe('reasoning streaming', () => {
    it('publishes reasoning create + delta appends + end', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'r-0' },
        { type: 'reasoning-delta', id: 'r-0', delta: 'thinking...' },
        { type: 'reasoning-end', id: 'r-0' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const createCall = channel.publishCalls.find((c) => c.message.name?.startsWith('reasoning:'));
      expect(createCall).toBeDefined();

      expect(channel.appendCalls).toHaveLength(2);
      expect(channel.appendCalls[0].message.data).toBe('thinking...');
      expect(channel.appendCalls[0].operation?.metadata?.event).toBe('reasoning-delta');
      expect(channel.appendCalls[1].message.data).toBe('');
      expect(channel.appendCalls[1].operation?.metadata?.event).toBe('reasoning-end');
    });
  });

  describe('tool lifecycle', () => {
    it('publishes streaming tool: create + delta appends + end + update (output)', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'search' },
        {
          type: 'tool-input-delta',
          toolCallId: 'call-1',
          inputTextDelta: '{"query":',
        },
        {
          type: 'tool-input-delta',
          toolCallId: 'call-1',
          inputTextDelta: '"test"}',
        },
        {
          type: 'tool-input-available',
          toolCallId: 'call-1',
          toolName: 'search',
          input: { query: 'test' },
        },
        {
          type: 'tool-output-available',
          toolCallId: 'call-1',
          output: { results: ['a', 'b'] },
        },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      // Create
      const createCall = channel.publishCalls.find((c) => c.message.name === 'tool:call-1:search');
      expect(createCall).toBeDefined();

      // Delta appends (2) + end append (1)
      expect(channel.appendCalls).toHaveLength(3);
      expect(channel.appendCalls[0].message.data).toBe('{"query":');
      expect(channel.appendCalls[1].message.data).toBe('"test"}');
      expect(channel.appendCalls[2].message.data).toBe('');
      expect(channel.appendCalls[2].operation?.metadata?.event).toBe('tool-input-end');

      // Update for output
      expect(channel.updateCalls).toHaveLength(1);
      expect(channel.updateCalls[0].message.name).toBe('tool-output:call-1');
      const outputData = JSON.parse(channel.updateCalls[0].message.data);
      expect(outputData.output).toEqual({ results: ['a', 'b'] });
    });

    it('publishes non-streaming tool call as single create with extras', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-2',
          toolName: 'getTime',
          input: { tz: 'UTC' },
        },
        {
          type: 'tool-output-available',
          toolCallId: 'call-2',
          output: { time: '10:30' },
        },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      // Should be a single create with extras
      const createCall = channel.publishCalls.find((c) => c.message.name === 'tool:call-2:getTime');
      expect(createCall).toBeDefined();
      expect(createCall!.message.extras?.headers?.event).toBe('tool-input-available');
      const inputData = JSON.parse(createCall!.message.data);
      expect(inputData).toEqual({ tz: 'UTC' });

      // No append calls for this tool (non-streaming)
      expect(channel.appendCalls).toHaveLength(0);
    });

    it('publishes tool-output-error as updateMessage', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'tool-input-start', toolCallId: 'call-3', toolName: 'search' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-3',
          toolName: 'search',
          input: { q: 'test' },
        },
        {
          type: 'tool-output-error',
          toolCallId: 'call-3',
          errorText: 'API unavailable',
        },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      expect(channel.updateCalls).toHaveLength(1);
      expect(channel.updateCalls[0].message.name).toBe('tool-error:call-3');
      const errorData = JSON.parse(channel.updateCalls[0].message.data);
      expect(errorData.errorText).toBe('API unavailable');
    });

    it('publishes tool-input-error as updateMessage', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'tool-input-start', toolCallId: 'call-4', toolName: 'calc' },
        {
          type: 'tool-input-error',
          toolCallId: 'call-4',
          toolName: 'calc',
          input: 'bad',
          errorText: 'Invalid JSON',
        },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      expect(channel.updateCalls).toHaveLength(1);
      expect(channel.updateCalls[0].message.name).toBe('tool-error:call-4');
    });
  });

  describe('discrete events', () => {
    it.each([
      {
        label: 'file',
        chunk: { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
        expectedName: 'file',
        expectedData: { url: 'https://example.com/img.png', mediaType: 'image/png' },
      },
      {
        label: 'source-url',
        chunk: {
          type: 'source-url',
          sourceId: 'src-1',
          url: 'https://example.com',
          title: 'Example',
        },
        expectedName: 'source-url',
        expectedData: { sourceId: 'src-1', url: 'https://example.com', title: 'Example' },
      },
      {
        label: 'source-document',
        chunk: {
          type: 'source-document',
          sourceId: 'doc-1',
          mediaType: 'application/pdf',
          title: 'Report',
          filename: 'report.pdf',
        },
        expectedName: 'source-document',
        expectedData: {
          sourceId: 'doc-1',
          mediaType: 'application/pdf',
          title: 'Report',
          filename: 'report.pdf',
        },
      },
      {
        label: 'data-*',
        chunk: { type: 'data-progress', data: { percent: 50 }, id: 'p1' },
        expectedName: 'data-progress',
        expectedData: { data: { percent: 50 }, id: 'p1' },
      },
    ] as const)('publishes $label', async ({ chunk, expectedName, expectedData }) => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        chunk as any,
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const call = channel.publishCalls.find((c) => c.message.name === expectedName);
      expect(call).toBeDefined();
      const data = JSON.parse(call!.message.data);
      for (const [key, value] of Object.entries(expectedData)) {
        expect(data[key]).toEqual(value);
      }
    });

    it('publishes transient data-* chunks with both ephemeral and role header', async () => {
      const stream = createChunkStream([
        { type: 'data-progress', data: { percent: 50 }, id: 'p1', transient: true } as any,
      ]);

      await publishToAbly({ channel, stream });

      const dataCall = channel.publishCalls.find((c) => c.message.name === 'data-progress');
      expect(dataCall).toBeDefined();
      expect(dataCall!.message.extras).toEqual({
        ephemeral: true,
        headers: { role: 'assistant' },
      });
    });
  });

  describe('pending append flushing', () => {
    it('flushes pending appends before publishing abort sequence', async () => {
      const controller = new AbortController();

      // Track the order of all operations (publish, append) as they resolve
      const resolveOrder: string[] = [];
      const origAppend = channel.appendMessage.bind(channel);
      const origPublish = channel.publish.bind(channel);

      // Make appends slow so they're still pending when abort fires
      const appendResolvers: (() => void)[] = [];
      channel.appendMessage = ((msg: any, op: any) => {
        const result = origAppend(msg, op);
        const p = new Promise<any>((resolve) => {
          appendResolvers.push(() => {
            resolveOrder.push(`append:${op?.metadata?.event ?? 'unknown'}`);
            resolve(result);
          });
        });
        return p;
      }) as any;

      channel.publish = ((msg: any) => {
        resolveOrder.push(`publish:${msg.name}`);
        return origPublish(msg);
      }) as any;

      // Stream that emits text deltas then blocks (simulating ongoing streaming)
      const stream = new ReadableStream<UIMessageChunk>({
        start(streamController) {
          streamController.enqueue({ type: 'start' });
          streamController.enqueue({ type: 'start-step' });
          streamController.enqueue({ type: 'text-start', id: 'text-0' } as UIMessageChunk);
          streamController.enqueue({
            type: 'text-delta',
            id: 'text-0',
            delta: 'Hello',
          } as UIMessageChunk);
          streamController.enqueue({
            type: 'text-delta',
            id: 'text-0',
            delta: ' world',
          } as UIMessageChunk);
        },
        pull() {
          // Block until abort cancels the reader
          return new Promise<void>(() => {});
        },
      });

      // Start publishing, then abort after a short delay
      const publishPromise = publishToAbly({
        channel: channel as any,
        stream,
        abortSignal: controller.signal,
      });

      // Wait for text-start publish + both text-delta appends to be issued
      await new Promise((r) => setTimeout(r, 50));

      // Now abort
      controller.abort();

      // Resolve the pending appends (simulating network completion)
      for (const resolver of appendResolvers) {
        resolver();
      }

      await publishPromise;

      // The key assertion: all append operations resolved BEFORE any terminal publish
      const firstTerminalIdx = resolveOrder.findIndex(
        (entry) =>
          entry.startsWith('publish:step-finish') ||
          entry.startsWith('publish:finish') ||
          entry.startsWith('publish:abort'),
      );
      const lastAppendIdx = resolveOrder.reduce(
        (max, entry, idx) => (entry.startsWith('append:') ? idx : max),
        -1,
      );

      // All appends should have resolved before the first terminal message
      if (lastAppendIdx >= 0 && firstTerminalIdx >= 0) {
        expect(lastAppendIdx).toBeLessThan(firstTerminalIdx);
      }
    });
  });

  describe('abort signal handling', () => {
    it('publishes abort on signal abort mid-step', async () => {
      const controller = new AbortController();

      // Stream that blocks on pull — simulates waiting for model output
      const stream = new ReadableStream<UIMessageChunk>({
        start(streamController) {
          streamController.enqueue({ type: 'start' });
          streamController.enqueue({ type: 'start-step' });
        },
        pull() {
          // Never resolves — reader.cancel() from abort listener unblocks it
          return new Promise<void>(() => {});
        },
      });

      // Abort after a short delay
      setTimeout(() => controller.abort(), 20);

      await publishToAbly({ channel, stream, abortSignal: controller.signal });

      const publishNames = channel.publishCalls.map((c) => c.message.name);
      expect(publishNames).toEqual(['abort']);
    });

    it('does not double-publish abort when stream emits abort chunk', async () => {
      const controller = new AbortController();

      // Stream emits its own abort chunk, then signal also fires
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'abort' },
      ]);

      // Abort the signal before calling publishToAbly
      controller.abort();

      await publishToAbly({ channel, stream, abortSignal: controller.signal });

      const abortCalls = channel.publishCalls.filter((c) => c.message.name === 'abort');
      expect(abortCalls).toHaveLength(1);
    });

    it('does not publish abort after finish when signal fires late', async () => {
      const controller = new AbortController();

      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream, abortSignal: controller.signal });

      // Signal fires after natural completion
      controller.abort();

      const abortCalls = channel.publishCalls.filter((c) => c.message.name === 'abort');
      expect(abortCalls).toHaveLength(0);

      const finishCalls = channel.publishCalls.filter((c) => c.message.name === 'finish');
      expect(finishCalls).toHaveLength(1);
    });

    it('does not publish abort after error chunk when signal fires late', async () => {
      const controller = new AbortController();

      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'error', errorText: 'model error' },
      ]);

      await publishToAbly({ channel, stream, abortSignal: controller.signal });

      // Signal fires after error terminal
      controller.abort();

      const abortCalls = channel.publishCalls.filter((c) => c.message.name === 'abort');
      expect(abortCalls).toHaveLength(0);

      const errorCalls = channel.publishCalls.filter((c) => c.message.name === 'error');
      expect(errorCalls).toHaveLength(1);
    });

    it('publishes abort when signal is already aborted at call time', async () => {
      const controller = new AbortController();
      controller.abort();

      // Stream with no terminal — abort listener cancels the reader immediately
      const stream = new ReadableStream<UIMessageChunk>({
        start(streamController) {
          streamController.enqueue({ type: 'start' });
        },
        pull() {
          return new Promise<void>(() => {});
        },
      });

      await publishToAbly({ channel, stream, abortSignal: controller.signal });

      const abortCalls = channel.publishCalls.filter((c) => c.message.name === 'abort');
      expect(abortCalls).toHaveLength(1);
    });
  });

  describe('promptId', () => {
    it('includes promptId in extras of all publish, append, and update calls', async () => {
      // Stream that exercises publish, append, and update paths
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'text-start', id: 'text-0' },
        { type: 'text-delta', id: 'text-0', delta: 'Hello' },
        { type: 'text-end', id: 'text-0' },
        { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'search' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-1',
          toolName: 'search',
          input: { q: 'test' },
        },
        { type: 'tool-output-available', toolCallId: 'call-1', output: { results: [] } },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream, promptId: 'prompt-123' });

      for (const call of channel.publishCalls) {
        expect(call.message.extras?.headers?.promptId).toBe('prompt-123');
        expect(call.message.extras?.headers?.role).toBe('assistant');
      }
      for (const call of channel.appendCalls) {
        expect(call.message.extras?.headers?.promptId).toBe('prompt-123');
        expect(call.message.extras?.headers?.role).toBe('assistant');
      }
      for (const call of channel.updateCalls) {
        expect(call.message.extras?.headers?.promptId).toBe('prompt-123');
        expect(call.message.extras?.headers?.role).toBe('assistant');
      }
    });

    it('includes promptId on abort message published after signal abort', async () => {
      const controller = new AbortController();

      const stream = new ReadableStream<UIMessageChunk>({
        start(streamController) {
          streamController.enqueue({ type: 'start' });
        },
        pull() {
          return new Promise<void>(() => {});
        },
      });

      setTimeout(() => controller.abort(), 20);

      await publishToAbly({
        channel,
        stream,
        abortSignal: controller.signal,
        promptId: 'prompt-789',
      });

      const publishNames = channel.publishCalls.map((c) => c.message.name);
      expect(publishNames).toEqual(['abort']);

      for (const call of channel.publishCalls) {
        expect(call.message.extras?.headers?.promptId).toBe('prompt-789');
      }
    });

    it('does not include promptId when not provided', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      for (const call of channel.publishCalls) {
        expect(call.message.extras?.headers?.promptId).toBeUndefined();
        expect(call.message.extras?.headers?.role).toBe('assistant');
      }
    });

    it('includes promptId in non-streaming tool call extras', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-2',
          toolName: 'getTime',
          input: { tz: 'UTC' },
        },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream, promptId: 'prompt-tool' });

      const toolCall = channel.publishCalls.find((c) => c.message.name === 'tool:call-2:getTime');
      expect(toolCall).toBeDefined();
      expect(toolCall!.message.extras?.headers?.promptId).toBe('prompt-tool');
      expect(toolCall!.message.extras?.headers?.event).toBe('tool-input-available');
    });

    it('includes promptId in transient data-* chunk extras', async () => {
      const stream = createChunkStream([
        { type: 'data-progress', data: { percent: 50 }, id: 'p1', transient: true } as any,
      ]);

      await publishToAbly({ channel, stream, promptId: 'prompt-data' });

      const dataCall = channel.publishCalls.find((c) => c.message.name === 'data-progress');
      expect(dataCall).toBeDefined();
      expect(dataCall!.message.extras).toEqual({
        ephemeral: true,
        headers: { role: 'assistant', promptId: 'prompt-data' },
      });
    });
  });

  describe('error handling', () => {
    it('publishes error to channel on stream read error', async () => {
      const errorStream = new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: 'start' });
          controller.enqueue({ type: 'start-step' });
          controller.error(new Error('Stream broke'));
        },
      });

      await expect(publishToAbly({ channel, stream: errorStream })).rejects.toThrow('Stream broke');

      // Should have published error to channel
      const errorCall = channel.publishCalls.find((c) => c.message.name === 'error');
      expect(errorCall).toBeDefined();
      const data = JSON.parse(errorCall!.message.data);
      expect(data.errorText).toBe('Stream broke');
    });
  });
});
