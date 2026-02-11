import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'Minimal Chat',
  description: 'Streaming Claude responses via Ably pub/sub',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
