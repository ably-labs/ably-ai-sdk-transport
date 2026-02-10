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

      const finishCall = channel.publishCalls.find(
        (c) => c.message.name === 'finish',
      );
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

      const finishCall = channel.publishCalls.find(
        (c) => c.message.name === 'finish',
      );
      const data = JSON.parse(finishCall!.message.data);
      expect(data.messageMetadata).toEqual({ custom: 'data' });
    });

    it('publishes abort', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'abort' },
      ]);

      await publishToAbly({ channel, stream });

      const abortCall = channel.publishCalls.find(
        (c) => c.message.name === 'abort',
      );
      expect(abortCall).toBeDefined();
    });

    it('publishes error', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'error', errorText: 'Something went wrong' },
      ]);

      await publishToAbly({ channel, stream });

      const errorCall = channel.publishCalls.find(
        (c) => c.message.name === 'error',
      );
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

      const metaCall = channel.publishCalls.find(
        (c) => c.message.name === 'metadata',
      );
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
      const createCall = channel.publishCalls.find(
        (c) => c.message.name === 'text:text-0',
      );
      expect(createCall).toBeDefined();
      expect(createCall!.message.data).toBe('');

      // Verify appends
      expect(channel.appendCalls).toHaveLength(3); // 2 deltas + 1 end
      expect(channel.appendCalls[0].message.data).toBe('Hello');
      expect(channel.appendCalls[0].operation?.metadata?.event).toBe(
        'text-delta',
      );
      expect(channel.appendCalls[1].message.data).toBe(' world');
      expect(channel.appendCalls[2].message.data).toBe('');
      expect(channel.appendCalls[2].operation?.metadata?.event).toBe(
        'text-end',
      );
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

      const createCall = channel.publishCalls.find(
        (c) => c.message.name === 'reasoning:r-0',
      );
      expect(createCall).toBeDefined();

      expect(channel.appendCalls).toHaveLength(2);
      expect(channel.appendCalls[0].message.data).toBe('thinking...');
      expect(channel.appendCalls[0].operation?.metadata?.event).toBe(
        'reasoning-delta',
      );
      expect(channel.appendCalls[1].message.data).toBe('');
      expect(channel.appendCalls[1].operation?.metadata?.event).toBe(
        'reasoning-end',
      );
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
      const createCall = channel.publishCalls.find(
        (c) => c.message.name === 'tool:call-1:search',
      );
      expect(createCall).toBeDefined();

      // Delta appends (2) + end append (1)
      expect(channel.appendCalls).toHaveLength(3);
      expect(channel.appendCalls[0].message.data).toBe('{"query":');
      expect(channel.appendCalls[1].message.data).toBe('"test"}');
      expect(channel.appendCalls[2].message.data).toBe('');
      expect(channel.appendCalls[2].operation?.metadata?.event).toBe(
        'tool-input-end',
      );

      // Update for output
      expect(channel.updateCalls).toHaveLength(1);
      expect(channel.updateCalls[0].message.name).toBe(
        'tool-output:call-1',
      );
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
      const createCall = channel.publishCalls.find(
        (c) => c.message.name === 'tool:call-2:getTime',
      );
      expect(createCall).toBeDefined();
      expect(createCall!.message.extras?.headers?.event).toBe(
        'tool-input-available',
      );
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
    it('publishes file', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'file', url: 'https://example.com/img.png', mediaType: 'image/png' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const fileCall = channel.publishCalls.find(
        (c) => c.message.name === 'file',
      );
      expect(fileCall).toBeDefined();
      const data = JSON.parse(fileCall!.message.data);
      expect(data.url).toBe('https://example.com/img.png');
      expect(data.mediaType).toBe('image/png');
    });

    it('publishes source-url', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        {
          type: 'source-url',
          sourceId: 'src-1',
          url: 'https://example.com',
          title: 'Example',
        },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const srcCall = channel.publishCalls.find(
        (c) => c.message.name === 'source-url',
      );
      expect(srcCall).toBeDefined();
      const data = JSON.parse(srcCall!.message.data);
      expect(data.sourceId).toBe('src-1');
      expect(data.url).toBe('https://example.com');
      expect(data.title).toBe('Example');
    });

    it('publishes source-document', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        {
          type: 'source-document',
          sourceId: 'doc-1',
          mediaType: 'application/pdf',
          title: 'Report',
          filename: 'report.pdf',
        },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const docCall = channel.publishCalls.find(
        (c) => c.message.name === 'source-document',
      );
      expect(docCall).toBeDefined();
      const data = JSON.parse(docCall!.message.data);
      expect(data.sourceId).toBe('doc-1');
      expect(data.filename).toBe('report.pdf');
    });

    it('publishes data-* chunks', async () => {
      const stream = createChunkStream([
        { type: 'start' },
        { type: 'start-step' },
        { type: 'data-progress', data: { percent: 50 }, id: 'p1' } as any,
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]);

      await publishToAbly({ channel, stream });

      const dataCall = channel.publishCalls.find(
        (c) => c.message.name === 'data-progress',
      );
      expect(dataCall).toBeDefined();
      const data = JSON.parse(dataCall!.message.data);
      expect(data.data).toEqual({ percent: 50 });
      expect(data.id).toBe('p1');
    });

    it('publishes transient data-* chunks with both ephemeral and role header', async () => {
      const stream = createChunkStream([
        { type: 'data-progress', data: { percent: 50 }, id: 'p1', transient: true } as any,
      ]);

      await publishToAbly({ channel, stream });

      const dataCall = channel.publishCalls.find(
        (c) => c.message.name === 'data-progress',
      );
      expect(dataCall).toBeDefined();
      expect(dataCall!.message.extras).toEqual({
        ephemeral: true,
        headers: { role: 'assistant' },
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

      await expect(
        publishToAbly({ channel, stream: errorStream }),
      ).rejects.toThrow('Stream broke');

      // Should have published error to channel
      const errorCall = channel.publishCalls.find(
        (c) => c.message.name === 'error',
      );
      expect(errorCall).toBeDefined();
      const data = JSON.parse(errorCall!.message.data);
      expect(data.errorText).toBe('Stream broke');
    });
  });
});
