# @ably/ai-sdk-transport

Drop-in [Ably](https://ably.com) transport for the [Vercel AI SDK](https://sdk.vercel.ai) — replaces HTTP SSE with persistent, resumable AI chat sessions over Ably pub/sub.

## Why Ably instead of the default transport?

| Scenario | Default Transport (HTTP/SSE) | Ably AI Transport |
|---|---|---|
| Connection drops mid-stream | Response lost; user must re-send | Stream resumes automatically |
| Page refresh during response | Response lost | Reconnects and continues from where it left off |
| Multiple tabs / devices | Each tab is independent | All see the same live conversation |
| User sends a message | HTTP POST to server | Published on Ably channel; server subscribes |
| Conversation history | Build your own persistence layer | Built-in via Ably channel history |
| Cancel / stop generation | Abort HTTP request | Cancel propagated to server via channel |
| Observability | Server logs only | All events (text, tool calls, reasoning) visible on channel |

## Installation

```bash
npm install @ably/ai-sdk-transport ably ai
```

`ably` (>= 2.6.0) and `ai` (>= 6.0.0) are peer dependencies.

## Quick Start

### 1. Prerequisites — Ably setup

1. Create or select an app in the [Ably dashboard](https://ably.com/accounts)
2. Go to **Settings** > **Channel Rules** and add a rule for namespace `ait`
3. Enable **Message interactions (annotations, updates, deletes, and appends)**
4. Copy your API key from the **API Keys** tab

> This transport uses Ably's [mutable messages](https://ably.com/docs/messages/mutable) feature to stream AI responses incrementally. Streaming will not work without the channel rule configured.

### 2. Client — use with `useChat()`

```tsx
import Ably from 'ably';
import { useChat } from '@ai-sdk/react';
import { AblyChatTransport } from '@ably/ai-sdk-transport';

// 1. Create the transport
const ably = new Ably.Realtime({ authUrl: '/api/ably-token' });
const transport = new AblyChatTransport({ ably, channelName: 'ait:my-chat' });

// 2. Pass it to useChat — replaces the default HTTP transport
const { messages, sendMessage, setMessages, resumeStream } = useChat({ transport });

// 3. Load history and resume any in-progress stream
const { messages: history, hasActiveStream } = await transport.loadChatHistory();
if (history.length > 0) setMessages(history);
if (hasActiveStream) resumeStream();
```

The client publishes messages directly to the Ably channel — no message payload travels over HTTP. A separate `POST` to `/api/chat` tells the server which channel to subscribe to. See [`examples/minimal-chat/`](./examples/minimal-chat/) for a complete working example.

### 3. Server — subscribe and respond

```typescript
import Ably from 'ably';
import { streamText, convertToModelMessages } from 'ai';
import { openai } from '@ai-sdk/openai';
import { subscribeToChannel } from '@ably/ai-sdk-transport';

const ably = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(request: Request) {
  const { channelName } = await request.json();
  const channel = ably.channels.get(channelName);

  const cleanup = await subscribeToChannel({
    channel,
    presence: {},
    handler: async ({ messages, abortSignal }) => {
      const result = streamText({
        model: openai('gpt-4o'),
        messages: await convertToModelMessages(messages),
        abortSignal,
      });
      return result.toUIMessageStream();
    },
  });

  return new Response('OK', { status: 200 });
}
```

The server subscribes to the Ably channel and waits for client messages. When a message arrives, the `handler` is called with the full conversation history. The response stream is published back through the same channel.

### 4. Token authentication

```typescript
import jwt from 'jsonwebtoken';

export async function GET() {
  const apiKey = process.env.ABLY_API_KEY!;
  const [keyName, keySecret] = apiKey.split(':');

  const token = jwt.sign(
    {
      'x-ably-capability': JSON.stringify({
        'ait:*': ['publish', 'subscribe', 'history', 'presence'],
      }),
    },
    keySecret,
    { algorithm: 'HS256', keyid: keyName, expiresIn: '1h' },
  );

  return new Response(token, {
    headers: { 'Content-Type': 'application/jwt' },
  });
}
```

Clients need four capabilities: `publish` (send messages), `subscribe` (receive responses), `history` (load past messages), and `presence` (detect agent connectivity).

## How it works

```
Client (browser)                         Server (Node.js)
     |                                        |
     |-- publish "chat-message" ------------->|
     |                                        |-- handler() called
     |                                        |-- streamText() generates response
     |<--- message.create (text:abc) ---------|-- response streamed as Ably messages
     |<--- message.append (delta) ------------|
     |<--- message.append (delta) ------------|
     |<--- finish ----------------------------|
```

Both client and server connect to the same Ably channel. The client publishes user messages; the server publishes AI responses. Echo filtering prevents each side from processing its own messages.

Ably's [mutable messages](https://ably.com/docs/messages/mutable) (`message.create` / `message.append` / `message.update`) enable efficient incremental streaming — text deltas are appended to a single message rather than publishing thousands of individual messages.

## Features

### Chat history

History is fetched using `channel.history({ untilAttach: true })`, which provides a clean boundary between pre-existing messages and live ones. Channel history persists for 24–72 hours depending on your Ably plan.

### Stream reconnection

The transport handles reconnection at three levels:

1. **Brief disconnect (< 2 min)** — Ably automatically resumes the connection and replays missed messages. No application code needed.
2. **Extended disconnect** — `loadChatHistory()` fetches everything published while the client was offline. `hasActiveStream` tells you whether to call `resumeStream()`.
3. **Page reload** — Same as (2). Load history, check `hasActiveStream`, resume if needed.

### Agent presence

Detect whether the server-side agent is connected:

```typescript
// Client
const unsubscribe = transport.onAgentPresenceChange((isPresent) => {
  console.log(isPresent ? 'Agent online' : 'Agent offline');
});
```

Server-side, pass `presence: {}` to `subscribeToChannel()` to automatically enter presence on the channel.

### Cancellation

When the user calls `stop()` via the AI SDK, the transport publishes a `user-abort` event on the channel. The server's `subscribeToChannel()` handler receives it and aborts the in-flight `streamText()` call via the `abortSignal`, stopping token generation and saving LLM costs.

### Debugging

Wrap the transport to log every chunk to the console:

```typescript
import { AblyChatTransport, debugTransport } from '@ably/ai-sdk-transport';

const transport = new AblyChatTransport({ ably, channelName: 'ait:my-chat' });
const { messages } = useChat({ transport: debugTransport(transport) });
```

Or debug an individual stream with `debugStream(stream)`.

## Ably configuration

### Mutable messages

This transport requires Ably's mutable messages feature. It uses `message.create` to start a content stream, `message.append` to add text deltas, and `message.update` to finalize tool results. Without mutable messages enabled on the channel namespace, streaming will not work.

To enable: Ably dashboard > your app > **Settings** > **Channel Rules** > add a rule for your namespace (default: `ait`) > enable **Message interactions**.

### Channel namespace

The default convention is to prefix channel names with `ait:` (e.g., `ait:my-chat`). Your Ably channel rule namespace must match whatever prefix you use in `channelName`.

### Token capabilities

Client tokens need four capabilities on the channel namespace:

| Capability | Purpose |
|---|---|
| `publish` | Send user messages and abort signals |
| `subscribe` | Receive AI responses |
| `history` | Load conversation history |
| `presence` | Detect agent connectivity |

## Limitations of the Vercel AI SDK

1. **Single user, single device.** Multiple tabs and devices receive the same streamed responses via Ably, but the AI SDK's `useChat` hook expects a request-response pattern. This means that the UI SDK cannot handle responses and messages triggered on another device or by another user. 

2. **One response at a time.** The AI SDK does not support concurrent assistant responses. Sending a new message while a response is streaming will abort the in-progress stream.

3. **Persistent server required.** `subscribeToChannel()` maintains a long running in-memory subscription to Ably. Serverless environments (Vercel Functions, AWS Lambda) lose state on cold starts, or are not long running. For production, run the agent subscriber in a persistent process.

## Examples

See [`examples/minimal-chat/`](./examples/minimal-chat/) for a complete Next.js App Router example with chat history, stream reconnection, and agent presence detection.

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
