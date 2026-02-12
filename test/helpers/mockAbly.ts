import type * as Ably from 'ably';

interface PublishCall {
  message: Ably.Message;
}

interface AppendCall {
  message: Ably.Message;
  operation?: Ably.MessageOperation;
}

interface UpdateCall {
  message: Ably.Message;
  operation?: Ably.MessageOperation;
}

type MessageListener = (message: Ably.InboundMessage) => void;
type StateListener = (stateChange: Ably.ChannelStateChange) => void;
type PresenceListener = (message: Ably.PresenceMessage) => void;

let serialCounter = 0;

export function resetSerialCounter(): void {
  serialCounter = 0;
}

function nextSerial(): string {
  serialCounter++;
  return `serial-${String(serialCounter).padStart(4, '0')}`;
}

export interface MockPresence {
  enterClientCalls: Array<{ clientId: string; data?: any }>;
  leaveClientCalls: Array<{ clientId: string; data?: any }>;
  members: Map<string, Ably.PresenceMessage>;
  enterListeners: PresenceListener[];
  leaveListeners: PresenceListener[];
  simulateEnter: (member: Partial<Ably.PresenceMessage>) => void;
  simulateLeave: (member: Partial<Ably.PresenceMessage>) => void;
  subscribe: (
    action: Ably.PresenceAction | Ably.PresenceAction[],
    listener?: PresenceListener,
  ) => Promise<void>;
  unsubscribe: (
    action: Ably.PresenceAction | Ably.PresenceAction[],
    listener?: PresenceListener,
  ) => void;
  get: (params?: any) => Promise<Ably.PresenceMessage[]>;
  enterClient: (clientId: string, data?: any) => Promise<void>;
  leaveClient: (clientId: string, data?: any) => Promise<void>;
  enter: (data?: any) => Promise<void>;
  leave: (data?: any) => Promise<void>;
}

export function createMockPresence(): MockPresence {
  const members = new Map<string, Ably.PresenceMessage>();
  const enterListeners: PresenceListener[] = [];
  const leaveListeners: PresenceListener[] = [];
  const enterClientCalls: Array<{ clientId: string; data?: any }> = [];
  const leaveClientCalls: Array<{ clientId: string; data?: any }> = [];

  function makePresenceMessage(partial: Partial<Ably.PresenceMessage>): Ably.PresenceMessage {
    return {
      action: partial.action ?? 'enter',
      clientId: partial.clientId ?? 'unknown',
      connectionId: partial.connectionId ?? `conn-${partial.clientId ?? 'unknown'}`,
      data: partial.data ?? null,
      encoding: partial.encoding ?? '',
      extras: partial.extras ?? null,
      id: partial.id ?? `presence-${Date.now()}`,
      timestamp: partial.timestamp ?? Date.now(),
      ...partial,
    } as Ably.PresenceMessage;
  }

  return {
    enterClientCalls,
    leaveClientCalls,
    members,
    enterListeners,
    leaveListeners,

    simulateEnter(partial: Partial<Ably.PresenceMessage>) {
      const msg = makePresenceMessage({ action: 'enter', ...partial });
      members.set(msg.connectionId, msg);
      for (const listener of [...enterListeners]) {
        listener(msg);
      }
    },

    simulateLeave(partial: Partial<Ably.PresenceMessage>) {
      const msg = makePresenceMessage({ action: 'leave', ...partial });
      members.delete(msg.connectionId);
      for (const listener of [...leaveListeners]) {
        listener(msg);
      }
    },

    subscribe(
      action: Ably.PresenceAction | Ably.PresenceAction[],
      listener?: PresenceListener,
    ): Promise<void> {
      if (!listener) return Promise.resolve();
      const actions = Array.isArray(action) ? action : [action];
      for (const a of actions) {
        if (a === 'enter') enterListeners.push(listener);
        if (a === 'leave') leaveListeners.push(listener);
      }
      return Promise.resolve();
    },

    unsubscribe(
      action: Ably.PresenceAction | Ably.PresenceAction[],
      listener?: PresenceListener,
    ): void {
      const actions = Array.isArray(action) ? action : [action];
      for (const a of actions) {
        if (a === 'enter' && listener) {
          const idx = enterListeners.indexOf(listener);
          if (idx !== -1) enterListeners.splice(idx, 1);
        }
        if (a === 'leave' && listener) {
          const idx = leaveListeners.indexOf(listener);
          if (idx !== -1) leaveListeners.splice(idx, 1);
        }
      }
    },

    get(): Promise<Ably.PresenceMessage[]> {
      return Promise.resolve([...members.values()]);
    },

    enterClient(clientId: string, data?: any): Promise<void> {
      enterClientCalls.push({ clientId, data });
      const msg = makePresenceMessage({
        clientId,
        data,
        action: 'enter',
        connectionId: `conn-${clientId}`,
      });
      members.set(msg.connectionId, msg);
      return Promise.resolve();
    },

    leaveClient(clientId: string, data?: any): Promise<void> {
      leaveClientCalls.push({ clientId, data });
      members.delete(`conn-${clientId}`);
      return Promise.resolve();
    },

    enter(): Promise<void> {
      return Promise.resolve();
    },

    leave(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export function createMockChannel(): Ably.RealtimeChannel & {
  publishCalls: PublishCall[];
  appendCalls: AppendCall[];
  updateCalls: UpdateCall[];
  simulateMessage: (message: Partial<Ably.InboundMessage>) => void;
  simulateStateChange: (stateChange: Partial<Ably.ChannelStateChange>) => void;
  listeners: MessageListener[];
  stateListeners: Map<string, StateListener[]>;
  lastHistoryParams: { untilAttach?: boolean; limit?: number } | undefined;
} {
  const listeners: MessageListener[] = [];
  const stateListeners = new Map<string, StateListener[]>();
  const publishCalls: PublishCall[] = [];
  const appendCalls: AppendCall[] = [];
  const updateCalls: UpdateCall[] = [];

  // Track published serials for history simulation
  const publishedMessages: Ably.InboundMessage[] = [];

  const channel = {
    name: 'test-channel',
    publishCalls,
    appendCalls,
    updateCalls,
    listeners,
    stateListeners,
    publishedMessages,

    subscribe(
      listenerOrEvent: unknown,
      maybeListener?: unknown,
    ): Promise<Ably.ChannelStateChange | null> {
      if (typeof listenerOrEvent === 'function') {
        listeners.push(listenerOrEvent as MessageListener);
      } else if (typeof maybeListener === 'function') {
        listeners.push(maybeListener as MessageListener);
      }
      return Promise.resolve(null);
    },

    unsubscribe() {
      listeners.length = 0;
    },

    publish(nameOrMessage: unknown): Promise<Ably.PublishResult> {
      let msg: Ably.Message;
      if (typeof nameOrMessage === 'object' && nameOrMessage !== null) {
        msg = nameOrMessage as Ably.Message;
      } else {
        msg = { name: nameOrMessage as string };
      }
      publishCalls.push({ message: msg });
      const serial = nextSerial();

      // Store for history
      publishedMessages.push({
        ...msg,
        serial,
        action: 'message.create',
        id: serial,
        timestamp: Date.now(),
        version: { serial, timestamp: Date.now() },
        annotations: { summary: {} },
      } as Ably.InboundMessage);

      return Promise.resolve({ serials: [serial] });
    },

    appendMessage(
      message: Ably.Message,
      operation?: Ably.MessageOperation,
    ): Promise<Ably.UpdateDeleteResult> {
      appendCalls.push({ message, operation });

      // Update published message data for history simulation
      const existing = publishedMessages.find((m) => m.serial === message.serial);
      if (existing) {
        const existingData = typeof existing.data === 'string' ? existing.data : '';
        const appendData = typeof message.data === 'string' ? message.data : '';
        existing.data = existingData + appendData;
        if (operation?.metadata) {
          existing.version = {
            ...existing.version,
            serial: nextSerial(),
            timestamp: Date.now(),
            metadata: operation.metadata,
          };
        }
      }

      return Promise.resolve({
        serial: message.serial!,
        version: nextSerial(),
      } as unknown as Ably.UpdateDeleteResult);
    },

    updateMessage(
      message: Ably.Message,
      operation?: Ably.MessageOperation,
    ): Promise<Ably.UpdateDeleteResult> {
      updateCalls.push({ message, operation });

      // Update in published messages
      const existing = publishedMessages.find((m) => m.serial === message.serial);
      if (existing) {
        if (message.name) existing.name = message.name;
        if (message.data !== undefined) existing.data = message.data;
        existing.action = 'message.update';
      }

      return Promise.resolve({
        serial: message.serial!,
        version: nextSerial(),
      } as unknown as Ably.UpdateDeleteResult);
    },

    lastHistoryParams: undefined as { untilAttach?: boolean; limit?: number } | undefined,

    history(params?: {
      untilAttach?: boolean;
      limit?: number;
    }): Promise<Ably.PaginatedResult<Ably.InboundMessage>> {
      channel.lastHistoryParams = params;
      const limit = params?.limit ?? 100;
      // Return newest-first (reverse chronological)
      const items = [...publishedMessages].reverse().slice(0, limit);
      return Promise.resolve({
        items,
        hasNext: () => false,
        isLast: () => true,
        next: () => Promise.resolve(null as any),
        current: () => Promise.resolve({ items } as any),
        first: () => Promise.resolve({ items } as any),
      } as Ably.PaginatedResult<Ably.InboundMessage>);
    },

    attach(): Promise<Ably.ChannelStateChange | null> {
      return Promise.resolve(null);
    },

    detach(): Promise<void> {
      return Promise.resolve();
    },

    on(event: string, listener: StateListener) {
      const existing = stateListeners.get(event) ?? [];
      existing.push(listener);
      stateListeners.set(event, existing);
    },

    off() {
      stateListeners.clear();
    },

    simulateMessage(partial: Partial<Ably.InboundMessage>) {
      const msg: Ably.InboundMessage = {
        id: partial.id ?? 'msg-id',
        name: partial.name ?? '',
        data: partial.data ?? '',
        action: partial.action ?? 'message.create',
        serial: partial.serial ?? nextSerial(),
        timestamp: partial.timestamp ?? Date.now(),
        extras: partial.extras ?? undefined,
        version: partial.version ?? {
          serial: nextSerial(),
          timestamp: Date.now(),
        },
        annotations: partial.annotations ?? { summary: {} },
        ...partial,
      } as Ably.InboundMessage;

      for (const listener of [...listeners]) {
        listener(msg);
      }
    },

    simulateStateChange(partial: Partial<Ably.ChannelStateChange>) {
      const event = partial.current ?? 'failed';
      const change = {
        current: event,
        previous: partial.previous ?? 'attached',
        resumed: partial.resumed ?? false,
        reason: partial.reason,
        ...partial,
      } as Ably.ChannelStateChange;

      const eventListeners = stateListeners.get(event) ?? [];
      for (const listener of eventListeners) {
        listener(change);
      }
    },

    // Stub other properties expected on RealtimeChannel
    state: 'attached' as Ably.ChannelState,
    errorReason: null as any,
    params: {},
    modes: [],
    presence: createMockPresence() as any,
    push: {} as any,
    annotations: {} as any,
    setOptions: () => Promise.resolve(),
    whenState: () => Promise.resolve(null),
    getMessage: () => Promise.resolve({} as any),
    deleteMessage: () => Promise.resolve({} as any),
    getMessageVersions: () => Promise.resolve({} as any),
    emit: () => {},
    once: () => {},
    eventListeners: () => [],
  };

  return channel as any;
}

export function createMockAbly(
  channelOverride?: ReturnType<typeof createMockChannel>,
): Ably.Realtime & {
  mockChannel: ReturnType<typeof createMockChannel>;
} {
  const mockChannel = channelOverride ?? createMockChannel();

  const ably = {
    mockChannel,
    channels: {
      get(_name: string, _options?: Ably.ChannelOptions) {
        return mockChannel;
      },
      getDerived() {
        return mockChannel;
      },
      release() {},
      all: {},
    },
    connection: {
      on() {},
      off() {},
      once() {},
      state: 'connected',
      id: 'conn-id',
      key: 'conn-key',
      errorReason: null,
      recoveryKey: null,
      createRecoveryKey: () => '',
      connect() {},
      close() {},
      ping: () => Promise.resolve(0),
      whenState: () => Promise.resolve({} as any),
      emit: () => {},
      listeners: () => [],
    },
    auth: {} as any,
    clientId: 'test-client',
    close() {},
    connect() {},
    push: {} as any,
    stats: () => Promise.resolve({} as any),
    time: () => Promise.resolve(Date.now()),
    request: () => Promise.resolve({} as any),
    batchPublish: () => Promise.resolve({} as any),
    batchPresence: () => Promise.resolve({} as any),
  };

  return ably as any;
}
