import Ably from 'ably';

const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });

export async function GET() {
  const tokenRequest = await ablyRest.auth.createTokenRequest({
    clientId: 'anonymous',
  });
  return Response.json(tokenRequest);
}
