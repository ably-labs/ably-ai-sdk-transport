# @ably/ai-sdk-transport

Drop-in [Ably](https://ably.com) transport for the [Vercel AI SDK](https://sdk.vercel.ai) — replaces HTTP SSE with Ably pub/sub for streaming AI responses.

## Why Ably instead of SSE?

| Concern | HTTP SSE | Ably |
|---|---|---|
| Fan-out | 1:1 (one connection per client) | Built-in: one publish, N subscribers |
| Reconnection | Manual (track last event ID, re-request) | Automatic with message continuity |
| Message persistence | None (ephemeral stream) | Built-in history and rewind |
| Proxy/firewall issues | SSE blocked by some proxies | WebSocket with automatic fallback |
| Mobile background | Connection dropped, stream lost | Automatic resume on foreground |

## Installation

```bash
npm install @ably/ai-sdk-transport ably ai
```

`ably` (≥ 2.6.0) and `ai` (≥ 5.0.0) are peer dependencies.

## Quick Start

### 1. Client — use with `useChat()`

```tsx
import Ably from 'ably';
import { useChat } from 'ai/react';
import { AblyChatTransport } from '@ably/ai-sdk-transport';

const ably = new Ably.Realtime({ authUrl: '/api/ably-token' });

const transport = new AblyChatTransport({
  ably,
  api: '/api/chat',
});

function Chat() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    transport,
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>{m.parts.map((p) => p.type === 'text' && p.text)}</div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
      </form>
    </div>
  );
}
```

### 2. Server — publish AI responses to Ably

```typescript
// app/api/chat/route.ts (Next.js App Router)
import Ably from 'ably';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { publishToAbly } from '@ably/ai-sdk-transport';

const ablyServer = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(req: Request) {
  const { id, messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
  });

  const channel = ablyServer.channels.get(`chat:${id}`);
  const stream = result.toUIMessageStream();

  // Publish in the background — don't block the response
  publishToAbly({ channel, stream });

  return new Response(null, { status: 202 });
}
```

### 3. Ably configuration

Create a token authentication endpoint:

```typescript
// app/api/ably-token/route.ts
import Ably from 'ably';

const ably = new Ably.Rest({ key: process.env.ABLY_API_KEY });

export async function GET() {
  const token = await ably.auth.createTokenRequest({
    clientId: 'user-id',
    capability: { 'chat:*': ['subscribe', 'history'] },
  });
  return Response.json(token);
}
```

## API Reference

### `AblyChatTransport`

Client-side transport implementing the AI SDK's `ChatTransport<UIMessage>` interface.

```typescript
import { AblyChatTransport } from '@ably/ai-sdk-transport';

const transport = new AblyChatTransport(options);
```

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `ably` | `Ably.Realtime` | *required* | Ably Realtime client instance |
| `api` | `string` | `'/api/chat'` | Server endpoint URL |
| `headers` | `Record<string, string>` | `{}` | Default headers for HTTP requests |
| `channelName` | `(chatId: string) => string` | `` chatId => `chat:${chatId}` `` | Custom channel naming function |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation |

#### Methods

- **`sendMessages(options)`** — Subscribes to the Ably channel, sends an HTTP POST to the server, and returns a `ReadableStream<UIMessageChunk>` of the AI response.

- **`reconnectToStream(options)`** — Queries channel history and reattaches to an in-flight stream. Returns `null` if the stream has already completed or no history exists.

### `publishToAbly`

Server-side function that consumes a `UIMessageStream` and publishes it to an Ably channel.

```typescript
import { publishToAbly } from '@ably/ai-sdk-transport';

await publishToAbly(options);
```

#### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `channel` | `Ably.RealtimeChannel` | *required* | Ably channel to publish to |
| `stream` | `ReadableStream<UIMessageChunk>` | *required* | Stream from `toUIMessageStream()` |
| `abortSignal` | `AbortSignal` | — | Signal to abort publishing |

## Reconnection

The transport supports three tiers of reconnection, all handled automatically:

1. **Brief disconnection** — Ably resumes the connection and replays missed messages. No action needed.
2. **Extended disconnection** — The channel is configured with `rewind: '1s'` to catch messages published just before subscription.
3. **App restart / page reload** — Call `reconnectToStream()` to query channel history, replay completed events, and reattach to any in-flight stream.

```typescript
// On page load, check for an active stream
const stream = await transport.reconnectToStream({ chatId: 'chat-123' });
if (stream) {
  // Resume processing the stream
}
```

## Channel Configuration

By default, channels are named `chat:{chatId}`. Customize this with the `channelName` option:

```typescript
const transport = new AblyChatTransport({
  ably,
  channelName: (chatId) => `my-app:conversations:${chatId}`,
});
```

Ensure your Ably token capabilities match the channel namespace you use.

## Examples

### Express server

```typescript
import express from 'express';
import Ably from 'ably';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { publishToAbly } from '@ably/ai-sdk-transport';

const app = express();
const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

app.post('/api/chat', express.json(), async (req, res) => {
  const { id, messages } = req.body;

  const result = streamText({
    model: openai('gpt-4o'),
    messages,
  });

  const channel = ably.channels.get(`chat:${id}`);
  publishToAbly({ channel, stream: result.toUIMessageStream() });

  res.status(202).end();
});

app.listen(3000);
```

### With tools

```typescript
const result = streamText({
  model: openai('gpt-4o'),
  messages,
  tools: {
    search: {
      description: 'Search the web',
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        return { results: await searchWeb(query) };
      },
    },
  },
});

// Tool calls, inputs, and outputs are all streamed through Ably
publishToAbly({ channel, stream: result.toUIMessageStream() });
```

## Contributing

```bash
npm install
npm run build        # Build ESM + CJS + types
npm run typecheck    # TypeScript type checking
npm test             # Run tests
npm run test:coverage # Run tests with coverage
```

## License

Apache-2.0
