'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { useChannel} from 'ably/react';
import { ChannelProvider } from 'ably/react';
import { AblyChatTransport } from '@ably/ai-sdk-transport';
import ReactMarkdown from 'react-markdown';

const DEFAULT_CHANNEL = 'ait:myChatApp';

function Chat() {
  const searchParams = useSearchParams();
  const channelName = searchParams.get('channel') || DEFAULT_CHANNEL;

  return (
    <ChannelProvider channelName={channelName}>
      <ChatWithChannel channelName={channelName} />
    </ChannelProvider>
  );
}

function ChatWithChannel({ channelName }: { channelName: string }) {
  // useChannel wires up useChannelAttach internally, which handles
  // connection-state-aware attachment and auto-re-attachment on reconnect.
  const { channel } = useChannel(channelName);

  // Create transport in useEffect so each mount/remount gets a fresh instance.
  // useMemo would return the same (closed) instance after strict-mode cleanup.
  const [transport, setTransport] = useState<AblyChatTransport | null>(null);

  useEffect(() => {
    const t = new AblyChatTransport({ channel, logger: console });
    setTransport(t);
    return () => t.close();
  }, [channel]);

  // Tell the server to subscribe to this channel
  useEffect(() => {
    fetch('/api/invite-agent', {
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
  const [reconnecting, setReconnecting] = useState(false);

  // Keep a ref so the history effect can call the latest resumeStream
  // without needing it in the dependency array (its reference isn't stable).
  const resumeStreamRef = useRef(resumeStream);
  resumeStreamRef.current = resumeStream;

  // Observe agent presence
  useEffect(() => {
    return transport.onAgentPresenceChange(setAgentConnected);
  }, [transport]);

  // Load history on mount and when transport changes.
  // resumeStream() must be awaited before allowing sends — concurrent
  // makeRequest calls in the AI SDK share activeResponse and will clobber
  // each other if they overlap.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const result = await transport.loadChatHistory();
        if (cancelled) return;
        if (result.messages.length > 0) {
          setMessages(result.messages);
        }
        if (result.hasActiveStream) {
          await resumeStreamRef.current();
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport]);

  const handleReconnect = async () => {
    setReconnecting(true);
    try {
      await fetch('/api/invite-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelName }),
      });
    } catch (err) {
      console.error('Failed to reconnect:', err);
    } finally {
      setReconnecting(false);
    }
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
            <button onClick={handleReconnect} className="reconnect-button" disabled={reconnecting}>
              {reconnecting ? 'Reconnecting...' : 'Reconnect'}
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
          disabled={isLoading}
        />
        <button type="submit" className="chat-button" disabled={isLoading}>
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
