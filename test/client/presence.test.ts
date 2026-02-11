import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AblyChatTransport } from '../../src/client/AblyChatTransport.js';
import {
  createMockAbly,
  createMockChannel,
  resetSerialCounter,
  type MockPresence,
} from '../helpers/mockAbly.js';

describe('onAgentPresenceChange', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let mockAbly: ReturnType<typeof createMockAbly>;
  let transport: AblyChatTransport;
  let presence: MockPresence;

  beforeEach(() => {
    resetSerialCounter();
    mockChannel = createMockChannel();
    mockAbly = createMockAbly(mockChannel);
    presence = mockChannel.presence as unknown as MockPresence;
    transport = new AblyChatTransport({
      ably: mockAbly,
      channelName: 'test-channel',
    });
  });

  it('calls callback with true when agent is already present', async () => {
    // Seed an agent in the presence set before subscribing
    presence.members.set('conn-agent', {
      action: 'present',
      clientId: 'agent',
      connectionId: 'conn-agent',
      data: { type: 'agent' },
      encoding: '',
      extras: null,
      id: 'p1',
      timestamp: Date.now(),
    } as any);

    const callback = vi.fn();
    transport.onAgentPresenceChange(callback);

    // Wait for the async get() to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledWith(true);
  });

  it('calls callback with false when no agent is present', async () => {
    const callback = vi.fn();
    transport.onAgentPresenceChange(callback);

    await new Promise((r) => setTimeout(r, 10));

    expect(callback).toHaveBeenCalledWith(false);
  });

  it('reacts to agent entering', async () => {
    const callback = vi.fn();
    transport.onAgentPresenceChange(callback);

    await new Promise((r) => setTimeout(r, 10));
    expect(callback).toHaveBeenCalledWith(false);

    callback.mockClear();
    presence.simulateEnter({
      clientId: 'agent',
      connectionId: 'conn-agent-1',
      data: { type: 'agent' },
    });

    expect(callback).toHaveBeenCalledWith(true);
  });

  it('reacts to agent leaving', async () => {
    // Start with an agent present
    presence.members.set('conn-agent-1', {
      action: 'present',
      clientId: 'agent',
      connectionId: 'conn-agent-1',
      data: { type: 'agent' },
      encoding: '',
      extras: null,
      id: 'p1',
      timestamp: Date.now(),
    } as any);

    const callback = vi.fn();
    transport.onAgentPresenceChange(callback);

    await new Promise((r) => setTimeout(r, 10));
    expect(callback).toHaveBeenCalledWith(true);

    callback.mockClear();
    presence.simulateLeave({
      clientId: 'agent',
      connectionId: 'conn-agent-1',
      data: { type: 'agent' },
    });

    expect(callback).toHaveBeenCalledWith(false);
  });

  it('ignores non-agent presence events', async () => {
    const callback = vi.fn();
    transport.onAgentPresenceChange(callback);

    await new Promise((r) => setTimeout(r, 10));
    callback.mockClear();

    // Enter a non-agent member
    presence.simulateEnter({
      clientId: 'user-123',
      connectionId: 'conn-user',
      data: { type: 'user' },
    });

    // Should not have been called again
    expect(callback).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further callbacks', async () => {
    const callback = vi.fn();
    const unsubscribe = transport.onAgentPresenceChange(callback);

    await new Promise((r) => setTimeout(r, 10));
    callback.mockClear();

    unsubscribe();

    presence.simulateEnter({
      clientId: 'agent',
      connectionId: 'conn-agent-1',
      data: { type: 'agent' },
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('stays true with multiple agents until all leave', async () => {
    const callback = vi.fn();
    transport.onAgentPresenceChange(callback);

    await new Promise((r) => setTimeout(r, 10));
    callback.mockClear();

    // Two agents enter
    presence.simulateEnter({
      clientId: 'agent',
      connectionId: 'conn-agent-1',
      data: { type: 'agent' },
    });
    expect(callback).toHaveBeenCalledWith(true);
    callback.mockClear();

    presence.simulateEnter({
      clientId: 'agent',
      connectionId: 'conn-agent-2',
      data: { type: 'agent' },
    });
    // No callback — still true, no change
    expect(callback).not.toHaveBeenCalled();

    // First agent leaves — still one left, no callback
    presence.simulateLeave({
      clientId: 'agent',
      connectionId: 'conn-agent-1',
      data: { type: 'agent' },
    });
    expect(callback).not.toHaveBeenCalled();

    // Last agent leaves — now false
    presence.simulateLeave({
      clientId: 'agent',
      connectionId: 'conn-agent-2',
      data: { type: 'agent' },
    });
    expect(callback).toHaveBeenCalledWith(false);
  });
});
