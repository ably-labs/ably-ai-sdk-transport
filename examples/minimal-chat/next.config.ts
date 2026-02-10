import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['ably'],
  transpilePackages: ['@ably/ai-sdk-transport'],
};

export default nextConfig;
