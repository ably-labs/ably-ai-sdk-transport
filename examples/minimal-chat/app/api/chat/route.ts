import Ably from 'ably';
import { streamText, convertToModelMessages } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { publishToAbly } from '@ably/ai-sdk-transport';

const ablyServer = new Ably.Realtime({ key: process.env.ABLY_API_KEY });

export async function POST(req: Request) {
  const { id, messages } = await req.json();
  console.log('Received messages for chat ID', id, messages);

  const result = streamText({
    model: anthropic('claude-sonnet-4-20250514'),
    messages: await convertToModelMessages(messages),
  });

  const channel = ablyServer.channels.get(`ait:myAppChat`);
  publishToAbly({ channel, stream: result.toUIMessageStream() });

  return new Response(null, { status: 202 });
}
