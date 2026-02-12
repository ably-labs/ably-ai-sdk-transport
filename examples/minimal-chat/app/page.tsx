'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { useAbly } from 'ably/react';
import { AblyChatTransport } from '@ably/ai-sdk-transport';
import ReactMarkdown from 'react-markdown';

const DEFAULT_CHANNEL = 'ait:myChatApp';

function Chat() {
  const searchParams = useSearchParams();
  const channelName = searchParams.get('channel') || DEFAULT_CHANNEL;
  const ably = useAbly();

  // Create transport in useEffect so each mount/remount gets a fresh instance.
  // useMemo would return the same (closed) instance after strict-mode cleanup.
  const [transport, setTransport] = useState<AblyChatTransport | null>(null);

  useEffect(() => {
    const t = new AblyChatTransport({ ably, channelName, logger: console });
    setTransport(t);
    return () => t.close();
  }, [ably, channelName]);

  // Tell the server to subscribe to this channel
  useEffect(() => {
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelName }),
    }).catch((err) => console.error('Failed to start server subscription:', err));
  }, [channelName]);

  if (!transport) return null;

  return <ChatView transport={transport} channelName={channelName} />;
}

function ChatView({ transport, channelName }: { transport: AblyChatTransport; channelName: string }) {
  const { messages, sendMessage, setMessages, resumeStream } = useChat({ transport });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [agentConnected, setAgentConnected] = useState<boolean | null>(null);

  // Observe agent presence
  useEffect(() => {
    return transport.onAgentPresenceChange(setAgentConnected);
  }, [transport]);

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

  const handleReconnect = () => {
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelName }),
    }).catch((err) => console.error('Failed to reconnect:', err));
  };

  return (
    <main className="chat-container">
      <h1>Minimal Chat</h1>

      <div className="agent-status">
        {agentConnected === null && (
          <span className="status-checking">Checking agent...</span>
        )}
        {agentConnected === true && (
          <span className="status-connected">Agent connected</span>
        )}
        {agentConnected === false && (
          <span className="status-disconnected">
            Agent disconnected
            <button onClick={handleReconnect} className="reconnect-button">
              Reconnect
            </button>
          </span>
        )}
      </div>

      {isLoading && (
        <div className="loading-indicator">Loading history...</div>
      )}

      <div className="chat-messages">
        {messages.map((m) => (
          <div key={m.id} className="chat-message">
            <strong>{m.role === 'user' ? 'You' : 'Assistant'}:</strong>{' '}
            {m.parts
              .filter((p) => p.type === 'text')
              .map((p, i) => (
                <ReactMarkdown key={i}>{p.text}</ReactMarkdown>
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
        className="chat-form"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Say something..."
          className="chat-input"
        />
        <button type="submit" className="chat-button">
          Send
        </button>
      </form>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}
