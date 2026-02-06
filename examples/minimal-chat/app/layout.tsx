export const metadata = {
  title: 'Minimal Chat',
  description: 'Streaming Claude responses via Ably pub/sub',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
