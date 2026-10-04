import type { Metadata, Viewport } from 'next';
import { Nav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenPulse',
  description: 'Offline biometric dashboard for your own strap. Scores are computed locally from your data.',
};

export const viewport: Viewport = {
  themeColor: '#0d0d0d',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen md:flex">
          <Nav />
          <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-[1180px]">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
