'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';
import * as Ably from 'ably';
import { AblyChatTransport, debugStream } from '@ably/ai-sdk-transport';

const inner = new AblyChatTransport({
  ably: new Ably.Realtime({
    authUrl: '/api/ably-token',
    autoConnect: typeof window !== 'undefined',
  }),
  api: '/api/chat',
  channelName: () => `ait:myAppChat`,
});

// Wrap the transport so every event gets debug-logged to the console
const transport = {
  sendMessages: async (...args: Parameters<typeof inner.sendMessages>) => {
    const stream = await inner.sendMessages(...args);
    return debugStream(stream, 'send');
  },
  reconnectToStream: async (...args: Parameters<typeof inner.reconnectToStream>) => {
    const stream = await inner.reconnectToStream(...args);
    return stream ? debugStream(stream, 'reconnect') : null;
  },
};

export default function Chat() {
  const { messages, sendMessage } = useChat({ transport });
  const [input, setInput] = useState('');

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem' }}>
      <h1>Minimal Chat</h1>

      <div style={{ marginBottom: '1rem' }}>
        {messages.map((m) => (
          <div key={m.id} style={{ marginBottom: '0.5rem' }}>
            <strong>{m.role === 'user' ? 'You' : 'Assistant'}:</strong>{' '}
            {m.parts
              .filter((p) => p.type === 'text')
              .map((p, i) => (
                <span key={i}>{p.text}</span>
              ))}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          sendMessage({ text: input });
          setInput('');
        }}
        style={{ display: 'flex', gap: '0.5rem' }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something..."
          style={{ flex: 1, padding: '0.5rem' }}
        />
        <button type="submit" style={{ padding: '0.5rem 1rem' }}>
          Send
        </button>
      </form>
    </main>
  );
}
