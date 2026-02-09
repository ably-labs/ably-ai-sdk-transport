import jwt from 'jsonwebtoken';

export async function GET() {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return new Response('ABLY_API_KEY not set', { status: 500 });
  }

  const [keyName, keySecret] = apiKey.split(':');

  const channelName =
    process.env.NEXT_PUBLIC_ABLY_CHANNEL_NAME || 'ai:minimal-chat';

  const token = jwt.sign(
    {
      'x-ably-capability': JSON.stringify({
        [channelName]: ['publish', 'subscribe'],
      }),
    },
    keySecret,
    {
      algorithm: 'HS256',
      keyid: keyName,
      expiresIn: '1h',
    },
  );

  return new Response(token, {
    headers: { 'Content-Type': 'application/jwt' },
  });
}
