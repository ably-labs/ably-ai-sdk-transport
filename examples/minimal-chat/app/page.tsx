'use client';

import { useChat } from '@ai-sdk/react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import * as Ably from 'ably';
import { AblyChatTransport } from '@ably/ai-sdk-transport';

const DEFAULT_CHANNEL = 'ait:myChatApp';

export default function Chat() {
  // Get the channel name from query params or default
  const searchParams = useSearchParams();
  const channelName = searchParams.get('channel') || DEFAULT_CHANNEL;

  const transport = useMemo(() => {
    return new AblyChatTransport({
      ably: new Ably.Realtime({
        authUrl: '/api/ably-token',
        autoConnect: typeof window !== 'undefined',
      }),
      channelName, // transport supports exactly one channel.
    });
  }, [channelName]);

  useEffect(() => {
    return () => transport.close();
  }, [transport]);

  // Tell the server to subscribe to this channel
  useEffect(() => {
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelName }),
    }).catch((err) => console.error('Failed to start server subscription:', err));
  }, [channelName]);

  // optionally wrap the transport for debug logging
  // transport = debugTransport(transport)

  const { messages, sendMessage, setMessages, resumeStream } = useChat({ transport });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Load history on mount and when transport changes
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    transport.loadChatHistory()
      .then((result) => {
        if (cancelled) return;
        if (result.messages.length > 0) {
          setMessages(result.messages);
        }
        if (result.hasActiveStream) {
          resumeStream();
        }
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [transport, setMessages, resumeStream]);

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: '2rem' }}>
      <h1>Minimal Chat</h1>

      {isLoading && (
        <div style={{ marginBottom: '1rem', color: '#888' }}>Loading history...</div>
      )}

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
