import Ably from 'ably';
import { streamText, convertToModelMessages } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { subscribeToChannel } from '@ably/ai-sdk-transport';

const ablyServer = new Ably.Realtime({ key: process.env.ABLY_API_KEY });
const subscribedChannels = new Set<string>();

export async function POST(request: Request) {
  const { channelName } = (await request.json()) as { channelName: string };

  if (!channelName) {
    return new Response('Missing channelName', { status: 400 });
  }

  if (subscribedChannels.has(channelName)) {
    return new Response('Already subscribed', { status: 200 });
  }

  const channel = ablyServer.channels.get(channelName);

  subscribeToChannel({
    channel,
    handler: async ({ messages, abortSignal }) => {
      console.log(`[${channelName}] Received messages:`, messages);

      const result = streamText({
        model: anthropic('claude-sonnet-4-20250514'),
        messages: await convertToModelMessages(messages),
        abortSignal,
      });

      return result.toUIMessageStream();
    },
  });

  subscribedChannels.add(channelName);

  return new Response('Subscribed', { status: 200 });
}
