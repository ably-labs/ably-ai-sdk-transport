# Minimal Chat

A working demo of [`@ably/ai-sdk-transport`](../../README.md) with Next.js and Claude — streaming AI responses through Ably pub/sub.

## Prerequisites

- Node.js 18+
- An [Ably account](https://ably.com/sign-up) (free tier works)
- An [Anthropic API key](https://console.anthropic.com/)

## Ably setup

1. Create or select an app in the [Ably dashboard](https://ably.com/accounts)
2. Go to **Configuration** > **Rules** and add a rule for namespace `ait` with feature **Message annotations, updates, appends, and deletes** enabled
3. Copy your API key from the **API Keys** tab

> Mutable messages must be enabled for streaming to work. See the [main README](../../README.md#ably-configuration) for details.

## Running the example

```bash
# 1. Build the parent library (from the repo root)
npm install
npm run build

# 2. Set up the example
cd examples/minimal-chat
cp .env.local.example .env.local
# Edit .env.local and fill in your ABLY_API_KEY and ANTHROPIC_API_KEY

# 3. Install dependencies and start
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## What to try

- Send a message and watch the streamed response
- Refresh the page mid-stream — history loads and the stream resumes
- Open a second tab with the same URL — both see the same conversation
- Check the "Agent connected" indicator — it reflects server-side presence

## Project structure

```
app/
├── layout.tsx                  # Root layout with AblyProvider
├── providers.tsx               # Client-side Ably Realtime setup
├── page.tsx                    # Chat UI: useChat + AblyChatTransport + history + presence
├── globals.css                 # Styles
└── api/
    ├── invite-agent/route.ts   # Server: subscribeToChannel + streamText (Claude)
    └── ably-token/route.ts     # JWT token auth endpoint
```

## How it works

1. **`providers.tsx`** creates an `Ably.Realtime` client with `authUrl: '/api/ably-token'` and wraps the app in `AblyProvider`.

2. **`page.tsx`** wraps the chat in a `ChannelProvider` and uses the `useChannel` hook to get a channel instance with connection-state-aware attachment. It passes the channel to `AblyChatTransport`, then POSTs to `/api/invite-agent` to tell the server which channel to subscribe to. On mount it calls `loadChatHistory()` to restore previous messages and `resumeStream()` if a response was mid-flight. It also monitors agent presence with `onAgentPresenceChange()`.

3. **`api/invite-agent/route.ts`** calls `subscribeToChannel()` with a handler that runs `streamText()` with Claude and returns the UI message stream. The server enters presence so the client can show agent connectivity status.

4. **`api/ably-token/route.ts`** signs an Ably JWT with `publish`, `subscribe`, `history`, and `presence` capabilities on the `ait:*` namespace.

## Environment variables

| Variable | Description |
|---|---|
| `ABLY_API_KEY` | Your Ably API key (from the [Ably dashboard](https://ably.com/accounts)) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (from [console.anthropic.com](https://console.anthropic.com/)) |
