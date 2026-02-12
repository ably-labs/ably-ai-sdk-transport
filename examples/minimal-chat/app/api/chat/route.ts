import Ably from 'ably';
import { streamText, convertToModelMessages } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { subscribeToChannel } from '@ably/ai-sdk-transport';

const ablyServer = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

// In-memory state — works in persistent server processes (next dev / next start)
// but NOT in serverless environments (Vercel/Lambda) where each cold start
// creates a new instance and this Map will be empty.
const subscriptions = new Set<string>();

async function startSubscription(channelName: string) {
  const channel = ablyServer.channels.get(channelName);
  console.log(`Subscribing to channel: ${channelName}`);

  await subscribeToChannel({
    channel,
    presence: {},
    logger: console,
    handler: async ({ messages, abortSignal }) => {
      const modelMessages = await convertToModelMessages(messages);

      console.log('Model messages');
      for (const msg of modelMessages) {
        console.log('    - ', JSON.stringify(msg));
      }
      const result = streamText({
        model: anthropic('claude-sonnet-4-20250514'),
        messages: modelMessages,
        abortSignal,
      });

      return result.toUIMessageStream();
    },
  });
}

export async function POST(request: Request) {
  const { channelName } = (await request.json()) as {
    channelName: string;
  };

  if (!channelName) {
    return new Response('Missing channelName', { status: 400 });
  }

  if (subscriptions.has(channelName)) {
    return new Response('Already subscribed', { status: 200 });
  }

  subscriptions.add(channelName);

  await startSubscription(channelName);

  return new Response('Subscribed', { status: 200 });
}
