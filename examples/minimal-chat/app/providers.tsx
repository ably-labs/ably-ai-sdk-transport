'use client';

import { useEffect, useMemo, useState } from 'react';
import * as Ably from 'ably';
import { AblyProvider } from 'ably/react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const client = useMemo(
    () => (mounted ? new Ably.Realtime({ authUrl: '/api/ably-token' }) : null),
    [mounted],
  );

  if (!client) return null;

  return <AblyProvider client={client}>{children}</AblyProvider>;
}
