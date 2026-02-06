# Minimal Chat

A minimal working example demonstrating `@ably/ai-sdk-transport` end-to-end: a Next.js app with a chat UI that streams Claude responses through Ably pub/sub.

## Files

```
examples/minimal-chat/
├── package.json              # Dependencies with file:../.. link to parent
├── .env.local.example        # ABLY_API_KEY + ANTHROPIC_API_KEY placeholders
├── tsconfig.json             # Standard Next.js App Router TS config
├── next.config.ts            # Minimal Next.js config
└── app/
    ├── layout.tsx            # Root layout shell
    ├── page.tsx              # Client: useChat + AblyChatTransport
    └── api/
        ├── chat/route.ts     # Server: streamText + publishToAbly
        └── ably-token/route.ts  # Token auth endpoint
```

## How it works

- **`page.tsx`** — `'use client'` component that creates `Ably.Realtime` with `authUrl` and `AblyChatTransport` in `useMemo`, passes `transport` to `useChat()`, renders messages via `m.parts` filtering for text parts
- **`api/chat/route.ts`** — Module-scoped Ably Realtime client, POST handler parses `{ id, messages }`, calls `streamText` with `anthropic('claude-sonnet-4-20250514')`, publishes via `publishToAbly`, returns `202`
- **`api/ably-token/route.ts`** — Module-scoped Ably Rest client, GET handler creates token request with `clientId: 'anonymous'`

## Running

```sh
# Build the parent library (from repo root)
npm run build

# Set up the example
cd examples/minimal-chat
cp .env.local.example .env.local   # fill in your keys
npm install
npm run dev
```

Open http://localhost:3000, type a message, and see Claude's streamed response.
